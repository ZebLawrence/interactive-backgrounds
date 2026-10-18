import CoreGraphics
import Metal
import simd

// Snowshoe hare: a procedural body on a small rig, clothed in fur strands, with the habits of the
// real animal and the tracks it leaves.
//
// Lepus americanus in winter: about 45 cm nose to rump and 1.3-1.5 kg, pure white but for black
// ear tips and dark eyes, with ears a third shorter than a jackrabbit's and huge furred hind
// feet, the "snowshoes", that carry it over soft snow. It spends the day in a form (a hollow it
// sits in), feeds at dusk and dawn on the bark and twigs of aspen suckers and other shoots,
// moves in short hops, sits up tall to look and listen when something stirs, and when it must
// flee runs at up to 45 km/h in three-metre zigzag bounds. Its track is the classic set of four:
// the long hind feet land side by side ahead of the two small fore feet.

// MARK: - Geometry helpers

private typealias Surface = (Float, Float) -> V3

/// A closed surface of `rows` x `sides` from `at(t, a)` (t 0..1 along, a 0..TAU round).
private func lofted(_ rows: Int, _ sides: Int, _ at: Surface) -> MeshData {
    var m = MeshData()
    for r in 0...rows {
        for c in 0...sides {
            let t = Float(r) / Float(rows), a = Float(c) / Float(sides) * TAU
            m.positions.append(at(t, a))
            m.uvs.append(V2(Float(c) / Float(sides), t))
        }
    }
    for r in 0..<rows {
        for c in 0..<sides {
            let a = UInt32(r * (sides + 1) + c), b = a + 1, d = a + UInt32(sides + 1), e = d + 1
            m.indices += [a, d, b, b, d, e]
        }
    }
    m.computeVertexNormals()
    return m
}

/// A sausage along +x from x0 to x1: centre line y = yc(t), half-heights ry(t), half-widths rz(t),
/// with the ends rounded off by the radius functions going to zero.
private func sausage(_ x0: Float, _ x1: Float, _ yc: @escaping (Float) -> Float, _ ry: @escaping (Float) -> Float,
                     _ rz: @escaping (Float) -> Float) -> Surface {
    { t, a in V3(x0 + (x1 - x0) * t, yc(t) + sin(a) * ry(t), cos(a) * rz(t)) }
}

private func bulb(_ k: Float = 0.5) -> (Float) -> Float { { t in pow(sin(.pi * clamp(t, 0, 1)), k) } }

/// Fur cards in a mesh: (position, u), (normal, v), (seed, 0, 0, 0) per vertex.
private struct FurMesh {
    let vertices: MTLBuffer
    let indices: MTLBuffer
    let count: Int
}

/// Fur: small cards rooted just under a surface, lying along the fur's flow and lifted a little
/// off it, each drawn in the shader as a few hairs. `flow(t, a, p)` is the direction the hair lies in.
private func furCards(_ count: Int, _ surface: Surface, _ flow: (Float, Float, V3) -> V3, _ rng: () -> Float,
                      len: Float = 0.016, wid: Float = 0.007, lift: Float = 0.3, tRange: (Float, Float)? = nil) -> FurMesh {
    var m = MeshData()
    var seeds: [Float] = []
    for i in 0..<count {
        let t = tRange.map { lerp($0.0, $0.1, rng()) } ?? rng()
        let a = rng() * TAU
        let p = surface(t, a)
        // Normal from finite differences.
        let dt = (surface(min(1, t + 0.01), a) - surface(max(0, t - 0.01), a)).normalized
        let da = (surface(t, a + 0.05) - surface(t, a - 0.05)).normalized
        var n = da.cross(dt)
        if n.lengthSquared < 1e-9 { continue }
        n = n.normalized
        // Outward: the normal should point away from the part's axis (its centre line is near y = 0, z = 0).
        let outward = V3(0, p.y, p.z)
        if outward.lengthSquared > 1e-9 && n.dot(outward) < 0 { n = -n }
        var f = flow(t, a, p)
        f = (f - n * f.dot(n)).normalized
        if f.lengthSquared < 1e-6 { f = dt }
        let side = f.cross(n).normalized
        if side.lengthSquared < 0.5 { continue }
        let dir = (f * cos(lift) + n * sin(lift)).normalized
        let root = p - n * 0.002
        let L = len * (0.7 + 0.6 * rng()), W = wid * (0.7 + 0.6 * rng())
        let base = UInt32(m.positions.count)
        let seed = (Float(i) * 0.37).truncatingRemainder(dividingBy: 1)
        for r in 0..<3 {
            let s = Float(r) / 2
            // The card curves back toward the surface at the tip.
            let q = root + dir * (s * L) - n * (s * s * L * 0.3)
            for c: Float in [-1, 1] {
                let w = W * 0.5 * (1 - s * 0.5)
                m.positions.append(q + side * (c * w))
                m.uvs.append(V2(c * 0.5 + 0.5, s))
                seeds.append(seed)
            }
        }
        for r in 0..<UInt32(2) {
            let k = base + r * 2
            m.indices += [k, k + 2, k + 1, k + 1, k + 2, k + 3]
        }
    }
    m.computeVertexNormals()
    var verts: [V4] = []
    verts.reserveCapacity(m.positions.count * 3)
    for i in m.positions.indices {
        verts += [V4(m.positions[i], m.uvs[i].x), V4(m.normals[i], m.uvs[i].y), V4(seeds[i], 0, 0, 0)]
    }
    return FurMesh(vertices: GPU.shared.buffer(verts), indices: GPU.shared.buffer(m.indices), count: m.indices.count)
}

// MARK: - The kit: geometry shared by every hare

/// Which painted coat a pelt part wears.
private enum PeltKind: Float { case body = 0, head = 1, ear = 2, tail = 3 }

final class HareKit {
    static let shared = HareKit()

    fileprivate let torso, head, ear, thigh, shank, foot, toe, upper, lower, paw, tail: GPUMesh
    fileprivate let eyeRing, cleft, eye, joint, nose, glint, plane: GPUMesh
    fileprivate let furTorso, furHead, furEar, furThigh, furUpper, furLower: FurMesh
    fileprivate let blob: MTLTexture

