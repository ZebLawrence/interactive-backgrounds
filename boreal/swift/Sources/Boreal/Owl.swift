import Foundation
import Metal
import simd

// The great grey owl (Strix nebulosa): its body, face, wings and feet, and how it hunts.
//
// The largest owl of the boreal forest by length (around 70 cm, a 1.4 m wingspan) but mostly
// feathers: a big round head with no ear tufts, nearly as wide as the body, on a heavy bell of a
// body that tapers into a long tail. Its huge facial disc is ringed with fine concentric grey
// lines, centred on each of its small yellow eyes; white "eyebrows" curve between the eyes and a
// white bow tie sits under a black chin. It hunts voles by ear from a low perch at the forest
// edge: it turns its head to the sound, bobs to fix it, glides down, hovers, and plunges into the
// snow with its wings flung up and its legs and talons thrust out ahead, breaking through crust
// that would hold a person, then sits mantling with its wings spread before it flies off. The
// prints it leaves, a pit flanked by long wing marks, are a winter classic.
//
// The wings are skinned on a real bird's skeleton: shoulder, elbow, wrist and the outer hand.
// Folding is the bird's Z-fold (the upper arm swings back, the forearm folds forward along it and
// the hand folds back again), so a folded wing lies along the flank with the primaries crossing
// over the tail, and the same joints flex on every upstroke and lag on every downstroke.

// MARK: - The wing's skeleton and skin

// The wing's bones along the span (m from the shoulder): upper arm, forearm, hand, outer hand.
private let ELBOW: Float = 0.15, WRIST: Float = 0.31, FLEX: Float = 0.46, SPAN: Float = 0.62
// A broad, round-tipped owl wing: the chord stays wide almost to the tip, swept a little back.
private func wingSweep(_ s: Float) -> Float { -0.1 - 0.06 * (s / SPAN) * (s / SPAN) }
private func wingChord(_ s: Float) -> Float {
    let r = s / (SPAN + 0.02)
    return 0.31 * max(0.03, 1 - r * r * r * r).squareRoot() * (1 - 0.15 * exp(-s / 0.03))
}
private func wingLead(_ s: Float) -> Float { wingSweep(s) + wingChord(s) * 0.42 }
private func wingTrail(_ s: Float) -> Float { wingSweep(s) - wingChord(s) * 0.58 }

/// The two bones a point `s` along the span follows, and how much: joints blend over +-2.5 cm.
private func skinAt(_ s: Float) -> (bones: (Int, Int), weights: (Float, Float)) {
    let J = [ELBOW, WRIST, FLEX], h: Float = 0.025
    for j in 0..<3 where s < J[j] + h {
        let k = smoothstep(J[j] - h, J[j] + h, s)
        return ((j, j + 1), (1 - k, k))
    }
    return ((3, 0), (1, 0))
}

/// Each bone's feather fan: upper arm, forearm (the secondaries), hand and outer hand.
private func fan(_ b: Int) -> Int { [4, 7, 5, 6][b] }
private func camber(_ s: Float, _ v: Float) -> Float {
    sin(.pi * min(1, v * 1.4)) * (wingLead(s) - wingTrail(s)) * 0.07 * (1 - s / SPAN * 0.5)
}

/// A flight feather's bone: the arm bone it grows from, its root in wing space, its direction.
private struct FeatherInfo { let attach: Int; let root: V3; let dir: V2 }

/// One wing (sx = 1 right, -1 left), skinned on the shoulder, elbow, wrist and outer-hand bones:
/// a cambered sheet of coverts over the front of the wing, and the flight feathers as separate
/// vanes, 14 secondaries along the forearm and 10 primaries fanning from the hand round the
/// rounded tip. Each feather's base follows the bone it grows from and its tip that bone's
/// feather fan, so the fans close the feathers up as the wing folds. Per vertex, five float4s:
/// (position, s), (normal, v), the feather (across, along, kind, id), bone indices, bone weights.
private func wingGeometry(_ sx: Float) -> (mesh: OwlMesh, feathers: [FeatherInfo]) {
    var pos: [V3] = [], wing: [V2] = [], feather: [V4] = [], si: [V4] = [], sw: [V4] = []
    var idx: [UInt32] = []
    let COV: Float = 0.62   // the coverts reach this far back across the chord
    func push(_ x: Float, _ y: Float, _ z: Float, _ s: Float, _ v: Float, _ f: V4, _ bones: V4, _ weights: V4) -> UInt32 {
        pos.append(V3(sx * x, y, z))
        wing.append(V2(s, v))
        feather.append(f)
        si.append(bones)
        sw.append(weights)
        return UInt32(pos.count - 1)
    }
    func quad(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32) {
        // Front faces are the upper (dorsal) side.
        if sx > 0 { idx += [a, c, b, b, c, d] } else { idx += [a, b, c, b, d, c] }
    }
    // The covert sheet.
    let nu = 30, nv = 6
    var grid: [[UInt32]] = []
    for i in 0...nu {
        let s = SPAN * 0.97 * (Float(i) / Float(nu))
        let (bi, bw) = skinAt(s)
        var col: [UInt32] = []
        for j in 0...nv {
            let v = Float(j) / Float(nv) * COV
            let z = lerp(wingLead(s), wingTrail(s), v)
            let k = smoothstep(0.2, 0.9, v)
            col.append(push(s, camber(s, v) + 0.002, z, s, v, .zero,
                            V4(Float(bi.0), Float(fan(bi.0)), Float(bi.1), Float(fan(bi.1))),
                            V4(bw.0 * (1 - k), bw.0 * k, bw.1 * (1 - k), bw.1 * k)))
        }
        grid.append(col)
    }
    for i in 0..<nu { for j in 0..<nv { quad(grid[i][j], grid[i][j + 1], grid[i + 1][j], grid[i + 1][j + 1]) } }

    // One feather strip from root (s0, z0) to tip (s1, z1), `w` wide, along +s/-z in wing space.
    var info: [FeatherInfo] = []
    func strip(_ s0: Float, _ z0: Float, _ s1: Float, _ z1: Float, _ w: Float, _ kind: Float, _ id: Float, _ lift: Float) {
        // The feather's own bone, child of the bone it grows from; the feather is rigid on it but
        // for its quill, which blends into the attachment bone.
        let fb = Float(8 + info.count)
        let attach = s0 < ELBOW ? 0 : s0 < WRIST ? 1 : s0 < FLEX ? 2 : 3
        info.append(FeatherInfo(attach: attach, root: V3(s0, camber(s0, 0.38) + lift, z0), dir: V2(s1 - s0, z1 - z0)))
        let rows = 7
        let dx = s1 - s0, dz = z1 - z0
        let len = hypot(dx, dz)
        // Across the feather, in the wing plane.
        let ax = -dz / len, az = dx / len
        var ids: [[UInt32]] = []
        for r in 0...rows {
            let t = Float(r) / Float(rows)
            var row: [UInt32] = []
            for u: Float in [-1, 0, 1] {
                let x = s0 + dx * t + ax * u * w * 0.5
                let z = z0 + dz * t + az * u * w * 0.5
                let sv = clamp(x, 0, SPAN)
                let vv = clamp((wingLead(sv) - z) / max(0.02, wingLead(sv) - wingTrail(sv)), 0, 1)
                let y = camber(sv, vv) + lift + (1 - u * u) * 0.0025 - t * 0.002
                let k = smoothstep(0.0, 0.12, t)
                row.append(push(x, y, z, sv, max(vv, 0.45 + 0.55 * t), V4(u, t, kind, id),
                                V4(Float(attach), fb, 0, 0), V4(1 - k, k, 0, 0)))
            }
            ids.append(row)
        }
        for r in 0..<rows {
            for c in 0..<2 {
                // Rows run toward the tip, columns across: orient so the upper side faces up.
                quad(ids[r][c + 1], ids[r][c], ids[r + 1][c + 1], ids[r + 1][c])
            }
        }
    }
    // Secondaries (and tertials near the body), straight back from the arm and forearm.
    for k in 0..<14 {
        let s0 = 0.015 + Float(k) * (WRIST - 0.03) / 13
        let z0 = lerp(wingLead(s0), wingTrail(s0), 0.38)
        let s1 = s0 + 0.012
        let z1 = wingTrail(s1) - 0.004
        strip(s0, z0, s1, z1, 0.042, 1, Float(k), -0.0015 - Float(k % 2) * 0.0012)
    }
    // Primaries, fanning from the hand: their tips run round the wing's rounded outline from the
    // trailing edge out to the wingtip.
    for k in 0..<10 {
        let q = Float(k) / 9
        let sr = WRIST - 0.01 + (FLEX + 0.04 - WRIST) * q
        let zr = lerp(wingLead(sr), wingTrail(sr), 0.3)
        let st = WRIST + 0.05 + (SPAN - WRIST - 0.04) * pow(q, 0.75)
        let zt = wingTrail(st) + (wingLead(st) - wingTrail(st)) * 0.5 * q * q * q - 0.004
        strip(sr, zr, st, zt, 0.044 - 0.012 * q, 2, Float(k), 0.0005 + Float(k) * 0.0011)
    }
    var m = MeshData()
    m.positions = pos
    m.indices = idx
    m.computeVertexNormals()
    var v: [V4] = []
    v.reserveCapacity(pos.count * 5)
    for i in pos.indices { v += [V4(pos[i], wing[i].x), V4(m.normals[i], wing[i].y), feather[i], si[i], sw[i]] }
    return (OwlMesh(v, idx), info)
}

