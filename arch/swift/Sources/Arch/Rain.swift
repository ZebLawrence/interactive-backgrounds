import CoreGraphics
import Metal
import simd

// The storm: rain streaking through the air in front of the viewer, in a box that follows the
// camera, slanted by the breeze and fading with distance; and the lightning, a forked bolt (drawn
// the way Firefly Meadow draws its own) standing for a moment somewhere in the sky behind the
// canyon, whose flash the clouds, the rock and the streaks all answer. The drops' other marks (the
// patter on the lake, the film on the craft, the drips off its rim) live with the water and the craft.

private let rainCount = 3200
private let rainBox = (halfX: Float(55), height: Float(38), near: Float(1.5), far: Float(95))

/// The rain streaks: line segments that fall in the vertex shader, wrapping to the top of a box that
/// follows the camera. Seen directly only (not in the water's reflection).
final class Rain {
    private let vertices: MTLBuffer
    private var rain: Float = 0
    private var camera = V3.zero

    init() {
        // Two vertices per streak: (position, end 0 or 1), (seed, 0, 0, 0).
        var v: [V4] = []
        v.reserveCapacity(rainCount * 4)
        for _ in 0..<rainCount {
            let x = (Float.random(in: 0..<1) * 2 - 1) * rainBox.halfX, y = Float.random(in: 0..<1) * rainBox.height
            // Denser near the viewer, thinning with distance, so the screen is evenly peppered.
            let z = -(rainBox.near + pow(Float.random(in: 0..<1), 1.6) * (rainBox.far - rainBox.near))
            let s = Float.random(in: 0..<1)
            for k in 0..<2 { v += [V4(x, y, z, Float(k)), V4(s, 0, 0, 0)] }
        }
        vertices = GPU.shared.buffer(v)
    }

    func update(camera: V3, rain: Float) {
        self.rain = rain
        self.camera = camera
    }

    func draw(_ ctx: DrawContext) {
        guard ctx.pass == .main, rain > 0.01 else { return }
        var p = V4(camera, rain)
        let e = ctx.encoder
        ctx.use("rainVertex", "rainFragment", blend: .alpha)
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.setVertexBytes(&p, length: 16, index: 2)
        e.drawPrimitives(type: .line, vertexStart: 0, vertexCount: rainCount * 2)
    }
}

/// The lightning: every few seconds under the rain a bolt forks down the sky somewhere ahead, a
/// kilometre off, facing the viewer, in two or three strokes that die within a second. Its flash
/// (0..1) and its direction (the web version's uFlash) are what the sky, the rock and the streaks
/// read. The bolt is seen directly and in the reflection.
final class Lightning {
    /// xyz: toward the bolt; w: how bright the flash is now.
    private(set) var flash = V4(0, 1, 0, 0)
    private var dir = V3(0, 1, 0)
    private var timer = rnd(3, 6)
    private var strike: (t: Float, bursts: [(Float, Float)])?
    private var opacity: Float = 0
    private var texture: MTLTexture?
    private var model = matrix_identity_float4x4
    private let plane = Geometry.plane(320, 640).upload()
    /// `--strike-at seconds`: force the first strike (with the rain on) for testing.
    private static let strikeAt: Float? = {
        let a = CommandLine.arguments
        return a.firstIndex(of: "--strike-at").flatMap { $0 + 1 < a.count ? Float(a[$0 + 1]) : nil }
    }()
    private var clock: Float = 0

    private var forced = false

    init() {}

