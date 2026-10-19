import CoreGraphics
import Metal
import simd

// What stands on the shore: dark bushes and shrubs along the beach and the bank (tamarisk and
// rabbitbrush, silhouettes at night), blocks and cobbles, and the dust in the air.

// MARK: - Shrubs

/// Feathery sprays on alpha cards round a few stems; by night they are shapes against the water,
/// but they still catch the moon and sway in the breeze. Seen directly and in the reflection; the
/// cards cast the moon's shadow (cut out of their cards), take none themselves, and the stems
/// neither cast nor take one, as the web version's materials have it.
final class Shrubs {
    private let card: GPUMesh
    private let stem: GPUMesh
    private let texture: MTLTexture
    private let instances: MTLBuffer
    private let count: Int
    private let stems: MTLBuffer
    private let stemCount: Int
    static let layers: Layers = .surface

    /// The spray drawn once on a 512 x 512 canvas: a stem with side shoots, each with leaf scales.
    private static func sprayCanvas() -> Canvas {
        let w = 512.0, h = 512.0
        let c = Canvas(Int(w), Int(h))
        let ctx = c.ctx
        ctx.setLineCap(.round)
        func spray(_ x0: Double, _ y0: Double, _ ang: Double, _ len: Double, _ depth: Int) {
            let x1 = x0 + cos(ang) * len, y1 = y0 + sin(ang) * len
            c.stroke(depth == 0 ? .bytes(90, 60, 45, 0.95) : .bytes(95, 110, 80, 0.9))
            c.line(x0, y0, x1, y1, width: depth == 0 ? 4 : 1.6)
            let n = depth == 0 ? 22 : 9
            for i in 1...n {
                let t = Double(i) / Double(n)
                let px = lerp(x0, x1, t), py = lerp(y0, y1, t)
                if depth < 1 {
                    for s in [-1.0, 1.0] { spray(px, py, ang + s * rndD(0.5, 0.9), len * rndD(0.18, 0.32) * (1 - t * 0.5), depth + 1) }
                } else {
                    for s in [-1.0, 1.0] {
                        c.stroke(.bytes(100 + floor(rndD(0, 40)), 125 + floor(rndD(0, 40)), 85 + floor(rndD(0, 30)), 0.95))
                        c.line(px, py, px + cos(ang + s * 1.2) * 4, py + sin(ang + s * 1.2) * 4, width: 2.2)
                    }
                }
            }
        }
        spray(w * 0.5, h * 0.98, -.pi / 2, h * 0.9, 0)
        return c
    }

    init(rng: Seeded) {
        texture = GPU.shared.texture(Shrubs.sprayCanvas(), srgb: true)
        card = Geometry.plane(1, 1.2, 1, 3).translated(V3(0, 0.6, 0)).upload()
        // A unit-tall stem, stretched to each one's length.
        stem = Geometry.cylinder(top: 0.012, bottom: 0.035, height: 1, radialSegments: 6).upload()
        // Along the left beach, from the bay to the cliff foot, thicker near the water; the near
        // bank is bare rock, as the picture has it.
        let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
        var shrubs: [(x: Float, z: Float, h: Float, n: Int)] = []
        var z: Float = -56
        while z > -190 {
            defer { z -= R(3, 9) }
            let sx = shoreX(z)
            let x = sx - R(1.5, 12)
            if groundHeight(x, z) < 0.3 { continue }
            let h = R(1.2, 3.2)
            shrubs.append((x, z, h, Int(R(26, 60).rounded())))
        }
        var mats: [simd_float4x4] = []
        var stemList: [StdInstance] = []
        for s in shrubs {
            let base = groundHeight(s.x, s.z)
            for _ in 0..<4 {
                let a = rng() * TAU, lean = 0.25 + rng() * 0.35, L = s.h * (0.6 + rng() * 0.5)
                let q = quatAxis(a, 0, 1, 0) * quatAxis(lean, 1, 0, 0)
                let m = simd_float4x4(translation: V3(s.x, base, s.z)) * simd_float4x4(q)
                    * simd_float4x4(translation: V3(0, L / 2, 0)) * simd_float4x4(scale: V3(1, L, 1))
                stemList.append(StdInstance(model: m))
            }
            for _ in 0..<s.n {
                let a = rng() * TAU, r = pow(rng(), 0.6) * s.h * 0.55
                let y = base + 0.3 + rng() * s.h * 0.9 * (1 - r / (s.h * 0.7))
                let size = 0.45 + rng() * 0.5
                let yaw = a + .pi / 2 + (rng() - 0.5) * 1.2
                let tilt = (rng() - 0.5) * 1.4 + (r / s.h) * 0.8
                mats.append(compose(V3(s.x + cos(a) * r, y, s.z + sin(a) * r), quatAxis(yaw, 0, 1, 0) * quatAxis(tilt, 1, 0, 0), V3(repeating: size)))
            }
        }
        count = mats.count
        instances = GPU.shared.buffer(mats)
        stemCount = stemList.count
        stems = GPU.shared.buffer(stemList)
    }