/// A wing's bones: transforms relative to the wing mesh, parents before children. The skin
/// matrices (each bone's transform now times the inverse of its transform at bind time) go to the
/// vertex shader, as three's SkinnedMesh does it.
private final class WingSkeleton {
    var parent: [Int]
    var pos: [V3]
    var quat: [simd_quatf]
    var scale: [V3]
    private var bindInverse: [simd_float4x4] = []
    private(set) var skin: [simd_float4x4] = []

    init(count: Int) {
        parent = [Int](repeating: -1, count: count)
        pos = [V3](repeating: .zero, count: count)
        quat = [simd_quatf](repeating: .identity, count: count)
        scale = [V3](repeating: V3(1, 1, 1), count: count)
    }

    private func relative() -> [simd_float4x4] {
        var rel = [simd_float4x4](repeating: matrix_identity_float4x4, count: pos.count)
        for i in pos.indices {
            let local = compose(pos[i], quat[i], scale[i])
            rel[i] = parent[i] < 0 ? local : rel[parent[i]] * local
        }
        return rel
    }

    func bind() {
        bindInverse = relative().map { $0.inverse }
        skin = [simd_float4x4](repeating: matrix_identity_float4x4, count: pos.count)
    }

    func update() { skin = zip(relative(), bindInverse).map { $0 * $1 } }
}

// MARK: - Other geometry

/// Fluff: a feathered surface is never smooth, least of all its silhouette.
private func fluff(_ g: inout MeshData, _ amount: Float, _ scale: Float) {
    func h(_ x: Float, _ y: Float, _ z: Float) -> Float {
        let s = sin(Double(x * 127.1 * scale + y * 311.7 * scale + z * 74.7 * scale)) * 43758.5453
        return Float(s - floor(s))
    }
    func jsRound(_ v: Float) -> Float { (v + 0.5).rounded(.down) }
    for i in g.positions.indices {
        let p = g.positions[i], n = g.normals[i]
        let k = (h(jsRound(p.x * 60), jsRound(p.y * 60), jsRound(p.z * 60)) - 0.5) * amount
        g.positions[i] = p + n * k
    }
    g.computeVertexNormals()
}

/// The head: a sphere pushed into `headShape`. Per vertex (position, 0), (normal, 0), (direction, 0).
private func headGeometry() -> OwlMesh {
    var g = Geometry.sphere(radius: 1, widthSegments: 56, heightSegments: 40)
    let dirs = g.positions.map { $0.normalized }
    g.positions = dirs.map(headShape)
    g.computeVertexNormals()
    var v: [V4] = []
    for i in g.positions.indices { v += [V4(g.positions[i], 0), V4(g.normals[i], 0), V4(dirs[i], 0)] }
    return OwlMesh(v, g.indices)
}

/// A toe: a short, feathered digit along +z with a black, hooked talon at its tip.
private func toeGeometries() -> (toe: MeshData, talon: MeshData) {
    let toe = Geometry.cylinder(top: 0.0075, bottom: 0.009, height: 0.036, radialSegments: 8)
        .transformed(simd_float4x4(translation: V3(0, 0, 0.018)) * simd_float4x4(rotationX: .pi / 2))
    var talon = Geometry.cone(radius: 0.005, height: 0.022, radialSegments: 8)
    // Curve it: bend the cone's tip downward.
    for i in talon.positions.indices {
        let y = talon.positions[i].y + 0.011   // 0 base .. 0.022 tip
        talon.positions[i].z -= (y / 0.022) * (y / 0.022) * 0.008
    }
    talon = talon.transformed(simd_float4x4(translation: V3(0, -0.002, 0.036)) * simd_float4x4(rotationX: .pi / 2 + 0.45))
    talon.computeVertexNormals()
    return (toe, talon)
}

// MARK: - The kit: geometry shared by every owl

final class OwlKit {
    static let shared = OwlKit()

    fileprivate let body: OwlMesh
    fileprivate let bodyCards: OwlMesh
    fileprivate let headCards: OwlMesh
    fileprivate let head: OwlMesh
    fileprivate let tail: OwlMesh
    fileprivate let wings: [OwlMesh]            // left, right
    fileprivate let feathers: [FeatherInfo]
    fileprivate let eye: OwlMesh
    fileprivate let leg: OwlMesh
    fileprivate let toe: OwlMesh
    fileprivate let beak: GPUMesh
    fileprivate let talon: GPUMesh
    fileprivate let vole: GPUMesh

    private init() {
        let toes = toeGeometries()
        // Thigh and tarsus together, feathered right down to the toes.
        var leg = Geometry.cylinder(top: 0.032, bottom: 0.019, height: 0.18, radialSegments: 12)
        fluff(&leg, 0.004, 2)
        body = owlStdMesh(bodyGeometry())
        bodyCards = bodyCardsGeometry()
        headCards = headCardsGeometry()
        head = headGeometry()
        tail = tailFeathersGeometry()
        let left = wingGeometry(-1), right = wingGeometry(1)
        wings = [left.mesh, right.mesh]
        feathers = right.feathers
        eye = owlStdMesh(Geometry.sphere(radius: 0.0125, widthSegments: 20, heightSegments: 14))
        self.leg = owlStdMesh(leg)
        toe = owlStdMesh(toes.toe)
        beak = Geometry.cone(radius: 0.008, height: 0.026, radialSegments: 10).upload()
        talon = toes.talon.upload()
        vole = Geometry.sphere(radius: 0.03, widthSegments: 12, heightSegments: 8)
            .transformed(simd_float4x4(scale: V3(0.8, 0.75, 1.6))).upload()
    }
}

// MARK: - Individuals

// Great greys vary a lot: females are noticeably bigger than males (by a tenth or more in length,
// far more in weight), and plumage runs from a cool, pale ash grey through silvery birds with
// crisp markings to darker, browner ones; eyes from lemon to deep yellow.

struct OwlTraits {
    var size: Float, girth: Float, height: Float, head: Float, tail: Float
    /// At rest some sit fluffed out round, others sleek and upright.
    var fluff: Float
    /// A habit of carriage: a slight lean, a head held a little tilted.
    var lean: Float, tilt: Float
    var tint: V3, contrast: Float, streak: Float
    var iris: V3
    var plumage: String

    private static let plumages: [(name: String, tint: V3, contrast: Float, streak: Float)] = [
        ("ash", V3(1.15, 1.15, 1.2), 1.0, 1.0),
        ("dusky", V3(0.72, 0.68, 0.64), 1.2, 1.5),
        ("silver", V3(1.1, 1.11, 1.16), 1.35, 0.75),
        ("brown", V3(1.12, 0.9, 0.68), 1.1, 1.25),
        ("pale", V3(1.18, 1.16, 1.11), 0.8, 0.6),
    ]
    private static let irises: [V3] = [V3(0.98, 0.76, 0.1), V3(1.0, 0.86, 0.22), V3(0.95, 0.6, 0.06), V3(0.98, 0.92, 0.35)]

