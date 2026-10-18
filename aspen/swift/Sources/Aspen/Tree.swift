import Foundation
import Metal
import simd

// Quaking aspen: procedural trees built branch by branch, their bark drawn in the shader from the
// painted maps (Bark.swift), a ridge of snow along every branch, swaying on springs, shedding snow
// when the wind (or the cursor) shakes them and cascading it when a trunk is struck.
//
// Built like the real thing (Populus tremuloides in a dense clonal stand): a straight, slender,
// slightly leaning trunk, self-pruned bare to well over half its height where the grove shades
// it, then an open crown of ascending branches that fork and end in fans of fine twigs. In winter
// there are no leaves; snow lies in a ridge along the top of each branch and twig.

/// Vertex kinds, in `f.x`.
private let BARK: Float = 0, TWIG: Float = 1, SNOW: Float = 2, BRANCH: Float = 3

/// Accumulates the vertices of one tree. f = (kind, flex, tH, y metres); c across; t thickness.
private final class Builder {
    final class Target {
        var pos: [V3] = [], uv: [V2] = [], f: [V4] = [], c: [Float] = [], t: [Float] = [], idx: [UInt32] = []
    }
    struct Vert { var p: V3; var uv: V2; var f: V4; var c: Float = 0; var t: Float = 0 }
    struct Frame { var p: V3; var n: V3; var bn: V3; var s: Float; var along: Float = 0 }

    /// The bark (trunk and branches), the twig fans (cut out in the shader), the snow ridges.
    let wood = Target(), twig = Target(), snow = Target()

    /// A grid of `rows` x `cols` vertices produced by `at(r, c)`.
    func grid(_ target: Target, _ rows: Int, _ cols: Int, _ at: (Int, Int) -> Vert) {
        let base = UInt32(target.pos.count)
        for r in 0..<rows {
            for c in 0..<cols {
                let v = at(r, c)
                target.pos.append(v.p)
                target.uv.append(v.uv)
                target.f.append(v.f)
                target.c.append(v.c)
                target.t.append(v.t)
            }
        }
        for r in 0..<UInt32(rows - 1) {
            for c in 0..<UInt32(cols - 1) {
                let a = base + r * UInt32(cols) + c, b = a + 1, d = a + UInt32(cols), e = d + 1
                target.idx += [a, d, b, b, d, e]
            }
        }
    }

    /// A tapered tube along `path(s)` (s in 0..1) with radius `radius(s)`, `sides` round, `rows`
    /// along. uv in metres (around, along). `fAt(s, p)` gives the f for a row.
    @discardableResult
    func tube(_ target: Target, _ path: (Float) -> V3, _ radius: (Float) -> Float, _ sides: Int, _ rows: Int,
              _ fAt: (Float, V3) -> V4, uvOffset: Float = 0) -> [Frame] {
        // Frames along the path from finite differences.
        var frames: [Frame] = []
        var prevN: V3?
        for r in 0...rows {
            let s = Float(r) / Float(rows)
            let p = path(s)
            let d = (path(min(1, s + 0.01)) - path(max(0, s - 0.01))).normalized
            var n: V3
            if let pn = prevN {
                n = (pn - d * pn.dot(d)).normalized
            } else {
                n = (abs(d.y) < 0.9 ? V3(0, 1, 0).cross(d) : V3(1, 0, 0).cross(d)).normalized
            }
            if n.lengthSquared < 1e-6 { n = V3(1, 0, 0).cross(d).normalized }
            frames.append(Frame(p: p, n: n, bn: d.cross(n), s: s))
            prevN = n
        }
        var along: Float = 0
        for r in 1..<frames.count {
            along += frames[r].p.distance(to: frames[r - 1].p)
            frames[r].along = along
        }
        grid(target, rows + 1, sides + 1) { r, c in
            let fr = frames[r], a = Float(c) / Float(sides) * TAU, rad = radius(fr.s)
            let p = fr.p + fr.n * (cos(a) * rad) + fr.bn * (sin(a) * rad)
            return Vert(p: p, uv: V2(a * rad + uvOffset, fr.along + uvOffset * 3), f: fAt(fr.s, p))
        }
        return frames
    }

    /// A ridge of snow along the top of a tube: three vertices across, the middle lifted by the
    /// thickness (`t`), the sides sitting at the surface either side of the top.
    func ridge(_ target: Target, _ frames: [Frame], _ radius: (Float) -> Float, _ thick: (Float) -> Float, _ fAt: (Float, V3) -> V4) {
        let up = V3(0, 1, 0)
        grid(target, frames.count, 3) { r, ci in
            let fr = frames[r], c = Float(ci - 1), rad = radius(fr.s)
            let d = fr.bn.cross(fr.n).normalized                 // along
            var side = d.cross(up).normalized
            if side.lengthSquared < 1e-6 { side = fr.n }
            var top = side.cross(d).normalized
            if top.y < 0 { top = -top }
            let p = fr.p + top * (rad * (1 - 0.25 * c * c)) + side * (c * rad * 0.95)
            let th = thick(fr.s) * (1 - 0.7 * c * c)
            return Vert(p: p, uv: V2(fr.s * 10, c * rad), f: fAt(fr.s, p), c: c, t: th)
        }
    }

