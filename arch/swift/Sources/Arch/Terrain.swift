import AppKit
import CoreGraphics
import Foundation
import Metal
import MetalKit
import simd

// The land: a heightfield of Navajo sandstone round a lake (the cliff mass on the left, the
// abutment on the right, the wall beyond, the mesas in the distance, the beach and the rocky bank
// under the viewer), the natural bridge spanning the lake, and the rock material that wraps them
// in the owner's own Lake Powell photographs.
//
// Units are metres. The water is y = 0, the viewer stands at the origin on the near bank, the
// bridge spans the lake 150 m away toward -z.

// MARK: - The reference picture and its camera

/// The land is shaped to the owner's reference picture. Its edges, traced in picture pixels
/// (2000 x 1116, [column, row] polylines), are cast back through the camera the picture is taken
/// to have been made with: the viewer's own, at the origin `eyeY` above the water, looking down
/// -z, pitched up `pitch`, with a 50 degree vertical field. Each mass is then the visual hull of
/// its traced skyline at the depth we give it, so from the viewer's eye its outline is the
/// picture's. The picture fixes outlines, not distances; the depths are ours.
enum Ref {
    static let w: Float = 2000, h: Float = 1116, fov: Float = 50, eyeY: Float = 2.7, pitch: Float = 2 * .pi / 180
    static let t = tan(fov / 2 * .pi / 180)
    static let a = w / h

    /// The world direction of the ray through picture pixel (px, py).
    static func ray(_ px: Float, _ py: Float) -> V3 {
        let nx = px / w * 2 - 1, ny = 1 - py / h * 2
        let x = nx * t * a, y0 = ny * t, z0: Float = -1
        let c = cos(pitch), s = sin(pitch)
        return V3(x, y0 * c - z0 * s, y0 * s + z0 * c)
    }

    /// Where that ray is at depth z.
    static func point(_ px: Float, _ py: Float, _ z: Float) -> V3 {
        let d = ray(px, py), k = z / d.z
        return V3(d.x * k, eyeY + d.y * k, z)
    }

    /// The picture pixel a world point falls on.
    static func pixel(_ x: Float, _ y: Float, _ z: Float) -> V2 {
        let c = cos(pitch), s = sin(pitch)
        let yy = y - eyeY
        let y0 = yy * c + z * s, z0 = -yy * s + z * c
        let nx = x / -z0 / (t * a), ny = y0 / -z0 / t
        return V2((nx + 1) / 2 * w, (1 - ny) / 2 * h)
    }

    /// The x where the ray down picture column px passes depth z.
    static func colX(_ px: Float, _ z: Float) -> Float { point(px, h / 2, z).x }

    /// The reference camera's view-projection, for projecting the picture back onto the rock:
    /// the viewer's own camera at load (pitched up 2 degrees), at the picture's aspect.
    static var matrix: simd_float4x4 {
        let proj = simd_float4x4(perspectiveFovY: fov * .pi / 180, aspect: a, near: 0.2, far: 60_000)
        let cam = simd_float4x4(translation: V3(0, eyeY, 0)) * simd_float4x4(quatAxis(pitch, 1, 0, 0))
        return proj * cam.inverse
    }
}

/// A traced edge: picture rows by column, interpolated along the polyline and held past its ends.
struct Curve {
    let points: [V2]
    init(_ p: [(Float, Float)]) { points = p.map { V2($0.0, $0.1) } }

    func row(_ px: Float) -> Float {
        if px <= points[0].x { return points[0].y }
        guard px < points[points.count - 1].x else { return points[points.count - 1].y }
        // Binary search for the segment (the skyline has hundreds of points).
        var lo = 0, hi = points.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if points[mid].x < px { lo = mid } else { hi = mid }
        }
        let p0 = points[lo], p1 = points[hi]
        return lerp(p0.y, p1.y, (px - p0.x) / (p1.x - p0.x))
    }
}

/// The traced edges, measured off the picture column by column (every 25 px): the skyline is the
/// first row from the top where eight rows running are not sky; through the opening, the underside
/// is where sky begins again below the span and the far wall where it ends.
enum Trace {
    static let skyRows: [Float] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 77, 123, 177, 192, 171, 145, 131, 123, 120, 118, 116, 114, 111, 111, 109, 105, 101, 105, 112, 115, 120, 125, 131, 140, 148, 157, 172, 184, 194, 194, 199, 203, 208, 213, 220, 226, 236, 247, 252, 258, 266, 268, 271, 276, 282, 286, 292, 299, 271, 268, 277, 279, 274, 278, 298, 299, 284, 271, 259, 245, 229, 214, 200, 195, 194, 202, 223, 223, 201]
    /// The skyline across the whole picture (the tower above the frame, the span, the dome), and
    /// on mirrored past each edge of the frame, as the picture is.
    static let sky: Curve = {
        let n = skyRows.count
        var p: [(Float, Float)] = []
        for i in (1..<n).reversed() { p.append((-Float(i) * 25, skyRows[i])) }       // mirrored, left of the frame
        for i in 0..<n { p.append((Float(i) * 25, skyRows[i])) }
        for i in (0..<(n - 1)).reversed() { p.append((4000 - Float(i) * 25, skyRows[i])) }  // mirrored, right of the frame
        return Curve(p)
    }()
    /// The underside of the span: the opening's upper edge, running down the buttress faces at each
    /// end and on below the water, where the legs stand.
    static let archBottom = Curve([(480, 700), (497, 583), (504, 565), (560, 496), (659, 422), (783, 360), (850, 352), (900, 342), (925, 338), (950, 336), (975, 333), (1000, 333), (1025, 336), (1050, 338), (1075, 340), (1100, 343), (1125, 347), (1150, 354), (1175, 362), (1200, 370), (1250, 372), (1300, 375), (1350, 380), (1400, 385), (1450, 390), (1500, 398), (1550, 408), (1600, 440), (1640, 520), (1660, 620), (1680, 700)])
    /// The far wall seen through the opening.
    static let far = Curve([(0, 352), (850, 352), (900, 348), (925, 352), (950, 354), (975, 358), (1000, 364), (1025, 369), (1050, 392), (1075, 396), (1100, 403), (1125, 410), (1150, 406), (1175, 399), (1200, 395), (2200, 395)])
    /// The nearer wall on the canyon's right, behind the craft.
    static let right = Curve([(1180, 430), (1230, 358), (1300, 360), (1400, 365), (1550, 375), (1700, 385), (2200, 385)])
    /// Where the gap of sky under the span runs, in columns.
    static let gap: (Float, Float) = (890, 1215)
}