    private init() {
        // A fixed LCG, as the web version's kit uses, so every run builds the same hare.
        var s: UInt32 = 12345
        let rng: () -> Float = {
            s = s &* 1_664_525 &+ 1_013_904_223
            return Float(Double(s) / 4_294_967_296)
        }

        // Bodies are lofted from side-view profiles: the line of the back, the line of the belly and
        // the half-width, each given as control points along the body and interpolated smoothly.
        func curve(_ pts: [(Float, Float)]) -> (Float) -> Float {
            { t in
                for i in 1..<pts.count where t <= pts[i].0 {
                    let u = clamp((t - pts[i - 1].0) / (pts[i].0 - pts[i - 1].0), 0, 1)
                    let k = u * u * (3 - 2 * u)
                    return lerp(pts[i - 1].1, pts[i].1, k)
                }
                return pts[pts.count - 1].1
            }
        }
        func profiled(_ x0: Float, _ x1: Float, _ top: @escaping (Float) -> Float, _ bottom: @escaping (Float) -> Float,
                      _ width: @escaping (Float) -> Float) -> Surface {
            { t, a in
                let yt = top(t), yb = bottom(t), w = width(t)
                let sa = sin(a), ca = cos(a)
                // A little squarer than an ellipse, as a furred body is.
                let sy = (sa < 0 ? -1 : sa > 0 ? 1 : 0) * pow(abs(sa), 0.85)
                let cz = (ca < 0 ? -1 : ca > 0 ? 1 : 0) * pow(abs(ca), 0.85)
                let y = sy > 0 ? sy * yt : -sy * yb
                return V3(x0 + (x1 - x0) * t, y, cz * w)
            }
        }

        // Torso: the rump high and round over the haunches, the back sloping down to low shoulders,
        // a deep belly, narrowing into the neck at the front and the tail at the back.
        let torsoS = profiled(-0.19, 0.12,
                              curve([(0, 0.01), (0.12, 0.068), (0.3, 0.092), (0.55, 0.082), (0.8, 0.066), (0.95, 0.042), (1, 0.004)]),
                              curve([(0, -0.005), (0.1, -0.042), (0.3, -0.062), (0.6, -0.06), (0.85, -0.052), (0.95, -0.032), (1, -0.004)]),
                              curve([(0, 0.005), (0.1, 0.044), (0.3, 0.066), (0.55, 0.06), (0.8, 0.052), (0.95, 0.032), (1, 0.004)]))
        torso = lofted(30, 26, torsoS).upload()
        furTorso = furCards(820, torsoS, { _, a, _ in V3(-1, -0.35 * abs(cos(a)), 0.45 * cos(a)) }, rng, len: 0.023, wid: 0.008)
        // Head: a domed skull, the brow high, the nose line convex and curving down to a blunt
        // muzzle; wide at the cheeks, narrow at the nose; the back open into the neck.
        let headS = profiled(-0.035, 0.095,
                             curve([(0, 0.012), (0.12, 0.038), (0.4, 0.041), (0.7, 0.03), (0.9, 0.014), (1, 0.002)]),
                             curve([(0, -0.006), (0.15, -0.03), (0.4, -0.037), (0.7, -0.031), (0.9, -0.019), (1, -0.006)]),
                             curve([(0, 0.005), (0.15, 0.038), (0.4, 0.046), (0.7, 0.035), (0.9, 0.023), (1, 0.005)]))
        head = lofted(22, 22, headS).upload()
        furHead = furCards(300, headS, { _, a, _ in V3(-1, -0.2, 0.5 * cos(a)) }, rng, len: 0.011, wid: 0.005, tRange: (0.05, 0.9))
        // Ears: long, slightly cupped blades, along +y, the tip curving back.
        let earS: Surface = { t, a in
            let w = 0.024 * pow(sin(.pi * clamp(t * 0.95 + 0.05, 0, 1)), 0.55) * (1 - 0.2 * t)
            let th = 0.0045 * bulb(0.5)(t)
            return V3(sin(a) * th - 0.016 * t * t + 0.005 * cos(a) * cos(a) * w / 0.024, t * 0.092, cos(a) * w)
        }
        ear = lofted(14, 12, earS).upload()
        furEar = furCards(50, earS, { _, _, _ in V3(0, 1, 0) }, rng, len: 0.006, wid: 0.003, lift: 0.15, tRange: (0, 0.7))
        // Limbs, along +x of their own groups. The thigh is a big rounded haunch.
        func seg(_ L: Float, _ r0: Float, _ r1: Float, _ flat: Float = 1) -> Surface {
            sausage(-0.004, L + 0.004, { _ in 0 }, { t in lerp(r0, r1, t) * bulb(0.12)(t) }, { t in lerp(r0, r1, t) * bulb(0.12)(t) * flat })
        }
        let thighS = sausage(-0.01, 0.105, { t in 0.008 * sin(.pi * t) }, { t in lerp(0.058, 0.028, t) * bulb(0.3)(t) },
                             { t in lerp(0.046, 0.024, t) * bulb(0.3)(t) })
        thigh = lofted(12, 16, thighS).upload()
        furThigh = furCards(160, thighS, { _, _, _ in V3(1, -0.3, 0) }, rng, len: 0.016, wid: 0.006)
        shank = lofted(8, 10, seg(0.11, 0.024, 0.016)).upload()
        foot = lofted(8, 12, sausage(-0.02, 0.13, { _ in 0 }, { t in 0.013 * bulb(0.3)(t) }, { t in 0.03 * bulb(0.3)(t) })).upload()
        toe = lofted(4, 8, seg(0.03, 0.007, 0.004)).upload()
        let upperS = seg(0.075, 0.02, 0.014), lowerS = seg(0.07, 0.014, 0.011)
        upper = lofted(8, 10, upperS).upload()
        lower = lofted(8, 10, lowerS).upload()
        furUpper = furCards(50, upperS, { _, _, _ in V3(1, -0.4, 0) }, rng, len: 0.012, wid: 0.005)
        furLower = furCards(40, lowerS, { _, _, _ in V3(1, -0.4, 0) }, rng, len: 0.01, wid: 0.004)
        paw = lofted(6, 10, sausage(-0.01, 0.045, { _ in 0 }, { t in 0.009 * bulb(0.3)(t) }, { t in 0.016 * bulb(0.3)(t) })).upload()
        tail = lofted(8, 10, sausage(-0.005, 0.032, { t in 0.012 * t }, { t in 0.017 * bulb(0.6)(t) }, { t in 0.016 * bulb(0.6)(t) })).upload()
        eyeRing = Geometry.torus(radius: 0.0135, tube: 0.0022, radialSegments: 8, tubularSegments: 24).upload()
        cleft = Geometry.box(0.003, 0.012, 0.0012).upload()
        eye = Geometry.sphere(radius: 0.0135, widthSegments: 20, heightSegments: 14).upload()
        joint = Geometry.sphere(radius: 1, widthSegments: 10, heightSegments: 8).upload()
        nose = Geometry.sphere(radius: 0.007, widthSegments: 12, heightSegments: 8).upload()
        glint = Geometry.sphere(radius: 0.0022, widthSegments: 8, heightSegments: 6).upload()
        // The contact shadow: a flat quad lying on the snow.
        plane = Geometry.plane(1, 1).transformed(simd_float4x4(rotationX: -.pi / 2)).upload()
        blob = GPU.shared.texture(Art.blob(128, hardness: 0.2), srgb: true)
    }
}

