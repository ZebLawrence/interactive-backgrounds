import Foundation
import Metal
import simd

// Spruce: procedural trees built branch by branch, loaded with snow that bends the boughs, swaying
// on springs, and shedding their snow when the wind (or the cursor) shakes them.
//
// Built like the real thing: a tapering trunk; whorls of branches every 20-35 cm, longest at the
// bottom of a narrow crown (snow-country spruce are slender, which helps them shed snow); each
// branch a flat, arched spray of side twigs clothed in 1-2 cm needles, drooping from the trunk and
// turning up at the tip; dead, bare twigs low on the trunk where the crown has been shaded out.
// Snow lies on each spray as a pillow, thickest along the middle, and its weight bends the branch
// down. A shaken tree drops its load in clumps, and the branches spring back up.

/// Vertex kinds, in `f.x`.
private let BARK: Float = 0, NEEDLES: Float = 1, TWIG: Float = 2, SNOW: Float = 3

/// Accumulates the vertices of one tree. f = (kind, droop s, parent length lp, height fraction);
/// c across the spray; t the snow pillow's thickness.
private final class SpruceBuilder {
    final class Target {
        var pos: [V3] = [], uv: [V2] = [], f: [V4] = [], c: [Float] = [], t: [Float] = [], idx: [UInt32] = []
    }
    struct Vert { var p: V3; var uv: V2; var f: V4; var c: Float = 0; var t: Float = 0 }

    /// The bark and dead twigs (opaque), the needle sprays (cut out in the shader), the snow pillows.
    /// The web version keeps bark and needles in one mesh; here they are drawn apart so the opaque
    /// trunks keep the GPU's hidden-surface removal.
    let wood = Target(), needles = Target(), snow = Target()

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