/// The picture's sky, as a mask drawn from the traces (1 = sky): everything above the skyline, and
/// the gap under the span; each grown four pixels into the rock, so a surface point that lands
/// within a few pixels of an edge counts as sky and the shader steps off it. Row 0 is the top.
let refMask: MTLTexture = {
    let c = Canvas(Int(Ref.w), Int(Ref.h), gray: true)
    let g = c.ctx
    g.setFillColor(gray: 0, alpha: 1)
    g.fill(CGRect(x: 0, y: 0, width: Int(Ref.w), height: Int(Ref.h)))
    g.setFillColor(gray: 1, alpha: 1)
    let sky = CGMutablePath()
    sky.move(to: CGPoint(x: 0, y: -10))
    var x: Float = 0
    while x <= Ref.w { sky.addLine(to: CGPoint(x: CGFloat(x), y: CGFloat(Trace.sky.row(x) + 4))); x += 4 }
    sky.addLine(to: CGPoint(x: CGFloat(Ref.w), y: -10))
    sky.closeSubpath()
    g.addPath(sky)
    g.fillPath()
    let gap = CGMutablePath()
    x = Trace.gap.0
    gap.move(to: CGPoint(x: CGFloat(x), y: CGFloat(Trace.archBottom.row(x) - 4)))
    while x <= Trace.gap.1 { gap.addLine(to: CGPoint(x: CGFloat(x), y: CGFloat(Trace.archBottom.row(x) - 4))); x += 4 }
    x = Trace.gap.1
    while x >= Trace.gap.0 { gap.addLine(to: CGPoint(x: CGFloat(x), y: CGFloat(Trace.far.row(x) + 4))); x -= 4 }
    gap.closeSubpath()
    g.addPath(gap)
    g.fillPath()
    return GPU.shared.mask(c)
}()

// MARK: - The shape of the land

/// A mass of rock under a traced skyline: full height between picture columns c0..c1 and depths
/// zBack..zFront, eased over `edge` metres at the sides and the back, sheer at the front. Its top
/// is flat behind the front, at the height where the front edge meets the skyline's ray, so from
/// the eye its outline is the trace.
private func hullMass(_ x: Float, _ z: Float, _ curve: Curve, _ c0: Float, _ c1: Float, _ zBack: Float, _ zFront: Float, _ edge: Float) -> Float {
    if z > zFront { return 0 }
    let x0 = Ref.colX(c0, z), x1 = Ref.colX(c1, z)
    let w = smoothstep(0, edge, min(x - x0, x1 - x, z - zBack))
    if w <= 0 { return 0 }
    var y: Float = 0
    for _ in 0..<2 {
        let px = Ref.pixel(x, y, zFront).x
        y = Ref.point(px, curve.row(px), zFront).y
    }
    return w * y
}

/// The lake's left shoreline: the near bank the viewer stands on, then a bay out of frame to the
/// left, then the beach.
private let shore: [V2] = [V2(10, -1), V2(0, -2), V2(-6.4, -3.1), V2(-8.2, -4.7), V2(-10.9, -6.8), V2(-13, -8.2), V2(-16.3, -10.5), V2(-21.6, -15.3), V2(-32.4, -25.9), V2(-36, -29.9), V2(-38, -70), V2(-56, -70), V2(-58.7, -48.9), V2(-64.5, -48.4), V2(-67.2, -44.8), V2(-71.6, -41.8), V2(-76.7, -38.4), V2(-84.7, -35.4), V2(-107.2, -35.8), V2(-128.4, -38.6), V2(-160, -32), V2(-400, -32)]

/// x of the water's edge at z (z first in each pair), traced from the picture.
func shoreX(_ z: Float) -> Float {
    var x: Float
    if z >= shore[0].x {
        x = shore[0].y
    } else {
        x = shore[shore.count - 1].y
        for i in 1..<shore.count where z >= shore[i].x {
            let p0 = shore[i - 1], p1 = shore[i]
            x = lerp(p0.y, p1.y, (z - p0.x) / (p1.x - p0.x))
            break
        }
    }
    // A wobble that stays a few picture pixels wide at any distance.
    return x + Float(fbm2(Double(z * 0.02 + 3), 1.7, 3) - 0.5) * 0.02 * max(-z, 0)
}

