import Metal
import simd

/// The simulated patch of water: 64 m square in front of the viewer. Beyond it, ripples are drawn
/// analytically (they are only a few pixels tall out there anyway).
let simOrigin = V2(-32, -64)
let simExtent: Float = 64
let maxSplats = 48
let maxRings = 24
/// The patch of bed the contact-occlusion map covers, in metres.
let aoRegion = (x0: Float(-30), z0: Float(-32), w: Float(60), d: Float(34))

/// Is a world point inside the simulated patch (with a margin inside the edge)?
func inSim(_ x: Float, _ z: Float, margin: Float = 0.5) -> Bool {
    x > simOrigin.x + margin && x < simOrigin.x + simExtent - margin && z > simOrigin.y + margin && z < simOrigin.y + simExtent - margin
}

/// Depth of the bed below the surface at distance -z out from the shore: shallows sloping gently
/// for fifteen metres, then the drop-off.
func bedDepth(_ z: Float) -> Float {
    let d = -z
    return 0.4 + 0.08 * min(d, 15) + 0.3 * max(min(d, 40) - 15, 0)
}

// MARK: - The wave simulation

/// The 2D wave equation on a float texture, ping-ponged each frame. Disturbances are "splats":
/// soft dents pressed into the surface (a fingertip, a stone, a trout's nose) that the equation
/// then spreads into rings. Wave speed is fixed at about 0.6 m/s, close to the group speed of the
/// centimetre ripples a stone makes on a pond, and the surface is damped so a ring fades over ten
/// seconds or so, as it would.
final class WaveSim {
    let size: Int
    private let dx: Float
    private let c: Float = 0.6
    private let dtFixed: Float = 1 / 60
    private var heights: [MTLTexture]
    private var cur = 0
    /// (slope x, slope z, height), filtered and mipmapped so far water averages many cells. Half
    /// floats are plenty for ripples a few millimetres high, and half the cost to mipmap each frame.
    let slopes: MTLTexture
    private var splats: [V4] = []
    private var steps = 0

    init(size: Int) {
        self.size = size
        dx = simExtent / Float(size)
        let dev = GPU.shared.device
        func texture(_ format: MTLPixelFormat, mips: Bool) -> MTLTexture {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: size, height: size, mipmapped: mips)
            d.usage = [.shaderRead, .shaderWrite]
            d.storageMode = .private
            return dev.makeTexture(descriptor: d)!
        }
        heights = [texture(.rg32Float, mips: false), texture(.rg32Float, mips: false)]
        slopes = texture(.rgba16Float, mips: true)
        // Start flat.
        if let cb = GPU.shared.queue.makeCommandBuffer(), let blit = cb.makeBlitCommandEncoder() {
            let zero = dev.makeBuffer(length: size * size * 16, options: .storageModePrivate)!
            blit.fill(buffer: zero, range: 0..<zero.length, value: 0)
            for t in heights + [slopes] {
                blit.copy(from: zero, sourceOffset: 0, sourceBytesPerRow: size * 8,
                          sourceBytesPerImage: size * size * 8, sourceSize: MTLSize(width: size, height: size, depth: 1),
                          to: t, destinationSlice: 0, destinationLevel: 0, destinationOrigin: MTLOrigin())
            }
            blit.endEncoding()
            cb.commit()
            cb.waitUntilCompleted()
        }
    }

    /// Press a dent into the water at world (x, z): `radius` in metres, `amount` in metres (negative is down).
    func splat(_ x: Float, _ z: Float, radius: Float, amount: Float) -> Bool {
        guard inSim(x, z, margin: 0.2) else { return false }
        if splats.count < maxSplats {
            splats.append(V4((x - simOrigin.x) / simExtent, (z - simOrigin.y) / simExtent, radius / simExtent, amount))
        }
        return true
    }

    /// Queue the water's advance by `dt`, in fixed sub-steps so the scheme stays stable.
    func advance(dt: Float) {
        steps += clamp(Int((dt / dtFixed).rounded()), 1, 4)
    }

    /// Encode the queued sub-steps (splats land on the first), then the slope map and its mipmaps.
    func encode(_ cb: MTLCommandBuffer) {
        let n = min(max(steps, 0), 4)
        steps = 0
        guard n > 0, let enc = cb.makeComputeCommandEncoder() else { splats.removeAll(); return }
        let gpu = GPU.shared
        let threads = MTLSize(width: 16, height: 16, depth: 1)
        let groups = MTLSize(width: (size + 15) / 16, height: (size + 15) / 16, depth: 1)
        var k = pow(c * dtFixed / dx, 2)
        var params = V4(k, 0.006, 0.06, 0)
        enc.setComputePipelineState(gpu.computePipeline("waveStep"))
        for s in 0..<n {
            let count = s == 0 ? splats.count : 0
            params.w = Float(count)
            var list = splats + [V4](repeating: .zero, count: maxSplats - splats.count)
            enc.setTexture(heights[cur], index: 0)
            enc.setTexture(heights[1 - cur], index: 1)
            enc.setBytes(&params, length: 16, index: 0)
            enc.setBytes(&list, length: maxSplats * 16, index: 1)
            enc.dispatchThreadgroups(groups, threadsPerThreadgroup: threads)
            cur = 1 - cur
        }
        splats.removeAll()
        k = 1 / (2 * dx)
        var inv = V4(k, 0, 0, 0)
        enc.setComputePipelineState(gpu.computePipeline("waveSlopes"))
        enc.setTexture(heights[cur], index: 0)
        enc.setTexture(slopes, index: 1)
        enc.setBytes(&inv, length: 16, index: 0)
        enc.dispatchThreadgroups(groups, threadsPerThreadgroup: threads)
        enc.endEncoding()
        if let blit = cb.makeBlitCommandEncoder() {
            blit.generateMipmaps(for: slopes)
            blit.endEncoding()
        }
    }
}