    func draw(_ ctx: DrawContext) {
        guard ctx.shows(Shrubs.layers), count > 0 else { return }
        let e = ctx.encoder
        // The cards: an alpha test at one half (the web version's alphaTest), in every pass.
        ctx.use("shrubVertex", "shrubFragment", shadowFragment: "shrubShadowFragment")
        e.setVertexBuffer(card.vertices, offset: 0, index: 0)
        e.setVertexBuffer(instances, offset: 0, index: 3)
        e.setFragmentTexture(texture, index: 3)
        e.drawIndexedPrimitives(type: .triangle, indexCount: card.count, indexType: .uint32, indexBuffer: card.indices,
                                indexBufferOffset: 0, instanceCount: count)
        // The stems cast no shadow (the web version leaves castShadow off on them).
        if ctx.isShadow || stemCount == 0 { return }
        Std.begin(ctx, vertex: "stdInstancedVertex")
        Std.draw(ctx, stem, StdParams(model: matrix_identity_float4x4, color: RGBA(hex: "#4a3028").linear, roughness: 0.9, flags: []),
                 instances: stems, count: stemCount)
    }
}

// MARK: - Blocks

/// Blocks and cobbles along the shore and the bank, in the rock material (darker than the land):
/// seen directly, in the reflection and under the water, and casting the moon's shadow.
final class Blocks {
    private let meshes: [GPUMesh]
    private var list: [(mesh: Int, model: simd_float4x4)] = []
    static let layers: Layers = [.main, .above, .below]

    /// A rounded box (a superellipsoid, `ratio` tall for its width), roughened, from a subdivided
    /// icosahedron with its vertices merged so it shades smoothly.
    private static func blockGeometry(_ seed: Double, _ ratio: Double, detail: Int = 4) -> MeshData {
        let soup = Geometry.icosahedron(radius: 1, detail: detail)
        // Merge the soup's repeated corners (three's mergeVertices), by position.
        var m = MeshData()
        var index: [SIMD3<Int32>: UInt32] = [:]
        for p in soup.positions {
            let key = SIMD3<Int32>(Int32((p.x * 1e4).rounded()), Int32((p.y * 1e4).rounded()), Int32((p.z * 1e4).rounded()))
            if let i = index[key] {
                m.indices.append(i)
            } else {
                let i = UInt32(m.positions.count)
                index[key] = i
                m.positions.append(p)
                m.uvs.append(.zero)
                m.indices.append(i)
            }
        }
        for i in m.positions.indices {
            let n = SIMD3<Double>(m.positions[i].normalized)
            let r = 1 / pow(pow(abs(n.x), 5) + pow(abs(n.y / ratio), 5) + pow(abs(n.z / 0.85), 5), 1.0 / 5)
            let rough = 1 + (fbm2(n.x * 2.5 + seed, n.y * 2.5 + n.z * 1.7 + seed * 3, 3) - 0.5) * 0.3
            m.positions[i] = V3(n * r * rough)
        }
        m.computeVertexNormals()
        return m
    }