    /// Upload a target: four float4s per vertex, (position, u), (normal, v), f, (c, t).
    func mesh(_ target: Target, offsetThickness: Bool = false) -> GPUMesh? {
        guard !target.idx.isEmpty else { return nil }
        var m = MeshData()
        m.indices = target.idx
        if offsetThickness {
            // Normals for the snow ridges are computed at full thickness, then the thickness is taken
            // out again: the shader puts back as much as the tree's current load allows.
            m.positions = zip(target.pos, target.t).map { V3($0.x, $0.y + $1, $0.z) }
            m.computeVertexNormals()
            m.positions = target.pos
        } else {
            m.positions = target.pos
            m.computeVertexNormals()
        }
        var verts: [V4] = []
        verts.reserveCapacity(target.pos.count * 4)
        for i in target.pos.indices {
            verts.append(V4(m.positions[i], target.uv[i].x))
            verts.append(V4(m.normals[i], target.uv[i].y))
            verts.append(target.f[i])
            verts.append(V4(target.c[i], target.t[i], 0, 0))
        }
        return GPUMesh(vertices: GPU.shared.buffer(verts), indices: GPU.shared.buffer(target.idx), count: target.idx.count)
    }
}

/// One built tree (or fallen branch): its wood and snow meshes and its proportions.
final class TreeVariant {
    let wood: GPUMesh?
    let twig: GPUMesh?
    let snow: GPUMesh?
    var castShadow = true
    var height: Float, crownBase: Float, maxR: Float, baseR: Float
    /// Fallen wood: its length and radius.
    var length: Float = 0, radius: Float = 0

    fileprivate init(_ b: Builder, height: Float, crownBase: Float, maxR: Float, baseR: Float) {
        wood = b.mesh(b.wood)
        twig = b.mesh(b.twig)
        snow = b.mesh(b.snow, offsetThickness: true)
        self.height = height
        self.crownBase = crownBase
        self.maxR = maxR
        self.baseR = baseR
    }
}