// MARK: - Rings beyond the simulated patch

/// A few analytic wave packets, each spreading from a point (a stone's last skip far out, a loon
/// surfacing, a trout rising across the lake).
final class Rings {
    private(set) var list: [(x: Float, z: Float, amp: Float, t0: Double)] = []
    private var now: Double = 0

    func add(_ x: Float, _ z: Float, amp: Float, time: Double) {
        list.append((x, z, amp, time))
        if list.count > maxRings { list.removeFirst() }
    }

    func update(time: Double) {
        now = time
        list.removeAll { time - $0.t0 >= 30 }
    }

    /// (x, z, age, amplitude) per ring, for the shader.
    var uniforms: [V4] {
        (0..<maxRings).map { i in i < list.count ? V4(list[i].x, list[i].z, Float(now - list[i].t0), list[i].amp) : V4(0, 0, -1000, 0) }
    }
}

// MARK: - The surface

/// The water: one big plane that samples a reflection of the shore and sky (from the mirrored
/// camera), a refraction of the bed and fish (with its depth), and the slope map plus wind
/// ripples, analytic rings and rain, then mixes them by Fresnel.
final class Water {
    private let mesh = Geometry.plane(9000, 9000, 64, 64)
        .transformed(simd_float4x4(translation: V3(0, 0, -4000)) * simd_float4x4(rotationX: -.pi / 2)).upload()

    /// `WaterParams` in the shaders.
    static let length = (16 + 4 + 4 * maxRings) * 4

    func write(into buffer: MTLBuffer, mirror: simd_float4x4, rings: Rings, sim: WaveSim) {
        var floats: [Float] = []
        for c in [mirror.columns.0, mirror.columns.1, mirror.columns.2, mirror.columns.3] { floats += [c.x, c.y, c.z, c.w] }
        floats += [simOrigin.x, simOrigin.y, simExtent, Float(rings.list.count)]
        for r in rings.uniforms { floats += [r.x, r.y, r.z, r.w] }
        floats.withUnsafeBytes { buffer.contents().copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
    }

    func draw(_ ctx: DrawContext, params: MTLBuffer, sim: WaveSim, reflection: MTLTexture, refraction: MTLTexture, depth: MTLTexture) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("waterVertex", "waterFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthWrite)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setVertexBuffer(params, offset: 0, index: 2)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentBuffer(params, offset: 0, index: 1)
        e.setFragmentTexture(reflection, index: 0)
        e.setFragmentTexture(refraction, index: 1)
        e.setFragmentTexture(depth, index: 2)
        e.setFragmentTexture(sim.slopes, index: 3)
        e.setFragmentSamplerState(gpu.postSampler, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 1)
        mesh.draw(e)
    }
}

// MARK: - The lake bed

/// Pebbles and sand sloping away from the shore, seen through the water near by, with caustics
/// from the ripples playing over it and contact shadows under everything that rests on it.
final class LakeBed {
    private let mesh: GPUMesh
    private let ao: MTLTexture

    init(ao: MTLTexture) {
        self.ao = ao
        let w: Float = 120, d: Float = 80, segs = 64
        var m = Geometry.plane(w, d, segs, segs).transformed(simd_float4x4(rotationX: -.pi / 2))
        for i in m.positions.indices {
            let z = m.positions[i].z - d / 2 + 2
            m.positions[i] = V3(m.positions[i].x, -bedDepth(min(z, -0.01)), z)
        }
        m.computeVertexNormals()
        mesh = m.upload()
    }

    func draw(_ ctx: DrawContext, sim: WaveSim) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("bedVertex", "bedFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthWrite)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        var p = V4(simOrigin.x, simOrigin.y, simExtent, 1 / Float(sim.size))
        e.setFragmentBytes(&p, length: 16, index: 1)
        e.setFragmentTexture(sim.slopes, index: 0)
        e.setFragmentTexture(ao, index: 1)
        e.setFragmentTexture(ctx.shadowMap, index: 2)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.setFragmentSamplerState(gpu.shadowSampler, index: 1)
        mesh.draw(e)
    }
}