    init(rng: Seeded) {
        meshes = [Blocks.blockGeometry(1.1, 0.6), Blocks.blockGeometry(3.7, 0.8), Blocks.blockGeometry(6.2, 0.5)].map { $0.upload() }
        let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
        func place(_ x: Float, _ z: Float, _ size: Float, _ yScale: Float) {
            let k = Int(rng() * Float(meshes.count))
            let y = groundHeight(x, z)
            let rx = R(-0.25, 0.25), ry = R(0, TAU), rz = R(-0.25, 0.25)
            let sz = size * R(0.8, 1.2)
            let model = simd_float4x4(translation: V3(x, y + size * yScale * 0.3, z)) * simd_float4x4(eulerXYZ: V3(rx, ry, rz))
                * simd_float4x4(scale: V3(size, size * yScale, sz))
            list.append((min(k, meshes.count - 1), model))
        }
        // The near bank: blocks and cobbles at the viewer's feet and at the frame edges.
        for _ in 0..<40 {
            let z = R(-20, 2), x = R(-16, 6 + z * 0.3)
            if hypot(x, z) < 1.5 || groundHeight(x, z) < 0.2 { continue }
            let size = R(0.15, 0.9), yScale = R(0.5, 0.8)
            place(x, z, size, yScale)
        }
        // Along the beach and at the cliff's foot: fallen blocks, bigger toward the cliff.
        for _ in 0..<70 {
            let z = R(-10, -190)
            let x = shoreX(z) - R(-1, 14)
            if groundHeight(x, z) < 0.1 { continue }
            let size = R(0.3, 1.5 + 2 * smoothstep(-60, -160, z)), yScale = R(0.5, 0.8)
            place(x, z, size, yScale)
        }
    }

    func draw(_ ctx: DrawContext, lights: RockLights) {
        guard ctx.shows(Blocks.layers) else { return }
        for b in list { Rock.draw(ctx, meshes[b.mesh], model: b.model, tint: 0.55, lights: lights, layers: Blocks.layers) }
    }
}

// MARK: - Dust and drops

/// Per-frame sprite buffers, one per frame in flight.
private struct PuffSprite { var p: V4; var a: V4 }

/// A small pool of sprites: dust thrown up where a stone lands on the shore, or (tinted brighter
/// than white) the spray of a splash and the drips off the craft, which fall and vanish at the
/// water. Seen directly and in the reflection.
final class Puffs {
    struct Particle { var pos: V3; var vel: V3; var age: Float; var life: Float; var size: Float }
    var p: [Particle] = []
    private let max: Int
    private let tint: V3
    private let buffers: [MTLBuffer]
    private let texture: MTLTexture = Puffs.blob
    static let layers: Layers = .surface
    private static let blob = GPU.shared.texture(Art.blob(128, hardness: 0.2), srgb: true)

    init(max: Int = 500, tint: V3 = V3(0.7, 0.45, 0.3)) {
        self.max = max
        self.tint = tint
        buffers = (0..<FrameRing.count).map { _ in GPU.shared.buffer(length: max * MemoryLayout<PuffSprite>.stride) }
    }

    /// Water drops rather than dust.
    private var isDrop: Bool { tint.x > 1.0 }

    func burst(at: V3, n: Int, size: Float, vel: V3? = nil) {
        let drop = isDrop
        var i = 0
        while i < n && p.count < max {
            i += 1
            let dir = V3(rnd(-1, 1), rnd(-0.3, 1), rnd(-1, 1)).normalized
            p.append(Particle(pos: at + dir * rnd(0, size * 0.3), vel: dir * (rnd(0.3, 1.6) * size) + (vel ?? .zero), age: 0,
                              life: drop ? rnd(0.8, 1.6) : rnd(2.5, 6) * (0.6 + size), size: (drop ? rnd(0.06, 0.14) : rnd(0.2, 0.5)) * size))
        }
    }

    func update(dt: Float) {
        let drop = isDrop
        var alive: [Particle] = []
        alive.reserveCapacity(p.count)
        for var q in p {
            q.age += dt
            if q.age > q.life { continue }
            q.vel *= exp(-dt * (drop ? 0.4 : 1.6))
            q.vel.y += (drop ? -9.81 : (0.05 - q.vel.y * 0.3)) * dt
            if drop && q.pos.y < 0.02 && q.vel.y < 0 { continue }
            q.pos += q.vel * dt
            alive.append(q)
        }
        p = alive
    }