/// Build one aspen. `rng` is a seeded random; `H` the height in metres; `detail` 1 for trees near
/// the viewer and lower for far ones (fewer sides, no sub-branches, bigger fans). `sapling` builds
/// a knee-high sucker instead: thin, with a few twigs from low down.
func buildAspen(_ rng: Seeded, _ H: Float, detail: Float, young: Bool = false, sapling: Bool = false) -> TreeVariant {
    let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
    let b = Builder()
    let up = V3(0, 1, 0)

    // The trunk: slender, with a slight lean and a gentle bend, bark mapped in metres.
    let baseR: Float = sapling ? 0.006 + H * 0.004 : young ? 0.012 + H * 0.0045 : 0.03 + H * 0.0085
    let lx = R(-1, 1), lz = R(-1, 1)
    let leanK: Float = H * (sapling ? 0.05 : R(0.008, 0.03))
    let lean = V3(lx, 0, lz) * leanK
    let bendPh = R(0, TAU), bendA = H * R(0.004, 0.014)
    func axis(_ y: Float) -> V3 {
        let t = y / H
        return V3(lean.x * t * t + sin(t * 2.1 + bendPh) * bendA * t, y, lean.z * t * t + cos(t * 1.7 + bendPh) * bendA * t)
    }
    func trunkR(_ t: Float) -> Float { baseR * pow(1 - t, 0.75) * (1 + 0.25 * exp(-t * H / 0.4)) + 0.006 }
    // No trunk is a true cylinder: the section wanders in and out round the trunk and up it, and
    // old branch stubs and wounds leave swellings; the mean diameter stays what it was.
    struct Bump { let y: Float, a: Float, s: Float, w: Float }
    var bumps: [Bump] = []
    if !sapling {
        let n = 3 + Int(R(0, 5))
        for _ in 0..<n {
            let y = R(0.3, H * 0.7), a = R(0, TAU), s = R(0.1, 0.3), w = R(0.15, 0.6)
            bumps.append(Bump(y: y, a: a, s: s, w: w))
        }
    }
    let seedK = Double(R(0, 100))
    func irregular(_ a: Float, _ y: Float) -> Float {
        let ca = Double(cos(a)), sa = Double(sin(a)), yd = Double(y)
        var k = Float(1 + 0.13 * (noise2(ca * 1.3 + 10 + seedK, sa * 1.3 + yd * 0.45) - 0.5) * 2
                      + 0.06 * (noise2(ca * 3 + 20, sa * 3 + yd * 1.6 + seedK) - 0.5) * 2)
        for bp in bumps {
            var da = a - bp.a
            da = atan2(sin(da), cos(da))
            k += bp.s * exp(-((y - bp.y) * (y - bp.y)) / (bp.w * bp.w) - da * da / 0.45)
        }
        return k
    }
    let sides = detail > 0.8 ? 16 : detail > 0.5 ? 9 : 5
    let rows = max(6, Int((H * (detail > 0.8 ? 3.2 : detail > 0.5 ? 1.6 : 0.8)).rounded()))
    b.grid(b.wood, rows + 1, sides + 1) { r, c in
        let t = pow(Float(r) / Float(rows), 1.3), a = Float(c) / Float(sides) * TAU     // denser rows near the base
        let o = axis(t * H)
        let rad = trunkR(t) * (detail > 0.5 ? irregular(a, t * H) : 1)
        // The bottom ring sinks into the snow so the trunk never floats.
        let y: Float = r == 0 ? -0.35 : o.y
        return Builder.Vert(p: V3(o.x + cos(a) * rad, y, o.z + sin(a) * rad), uv: V2(a * baseR, t * H), f: V4(BARK, baseR, t, t * H))
    }

    /// A fan of twigs: a vertical card from `tip` along `dir`, its twig pattern drawn in the shader.
    func fan(_ tip: V3, _ dir: V3, _ L: Float, _ flex: Float, _ tBase: Float) {
        let seed = rng()
        let d = V3(dir.x, dir.y * 0.6, dir.z).normalized
        var side = d.cross(up).normalized
        if side.lengthSquared < 1e-6 { side = V3(1, 0, 0) }
        var n = side.cross(d).normalized           // in the card's plane, roughly up
        if n.y < 0 { n = -n }
        let W = L * 0.9
        let cards = detail > 0.5 ? [n] : [n, side]
        for across in cards {
            b.grid(b.twig, 2, 3) { r, ci in
                let c = Float(ci - 1), rf = Float(r)
                let off = c * W * 0.5 * (r == 1 ? 1 : 0.12)
                let p = tip + d * (rf * L) + across * off
                return Builder.Vert(p: p, uv: V2(rf * L, off), f: V4(TWIG, flex + rf * 0.5, tBase + (p.y - tip.y) / H, seed), c: c, t: L)
            }
        }
    }

    /// A branch from `o` in horizontal direction `dir`, rising, length L, base radius r0.
    func branch(_ o: V3, _ dir: V3, _ L: Float, _ r0: Float, _ theta0: Float, _ tBase: Float, _ flexBase: Float, _ deep: Int) {
        // Ascending and curving upward: the angle from vertical shrinks along the branch.
        let path = { (s: Float) -> V3 in
            let th = theta0 * (1 - 0.45 * s)
            let horiz = sin(th), vert = cos(th)
            return o + dir * (horiz * s * L) + up * (vert * s * L - 0.06 * L * s * s * (1 - s))
        }
        let radius = { (s: Float) -> Float in r0 * (1 - s * 0.8) + 0.004 }
        let bs = detail > 0.8 ? 6 : 4, br = detail > 0.8 ? 7 : 4
        let frames = b.tube(b.wood, path, radius, bs, br, { s, p in V4(BRANCH, flexBase + s * 0.8, tBase + (p.y - o.y) / H, p.y) }, uvOffset: o.y)
        if !sapling {
            b.ridge(b.snow, frames, radius, { s in clamp(r0 * 0.9, 0.012, 0.05) * (0.6 + 0.4 * sin(s * .pi)) },
                    { s, p in V4(SNOW, flexBase + s * 0.8, tBase + (p.y - o.y) / H, p.y) })
        }
        let tip = path(1), tipDir = (path(1) - path(0.92)).normalized
        if deep > 0 && detail > 0.5 && L > 0.5 {
            // Forks: two or three sub-branches, off to either side and rising.
            let n = 2 + (rng() < 0.5 ? 1 : 0)
            for k in 0..<n {
                let s0 = R(0.3, 0.8)
                let ang = (k % 2 == 1 ? 1 : -1) * R(0.45, 0.9)
                let d2 = V3(dir.x * cos(ang) - dir.z * sin(ang), 0, dir.x * sin(ang) + dir.z * cos(ang))
                let o2 = path(s0)
                let L2 = L * R(0.4, 0.6) * (1 - s0 * 0.3)
                let th2 = theta0 * R(0.8, 1.1)
                branch(o2, d2, L2, radius(s0) * 0.7, th2, tBase + (o2.y - o.y) / H, flexBase + s0 * 0.8, deep - 1)
            }
        }
        let fanL = L * (sapling ? R(0.35, 0.5) : detail > 0.5 ? R(0.3, 0.45) : R(0.5, 0.7))
        fan(tip, tipDir, fanL, flexBase + 0.8, tBase + (tip.y - o.y) / H)
    }

    // The crown.
    let crownBase = H * (sapling ? R(0.2, 0.35) : young ? R(0.3, 0.45) : R(0.46, 0.62))
    var az = R(0, TAU)
    let spacing = sapling ? H * 0.12 : R(0.45, 0.75) / detail.squareRoot()
    var y = crownBase
    while y < H - (sapling ? 0.08 : 0.6) {
        let t = y / H, tc = (y - crownBase) / (H - crownBase)
        let n = rng() < 0.35 ? 2 : 1
        for _ in 0..<n {
            az += TAU * R(0.3, 0.45)
            let dir = V3(cos(az), 0, sin(az))
            let L: Float
            if sapling {
                L = H * R(0.25, 0.45)
            } else {
                let a = R(0.11, 0.17), bb = R(0.05, 0.09)
                L = H * lerp(a, bb, tc) / pow(detail, 0.3) * (young ? 0.8 : 1)
            }
            let r0 = max(0.006, trunkR(t) * R(0.22, 0.35))
            let theta0: Float
            if sapling {
                theta0 = R(0.5, 0.9)
            } else {
                let a = R(0.75, 1.05), bb = R(0.4, 0.65)
                theta0 = lerp(a, bb, tc)      // from vertical
            }
            let o = axis(y) + dir * (trunkR(t) * 0.7)
            branch(o, dir, L, r0, theta0, t, 0, sapling ? 0 : detail > 0.8 ? 3 : 2)
        }
        y += spacing * R(0.7, 1.3)
    }
    // The leader: the trunk's last stretch as a branch going straight up, ending in a fan.
    do {
        let top = axis(H - (sapling ? 0.05 : 0.5))
        let dir = V3(cos(az + 1), 0, sin(az + 1))
        fan(top, V3(dir.x * 0.3, 1, dir.z * 0.3).normalized, sapling ? H * 0.18 : R(0.5, 0.8), 0.8, 1)
    }
    let maxR = sapling ? H * 0.4 : H * 0.14
    return TreeVariant(b, height: H, crownBase: crownBase, maxR: maxR, baseR: baseR)
}