    /// `n` owls that differ from one another: sizes spread out, no two plumages alike.
    static func make(_ rng: Seeded, _ n: Int) -> [OwlTraits] {
        let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
        func shuffle<T>(_ a: [T]) -> [T] {
            var b = a
            var i = b.count - 1
            while i > 0 {
                let j = Int(floor(rng() * Float(i + 1)))
                b.swapAt(i, min(j, i))
                i -= 1
            }
            return b
        }
        let plumage = shuffle(plumages), iris = shuffle(irises)
        // A big female, a small male, and one in between.
        let s0 = R(1.1, 1.17), s1 = R(0.84, 0.9), s2 = R(0.95, 1.03)
        let sizes = shuffle([s0, s1, s2])
        return (0..<n).map { i in
            let p = plumage[i % plumage.count]
            let v = R(0.95, 1.05)
            let size = sizes[i % 3] * R(0.98, 1.02)
            let girth = R(0.86, 1.16), height = R(0.9, 1.12), head = R(0.88, 1.12), tail = R(0.85, 1.15)
            let fluff = R(-0.8, 0.3), lean = R(-0.04, 0.1), tilt = R(-0.12, 0.12)
            let contrast = p.contrast * R(0.92, 1.08), streak = p.streak * R(0.85, 1.15)
            return OwlTraits(size: size, girth: girth, height: height, head: head, tail: tail, fluff: fluff, lean: lean, tilt: tilt,
                             tint: p.tint * v, contrast: contrast, streak: streak, iris: iris[i % iris.count], plumage: p.name)
        }
    }
}

// MARK: - The owl

private let X = V3(1, 0, 0), Y = V3(0, 1, 0), Z = V3(0, 0, 1)
private func qAxis(_ axis: V3, _ a: Float) -> simd_quatf { simd_quatf(angle: a, axis: axis) }
private func mirror(_ q: simd_quatf) -> simd_quatf { simd_quatf(ix: q.imag.x, iy: -q.imag.y, iz: -q.imag.z, r: q.real) }
private func easeInOut(_ t: Float) -> Float { t * t * (3 - 2 * t) }

/// three's `Quaternion.slerp`: the shortest arc.
private func slerp(_ a: simd_quatf, _ b: simd_quatf, _ t: Float) -> simd_quatf {
    var b = b
    if simd_dot(a.vector, b.vector) < 0 { b = simd_quatf(vector: -b.vector) }
    return simd_slerp(a, b, t)
}

private func quatFromBasis(_ x: V3, _ y: V3, _ z: V3) -> simd_quatf { simd_quatf(simd_float3x3(columns: (x, y, z))) }

// The folded wing's shoulder: the upper arm swept back and down along the flank, its upper
// surface facing out (and a little up), so the folded wings wrap round and cover most of the back.
private let foldedShoulder: simd_quatf = {
    let span = V3(0, -sin(1.12), -cos(1.12))
    let out = V3(0.8, 0.2, -0.75)
    let dorsal = (out - span * span.dot(out)).normalized
    let lead = span.cross(dorsal)
    return quatFromBasis(span, dorsal, lead)
}()

// The folded forearm and hand, placed from where the joints lie on a real folded wing (in the
// shoulder's frame): the wrist at the front of the flank just under the shoulder, the wingtip down
// over the tail; each bone's upper surface kept facing out.
private func basis(_ x: V3, _ hint: V3) -> simd_quatf {
    let X1 = x.normalized
    let Y1 = (hint - X1 * X1.dot(hint)).normalized
    return quatFromBasis(X1, Y1, X1.cross(Y1))
}

private let foldedElbowWrist: (simd_quatf, simd_quatf) = {
    let armQ = foldedShoulder
    let elbow = armQ.act(V3(ELBOW, 0, 0))
    let wristTarget = V3(-0.03, -0.035, 0.06)
    // The forearm lies along the flank, its upper surface straight out; the hand over the back.
    let foreQ = basis(wristTarget - elbow, V3(1, 0.1, 0))
    let wrist = elbow + foreQ.act(V3(WRIST - ELBOW, 0, 0))
    let tipTarget = V3(-0.06, -0.33, -0.1)
    let handQ = basis(tipTarget - wrist, V3(0.75, 0.2, -0.6))
    return (armQ.inverse * foreQ, foreQ.inverse * handQ)
}()

final class Owl {
    enum State: String { case perch, listen, takeoff, fly, land, hover, plunge, insnow }

    private enum PathKind { case perch, hunt }
    private struct Path { let curve: Curve3; let len: Float; var s: Float; var speed: Float; let kind: PathKind }
    private enum IdleKind { case preen, ruffle, stretch, scan }
    private struct Idle { let kind: IdleKind; var t: Float; var side: Float = 1; var point = V3.zero }

    /// What a node of the rig draws.
    private enum Part {
        case body(OwlMesh), head, tail, cards(OwlMesh), wing(Int), eye, std(GPUMesh, StdParams)
    }

    private let kit: OwlKit
    let traits: OwlTraits
    let root = Node("owl")
    private let bank = Node("bank"), body = Node("body"), off = Node("off")
    private let tailNode = Node("tail"), neck = Node("neck"), head = Node("head")
    private var eyes: [Node] = []
    private var wings: [(sx: Float, skel: WingSkeleton, fold: [(q: simd_quatf, lift: Float, y: Float)])] = []
    private var legs: [(sx: Float, hip: Node, shank: Node, ankle: Node, toes: [(toe: Node, curl: Node, a: Float)])] = []
    private let voleNode = Node("vole")
    private var queue: [(Part, simd_float4x4)] = []

    // Pose.
    var yaw: Float = 0
    private var headYaw: Float = 0, headPitch: Float = 0, headRoll: Float = 0
    private var headTarget = (yaw: Float(0), pitch: Float(0), roll: Float(0))
    /// Body pitch: 0 upright, about pi/2 flat out in flight.
    private var pitch: Float = 0
    private var bankAngle: Float = 0
    /// Wings: 0 spread .. 1 folded.
    private var fold: Float = 1
    private var flapPhase: Float = 0, flapAmp: Float = 0, flapRate: Float = 2.4
    /// Wings swept forward (-) or back (+); held up in a V (+) or drooped over the snow (-).
    private var sweep: Float = 0, raise: Float = 0
    private var tailSpread: Float = 0, tailLift: Float = 0
    /// The legs' angle from straight down, in the world (+ reaching forward); 1 tucked back along
    /// the belly in flight; 0 drawn up .. 1 fully extended; toes 0 spread wide .. 1 closed round a perch.
    private var legAngle: Float = 0, legTuck: Float = 1, legReach: Float = 0.55, grip: Float = 1
    /// -1 fluffed .. 1 sleeked in alarm.
    private var sleek: Float = 0
    private var lid: Float = 0.45
    private var blinkT = rnd(2, 6)
    private var blink: Float = 0
    private var settle: Float = 0
    private var ruffle: Float = 0
    private var eyeLid: Float = 0
    private var spread: Float = 0.1

    // Behaviour.
    var state = State.perch
    var timer = rnd(4, 10)
    var perch: Perch?
    private var target = V3.zero
    private var path: Path?
    var alarm: Float = 0
    private var bob: Float = 0
    private var idle: Idle?
    private var carry = false
    var cooldown: Float = 0
    private var takeoffDur: Float = 0.55
    private var heavy = false
    private var landFrom = V3.zero, landTo = V3.zero, landPitch: Float = 0
    private var vy: Float = 0

    init(kit: OwlKit, traits: OwlTraits) {
        self.kit = kit
        self.traits = traits
        build()
    }

    private func part(_ p: Part, cast: Bool = true, _ name: String = "") -> Node {
        let n = Node(name)
        n.castShadow = cast
        n.draw = { [unowned self] _, m in self.queue.append((p, m)) }
        return n
    }

