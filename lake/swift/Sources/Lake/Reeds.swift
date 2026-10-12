import Metal
import simd

/// Somewhere a dragonfly may land: the top of a swaying stalk, or a lily pad.
struct Perch {
    let base: V3
    let h: Float
    let phase: Float
    let stiff: Float
    /// How far above the stalk's top the dragonfly sits (a cattail's spike is 21 cm).
    var top: Float = 0.21
}

/// Round an angular frequency to a whole number of cycles per hourly wrap (the shaders' `q`).
func quantize(_ w: Float) -> Float {
    let k = Float(timeWrap / (2 * Double.pi))
    return (w * k).rounded() / k
}

/// Cattails, bulrushes, sedge tussocks and reed grass standing in the shallows at the edges of the
/// view, swaying in the breeze. A cattail (Typha) is a round stalk topped by the brown velvet spike
/// with a thin spire above it, and a fan of long flat strap leaves arching out from the base. Their
/// tops are perches for the dragonflies. Everything is rooted on the lake bed and grows up through
/// the water, so the reeds appear in every pass.
final class Reeds {
    private enum Kind: Float { case grass = 0, stalk = 1, leaf = 2 }

    private(set) var perches: [Perch] = []
    /// Where stems meet the bed, for the contact-shadow map.
    private(set) var bases: [(x: Float, z: Float, r: Float)] = []
    let layers: Layers = [.main, .above, .below]

    private let bladeTemplate: MTLBuffer
    private let bladeIndices: MTLBuffer
    private let bladeIndexCount: Int
    private let blades: MTLBuffer
    private let bladeCount: Int
    private let headMesh: GPUMesh
    private let heads: MTLBuffer
    private let headCount: Int
    private let tuftMesh: GPUMesh
    private let tufts: MTLBuffer
    private let tuftCount: Int