/// A fallen branch or log lying along +x: dead grey wood, half sunk in the snow, snow on top.
func buildStick(_ rng: Seeded, _ L: Float, _ r: Float) -> TreeVariant {
    let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
    let b = Builder()
    let bend = R(-0.08, 0.08) * L, ph = R(0, TAU)
    let path = { (s: Float) -> V3 in V3(s * L, sin(s * .pi) * bend * 0.3 + sin(s * 3 + ph) * r * 0.3, sin(s * .pi) * bend) }
    let radius = { (s: Float) -> Float in r * (1 - 0.45 * s) * (1 + 0.06 * sin(s * 23 + ph)) }
    let fAt = { (_: Float, p: V3) -> V4 in V4(BARK, -1, 0, p.y) }
    let sides = r > 0.08 ? 12 : 6
    let frames = b.tube(b.wood, path, radius, sides, max(4, Int((L * 2).rounded())), fAt)
    // A few stubs of broken branches.
    for _ in 0..<Int((L * 1.5).rounded()) {
        let s = R(0.1, 0.9), a = R(-1.2, 1.2) + (rng() < 0.5 ? 0 : .pi)
        let o = path(s), d = V3(R(-0.3, 0.3), cos(a), sin(a)).normalized
        let sl = R(0.1, 0.4) * (0.5 + r * 3)
        let rs = radius(s)
        b.tube(b.wood, { q in o + d * (q * sl) }, { q in rs * 0.25 * (1 - q * 0.7) + 0.003 }, 4, 2, fAt)
    }
    b.ridge(b.snow, frames, radius, { s in clamp(r * 0.6, 0.03, 0.14) * (0.7 + 0.3 * sin(s * .pi)) }, { _, p in V4(SNOW, 0, 0, p.y) })
    let v = TreeVariant(b, height: 0.5, crownBase: 0, maxR: L / 2, baseR: r)
    v.length = L
    v.radius = r
    return v
}

// MARK: - The grove

/// One tree (or fallen branch) standing in the grove, with its spring and its snow.
final class TreeInstance {
    var x: Float, y: Float = 0, z: Float, rot: Float, scale: Float, variant: Int
    /// The snow on it, 0..1, and how much it can hold.
    var load: Float
    var maxLoad: Float = 1
    /// How far fallen wood sinks into the snow (negative).
    var lift: Float = 0
    var height: Float = 0, crownBase: Float = 0, maxR: Float = 0, baseR: Float = 0
    /// The top's sway (m) and its velocity (m/s), world x and z.
    var sx: Float = 0, sz: Float = 0, vx: Float = 0, vz: Float = 0
    var omega: Float = 1, shedSpeed: Float = 1
    var shiver: Float = 0
    /// The cascade front: snow remains only below it (1 when the tree is undisturbed).
    var front: Float = 1
    var cascade: (front: Float, speed: Float)?
    var shedAcc: Float = 0
    var phase = Float.random(in: 0..<100)
    var seed = Float.random(in: 0..<1)
    fileprivate var slot = 0

    init(x: Float, z: Float, rot: Float, scale: Float, variant: Int, load: Float) {
        self.x = x; self.z = z; self.rot = rot; self.scale = scale; self.variant = variant; self.load = load
    }
}

/// Instances of a handful of tree variants, each on its own spring, with a snow load that the wind
/// and the cursor can shake off, or a struck trunk can send down in a cascade.
final class Grove {
    /// Per instance: its matrix, the top's sway in its own frame (x, z), the load and the shiver,
    /// and (inst) the bark seed and the cascade front.
    private struct Inst { var model: simd_float4x4; var sway: V4; var inst: V4 }

    let variants: [TreeVariant]
    let trees: [TreeInstance]
    private let bark: BarkTextures
    private let byVariant: [[TreeInstance]]
    private let models: [[simd_float4x4]]
    /// One instance buffer per variant per frame in flight.
    private var buffers: [[MTLBuffer]]
    private var filledSlot = -1

    init(variants: [TreeVariant], trees: [TreeInstance], bark: BarkTextures) {
        self.variants = variants
        self.trees = trees
        self.bark = bark
        var groups = variants.map { _ in [TreeInstance]() }
        for t in trees { groups[t.variant].append(t) }
        byVariant = groups
        models = groups.map { list in
            list.map { compose(V3($0.x, $0.y, $0.z), quatAxis($0.rot, 0, 1, 0), V3(repeating: $0.scale)) }
        }
        buffers = groups.map { list in
            (0..<FrameRing.count).map { _ in GPU.shared.buffer(length: max(1, list.count) * MemoryLayout<Inst>.stride) }
        }
        for (vi, list) in groups.enumerated() {
            let v = variants[vi]
            for (k, t) in list.enumerated() {
                t.slot = k
                t.height = v.height * t.scale
                t.crownBase = v.crownBase * t.scale
                t.maxR = v.maxR * t.scale
                t.baseR = v.baseR * t.scale
                // A spring for the top: slender hardwoods sway at 0.2-0.5 Hz, slower when taller.
                t.omega = TAU * clamp(1.6 / t.height.squareRoot(), 0.2, 1.5)
                // The top of a tall tree moves faster for the same bend: snow comes off at a higher speed.
                t.shedSpeed = 0.9 * (max(t.height, 1) / 8).squareRoot()
                t.maxLoad = t.load
            }
        }
    }

    /// Push a tree's top with a velocity impulse (m/s, world x/z).
    func shake(_ t: TreeInstance, _ ix: Float, _ iz: Float) {
        t.vx += ix
        t.vz += iz
    }

    /// Strike a trunk: it shivers and its snow comes down from the top, branch by branch.
    func strike(_ t: TreeInstance) {
        t.shiver = min(1.5, t.shiver + 1)
        if t.cascade == nil && t.load > 0.05 { t.cascade = (1, 0.1 + 0.08 / max(0.5, t.height / 15)) }
    }

