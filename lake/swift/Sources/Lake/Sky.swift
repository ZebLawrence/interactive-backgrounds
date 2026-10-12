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

/// Dusk twenty minutes after sunset (the afterglow, altostratus lit from below, Venus, the first
/// stars); at night a painted Milky Way, three star layers and the moon's halo; in rain a
/// scrolling grey ceiling. All in one shader on a big sphere.
final class Sky {
    private let mesh = Geometry.sphere(radius: skyRadius, widthSegments: 64, heightSegments: 40).upload()
    private let haze: MTLTexture

    init() {
        haze = GPU.shared.texture(Sky.milkyWay(), srgb: false)
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("skyVertex", "skyFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(haze, index: 0)
        e.setFragmentSamplerState(gpu.skySampler, index: 0)
        mesh.draw(e)
    }

    /// The Milky Way, painted once onto an equirectangular image: a glowing core, cooler arms,
    /// dust lanes and the great rift (the same approach as Firefly Meadow's sky).
    static func milkyWay(_ w: Int = 1536, _ h: Int = 768) -> Canvas {
        let n = simd_normalize(SIMD3<Double>(0.75, 0.6, 0.19))
        let t1 = simd_normalize(SIMD3<Double>(0, 0, -1) + n * n.z)
        let t2 = simd_cross(n, t1)
        let c = Canvas(w, h)
        c.setPixels { x, y in milkyWayPixel(x, y, w, h, n, t1, t2) }
        return c
    }
}

private func milkyWayPixel(_ x: Int, _ y: Int, _ w: Int, _ h: Int,
                           _ n: SIMD3<Double>, _ t1: SIMD3<Double>, _ t2: SIMD3<Double>) -> (Double, Double, Double) {
    let lat: Double = (0.5 - (Double(y) + 0.5) / Double(h)) * .pi
    let lon: Double = ((Double(x) + 0.5) / Double(w) - 0.5) * .pi * 2
    let d = SIMD3<Double>(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon))
    let b: Double = simd_dot(d, n)
    let along: Double = atan2(simd_dot(d, t2), simd_dot(d, t1))
    let core: Double = exp(-(b * b) / 0.012)
    let wide: Double = exp(-(b * b) / 0.09)
    let patches = fbm2(along * 1.3 + 2, b * 5 + 9, 3)
    let knots = fbm2(along * 3.5, b * 14 + 3, 4)
    var haze: Double = wide * 0.28 * (0.3 + patches) + core * (0.35 + 1.0 * knots * knots)
    let lanes = fbm2(along * 6 + 7, b * 26 + 1, 4)
    haze *= 1 - 0.85 * smoothstep(0.52, 0.7, lanes) * core
    let riftCentre: Double = 0.04 * sin(along * 2.2 + 1) + 0.02 * sin(along * 5.1)
    let rx: Double = (b - riftCentre) / 0.03
    let rift: Double = exp(-rx * rx) * (0.35 + 0.65 * fbm2(along * 4 + 5, 1.5, 3))
    haze *= 1 - 0.7 * rift
    let warmth: Double = core * (0.35 + 0.65 * patches)
    var r = lerp(0.62, 1.0, warmth), g = lerp(0.72, 0.9, warmth), bl = lerp(1.0, 0.72, warmth)
    let pink: Double = smoothstep(0.62, 0.8, fbm2(along * 3 + 11, b * 12 + 5, 3)) * core
    let teal: Double = smoothstep(0.64, 0.82, fbm2(along * 2.6 + 23, b * 10 + 17, 3)) * wide
    r += pink * 0.5; g -= pink * 0.15; bl += pink * 0.1
    g += teal * 0.35; bl += teal * 0.3; r -= teal * 0.15
    return (clamp(r * haze * 0.9, 0, 1) * 255, clamp(g * haze * 0.9, 0, 1) * 255, clamp(bl * haze * 0.9, 0, 1) * 255)
}

// MARK: - The moon

/// NASA's Lunar Reconnaissance Orbiter colour map on a sphere, with the LRO height map shading the
/// relief, lit by its own sun in the shader for a waxing gibbous. The maps are the ones Firefly
/// Meadow uses (NASA Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720).
final class Moon {
    private struct Params { var model: simd_float4x4; var sun: V4; var opacity: V4 }