    private func build() {
        let T = traits, k = kit
        root.add(bank)
        bank.add(body)
        body.position.y = 0.24
        off.position.y = -0.24
        body.add(off)

        // Proportions: some owls stockier, some taller and slimmer.
        let torso = part(.body(k.body))
        torso.scale = V3(T.girth, T.height, T.girth)
        // The coat of contour feathers over it.
        torso.add(part(.cards(k.bodyCards), cast: false))
        off.add(torso)
        tailNode.position = V3(0, 0.12, -0.095)
        tailNode.add(part(.tail))
        tailNode.scale.y = T.tail
        off.add(tailNode)

        // The head sits right down on the shoulders.
        neck.position = V3(0, 0.405 * T.height, 0.03)
        off.add(neck)
        head.position.y = 0.095
        neck.add(head)
        head.add(part(.head))
        head.add(part(.cards(k.headCards), cast: false))
        head.scale = V3(repeating: T.head)
        for sx: Float in [-1, 1] {
            let eye = part(.eye)
            eye.position = V3(sx * 0.036, 0.013, 0.052)
            eye.setRotation(0, sx * 0.12, 0)
            head.add(eye)
            eyes.append(eye)
        }
        let beak = part(.std(k.beak, StdParams(model: matrix_identity_float4x4, color: RGBA(hex: "#d2c27e").linear, roughness: 0.35)))
        beak.position = V3(0, -0.012, 0.062)
        beak.setRotation(.pi / 2 + 0.55, 0, 0)
        head.add(beak)

        // Wings: skinned on shoulder, elbow, wrist and outer-hand bones; and feather fans on the
        // upper arm (tertials), the hand (inner primaries) and the outer hand (outer primaries).
        let feathers = k.feathers
        for (side, sx) in [Float(-1), 1].enumerated() {
            let skel = WingSkeleton(count: 8 + feathers.count)
            // Bind-pose positions of the arm bones along the span.
            let boneS: [Float] = [0, ELBOW, WRIST, FLEX]
            var fold: [(q: simd_quatf, lift: Float, y: Float)] = []
            for (kk, fi) in feathers.enumerated() {
                skel.pos[8 + kk] = V3(sx * (fi.root.x - boneS[fi.attach]), fi.root.y, fi.root.z)
                skel.parent[8 + kk] = fi.attach
                // Folded, it turns in the plane of the wing to point back toward the tail: along the
                // bone on the upper arm and hand (which point back), toward its base on the forearm
                // (and on the forearm also a little down the flank, so they lie in a panel, not a bundle).
                let heading = atan2(-fi.dir.y, fi.dir.x)
                let want: Float = fi.attach == 1 ? .pi - 0.55 - Float(kk) * 0.025 : 0
                var a = want - heading
                while a > .pi { a -= TAU }
                while a < -.pi { a += TAU }
                fold.append((qAxis(Y, a), 0.002 + Float(kk) * 0.0011, fi.root.y))
            }
            skel.pos[1].x = sx * ELBOW
            skel.pos[2].x = sx * (WRIST - ELBOW)
            skel.pos[3].x = sx * (FLEX - WRIST)
            skel.parent[1] = 0; skel.parent[2] = 1; skel.parent[3] = 2
            skel.parent[4] = 0; skel.parent[5] = 2; skel.parent[6] = 3; skel.parent[7] = 1
            skel.bind()
            let shoulder = Node("shoulder")
            shoulder.position = V3(sx * 0.13 * T.girth, 0.37 * T.height, -0.03)
            shoulder.add(part(.wing(side)))
            off.add(shoulder)
            wings.append((sx, skel, fold))
        }

        // Legs: feathered to the toes, with two toes forward and two back when gripping, all four
        // spread wide when striking.
        for sx: Float in [-1, 1] {
            let hip = Node("hip")
            hip.position = V3(sx * 0.048, 0.12, 0.05)
            let shank = part(.body(k.leg))
            shank.position.y = -0.09
            let ankle = Node("ankle")
            ankle.position.y = -0.18
            var toes: [(toe: Node, curl: Node, a: Float)] = []
            // Inner front, outer front, the reversible outer toe, and the hind toe.
            for a: Float in [0.3, -0.3, -1.7, .pi] {
                let toe = Node("toe")
                toe.setRotation(0, sx * a, 0)
                let curl = Node("curl")
                curl.add(part(.body(k.toe)))
                curl.add(part(.std(k.talon, StdParams(model: matrix_identity_float4x4, color: RGBA(hex: "#0c0a09").linear, roughness: 0.3))))
                toe.add(curl)
                ankle.add(toe)
                toes.append((toe, curl, a))
            }
            hip.add(shank)
            hip.add(ankle)
            off.add(hip)
            legs.append((sx, hip, shank, ankle, toes))
        }
        // The vole, when the strike succeeds, carried off in the talons.
        voleNode.add(part(.std(k.vole, StdParams(model: matrix_identity_float4x4, color: RGBA(hex: "#3a2a1e").linear, roughness: 0.9))))
        voleNode.position = V3(0, -0.02, 0.03)
        voleNode.visible = false
        legs[1].ankle.add(voleNode)
        root.scale = V3(repeating: T.size)
    }

    var busy: Bool { state != .perch }

    func headWorld() -> V3 { head.worldPosition() }

    // MARK: Pose

    private func applyPose(dt: Float) {
        root.setRotation(0, yaw, 0)
        bank.setRotation(0, 0, bankAngle)
        body.setRotation(pitch, 0, 0)
        let sl = sleek
        body.scale = V3(1 - sl * 0.09, 1 + sl * 0.07, 1 - sl * 0.09)
        // The head keeps itself level while the body pitches (owls are superb at this).
        neck.setRotation(-pitch * 0.9, 0, 0)
        head.setRotation(-headPitch, headYaw, headRoll, order: "YXZ")
        head.position.y = 0.095 * traits.head + bob * 0.025
        head.position.z = bob * 0.02
        poseWings()
        // Tail: hangs along the line of the body, fans and drops to brake.
        tailNode.setRotation(0.28 - tailLift * 0.7, 0, 0)
        spread = 0.06 + tailSpread * 0.55
        ruffle = clamp(-sleek, 0, 1.5)
        poseLegs()
        voleNode.visible = carry && (state == .fly || state == .land || state == .takeoff)
        // Blinking.
        blinkT -= dt
        if blinkT < 0 {
            blink = 1
            blinkT = rnd(3, 9)
        }
        blink = max(0, blink - dt * 5)
        let shut = sin(blink * .pi)
        eyeLid = clamp(max(lid, shut), 0, 1)
    }

    private func poseWings() {
        let ph = flapPhase, amp = flapAmp
        // Downstroke with the wing straight; on the upstroke the elbow and wrist flex to draw it in.
        let stroke = sin(ph) * amp
        let upFlex = max(0, cos(ph)) * amp * 0.38
        let lag = cos(ph) * amp * 0.45
        let f = easeInOut(clamp(max(fold, upFlex), 0, 1))
        // Keep the spread wing's chord in the airflow whatever the body's pitch.
        let twist = -pitch * 0.92 + 0.08
        let fwd = V3(0, sin(pitch), cos(pitch))
        let spreadShoulder = qAxis(fwd, stroke * 0.95 + raise * 1.15 + 0.06) * qAxis(X, twist) * qAxis(Y, sweep)
        let shoulder = slerp(spreadShoulder, foldedShoulder, f)
        // Elbow and wrist fold in the plane of the wing: the forearm forward along the upper arm, the
        // hand back along the forearm.
        let elbow = slerp(qAxis(Y, -0.1) * qAxis(Z, -lag * 0.3), foldedElbowWrist.0, f)
        let wrist = slerp(qAxis(Y, 0.16 - sweep * 0.4) * qAxis(Z, -lag * 0.6 + raise * 0.25), foldedElbowWrist.1, f)
        // The outer primaries bend up under load on the downstroke and trail on the upstroke.
        // Folded, the hand tucks its tip in against the body.
        let flex = slerp(qAxis(Z, -lag * 0.7 + stroke * 0.25), qAxis(Y, 0.08), f)
        // Folding, the coverts close up toward the bones (fans 4-7: arm, hand, outer hand,
        // forearm), and every flight feather swings round on its own root to point back toward the
        // tail, sliding in over its neighbour.
        let fans: [Float] = [0.45, 0.5, 0.55, 0.45]
        for w in wings {
            let qs = [shoulder, elbow, wrist, flex]
            for i in 0..<4 { w.skel.quat[i] = w.sx > 0 ? qs[i] : mirror(qs[i]) }
            for (i, sz) in fans.enumerated() {
                w.skel.scale[4 + i] = V3(1, 1, lerp(1, sz, f))
                w.skel.quat[4 + i] = .identity
            }
            for (kk, fd) in w.fold.enumerated() {
                let q = slerp(.identity, fd.q, f)
                w.skel.quat[8 + kk] = w.sx > 0 ? q : mirror(q)
                w.skel.pos[8 + kk].y = fd.y + fd.lift * f
            }
            w.skel.update()
        }
    }

    private func poseLegs() {
        // Hip angle in the body frame for the wanted world angle; tucked, they lie back along the body.
        let down = -legAngle - pitch
        let hipX = lerp(down, 0.15, legTuck)
        let reach = legReach
        for L in legs {
            L.hip.setRotation(hipX, 0, L.sx * (0.06 + 0.12 * (1 - grip)))
            L.shank.scale.y = 0.4 + 0.8 * reach
            L.shank.position.y = -0.09 * L.shank.scale.y
            L.ankle.position.y = -0.18 * L.shank.scale.y
            // Keep the foot level with the ground when perched; flex it toward the target otherwise.
            L.ankle.setRotation(-hipX * (1 - legTuck) * 0.8 - pitch * (1 - legTuck) * 0.2, 0, 0)
            for t in L.toes {
                // Spread: the toes fan out wide, the talons open; grip: they curl round the perch.
                let sgn: Float = t.a < 0 ? -1 : 1
                let spreadA = t.a + sgn * (1 - grip) * 0.35
                t.toe.setRotation(0, L.sx * spreadA, 0)
                t.curl.setRotation(lerp(-0.35, 0.9, grip) + legTuck * 0.6, 0, 0)
            }
        }
    }

