import CoreGraphics
import Foundation
import Metal
import simd

let skyRadius: Float = 7000

/// The quad pipeline's per-draw parameters (`QuadParams` in the shaders).
struct QuadParams {
    var model: simd_float4x4
    var color: V4
    var extra: V4 = .zero
}

// MARK: - Sky dome

/// The dawn gradient, the sun's disc and glow, cirrus blown across the upper sky, and at night a
/// dark blue vault full of stars, all in one shader on a big sphere.
final class Sky {
    private let mesh: GPUMesh

    init() {
        mesh = Geometry.sphere(radius: skyRadius, widthSegments: 64, heightSegments: 40).upload()
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("skyVertex", "skyFragment", samples: ctx.samples))
        // Drawn after the land, so only the sky that shows is shaded.
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        mesh.draw(e)
    }
}

// MARK: - Mountains

/// Three ridges on the horizon, each a silhouette dissolving into the haze.
final class Mountains {
    private struct Layer { let mask: MTLTexture; var params: QuadParams }
    private var layers: [Layer] = []

    init() {
        let specs: [(z: Float, w: Float, h: Float, seed: Double, rough: Double, tint: V3, maxFog: Float)] = [
            (-2600, 9000, 800, 1.3, 0.14, V3(0.07, 0.08, 0.15), 0.3),
            (-3900, 13000, 1300, 4.1, 0.09, V3(0.09, 0.1, 0.19), 0.5),
            (-5400, 17000, 2000, 8.7, 0.05, V3(0.11, 0.12, 0.22), 0.66),
        ]
        for L in specs {
            let model = simd_float4x4(translation: V3(0, L.h / 2 - L.h * 0.22, L.z)) * simd_float4x4(scale: V3(L.w, L.h, 1))
            layers.append(Layer(mask: GPU.shared.mask(Mountains.ridge(L.seed, L.rough)),
                                params: QuadParams(model: model, color: V4(L.tint, 1), extra: V4(L.maxFog, 0, 0, 0))))
        }
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("quadVertex", "ridgeFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthWrite)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        for layer in layers {
            var p = layer.params
            e.setVertexBytes(&p, length: MemoryLayout<QuadParams>.stride, index: 1)
            e.setFragmentBytes(&p, length: MemoryLayout<QuadParams>.stride, index: 1)
            e.setFragmentTexture(layer.mask, index: 0)
            e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
    }

    /// A ridge line: broad fbm peaks with finer roughness along the crest, filled below.
    static func ridge(_ seed: Double, _ roughness: Double) -> Canvas {
        let w = 4096.0, h = 512.0
        let c = Canvas(Int(w), Int(h), gray: true)
        c.fill(RGBA(0, 0, 0))
        c.fillRect(0, 0, w, h)
        c.fill(RGBA(1, 1, 1))
        let ctx = c.ctx
        ctx.beginPath()
        ctx.move(to: CGPoint(x: 0, y: h))
        for x in stride(from: 0.0, through: w, by: 2) {
            let t = x / w
            let big = fbm2(t * 5 + seed, seed * 1.7, 4)
            let fine = fbm2(t * 60 + seed * 3, seed, 4) - 0.5
            ctx.addLine(to: CGPoint(x: x, y: h * (0.78 - big * 0.55 - fine * roughness)))
        }
        ctx.addLine(to: CGPoint(x: w, y: h))
        ctx.fillPath()
        return c
    }
}

// MARK: - Mist

/// Banks of mist lying over the valley floor: huge soft sprites drifting slowly across it.
final class Mist {
    struct Sprite { var pos: V3; let size: V2; let base: Float; let rate: Float; var opacity: Float }

    private(set) var sprites: [Sprite] = []
    private let texture: MTLTexture
    private let instances: FrameRing
    static let count = 34

    init() {
        texture = GPU.shared.texture(Art.blob(256), srgb: true)
        instances = FrameRing(length: Mist.count * 2 * MemoryLayout<V4>.stride)
        for _ in 0..<Mist.count {
            let opacity = rnd(0.14, 0.3)
            let z = -rnd(260, 2400), x = rnd(-1, 1) * (300 - z * 0.6)
            let size = rnd(220, 620)
            sprites.append(Sprite(pos: V3(x, groundHeight(x, z) + rnd(15, 45), z), size: V2(size, size * rnd(0.12, 0.22)),
                                  base: opacity, rate: rnd(0.4, 1.2), opacity: opacity))
        }
    }

    func update(dt: Float, night: Float) {
        for i in sprites.indices {
            sprites[i].pos.x += sprites[i].rate * dt
            let limit = 300 - sprites[i].pos.z * 0.6
            if sprites[i].pos.x > limit + 300 { sprites[i].pos.x = -limit - 300 }
            sprites[i].opacity = sprites[i].base * (1 - night * 0.55)
        }
    }

    /// Fill this frame's instance buffer; `draw` then draws sprites one at a time, in the order given.
    func prepare(_ ctx: DrawContext) {
        let p = instances[ctx.slot].contents().assumingMemoryBound(to: V4.self)
        for (i, s) in sprites.enumerated() {
            p[i * 2] = V4(s.pos, s.opacity)
            p[i * 2 + 1] = V4(s.size.x, s.size.y, 0, 0)
        }
    }

    func draw(_ ctx: DrawContext, sprite i: Int) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("mistVertex", "mistFragment", blend: .alpha, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(instances[ctx.slot], offset: i * 2 * MemoryLayout<V4>.stride, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(texture, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }
}
