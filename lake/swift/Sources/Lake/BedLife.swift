import CoreGraphics
import Metal
import simd

private let rockTints: [V3] = [V3(0.55, 0.53, 0.5), V3(0.6, 0.56, 0.5), V3(0.42, 0.43, 0.45), V3(0.5, 0.46, 0.4),
                               V3(0.36, 0.37, 0.39), V3(0.66, 0.63, 0.58), V3(0.47, 0.5, 0.47), V3(0.58, 0.58, 0.6)]

/// What lies on the lake bed under the near water: rocks and boulders, beds of pondweed swaying in
/// the slow current, and sunken branches. All of it is seen through the surface, so it is drawn in
/// the refraction pass, and all of it casts the key light's shadows.
final class BedLife {
    /// The contact-occlusion map: a dark soft ring around everything that sits on the bed.
    let aoTexture: MTLTexture
    private let rockMeshes: [GPUMesh]
    private let rockInstances: [MTLBuffer]
    private let rockCounts: [Int]
    private let rockTexture: MTLTexture
    private let weedTemplate: MTLBuffer
    private let weedIndices: MTLBuffer
    private let weedIndexCount: Int
    private let weeds: MTLBuffer
    private let weedCount: Int
    private let logs: GPUMesh
    private let barkTexture: MTLTexture