    func update(dt: Float, storm: Float, camera: V3) {
        clock += dt
        if var s = strike {
            s.t += dt
            var f: Float = 0
            for (t0, peak) in s.bursts where s.t >= t0 { f += peak * exp(-(s.t - t0) / 0.07) }
            flash.w = min(1, f) * storm
            opacity = s.t < 0.4 ? min(1, f * 1.6) : 0
            strike = s
            if s.t > 1.2 {
                strike = nil
                flash.w = 0
                opacity = 0
            }
        }
        flash = V4(dir, flash.w)
        if let at = Lightning.strikeAt, !forced, clock >= at {
            forced = true
        } else {
            if storm < 0.4 { return }
            timer -= dt
            if timer > 0 { return }
        }
        timer = rnd(4, 15)
        texture = GPU.shared.texture(Lightning.boltCanvas(), srgb: true)
        // Somewhere ahead, over the canyon or its walls, a kilometre off; the plane faces the viewer
        // and stands with its foot near the skyline.
        let az = rnd(-1.1, 1.1)
        dir = V3(sin(az) * 0.93, 0.36, -cos(az) * 0.93).normalized
        let foot = V3(dir.x, 0, dir.z).normalized * 1100
        var pos = camera + foot
        pos.y = 250
        // Facing the camera, upright (three's lookAt for a mesh points its +z at the target).
        let z = V3(camera.x - pos.x, 0, camera.z - pos.z).normalized
        let x = V3(0, 1, 0).cross(z).normalized
        model = simd_float4x4(basisX: x, y: z.cross(x), z: z, position: pos)
        strike = (0, [(0, 1), (0.1 + rnd(0, 0.08), rnd(0.5, 0.9)), (0.25 + rnd(0, 0.15), rnd(0.2, 0.6))])
        flash = V4(dir, flash.w)
    }

    func draw(_ ctx: DrawContext) {
        guard ctx.shows(.above), !ctx.isShadow, opacity > 0.01, let texture else { return }
        Std.begin(ctx, blend: .additive)
        Std.draw(ctx, plane, StdParams(model: model, color: V3(2.2, 2.3, 2.8), opacity: opacity, roughness: 1,
                                       flags: [.map, .unlit, .noFog, .clampMap]), map: texture)
    }

    /// A forked bolt down a tall canvas (Firefly Meadow's), faded out at its sides and foot so the
    /// plane's edges never show.
    static func boltCanvas() -> Canvas {
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
                x = clamp(x + cos(a) * step, w * 0.12, w * 0.88)
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
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        // destination-in with two gradients: scale every pixel (premultiplied, so all four
        // channels) by the fade across and down.
        let d = c.data, W = c.width, H = c.height
        func ramp(_ t: Double, _ a: Double, _ b: Double) -> Double {
            // 0 at the edge, 1 between a and b (fractions), back to 0 at the far edge.
            t < a ? t / a : (t > b ? (1 - t) / (1 - b) : 1)
        }
        for yy in 0..<H {
            let fy = ramp((Double(yy) + 0.5) / Double(H), 0.06, 0.9)
            for xx in 0..<W {
                let k = fy * ramp((Double(xx) + 0.5) / Double(W), 0.1, 0.9)
                if k >= 1 { continue }
                let i = (yy * W + xx) * 4
                for j in 0..<4 { d[i + j] = UInt8(Double(d[i + j]) * k) }
            }
        }
        return c
    }
}

extension Shaders {
    static let rain = """

    // MARK: - Rain streaks

    struct RainOut { float4 position [[position]]; float alpha; };

    /// verts: (position, end), (seed) per vertex; P: xyz the camera, w how hard it is raining.
    vertex RainOut rainVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]],
                              constant float4& P [[buffer(2)]]) {
        float4 a = verts[vid * 2];
        float seed = verts[vid * 2 + 1].x, end = a.w;
        float speed = 8.5 + seed * 3.5;
        float3 p = a.xyz;
        // Each streak falls at its own speed and wraps to the top of the box.
        p.y = fmodGL(a.y - F.misc.x * speed - seed * 97.0, \(rainBox.height));
        // Slanted by the breeze; the tail trails the head along the fall.
        float2 drift = F.wind.xy * F.wind.z * 2.5;
        float3 dir = normalize(float3(drift.x, -speed, drift.y));
        p.xz += drift * (\(rainBox.height) - p.y) / speed;
        p += dir * end * (0.45 + seed * 0.35);
        float3 world = p + float3(P.x, 0.0, P.z);
        float dist = length(world - F.camera.xyz);
        RainOut o;
        o.alpha = (0.08 + 0.18 * (1.0 - end)) * P.w * smoothstep(0.0, 8.0, dist) * (1.0 - smoothstep(45.0, 95.0, dist));
        o.position = F.viewProj * float4(world, 1.0);
        return o;
    }

    fragment float4 rainFragment(RainOut in [[stage_in]], constant Frame& F [[buffer(0)]]) {
        return float4(float3(0.72, 0.8, 0.9) * (F.skyLight.xyz * 2.5 + 0.12) * (1.0 + 3.0 * F.flash.w), in.alpha);
    }

    """
}