/// A few individuals: size, the grey in their coat, and temperament.
struct HareTraits {
    var size: Float = 1
    var tint: Float = 1
    /// Shy ones bolt sooner and watch longer.
    var bold: Float = 0.5
    var earTilt: Float = 0

    static func make(_ rng: Seeded, _ n: Int) -> [HareTraits] {
        (0..<n).map { _ in
            let size = 0.92 + rng() * 0.2
            let tint = 0.95 + rng() * 0.05
            let bold = rng()
            let earTilt = (rng() - 0.5) * 0.3
            return HareTraits(size: size, tint: tint, bold: bold, earTilt: earTilt)
        }
    }
}

// MARK: - Poses

/// Joint angles (radians) and the body's height; blended between states. Leg segments are given as
/// angles in the ground frame, from straight forward (+x), positive upward: thigh/shank/foot for
/// the hind leg, upper/lower/paw for the fore leg. Ear pitch is positive laid back; head pitch
/// positive nose up; body pitch positive nose up.
private struct Pose {
    var bodyY: Float, pitch: Float, headPitch: Float, headY: Float, earPitch: Float, earSpread: Float
    var thigh: Float, shank: Float, foot: Float, upper: Float, lower: Float, paw: Float, tail: Float

    static func blend(_ a: Pose, _ b: Pose, _ t: Float) -> Pose {
        Pose(bodyY: lerp(a.bodyY, b.bodyY, t), pitch: lerp(a.pitch, b.pitch, t), headPitch: lerp(a.headPitch, b.headPitch, t),
             headY: lerp(a.headY, b.headY, t), earPitch: lerp(a.earPitch, b.earPitch, t), earSpread: lerp(a.earSpread, b.earSpread, t),
             thigh: lerp(a.thigh, b.thigh, t), shank: lerp(a.shank, b.shank, t), foot: lerp(a.foot, b.foot, t),
             upper: lerp(a.upper, b.upper, t), lower: lerp(a.lower, b.lower, t), paw: lerp(a.paw, b.paw, t), tail: lerp(a.tail, b.tail, t))
    }

    // Hunched in its form, legs tucked beneath, ears laid back along the shoulders.
    static let loaf = Pose(bodyY: 0.09, pitch: 0.05, headPitch: -0.15, headY: 0, earPitch: 1.3, earSpread: 0.25, thigh: -2.7, shank: -0.05, foot: 0, upper: -2.4, lower: -0.25, paw: 0, tail: 0.3)
    // Sitting on its haunches, fore legs straight, head up, ears up.
    static let sit = Pose(bodyY: 0.14, pitch: 0.28, headPitch: -0.1, headY: 0, earPitch: 0.25, earSpread: 0.3, thigh: -2.3, shank: -0.35, foot: 0, upper: -1.6, lower: -1.55, paw: 0, tail: 0.4)
    // Up on its hind legs to look and listen, fore paws held to the chest.
    static let tall = Pose(bodyY: 0.19, pitch: 0.85, headPitch: -0.55, headY: 0, earPitch: 0.05, earSpread: 0.25, thigh: -2.5, shank: -0.5, foot: 0, upper: -1.8, lower: -1.35, paw: -1.1, tail: 0.6)
    // Crouched, ready: the frame of the hop.
    static let crouch = Pose(bodyY: 0.11, pitch: 0.1, headPitch: -0.05, headY: 0, earPitch: 0.4, earSpread: 0.3, thigh: -2.5, shank: -0.3, foot: 0, upper: -1.7, lower: -1.2, paw: 0, tail: 0.2)
    // Stretched in the air: hind legs trailing, fore legs reaching.
    static let stretch = Pose(bodyY: 0.2, pitch: 0.2, headPitch: 0, headY: 0, earPitch: 0.9, earSpread: 0.2, thigh: -3.0, shank: -2.9, foot: -2.8, upper: -0.6, lower: -0.4, paw: -0.3, tail: 0.1)
    // Landing on the fore paws, hind legs swinging forward past them.
    static let land = Pose(bodyY: 0.14, pitch: -0.2, headPitch: 0.15, headY: 0, earPitch: 0.6, earSpread: 0.3, thigh: -1.2, shank: 0.3, foot: 0.2, upper: -1.5, lower: -1.4, paw: 0, tail: 0.2)
    // Nose down to the snow or a sucker.
    static let nibble = Pose(bodyY: 0.1, pitch: -0.05, headPitch: -0.7, headY: -0.01, earPitch: 0.9, earSpread: 0.3, thigh: -2.6, shank: -0.1, foot: 0, upper: -1.9, lower: -0.9, paw: 0, tail: 0.3)
    // Sitting, head turned down to a raised fore paw.
    static let groom = Pose(bodyY: 0.13, pitch: 0.35, headPitch: -0.5, headY: 0, earPitch: 0.7, earSpread: 0.3, thigh: -2.4, shank: -0.3, foot: 0, upper: -1.6, lower: -1.5, paw: 0, tail: 0.4)

    static func named(_ n: String) -> Pose {
        switch n {
        case "loaf": return loaf
        case "tall": return tall
        case "crouch": return crouch
        case "stretch": return stretch
        case "land": return land
        case "nibble": return nibble
        case "groom": return groom
        default: return sit
        }
    }
}

// MARK: - The hare

/// Per-draw parameters of a pelt or fur part (`HareParams` in the shaders).
private struct HareParams {
    var model: simd_float4x4
    /// x = coat kind, y = tint, z = double-sided.
    var misc: V4
}

private enum HarePart {
    case pelt(GPUMesh, PeltKind, doubleSided: Bool)
    case fur(FurMesh)
    case std(GPUMesh, StdParams)
}

final class Hare {
    enum State: String { case loaf, sit, tall, nibble, groom, freeze, hop, bolt }

    private let kit: HareKit
    private let traits: HareTraits
    let size: Float
    private unowned let scene: Aspen
    private let root = Node("hare")
    private var body = Node(), neck = Node(), headG = Node(), noseNode = Node(), tailNode = Node()
    private var eyes: [Node] = []
    private var ears: [(pivot: Node, side: Float)] = []
    private var hind: [(hip: Node, knee: Node, ankle: Node, side: Float)] = []
    private var fore: [(shoulder: Node, elbow: Node, wrist: Node, side: Float)] = []
    private var queue: [(HarePart, simd_float4x4)] = []