/// Height of the ground at (x, z), in metres above the water (negative under it).
func groundHeight(_ x: Float, _ z: Float) -> Float {
    // The lake floor: a trough 9 m deep along the middle, shallowing toward every shore.
    var h: Float = -9
    let n2 = Float(fbm2(Double(x * 0.02 + 1), Double(z * 0.02 + 9), 3) - 0.5)
    // The left beach: sand rising gently from the water's edge toward the cliff foot; the near bank
    // the viewer stands on is its first few metres. Past the water's edge the floor drops steeply,
    // so the water is dark right up to the shore, as the picture has it; and the bank meets the
    // water nearly flat, so the shore stands where the picture has it.
    let sx = shoreX(z)
    let beach = (x < sx ? (sx - x) * 0.11 : (sx - x) * 1.6) + 0.1
    if z < 10 { h = max(h, min(beach, 4.5 + n2 * 1.5)) }
    // Rock masses, each the hull of its traced skyline.
    var rock: Float = 0
    rock = max(rock, hullMass(x, z, Trace.sky, -1500, 375, -220, -120, 10))     // the tower on the left
    rock = max(rock, hullMass(x, z, Trace.sky, 1540, 3600, -260, -165, 10))     // the dome on the right
    rock = max(rock, hullMass(x, z, Trace.right, 1180, 3600, -420, -300, 14))   // the canyon's right wall
    rock = max(rock, hullMass(x, z, Trace.far, -1500, 760, -520, -350, 14))     // the canyon's left wall
    rock = max(rock, hullMass(x, z, Trace.far, 560, 1320, -620, -450, 14))      // the far wall across the opening
    rock = max(rock, hullMass(x, z, Trace.far, -2000, 4000, -1100, -900, 30))   // the skyline beyond
    if rock > 0.02 { h = max(h, rock) }
    // Under the water the floor is sand; above it the beach and the rock carry small roughness.
    if h > 0.3 { h += Float(fbm2(Double(x * 0.3 + 5), Double(z * 0.3 + 11), 2) - 0.5) * 0.25 }
    return h
}

/// Is a world point inside rock (below the ground surface or in the bridge)?
func insideRock(_ p: V3) -> Bool { p.y < groundHeight(p.x, p.z) || bridgeInside(p) }

// MARK: - The bridge

/// The span lies in the plane z = -150, a slim rib at the crown swelling into broad buttresses
/// toward each end; its top and underside follow the traced edges exactly: at each station the
/// elliptical section is sized and placed so the rays to the two edges are tangent to it.
enum BridgeShape {
    static let z: Float = -150
    static let x0 = Ref.colX(340, -150), x1 = Ref.colX(1690, -150)
    static let crownT: Float = 0.33, crownHalfT: Float = 9, legHalfT: Float = 42

    /// The section at fraction t along the span: its centre and half height and half thickness.
    static func path(_ t: Float) -> (x: Float, y: Float, z: Float, halfH: Float, halfT: Float) {
        let x = lerp(x0, x1, t)
        // Thickness: slim at the crown, flaring fast toward the feet.
        let u = abs(t - crownT) / max(crownT, 1 - crownT)
        let halfT = lerp(crownHalfT, legHalfT, pow(min(u, 1), 1.6))
        // The picture column this station is seen in, and the rays to the traced top and underside.
        let px = Ref.pixel(x, 30, z).x
        let top = Ref.ray(px, Trace.sky.row(px)), bot = Ref.ray(px, Trace.archBottom.row(px))
        let yt = Ref.eyeY + top.y * (z / top.z), yb = Ref.eyeY + bot.y * (z / bot.z)
        let tt = top.y / -top.z, tb = bot.y / -bot.z
        // An ellipse (a tall, b deep) centred at yc is tangent to a ray of slope s passing yc + D at
        // its centre's depth when D^2 = a^2 + b^2 s^2; two rays fix a and yc.
        let H = max(yt - yb, 2)
        let Dt = (H + halfT * halfT * (tt * tt - tb * tb) / H) / 2
        let halfH = max(Dt * Dt - halfT * halfT * tt * tt, 1).squareRoot()
        return (x, yt - Dt, z, halfH, halfT)
    }
}

func bridgeInside(_ p: V3) -> Bool {
    let t = clamp((p.x - BridgeShape.x0) / (BridgeShape.x1 - BridgeShape.x0), 0, 1)
    let q = BridgeShape.path(t)
    let dy = (p.y - q.y) / q.halfH, dz = (p.z - q.z) / q.halfT
    return dy * dy + dz * dz < 1
}

/// The bridge's surface nearest a point, with the outward normal (for the craft and the blocks).
func bridgeContact(_ p: V3) -> (point: V3, normal: V3, inside: Bool) {
    let t = clamp((p.x - BridgeShape.x0) / (BridgeShape.x1 - BridgeShape.x0), 0, 1)
    let q = BridgeShape.path(t)
    let dy = p.y - q.y, dz = p.z - q.z
    var k = hypot(dy / q.halfH, dz / q.halfT)
    if k == 0 { k = 1e-3 }
    let normal = V3(0, dy / (q.halfH * q.halfH), dz / (q.halfT * q.halfT)).normalized
    return (V3(p.x, q.y + dy / k, q.z + dz / k), normal, k < 1)
}