    init(halfWidth: (Float) -> Float, stems: [(x: Float, z: Float, r: Float)]) {
        let ao = Canvas(2048, Int((2048 * aoRegion.d / aoRegion.w).rounded()))
        ao.fill(RGBA(1, 1, 1))
        ao.fillRect(0, 0, Double(ao.width), Double(ao.height))
        let px = Double(2048 / aoRegion.w)
        func contact(_ x: Float, _ z: Float, _ r: Float, _ strength: Double) {
            let cx = Double(x - aoRegion.x0) * px, cy = Double(aoRegion.z0 + aoRegion.d - z) * px
            let R = Double(r) * px
            let centre = CGPoint(x: cx, y: cy)
            ao.clipped(CGRect(x: cx - R * 1.7, y: cy - R * 1.7, width: R * 3.4, height: R * 3.4)) {
                ao.radialGradient(centre, R * 0.6, centre, R * 1.7,
                                  [(0, RGBA(0, 0, 0, strength)), (0.45, RGBA(0, 0, 0, strength * 0.45)), (1, RGBA(0, 0, 0, 0))])
            }
        }
        for s in stems { contact(s.x, s.z, s.r, 0.35) }
        func hw(_ z: Float) -> Float { halfWidth(-z) * 1.05 + 1 }
        func onBed(_ z: Float) -> Float { -bedDepth(min(z, -0.01)) }
        let gpu = GPU.shared

        // Rocks: a scatter of cobbles, a few boulders, denser in the shallows.
        rockTexture = gpu.texture(BedLife.rockImage(), srgb: true)
        var groups: [[StdInstance]] = [[], [], []]
        for k in 0..<220 {
            let z = -1.2 - pow(Float.random(in: 0..<1), 1.3) * 24
            let x = rnd(-1, 1) * hw(z)
            // Boulders only farther out, where they do not fill the bottom of the frame.
            let boulder = z < -6 && chance(0.07)
            let s = boulder ? rnd(0.28, 0.5) : rnd(0.04, 0.2)
            contact(x, z, s * 1.05, boulder ? 0.75 : 0.6)
            let sy = s * rnd(0.5, 0.8), sx = s * rnd(0.8, 1.3), sz = s * rnd(0.8, 1.3)
            let model = simd_float4x4(translation: V3(x, onBed(z) + sy * 0.3, z))
                * simd_float4x4(eulerXYZ: V3(rnd(-0.15, 0.15), rnd(0, TAU), rnd(-0.15, 0.15))) * simd_float4x4(scale: V3(sx, sy, sz))
            let tint = rockTints.randomElement()! * rnd(0.8, 1.1)
            let linear = RGBA(Double(tint.x), Double(tint.y), Double(tint.z)).linear
            groups[k % 3].append(StdInstance(model: model, color: V4(linear, 1)))
        }
        rockMeshes = (0..<3).map { BedLife.rockGeometry(seed: Double($0) * 7.3 + 1).upload() }
        rockInstances = groups.map { gpu.buffer($0) }
        rockCounts = groups.map(\.count)

        // Pondweed: ribbons of eelgrass in beds, never taller than the water over them, swaying in
        // the slow drift along the shore. (base xyz, height), (width, yaw, phase, tone).
        var blades: [V4] = []
        for _ in 0..<26 {
            let z = -rnd(2, 20), x = rnd(-0.9, 0.9) * hw(z), r = rnd(0.5, 1.6)
            let count = Int(rnd(18, 50).rounded())
            let tone = Float.random(in: 0..<1)
            contact(x, z, r * 0.8, 0.18)
            for _ in 0..<count {
                let a = rnd(0, TAU), d = Float.random(in: 0..<1).squareRoot() * r
                let bx = x + cos(a) * d, bz = z + sin(a) * d
                let h = min(rnd(0.3, 1.1), bedDepth(min(bz, -0.01)) * rnd(0.55, 0.9))
                blades += [V4(bx, onBed(bz), bz, h), V4(rnd(0.008, 0.016), rnd(0, TAU), rnd(0, TAU), clamp(tone + rnd(-0.2, 0.2), 0, 1))]
            }
        }
        let rows = 10
        var tmpl: [V2] = [], idx: [UInt16] = []
        for r in 0...rows {
            let t = Float(r) / Float(rows)
            tmpl += [V2(-0.5, t), V2(0.5, t)]
        }
        for r in 0..<rows {
            let a = UInt16(r * 2)
            idx += [a, a + 1, a + 2, a + 1, a + 3, a + 2]
        }
        weedTemplate = gpu.buffer(tmpl)
        weedIndices = gpu.buffer(idx)
        weedIndexCount = idx.count
        weeds = gpu.buffer(blades)
        weedCount = blades.count / 2

        // Sunken branches: a few waterlogged limbs lying on the bed with stubs of side branches.
        barkTexture = gpu.texture(BedLife.barkImage(), srgb: true)
        var wood: [MeshData] = []
        for k in 0..<4 {
            let z = -rnd(3, 18), x = rnd(-0.8, 0.8) * hw(z)
            let len = rnd(1.2, 3.2), yaw = rnd(0, TAU), r = rnd(0.05, 0.11)
            let dir = V3(cos(yaw), 0, sin(yaw))
            let pts: [V3] = (0...4).map { i in
                let t = Float(i) / 4 - 0.5
                var p = V3(x, 0, z) + dir * (t * len)
                p.y = onBed(p.z) + r * 0.6 + sin(t * 3 + Float(k)) * r * 0.3
                p.x += sin(t * 5 + Float(k) * 2) * len * 0.04
                return p
            }
            let curve = Curve3(pts)
            wood.append(Geometry.tube(curve, tubularSegments: 24, radius: r, radialSegments: 10))
            for i in 0...8 {
                let q = curve.pointAt(Float(i) / 8)
                contact(q.x, q.z, r * 1.2, 0.55)
            }
            // Stubs.
            var s = Int(floor(rnd(2, 5)))
            while s > 0 {
                let at = curve.pointAt(rnd(0.15, 0.85))
                let a = rnd(0, TAU), up = rnd(0.2, 1.0)
                let sdir = V3(cos(a) * (1 - up), up, sin(a) * (1 - up)).normalized
                let slen = rnd(0.15, 0.5)
                let stub = Curve3([at, at + sdir * (slen * 0.5), at + sdir * slen + V3(0, slen * 0.1, 0)])
                wood.append(Geometry.tube(stub, tubularSegments: 6, radius: r * 0.35, radialSegments: 7))
                s -= 1
            }
        }
        logs = MeshData.merged(wood).upload()
        aoTexture = gpu.texture(ao, srgb: false)
    }

    private var logParams: StdParams {
        StdParams(model: matrix_identity_float4x4, color: RGBA(hex: "#9a8a78").linear, roughness: 0.95, metalness: 0,
                  flags: [.map, .receiveShadow], uv: V4(1, 4, 0, 0))
    }

    private var rockParams: StdParams {
        StdParams(model: matrix_identity_float4x4, color: V3(1, 1, 1), roughness: 0.92, metalness: 0.02, flags: [.map, .receiveShadow])
    }