    /// The world position of a point `f` of the way up the tree, swayed.
    func pointUp(_ t: TreeInstance, _ f: Float) -> V3 {
        let b = f * f * (1.4 - 0.4 * f)
        return V3(t.x + t.sx * b, t.y + t.height * f, t.z + t.sz * b)
    }

    /// Step the springs. `wind(x, z)` gives the ambient wind at a tree (m/s). Calls `shed(t, amount,
    /// f)` whenever a tree drops snow, with `f` the fraction of its height it falls from.
    func update(dt: Float, time now: Float, wind: (Float, Float) -> V2, snowing: Bool, shed: (TreeInstance, Float, Float) -> Void) {
        for t in trees {
            let w = wind(t.x, t.z)
            // Wind leans the top over a little (drag grows with the square of the speed) and its
            // turbulence keeps it moving.
            let gustiness = 0.5 + 0.5 * sin(now * 0.37 + t.phase) * sin(now * 0.23 + t.phase * 1.7)
            let lean = 0.02 * t.height / 15
            let ex = w.x * abs(w.x) * lean * (0.6 + 0.6 * gustiness)
            let ez = w.y * abs(w.y) * lean * (0.6 + 0.6 * gustiness)
            let zeta: Float = 0.06
            let ax = -t.omega * t.omega * (t.sx - ex) - 2 * zeta * t.omega * t.vx
            let az = -t.omega * t.omega * (t.sz - ez) - 2 * zeta * t.omega * t.vz
            t.vx += ax * dt
            t.vz += az * dt
            t.sx += t.vx * dt
            t.sz += t.vz * dt
            t.shiver *= exp(-dt / 0.6)
            let speed = hypot(t.vx, t.vz)
            if var c = t.cascade {
                // The front runs down the crown; snow above it is gone, shed as it passes.
                let prev = c.front
                c.front -= c.speed * dt
                let crownF = t.crownBase / t.height
                if c.front <= crownF {
                    t.cascade = nil
                    t.front = 1
                    t.load = 0
                    shed(t, 0.06, crownF + 0.05)
                } else {
                    t.cascade = c
                    t.front = c.front
                    if floor(prev * 14) != floor(c.front * 14) { shed(t, 0.16 * t.load, c.front) }
                }
            } else if speed > t.shedSpeed && t.load > 0.05 {
                // A hard swing shakes snow loose; the load builds again slowly while it snows.
                let lost = min(t.load, (speed - t.shedSpeed) * dt * 0.18)
                t.load -= lost
                // Snow comes off in a few clumps at a time, not a steady stream.
                t.shedAcc += lost
                if t.shedAcc > 0.04 {
                    let cb = t.crownBase / t.height
                    shed(t, t.shedAcc, cb + Float.random(in: 0..<1) * (1 - cb))
                    t.shedAcc = 0
                }
            } else if snowing && t.load < t.maxLoad {
                t.load = min(t.maxLoad, t.load + dt / 900)
            }
        }
        filledSlot = -1
    }

    /// Write this frame's instance data for every variant (once per frame, shared by every pass).
    private func fill(_ slot: Int) {
        guard filledSlot != slot else { return }
        filledSlot = slot
        for (vi, list) in byVariant.enumerated() where !list.isEmpty {
            let p = buffers[vi][slot].contents().bindMemory(to: Inst.self, capacity: list.count)
            for (k, t) in list.enumerated() {
                // Into the tree's own frame for the shader.
                let c = cos(t.rot), sn = sin(t.rot), inv = 1 / t.scale
                let sway = V4((t.sx * c - t.sz * sn) * inv, (t.sx * sn + t.sz * c) * inv, t.load, t.shiver)
                p[k] = Inst(model: models[vi][k], sway: sway, inst: V4(t.seed, t.front, 0, 0))
            }
        }
    }

    func draw(_ ctx: DrawContext) {
        fill(ctx.slot)
        let e = ctx.encoder
        func each(_ body: (TreeVariant, Int, MTLBuffer) -> Void) {
            for (vi, list) in byVariant.enumerated() where !list.isEmpty {
                let v = variants[vi]
                if ctx.isShadow && !v.castShadow { continue }
                body(v, list.count, buffers[vi][ctx.slot])
            }
        }
        let H = Aspen.hidden
        func meshes(_ pick: (TreeVariant) -> GPUMesh?) {
            each { v, n, buf in
                guard let m = pick(v) else { return }
                e.setVertexBuffer(m.vertices, offset: 0, index: 0)
                e.setVertexBuffer(buf, offset: 0, index: 3)
                e.drawIndexedPrimitives(type: .triangle, indexCount: m.count, indexType: .uint32, indexBuffer: m.indices,
                                        indexBufferOffset: 0, instanceCount: n)
            }
        }
        // The bark of trunks and branches: opaque, nothing cut out, so the GPU can skip what is hidden.
        ctx.use("treeVertex", "barkFragment")
        e.setFragmentTexture(bark.feature, index: 3)
        e.setFragmentTexture(bark.detail, index: 4)
        e.setFragmentTexture(bark.rough, index: 5)
        if !H.contains("wood") { meshes { $0.wood } }
        // The twig fans, cut out of their cards in the shader.
        ctx.use("treeVertex", "twigFragment", shadowFragment: "twigShadowFragment", alphaToCoverage: true)
        if !H.contains("twigs") && !(ctx.isShadow && H.contains("twigshadow")) && !(!ctx.isShadow && H.contains("twigmain")) { meshes { $0.twig } }
        // The snow ridges, seen from above only (three's FrontSide).
        ctx.use("treeVertex", "ridgeFragment", shadowFragment: "ridgeShadowFragment", alphaToCoverage: true)
        if !ctx.isShadow { e.setCullMode(.back) }
        if !H.contains("ridges") { meshes { $0.snow } }
        e.setCullMode(.none)
    }
}