    private let vertices: MTLBuffer
    private let indices: MTLBuffer
    private let indexCount: Int
    private let colorMap: MTLTexture?
    private let bumpMap: MTLTexture?
    private var params: Params

    init() {
        let distance = skyRadius * 0.97
        let radius = distance * tan(1.6 * .pi / 180)
        let m = Geometry.sphere(radius: radius, widthSegments: 96, heightSegments: 64)
        vertices = GPU.shared.buffer(m.positions.indices.flatMap { [V4(m.positions[$0], m.uvs[$0].x), V4(m.normals[$0], m.uvs[$0].y)] })
        indices = GPU.shared.buffer(m.indices)
        indexCount = m.indices.count
        colorMap = Assets.url("lroc_color_2k.jpg").flatMap { GPU.shared.load($0, srgb: true) }
        bumpMap = Assets.url("ldem_3_8bit.jpg").flatMap { GPU.shared.load($0, srgb: false) }
        let toViewer = -moonDir
        let right = moonDir.cross(V3(0, 1, 0)).normalized
        let sun = (right * 0.9 + toViewer * 0.5 + V3(0, 0.1, 0)).normalized
        params = Params(model: simd_float4x4(translation: moonDir * distance) * simd_float4x4(quatFromTo(V3(1, 0, 0), toViewer)),
                        sun: V4(sun, 0), opacity: .zero)
    }