    func drawShadow(_ e: MTLRenderCommandEncoder) {
        for i in 0..<3 {
            Std.drawShadow(e, rockMeshes[i], rockParams, vertex: "stdInstancedShadowVertex", instances: rockInstances[i], count: rockCounts[i])
        }
        Std.drawShadow(e, logs, logParams)
        e.setRenderPipelineState(GPU.shared.shadowPipeline("weedShadowVertex"))
        e.setVertexBuffer(weedTemplate, offset: 0, index: 0)
        e.setVertexBuffer(weeds, offset: 0, index: 2)
        e.drawIndexedPrimitives(type: .triangle, indexCount: weedIndexCount, indexType: .uint16, indexBuffer: weedIndices,
                                indexBufferOffset: 0, instanceCount: weedCount)
    }

    func draw(_ ctx: DrawContext) {
        guard ctx.pass == .refraction else { return }
        Std.begin(ctx, vertex: "stdInstancedVertex")
        for i in 0..<3 {
            Std.draw(ctx, rockMeshes[i], rockParams, map: rockTexture, instances: rockInstances[i], count: rockCounts[i])
        }
        Std.begin(ctx)
        Std.draw(ctx, logs, logParams, map: barkTexture)
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("weedVertex", "weedFragment", samples: ctx.samples))
        e.setVertexBuffer(weedTemplate, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setVertexBuffer(weeds, offset: 0, index: 2)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: weedIndexCount, indexType: .uint16, indexBuffer: weedIndices,
                                indexBufferOffset: 0, instanceCount: weedCount)
    }

    // MARK: - Shapes and images

    /// A lumpy rock: an icosphere pushed about by noise, with a flattish underside, faceted.
    static func rockGeometry(seed: Double) -> MeshData {
        var g = Geometry.icosahedron(radius: 1, detail: 4)
        for i in g.positions.indices {
            let n = g.positions[i].normalized
            let nx = Double(n.x), ny = Double(n.y), nz = Double(n.z)
            let big = fbm2(nx * 1.6 + seed, ny * 1.6 + nz * 1.1 + seed * 2, 3) - 0.5
            let fine = fbm2(nx * 5 + nz * 3 + seed * 3, ny * 5 + seed, 3) - 0.5
            var r = Float(1 + big * 0.6 + fine * 0.12)
            // Sits on the bed: flatten the bottom.
            if n.y < -0.3 { r *= 1 - (-0.3 - n.y) * 0.5 }
            g.positions[i] = n * r
        }
        g.computeVertexNormals()
        return g
    }

    /// Granite speckle with a few darker veins, tileable enough for small stones.
    static func rockImage() -> Canvas {
        let size = 512
        let c = Canvas(size, size)
        let tau = Double.pi * 2
        c.setPixels { x, y in
            let a = Double(x) / Double(size) * tau, b = Double(y) / Double(size) * tau
            let nx = cos(a) * 2, ny = sin(a) * 2, nz = cos(b) * 2, nw = sin(b) * 2
            let n = fbm2(nx + nz * 0.7 + 3, ny + nw * 0.7, 4)
            let vein = abs(fbm2(nx * 1.5 + nw, ny * 1.5 + nz + 9, 3) - 0.5)
            let grain = hash2(Double(x), Double(y))
            var v = 0.55 + 0.3 * n - 0.25 * max(0, 0.06 - vein) / 0.06 + (grain - 0.5) * 0.25
            // Feldspar flecks.
            if grain > 0.985 { v += 0.3 }
            return (v * 255, (v - 0.02) * 255, (v - 0.05) * 255)
        }
        return c
    }

    /// Bark: vertical ridges and furrows.
    static func barkImage() -> Canvas {
        let w = 256, h = 512
        let c = Canvas(w, h)
        let tau = Double.pi * 2
        c.setPixels { x, y in
            let a = Double(x) / Double(w) * tau
            let ridge = fbm2(cos(a) * 3 + 7, Double(y) / Double(h) * 6 + sin(a) * 3, 3)
            let fine = fbm2(cos(a) * 12, Double(y) / Double(h) * 40, 2)
            let v = (0.18 + 0.3 * ridge + 0.12 * fine) * 255
            return (v * 1.1, v * 0.85, v * 0.6)
        }
        return c
    }
}