    var pos = V3.zero
    private(set) var yaw: Float = 0
    private var pose = Pose.sit
    private var poseFrom = Pose.sit
    private var poseToName = "sit"
    private var blend: Float = 1
    private var blendTime: Float = 0.4
    private(set) var state = State.loaf
    var timer: Float = 5
    private var target: V3?
    private var finalTarget: V3?
    private var next: State?
    private var bounds = 0
    private var zig: Float = 1
    private struct Hop { var phase: Float, T: Float, len: Float, height: Float, yawFrom: Float, yawTo: Float, bolt: Bool, start: V3, landed: Bool }
    private var hop: Hop?
    private var airY: Float = 0
    /// A world point it is watching, or nil.
    private var look: V3?
    private var headYaw: Float = 0, headPitchExtra: Float = 0
    private var earL = (yaw: Float(0), pitch: Float(0)), earR = (yaw: Float(0), pitch: Float(0))
    private var earFlick = (side: Float(0), t: Float(1))
    private var blinkT = rnd(2, 6), blink: Float = 0
    private var breath: Float = 0
    private var nose: Float = 0
    /// 0..1, how wound up it is.
    private var alert: Float = 0
    private var cooldown: Float = 0
    private var groomT: Float = 0
    private var groomPaw: (upper: Float, lower: Float, paw: Float)?
    private var stare: Float = 0

    init(kit: HareKit, traits: HareTraits, scene: Aspen) {
        self.kit = kit
        self.traits = traits
        self.size = traits.size
        self.scene = scene
        build()
    }

    // MARK: Building the rig

    private func part(_ p: HarePart, cast: Bool) -> Node {
        let n = Node()
        n.castShadow = cast
        n.draw = { [unowned self] _, m in self.queue.append((p, m)) }
        return n
    }

    private func build() {
        let k = kit
        let pelt = { (mesh: GPUMesh, kind: PeltKind) in self.part(.pelt(mesh, kind, doubleSided: kind == .ear), cast: true) }
        let fur = { (mesh: FurMesh) in self.part(.fur(mesh), cast: false) }
        func std(_ mesh: GPUMesh, _ hex: String, _ rough: Float, flags: StdFlags = []) -> Node {
            part(.std(mesh, StdParams(model: matrix_identity_float4x4, color: RGBA(hex: hex).linear, roughness: rough, flags: flags)), cast: false)
        }
        func joint(_ r: Float) -> Node {
            let j = pelt(k.joint, .body)
            j.scale = V3(repeating: r)
            return j
        }
        // The torso frame.
        body.scale = V3(repeating: size)
        root.add(body)
        body.add(pelt(k.torso, .body))
        body.add(fur(k.furTorso))
        // Head on the neck.
        neck.position = V3(0.095, 0.028, 0)
        body.add(neck)
        neck.add(headG)
        headG.add(pelt(k.head, .head))
        headG.add(fur(k.furHead))
        headG.scale = V3(repeating: 1.1)
        for side: Float in [-1, 1] {
            let e = std(k.eye, "#120c08", 0.12)
            e.position = V3(0.018, 0.012, side * 0.039)
            e.scale = V3(0.9, 1, 1)
            let glint = std(k.glint, "#ffffff", 1, flags: [.unlit, .noFog])
            glint.position = V3(0.004, 0.005, side * 0.009)
            e.add(glint)
            // The dark rim of fur round the eye.
            let ring = std(k.eyeRing, "#1e1a17", 0.9)
            ring.position = V3(0.018, 0.012, side * 0.040)
            headG.add(e)
            headG.add(ring)
            eyes.append(e)
        }
        noseNode = std(k.nose, "#3a2a2a", 0.5)
        noseNode.position = V3(0.094, -0.004, 0)
        noseNode.scale = V3(0.7, 0.6, 1)
        headG.add(noseNode)
        // The cleft of the upper lip below the nose.
        let cleft = std(k.cleft, "#3a2a2a", 0.5)
        cleft.position = V3(0.093, -0.013, 0)
        cleft.setRotation(0, 0.2, 0)
        headG.add(cleft)
        // Ears: a pivot each at the back of the skull.
        for side: Float in [-1, 1] {
            let pivot = Node()
            pivot.position = V3(-0.018, 0.034, side * 0.017)
            headG.add(pivot)
            pivot.add(pelt(k.ear, .ear))
            pivot.add(fur(k.furEar))
            ears.append((pivot, side))
        }
        // Hind legs.
        for side: Float in [-1, 1] {
            let hip = Node()
            hip.position = V3(-0.09, -0.012, side * 0.045)
            body.add(hip)
            hip.add(pelt(k.thigh, .body))
            hip.add(fur(k.furThigh))
            let knee = Node()
            knee.position = V3(0.1, 0, 0)
            hip.add(knee)
            knee.add(pelt(k.shank, .body))
            knee.add(joint(0.024))
            let ankle = Node()
            ankle.position = V3(0.11, 0, 0)
            knee.add(ankle)
            ankle.add(pelt(k.foot, .body))
            ankle.add(joint(0.016))
            for i in 0..<4 {
                let toe = part(.pelt(k.toe, .body, doubleSided: false), cast: false)
                toe.position = V3(0.12, -0.002, (Float(i) - 1.5) * 0.013)
                toe.setRotation(0, (Float(i) - 1.5) * -0.2, 0)
                ankle.add(toe)
            }
            hind.append((hip, knee, ankle, side))
        }
        // Fore legs.
        for side: Float in [-1, 1] {
            let shoulder = Node()
            shoulder.position = V3(0.078, -0.028, side * 0.034)
            body.add(shoulder)
            shoulder.add(pelt(k.upper, .body))
            shoulder.add(fur(k.furUpper))
            let elbow = Node()
            elbow.position = V3(0.075, 0, 0)
            shoulder.add(elbow)
            elbow.add(pelt(k.lower, .body))
            elbow.add(joint(0.014))
            elbow.add(fur(k.furLower))
            let wrist = Node()
            wrist.position = V3(0.07, 0, 0)
            elbow.add(wrist)
            wrist.add(pelt(k.paw, .body))
            wrist.add(joint(0.011))
            fore.append((shoulder, elbow, wrist, side))
        }
        // Tail.
        tailNode.position = V3(-0.178, 0.028, 0)
        body.add(tailNode)
        let tail = pelt(k.tail, .tail)
        tail.setRotation(0, .pi, 0)
        tailNode.add(tail)
    }

    // MARK: Placement and poses

    func place(_ x: Float, _ z: Float, yaw: Float) {
        pos = V3(x, scene.height(x, z), z)
        self.yaw = yaw
        root.position = pos
        root.setRotation(0, yaw, 0)
    }