    func draw(_ ctx: DrawContext, night: Float, rain: Float) {
        params.opacity.x = night * (1 - rain * 0.95)
        guard params.opacity.x > 0.01, let colorMap, let bumpMap else { return }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("moonVertex", "moonFragment", blend: .alpha, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setVertexBytes(&params, length: MemoryLayout<Params>.stride, index: 2)
        e.setFragmentBytes(&params, length: MemoryLayout<Params>.stride, index: 0)
        e.setFragmentTexture(colorMap, index: 0)
        e.setFragmentTexture(bumpMap, index: 1)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        // Only the near side: with depth writes off, the far hemisphere would draw over it.
        e.setCullMode(.back)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
        e.setCullMode(.none)
    }
}

/// The moon maps live once in the repository, in Firefly Meadow's `html/assets`; the app bundle
/// gets a copy (see build.sh).
enum Assets {
    static func url(_ name: String) -> URL? {
        let parts = name.split(separator: ".")
        if let u = Bundle.main.url(forResource: String(parts[0]), withExtension: String(parts[1])) { return u }
        // Running from the package (`swift run`): find the assets in the repository.
        let here = URL(fileURLWithPath: #filePath)
        let u = here.deletingLastPathComponent().appendingPathComponent("../../../../meadow/html/assets/\(name)").standardized
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
}

// MARK: - The shore

/// The far shore and the ridges beyond: alpha-tested silhouettes on planes, standing in the fog.
final class Shore {
    private struct Layer { let mask: MTLTexture; var params: QuadParams; let ridge: Bool }
    private var layers: [Layer] = []

    init(halfWidth: (Float) -> Float) {
        func plane(_ w: Float, _ h: Float, _ x: Float, _ y: Float, _ z: Float) -> simd_float4x4 {
            simd_float4x4(translation: V3(x, y, z)) * simd_float4x4(scale: V3(w, h, 1))
        }
        // The far shore: a wall of pines 260 m across the water.
        let farZ: Float = -260, farW = max(300, halfWidth(-farZ) * 2.4), farH: Float = 26
        layers.append(Layer(mask: GPU.shared.mask(Shore.pines(Double(farW), Double(farH), 8192 / Double(farW))),
                            params: QuadParams(model: plane(farW, farH, 0, farH / 2 - 0.02, farZ), color: V4(0.012, 0.022, 0.02, 0),
                                               extra: V4(0.002, 0.004, 0.006, 0.55)), ridge: false))
        // A wooded point running in from the left, nearer, so the shore has depth.
        let ptZ: Float = -120, ptW = halfWidth(-ptZ) * 1.1, ptH: Float = 22
        layers.append(Layer(mask: GPU.shared.mask(Shore.pines(Double(ptW), Double(ptH), 8192 / Double(ptW), dense: 1.2, taper: true)),
                            params: QuadParams(model: plane(ptW, ptH, -halfWidth(-ptZ) * 0.95 - ptW * 0.5 + ptW * 0.55, ptH / 2 - 0.02, ptZ),
                                               color: V4(0.008, 0.016, 0.014, 0), extra: V4(0.0015, 0.003, 0.005, 0.3)), ridge: false))
        // Ridges beyond, dissolving into the haze.
        let ridges: [(z: Float, w: Float, h: Float, seed: Double, rough: Double, tint: V3, night: V3, maxFog: Float)] = [
            (-1800, 7000, 520, 2.3, 0.12, V3(0.14, 0.13, 0.2), V3(0.004, 0.005, 0.01), 0.5),
            (-3000, 11000, 900, 5.1, 0.08, V3(0.2, 0.17, 0.26), V3(0.006, 0.007, 0.014), 0.68),
            (-4600, 16000, 1500, 9.7, 0.05, V3(0.26, 0.21, 0.3), V3(0.008, 0.009, 0.018), 0.8),
        ]
        for R in ridges {
            layers.append(Layer(mask: GPU.shared.mask(Shore.ridge(R.seed, R.rough)),
                                params: QuadParams(model: plane(R.w, R.h, 0, R.h / 2 - R.h * 0.2, R.z), color: V4(R.tint, 0),
                                                   extra: V4(R.night, R.maxFog)), ridge: true))
        }
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setDepthStencilState(gpu.depthWrite)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        for layer in layers {
            var p = layer.params
            e.setRenderPipelineState(gpu.pipeline("quadVertex", layer.ridge ? "ridgeFragment" : "silhouetteFragment", samples: ctx.samples))
            e.setVertexBytes(&p, length: MemoryLayout<QuadParams>.stride, index: 1)
            e.setFragmentBytes(&p, length: MemoryLayout<QuadParams>.stride, index: 1)
            e.setFragmentTexture(layer.mask, index: 0)
            e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
    }

    /// A shore of conifers drawn in metres, `W` x `H`, at `px` pixels per metre: trunks, drooping
    /// branches with needle tufts, the odd broadleaf and dead snag, over a rocky bank. `taper`
    /// thins it out over the last fifth, where the shore is a point running out into the lake.
    static func pines(_ W: Double, _ H: Double, _ px: Double, dense: Double = 1, taper: Bool = false) -> Canvas {
        let c = Canvas(Int((W * px).rounded()), Int((H * px).rounded()), gray: true)
        let ctx = c.ctx
        c.fill(RGBA(0, 0, 0))
        c.fillRect(0, 0, Double(c.width), Double(c.height))
        ctx.scaleBy(x: px, y: px)
        c.fill(RGBA(1, 1, 1))
        c.stroke(RGBA(1, 1, 1))
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        let tau = Double.pi * 2
        func line(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, _ w: Double) { c.line(x0, y0, x1, y1, width: w) }
        func standing(_ x: Double) -> Double { taper ? pow(max(0, min(1, (W * 0.96 - x) / (W * 0.22))), 0.8) : 1 }
        // The bank: boulders and a low shelf of rock at the waterline.
        func groundAt(_ x: Double) -> Double { H - (0.6 + fbm2(x / 30, 3.3, 3) * 1.6) * standing(x) }
        ctx.beginPath()
        ctx.move(to: CGPoint(x: 0, y: H + 1))
        for x in stride(from: 0.0, through: W, by: 0.5) { ctx.addLine(to: CGPoint(x: x, y: groundAt(x))) }
        ctx.addLine(to: CGPoint(x: W, y: H + 1))
        ctx.fillPath()
        var bx = 0.0
        while bx < W {
            if standing(bx) >= 0.05 {
                let g = groundAt(bx), r = rndD(0.3, 1.1) * (0.4 + 0.6 * standing(bx))
                c.fillEllipse(bx, g + r * 0.3, r * rndD(1, 1.8), r)
            }
            bx += rndD(1.5, 5)
        }
        func conifer(_ x: Double, _ base: Double, _ height: Double) {
            let fir = chance(0.35)
            let widest = fir ? 0.3 : 0.2
            let tilt = rndD(-0.03, 0.03)
            let top = base - height
            line(x, base, x + tilt * height, top, 0.1 + height * 0.014)
            var y = top + height * 0.05
            while y < base - height * 0.1 {
                let f = (y - top) / height
                let cx = x + tilt * (base - y)
                for side in [-1.0, 1.0] {
                    if chance(0.1) { continue }
                    let len = pow(f, fir ? 0.85 : 1.1) * widest * height * rndD(0.7, 1.15) * (chance(0.05) ? 1.3 : 1)
                    let droop = rndD(0.12, 0.5) * (0.4 + f)
                    let ex = cx + side * cos(droop) * len, ey = y + sin(droop) * len
                    line(cx, y, ex, ey, 0.03 + len * 0.03)
                    var s = 0.15
                    while s < len {
                        let px = cx + side * cos(droop) * s, py = y + sin(droop) * s
                        let tl = rndD(0.12, 0.32) * (0.5 + s / len)
                        line(px, py, px + side * rndD(-0.05, 0.1), py + tl, 0.03)
                        if chance(0.5) { line(px, py, px + side * rndD(0.05, 0.15), py + tl * 0.6, 0.025) }
                        s += rndD(0.1, 0.22)
                    }
                }
                y += rndD(0.22, 0.4)
            }
            for k in 0..<4 {
                let ty = top + Double(k) * 0.12
                line(x + tilt * height, ty, x + tilt * height + rndD(-0.15, 0.15), ty + rndD(0.05, 0.2), 0.025)
            }
        }
        func snag(_ x: Double, _ base: Double, _ height: Double) {
            func branch(_ bx: Double, _ by: Double, _ a: Double, _ len: Double, _ width: Double, _ depth: Int) {
                let ex = bx + cos(a) * len, ey = by + sin(a) * len
                line(bx, by, ex, ey, width)
                if depth == 0 { return }
                for _ in 0..<randInt(1, 3) { branch(ex, ey, a + rndD(-0.8, 0.8), len * rndD(0.5, 0.7), max(0.02, width * 0.6), depth - 1) }
            }
            branch(x, base, -.pi / 2 + rndD(-0.1, 0.1), height * 0.4, 0.12 + height * 0.012, 5)
        }
        func birch(_ x: Double, _ base: Double, _ height: Double) {
            let trunkH = height * rndD(0.35, 0.5)
            var ends: [(Double, Double, Double)] = []
            func limb(_ bx: Double, _ by: Double, _ a: Double, _ len: Double, _ width: Double, _ depth: Int) {
                let ex = bx + cos(a) * len, ey = by + sin(a) * len
                line(bx, by, ex, ey, width)
                if depth == 0 { ends.append((ex, ey, len)); return }
                for _ in 0..<randInt(2, 3) { limb(ex, ey, a + rndD(-0.6, 0.6), len * rndD(0.5, 0.7), width * 0.6, depth - 1) }
            }
            line(x, base, x + rndD(-0.1, 0.1), base - trunkH, 0.12 + height * 0.02)
            for _ in 0..<randInt(3, 4) { limb(x, base - trunkH, -.pi / 2 + rndD(-0.8, 0.8), height * rndD(0.2, 0.3), 0.06 + height * 0.008, 2) }
            for (lx, ly, len) in ends {
                let r = len * rndD(1.0, 1.6)
                for _ in 0..<Int((r * r * 50).rounded()) {
                    let a = rndD(0, tau), dd = pow(Double.random(in: 0..<1), 0.6) * r
                    c.dot(lx + cos(a) * dd, ly + sin(a) * dd * 0.85, rndD(0.06, 0.2) * (1.1 - 0.5 * dd / r))
                }
            }
        }
        var x = -4.0
        while x < W + 4 {
            let k = standing(x)
            // Toward the tip the trees thin out and shrink: a few small ones, then bare rock.
            if k >= 0.12 && Double.random(in: 0..<1) <= 0.3 + 0.7 * k {
                let base = groundAt(x) + rndD(0, 0.5)
                let height = rndD(9, 20) * (0.85 + 0.3 * fbm2(x / 60, 0.7, 2)) * (chance(0.06) ? 1.35 : 1) * (0.25 + 0.75 * k)
                let roll = Double.random(in: 0..<1)
                if roll < 0.78 { conifer(x, base, height) } else if roll < 0.86 { snag(x, base, height * 0.8) } else { birch(x, base, height * 0.75) }
            }
            x += rndD(0.7, 1.8) / dense
        }
        // Young trees and brush at the waterline.
        x = -2
        while x < W + 2 {
            if standing(x) > 0.1 { conifer(x, groundAt(x) + 0.4, rndD(1.5, 4) * (0.3 + 0.7 * standing(x))) }
            x += rndD(1, 3)
        }
        return c
    }

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
            ctx.addLine(to: CGPoint(x: x, y: h * (0.8 - big * 0.6 - fine * roughness)))
        }
        ctx.addLine(to: CGPoint(x: w, y: h))
        ctx.fillPath()
        return c
    }
}

// MARK: - Mist

/// Mist lying on the far water, drifting with the breeze.
final class Mist {
    private struct Sprite { var pos: V3; let size: V2; let base: Float; let rate: Float; var opacity: Float }

