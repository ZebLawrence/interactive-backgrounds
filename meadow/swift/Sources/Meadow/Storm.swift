import CoreGraphics
import Metal
import simd

/// Storm mode: rain falling (and wrapping) through a box in front of the camera.
final class Rain {
    private let n = 2200
    private var positions: [V4]
    private let box = (x: Float(16), yTop: Float(9), zNear: Float(1), zFar: Float(-26))
    private let ring: FrameRing
    private let texture: MTLTexture
    private var opacity: Float = 0

    init() {
        positions = (0..<2200).map { _ in V4(rnd(-16, 16), rnd(-1, 9), rnd(-26, 1), 1) }
        ring = FrameRing(length: n * MemoryLayout<V4>.stride)
        texture = GPU.shared.texture(Art.streak(128), srgb: true)
    }

    func update(dt: Float, storm: Float, wind: Float, windDir: V2) {
        opacity = storm * 0.4
        guard storm > 0.01 else { return }
        let fall = 9 * dt, driftX = windDir.x * wind * 0.5 * dt, driftZ = windDir.y * wind * 0.5 * dt
        for i in 0..<n {
            var p = positions[i]
            p.x += driftX
            p.y -= fall
            p.z += driftZ
            if p.y < groundHeight(p.x, p.z) - 0.5 {
                p = V4(rnd(-box.x, box.x), box.yTop + rnd(0, 2), rnd(box.zFar, box.zNear), 1)
            }
            positions[i] = p
        }
    }

    func draw(_ ctx: DrawContext) {
        guard opacity > 0.004 else { return }
        let buf = ring[ctx.slot]
        positions.withUnsafeBytes { buf.contents().copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        let gpu = GPU.shared, e = ctx.encoder
        var params = V4(opacity, 0, 0, 0)
        e.setRenderPipelineState(gpu.pipeline("rainVertex", "rainFragment", blend: .additive, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(buf, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentBytes(&params, length: MemoryLayout<V4>.stride, index: 1)
        e.setFragmentTexture(texture, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawPrimitives(type: .point, vertexStart: 0, vertexCount: n)
    }
}

/// Lightning that forks down behind the trees: a bolt walked onto an image each strike, with a
/// flickering flash that every shader reads.
final class Lightning {
    private struct Strike { var t: Float; let bursts: [(Float, Float)] }

    /// For testing: the first strike comes after one second.
    static var strikeSoon = false

    private var texture: MTLTexture?
    private var timer = Lightning.strikeSoon ? 1 : rnd(2, 5)
    private var strike: Strike?
    private(set) var flash: Float = 0
    private var params = QuadParams(model: matrix_identity_float4x4, color: V4(2.2, 2.3, 2.8, 0))

    func update(dt: Float, storm: Float) {
        if var s = strike {
            s.t += dt
            var f: Float = 0
            for (t0, peak) in s.bursts where s.t >= t0 { f += peak * exp(-(s.t - t0) / 0.07) }
            flash = min(1, f)
            params.color.w = s.t < 0.4 ? min(1, f * 1.6) : 0
            strike = s
            if s.t > 1.2 { strike = nil; flash = 0; params.color.w = 0 }
        }
        guard storm >= 0.4 else { return }
        timer -= dt
        guard timer <= 0 else { return }
        timer = rnd(4, 15)
        texture = GPU.shared.texture(Lightning.bolt(), srgb: true, mipmaps: false)
        params.model = simd_float4x4(translation: V3(rnd(-80, 80), 60, -140)) * simd_float4x4(scale: V3(60, 120, 1))
        strike = Strike(t: 0, bursts: [(0, 1), (0.1 + rnd(0, 0.08), rnd(0.5, 0.9)), (0.25 + rnd(0, 0.15), rnd(0.2, 0.6))])
    }

    func draw(_ ctx: DrawContext) {
        guard params.color.w > 0.01, let texture else { return }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("quadVertex", "quadFragment", blend: .additive, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 0)
        e.setVertexBytes(&params, length: MemoryLayout<QuadParams>.stride, index: 1)
        e.setFragmentBytes(&params, length: MemoryLayout<QuadParams>.stride, index: 0)
        e.setFragmentTexture(texture, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }

    /// A forked bolt down a tall image.
    static func bolt() -> Canvas {
        let w = 512.0, h = 1024.0
        let c = Canvas(Int(w), Int(h))
        var paths: [(pts: [CGPoint], depth: Int)] = []
        func walk(_ x0: Double, _ y0: Double, _ len0: Int, _ spread: Double, _ depth: Int) {
            var x = x0, y = y0, len = len0
            var pts = [CGPoint(x: x, y: y)]
            var a = Double.pi / 2 + rndD(-0.3, 0.3)
            while y < h * (0.78 + Double(depth) * 0.05) && len > 0 {
                len -= 1
                a += rndD(-spread, spread)
                a = clamp(a, .pi / 2 - 1.1, .pi / 2 + 1.1)
                let step = rndD(14, 34)
                x += cos(a) * step
                y += sin(a) * step
                pts.append(CGPoint(x: x, y: y))
                if depth < 2 && chance(0.1) { walk(x, y, randInt(6, 18), spread * 1.3, depth + 1) }
            }
            paths.append((pts, depth))
        }
        walk(rndD(w * 0.3, w * 0.7), 0, 80, 0.5, 0)
        let ctx = c.ctx
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        let glow = RGBA.bytes(160, 180, 255, 1).cg
        for (width, color, blur) in [(18.0, RGBA.bytes(150, 170, 255, 0.35), 28.0), (6.0, RGBA.bytes(200, 215, 255, 0.8), 10.0), (2.2, RGBA(1, 1, 1), 0.0)] {
            // Canvas draws no shadow when the blur is 0.
            if blur > 0 { ctx.setShadow(offset: .zero, blur: blur, color: glow) } else { ctx.setShadow(offset: .zero, blur: 0, color: nil) }
            for (pts, depth) in paths {
                ctx.setLineWidth(width / (1 + Double(depth) * 0.8))
                c.stroke(color)
                ctx.beginPath()
                ctx.addLines(between: pts)
                ctx.strokePath()
            }
        }
        return c
    }
}