    private func headWorld() -> V3 { headG.worldPosition() }

    private func setPose(_ name: String, _ time: Float = 0.4) {
        if poseToName == name { return }
        poseFrom = pose
        poseToName = name
        blend = 0
        blendTime = time
    }

    /// Apply a pose to the rig, plus the live extras (head, ears, breathing, blink).
    private func apply(_ p: Pose) {
        let s = size
        body.position.y = p.bodyY * s + breath * 0.004
        body.setRotation(0, 0, p.pitch)
        body.scale = V3(s, s * (1 + breath * 0.012), s * (1 + breath * 0.012))
        headG.setRotation(0, headYaw, p.headPitch + headPitchExtra)
        headG.position.y = p.headY
        for e in ears {
            let extra = e.side < 0 ? earL : earR
            let flick = earFlick.side == e.side ? sin(min(earFlick.t, 1) * .pi) * 0.5 : 0
            e.pivot.setRotation(e.side * (p.earSpread + traits.earTilt) + flick, extra.yaw, p.earPitch + extra.pitch, order: "YZX")
        }
        // Segment angles are in the ground frame: the first joint takes out the body's pitch.
        for h in hind {
            h.hip.setRotation(0, 0, p.thigh - p.pitch)
            h.knee.setRotation(0, 0, p.shank - p.thigh)
            h.ankle.setRotation(0, 0, p.foot - p.shank)
        }
        for f in fore {
            let g = f.side < 0 ? groomPaw : nil
            let up = g?.upper ?? p.upper, lo = g?.lower ?? p.lower, pw = g?.paw ?? p.paw
            f.shoulder.setRotation(0, 0, up - p.pitch)
            f.elbow.setRotation(0, 0, lo - up)
            f.wrist.setRotation(0, 0, pw - lo)
        }
        tailNode.setRotation(0, 0, p.tail)
        // Blink: the eyes close to a slit.
        let closed = blink > 0 ? sin(min(blink / 0.14, 1) * .pi) : 0
        for e in eyes { e.scale.y = 1 - 0.92 * closed }
        // The nose works when it is alert.
        noseNode.position.y = -0.012 + sin(nose) * 0.0015
        noseNode.scale.x = 0.7 + sin(nose) * 0.08
    }

    // MARK: Behaviour

    /// Something sudden at `p`: bolt if it's close and strong, else sit up.
    func startle(_ p: V3, _ strength: Float) {
        let d = hypot(p.x - pos.x, p.z - pos.z)
        if state == .bolt { return }
        if d < 5 * strength && strength > 0.9 {
            bolt(from: p)
        } else if d < 12 * strength {
            alert = 1
            if state != .hop { enter(.sit) }
            look = p
        }
    }

    private func enter(_ s: State) {
        state = s
        switch s {
        case .loaf: setPose("loaf", 1.2); timer = rnd(25, 70)
        case .sit: setPose("sit", 0.35); timer = rnd(4, 12)
        case .tall: setPose("tall", 0.45); timer = rnd(5, 14)
        case .nibble: setPose("nibble", 0.5); timer = rnd(15, 40)
        case .groom: setPose("groom", 0.5); timer = rnd(4, 9); groomT = 0
        case .freeze: timer = rnd(3, 6)
        case .hop, .bolt: break
        }
    }

    /// Hop toward `target` (through `via` first, if given); `bolt` for flight bounds.
    private func goTo(_ target: V3, via: V3? = nil, bolt: Bool = false) {
        finalTarget = via != nil ? target : nil
        self.target = via ?? target
        bounds = 0
        state = bolt ? .bolt : .hop
        zig = 1
        beginBound()
    }

    private func bolt(from: V3) {
        alert = 1
        // Away from `from`, bent toward the middle of the home ground so it stays in view.
        var away = V3(pos.x - from.x, 0, pos.z - from.z).normalized
        if away.lengthSquared < 0.5 { away = V3(rnd(-1, 1), 0, -1).normalized }
        let home = V3(-pos.x * 0.6, 0, -16 - pos.z).normalized
        let dir = (away + home * 0.7).normalized
        let dist = rnd(7, 12)
        var t: V3?, via: V3?
        for tries in 0..<12 {
            let a = Float(tries - 6) * 0.25
            let d = V3(dir.x * cos(a) - dir.z * sin(a), 0, dir.x * sin(a) + dir.z * cos(a))
            let p = pos + d * dist
            if scene.openSnow(p.x, p.z, 0.6) && inHome(p), let way = route(p) {
                t = p
                via = way.count > 1 ? way[0] : nil
                break
            }
        }
        var goal = t ?? pos + dir * 4
        goal.y = scene.height(goal.x, goal.z)
        goTo(goal, via: via, bolt: true)
        cooldown = 6
    }

    /// The ground the hares keep to: in front of the viewer, within the view, not too close.
    private func inHome(_ p: V3) -> Bool { p.z < -3.5 && p.z > -34 && abs(p.x) < 2 + -p.z * 0.48 }

    private func pathClear(_ p: V3, from: V3? = nil) -> Bool {
        let f = from ?? pos
        let n = max(4, Int(ceil(hypot(p.x - f.x, p.z - f.z) / 0.5)))
        for i in 1...n {
            let x = lerp(f.x, p.x, Float(i) / Float(n)), z = lerp(f.z, p.z, Float(i) / Float(n))
            if !scene.openSnow(x, z, 0.35) { return false }
        }
        return true
    }

    /// A way to `p`: straight if it is clear, else round a trunk through one waypoint; nil if neither.
    private func route(_ p: V3) -> [V3]? {
        if pathClear(p) { return [p] }
        let dx = p.x - pos.x, dz = p.z - pos.z, d = hypot(dx, dz)
        if d < 0.5 { return nil }
        let sx = -dz / d, sz = dx / d
        for f: Float in [0.5, 0.35, 0.65] {
            for off: Float in [1.2, -1.2, 2.2, -2.2] {
                var via = V3(pos.x + dx * f + sx * off, 0, pos.z + dz * f + sz * off)
                if !inHome(via) || !scene.openSnow(via.x, via.z, 0.5) { continue }
                if pathClear(via) && pathClear(p, from: via) {
                    via.y = scene.height(via.x, via.z)
                    return [via, p]
                }
            }
        }
        return nil
    }