    /// Turn the head toward a world point, owl fashion: quick turns, then stillness.
    private func aimHead(_ world: V3, _ dt: Float, tilt: Float = 0) {
        let w = root.localMatrix.inverse * V4(world, 1)
        let d = V3(w.x, w.y, w.z) - V3(0, 0.55, 0)
        let yawT = atan2(d.x, d.z)
        let pitchT = atan2(d.y, hypot(d.x, d.z))
        if abs(angleTo(headTarget.yaw, yawT)) > 0.12 || abs(pitchT - headTarget.pitch) > 0.1 {
            headTarget.yaw = yawT
            headTarget.pitch = pitchT
        }
        headTarget.roll = tilt
        // An owl can turn its head 270 degrees; beyond about 120 either way it turns its body too.
        let lim: Float = 2.1
        if abs(headTarget.yaw) > lim && state == .perch && settle <= 0 {
            yaw += (headTarget.yaw < 0 ? -1 : 1) * min(abs(headTarget.yaw) - lim + 0.4, 1.6 * dt)
        }
        headYaw = approach(headYaw, clamp(headTarget.yaw, -2.35, 2.35), 0.09, dt)
        headPitch = approach(headPitch, clamp(headTarget.pitch, -1.1, 0.8), 0.09, dt)
        headRoll = approach(headRoll, headTarget.roll, 0.25, dt)
    }

    // MARK: Paths

    private func makePath(_ pts: [V3], _ speed: Float, _ kind: PathKind) -> Path {
        let curve = Curve3(pts, kind: .centripetal)
        return Path(curve: curve, len: curve.length, s: 0, speed: speed, kind: kind)
    }

    /// Leave the perch (or the snow) and follow `path`; a crouch and spring first from a perch.
    private func launch(_ p: Path, heavy: Bool = false) {
        path = p
        state = .takeoff
        timer = heavy ? 0.35 : 0.55
        takeoffDur = timer
        self.heavy = heavy
    }

    /// Fly to another perch, ending in a landing.
    func goTo(_ perch: Perch, scene: Boreal, heavy: Bool = false) {
        if let p = self.perch, p.owl === self { p.owl = nil }
        perch.owl = self
        self.perch = perch
        let from = root.position
        let to = scene.perchPoint(perch)
        var flat = to - from
        flat.y = 0
        let dist = max(flat.length, 0.5)
        let dir = flat / dist
        // The landing starts a little short of the perch and below it, so the owl swoops up onto it.
        let approachPt = to + dir * -1.3 + V3(0, -0.55, 0)
        var mid = lerp(from, approachPt, 0.5)
        mid.y = min(from.y, approachPt.y) - min(1.8, dist * 0.12)
        mid.y = max(mid.y, scene.heightAt(mid.x, mid.z) + 0.9)
        let drop = from + dir * min(0.9, dist * 0.2) + V3(0, heavy ? 0.3 : -0.5, 0)
        let pts = dist > 3 ? [from, drop, mid, approachPt] : [from, drop, approachPt]
        landFrom = approachPt
        landTo = to
        launch(makePath(pts, 4.2, .perch), heavy: heavy)
    }

    // MARK: Behaviour

    func hunt(_ p: V3) {
        target = p
        state = .listen
        timer = rnd(1.4, 2.6)
        lid = 0
    }

    func update(dt: Float, scene: Boreal, look: OwlLook) {
        cooldown = max(0, cooldown - dt)
        alarm = max(0, alarm - dt * 0.4)
        switch state {
        case .perch: updatePerch(dt, scene, look)
        case .listen: updateListen(dt, scene)
        case .takeoff: updateTakeoff(dt)
        case .fly: updateFly(dt)
        case .land: updateLand(dt, scene)
        case .hover: updateHover(dt, scene)
        case .plunge: updatePlunge(dt, scene)
        case .insnow: updateInSnow(dt, scene)
        }
        applyPose(dt: dt)
    }

    /// The common perched pose: upright, wings folded, feet gripping.
    private func perchedPose(_ dt: Float) {
        bankAngle = approach(bankAngle, 0, 0.3, dt)
        legAngle = 0
        legTuck = approach(legTuck, 0, 0.15, dt)
        legReach = approach(legReach, 0.4, 0.25, dt)
        grip = approach(grip, 1, 0.1, dt)
        tailSpread = approach(tailSpread, 0, 0.4, dt)
        tailLift = approach(tailLift, 0, 0.4, dt)
        sweep = approach(sweep, 0, 0.3, dt)
    }

    private func updatePerch(_ dt: Float, _ scene: Boreal, _ look: OwlLook) {
        guard let perch else { return }
        let p = scene.perchPoint(perch)
        root.position = p
        perchedPose(dt)
        // Just landed: the wings stay half raised a moment, then fold away in stages; the body
        // rocks forward and back as it finds its balance.
        if settle > 0 {
            settle = max(0, settle - dt)
            let k = 1 - settle / 1.8
            let wob = sin(k * 9) * exp(-k * 3.5) * 0.18
            pitch = 0.06 + wob
            fold = approach(fold, k < 0.12 ? 0.25 : 1, k < 0.12 ? 0.15 : 0.22, dt)
            raise = approach(raise, 0, 0.15, dt)
            flapAmp = approach(flapAmp, 0, 0.15, dt)
            flapPhase += dt * TAU * 1.2
            tailLift = approach(tailLift, max(0, wob * 2), 0.1, dt)
        } else {
            pitch = approach(pitch, 0.06 + traits.lean + alarm * 0.04, 0.4, dt)
            fold = approach(fold, 1, 0.25, dt)
            raise = approach(raise, 0, 0.3, dt)
            flapAmp = approach(flapAmp, 0, 0.2, dt)
        }
        bob = approach(bob, 0, 0.2, dt)
        sleek = approach(sleek, alarm > 0.3 ? 1 : traits.fluff, 0.6, dt)
        lid = approach(lid, look.attention > 0.5 || alarm > 0.2 ? 0 : 0.5, 1.2, dt)
        let t = scene.renderTime
        if let point = look.point {
            aimHead(point, dt, tilt: (look.stare ? 0.25 * sin(t * 0.4) : 0) + traits.tilt)
            idle = nil
        } else {
            if idle == nil || idle!.t <= 0 {
                let r = Float.random(in: 0..<1)
                let a = yaw + rnd(-1.6, 1.6)
                if r < 0.12 {
                    idle = Idle(kind: .preen, t: rnd(2.5, 4.5), side: chance(0.5) ? -1 : 1)
                } else if r < 0.18 {
                    idle = Idle(kind: .ruffle, t: 1.2)
                } else if r < 0.24 {
                    idle = Idle(kind: .stretch, t: 2.2, side: chance(0.5) ? -1 : 1)
                } else {
                    idle = Idle(kind: .scan, t: rnd(1.5, 5), point: p + V3(sin(a) * 10, rnd(-4, -1), cos(a) * 10))
                }
            }
            idle!.t -= dt
            let I = idle!
            switch I.kind {
            case .scan:
                aimHead(I.point, dt, tilt: traits.tilt)
            case .preen:
                headYaw = approach(headYaw, I.side * 1.5, 0.25, dt)
                headPitch = approach(headPitch, -0.85 + 0.08 * sin(t * 7), 0.15, dt)
                headRoll = approach(headRoll, I.side * 0.3, 0.3, dt)
                fold = 0.92
            case .stretch:
                // A slow stretch: one wing eased half open and down, then folded again.
                let k = 1 - I.t / 2.2
                let open = sin(clamp(k, 0, 1) * .pi)
                fold = 1 - open * 0.6
                raise = -open * 0.3
            case .ruffle:
                let k = 1 - I.t / 1.2
                sleek = -1.2 * sin(k * .pi)
                bankAngle = sin(k * 40) * 0.04 * sin(k * .pi)
            }
        }
        timer -= dt
        if timer <= 0 && settle <= 0 {
            timer = rnd(60, 150)
            if chance(0.75) { scene.selfHunt(self) } else { scene.relocate(self) }
        }
    }