    func draw(_ ctx: DrawContext) {
        guard ctx.shows(Puffs.layers), !ctx.isShadow, !p.isEmpty else { return }
        let drop = isDrop
        let buf = buffers[ctx.slot]
        let out = buf.contents().bindMemory(to: PuffSprite.self, capacity: max)
        let n = min(p.count, max)
        for i in 0..<n {
            let q = p[i]
            let f = q.age / q.life
            out[i] = PuffSprite(p: V4(q.pos, drop ? q.size : q.size * (1 + f * 2.5)),
                                a: V4((drop ? 0.9 : 0.45) * (1 - f) * smoothstep(0, 0.1, f), 0, 0, 0))
        }
        var t = V4(tint, 0)
        let e = ctx.encoder
        ctx.use("puffVertex", "puffFragment", blend: .alpha)
        e.setVertexBuffer(buf, offset: 0, index: 0)
        e.setVertexBytes(&t, length: 16, index: 2)
        e.setFragmentTexture(texture, index: 3)
        e.drawPrimitives(type: .point, vertexStart: 0, vertexCount: n)
    }
}

extension Shaders {
    static let shore = """

    // MARK: - Shrubs

    struct ShrubOut { float4 position [[position]]; float3 world; float3 normal; float2 uv; };

    /// The spray cards, swaying in the breeze, most at their tips.
    vertex ShrubOut shrubVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], device const float4x4* inst [[buffer(3)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float4x4 m = inst[iid];
        float3 g = a.xyz;
        float4 wpos = m * float4(0.0, 0.0, 0.0, 1.0);
        float ph = wpos.x * 1.3 + wpos.z * 0.9;
        float t = F.misc.x;
        float sway = sin(t * q(0.5) + ph) * 0.5 + sin(t * q(1.3) + ph * 2.0) * 0.3;
        float tip = clamp(g.y, 0.0, 1.0);
        g.x += sway * 0.08 * tip * tip * (0.3 + F.wind.z);
        g.z += sway * 0.05 * tip * tip * (0.3 + F.wind.z);
        float4 w = m * float4(g, 1.0);
        ShrubOut o;
        o.world = w.xyz;
        o.normal = transformNormal(m, b.xyz);
        o.uv = float2(a.w, b.w);
        o.position = F.viewProj * w;
        return o;
    }

    fragment float4 shrubFragment(ShrubOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                  texture2d<float> map [[texture(3)]], sampler rs [[sampler(1)]]) {
        float4 tex = map.sample(rs, tv(in.uv));
        if (tex.a < 0.5) discard_fragment();
        float3 n = normalize(in.normal);
        if (!front) n = -n;
        float3 c = standardLight(F, tex.rgb, n, in.world, 0.85, 0.0, float2(1.0), geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    fragment void shrubShadowFragment(ShrubOut in [[stage_in]], texture2d<float> map [[texture(3)]], sampler rs [[sampler(1)]]) {
        if (map.sample(rs, tv(in.uv)).a < 0.5) discard_fragment();
    }

    // MARK: - Dust and drops

    struct PuffIn { float4 p; float4 a; };
    struct PuffOut { float4 position [[position]]; float size [[point_size]]; float alpha; float3 color; float dist; };

    vertex PuffOut puffVertex(uint vid [[vertex_id]], device const PuffIn* sprites [[buffer(0)]], constant Frame& F [[buffer(1)]],
                              constant float4& tint [[buffer(2)]]) {
        PuffIn s = sprites[vid];
        float4 mv = F.view * float4(s.p.xyz, 1.0);
        float dist = length(mv.xyz);
        PuffOut o;
        // The web version sizes sprites at 900 pixels per metre at a metre (times the pixel ratio);
        // here the camera's own focal length in drawable pixels, which is about that.
        o.size = clamp(s.p.w * F.screen.z * 0.93 / dist, 1.0, 400.0);
        o.alpha = s.a.x;
        // Lit by the sky and a little by the moon.
        o.color = tint.xyz * (F.skyLight.xyz * 2.0 + F.moonColor.xyz * 0.3);
        o.dist = dist;
        o.position = F.proj * mv;
        return o;
    }

    fragment float4 puffFragment(PuffOut in [[stage_in]], float2 pc [[point_coord]], constant Frame& F [[buffer(0)]],
                                 texture2d<float> map [[texture(3)]], sampler cs [[sampler(1)]]) {
        float a = map.sample(cs, pc).a * in.alpha;
        if (a < 0.002) discard_fragment();
        return float4(applyFog(F, in.color, in.dist), a);
    }

    """
}