/// A winding check: the vertex normal at `index` must satisfy `expect`; if it does not, the
/// triangles are wound the wrong way round and their front faces would be culled, leaving a hollow
/// shell. Flip the index order and recompute.
private func assertOutward(_ m: inout MeshData, _ name: String, at index: Int? = nil, _ expect: (V3) -> Bool) {
    let i = index ?? m.positions.count / 2
    if expect(m.normals[i]) { return }
    for k in stride(from: 0, to: m.indices.count, by: 3) { m.indices.swapAt(k + 1, k + 2) }
    m.computeVertexNormals()
}

final class Bridge {
    private let mesh: GPUMesh

    init(rng: Seeded) {
        let segs = 260, around = 64
        let seed = Double(rng() * 100)
        var m = MeshData()
        for i in 0...segs {
            let t = Float(i) / Float(segs)
            let p = BridgeShape.path(t)
            // Sections stand vertical (in y-z planes), swept along x, so the span's height at each
            // station is exactly the traced one however steeply it climbs.
            for k in 0...around {
                let phi = Float(k) / Float(around) * TAU
                let c = cos(phi), s = sin(phi)
                var base = V3(p.x, p.y + c * p.halfH, p.z + s * p.halfT)
                let n = V3(0, c / p.halfH, s / p.halfT).normalized
                let cx = Double(cos(phi)) * 1.3 + seed, cz = Double(sin(phi)) * 1.3 + seed * 0.7
                var off = Float(fbm2(Double(t) * 30 + cx, cz, 3) - 0.5) * 1.2
                off += Float(fbm2(Double(t) * 120 + cx * 3 + 3, cz * 3 + 9, 2) - 0.5) * 0.4
                base += n * off
                m.positions.append(base)
                m.uvs.append(V2(t, phi / TAU))
            }
        }
        for i in 0..<segs {
            for k in 0..<around {
                let a = UInt32(i * (around + 1) + k), b = a + UInt32(around + 1)
                m.indices += [a, b, a + 1, a + 1, b, b + 1]
            }
        }
        m.computeVertexNormals()
        assertOutward(&m, "bridge", at: Int((BridgeShape.crownT * Float(segs)).rounded()) * (around + 1)) { $0.y > 0 }
        mesh = m.upload()
    }

    /// Above the water and in the refraction too (its legs stand in the lake).
    func draw(_ ctx: DrawContext, lights: RockLights) {
        Rock.draw(ctx, mesh, model: matrix_identity_float4x4, tint: 1, lights: lights, layers: [.main, .above, .below])
    }
}

// MARK: - The heightfield mesh

/// The land: one-metre cells over the bridge, its abutments and the near shore (x within 260 m, z
/// from 60 to -300), growing to 14 m at the skyline: the relief is metres deep and needs them.
final class Terrain {
    private let mesh: GPUMesh

    init() {
        var xs: [Float] = [], zs: [Float] = []
        var x: Float = -900
        while x <= 900 {
            xs.append(x)
            x += abs(x) < 260 ? 1.0 : clamp((abs(x) - 260) * 0.03 + 1.0, 1.0, 14)
        }
        var z: Float = 60
        while z >= -1100 {
            zs.append(z)
            z -= z > -300 ? 1.0 : clamp((-300 - z) * 0.03 + 1.0, 1.0, 14)
        }
        let nx = xs.count, nz = zs.count
        var m = MeshData()
        m.positions = [V3](repeating: .zero, count: nx * nz)
        m.positions.withUnsafeMutableBufferPointer { buf in
            let p = buf.baseAddress!
            DispatchQueue.concurrentPerform(iterations: nz) { j in
                for i in 0..<nx { p[j * nx + i] = V3(xs[i], groundHeight(xs[i], zs[j]), zs[j]) }
            }
        }
        m.uvs = [V2](repeating: .zero, count: nx * nz)
        // Rows run from +z toward -z, so the winding that faces up is (a, a+1, b).
        m.indices.reserveCapacity((nx - 1) * (nz - 1) * 6)
        for j in 0..<(nz - 1) {
            for i in 0..<(nx - 1) {
                let a = UInt32(j * nx + i), b = a + UInt32(nx)
                m.indices += [a, a + 1, b, a + 1, b + 1, b]
            }
        }
        m.computeVertexNormals()
        assertOutward(&m, "terrain") { $0.y > 0 }
        mesh = m.upload()
    }

    /// Above the water only: under it the canyon floor stands in for the land.
    func draw(_ ctx: DrawContext, lights: RockLights) {
        Rock.draw(ctx, mesh, model: matrix_identity_float4x4, tint: 1, lights: lights, layers: .surface)
    }
}

// MARK: - The rock material

/// What the rock shader draws itself, because the photograph fixes the rock's brightness and a scene
/// light cannot brighten it: the craft's eye beam and rim lamps, and how wet it is (the lightning's
/// flash comes from the Frame).
struct RockLights {
    var beam = V4.zero                  // the eye: xyz, w = on (0..1)
    var beamDir = V3(0, 0, -1)
    var beamReach: Float = 900          // the beam stops at the first rock it strikes
    var lamp = V4.zero                  // the craft: xyz, w = brightness (1 + wake * 1.5)
    var craftMatrix = matrix_identity_float4x4
    var lampRing = V2(17, 14)           // the lamps' ring (half length, half width)
    var lampEye: Float = 0              // the eye's azimuth on the ring (no lamp there)
    var wet: Float = 0
}