    private func updateListen(_ dt: Float, _ scene: Boreal) {
        let p = perch.map { scene.perchPoint($0) } ?? root.position
        root.position = p
        perchedPose(dt)
        fold = approach(fold, 1, 0.2, dt)
        raise = approach(raise, 0, 0.2, dt)
        timer -= dt
        let t = scene.renderTime
        // Head bobbing and tilting to fix the sound: owls triangulate by moving their head.
        bob = sin(t * 5.2) * 0.6 * smoothstep(0, 0.4, timer)
        aimHead(target, dt, tilt: sin(t * 2.1) * 0.35)
        pitch = approach(pitch, 0.35, 0.5, dt)
        lid = approach(lid, 0, 0.2, dt)
        sleek = approach(sleek, 0.5, 0.5, dt)
        let want = atan2(target.x - p.x, target.z - p.z)
        yaw += clamp(angleTo(yaw, want), -1.2 * dt, 1.2 * dt)
        if timer <= 0 {
            perch?.owl = nil
            let from = p
            var hover = target
            hover.y = scene.heightAt(hover.x, hover.z) + 1.7
            var dir = hover - from
            dir.y = 0
            let dist = dir.length
            dir = dir.normalized
            var low = from + dir * (dist * 0.45)
            low.y = max(scene.heightAt(low.x, low.z) + 1.0, min(from.y, hover.y) - 1.2)
            let drop = from + dir * 0.7 + V3(0, -0.5, 0)
            let before = hover + dir * -1.2 + V3(0, -0.3, 0)
            launch(makePath([from, drop, low, before, hover], 4.4, .hunt))
        }
    }

    private func updateTakeoff(_ dt: Float) {
        // Crouch, lean out, open the wings and push off with the first deep downstroke.
        guard let P = path else { state = .perch; return }
        timer -= dt
        let k = 1 - timer / takeoffDur
        let tan = P.curve.tangentAt(0.02)
        let want = atan2(tan.x, tan.z)
        yaw += clamp(angleTo(yaw, want), -4 * dt, 4 * dt)
        pitch = approach(pitch, heavy ? 0.7 : lerp(0.35, 0.8, k), 0.12, dt)
        fold = approach(fold, 0, 0.1, dt)
        raise = approach(raise, heavy ? 0.2 : 0.45 * (1 - k), 0.1, dt)
        sweep = approach(sweep, 0, 0.2, dt)
        legReach = approach(legReach, k < 0.5 ? 0.3 : 1, 0.06, dt)
        grip = approach(grip, k > 0.7 ? 0.4 : 1, 0.1, dt)
        flapAmp = approach(flapAmp, k > 0.4 ? 1 : 0, 0.12, dt)
        flapRate = 2.3
        if k > 0.4 { flapPhase += dt * TAU * flapRate / traits.size }
        lid = 0
        if timer <= 0 {
            state = .fly
            flapAmp = max(flapAmp, 0.8)
        }
    }

    private func updateFly(_ dt: Float) {
        guard var P = path else { state = .perch; return }
        let u = P.s / P.len
        let speed = P.speed * (0.45 + 0.55 * smoothstep(0, 0.15, u)) * (1 - 0.35 * smoothstep(0.85, 1, u))
        P.s = min(P.len, P.s + speed * dt)
        path = P
        let k = P.s / P.len
        let pos = P.curve.pointAt(k)
        let tan = P.curve.tangentAt(min(k, 0.999))
        root.position = pos
        let heading = atan2(tan.x, tan.z)
        let turn = angleTo(yaw, heading)
        yaw += clamp(turn, -3 * dt, 3 * dt)
        bankAngle = approach(bankAngle, clamp(-turn * 2.2, -0.6, 0.6), 0.3, dt)
        let climb = asin(clamp(tan.y, -1, 1))
        pitch = approach(pitch, 1.3 - climb * 0.5, 0.18, dt)
        fold = approach(fold, 0, 0.12, dt)
        raise = approach(raise, 0, 0.3, dt)
        sweep = approach(sweep, 0.05, 0.3, dt)
        // Slow, deep beats on take-off and climbing, long glides in between.
        let beat = k < 0.25 || tan.y > 0.12 || (k > 0.8 && P.kind == .hunt) || carry
        flapAmp = approach(flapAmp, beat ? 0.85 : 0.06, 0.4, dt)
        flapRate = 2.2
        flapPhase += dt * TAU * flapRate / traits.size
        tailSpread = approach(tailSpread, 0.1, 0.3, dt)
        tailLift = approach(tailLift, 0, 0.3, dt)
        // Legs tucked back under the tail, or dangling with the vole.
        legTuck = approach(legTuck, carry ? 0.3 : 1, 0.25, dt)
        legAngle = -0.3
        legReach = approach(legReach, carry ? 0.9 : 0.6, 0.3, dt)
        grip = approach(grip, 1, 0.2, dt)
        sleek = approach(sleek, 0.3, 0.5, dt)
        lid = 0
        aimHead(P.kind == .hunt ? target : pos + tan * 6, dt)
        if P.s >= P.len - 1e-3 {
            if P.kind == .hunt {
                state = .hover
                timer = rnd(0.9, 1.7)
            } else {
                state = .land
                timer = 0
                landPitch = pitch
            }
        }
    }

    private func updateLand(_ dt: Float, _ scene: Boreal) {
        // The swoop up onto the perch: the body rears upright, the wings spread wide and forward and
        // beat slowly to brake, the tail fans and drops, the legs reach out with the toes open, and
        // they close on the perch as it touches.
        let D: Float = 1.15
        timer += dt
        let k = clamp(timer / D, 0, 1)
        let to = perch.map { scene.perchPoint($0) } ?? landTo
        let e = 1 - pow(1 - k, 2.4)     // decelerating
        var p = lerp(landFrom, to, e)
        p.y += sin(k * .pi) * 0.25 * (1 - k)
        root.position = p
        let want = atan2(to.x - landFrom.x, to.z - landFrom.z)
        yaw += clamp(angleTo(yaw, want), -2 * dt, 2 * dt)
        bankAngle = approach(bankAngle, 0, 0.15, dt)
        pitch = approach(pitch, k < 0.75 ? -0.2 : 0.05, k < 0.75 ? 0.18 : 0.12, dt)
        fold = approach(fold, 0, 0.08, dt)
        sweep = approach(sweep, -0.45, 0.15, dt)
        raise = approach(raise, 0.25, 0.2, dt)
        flapAmp = approach(flapAmp, k < 0.85 ? 0.75 : 0.2, 0.15, dt)
        flapRate = 1.9
        flapPhase += dt * TAU * flapRate / traits.size
        tailSpread = approach(tailSpread, 1, 0.12, dt)
        tailLift = approach(tailLift, 0.7, 0.15, dt)
        legTuck = approach(legTuck, 0, 0.08, dt)
        legAngle = k < 0.85 ? 0.75 : 0.1
        legReach = approach(legReach, 1, 0.1, dt)
        grip = approach(grip, k < 0.88 ? 0 : 1, k < 0.88 ? 0.1 : 0.05, dt)
        aimHead(to + V3(sin(yaw) * 3, -0.5, cos(yaw) * 3), dt)
        if k >= 1 {
            state = .perch
            settle = 1.8
            timer = rnd(40, 110)
            carry = false
            root.position = to
        }
    }

    private func updateHover(_ dt: Float, _ scene: Boreal) {
        timer -= dt
        var want = target
        want.y = scene.heightAt(want.x, want.z) + 1.6
        root.position = lerp(root.position, want, 1 - exp(-dt * 3))
        pitch = approach(pitch, 0.5, 0.2, dt)
        bankAngle = approach(bankAngle, 0, 0.2, dt)
        fold = approach(fold, 0, 0.1, dt)
        sweep = approach(sweep, -0.15, 0.2, dt)
        flapAmp = approach(flapAmp, 0.8, 0.15, dt)
        flapRate = 3.0
        flapPhase += dt * TAU * flapRate / traits.size
        tailSpread = approach(tailSpread, 1, 0.2, dt)
        tailLift = approach(tailLift, 0.6, 0.2, dt)
        // The feet come down and open, ready.
        legTuck = approach(legTuck, 0, 0.2, dt)
        legAngle = 0.15
        legReach = approach(legReach, 0.9, 0.2, dt)
        grip = approach(grip, 0.3, 0.2, dt)
        aimHead(target, dt)
        if timer <= 0 {
            state = .plunge
            vy = 0
        }
    }

