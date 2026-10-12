import CoreGraphics
import Metal

/// Long grass on the knoll in the foreground: instanced blades with a veined surface, bending in
/// the prevailing wind and easing into the cursor's gusts, lit low and warm by the rising sun,
/// casting and receiving its shadows. The blades move on the GPU; the CPU places them once.
final class Grass {
    private let template: MTLBuffer
    private let indices: MTLBuffer
    private let indexCount: Int
    private let instances: MTLBuffer
    let count: Int
    private let surface: MTLTexture

    /// The gust the grass feels, eased: (direction x, direction z) x strength.
    private var gustDir = V2.zero
    private(set) var gust = V4(1, 0, 0, 0)

    init(halfWidth: (Float) -> Float) {
        let gpu = GPU.shared
        // A blade: a strip of 4 quads narrowing to a point; x runs -0.5...0.5, y is t in 0...1.
        let rows = 4
        var tmpl: [V2] = [], idx: [UInt16] = []
        for r in 0...rows {
            let t = Float(r) / Float(rows)
            tmpl += [V2(-0.5, t), V2(0.5, t)]
        }
        for r in 0..<rows {
            let a = UInt16(r * 2), b = a + 1, c = a + 2, d = a + 3
            idx += [a, b, c, b, d, c]
        }
        template = gpu.buffer(tmpl)
        indices = gpu.buffer(idx)
        indexCount = idx.count

        // Blades thin out with distance, where they're too small to see anyway.
        let near: Float = 0.8, far: Float = 80
        var samples: [(d: Float, n: Float)] = []
        var sum: Float = 0
        var d = near
        while d < far {
            let density = 170 / (1 + pow(d / 7, 2))
            let n = density * 2 * halfWidth(d) * 0.25
            samples.append((d, n))
            sum += n
            d += 0.25
        }
        let total = Int(min(70000, sum.rounded()))
        var inst: [V4] = []
        inst.reserveCapacity(total * 2)
        var i = 0
        for s in samples {
            var k = Int((s.n * Float(total) / sum).rounded())
            while k > 0 && i < total {
                let d = s.d + rnd(0, 0.25)
                let hw = halfWidth(d) * 1.3 + 2
                let x = rnd(-hw, hw), z = -d
                let clump = 0.5 + 0.5 * sin(x * 0.7 + z * 0.5) * cos(x * 0.3 - z * 0.6)
                let h = rnd(0.35, 0.8) * (0.75 + 0.5 * clump) * (1 + d / 45)
                inst.append(V4(x, groundHeight(x, z) - 0.03, z, h))
                inst.append(V4(rnd(0.018, 0.036) * (1 + d / 35), rnd(0, TAU), rnd(0, TAU), Float.random(in: 0..<1)))
                k -= 1
                i += 1
            }
        }
        instances = gpu.buffer(inst)
        count = i
        surface = gpu.texture(Grass.surfaceImage(), srgb: false)
    }

    /// Ease toward the cursor's gust: it builds over a second or so and dies away more slowly.
    func update(dt: Float, dir: V3, strength: Float) {
        let target = V2(dir.x, dir.z) * strength
        let rate: Float = target.length > gustDir.length ? 1.6 : 0.6
        gustDir += (target - gustDir) * (1 - exp(-dt * rate))
        let s = gustDir.length
        let d = s > 1e-4 ? gustDir / s : V2(1, 0)
        gust = V4(d.x, d.y, s, 0)
    }

    private func bind(_ e: MTLRenderCommandEncoder, _ frame: MTLBuffer) {
        e.setVertexBuffer(template, offset: 0, index: 0)
        e.setVertexBuffer(instances, offset: 0, index: 1)
        e.setVertexBuffer(frame, offset: 0, index: 2)
    }

    func drawShadow(_ e: MTLRenderCommandEncoder, frame: MTLBuffer) {
        e.setRenderPipelineState(GPU.shared.shadowPipeline("bladeShadowVertex"))
        bind(e, frame)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint16, indexBuffer: indices,
                                indexBufferOffset: 0, instanceCount: count)
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("bladeVertex", "bladeFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthWrite)
        bind(e, ctx.frame)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(surface, index: 0)
        e.setFragmentTexture(ctx.shadowMap, index: 1)
        e.setFragmentSamplerState(gpu.repeatSampler, index: 0)
        e.setFragmentSamplerState(gpu.shadowSampler, index: 1)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint16, indexBuffer: indices,
                                indexBufferOffset: 0, instanceCount: count)
    }

    /// The surface of a blade, tiling along its length: a grooved midrib with raised edges, parallel
    /// veins that wander a little, and fine longitudinal streaks. Grey level is height; the shader
    /// reads it for colour and tilts the normal across the blade from its slope.
    static func surfaceImage() -> Canvas {
        let w = 128, h = 512
        let c = Canvas(w, h)
        let tau = Double.pi * 2
        c.setPixels { x, y in
            let ang = Double(y) / Double(h) * tau
            let streak = fbm2(Double(x) * 0.09, cos(ang) * 1.5, 3) * 0.6 + fbm2(Double(x) * 0.25 + 9, sin(ang) * 1.5 + 4, 2) * 0.4
            let v = (0.42 + 0.3 * streak) * 255
            return (v, v, v)
        }
        let W = Double(w), H = Double(h)
        c.ctx.setLineCap(.round)
        for k in -4...4 where k != 0 {
            let x0 = W / 2 + Double(k) * W * 0.1
            let odd = abs(k) % 2 == 1
            func path(_ dx: Double) {
                c.ctx.beginPath()
                c.ctx.move(to: CGPoint(x: x0 + dx + 1.5 * sin(Double(k)), y: 0))
                for y in stride(from: 8.0, through: H, by: 8) {
                    c.ctx.addLine(to: CGPoint(x: x0 + dx + 1.5 * sin(y / H * tau * 2 + Double(k)), y: y))
                }
            }
            c.stroke(RGBA(1, 1, 1, 0.55 + 0.3 * (odd ? 1 : 0)))
            c.ctx.setLineWidth(odd ? 2.2 : 3.0)
            path(0)
            c.ctx.strokePath()
            c.stroke(RGBA(0, 0, 0, 0.5))
            c.ctx.setLineWidth(1.6)
            path(2.4)
            c.ctx.strokePath()
        }
        c.fill(RGBA(0, 0, 0, 0.7))
        c.fillRect(W / 2 - 3.5, 0, 7, H)
        c.fill(RGBA(1, 1, 1, 0.8))
        c.fillRect(W / 2 - 6, 0, 2.5, H)
        c.fillRect(W / 2 + 3.5, 0, 2.5, H)
        return c
    }
}