/// The owner's reference photographs, each drawn at the width in metres it seems to cover (its
/// height follows its aspect), and the reference picture itself, projected from the viewpoint.
private struct Photos {
    let wall: MTLTexture?, wall2: MTLTexture?, wall3: MTLTexture?, streaks: MTLTexture?, reference: MTLTexture?

    static let shared = Photos(wall: load("wall"), wall2: load("wall2"), wall3: load("wall3"), streaks: load("streaks"), reference: load("reference"))

    /// Whatever is present in html/assets (each optional), trying the web version's extensions in order.
    private static func load(_ name: String) -> MTLTexture? {
        for ext in ["webp", "png", "jpg", "jpeg"] {
            guard let url = Assets.url("\(name).\(ext)") else { continue }
            if let t = GPU.shared.load(url, srgb: true) { return t }
            // ImageIO decodes WebP even where the texture loader balks: draw it into a canvas.
            if let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                let c = Canvas(cg.width, cg.height)
                c.ctx.saveGState()
                c.ctx.translateBy(x: 0, y: CGFloat(cg.height))
                c.ctx.scaleBy(x: 1, y: -1)
                c.ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
                c.ctx.restoreGState()
                return GPU.shared.texture(c, srgb: true)
            }
        }
        return nil
    }
}

/// The rock: the reference picture projected from the viewpoint wherever it shows rock, the owner's
/// wall photographs tiled on whatever the projection cannot cover, the relief read off the wall
/// photograph bumping the normal, desert-varnish drips; and drawn into it, the craft's beam and
/// lamps, the lightning, and the wet.
enum Rock {
    /// `RockParams` in the shader.
    private struct Params {
        var model: simd_float4x4
        var refMatrix: simd_float4x4
        var craftMatrix: simd_float4x4
        var beam: V4
        var beamDir: V4               // xyz, w = reach
        var lamp: V4
        var lampRing: V4              // xy ring, z = eye azimuth, w = wet
        var photos: V4                // has wall, wall2, wall3, streaks
        var misc: V4                  // x = has reference, y = tint, z = mirrored pass (no relief)
    }

    private static let refMatrix = Ref.matrix

    /// Draw a rock mesh (positions in its own frame, placed by `model`); `tint` 1 for the land,
    /// 0.55 for the blocks. Visible in the passes `layers` says. Front faces only, as three's
    /// default; in the shadow pass the back faces, as three draws a front-sided caster's shadow.
    static func draw(_ ctx: DrawContext, _ mesh: GPUMesh, model: simd_float4x4, tint: Float, lights: RockLights, layers: Layers) {
        guard ctx.shows(layers) else { return }
        let P = Photos.shared
        var p = Params(model: model, refMatrix: refMatrix, craftMatrix: lights.craftMatrix, beam: lights.beam,
                       beamDir: V4(lights.beamDir, lights.beamReach), lamp: lights.lamp,
                       lampRing: V4(lights.lampRing.x, lights.lampRing.y, lights.lampEye, lights.wet),
                       photos: V4(P.wall != nil ? 1 : 0, P.wall2 != nil ? 1 : 0, P.wall3 != nil ? 1 : 0, P.streaks != nil ? 1 : 0),
                       misc: V4(P.reference != nil ? 1 : 0, tint, ctx.pass == .main ? 0 : 1, 0))
        let e = ctx.encoder
        ctx.use("rockVertex", "rockFragment")
        e.setVertexBytes(&p, length: MemoryLayout<Params>.stride, index: 2)
        e.setFragmentBytes(&p, length: MemoryLayout<Params>.stride, index: 3)
        let blank = GPU.shared.blank
        for (i, t) in [P.wall, P.wall2, P.wall3, P.streaks, P.reference, refMask].enumerated() { e.setFragmentTexture(t ?? blank, index: 3 + i) }
        e.setCullMode(ctx.isShadow ? .front : .back)
        mesh.draw(e)
        e.setCullMode(.none)
    }
}