    private func updatePlunge(_ dt: Float, _ scene: Boreal) {
        // Wings flung up in a V, face down onto the sound; at the last moment the legs swing forward,
        // fully extended, the toes spread wide and the talons open.
        vy -= 9.8 * 0.7 * dt
        root.position.y += vy * dt
        root.position.x += (target.x - root.position.x) * min(1, dt * 4)
        root.position.z += (target.z - root.position.z) * min(1, dt * 4)
        let gy = scene.heightAt(root.position.x, root.position.z)
        let late = smoothstep(0.9, 0.35, root.position.y - gy)
        pitch = approach(pitch, lerp(0.95, 0.35, late), 0.1, dt)
        flapAmp = approach(flapAmp, 0, 0.08, dt)
        fold = approach(fold, 0.12, 0.1, dt)
        raise = approach(raise, 1, 0.1, dt)
        sweep = approach(sweep, 0.1, 0.1, dt)
        tailSpread = approach(tailSpread, 0.8, 0.15, dt)
        legTuck = approach(legTuck, 0, 0.06, dt)
        legAngle = lerp(0.1, 0.55, late)
        legReach = approach(legReach, 1, 0.06, dt)
        grip = approach(grip, 0, 0.06, dt)
        aimHead(target, dt)
        if root.position.y <= gy - 0.08 {
            root.position.y = gy - 0.12
            state = .insnow
            timer = rnd(1.8, 3.2)
            scene.strike(self, x: root.position.x, z: root.position.z, yaw: yaw)
            carry = chance(0.55)
        }
    }

    private func updateInSnow(_ dt: Float, _ scene: Boreal) {
        // Mantling: half buried, wings spread and drooped over the snow, head down.
        timer -= dt
        let gy = scene.heightAt(root.position.x, root.position.z)
        root.position.y = approach(root.position.y, gy - 0.3, 0.3, dt)
        pitch = approach(pitch, 0.6, 0.2, dt)
        fold = approach(fold, 0.05, 0.15, dt)
        flapAmp = approach(flapAmp, 0, 0.1, dt)
        raise = approach(raise, -0.55, 0.2, dt)
        sweep = approach(sweep, 0.2, 0.3, dt)
        grip = approach(grip, 1, 0.1, dt)
        headPitch = approach(headPitch, -0.9, 0.2, dt)
        headYaw = approach(headYaw, sin(scene.renderTime * 1.3) * 0.4, 0.4, dt)
        headTarget.pitch = -0.9
        if timer <= 0 {
            // Every perch taken: stay down a moment longer and look again.
            guard let next = scene.choosePerch(self) else {
                timer = 1
                return
            }
            state = .perch
            root.position.y = gy + 0.05
            goTo(next, scene: scene, heavy: true)
            path?.speed = 3.6
            scene.burstAt(root.position.x, gy, root.position.z, strength: 0.5)
        }
    }

    // MARK: Drawing

    private func params(_ m: simd_float4x4, rim: Float, trans: Float, rough: Float) -> OwlParams {
        let T = traits
        return OwlParams(model: m, tint: V4(T.tint, T.contrast), misc: V4(T.streak, ruffle, spread, eyeLid),
                         iris: V4(T.iris, 0), rim: V4(rim, trans, rough, 0))
    }

    func draw(_ ctx: DrawContext) {
        queue.removeAll(keepingCapacity: true)
        root.render(ctx)
        let e = ctx.encoder
        func bind(_ p: inout OwlParams) {
            e.setVertexBytes(&p, length: MemoryLayout<OwlParams>.stride, index: 2)
            e.setFragmentBytes(&p, length: MemoryLayout<OwlParams>.stride, index: 3)
        }
        // The body, its legs and toes, under the coat (the same plumage, shadowed down).
        ctx.use("owlStdVertex", "owlBodyFragment")
        for (part, m) in queue {
            guard case .body(let mesh) = part else { continue }
            var p = params(m, rim: 1.0, trans: 0.04, rough: 0.96)
            bind(&p)
            mesh.draw(e)
        }
        // The head and its face.
        ctx.use("owlHeadVertex", "owlHeadFragment")
        for (part, m) in queue {
            guard case .head = part else { continue }
            var p = params(m, rim: 1.2, trans: 0.1, rough: 0.96)
            bind(&p)
            kit.head.draw(e)
        }
        // The eyes.
        ctx.use("owlStdVertex", "owlEyeFragment")
        for (part, m) in queue {
            guard case .eye = part else { continue }
            var p = params(m, rim: 0, trans: 0, rough: 0.1)
            bind(&p)
            kit.eye.draw(e)
        }
        // Beak, talons, the vole.
        Std.begin(ctx)
        for (part, m) in queue {
            guard case .std(let mesh, var sp) = part else { continue }
            sp.model = m
            Std.draw(ctx, mesh, sp)
        }
        // The wings, skinned on their bones.
        ctx.use("owlWingVertex", "owlWingFragment", shadowFragment: "owlWingShadowFragment", alphaToCoverage: true)
        for (part, m) in queue {
            guard case .wing(let side) = part else { continue }
            var p = params(m, rim: 1.0, trans: 0.1, rough: 0.95)
            bind(&p)
            var bones = wings[side].skel.skin
            e.setVertexBytes(&bones, length: bones.count * MemoryLayout<simd_float4x4>.stride, index: 4)
            kit.wings[side].draw(e)
        }
        // The tail's twelve feathers.
        ctx.use("owlTailVertex", "owlTailFragment", shadowFragment: "owlTailShadowFragment", alphaToCoverage: true)
        for (part, m) in queue {
            guard case .tail = part else { continue }
            var p = params(m, rim: 1.6, trans: 0.3, rough: 0.95)
            bind(&p)
            kit.tail.draw(e)
        }
        // The coat of contour feathers over everything (never in the shadow passes).
        if !ctx.isShadow {
            ctx.use("owlCardVertex", "owlCardFragment", alphaToCoverage: true)
            for (part, m) in queue {
                guard case .cards(let mesh) = part else { continue }
                var p = params(m, rim: 0.9, trans: 0.05, rough: 0.95)
                bind(&p)
                mesh.draw(e)
            }
        }
    }

    var debugDescription: String {
        let p = root.position
        return String(format: "%@ at (%.1f, %.2f, %.1f) yaw %.2f pitch %.2f fold %.2f flap %.2f%@", state.rawValue, p.x, p.y, p.z,
                      yaw, pitch, fold, flapAmp, carry ? " carrying a vole" : "")
    }
}

/// Per-draw parameters of an owl part (`OwlParams` in the shaders).
struct OwlParams {
    var model: simd_float4x4
    var tint: V4
    var misc: V4
    var iris: V4
    var rim: V4
}