    /// Somewhere nearby in the open snow to hop to (and the waypoint round a trunk), or nil.
    private func pickSpot(_ maxDist: Float, near: V3? = nil) -> (p: V3, via: V3?)? {
        for _ in 0..<16 {
            let a = rnd(0, TAU), d = rnd(1.5, maxDist)
            let c = near ?? pos
            var p = V3(c.x + cos(a) * d, 0, c.z + sin(a) * d)
            if !inHome(p) || !scene.openSnow(p.x, p.z, 0.7) { continue }
            // Not on top of another hare.
            if scene.hares.contains(where: { $0 !== self && hypot($0.pos.x - p.x, $0.pos.z - p.z) < 1.2 }) { continue }
            guard let way = route(p) else { continue }
            p.y = scene.height(p.x, p.z)
            return (p, way.count > 1 ? way[0] : nil)
        }
        return nil
    }

    private func beginBound() {
        guard let to = target else { return }
        let bolt = state == .bolt
        let dx = to.x - pos.x, dz = to.z - pos.z
        let dist = hypot(dx, dz)
        var yawTo = atan2(-dz, dx)
        if bolt {
            // Zigzag: each bound veers to alternate sides of the line.
            zig = -zig
            yawTo += zig * rnd(0.25, 0.5) * smoothstep(1, 4, dist)
        }
        let len = bolt ? min(dist, rnd(2.2, 3.2)) : min(dist, rnd(0.5, 0.9) * (0.6 + alert * 0.6))
        let T: Float = bolt ? 0.3 + len * 0.02 : 0.4 + len * 0.2
        bounds += 1
        hop = Hop(phase: 0, T: T, len: len, height: bolt ? 0.35 : 0.1 + len * 0.1, yawFrom: yaw, yawTo: yawTo, bolt: bolt, start: pos, landed: false)
    }

    private func stepBound(_ dt: Float) -> Pose {
        guard var h = hop else { return pose }
        let ph0 = h.phase
        h.phase = min(1, h.phase + dt / h.T)
        let ph = h.phase
        // Turn during the crouch, travel through the air, settle on landing.
        let turn = smoothstep(0, 0.25, ph)
        yaw = h.yawFrom + angleTo(h.yawFrom, h.yawTo) * turn
        let along = smoothstep(0.15, 0.85, ph)
        let fwd = V3(cos(h.yawTo), 0, -sin(h.yawTo))
        pos = h.start + fwd * (h.len * along)
        pos.y = scene.height(pos.x, pos.z)
        let air = sin(.pi * clamp((ph - 0.15) / 0.7, 0, 1))
        airY = h.height * air
        // The pose through the bound: crouch, stretch, land, gather.
        let p: Pose
        if ph < 0.15 { p = Pose.blend(.crouch, .stretch, smoothstep(0.05, 0.15, ph)) }
        else if ph < 0.6 { p = .stretch }
        else if ph < 0.85 { p = Pose.blend(.stretch, .land, smoothstep(0.6, 0.8, ph)) }
        else { p = Pose.blend(.land, .crouch, smoothstep(0.85, 1, ph)) }
        // Landing: the prints and a puff of snow.
        if ph0 < 0.78 && ph >= 0.78 && !h.landed {
            h.landed = true
            let strength: Float = h.bolt ? 0.35 : 0.08
            scene.puffs.burst(pos.x, pos.y, pos.z, strength: strength, spread: 0.2)
            if scene.snowpack.inMap(pos.x, pos.z) { scene.snowpack.stampHare(pos.x, pos.z, heading: -yaw, scale: size) }
        }
        hop = h
        if ph >= 1, let tgt = target {
            let dist = hypot(tgt.x - pos.x, tgt.z - pos.z)
            let arrived = dist < 0.4 || (h.bolt && dist < 1.2)
            if arrived, let fin = finalTarget {
                // Round the trunk: on to the real target.
                target = fin
                finalTarget = nil
                beginBound()
            } else if arrived || bounds > 30 {
                hop = nil
                target = nil
                pose = .crouch
                if h.bolt {
                    enter(.tall)
                    timer = rnd(6, 12)
                } else {
                    enter(next ?? .sit)
                }
                next = nil
            } else {
                beginBound()
            }
        }
        return p
    }