extension Shaders {
    static let terrain = """

    // MARK: - The rock

    struct RockParams {
        float4x4 model; float4x4 refMatrix; float4x4 craftMatrix;
        float4 beam; float4 beamDir; float4 lamp; float4 lampRing; float4 photos; float4 misc;
    };
    struct RockOut { float4 position [[position]]; float3 world; float3 wn; };

    vertex RockOut rockVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], constant RockParams& P [[buffer(2)]]) {
        float4 w = P.model * float4(verts[vid * 2].xyz, 1.0);
        RockOut o;
        o.world = w.xyz;
        o.wn = transformNormal(P.model, verts[vid * 2 + 1].xyz);
        o.position = F.viewProj * w;
        return o;
    }

    float fbm3(float2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }

    // The relief, read off the owner's photograph of the wall: a height function of world
    // position, differentiated into a bumped normal, with each scale fading before it would alias.
    //   plates: broad slabs of rock, taller than wide, each a little proud of or recessed from its
    //     neighbours, edges eased over a few metres, with a shallow groove along some joints;
    //   bedding: horizontal bands a few metres thick with a small step at some bands' bases, each
    //     band's face leaning back a touch, dipping gently along the wall, with fine laminae in sets;
    //   swell: undulation so no plate is a true plane; and the grain of the sand.
    /// The wall frame: along-wall coordinate u and how much of a face (as against a top) this is.
    void wallFrame(float3 P, float3 n, thread float& u, thread float& face) {
        float3 w = pow(abs(n), float3(4.0)); w /= (w.x + w.y + w.z);
        u = P.z * w.x + P.x * w.z + (P.x + P.z) * 0.7 * w.y;
        face = 1.0 - w.y * 0.85;
    }
    /// Which plate a point is on (cell id and the distance to the plate's edge, metres).
    void plateAt(float u, float y, thread float2& cell, thread float& edgeDist) {
        float ju = u + (fbm3(float2(u, y) * 0.02 + 5.0) - 0.5) * 5.0;
        float jy = y + (fbm3(float2(u, y) * 0.015 + 17.0) - 0.5) * 7.0;
        float cw = 26.0, ch = 44.0;
        cell = float2(floor(ju / cw), floor(jy / ch));
        float2 f = float2(fract(ju / cw), fract(jy / ch));
        edgeDist = min(min(f.x, 1.0 - f.x) * cw, min(f.y, 1.0 - f.y) * ch);
    }
    float rockHeight(float3 P, float3 n, float px) {
        float u, face; wallFrame(P, n, u, face);
        float y = P.y;
        float h = 0.0;
        // Plates.
        {
            float ju = u + (fbm3(float2(u, y) * 0.02 + 5.0) - 0.5) * 5.0;
            float jy = y + (fbm3(float2(u, y) * 0.015 + 17.0) - 0.5) * 7.0;
            float cw = 26.0, ch = 44.0;
            float2 cell = float2(floor(ju / cw), floor(jy / ch));
            float2 f = float2(fract(ju / cw), fract(jy / ch));
            float depth = (hash21(cell) - 0.5) * 1.4;
            float eu = min(f.x, 1.0 - f.x) * cw, ey = min(f.y, 1.0 - f.y) * ch;
            float edge = smoothstep(0.0, 3.0, min(eu, ey));
            h += depth * edge * face * sstep(80.0, 10.0, px);
            float seam = step(0.55, hash21(float2(floor(ju / cw + 0.5), cell.y) + 3.0));
            h -= 0.3 * seam * (1.0 - smoothstep(0.0, 1.4, eu)) * face * sstep(20.0, 3.0, px);
        }
        // Bedding, and fine laminae in sets.
        {
            float sy = y + 0.03 * u + (fbm3(float2(u * 0.01, 3.0)) - 0.5) * 3.0;
            float bandH = 4.5;
            float band = floor(sy / bandH);
            float fb = fract(sy / bandH);
            float r = hash11(band);
            float step1 = r < 0.4 ? 0.0 : (r - 0.7) * 0.5;
            h += step1 * smoothstep(0.0, 0.1, fb) * face * sstep(10.0, 1.5, px);
            h -= fb * 0.05 * face * sstep(10.0, 1.5, px);
            float lamSet = smoothstep(0.45, 0.6, fbm3(float2(u * 0.08, sy * 0.3) + 9.0));
            h += sin(sy * 6.2831853 / 0.12) * 0.005 * lamSet * face * sstep(0.12, 0.02, px);
        }
        // Swell.
        h += (fbm3(float2(u, y) * 0.05 + 2.0) - 0.5) * 0.9 * sstep(60.0, 8.0, px);
        h += (fbm3(float2(u, y) * 0.2) - 0.5) * 0.2 * sstep(12.0, 2.0, px);
        // Sand grain: pits and grains at a few centimetres, and the grain of the sand below that,
        // on every surface (tops too), each fading out before it could alias.
        float2 q2 = float2(u, y);
        h += (vnoise(q2 * 2.5 + 3.0) - 0.5) * 0.014 * sstep(0.7, 0.12, px);
        h += (vnoise(q2 * 12.0) - 0.5) * 0.005 * sstep(0.14, 0.02, px);
        h += (vnoise(q2 * 60.0 + 7.0) - 0.5) * 0.0009 * sstep(0.03, 0.004, px);
        return h;
    }

    /// One photo, tiled in metres, offset per plate so no two slabs show the same patch.
    float3 wallPhoto(texture2d<float> t, sampler s, float size, float aspect, float2 uv, float2 cell, float anchored) {
        float2 o = hash22(cell + 11.0) * 4.0;
        o.y *= 1.0 - anchored;
        float3 a = t.sample(s, tv(float2(uv.x / size + o.x, uv.y / (size * aspect) + o.y))).rgb;
        float3 b = t.sample(s, tv(float2(uv.x / (size * 1.6) + o.y + 2.3, uv.y / (size * 1.6 * aspect) + o.x * (1.0 - anchored)))).rgb;
        float m = smoothstep(0.3, 0.7, fbm3(uv * 0.02 + 31.0));
        return mix(a, b, m);
    }

    /// The rock's colour (lit by the scene) and, through refColor/refMix, the reference picture where
    /// it paints the rock (shown unlit, at its own brightness).
    float3 rockColor(constant RockParams& P, float3 Pw, float3 n, texture2d<float> wall, texture2d<float> streaks,
                     texture2d<float> ref, texture2d<float> mask, sampler rs, sampler cs,
                     thread float3& refColor, thread float& refMix) {
        float u, face; wallFrame(Pw, n, u, face);
        float3 rc = float3(0.0);
        float isRock = 0.0;
        // The reference, projected from where the viewer stands: wherever its pixel is rock (warm,
        // not sky or water) it paints the rock as the photograph has it.
        if (P.misc.x > 0.5) {
            float4 rp = P.refMatrix * float4(Pw, 1.0);
            if (rp.w > 0.0) {
                float2 ruv = rp.xy / rp.w * 0.5 + 0.5;
                if (ruv.y > 0.0) {
                    // Past the picture's edges it goes on mirrored, frame after frame, so land beyond
                    // the frame wears the same rock rather than the fill.
                    ruv.x = abs(fmodGL(ruv.x + 1.0, 2.0) - 1.0);
                    ruv.y = abs(fmodGL(ruv.y + 1.0, 2.0) - 1.0);
                    // The picture's own craft (body and lamp beams) is painted over with the shaded
                    // wall beside it, so the scene's craft is the only one: the body takes the far wall
                    // to its left; the lamp beam, a thin strip reaching out both sides, takes the wall
                    // just below it on the left and the abutment on the right.
                    float2 cd = ruv - float2(0.675, 0.545);
                    float body = smoothstep(0.0, 0.08, 1.0 - length(cd / float2(0.095, 0.11)));
                    float beam = sstep(0.035, 0.015, abs(ruv.y - 0.543)) * smoothstep(0.50, 0.53, ruv.x) * sstep(0.90, 0.87, ruv.x);
                    float2 beamSrc = ruv.x < 0.675 ? ruv + float2(0.0, -0.06) : ruv + float2(0.12, 0.0);
                    float3 rc = ref.sample(cs, tv(ruv)).rgb;
                    float sky = mask.sample(cs, tv(ruv)).r;
                    // A silhouette a few pixels off would wear a rim of sky: step off it into the
                    // rock, down from a skyline, up from the underside.
                    if (sky > 0.05) {
                        float2 rd = ruv - float2(0.0, 0.011), ru = ruv + float2(0.0, 0.011);
                        float sd = mask.sample(cs, tv(rd)).r, su = mask.sample(cs, tv(ru)).r;
                        if (sd < sky) { rc = ref.sample(cs, tv(rd)).rgb; sky = sd; }
                        else if (su < sky) { rc = ref.sample(cs, tv(ru)).rgb; sky = su; }
                    }
                    rc = mix(rc, ref.sample(cs, tv(beamSrc)).rgb, beam);
                    rc = mix(rc, ref.sample(cs, tv(ruv - float2(0.23, 0.0))).rgb, body);
                    // With the land shaped to the picture, whatever the picture shows on rock is rock;
                    // only sky is kept away; and the picture shows water, not rock, below the waterline.
                    isRock = 1.0 - sky;
                    isRock *= smoothstep(-1.5, 0.0, Pw.y);
                    isRock *= smoothstep(0.12, 0.2, rc.g / max(rc.r, 1e-3));
                    // Fade at the picture's bottom edge so nothing is cut off hard.
                    isRock *= smoothstep(0.0, 0.03, ruv.y);
                    refColor = rc;
                    refMix = isRock;
                }
            }
        }
        // The fill: one photo, the bedded wall, projected triplanar at one large scale; only where
        // the reference doesn't already cover the rock.
        float3 col = rc;
        if (isRock < 0.995) {
            float3 w = pow(abs(n), float3(4.0)); w /= (w.x + w.y + w.z);
            float2 cellNone = float2(0.0);
            bool hasWall = P.photos.x > 0.5;
            float3 fx = hasWall ? wallPhoto(wall, rs, 50.0, 0.7, float2(Pw.z, Pw.y), cellNone, 0.0) : float3(0.55);
            float3 fz = hasWall ? wallPhoto(wall, rs, 50.0, 0.7, float2(Pw.x, Pw.y), cellNone, 0.0) : float3(0.55);
            float3 fy = hasWall ? wallPhoto(wall, rs, 50.0, 0.7, float2(Pw.x + Pw.z * 0.3, Pw.z - Pw.x * 0.3), cellNone, 0.0) : float3(0.55);
            col = mix(fx * w.x + fz * w.z + fy * w.y, rc, isRock);
        }
        // Desert varnish drips down the faces, in patches, darkening the rock.
        if (P.photos.w > 0.5) {
            float pale = streaks.sample(rs, tv(float2(u / 55.0, Pw.y / (55.0 * 1.1)))).r;
            float dripArea = smoothstep(0.45, 0.7, fbm3(float2(u * 0.03, Pw.y * 0.01) + 23.0)) * face;
            col *= mix(1.0, 0.3 + 0.7 * pale, dripArea);
        }
        return col * P.misc.y * 1.15;
    }

    fragment float4 rockFragment(RockOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                 constant RockParams& P [[buffer(3)]],
                                 depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                 texture2d<float> wall [[texture(3)]], texture2d<float> wall2 [[texture(4)]],
                                 texture2d<float> wall3 [[texture(5)]], texture2d<float> streaks [[texture(6)]],
                                 texture2d<float> ref [[texture(7)]], texture2d<float> mask [[texture(8)]],
                                 sampler rs [[sampler(0)]], sampler cs [[sampler(1)]], sampler cmp [[sampler(2)]]) {
        float3 Pw = in.world;
        float3 nW = length_squared(in.wn) > 1e-12 ? normalize(in.wn) : float3(0.0, 1.0, 0.0);
        float px = length(fwidth(Pw));
        float3 refColor = float3(0.0);
        float refMix = 0.0;
        float3 albedo = rockColor(P, Pw, nW, wall, streaks, ref, mask, rs, cs, refColor, refMix);
        albedo *= 1.0 - refMix * 0.85;
        // The slope of the height along two tangents, by finite differences in world space with a
        // step no smaller than a pixel's footprint: smooth, and free of the 2x2-pixel-quad
        // quantisation that screen-space derivatives carry.
        float3 t1 = normalize(cross(nW, abs(nW.y) < 0.9 ? float3(0.0, 1.0, 0.0) : float3(1.0, 0.0, 0.0)));
        float3 t2 = cross(nW, t1);
        // Where the reference paints the rock, the lit part is a seventh of its colour and the relief
        // would not show; nor in the mirrored passes: there the bump is left out.
        float3 n = nW;
        float bump = P.misc.z > 0.5 ? 0.0 : 1.0 - smoothstep(0.85, 0.97, refMix);
        if (bump > 0.0) {
            float e = max(0.06, px * 1.5);
            float h0 = rockHeight(Pw, nW, px);
            float h1 = rockHeight(Pw + t1 * e, nW, px);
            float h2 = rockHeight(Pw + t2 * e, nW, px);
            n = normalize(nW - bump * (t1 * (h1 - h0) / e + t2 * (h2 - h0) / e));
        }
        if (!front) n = -n;
        float wet = P.lampRing.w;
        // Wet rock is glossy.
        float rough = mix(0.9, 0.22, wet);
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, Pw, n);
        float3 c = standardLight(F, albedo, n, Pw, rough, 0.0, shadow, geometryRoughness(nW));
        // The photograph is already lit: where it paints the rock it shows as it is, unlit. Wet rock
        // is darker; the lightning lights all of it, and glints off the wet faces.
        c += refColor * refMix * 1.15 * (1.0 - 0.42 * wet) * (1.0 + 2.5 * F.flash.w);
        if (F.flash.w > 0.001 && wet > 0.001) {
            float3 V = normalize(F.camera.xyz - Pw);
            float glint = pow(max(dot(reflect(-V, nW), F.flash.xyz), 0.0), 30.0);
            c += float3(0.8, 0.85, 1.0) * glint * F.flash.w * wet * 0.8;
        }
        // The craft's eye beam: the picture fixes how bright the rock is, so a scene light cannot
        // brighten it; the beam is drawn here instead, a red cone from the eye on whatever faces it.
        if (P.beam.w > 0.001) {
            float3 toP = Pw - P.beam.xyz;
            float dist = length(toP);
            float3 dir = toP / max(dist, 1e-3);
            float cone = smoothstep(0.955, 0.988, dot(dir, P.beamDir.xyz));
            float facing = max(dot(nW, -dir), 0.0);
            float fall = 1.0 / (1.0 + dist * dist * 0.0003);
            // It stops at the first rock it strikes: nothing beyond that distance is lit, so it
            // cannot seem to shine out of the inside of a mass.
            float reach = 1.0 - smoothstep(P.beamDir.w * 1.08 + 4.0, P.beamDir.w * 1.2 + 12.0, dist);
            c += float3(1.0, 0.16, 0.08) * cone * (0.25 + 0.75 * facing) * fall * reach * P.beam.w * 0.35;
        }
        // The craft's running lights: sixteen small spots round its waist, each at its place on the
        // ring and shining outward in a tight cone that dies within a few dozen metres, so the
        // underside of the span picks up a row of small discs as it passes beneath.
        if (P.lamp.w > 0.001) {
            float3x3 rot = float3x3(P.craftMatrix[0].xyz, P.craftMatrix[1].xyz, P.craftMatrix[2].xyz);
            float glow = 0.0;
            for (int i = 0; i < 16; i++) {
                float a = (float(i) + 0.5) / 16.0 * 6.2831853;
                if (abs(atan2(sin(a - P.lampRing.z), cos(a - P.lampRing.z))) < 0.3) continue;
                float3 lp = (P.craftMatrix * float4(cos(a) * P.lampRing.x, 0.0, sin(a) * P.lampRing.y, 1.0)).xyz;
                float3 ld = normalize(rot * float3(cos(a) / P.lampRing.x, 0.0, sin(a) / P.lampRing.y));
                float3 toP = Pw - lp;
                float dist = length(toP);
                float3 dir = toP / max(dist, 1e-3);
                // A tight cone: a small disc that never meets its neighbours'.
                float cone = smoothstep(0.985, 0.997, dot(dir, ld));
                float facing = max(dot(nW, -dir), 0.0);
                glow += cone * (0.2 + 0.8 * facing) / (1.0 + dist * dist * 0.008);
            }
            c += float3(1.0, 0.6, 0.22) * glow * P.lamp.w * 0.3;
        }
        return float4(applyFog(F, c, length(Pw - F.camera.xyz)), 1.0);
    }

    """
}