    init(halfWidth: (Float) -> Float) {
        // Clumps run along both sides of the view from the shallows out to twenty-five metres, each a
        // mix of plants. The view is narrow close by, so the near ones hug the frame's edge.
        struct Clump { let x: Float; let z: Float; let r: Float; let n: Int; let mix: [(String, Float)] }
        var clumps: [Clump] = []
        for side: Float in [-1, 1] {
            for (z0, z1) in [(3.5, 5.5), (6, 8.5), (9, 12), (12.5, 15.5), (16, 19.5), (20, 26)] as [(Float, Float)] {
                let z = -rnd(z0, z1)
                let hw = halfWidth(-z)
                let near = -z < 9
                // Sedges crowd the near shallows, cattails and bulrushes stand farther out.
                clumps.append(Clump(x: side * (near ? hw * rnd(0.95, 1.25) + 0.5 : hw * rnd(0.6, 1.0)), z: z, r: rnd(1.0, near ? 1.8 : 3.0),
                                    n: Int(rnd(near ? 6 : 10, near ? 14 : 24).rounded()),
                                    mix: near ? [("cattail", 0.35), ("bulrush", 0.1), ("sedge", 0.3), ("grass", 0.25)]
                                        : [("cattail", 0.4), ("bulrush", 0.3), ("sedge", 0.1), ("grass", 0.2)]))
            }
        }
        func choose(_ mix: [(String, Float)]) -> String {
            var r = Float.random(in: 0..<1)
            for (k, p) in mix {
                r -= p
                if r <= 0 { return k }
            }
            return "grass"
        }

        // Blades: (base xyz, height), (width, yaw, phase, tone + 10 x kind), (arch, out x, out z, -).
        var inst: [V4] = []
        var headList: [V4] = [], tuftList: [V4] = []
        func blade(_ x: Float, _ z: Float, _ y: Float, _ h: Float, _ w: Float, _ yaw: Float, _ phase: Float, _ tone: Float, _ kind: Kind,
                   _ arch: Float, _ out: Float) {
            inst += [V4(x, y, z, h), V4(w, yaw, phase, tone + 10 * kind.rawValue), V4(arch, cos(out), sin(out), 0)]
        }
        for c in clumps {
            for _ in 0..<c.n {
                let a = rnd(0, TAU), d = Float.random(in: 0..<1).squareRoot() * c.r
                let x = c.x + cos(a) * d, z = c.z + sin(a) * d * 0.7
                let tone = Float.random(in: 0..<1)
                let phase = rnd(0, TAU)
                let bed = -bedDepth(min(z, -0.01))
                bases.append((x, z, 0.12))
                switch choose(c.mix) {
                case "cattail":
                    // A cattail: the stalk, its head, and four to six leaves fanning out from the base.
                    let h = rnd(1.4, 2.1) - bed
                    blade(x, z, bed, h, 0.011, rnd(0, TAU), phase, tone, .stalk, 0, 0)
                    headList += [V4(x, bed, z, h), V4(rnd(0.85, 1.25), phase, tone, 0)]
                    let leaves = Int(floor(rnd(4, 7)))
                    let yaw0 = rnd(0, TAU)
                    for k in 0..<leaves {
                        let out = yaw0 + Float(k) / Float(leaves) * TAU + rnd(-0.25, 0.25)
                        blade(x + cos(out) * 0.01, z + sin(out) * 0.01, bed, h * rnd(0.75, 1.15), rnd(0.013, 0.019), out + .pi / 2,
                              phase + Float(k), tone, .leaf, rnd(0.12, 0.4), out)
                    }
                    if chance(0.3) { perches.append(Perch(base: V3(x, bed, z), h: h, phase: phase, stiff: 0.6)) }
                case "bulrush":
                    // Bulrushes: two or three tall round stems close together, each with a drooping brown
                    // tuft of spikelets just below its tip, and no leaves to speak of.
                    var k = Int(floor(rnd(2, 4)))
                    while k > 0 {
                        let h = rnd(1.8, 2.7) - bed
                        let bx = x + rnd(-0.06, 0.06), bz = z + rnd(-0.06, 0.06)
                        blade(bx, bz, bed, h, 0.0075, rnd(0, TAU), phase + Float(k), 0.5 + tone * 0.5, .stalk, 0, 0)
                        tuftList += [V4(bx, bed, bz, h), V4(rnd(0.8, 1.3), phase + Float(k), tone, 0)]
                        if chance(0.15) { perches.append(Perch(base: V3(bx, bed, bz), h: h, phase: phase + Float(k), stiff: 0.6, top: 0.05)) }
                        k -= 1
                    }
                case "sedge":
                    // A sedge tussock: a dense mound of narrow blades arching out in every direction.
                    let n = Int(floor(rnd(14, 26)))
                    for k in 0..<n {
                        let out = rnd(0, TAU)
                        blade(x + cos(out) * rnd(0, 0.12), z + sin(out) * rnd(0, 0.12), bed, rnd(0.9, 1.5) - bed, rnd(0.004, 0.007),
                              out + .pi / 2, phase + Float(k) * 0.7, tone * 0.6, .leaf, rnd(0.3, 0.65), out)
                    }
                default:
                    // Reed grass: a few narrow blades together.
                    var k = Int(floor(rnd(2, 5)))
                    while k > 0 {
                        blade(x + rnd(-0.05, 0.05), z + rnd(-0.05, 0.05), bed, rnd(0.7, 1.5) - bed, rnd(0.008, 0.014), rnd(0, TAU),
                              phase + Float(k), tone, .grass, rnd(0, 0.08), rnd(0, TAU))
                        k -= 1
                    }
                }
            }
        }

        let gpu = GPU.shared
        // A strip of 8 quads; x runs -0.5...0.5, y is t in 0...1.
        let rows = 8
        var tmpl: [V2] = [], idx: [UInt16] = []
        for r in 0...rows {
            let t = Float(r) / Float(rows)
            tmpl += [V2(-0.5, t), V2(0.5, t)]
        }
        for r in 0..<rows {
            let a = UInt16(r * 2), b = a + 1, c = a + 2, d = a + 3
            idx += [a, b, c, b, d, c]
        }
        bladeTemplate = gpu.buffer(tmpl)
        bladeIndices = gpu.buffer(idx)
        bladeIndexCount = idx.count
        blades = gpu.buffer(inst)
        bladeCount = inst.count / 3

        // Heads: the cattail's velvet spike (a capsule 20 cm long) with the thin spire above it, and
        // the bulrush's tuft of spikelets drooping from just below the tip.
        let spike = Geometry.capsule(radius: 0.012, length: 0.19, capSegments: 4, radialSegments: 12).translated(V3(0, 0.012 + 0.095, 0))
        let spire = Geometry.cylinder(top: 0.0015, bottom: 0.0025, height: 0.16, radialSegments: 6).translated(V3(0, 0.214 + 0.08, 0))
        headMesh = MeshData.merged([spike, spire]).upload()
        var tuftParts = [Geometry.cylinder(top: 0.0025, bottom: 0.004, height: 0.08, radialSegments: 6).translated(V3(0, 0.04, 0))]
        for k in 0..<7 {
            let a = Float(k) / 7 * TAU + 0.4, r = 0.006 + 0.01 * Float(k % 3) / 2, drop = 0.012 + 0.025 * Float(k % 2)
            let at = V3(cos(a) * r, -drop, sin(a) * r)
            tuftParts.append(Geometry.capsule(radius: 0.0028, length: 0.012, capSegments: 3, radialSegments: 6)
                .transformed(simd_float4x4(translation: at) * simd_float4x4(rotationY: a) * simd_float4x4(rotationZ: 0.5 + 0.2 * Float(k % 3))))
            // The ray that carries the spikelet out from the stem.
            tuftParts.append(Geometry.cylinder(top: 0.0007, bottom: 0.0009, height: at.length, radialSegments: 5)
                .transformed(simd_float4x4(translation: at / 2) * simd_float4x4(quatFromTo(V3(0, 1, 0), at))))
        }
        tuftMesh = MeshData.merged(tuftParts).upload()
        heads = gpu.buffer(headList.isEmpty ? [V4.zero, V4.zero] : headList)
        headCount = headList.count / 2
        tufts = gpu.buffer(tuftList.isEmpty ? [V4.zero, V4.zero] : tuftList)
        tuftCount = tuftList.count / 2
    }