    func update(dt: Float, scene: Aspen, info c: CursorInfo) {
        timer -= dt
        cooldown -= dt
        alert = max(0, alert - dt / 12)

        // --- What the cursor is doing, in screen space ---------------------------------------
        let headS = scene.project(headWorld())
        let near: Float = (headS != nil && c.inside) ? hypot(Float(headS!.x) - c.x, Float(headS!.y) - c.y) : .infinity
        let onMe = near < 55
        let hit = c.hit
        let hitDist = hit.map { hypot($0.x - pos.x, $0.z - pos.z) } ?? .infinity

        // A fast cursor sweeping close: bolt.
        if c.inside && c.speed > 900 && near < 260 && state != .bolt && cooldown <= 0 {
            bolt(from: hit ?? scene.cameraPosition)
        }
        // The cursor resting: notice it, then come closer to look.
        if c.inside && c.rest > 1.5, let hit, state != .bolt && state != .hop {
            if onMe {
                // Stared at, it freezes, then stares back.
                if state != .freeze { enter(.freeze); look = nil }
                stare = min(1, stare + dt / 2.5)
                if stare > 0.99 { look = scene.cameraPosition }
            } else if alert < 0.9 || state == .loaf {
                if state == .loaf && near < 700 { enter(.sit); alert = 0.6 }
                look = hit
            }
            if c.rest > 5 && hitDist > 3 && hitDist < 20 && cooldown <= 0 && c.nearestHare === self
                && (state == .sit || state == .tall || state == .nibble) {
                // Hop over to a spot a couple of metres short of it.
                if let spot = pickSpot(2.6, near: V3(hit.x, 0, hit.z)), hypot(spot.p.x - hit.x, spot.p.z - hit.z) > 1.2 {
                    next = .tall
                    goTo(spot.p, via: spot.via)
                    cooldown = 25
                } else {
                    cooldown = 2
                }
            }
        } else if state == .freeze {
            enter(.sit)
            stare = 0
        }
        if !(c.inside && c.rest > 0.5) { stare = 0 }
        if c.inside && c.attention > 0, let hit, look == nil, state != .loaf { look = hit }

        // --- The state machine ---------------------------------------------------------------
        var p: Pose
        if hop != nil {
            p = stepBound(dt)
        } else {
            airY = 0
            if timer <= 0 {
                switch state {
                case .loaf: enter(chance(0.6) ? .sit : .groom)
                case .sit:
                    let r = Float.random(in: 0..<1)
                    if r < 0.35 {
                        if let s = pickSpot(6) { next = chance(0.5) ? .nibble : .sit; goTo(s.p, via: s.via) } else { enter(.loaf) }
                    } else if r < 0.5 { enter(.tall) }
                    else if r < 0.65 { enter(.groom) }
                    else if r < 0.8 { enter(.nibble) }
                    else { enter(.loaf) }
                case .tall: enter(chance(0.5) ? .sit : .loaf)
                case .nibble:
                    if let s = pickSpot(4), chance(0.5) { next = .nibble; goTo(s.p, via: s.via) } else { enter(.sit) }
                case .groom: enter(chance(0.5) ? .sit : .loaf)
                case .freeze: enter(.tall)
                case .hop, .bolt: break
                }
            }
            if hop != nil {
                p = stepBound(0)
            } else {
                // Blend toward the state's pose.
                blend = min(1, blend + dt / blendTime)
                let k = smoothstep(0, 1, blend)
                p = Pose.blend(poseFrom, Pose.named(poseToName), k)
                pose = p
                // Grooming: the near fore paw up to the face, moving in little circles.
                if state == .groom {
                    groomT += dt
                    let g = sin(groomT * 9) * 0.5 + 0.5
                    groomPaw = (0.1 + g * 0.2, 1.9 + g * 0.25, 2.6)
                    p.headPitch += sin(groomT * 9) * 0.05
                    headYaw = approach(headYaw, 0.45, 0.3, dt)
                } else {
                    groomPaw = nil
                }
                // Nibbling: small chewing nods and shifts.
                if state == .nibble {
                    p.headPitch += sin(scene.time * 6 + pos.x) * 0.03 * (0.5 + 0.5 * sin(scene.time * 0.7))
                }
            }
        }
        pose = p

        // --- Head and ears -------------------------------------------------------------------
        let relaxed = state == .loaf || state == .nibble || state == .groom
        if let lk = look, !relaxed, hop == nil {
            // Turn the head (and a little of the body's intent) toward the point of interest.
            let dx = lk.x - pos.x, dz = lk.z - pos.z
            let want = angleTo(yaw, atan2(-dz, dx))
            headYaw = approach(headYaw, clamp(want, -1.1, 1.1), 0.25, dt)
            let dy = lk.y - (pos.y + 0.2)
            headPitchExtra = approach(headPitchExtra, clamp(atan2(dy, hypot(dx, dz)) * 0.5, -0.4, 0.4), 0.3, dt)
            // Ears swivel to it.
            let earWant = clamp(want, -1.0, 1.0)
            earL.yaw = approach(earL.yaw, earWant * 0.9, 0.2, dt)
            earR.yaw = approach(earR.yaw, earWant * 0.9, 0.2, dt)
            // Shuffle round if it is far behind.
            if abs(want) > 1.4 && state != .freeze && cooldown <= 0 {
                let sgn: Float = want < 0 ? -1 : 1
                var spot = pos + V3(cos(yaw + sgn * 0.5), 0, -sin(yaw + sgn * 0.5)) * 0.3
                spot.y = pos.y
                next = state == .tall ? .tall : .sit
                goTo(spot)
                cooldown = 2
            }
        } else {
            headYaw = approach(headYaw, state == .groom ? headYaw : 0, 0.6, dt)
            headPitchExtra = approach(headPitchExtra, 0, 0.6, dt)
            earL.yaw = approach(earL.yaw, 0, 0.5, dt)
            earR.yaw = approach(earR.yaw, 0, 0.5, dt)
        }
        // Ear flicks, blinks, breathing, the nose.
        earFlick.t += dt * 4
        if earFlick.t > 1 && Float.random(in: 0..<1) < dt * 0.15 {
            earFlick = (chance(0.5) ? -1 : 1, 0)
        }
        blinkT -= dt
        if blinkT <= 0 { blink = 0.14; blinkT = rnd(3, 8) }
        if blink > 0 { blink -= dt }
        let breathRate: Float = relaxed ? 0.9 : 1.6 + alert * 1.2
        breath = sin(scene.time * TAU * breathRate + pos.x * 3) * 0.5 + 0.5
        let sniffing = !relaxed || state == .nibble
        nose += dt * (sniffing ? 17 : 4)
        if look != nil && state != .freeze { alert = max(alert, 0.3) }

        // --- Place it ------------------------------------------------------------------------
        root.position = V3(pos.x, pos.y + airY, pos.z)
        root.setRotation(0, yaw, 0)
        apply(p)
        if look != nil && !(c.inside && (c.attention > 0 || c.rest > 0.5)) {
            // Interest fades when nothing moves.
            if Float.random(in: 0..<1) < dt * 0.15 { look = nil }
        }
    }

    // MARK: Drawing

    func draw(_ ctx: DrawContext) {
        queue.removeAll(keepingCapacity: true)
        root.render(ctx)
        let e = ctx.encoder
        // The pelt parts.
        ctx.use("peltVertex", "peltFragment")
        for (part, m) in queue where !Aspen.hidden.contains("pelt") {
            guard case .pelt(let mesh, let kind, let ds) = part else { continue }
            var p = HareParams(model: m, misc: V4(kind.rawValue, traits.tint, ds ? 1 : 0, 0))
            e.setVertexBytes(&p, length: MemoryLayout<HareParams>.stride, index: 2)
            e.setFragmentBytes(&p, length: MemoryLayout<HareParams>.stride, index: 3)
            mesh.draw(e)
        }
        if ctx.isShadow { return }
        // The small dark parts: eyes, the rims round them, the nose.
        Std.begin(ctx)
        for (part, m) in queue where !Aspen.hidden.contains("harestd") {
            guard case .std(let mesh, var params) = part else { continue }
            params.model = m
            Std.draw(ctx, mesh, params)
        }
        // The fur strands over everything.
        ctx.use("strandVertex", "strandFragment", alphaToCoverage: true)
        for (part, m) in queue where !Aspen.hidden.contains("strands") {
            guard case .fur(let f) = part else { continue }
            var p = HareParams(model: m, misc: V4(0, traits.tint, 1, 0))
            e.setVertexBytes(&p, length: MemoryLayout<HareParams>.stride, index: 2)
            e.setFragmentBytes(&p, length: MemoryLayout<HareParams>.stride, index: 3)
            e.setVertexBuffer(f.vertices, offset: 0, index: 0)
            e.drawIndexedPrimitives(type: .triangle, indexCount: f.count, indexType: .uint32, indexBuffer: f.indices, indexBufferOffset: 0)
        }
    }

    /// The contact shadow on the snow under it: soft, fading as it leaves the ground.
    func drawShadowBlob(_ ctx: DrawContext) {
        let opacity = 0.7 * (1 - 0.6 * scene.light.night) * (1 - smoothstep(0, 0.3, airY) * 0.6)
        let m = compose(V3(pos.x, pos.y + 0.012, pos.z), quatAxis(yaw, 0, 1, 0), V3(0.8 * size, 1, 0.6 * size))
        Std.begin(ctx, blend: .alpha)
        Std.draw(ctx, kit.plane, StdParams(model: m, color: .zero, opacity: opacity, roughness: 1, flags: [.map, .unlit, .noFog, .clampMap]),
                 map: kit.blob)
    }