    private var sprites: [Sprite] = []
    private let texture: MTLTexture
    private let instances = FrameRing(length: 26 * 2 * MemoryLayout<V4>.stride * 2)
    private let halfWidth: (Float) -> Float

    init(halfWidth: @escaping (Float) -> Float) {
        self.halfWidth = halfWidth
        texture = GPU.shared.texture(Art.blob(256), srgb: true)
        for _ in 0..<26 {
            let opacity = rnd(0.05, 0.14)
            let z = -rnd(60, 240)
            let x = rnd(-1, 1) * halfWidth(-z) * 1.2
            let size = rnd(20, 70)
            sprites.append(Sprite(pos: V3(x, size * 0.06, z), size: V2(size, size * rnd(0.12, 0.2)), base: opacity, rate: rnd(0.3, 0.8), opacity: opacity))
        }
    }

    func update(dt: Float, night: Float, rain: Float, wind: V3) {
        for i in sprites.indices {
            var s = sprites[i]
            s.pos.x += wind.x * wind.z * s.rate * 0.6 * dt
            s.pos.z += wind.y * wind.z * s.rate * 0.2 * dt
            let lim = halfWidth(-s.pos.z) * 1.3
            if s.pos.x > lim { s.pos.x = -lim }
            if s.pos.x < -lim { s.pos.x = lim }
            if s.pos.z > -50 { s.pos.z = -240 }
            if s.pos.z < -250 { s.pos.z = -60 }
            s.opacity = s.base * (1 - night * 0.5) * (1 + rain * 0.8)
            sprites[i] = s
        }
    }

