import CoreGraphics
import Foundation
import Metal
import simd

let skyRadius: Float = 480

/// A UV sphere laid out exactly like three.js's `SphereGeometry`, so texture coordinates match.
/// Returns (position, normal, uv) per vertex and triangle indices.
func sphereMesh(radius r: Float, widthSegments ws: Int, heightSegments hs: Int) -> (verts: [(V3, V3, V2)], indices: [UInt32]) {
    var verts: [(V3, V3, V2)] = []
    var grid: [[UInt32]] = []
    for iy in 0...hs {
        let v = Float(iy) / Float(hs)
        var row: [UInt32] = []
        for ix in 0...ws {
            let u = Float(ix) / Float(ws)
            let p = V3(-r * cos(u * TAU) * sin(v * .pi), r * cos(v * .pi), r * sin(u * TAU) * sin(v * .pi))
            verts.append((p, p.normalized, V2(u, 1 - v)))
            row.append(UInt32(verts.count - 1))
        }
        grid.append(row)
    }
    var idx: [UInt32] = []
    for iy in 0..<hs {
        for ix in 0..<ws {
            let a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1]
            if iy != 0 { idx += [a, b, d] }
            if iy != hs - 1 { idx += [b, c, d] }
        }
    }
    return (verts, idx)
}

/// The quad pipeline's per-draw parameters (`QuadParams` in the shaders).
struct QuadParams {
    var model: simd_float4x4
    var color: V4
    var extra: V4 = .zero
}

// MARK: - Sky dome

/// The Milky Way is painted once onto an equirectangular image (its glowing core, the cooler outer
/// arms, layered dark dust lanes and a few tinted nebulae); the stars are hashed in the shader so
/// they stay crisp at any resolution, each with its own colour and size.
final class Sky {
    private let vertices: MTLBuffer
    private let indices: MTLBuffer
    private let indexCount: Int
    private let haze: MTLTexture