    var debugDescription: String {
        String(format: "(%.2f, %.2f, %.2f) yaw %.2f %@ alert %.2f", pos.x, pos.y, pos.z, yaw, state.rawValue, alert)
    }
}

extension Shaders {
    static let hare = """

    // MARK: - Snowshoe hare

    struct HareParams { float4x4 model; float4 misc; };   // misc: x = coat kind, y = tint, z = double-sided
    struct PeltOut { float4 position [[position]]; float3 world; float3 normal; float2 uv; };

    vertex PeltOut peltVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], constant HareParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float4 w = P.model * float4(a.xyz, 1.0);
        PeltOut o;
        o.world = w.xyz;
        o.normal = transformNormal(P.model, b.xyz);
        o.uv = float2(a.w, b.w);
        o.position = F.viewProj * w;
        return o;
    }

    /// The sky lights the back and leaves the belly and the undersides in a cool shade, which is
    /// what gives a white animal its shape on a white day.
    inline float3 hareForm(float up, float floor) {
        float form = smoothstep(-0.9, 0.9, up);
        return mix(float3(0.50, 0.56, 0.69), float3(1.0), floor + (1.0 - floor) * form);
    }

    /// The pelt: white with the faint grey of the underfur in the shade, soft at the edges.
    fragment float4 peltFragment(PeltOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                 constant HareParams& P [[buffer(3)]]) {
        float3 n = length_squared(in.normal) > 1e-12 ? normalize(in.normal) : float3(0.0, 1.0, 0.0);
        if (P.misc.z > 0.5 && !front) n = -n;
        float2 uv = in.uv;
        int kind = int(P.misc.x + 0.5);
        // The coat lies in strands along the body: fine streaks, fading out before they alias.
        float2 sp = float2(uv.x * 120.0, uv.y * 6.0);
        float streak = vnoise(sp) * 0.5 + vnoise(sp * float2(2.1, 1.3) + 7.0) * 0.3 + vnoise(sp * float2(4.3, 1.7) + 3.0) * 0.2;
        float px = fwidthf(sp.x);
        streak = mix(0.5, streak, 1.0 - smoothstep(0.25, 0.6, px));
        float g = vnoise(uv * float2(30.0, 60.0));
        float3 fur = mix(float3(0.86, 0.88, 0.91), float3(0.97, 0.97, 0.98), smoothstep(0.2, 0.8, g * 0.5 + streak * 0.5));
        fur *= hareForm(n.y, 0.15);
        if (kind == 2) {
            // Ears: black tips, and the inside greyish-pink where the fur is thin.
            float tip = smoothstep(0.82, 0.88, uv.y + (vnoise(uv * 40.0) - 0.5) * 0.06);
            fur = mix(fur, float3(0.025, 0.023, 0.022), tip);
            float inner = smoothstep(0.2, 0.5, sin(uv.x * 6.2831) * -1.0);
            fur = mix(fur, float3(0.5, 0.42, 0.42), inner * 0.5 * (1.0 - tip));
        } else if (kind == 1) {
            // The muzzle a touch greyer toward the nose.
            fur = mix(fur, float3(0.7, 0.7, 0.72), smoothstep(0.85, 1.0, uv.y) * 0.4);
        } else if (kind == 3) {
            fur = mix(fur, float3(0.45, 0.45, 0.47), smoothstep(0.5, 0.9, sin(uv.x * 6.2831)) * 0.45);
        }
        // A winter coat is a touch creamier than fresh snow, which is blue-white: just enough to part them.
        fur *= P.misc.y * float3(1.0, 0.985, 0.95);
        float3 c = standardLight(F, fur, n, in.world, 0.85, 0.0, float2(1.0), geometryRoughness(n));
        // The soft halo of fur at the silhouette: light from the sky scatters through the tips.
        float3 V = normalize(F.camera.xyz - in.world);
        float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        c += F.skyLight.xyz * rim * 0.35 * fur;
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    struct StrandOut { float4 position [[position]]; float3 world; float3 normal; float2 uv; float seed; };

    /// Fur cards: (position, u), (normal, v), (seed) per vertex.
    vertex StrandOut strandVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                  constant Frame& F [[buffer(1)]], constant HareParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 3], b = verts[vid * 3 + 1], c = verts[vid * 3 + 2];
        float2 uv = float2(a.w, b.w);
        float t = F.misc.x;
        // The tips stir a little in the air.
        float3 p = a.xyz + float3(sin(t * q(2.1) + c.x * 20.0), 0.0, cos(t * q(1.7) + c.x * 30.0)) * 0.0008 * uv.y * uv.y;
        float4 w = P.model * float4(p, 1.0);
        StrandOut o;
        o.world = w.xyz;
        o.normal = transformNormal(P.model, b.xyz);
        o.uv = uv;
        o.seed = c.x;
        o.position = F.viewProj * w;
        return o;
    }

    /// The hair cards: three strands per card, alpha to coverage.
    fragment float4 strandFragment(StrandOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                   constant HareParams& P [[buffer(3)]]) {
        float x = in.uv.x * 3.0 + in.seed * 0.5;
        float d = abs(fract(x) - 0.5);
        float fw = max(fwidthf(x), 0.02);
        float w = 0.16 * (1.0 - in.uv.y * 0.7);
        float a = 1.0 - smoothstep(w - fw, w + fw, d);
        a *= 1.0 - smoothstep(0.8, 1.0, in.uv.y);
        if (a < 0.03) discard_fragment();
        // Without multisampling there is no alpha to coverage: cut at one half instead (Low Power).
        if (F.screen.w < 0.5) { if (a < 0.5) discard_fragment(); a = 1.0; }
        // A degenerate card has no normal: face the sky rather than shade with NaN (which the bloom
        // spreads into a black square).
        float3 n = length_squared(in.normal) > 1e-12 ? normalize(in.normal) : float3(0.0, 1.0, 0.0);
        if (!front) n = -n;
        float3 col = mix(float3(0.82, 0.83, 0.86), float3(0.97, 0.97, 0.98), in.uv.y) * P.misc.y * float3(1.0, 0.985, 0.95);
        // The same sky shading as the pelt beneath, gentler, so the coat keeps its form.
        col *= hareForm(n.y, 0.3);
        float3 c = standardLight(F, col, n, in.world, 0.85, 0.0, float2(1.0), geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), a);
    }

    """
}
