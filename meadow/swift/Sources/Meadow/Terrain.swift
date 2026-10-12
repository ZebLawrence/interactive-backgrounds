import Metal

/// What every part of the scene needs to draw itself into the frame.
struct DrawContext {
    let encoder: MTLRenderCommandEncoder
    /// The frame's shared uniforms (`Frame` in the shaders).
    let frame: MTLBuffer
    /// Multisample count of the scene pass (pipelines must match it).
    let samples: Int
    /// Which of the frames in flight this is, for per-frame buffers.
    let slot: Int
}

/// Height of the meadow at (x, z): gentle swells, sloping down a little toward the trees.
func groundHeight(_ x: Float, _ z: Float) -> Float {
    0.3 * sin(x * 0.11 + 1.3) * cos(z * 0.07 + 0.4)
        + 0.14 * sin(x * 0.31 + z * 0.17 + 2.0)
        + 0.05 * sin(z * 0.53 + x * 0.9)
        + 0.004 * z
}

/// A big displaced plane under the grass: dark soil and matted grass, moonlit and lit by fireflies.
final class Ground {
    private let vertices: MTLBuffer
    private let indices: MTLBuffer
    private let indexCount: Int
    private let soil: MTLTexture

    init() {
        let size: Float = 260, segs = 200
        var verts: [V4] = []
        verts.reserveCapacity((segs + 1) * (segs + 1) * 2)
        for j in 0...segs {
            let z = -size / 2 + size * Float(j) / Float(segs) - 70
            for i in 0...segs {
                let x = -size / 2 + size * Float(i) / Float(segs)
                // Smooth normal from the slope of the height field.
                let e: Float = 0.05
                let dx = (groundHeight(x + e, z) - groundHeight(x - e, z)) / (2 * e)
                let dz = (groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e)
                verts.append(V4(x, groundHeight(x, z), z, 1))
                verts.append(V4(V3(-dx, 1, -dz).normalized, 0))
            }
        }
        var idx: [UInt32] = []
        idx.reserveCapacity(segs * segs * 6)
        for j in 0..<segs {
            for i in 0..<segs {
                let a = UInt32(j * (segs + 1) + i), b = a + 1, c = a + UInt32(segs + 1), d = c + 1
                idx += [a, c, b, b, c, d]
            }
        }
        let gpu = GPU.shared
        vertices = gpu.buffer(verts)
        indices = gpu.buffer(idx)
        indexCount = idx.count
        soil = gpu.texture(Ground.soilImage(), srgb: true)
    }

    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        e.setRenderPipelineState(GPU.shared.pipeline("groundVertex", "groundFragment", samples: ctx.samples))
        e.setDepthStencilState(GPU.shared.depthWrite)
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(soil, index: 0)
        e.setFragmentSamplerState(GPU.shared.repeatSampler, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
    }

    /// Dark, mottled meadow soil and matted grass, tileable (noise sampled on a torus).
    static func soilImage(_ size: Int = 512) -> Canvas {
        let c = Canvas(size, size)
        let w = Double(size), h = Double(size), tau = Double.pi * 2
        c.setPixels { x, y in
            let a = Double(x) / w * tau, b = Double(y) / h * tau
            let nx = cos(a) * 3, ny = sin(a) * 3, nz = cos(b) * 3, nw = sin(b) * 3
            let n = fbm2(nx + nz * 0.7, ny + nw * 0.7, 4)
            let m = fbm2(nx * 3.1 + nw, ny * 3.1 + nz, 3)
            let g = 0.35 + 0.65 * n
            return ((22 + 30 * g + 12 * m).rounded(.towardZero), (40 + 55 * g + 14 * m).rounded(.towardZero),
                    (18 + 24 * g + 10 * m).rounded(.towardZero))
        }
        return c
    }
}