    /// Upload a target: four float4s per vertex, (position, u), (normal, v), f, (c, t).
    func mesh(_ target: Target, offsetThickness: Bool = false) -> GPUMesh? {
        guard !target.idx.isEmpty else { return nil }
        var m = MeshData()
        m.indices = target.idx
        if offsetThickness {
            // Normals for the snow pillows are computed at full thickness, then the thickness is taken
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

/// One built tree (spruce or snag): its meshes and its proportions.
final class TreeVariant {
    let wood: GPUMesh?
    let needles: GPUMesh?
    let snow: GPUMesh?
    var castShadow = true
    var height: Float, crownBase: Float, maxR: Float
    var black = false
    /// A snag's broken top, in the tree's own frame (where an owl perches).
    var top = V3(0, 4, 0)

    fileprivate init(_ b: SpruceBuilder, height: Float, crownBase: Float, maxR: Float) {
        wood = b.mesh(b.wood)
        needles = b.mesh(b.needles)
        snow = b.mesh(b.snow, offsetThickness: true)
        self.height = height
        self.crownBase = crownBase
        self.maxR = maxR
    }
}

/// Build one spruce. `rng` is a seeded random; `H` the height in metres; `detail` 1 for the trees
/// near the viewer and lower for the far ones (fewer whorls and no secondary sprays). `black` picks
/// a slender black spruce; nil decides at random, as the web version does without the option.
func buildSpruce(_ rng: Seeded, _ H: Float, detail: Float, black blackOpt: Bool? = nil) -> TreeVariant {
    let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
    let b = SpruceBuilder()
    let black = blackOpt ?? (rng() < 0.4)
    let up = V3(0, 1, 0)

    // The trunk: a tapering tube with bark mapped in metres.
    let baseR = 0.045 + H * 0.011
    func trunkR(_ t: Float) -> Float { baseR * pow(1 - t, 0.85) + 0.008 }
    let lx = R(-1, 1), lz = R(-1, 1)
    let lean = V3(lx, 0, lz) * (H * 0.006)
    func axis(_ y: Float) -> V3 { V3(lean.x * (y / H) * (y / H), y, lean.z * (y / H) * (y / H)) }
    let rows = max(6, Int((H * 1.2 * detail).rounded())), sides = detail > 0.6 ? 8 : 5
    b.grid(b.wood, rows + 1, sides + 1) { r, c in
        let t = Float(r) / Float(rows), a = Float(c) / Float(sides) * TAU
        let rad = trunkR(t)
        let o = axis(t * H)
        return SpruceBuilder.Vert(p: V3(o.x + cos(a) * rad, o.y - (r == 0 ? 0.3 : 0), o.z + sin(a) * rad),
                                  uv: V2(Float(c) / Float(sides) * TAU * baseR, t * H), f: V4(BARK, 0, 1, t))
    }

    /// One flat, arched spray from `o` along horizontal `d`. `lp` is the parent branch length.
    func spray(_ o: V3, _ d: V3, _ L: Float, _ w: Float, _ lp: Float, _ curve: (Float, Float), withSnow: Bool, snowScale: Float = 1) {
        let S = detail > 0.6 ? 7 : 4
        let side = V3(-d.z, 0, d.x)
        func width(_ s: Float) -> Float { w * pow(sin(.pi * clamp((s + 0.1) / 1.1, 0, 1)), 0.7) * (1 - 0.3 * s) }
        func centre(_ s: Float) -> V3 { o + d * (s * L) + up * ((curve.0 * s + curve.1 * s * s) * L) }
        func surface(_ s: Float, _ c: Float) -> V3 { centre(s) + side * (c * width(s)) + up * (-0.16 * width(s) * c * c) }
        func droopS(_ p: V3) -> Float {
            let a = axis(p.y)
            return clamp(hypot(p.x - a.x, p.z - a.z) / lp, 0, 1.3)
        }
        b.grid(b.needles, S + 1, 3) { r, ci in
            let s = Float(r) / Float(S), c = Float(ci - 1)
            let p = surface(s, c)
            return SpruceBuilder.Vert(p: p, uv: V2(s * L, c * width(s)), f: V4(NEEDLES, droopS(p), lp, p.y / H), c: c)
        }
        guard withSnow else { return }
        // The snow pillow: five across, thickest along the middle, thin near the trunk and the tip.
        let tmax = clamp(0.3 * w, 0.015, 0.11) * snowScale
        b.grid(b.snow, S + 1, 5) { r, ci in
            let s = Float(r) / Float(S), c = Float(ci - 2) / 2
            let p = surface(s, c * 0.92)
            let th = tmax * pow(sin(.pi * clamp(s * 1.05, 0, 1)), 0.6) * (1 - c * c) * smoothstep(0.02, 0.2, s)
            return SpruceBuilder.Vert(p: p + up * 0.006, uv: V2(s * L, c * width(s)), f: V4(SNOW, droopS(p), lp, p.y / H), c: c, t: th)
        }
    }

    // The crown.
    let crownBase = H * (black ? R(0.03, 0.14) : R(0.08, 0.26))
    let maxR = H * (black ? R(0.09, 0.12) : R(0.13, 0.17))
    let club = black && rng() < 0.45   // black spruce often carry a dense club of cones at the top
    let spacing = R(0.22, 0.32) / detail.squareRoot()
    var az = R(0, TAU)
    var y = crownBase
    while y < H - 0.22 {
        let t = (y - crownBase) / (H - crownBase)
        var rad = maxR * pow(1 - t, 0.9) + 0.12
        if club && t > 0.82 && t < 0.95 { rad *= 1.7 }
        // Old lower branches droop more; young upper ones reach up.
        let c0 = lerp(-0.42, -0.08, t) + R(-0.08, 0.08)
        let c1 = lerp(0.32, 0.12, t) + R(-0.05, 0.05)
        let curve = (c0, c1)
        let n = Int((lerp(5, 4, t) + R(-0.4, 0.6)).rounded())
        for _ in 0..<max(n, 0) {
            if rng() < 0.08 { continue }
            az += TAU / Float(n) + R(-0.35, 0.35)
            let d = V3(cos(az), 0, sin(az))
            let L = rad * R(0.75, 1.15)
            if L < 0.08 { continue }
            let o = axis(y) + d * (trunkR(y / H) * 0.8)
            // Simpler far trees make up for their missing sprays with broader ones.
            spray(o, d, L, L * R(0.36, 0.46) / pow(detail, 0.45), L, curve, withSnow: true)
            if detail > 0.6 && L > 0.45 {
                // Secondary sprays off the main branch fill the bough out.
                let s0s = [R(0.25, 0.4), R(0.5, 0.7)]
                for s0 in s0s {
                    for sgn: Float in [-1, 1] {
                        if rng() < 0.25 { continue }
                        let ang = sgn * R(0.5, 0.85)
                        let d2 = V3(d.x * cos(ang) - d.z * sin(ang), 0, d.x * sin(ang) + d.z * cos(ang))
                        let o2 = o + d * (s0 * L) + up * ((curve.0 * s0 + curve.1 * s0 * s0) * L - 0.02)
                        let L2 = L * R(0.35, 0.5) * (1 - s0 * 0.4)
                        spray(o2, d2, L2, L2 * 0.42, L, (curve.0 * 0.6, curve.1 * 0.6), withSnow: true, snowScale: 0.6)
                    }
                }
            }
        }
        y += spacing * R(0.8, 1.2)
    }
    // The leader: a short, upright sprig at the very top, crossed so it reads from any side.
    for a: Float in [0, .pi / 2] {
        let top = axis(H - 0.3)
        let d = V3(cos(a), 0, sin(a))
        b.grid(b.needles, 4, 3) { r, ci in
            let s = Float(r) / 3, c = Float(ci - 1)
            let w = 0.07 * (1 - s * 0.8)
            let p = top + up * (s * 0.42) + d * (c * w)
            return SpruceBuilder.Vert(p: p, uv: V2(s * 0.42, c * w), f: V4(NEEDLES, 0, 0.3, p.y / H), c: c)
        }
    }
    // Dead twigs on the bare lower trunk.
    if detail > 0.6 {
        var ty: Float = 0.4
        while ty < crownBase {
            for _ in 0..<3 {
                if rng() < 0.35 { continue }
                let a = R(0, TAU), L = R(0.15, 0.55)
                let dy = R(-0.5, 0.1)
                let d = V3(cos(a), dy, sin(a)).normalized
                let o = axis(ty)
                for cross in [false, true] {
                    let side = cross ? V3(0, 1, 0) : V3(-d.z, 0, d.x)
                    b.grid(b.wood, 2, 2) { r, ci in
                        let w = 0.012 * (1 - Float(r) * 0.7)
                        let p = o + d * (Float(r) * L) + side * ((Float(ci) - 0.5) * w)
                        return SpruceBuilder.Vert(p: p, uv: V2(Float(r) * L, 0), f: V4(TWIG, 0, 1, p.y / H))
                    }
                }
            }
            ty += R(0.15, 0.3)
        }
    }
    let v = TreeVariant(b, height: H, crownBase: crownBase, maxR: maxR)
    v.black = black
    return v
}

/// A dead spruce: silver-grey and bare, broken off at the top, with stubs of branches.
func buildSnag(_ rng: Seeded, _ H: Float) -> TreeVariant {
    let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
    let b = SpruceBuilder()
    let baseR = 0.15 + H * 0.02
    let rows = 16, sides = 12
    let lx = R(-1, 1), lz = R(-1, 1)
    let lean = V3(lx, 0, lz) * (0.012 * H)
    func axis(_ y: Float) -> V3 { V3(lean.x * y / H, y, lean.z * y / H) }
    b.grid(b.wood, rows + 1, sides + 1) { r, c in
        let t = Float(r) / Float(rows), a = Float(c) / Float(sides) * TAU
        // The broken top is jagged: the last ring is torn to different heights.
        let tear: Float = r == rows ? R(-0.35, 0.05) : 0
        // A flared base, then a steady taper; weathered wood bulges and knots here and there.
        let ragged: Float = r == rows ? R(0.4, 0.9) : 1
        let rad = baseR * (1 - t * 0.7) * (1 + 0.35 * exp(-t * 18)) * (1 + 0.05 * sin(a * 3 + t * 20)) * ragged
        let o = axis(t * H + tear)
        return SpruceBuilder.Vert(p: V3(o.x + cos(a) * rad, o.y - (r == 0 ? 0.3 : 0), o.z + sin(a) * rad),
                                  uv: V2(Float(c) / Float(sides) * TAU * baseR, t * H), f: V4(BARK, 1, 1, t))
    }
    // Dead spruce keep the stubs of every whorl, a bottle-brush of grey twigs up the trunk, and a
    // few longer dead limbs.
    var y: Float = 0.5
    while y < H - 0.3 {
        for _ in 0..<4 {
            if rng() < 0.3 { continue }
            let a = R(0, TAU)
            let L = rng() < 0.22 ? R(0.6, 1.5) * (1 - y / H * 0.5) : R(0.12, 0.4)
            let dy = R(-0.4, 0.15)
            let d = V3(cos(a), dy, sin(a)).normalized
            let o = axis(y)
            for cross in [false, true] {
                let side = cross ? V3(0, 1, 0) : V3(-d.z, 0, d.x)
                b.grid(b.wood, 2, 2) { r, ci in
                    let w = (L > 0.4 ? 0.05 : 0.03) * (1 - Float(r) * 0.75)
                    let p = o + d * (Float(r) * L) + side * ((Float(ci) - 0.5) * w)
                    return SpruceBuilder.Vert(p: p, uv: V2(Float(r) * L, 0), f: V4(TWIG, 1, 1, p.y / H))
                }
            }
        }
        y += R(0.14, 0.3)
    }
    // A cap of snow on the broken top.
    let top = axis(H - 0.1)
    let capR = baseR * 0.4
    b.grid(b.snow, 5, 13) { r, c in
        let rr = Float(r) / 4 * capR * 1.15, a = Float(c) / 12 * TAU
        let th = 0.09 * (1 - pow(Float(r) / 4, 2))
        return SpruceBuilder.Vert(p: V3(top.x + cos(a) * rr, top.y, top.z + sin(a) * rr), uv: V2(rr, a * rr),
                                  f: V4(SNOW, 0, 1, 1), c: Float(r) / 4, t: th)
    }
    let v = TreeVariant(b, height: H, crownBase: H, maxR: 0.3)
    v.top = V3(top.x, H - 0.05, top.z)
    return v
}

// MARK: - The forest

/// One tree standing in the forest, with its spring and its snow.
final class TreeInstance {
    var x: Float, y: Float = 0, z: Float, rot: Float, scale: Float, variant: Int
    /// The snow on it, 0..1, and how much it can hold.
    var load: Float
    var maxLoad: Float = 1
    let snag: Bool
    var height: Float = 0, crownBase: Float = 0, maxR: Float = 0
    /// The top's sway (m) and its velocity (m/s), world x and z.
    var sx: Float = 0, sz: Float = 0, vx: Float = 0, vz: Float = 0
    var omega: Float = 1
    /// How hard the boughs are fluttering.
    var flutter: Float = 0
    var shedAcc: Float = 0
    var phase = Float.random(in: 0..<100)
    fileprivate var slot = 0

    init(x: Float, z: Float, rot: Float, scale: Float, variant: Int, load: Float, snag: Bool = false) {
        self.x = x; self.z = z; self.rot = rot; self.scale = scale; self.variant = variant; self.load = load; self.snag = snag
    }
}

/// Instances of a handful of tree variants, each on its own spring.
final class Forest {
    /// Per instance: its matrix, and the top's sway in its own frame (x, z), the load and the flutter.
    private struct Inst { var model: simd_float4x4; var sway: V4 }

    let variants: [TreeVariant]
    let trees: [TreeInstance]
    private let byVariant: [[TreeInstance]]
    private let models: [[simd_float4x4]]
    /// One instance buffer per variant per frame in flight.
    private let buffers: [[MTLBuffer]]
    private var filledSlot = -1

    init(variants: [TreeVariant], trees: [TreeInstance]) {
        self.variants = variants
        self.trees = trees
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
                // A spring for the top: real conifers sway at 0.2-0.6 Hz, slower when taller.
                t.omega = TAU * clamp(3.2 / t.height.squareRoot(), 0.25, 1.2)
                t.maxLoad = t.load
            }
        }
    }

    /// Push a tree's top with a velocity impulse (m/s, world x/z).
    func shake(_ t: TreeInstance, _ ix: Float, _ iz: Float) {
        t.vx += ix
        t.vz += iz
        t.flutter = min(1.5, t.flutter + hypot(ix, iz) * 0.8)
    }

    /// The world position of a point `f` of the way up the tree, swayed.
    func pointUp(_ t: TreeInstance, _ f: Float) -> V3 {
        let b = f * f * (1.4 - 0.4 * f)
        return V3(t.x + t.sx * b, t.y + t.height * f, t.z + t.sz * b)
    }

    /// Step the springs. `wind(x, z)` gives the ambient wind at a tree (m/s). Calls `shed(t, amount)`
    /// whenever a tree swings hard enough to drop some of its snow.
    func update(dt: Float, time now: Float, wind: (Float, Float) -> V2, snowing: Bool, shed: (TreeInstance, Float) -> Void) {
        for t in trees {
            let w = wind(t.x, t.z)
            // Wind leans the top over a little (drag grows with the square of the speed) and its
            // turbulence keeps it moving.
            let gustiness = 0.5 + 0.5 * sin(now * 0.37 + t.phase) * sin(now * 0.23 + t.phase * 1.7)
            let lean = 0.012 * t.height / 10
            let ex = w.x * abs(w.x) * lean * (0.6 + 0.6 * gustiness)
            let ez = w.y * abs(w.y) * lean * (0.6 + 0.6 * gustiness)
            let zeta: Float = 0.07
            let ax = -t.omega * t.omega * (t.sx - ex) - 2 * zeta * t.omega * t.vx
            let az = -t.omega * t.omega * (t.sz - ez) - 2 * zeta * t.omega * t.vz
            t.vx += ax * dt
            t.vz += az * dt
            t.sx += t.vx * dt
            t.sz += t.vz * dt
            let speed = hypot(t.vx, t.vz)
            t.flutter = max(t.flutter * exp(-dt / 2.5), 0.12 + hypot(w.x, w.y) * 0.08)
            // A hard swing shakes snow loose; the load builds again slowly while it snows.
            if speed > 0.35 && t.load > 0.05 {
                let lost = min(t.load, (speed - 0.35) * dt * 0.45)
                t.load -= lost
                // Snow comes off in a few clumps at a time, not a steady stream.
                t.shedAcc += lost
                if t.shedAcc > 0.04 {
                    shed(t, t.shedAcc)
                    t.shedAcc = 0
                }
            } else if snowing && t.load < t.maxLoad {
                t.load = min(t.maxLoad, t.load + dt / 600)
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
                p[k] = Inst(model: models[vi][k], sway: V4((t.sx * c - t.sz * sn) * inv, (t.sx * sn + t.sz * c) * inv, t.load, t.flutter))
            }
        }
    }

    func draw(_ ctx: DrawContext) {
        fill(ctx.slot)
        let e = ctx.encoder
        let H = Boreal.hidden
        func meshes(_ pick: (TreeVariant) -> GPUMesh?) {
            for (vi, list) in byVariant.enumerated() where !list.isEmpty {
                let v = variants[vi]
                if ctx.isShadow && !v.castShadow { continue }
                guard let m = pick(v) else { continue }
                e.setVertexBuffer(m.vertices, offset: 0, index: 0)
                e.setVertexBuffer(buffers[vi][ctx.slot], offset: 0, index: 3)
                e.drawIndexedPrimitives(type: .triangle, indexCount: m.count, indexType: .uint32, indexBuffer: m.indices,
                                        indexBufferOffset: 0, instanceCount: list.count)
            }
        }
        // Trunks, snags and dead twigs: opaque, nothing cut out, so the GPU can skip what is hidden.
        ctx.use("spruceVertex", "spruceBarkFragment")
        if !H.contains("wood") { meshes { $0.wood } }
        // The needle sprays, cut out of their cards in the shader.
        ctx.use("spruceVertex", "spruceNeedleFragment", shadowFragment: "spruceNeedleShadowFragment", alphaToCoverage: true)
        if !H.contains("needles") { meshes { $0.needles } }
        // The snow pillows, front faces only (three's FrontSide).
        ctx.use("spruceVertex", "spruceSnowFragment", shadowFragment: "spruceSnowShadowFragment", alphaToCoverage: true)
        if !ctx.isShadow { e.setCullMode(.back) }
        if !H.contains("pillows") { meshes { $0.snow } }
        e.setCullMode(.none)
    }
}

extension Shaders {
    static let spruce = """

    // MARK: - Spruce: shared deformation

    struct SpruceInst { float4x4 model; float4 sway; };
    struct SpruceOut {
        float4 position [[position]];
        float3 world; float3 normal; float2 muv; float4 F; float c; float load;
    };

    /// verts: (position, u), (normal, v), f = (kind, droop s, parent length, height fraction), (c, t).
    vertex SpruceOut spruceVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                                  constant Frame& F [[buffer(1)]], device const SpruceInst* inst [[buffer(3)]]) {
        float4 a = verts[vid * 4], b = verts[vid * 4 + 1], f = verts[vid * 4 + 2], ct = verts[vid * 4 + 3];
        SpruceInst I = inst[iid];
        float uTime = F.misc.x;
        float3 gPos = a.xyz;
        float kind = f.x;
        float tH = clamp(f.w, 0.0, 1.0);
        bool bough = kind > 0.5 && abs(kind - 2.0) > 0.5;
        if (bough) {
            // The snow's weight bends the bough down, most at the tip; it flutters in the wind.
            float s = f.y, lp = f.z;
            gPos.y -= I.sway.z * 0.16 * lp * s * s;
            float ph = dot(gPos, float3(1.7, 0.9, 1.3));
            gPos.y += sin(uTime * q(2.3) + ph) * I.sway.w * 0.025 * s * lp;
            gPos.xz += float2(sin(uTime * q(1.7) + ph * 1.3), cos(uTime * q(1.9) + ph)) * I.sway.w * 0.012 * s * lp;
        }
        if (abs(kind - 3.0) < 0.5) gPos.y += ct.y * clamp(I.sway.z * 1.25, 0.0, 1.0);
        // The whole tree sways from the base.
        gPos.xz += I.sway.xy * (tH * tH * (1.4 - 0.4 * tH));
        float4 wp = I.model * float4(gPos, 1.0);
        SpruceOut o;
        o.world = wp.xyz;
        o.normal = transformNormal(I.model, b.xyz);
        o.muv = float2(a.w, b.w);
        o.F = f;
        o.c = ct.x;
        o.load = I.sway.z;
        o.position = F.viewProj * wp;
        return o;
    }

    // MARK: - Bark and dead twigs

    fragment float4 spruceBarkFragment(SpruceOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                       depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                       sampler cmp [[sampler(2)]]) {
        float kind = in.F.x;
        // Bark: grey-brown scales; the dead wood of snags and twigs weathered to silver-grey.
        float scales = vnoise(float2(in.muv.x * 38.0, in.muv.y * 16.0)) * 0.6 + vnoise(in.muv * float2(90.0, 50.0)) * 0.4;
        float3 live = mix(float3(0.13, 0.09, 0.07), float3(0.24, 0.19, 0.15), scales);
        float3 dead = mix(float3(0.28, 0.27, 0.26), float3(0.46, 0.45, 0.42), scales);
        float3 base = mix(live, dead, clamp(step(0.5, in.F.y) * 0.9 + (kind > 1.5 ? 0.35 : 0.0), 0.0, 1.0));
        float3 n = normalize(in.normal);
        if (!front) n = -n;
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, base, n, in.world, 0.92, 0.0, shadow, geometryRoughness(n));
        // A breath of the aurora's green on the wood.
        c += base * F.aurora.xyz * 0.2;
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    // MARK: - Needles

    /// The needles on a spray: side twigs leaving the midrib at about 50 degrees toward the tip, each
    /// serrated by its needles, with a ragged edge to the spray. m is (along, across) in metres, c
    /// across the card (-1..1), lp the parent branch's length (a seed).
    float needleCover(float2 m, float c, float lp, thread float& twigShade) {
        twigShade = 0.0;
        // A ragged edge to the spray as a whole; outside it nothing to draw.
        float edge = 1.0 - smoothstep(0.7, 1.0, abs(c) + (vnoise(m * 31.0) - 0.5) * 0.45);
        if (edge <= 0.0) return 0.0;
        // Far away the needles merge into a mass: once they are well under a pixel the mass is all.
        float far = smoothstep(0.006, 0.03, fwidthf(m.x));
        if (far > 0.999) return edge;
        float across = abs(m.y);
        float sp = 0.05;
        float a = m.x - across * 0.85;
        float k = floor(a / sp);
        float j = hash21(float2(k, sign(m.y) + lp * 37.0));
        float da = abs(fract(a / sp) - 0.5) * sp * 0.76;
        float r = 0.0155 * (0.8 + 0.4 * j);
        // Needles stand out along each twig, so its edge is serrated.
        float serr = 0.62 + 0.38 * abs(sin(across / 0.0042 + j * 6.2831));
        float fw = max(fwidthf(a) * 0.7, 1e-4);
        float twig = 1.0 - smoothstep(r * serr - fw, r * serr + fw, da);
        // Short twigs near the tip of the spray.
        twig *= step(across, 0.02 + 0.6 * max(m.x, 0.0) + 0.02 * j);
        float rib = 1.0 - smoothstep(0.012, 0.012 + fw * 2.0, across);
        twigShade = 1.0 - smoothstep(0.0, r * 0.4, da);
        float cover = max(twig, rib) * edge;
        return mix(cover, edge, far);
    }

    fragment float4 spruceNeedleFragment(SpruceOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                         depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                         sampler cmp [[sampler(2)]]) {
        float twigShade;
        float cover = needleCover(in.muv, in.c, in.F.z, twigShade);
        if (cover < 0.02) discard_fragment();
        // Without multisampling there is no alpha to coverage: cut at one half instead (Low Power).
        if (F.screen.w < 0.5) { if (cover < 0.5) discard_fragment(); cover = 1.0; }
        // Dark blue-green needles, a little lighter toward the tips; brown twigs inside.
        float tip = smoothstep(0.0, 0.6, in.muv.x / max(in.F.z, 0.2));
        float vary = hash21(floor(in.muv * 23.0));
        float3 base = mix(float3(0.028, 0.055, 0.045), float3(0.06, 0.1, 0.075), tip * 0.6 + vary * 0.4);
        base = mix(base, float3(0.09, 0.06, 0.04), twigShade * 0.35);
        float3 n = normalize(in.normal);
        if (!front) n = -n;
        float2 shadow = keyShadowsFast(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, base, n, in.world, 0.92, 0.0, shadow, geometryRoughness(n));
        // A breath of the aurora's green on the needles.
        c += base * F.aurora.xyz * 0.2;
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), cover);
    }

    /// A coarse version of the cut-out for the moon's shadow map.
    fragment void spruceNeedleShadowFragment(SpruceOut in [[stage_in]]) {
        float edge = 1.0 - smoothstep(0.6, 1.0, abs(in.c) + (vnoise(in.muv * 31.0) - 0.5) * 0.45);
        if (edge * (0.55 + 0.45 * vnoise(in.muv * 70.0)) < 0.5) discard_fragment();
    }

    // MARK: - Snow pillows

    float spruceSnowCover(float2 m, float c, float load, float seed) {
        float n = vnoise(m * 9.0 + seed * 13.0) * 0.65 + vnoise(m * 27.0 + seed) * 0.35;
        float mid = 1.0 - c * c;
        float thr = 1.15 - load * 1.05;
        return smoothstep(thr, thr + 0.12, n * 0.55 + mid * 0.6);
    }

    fragment float4 spruceSnowFragment(SpruceOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                       depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                       sampler cmp [[sampler(2)]]) {
        float cover = spruceSnowCover(in.muv, in.c, in.load, in.F.z);
        if (cover < 0.03) discard_fragment();
        if (F.screen.w < 0.5) { if (cover < 0.5) discard_fragment(); cover = 1.0; }
        // #f4f7ff in linear; shaded snow under the pillow's edge looks blue.
        float3 albedo = float3(0.905, 0.930, 1.0) * mix(float3(0.78, 0.84, 1.0), float3(1.0), smoothstep(0.0, 0.6, 1.0 - abs(in.c)));
        float3 n = normalize(in.normal);
        // One filtered shadow tap: the pillows are small and many, and nine cost a millisecond.
        float2 shadow = keyShadowsFast(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, albedo, n, in.world, 0.78, 0.0, shadow, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), cover);
    }

    fragment void spruceSnowShadowFragment(SpruceOut in [[stage_in]]) {
        if (spruceSnowCover(in.muv, in.c, in.load, in.F.z) < 0.5) discard_fragment();
    }

    """
}