    init() {
        let (verts, idx) = sphereMesh(radius: skyRadius, widthSegments: 48, heightSegments: 32)
        vertices = GPU.shared.buffer(verts.map { V4($0.0, 1) })
        indices = GPU.shared.buffer(idx)
        indexCount = idx.count
        haze = GPU.shared.texture(Sky.milkyWay(), srgb: false)
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("skyVertex", "skyFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthNone)
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(haze, index: 0)
        e.setFragmentSamplerState(gpu.skySampler, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
    }

    static func milkyWay(_ w: Int = 1536, _ h: Int = 768) -> Canvas {
        // The plane of the galaxy, tilted so the band crosses the sky in front of the viewer, and a
        // basis in that plane to measure position along it.
        let n = SIMD3<Double>(0.6, 0.76, 0.24) / simd_length(SIMD3<Double>(0.6, 0.76, 0.24))
        let t1 = simd_normalize(SIMD3<Double>(0, 0, -1) + n * n.z)
        let t2 = simd_cross(n, t1)
        let c = Canvas(w, h)
        c.setPixels { x, y in milkyWayPixel(x, y, w, h, n, t1, t2) }
        return c
    }
}

/// One pixel of the Milky Way image (equirectangular; row 0 is the zenith).
private func milkyWayPixel(_ x: Int, _ y: Int, _ w: Int, _ h: Int,
                           _ n: SIMD3<Double>, _ t1: SIMD3<Double>, _ t2: SIMD3<Double>) -> (Double, Double, Double) {
    let lat: Double = (0.5 - (Double(y) + 0.5) / Double(h)) * .pi
    let cl = cos(lat), sl = sin(lat)
    let lon: Double = ((Double(x) + 0.5) / Double(w) - 0.5) * .pi * 2
    let d = SIMD3<Double>(cl * cos(lon), sl, cl * sin(lon))
    let b: Double = simd_dot(d, n)
    let along: Double = atan2(simd_dot(d, t2), simd_dot(d, t1))
    let core: Double = exp(-(b * b) / 0.012)
    let wide: Double = exp(-(b * b) / 0.09)
    // Mottled brightness along the band, big patches and finer knots.
    let patches = fbm2(along * 1.3 + 2, b * 5 + 9, 3)
    let knots = fbm2(along * 3.5, b * 14 + 3, 4)
    var haze: Double = wide * 0.28 * (0.3 + patches)
    haze += core * (0.35 + 1.0 * knots * knots)
    // Dust: dark lanes threaded through the core, and the great rift down its middle.
    let lanes = fbm2(along * 6 + 7, b * 26 + 1, 4)
    haze *= 1 - 0.85 * smoothstep(0.52, 0.7, lanes) * core
    let riftCentre: Double = 0.04 * sin(along * 2.2 + 1) + 0.02 * sin(along * 5.1)
    let riftX: Double = (b - riftCentre) / 0.03
    let rift: Double = exp(-riftX * riftX) * (0.35 + 0.65 * fbm2(along * 4 + 5, 1.5, 3))
    haze *= 1 - 0.7 * rift
    // Colour: a warm bulge, cooler blue-white arms, with pink and teal nebulae here and there.
    let warmth: Double = core * (0.35 + 0.65 * patches)
    var r = lerp(0.62, 1.0, warmth), g = lerp(0.72, 0.9, warmth), bl = lerp(1.0, 0.72, warmth)
    let pink: Double = smoothstep(0.62, 0.8, fbm2(along * 3 + 11, b * 12 + 5, 3)) * core
    let teal: Double = smoothstep(0.64, 0.82, fbm2(along * 2.6 + 23, b * 10 + 17, 3)) * wide
    r += pink * 0.5; g -= pink * 0.15; bl += pink * 0.1
    g += teal * 0.35; bl += teal * 0.3; r -= teal * 0.15
    let k: Double = haze * 0.9 * 255
    return (clamp(r * k, 0, 255), clamp(g * k, 0, 255), clamp(bl * k, 0, 255))
}

// MARK: - Moon

/// A sphere wrapped in NASA's Lunar Reconnaissance Orbiter colour map, with its height map as a
/// bump map, lit by its own sun so the phase and the relief along the terminator are real.
/// (Maps: NASA's Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720.)
final class Moon {
    private struct Params {
        var model: simd_float4x4
        var sunDir: V4
        var sunColor: V4
        var ambient: V4
        var params: V4
    }

    private let vertices: MTLBuffer
    private let indices: MTLBuffer
    private let indexCount: Int
    private let colorMap: MTLTexture?
    private let heightMap: MTLTexture?
    private var params: Params

    init(direction dir: V3) {
        let distance = skyRadius * 0.98
        let radius = distance * tan(1.55 * .pi / 180)
        let (verts, idx) = sphereMesh(radius: radius, widthSegments: 96, heightSegments: 64)
        vertices = GPU.shared.buffer(verts.flatMap { [V4($0.0, $0.2.x), V4($0.1, $0.2.y)] })
        indices = GPU.shared.buffer(idx)
        indexCount = idx.count
        colorMap = Assets.url("lroc_color_2k.jpg").flatMap { GPU.shared.load($0, srgb: true) }
        heightMap = Assets.url("ldem_3_8bit.jpg").flatMap { GPU.shared.load($0, srgb: false) }

        // Turn the near side (the middle of the map, on the sphere's +x) to face the viewer.
        let toViewer = -dir
        let model = simd_float4x4(translation: dir * distance) * simd_float4x4(quatFromTo(V3(1, 0, 0), toViewer))
        // The moon's sun: off to the right and a little toward us, for a waxing gibbous.
        let right = dir.cross(V3(0, 1, 0)).normalized
        let sunDir = (right * 0.9 + toViewer * 0.55 + V3(0, 0.12, 0)).normalized
        // DirectionalLight(0xf8f8ff, 4.6), bright enough to spill a little into the bloom; and a
        // whisper of earthshine (AmbientLight(0x6f7fb0, 0.06)) on the dark side.
        let sun = RGBA(hex: "#f8f8ff").linear * 4.6
        let earthshine = RGBA(hex: "#6f7fb0").linear * 0.06
        params = Params(model: model, sunDir: V4(sunDir, 0), sunColor: V4(sun, 0), ambient: V4(earthshine, 0), params: V4(1, 0.35, 0, 0))
    }

    /// Fade with the moonlight setting and hide behind storm clouds.
    func update(moon: Float, storm: Float) {
        params.params.x = clamp(moon * (1 - storm), 0, 1)
    }

    func draw(_ ctx: DrawContext) {
        guard params.params.x > 0.01, let colorMap, let heightMap else { return }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("moonVertex", "moonFragment", blend: .alpha, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setCullMode(.back)
        e.setFrontFacing(.counterClockwise)
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setVertexBytes(&params, length: MemoryLayout<Params>.stride, index: 2)
        e.setFragmentBytes(&params, length: MemoryLayout<Params>.stride, index: 0)
        e.setFragmentTexture(colorMap, index: 0)
        e.setFragmentTexture(heightMap, index: 1)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
        e.setCullMode(.none)
    }
}

/// The moon maps live once in the repository, in the web version's `html/assets`; the app bundle
/// gets a copy (see build.sh).
enum Assets {
    static func url(_ name: String) -> URL? {
        let parts = name.split(separator: ".")
        if let u = Bundle.main.url(forResource: String(parts[0]), withExtension: String(parts[1])) { return u }
        // Running from the package (`swift run`): find the web assets next to this source file.
        let here = URL(fileURLWithPath: #filePath)
        let u = here.deletingLastPathComponent().appendingPathComponent("../../../html/assets/\(name)").standardized
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
}

// MARK: - Shooting stars

/// A streak that crosses a few degrees of sky in half a second, now and then.
final class Meteors {
    private struct Active {
        let start: V3, dir: V3
        var t: Float
        let duration: Float, travel: Float, length: Float, width: Float
    }

    private let texture: MTLTexture
    private var timer = rnd(4, 10)
    private var active: Active?
    private var params = QuadParams(model: matrix_identity_float4x4, color: V4(1.6, 1.7, 2.0, 0))

    init() {
        let c = Canvas(256, 16)
        c.linearGradient(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 256, y: 0),
                         [(0, RGBA(1, 1, 1, 0)), (0.75, RGBA(1, 1, 1, 0.5)), (1, RGBA(1, 1, 1, 1))])
        c.ctx.setBlendMode(.destinationOut)
        c.linearGradient(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: 16),
                         [(0, RGBA(0, 0, 0, 1)), (0.5, RGBA(0, 0, 0, 0)), (1, RGBA(0, 0, 0, 1))])
        texture = GPU.shared.texture(c, srgb: true)
    }

    func update(dt: Float, storm: Float) {
        if var a = active {
            a.t += dt
            let k = a.t / a.duration
            if k >= 1 { active = nil; return }
            active = a
            let head = (a.start + a.dir * (a.travel * k)).normalized * (skyRadius * 0.97)
            let tangent = (a.dir - head * (a.dir.dot(head) / head.lengthSquared)).normalized
            let normal = (-head).normalized
            let side = tangent.cross(normal).normalized
            params.model = simd_float4x4(basisX: tangent, y: side, z: normal, position: head - tangent * (a.length / 2))
                * simd_float4x4(scale: V3(a.length, a.width, 1))
            params.color.w = sin(k * .pi) * 0.9
            return
        }
        timer -= dt
        if timer > 0 || storm > 0.3 { return }
        timer = rnd(7, 22)
        // Start high in the sky in front of the viewer, heading down at a shallow angle.
        let az = rnd(-1.1, 1.1), el = rnd(0.35, 0.9)
        let start = V3(sin(az) * cos(el), sin(el), -cos(az) * cos(el))
        let dir = V3(rnd(-1, 1), rnd(-0.9, -0.3), rnd(-0.4, 0.4)).normalized
        active = Active(start: start, dir: dir, t: 0, duration: rnd(0.35, 0.6), travel: rnd(0.06, 0.12),
                        length: rnd(14, 30), width: rnd(0.5, 0.9))
    }

    func draw(_ ctx: DrawContext) {
        guard active != nil else { return }
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
}

// MARK: - The horizon

/// A dark tree line standing in the fog, and hills beyond it. The trees are drawn in metres onto
/// a mask fine enough (about 45 px per metre) to stay sharp on a 4K display, with real structure:
/// trunks, drooping branches with needle tufts, forking limbs, clumped leaves.
final class Horizon {
    private let trees: MTLTexture
    private let hills: MTLTexture
    private var treeParams: QuadParams
    private var hillParams: QuadParams

    init(halfWidth: (Float) -> Float) {
        // The tree line only needs to span what the camera can see at its distance.
        let treeZ: Float = -90, treeW = max(120, halfWidth(-treeZ) * 2.3), treeH: Float = 40
        let px = 8192 / Double(treeW)
        trees = GPU.shared.mask(Horizon.treeLine(Double(treeW), Double(treeH), px))
        hills = GPU.shared.mask(Horizon.hillsImage())
        treeParams = QuadParams(model: simd_float4x4(translation: V3(0, treeH / 2 - 1, treeZ)) * simd_float4x4(scale: V3(treeW, treeH, 1)),
                                color: V4(0.004, 0.009, 0.006, 1), extra: V4(1, 0, 0, 0))
        hillParams = QuadParams(model: simd_float4x4(translation: V3(0, 20 - 3, -150)) * simd_float4x4(scale: V3(640, 40, 1)),
                                color: V4(0, 0, 0, 1), extra: V4(0, 0, 0, 0))
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("quadVertex", "silhouetteFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthWrite)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        for (tex, p) in [(hills, hillParams), (trees, treeParams)] {
            var params = p
            e.setVertexBytes(&params, length: MemoryLayout<QuadParams>.stride, index: 1)
            e.setFragmentBytes(&params, length: MemoryLayout<QuadParams>.stride, index: 1)
            e.setFragmentTexture(tex, index: 0)
            e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        }
    }

    /// The tree line, `W` metres wide and `H` tall, drawn in metre units at `px` pixels per metre.
    static func treeLine(_ W: Double, _ H: Double, _ px: Double) -> Canvas {
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

        // The ground the trees stand on: a low bank with a ragged fringe of grass.
        func groundAt(_ x: Double) -> Double { H - 0.8 - fbm2(x / 40, 3.3, 3) * 1.4 }
        ctx.beginPath()
        ctx.move(to: CGPoint(x: 0, y: H))
        for x in stride(from: 0.0, through: W, by: 0.5) { ctx.addLine(to: CGPoint(x: x, y: groundAt(x))) }
        ctx.addLine(to: CGPoint(x: W, y: H))
        ctx.fillPath()
        var gx = 0.0
        while gx < W {
            let g = groundAt(gx)
            line(gx, g + 0.1, gx + rndD(-0.15, 0.15), g - rndD(0.15, 0.6), rndD(0.02, 0.05))
            gx += rndD(0.04, 0.12)
        }

        /// A spruce or fir: trunk, drooping branches every few decimetres, needle tufts along each.
        func conifer(_ x: Double, _ base: Double, _ height: Double) {
            let fir = chance(0.4)
            let widest = fir ? 0.32 : 0.22
            let tilt = rndD(-0.03, 0.03)
            let top = base - height
            line(x, base, x + tilt * height, top, 0.12 + height * 0.015)
            var y = top + height * 0.04
            while y < base - height * 0.08 {
                let f = (y - top) / height
                let cx = x + tilt * (base - y)
                for side in [-1.0, 1.0] {
                    if chance(0.08) { continue } // a missing branch
                    let len = pow(f, fir ? 0.85 : 1.15) * widest * height * rndD(0.75, 1.15) * (chance(0.05) ? 1.3 : 1)
                    let droop = rndD(0.1, 0.45) * (0.4 + f)
                    let ex = cx + side * cos(droop) * len, ey = y + sin(droop) * len
                    line(cx, y, ex, ey, 0.03 + len * 0.03)
                    // Needle tufts hang from the branch, denser toward its tip.
                    var s = 0.15
                    while s < len {
                        let bx = cx + side * cos(droop) * s, by = y + sin(droop) * s
                        let tl = rndD(0.12, 0.3) * (0.5 + s / len)
                        line(bx, by, bx + side * rndD(-0.05, 0.1), by + tl, 0.03)
                        if chance(0.5) { line(bx, by, bx + side * rndD(0.05, 0.15), by + tl * 0.6, 0.025) }
                        s += rndD(0.1, 0.2)
                    }
                }
                y += rndD(0.2, 0.38)
            }
            // The leader: a few short twigs at the very top.
            for k in 0..<4 {
                let ty = top + Double(k) * 0.12
                line(x + tilt * height, ty, x + tilt * height + rndD(-0.15, 0.15), ty + rndD(0.05, 0.2), 0.025)
            }
        }

        /// A broadleaf tree: trunk, forking limbs, and a crown of many small leaf clusters.
        func deciduous(_ x: Double, _ base: Double, _ height: Double) {
            let trunkH = height * rndD(0.3, 0.45)
            var limbEnds: [(Double, Double, Double)] = []
            func limb(_ bx: Double, _ by: Double, _ a: Double, _ len: Double, _ width: Double, _ depth: Int) {
                let ex = bx + cos(a) * len, ey = by + sin(a) * len
                ctx.setLineWidth(width)
                ctx.beginPath()
                ctx.move(to: CGPoint(x: bx, y: by))
                let c1 = a + rndD(-0.3, 0.3), c2 = a + rndD(-0.3, 0.3)
                ctx.addQuadCurve(to: CGPoint(x: ex, y: ey), control: CGPoint(x: bx + cos(c1) * len * 0.5, y: by + sin(c2) * len * 0.5))
                ctx.strokePath()
                if depth == 0 { limbEnds.append((ex, ey, len)); return }
                for _ in 0..<randInt(2, 3) { limb(ex, ey, a + rndD(-0.7, 0.7), len * rndD(0.5, 0.7), width * 0.6, depth - 1) }
            }
            line(x, base, x + rndD(-0.1, 0.1), base - trunkH, 0.18 + height * 0.025)
            for _ in 0..<randInt(3, 5) {
                limb(x, base - trunkH, -.pi / 2 + rndD(-0.9, 0.9), height * rndD(0.2, 0.32), 0.08 + height * 0.008, 2)
            }
            // Leaves cluster around the limb ends, each cluster a lobe of the crown, ragged at its edge.
            for (lx, ly, len) in limbEnds {
                let r = len * rndD(1.1, 1.8)
                for _ in 0..<Int((r * r * 55).rounded()) {
                    let a = rndD(0, tau), d = pow(Double.random(in: 0..<1), 0.6) * r
                    c.dot(lx + cos(a) * d, ly + sin(a) * d * 0.85, rndD(0.07, 0.22) * (1.1 - 0.5 * d / r))
                }
                for _ in 0..<randInt(3, 7) {
                    let a = rndD(-.pi, 0.3)
                    let sx = lx + cos(a) * r * 0.8, sy = ly + sin(a) * r * 0.7
                    line(sx, sy, sx + cos(a) * rndD(0.2, 0.5), sy + sin(a) * rndD(0.2, 0.5), 0.025)
                }
            }
        }

        /// A dead or winter tree: bare branches forking down to twigs.
        func bare(_ x: Double, _ base: Double, _ height: Double) {
            func branch(_ bx: Double, _ by: Double, _ a: Double, _ len: Double, _ width: Double, _ depth: Int) {
                let ex = bx + cos(a) * len, ey = by + sin(a) * len
                line(bx, by, ex, ey, width)
                if depth == 0 { return }
                for _ in 0..<randInt(2, 3) { branch(ex, ey, a + rndD(-0.7, 0.7), len * rndD(0.55, 0.72), max(0.02, width * 0.6), depth - 1) }
            }
            branch(x, base, -.pi / 2 + rndD(-0.12, 0.12), height * 0.32, 0.14 + height * 0.012, 6)
        }

        /// Low bushes and brambles: tiny leaves on a tangle of stems.
        func bush(_ x: Double, _ base: Double, _ size: Double) {
            for _ in 0..<randInt(6, 12) {
                let a = rndD(-.pi * 0.9, -.pi * 0.1), len = size * rndD(0.4, 1)
                let ex = x + cos(a) * len, ey = base + sin(a) * len
                line(x, base, ex, ey, 0.03)
                for _ in 0..<Int((len * 25).rounded()) {
                    let t = Double.random(in: 0..<1)
                    c.dot(x + cos(a) * len * t + rndD(-0.12, 0.12), base + sin(a) * len * t + rndD(-0.12, 0.12), rndD(0.03, 0.09))
                }
            }
        }

        // Woodland with open patches, denser and taller toward the middle, with the odd tall emergent.
        var x = -4.0
        while x < W + 4 {
            let open = fbm2(x / 55 + 7, 1.2, 2) < 0.4 // a clearing: bushes only
            let base = groundAt(x) + rndD(0, 0.6)
            if open {
                if chance(0.5) { bush(x, base, rndD(1, 2.5)) }
            } else {
                let height = rndD(6, 14) * (0.8 + 0.4 * sin(x / W * .pi)) * (chance(0.06) ? 1.5 : 1)
                let roll = Double.random(in: 0..<1)
                if roll < 0.38 { conifer(x, base, height * 1.25) } else if roll < 0.47 { bare(x, base, height) } else { deciduous(x, base, height) }
            }
            x += rndD(0.9, 2.6)
        }
        x = -2
        while x < W + 2 {
            bush(x, groundAt(x) + 0.3, rndD(0.8, 2.2))
            x += rndD(1.5, 4)
        }
        return c
    }

    static func hillsImage() -> Canvas {
        let w = 4096.0, h = 256.0
        let c = Canvas(Int(w), Int(h), gray: true)
        c.fill(RGBA(0, 0, 0))
        c.fillRect(0, 0, w, h)
        c.fill(RGBA(1, 1, 1))
        for (seed, lift, amp) in [(1.3, 40.0, 50.0), (7.7, 70.0, 40.0)] {
            c.ctx.beginPath()
            c.ctx.move(to: CGPoint(x: 0, y: h))
            for x in stride(from: 0.0, through: w, by: 8) {
                c.ctx.addLine(to: CGPoint(x: x, y: h - lift - fbm2(x / 380 + seed, seed, 4) * amp))
            }
            c.ctx.addLine(to: CGPoint(x: w, y: h))
            c.ctx.fillPath()
        }
        return c
    }
}

// MARK: - Ground mist

/// A few huge soft sprites drifting downwind.
final class Mist {
    private struct Sprite { var pos: V3; let size: V2; let base: Float; let rate: Float; var opacity: Float }

    private var sprites: [Sprite] = []
    private let texture: MTLTexture
    private let instances = FrameRing(length: 14 * 2 * MemoryLayout<V4>.stride)

    init(halfWidth: (Float) -> Float) {
        texture = GPU.shared.texture(Art.blob(256), srgb: true)
        for _ in 0..<14 {
            let z = -rnd(10, 48)
            let size = rnd(10, 30)
            let base = rnd(0.03, 0.07)
            sprites.append(Sprite(pos: V3(rnd(-1, 1) * (halfWidth(-z) + 10), rnd(0.6, 3.5), z),
                                  size: V2(size, size * rnd(0.3, 0.5)), base: base, rate: rnd(0.6, 1.2), opacity: base))
        }
    }

    func update(dt: Float, halfWidth: (Float) -> Float, wind: Float, windDir: V2, storm: Float) {
        for i in sprites.indices {
            var s = sprites[i]
            s.pos.x += windDir.x * wind * s.rate * 0.2 * dt
            s.pos.z += windDir.y * wind * s.rate * 0.05 * dt
            let limit = halfWidth(-s.pos.z) + 14
            if s.pos.x > limit { s.pos.x = -limit }
            if s.pos.x < -limit { s.pos.x = limit }
            if s.pos.z > -8 { s.pos.z = -48 }
            if s.pos.z < -50 { s.pos.z = -9 }
            s.opacity = s.base * (1 - storm * 0.6)
            sprites[i] = s
        }
    }

    func draw(_ ctx: DrawContext) {
        let buf = instances[ctx.slot]
        let p = buf.contents().assumingMemoryBound(to: V4.self)
        for (i, s) in sprites.enumerated() {
            p[i * 2] = V4(s.pos, s.opacity)
            p[i * 2 + 1] = V4(s.size.x, s.size.y, 0, 0)
        }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("mistVertex", "mistFragment", blend: .alpha, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(buf, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(texture, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: sprites.count)
    }
}