    /// The sprites, far to near, as instances in this frame's buffer (one region per pass).
    func draw(_ ctx: DrawContext, eye: V3) {
        let region = ctx.pass == .main ? 0 : 1
        let offset = region * sprites.count * 2 * MemoryLayout<V4>.stride
        let p = (instances[ctx.slot].contents() + offset).assumingMemoryBound(to: V4.self)
        for (i, s) in sprites.sorted(by: { $0.pos.distance(to: eye) > $1.pos.distance(to: eye) }).enumerated() {
            p[i * 2] = V4(s.pos, s.opacity)
            p[i * 2 + 1] = V4(s.size.x, s.size.y, 0, 0)
        }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("mistVertex", "mistFragment", blend: .alpha, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(instances[ctx.slot], offset: offset, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(texture, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: sprites.count)
    }
}

// MARK: - Rain

/// Streaks falling through a box around the viewer, wrapping as they go (the drops dimpling the
/// water are drawn in the water's shader).
final class Rain {
    private let points: MTLBuffer
    private let count = 2200
    private let texture: MTLTexture

    init() {
        var p: [V4] = []
        for _ in 0..<count { p.append(V4(rnd(-36, 36), rnd(0, 14), rnd(-40, 2), Float.random(in: 0..<1))) }
        points = GPU.shared.buffer(p)
        texture = GPU.shared.texture(Art.streak(128), srgb: true)
    }

    func draw(_ ctx: DrawContext, rain: Float) {
        guard rain > 0.005 else { return }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("rainVertex", "rainFragment", blend: .alpha, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(points, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(texture, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawPrimitives(type: .point, vertexStart: 0, vertexCount: count)
    }
}