extension Shaders {
    static let tree = """

    // MARK: - Trees: shared deformation

    struct TreeInst { float4x4 model; float4 sway; float4 inst; };
    struct TreeOut {
        float4 position [[position]];
        float3 world; float3 normal; float2 muv; float4 F; float c; float load; float seed; float t;
    };

    /// verts: (position, u), (normal, v), f = (kind, flex, tH, y), (c, t) per vertex.
    vertex TreeOut treeVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], device const TreeInst* inst [[buffer(3)]]) {
        float4 a = verts[vid * 4], b = verts[vid * 4 + 1], f = verts[vid * 4 + 2], ct = verts[vid * 4 + 3];
        TreeInst I = inst[iid];
        float uTime = F.misc.x;
        float3 gPos = a.xyz;
        float kind = f.x;
        float tH = clamp(f.z, 0.0, 1.0);
        // Snow stays only below the cascade front (1 when the tree is undisturbed).
        float snowOn = clamp(I.sway.z, 0.0, 1.0) * (1.0 - smoothstep(I.inst.y - 0.02, I.inst.y + 0.02, tH));
        if (abs(kind - 2.0) < 0.5) gPos.y += ct.y * snowOn;
        float flex = f.y;
        if (kind > 0.5) {
            // Branches bend a little under their snow and flutter in the wind, most at the tips.
            float ph = dot(gPos, float3(1.7, 0.9, 1.3)) + I.inst.x * 20.0;
            float w = length(F.wind.xy) * 0.2 + 0.4;
            gPos.y -= snowOn * 0.03 * flex * flex;
            gPos.y += sin(uTime * q(1.9) + ph) * 0.012 * flex * w;
            gPos.xz += float2(sin(uTime * q(1.3) + ph * 1.3), cos(uTime * q(1.6) + ph)) * 0.008 * flex * w;
        }
        // The whole tree sways from the base, and shivers when struck.
        gPos.xz += I.sway.xy * (tH * tH * (1.4 - 0.4 * tH));
        gPos.xz += float2(sin(uTime * q(23.0) + gPos.y * 2.3), cos(uTime * q(27.0) + gPos.y * 1.9)) * I.sway.w * 0.03 * tH;
        float4 wp = I.model * float4(gPos, 1.0);
        TreeOut o;
        o.world = wp.xyz;
        o.normal = transformNormal(I.model, b.xyz);
        o.muv = float2(a.w, b.w);
        o.F = f;
        o.c = ct.x;
        o.t = ct.y;
        o.load = snowOn;
        o.seed = I.inst.x;
        o.position = F.viewProj * wp;
        return o;
    }

    // MARK: - The bark, from the painted maps (Bark.swift)

    /// Value noise whose lattice wraps every `period` cells in x, for patterns round a trunk.
    float pvnoise(float2 p, float period) {
        float2 i = floor(p), f = fract(p); float2 u = f * f * (3.0 - 2.0 * f);
        float x0 = fmodGL(i.x, period), x1 = fmodGL(i.x + 1.0, period);
        return mix(mix(hash21(float2(x0, i.y)), hash21(float2(x1, i.y)), u.x),
                   mix(hash21(float2(x0, i.y + 1.0)), hash21(float2(x1, i.y + 1.0)), u.x), u.y);
    }

    /// p is the position on the trunk in metres (around, up), seed the tree's own offset, circ its
    /// circumference (0 for branches), dead 1 for bare fallen wood. Returns the colour; rough and
    /// bump come out through the reference parameters.
    float3 aspenBark(float2 p, float seed, float dead, float circ, thread float& rough, thread float& bump,
                     texture2d<float> feature, texture2d<float> detail, texture2d<float> roughTex, sampler s) {
        // Round a trunk the feature map is squeezed to a whole number of repeats, so it meets itself
        // at the seam (thin trunks get smaller eyes, as they do).
        float reps = max(1.0, floor(circ + 0.5));
        float ax = circ > 0.0 ? p.x / circ * reps : p.x;
        float4 Fe = feature.sample(s, float2(ax + seed * 0.37, p.y / 4.0 + seed * 1.7));
        float4 D = detail.sample(s, p / 0.2);
        float4 Rg = roughTex.sample(s, float2(ax + seed * 0.61, p.y / 2.0 + seed * 0.9));
        // The rough bark of the foot. Departure from the web version (to try here first): how far up
        // it reaches varies continuously from tree to tree, from a dark collar a hand high on most
        // trunks to rough bark nearly two metres up on the oldest, instead of two fixed bands.
        float hOld = hash11(seed * 5.0 + 1.0);
        float top = 0.08 + 1.6 * pow(hOld, 2.2);
        // The edge wanders round the trunk in rounded tongues, following the ridges a little.
        float edge = p.y + 0.1 * sin(ax * 12.57 + seed * 9.0) + 0.06 * sin(ax * 31.4 + seed * 3.0) + 0.03 * sin(ax * 69.1 + seed * 2.0) + (Rg.a - 0.5) * 0.03;
        float live = (circ > 0.0 && dead < 0.5) ? 1.0 : 0.0;
        // A crisp edge at any distance (the web version blends over 7 cm, which blurs close up).
        float ew = clamp(fwidthf(edge), 0.003, 0.035);
        float furrow = live * (1.0 - smoothstep(top - ew, top + ew, edge));
        // Above the edge it breaks up into patches and islands before the smooth bark takes over,
        // rather than stopping at one hard line (the web version's edge read as a burnt band).
        float zone = 0.25 + 0.6 * hOld;
        float thr = mix(0.52, 1.05, clamp((p.y - top) / zone, 0.0, 1.0));
        // The patches are plates of rough bark: taller than wide, with ragged but crisp edges.
        float patchN = pvnoise(float2(ax * 14.0 + seed * 17.0, p.y * 6.0), reps * 14.0) * 0.6
                     + pvnoise(float2(ax * 40.0 + seed * 5.0, p.y * 18.0), reps * 40.0) * 0.25
                     + (Rg.a - 0.5) * 0.3;
        float pw = max(fwidthf(patchN), 0.004);
        furrow = max(furrow, live * smoothstep(thr - pw, thr + pw, patchN) * step(top - 0.1, p.y));
        // Each trunk's rough bark has its own tone: some greyer, some darker.
        float tone = 0.85 + 0.3 * hash11(seed * 3.7 + 2.0);
        float3 smoothCol = Fe.rgb * (0.92 + 0.16 * D.r) * (0.96 + 0.08 * D.b);
        // Softer than the web version's: the furrows lifted and the crests toned down toward a
        // mid grey, so the foot reads as weathered bark rather than pale dashes on black.
        float3 roughCol = mix(float3(0.17, 0.16, 0.15), Rg.rgb, 0.7) * (0.85 + 0.3 * D.g) * tone;
        float3 col = mix(smoothCol, roughCol, furrow);
        rough = mix(0.62 + 0.1 * D.r, 0.98, furrow);
        bump = mix((Fe.a - 0.5) * 0.045 + (D.a - 0.5) * 0.003, (Rg.a - 0.5) * 0.012, furrow);
        // Dead wood (fallen branches, logs): weathered silver-grey, the bark gone, the grain showing.
        float3 g2 = mix(float3(0.16, 0.15, 0.13), float3(0.34, 0.33, 0.30), D.b) * (0.85 + 0.3 * D.g);
        col = mix(col, g2, dead);
        rough = mix(rough, 0.9, dead);
        bump = mix(bump, (D.a - 0.5) * 0.004, dead);
        return col;
    }

    // MARK: - Twig fans

    /// Distance across from a straight twig segment from p0 along unit dir, of length len; also how
    /// far along (0..1) in t.
    float segDist(float2 m, float2 p0, float2 dir, float len, thread float& t) {
        float2 d = m - p0;
        float along = dot(d, dir);
        t = along / len;
        along = clamp(along, 0.0, len);
        return length(d - dir * along);
    }

    /// The twigs on a card: coverage, and how much of what's covered is snow on the twigs' upper
    /// sides. m is the position on the card in metres (along, across: + is up), L the card's length.
    /// Six twigs leave the branch end, spread a little either side and curving upward as they go,
    /// each with two side twigs.
    /// `sides` false leaves out the side twigs (for the shadow maps, where they are under a texel).
    float twigCover(float2 m, float L, float seed, float load, thread float& snowK, thread float& shade, bool sides = true) {
        float cover = 0.0; snowK = 0.0; shade = 0.0;
        float fw = max(fwidthf(m.x), 1e-4);
        float r = length(m), a = atan2(m.y, m.x);
        // Nothing behind the branch end or beyond the longest side twig.
        if (m.x < 0.0 || r > L * 1.15) return 0.0;
        // Far away the twigs merge into a faint, broken grey mass so the crowns don't vanish; once
        // a twig is well under a pixel, the mass is all there is to draw.
        float far = smoothstep(0.025, 0.07, fw);
        float mass = 0.2 * (1.0 - smoothstep(0.35, 1.0, r / L)) * (1.0 - smoothstep(0.2, 0.5, abs(a - 0.25 * r / L)));
        mass *= 0.5 + 0.5 * vnoise(m * 30.0 + seed * 40.0);
        if (far > 0.999) return mass;
        for (int i = 0; i < 7; i++) {
            float fi = float(i);
            float h = hash11(seed * 13.1 + fi * 1.7), h2 = hash11(seed * 7.7 + fi * 2.3);
            float a0 = (fi - 3.0) * 0.14 + (h - 0.5) * 0.1;
            float len = L * (0.5 + 0.5 * h2);
            // Curving upward, more the longer it goes.
            float curve = 0.25 + 0.4 * h;
            float ai = a0 + curve * r / L;
            float da = abs(a - ai) * r;
            // Neither this twig nor its side twigs (at most a third of its length long, at most
            // 0.7 rad off it) can reach a point this far to the side: skip it.
            if (da > 0.3 * len + 0.012 + fw) continue;
            float t = r / len;
            float w = 0.004 * (1.0 - 0.65 * clamp(t, 0.0, 1.0)) + 0.0008;
            float on = step(0.0, m.x) * (1.0 - smoothstep(0.97, 1.03, t));
            float twig = (1.0 - smoothstep(w - fw, w + fw, da)) * on;
            float dy = (a - ai) * r;
            float snow = (1.0 - smoothstep(w + 0.005 * load - fw, w + 0.005 * load + fw, da)) * on * step(0.0, dy) * step(0.25, load) * step(0.12, t);
            snowK = max(snowK, snow * (1.0 - twig));
            shade = max(shade, twig * (1.0 - smoothstep(0.0, w, da)));
            cover = max(cover, max(twig, snow));
            for (int k = 0; k < (sides ? 2 : 0); k++) {
                float fk = float(k);
                float s0 = 0.3 + 0.3 * fk + 0.15 * hash11(seed + fi * 3.1 + fk);
                float sgn = fk < 0.5 ? 1.0 : -1.0;
                float a1 = a0 + curve * s0 * len / L;
                float ab = a1 + sgn * (0.3 + 0.25 * hash11(seed * 2.0 + fi + fk)) + 0.15;
                float2 p0 = float2(cos(a1), sin(a1)) * s0 * len;
                float tt;
                float ds = segDist(m, p0, float2(cos(ab), sin(ab)), len * (0.22 + 0.15 * h2), tt);
                float ws = 0.0025 * (1.0 - 0.5 * tt) + 0.0007;
                float side = (1.0 - smoothstep(ws - fw, ws + fw, ds)) * step(0.0, tt) * step(tt, 1.0);
                float2 rel = m - p0; float dys = rel.x * -sin(ab) + rel.y * cos(ab);
                float ssnow = (1.0 - smoothstep(ws + 0.004 * load - fw, ws + 0.004 * load + fw, ds)) * step(0.0, tt) * step(tt, 1.0) * step(0.0, dys) * step(0.25, load);
                snowK = max(snowK, ssnow * (1.0 - side));
                cover = max(cover, max(side, ssnow));
            }
        }
        return mix(cover, max(cover, mass), far);
    }

    /// The snow ridge's coverage: full along the middle, breaking up at the sides and when the load is low.
    float ridgeCover(float2 m, float c, float load, float seed) {
        float n = vnoise(m * float2(12.0, 60.0) + seed * 13.0) * 0.6 + vnoise(m * float2(40.0, 200.0) + seed) * 0.4;
        float mid = 1.0 - c * c;
        float thr = 1.1 - load * 1.0;
        return smoothstep(thr, thr + 0.15, n * 0.5 + mid * 0.65);
    }

    // MARK: - The wood: bark, branches and twigs

    fragment float4 barkFragment(TreeOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                 depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                 texture2d<float> feature [[texture(3)]], texture2d<float> detail [[texture(4)]],
                                 texture2d<float> roughTex [[texture(5)]],
                                 sampler rs [[sampler(0)]], sampler cmp [[sampler(2)]]) {
        float barkBump = 0.0;
        float barkRough = 0.6;
        float kind = in.F.x;
        float dead = kind < 0.5 && in.F.y < -0.5 ? 1.0 : 0.0;
        float circ = kind < 0.5 && in.F.y > 0.0 ? 6.2831853 * in.F.y : 0.0;
        float3 base = aspenBark(in.muv, in.seed + (kind > 2.5 ? in.F.w * 0.37 : 0.0), dead, circ, barkRough, barkBump, feature, detail, roughTex, rs);
        if (kind < 0.5 && dead < 0.5) {
            // The foot of the trunk, where the snow banks against it, is in the shade of both
            // (a little lighter than the web version's 0.4, with the rest of the foot-bark change).
            base *= 1.0 - 0.3 * (1.0 - smoothstep(-0.1, 0.5, in.F.w));
        }
        if (kind > 2.5) {
            // Branches: the same bark, smoother and greyer toward the thin ends.
            base = mix(base, float3(0.30, 0.28, 0.22), smoothstep(0.3, 1.0, in.F.y) * 0.5);
        }
        float3 n = normalize(in.normal);
        if (!front) n = -n;
        float geo = geometryRoughness(n);
        n = perturbByHeight(n, in.world, barkBump, 1.0);
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, base, n, in.world, barkRough, 0.0, shadow, geo);
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    fragment float4 twigFragment(TreeOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                 depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                 sampler cmp [[sampler(2)]]) {
        float snowK, shade;
        float cover = twigCover(in.muv, in.t, in.F.w, in.load, snowK, shade);
        if (cover < 0.02) discard_fragment();
        // Without multisampling there is no alpha to coverage: cut at one half instead (Low Power).
        if (F.screen.w < 0.5) { if (cover < 0.5) discard_fragment(); cover = 1.0; }
        // Twigs: grey-brown, a touch reddish at the buds; snow where it lies on them.
        float3 twig = mix(float3(0.12, 0.10, 0.08), float3(0.26, 0.21, 0.16), hash21(floor(in.muv * 40.0) + in.seed));
        twig *= 1.0 - shade * 0.35;
        float3 base = mix(twig, float3(0.9, 0.92, 0.96), snowK);
        float rough = mix(0.8, 0.6, snowK);
        float3 n = normalize(in.normal);
        if (!front) n = -n;
        float2 shadow = keyShadowsFast(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, base, n, in.world, rough, 0.0, shadow, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), cover);
    }

    fragment void twigShadowFragment(TreeOut in [[stage_in]]) {
        float snowK, shade;
        if (twigCover(in.muv, in.t, in.F.w, in.load, snowK, shade, false) < 0.5) discard_fragment();
    }

    // MARK: - The snow ridges

    fragment float4 ridgeFragment(TreeOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                  depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                  sampler cmp [[sampler(2)]]) {
        float cover = ridgeCover(in.muv, in.c, in.load, in.seed);
        if (cover < 0.03) discard_fragment();
        // Without multisampling there is no alpha to coverage: cut at one half instead (Low Power).
        if (F.screen.w < 0.5) { if (cover < 0.5) discard_fragment(); cover = 1.0; }
        // #f6f8ff in linear; shaded snow at the ridge's edges looks blue.
        float3 albedo = float3(0.922, 0.939, 1.0) * mix(float3(0.8, 0.86, 1.0), float3(1.0), smoothstep(0.0, 0.6, 1.0 - abs(in.c)));
        float3 n = normalize(in.normal);
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, albedo, n, in.world, 0.75, 0.0, shadow, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), cover);
    }

    fragment void ridgeShadowFragment(TreeOut in [[stage_in]]) {
        if (ridgeCover(in.muv, in.c, in.load, in.seed) < 0.5) discard_fragment();
    }

    """
}