extension Shaders {
    static let owl = plumage + """

    // MARK: - The owl (owl.js)

    vertex OwlOut owlStdVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                               constant Frame& F [[buffer(1)]], constant OwlParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        return owlOut(F, P, a.xyz, b.xyz, a.xyz, float4(0.0), float4(0.0));
    }

    vertex OwlOut owlHeadVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], constant OwlParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 3], b = verts[vid * 3 + 1], c = verts[vid * 3 + 2];
        return owlOut(F, P, a.xyz, b.xyz, a.xyz, float4(c.xyz, 0.0), float4(0.0));
    }

    /// The wing: each vertex follows up to four bones (`bones`: their skin matrices).
    vertex OwlOut owlWingVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], constant OwlParams& P [[buffer(2)]],
                                constant float4x4* bones [[buffer(4)]]) {
        float4 a = verts[vid * 5], b = verts[vid * 5 + 1], fe = verts[vid * 5 + 2], si = verts[vid * 5 + 3], sw = verts[vid * 5 + 4];
        float4x4 S = bones[int(si.x + 0.5)] * sw.x + bones[int(si.y + 0.5)] * sw.y + bones[int(si.z + 0.5)] * sw.z + bones[int(si.w + 0.5)] * sw.w;
        float3 p = (S * float4(a.xyz, 1.0)).xyz;
        float3 n = (S * float4(b.xyz, 0.0)).xyz;
        return owlOut(F, P, p, n, p, float4(a.w, b.w, 0.0, 0.0), fe);
    }

    fragment float4 owlBodyFragment(OwlOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                    constant OwlParams& P [[buffer(3)]], depth2d<float> sunMap [[texture(1)]],
                                    depth2d<float> moonMap [[texture(2)]], sampler cmp [[sampler(2)]]) {
        float3 p = in.local;
        float ang = atan2(p.x, p.z);              // 0 straight ahead, +-PI behind
        float fe;
        float r = owlFeathers(float2(ang * 9.0, p.y * 46.0), fe);
        // Under the contour feathers: the same colours, a little darker (shadowed down).
        float3 c = owlBodyBase(p, P.misc.x) * 0.85;
        c *= 1.0 - fe * 0.14;
        c *= 0.94 + 0.12 * r;
        float3 n = owlNormal(in.normal, true, false);
        return float4(owlShade(F, P, owlLook(c, P.tint), n, in.world, sunMap, moonMap, cmp), 1.0);
    }

    fragment float4 owlHeadFragment(OwlOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                    constant OwlParams& P [[buffer(3)]], depth2d<float> sunMap [[texture(1)]],
                                    depth2d<float> moonMap [[texture(2)]], sampler cmp [[sampler(2)]]) {
        float3 d = normalize(in.a.xyz);
        float2 p = in.local.xy;
        // The crown and nape: grey, finely barred.
        float ang = atan2(d.x, d.z);
        float fe;
        float fr = owlFeathers(float2(ang * 7.0, d.y * 9.0), fe);
        float3 crown = owlCrownBase(d, in.local.y) * 0.85;
        crown *= 1.0 - fe * 0.12;
        crown *= 0.94 + 0.12 * fr;
        // The facial disc: rings centred on each eye.
        float2 e = float2(p.x < 0.0 ? -0.036 : 0.036, 0.014);
        float r = length(p - e);
        float ra = atan2(p.y - e.y, p.x - e.x);
        // The rings are made of feathers, so they waver and break; fine streaks radiate from the eye.
        float rings = 0.5 + 0.5 * cos(r / 0.0102 * 6.2831853 + vnoise(float2(ra * 6.0, r * 40.0)) * 2.2 + vnoise(float2(ra * 30.0, r * 90.0)) * 0.8);
        float3 face = float3(0.64, 0.63, 0.6);
        face = mix(face, float3(0.3, 0.29, 0.27), sstep(0.62, 0.95, rings) * sstep(0.012, 0.024, r) * 0.42);
        float rays = vnoise(float2(ra * 70.0, r * 18.0));
        face *= 0.82 + 0.26 * rays;
        // White brows from above the beak, curving up between the eyes.
        float bx = abs(p.x);
        float brow = sstep(0.006, 0.0015, abs(bx - (0.005 + (p.y + 0.012) * 0.55))) * step(-0.014, p.y) * step(p.y, 0.05);
        face = mix(face, float3(0.9, 0.89, 0.86), brow);
        // Dark skin round each eye.
        face = mix(face, float3(0.07, 0.06, 0.06), sstep(0.019, 0.015, r));
        // The black chin and the white bow tie either side of it.
        float chin = sstep(0.013, 0.007, length((p - float2(0.0, -0.056)) * float2(1.0, 1.4)));
        float tie = sstep(0.02, 0.013, length((float2(bx, p.y) - float2(0.027, -0.066)) * float2(0.75, 1.7)));
        face = mix(face, float3(0.93, 0.92, 0.89), tie);
        face = mix(face, float3(0.04, 0.035, 0.03), chin);
        // The disc's rim: a dark ring, then the crown feathers.
        float disc = sstep(0.38, 0.47, d.z);
        float rim = sstep(0.36, 0.43, d.z) * (1.0 - sstep(0.47, 0.55, d.z));
        float3 c = mix(crown, face, disc);
        // The white bow tie breaks the rim under the chin.
        float tieRim = sstep(0.05, 0.02, abs(p.x)) * step(p.y, -0.06);
        c = mix(c, float3(0.13, 0.11, 0.1), rim * 0.85 * (1.0 - tieRim));
        c = mix(c, float3(0.86, 0.85, 0.82), tieRim * sstep(0.36, 0.45, d.z) * (1.0 - sstep(0.5, 0.6, d.z)) * 0.8);
        float3 n = owlNormal(in.normal, true, false);
        return float4(owlShade(F, P, owlLook(c, P.tint), n, in.world, sunMap, moonMap, cmp), 1.0);
    }

    fragment float4 owlEyeFragment(OwlOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                   constant OwlParams& P [[buffer(3)]], depth2d<float> sunMap [[texture(1)]],
                                   depth2d<float> moonMap [[texture(2)]], sampler cmp [[sampler(2)]]) {
        float3 n0 = normalize(in.local);
        float3 c = P.iris.xyz;
        c *= 0.75 + 0.25 * sstep(0.75, 0.95, n0.z);
        c = mix(c, float3(0.004), sstep(0.955, 0.965, n0.z));
        // The upper lid, feathered grey, comes down over the eye.
        float lidLine = 1.0 - 2.0 * P.misc.w;
        c = mix(c, float3(0.4, 0.39, 0.37), step(lidLine, n0.y));
        float3 n = owlNormal(in.normal, true, false);
        float2 sh = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 lit = standardLight(F, c, n, in.world, 0.1, 0.0, sh, geometryRoughness(n));
        return float4(applyFog(F, lit, length(in.world - F.camera.xyz)), 1.0);
    }

    /// A flight feather's coverage: a long vane with a rounded tip; the outer primaries narrow
    /// toward the tip (emarginated), which is what makes the "fingers" of an owl's wingtip.
    float owlFlightAlpha(float4 fe) {
        float u = fe.x, t = fe.y, kind = fe.z;
        float k = (t - 0.82) / 0.18;
        float hw = t < 0.82 ? 1.0 : sqrt(max(0.0, 1.0 - k * k));
        hw *= mix(1.0, 0.6, step(1.5, kind) * step(4.5, fe.w) * sstep(0.5, 0.62, t));
        hw *= sstep(0.0, 0.06, t) * 0.4 + 0.6;
        float fw = fwidthf(u) * 1.5 + 0.02;
        return 1.0 - sstep(hw - fw, hw + fw, abs(u));
    }

    /// Flight feathers: barred dark on grey above, pale and barred below, the primaries' fingers cut out.
    fragment float4 owlWingFragment(OwlOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                    constant OwlParams& P [[buffer(3)]], depth2d<float> sunMap [[texture(1)]],
                                    depth2d<float> moonMap [[texture(2)]], sampler cmp [[sampler(2)]]) {
        float s = in.a.x, v = in.a.y;
        float4 fe = in.b;
        float kind = fe.z;
        float alpha = 1.0;
        if (kind > 0.5) {
            alpha = owlFlightAlpha(fe);
            if (alpha < 0.1) discard_fragment();
            if (F.screen.w < 0.5) { if (alpha < 0.5) discard_fragment(); alpha = 1.0; }
        }
        float bars = sstep(0.3, 0.7, sin(v * 24.0 + s * 5.0 + vnoise(float2(s, v) * 30.0)) * 0.5 + 0.5) * sstep(0.4, 0.6, v);
        float3 up = mix(float3(0.44, 0.42, 0.39), float3(0.2, 0.18, 0.17), bars * 0.85);
        // Coverts toward the leading edge: mottled, each feather with a pale tip.
        float fedge;
        float fr = owlFeathers(float2(s * 30.0, v * 9.0), fedge);
        float3 cov = float3(0.47, 0.45, 0.42) * (1.0 - 0.3 * owlVermic(float2(s * 0.3, v * 0.25)));
        cov = mix(cov, float3(0.66, 0.64, 0.6), (1.0 - fedge) * step(0.75, fr) * 0.4);
        up = mix(cov, up, kind > 0.5 ? 1.0 : sstep(0.35, 0.5, v));
        // The buff patch at the base of the primaries.
        up = mix(up, float3(0.6, 0.55, 0.46), sstep(0.07, 0.0, abs(s - 0.36)) * sstep(0.3, 0.45, v) * sstep(0.75, 0.55, v) * 0.6);
        float3 under = mix(float3(0.68, 0.67, 0.64), float3(0.34, 0.33, 0.31), bars * 0.7);
        float3 c = front ? up : under;
        if (kind > 0.5) {
            // Its shaft, and a darker outer vane edge so neighbouring feathers read apart.
            c = mix(c, c * 0.6, sstep(0.08, 0.0, abs(fe.x)) * sstep(0.1, 0.3, fe.y));
            c *= 1.0 - sstep(0.7, 1.0, abs(fe.x)) * 0.2;
            c *= 0.94 + 0.12 * fract(fe.w * 0.618);
        }
        float3 n = owlNormal(in.normal, front, true);
        return float4(owlShade(F, P, owlLook(c, P.tint), n, in.world, sunMap, moonMap, cmp), alpha);
    }

    fragment void owlWingShadowFragment(OwlOut in [[stage_in]]) {
        if (in.b.z > 0.5 && owlFlightAlpha(in.b) < 0.5) discard_fragment();
    }

    """
}