    /// Where the top of a perch stalk is right now (mirrors the shader's sway).
    func perchTop(_ perch: Perch, time: Float, wind: V3) -> V3 {
        let len = hypot(wind.x, wind.y)
        let wx = len > 0 ? wind.x / len : 1, wz = len > 0 ? wind.y / len : 0
        let along = perch.base.x * wx + perch.base.z * wz
        let wv = 0.6 + 0.3 * sin(time * quantize(0.35) - along * 0.4 + perch.phase) + 0.15 * sin(time * quantize(0.9) - along * 0.9 + perch.phase * 1.7)
        let lean = wind.z * wv * 0.14 * perch.stiff
        return V3(perch.base.x + wx * lean * perch.h, perch.base.y + perch.h + perch.top, perch.base.z + wz * lean * perch.h)
    }

    func drawShadow(_ e: MTLRenderCommandEncoder) {
        let gpu = GPU.shared
        e.setRenderPipelineState(gpu.shadowPipeline("reedShadowVertex"))
        e.setVertexBuffer(bladeTemplate, offset: 0, index: 0)
        e.setVertexBuffer(blades, offset: 0, index: 2)
        e.drawIndexedPrimitives(type: .triangle, indexCount: bladeIndexCount, indexType: .uint16, indexBuffer: bladeIndices,
                                indexBufferOffset: 0, instanceCount: bladeCount)
        e.setRenderPipelineState(gpu.shadowPipeline("reedHeadShadowVertex"))
        for (mesh, list, n) in [(headMesh, heads, headCount), (tuftMesh, tufts, tuftCount)] where n > 0 {
            e.setVertexBuffer(list, offset: 0, index: 2)
            e.setVertexBuffer(mesh.vertices, offset: 0, index: 0)
            e.drawIndexedPrimitives(type: .triangle, indexCount: mesh.count, indexType: .uint32, indexBuffer: mesh.indices,
                                    indexBufferOffset: 0, instanceCount: n)
        }
    }

    func draw(_ ctx: DrawContext) {
        guard layers.visible(in: ctx.pass) else { return }
        let gpu = GPU.shared, e = ctx.encoder
        e.setDepthStencilState(gpu.depthWrite)
        e.setRenderPipelineState(gpu.pipeline("reedVertex", "reedFragment", samples: ctx.samples))
        e.setVertexBuffer(bladeTemplate, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setVertexBuffer(blades, offset: 0, index: 2)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: bladeIndexCount, indexType: .uint16, indexBuffer: bladeIndices,
                                indexBufferOffset: 0, instanceCount: bladeCount)
        e.setRenderPipelineState(gpu.pipeline("reedHeadVertex", "reedHeadFragment", samples: ctx.samples))
        for (mesh, list, n, tuft) in [(headMesh, heads, headCount, Float(0)), (tuftMesh, tufts, tuftCount, Float(1))] where n > 0 {
            var t = V4(tuft, 0, 0, 0)
            e.setVertexBuffer(list, offset: 0, index: 2)
            e.setFragmentBytes(&t, length: 16, index: 1)
            e.setVertexBuffer(mesh.vertices, offset: 0, index: 0)
            e.drawIndexedPrimitives(type: .triangle, indexCount: mesh.count, indexType: .uint32, indexBuffer: mesh.indices,
                                    indexBufferOffset: 0, instanceCount: n)
        }
    }
}
