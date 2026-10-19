import Foundation
import Metal
import simd

// The winter sky (stars, a faint Milky Way, airglow), the moon and shooting stars.

/// The sky sits beyond the aurora, which is drawn at a tenth of its real size (see Aurora.swift).
let skyRadius: Float = 150_000

/// The sky dome. The Milky Way is painted once onto an equirectangular image (the same painter as
/// Firefly Meadow's, with its band tilted for a winter evening); the stars are hashed in the shader
/// so they stay crisp at any resolution, each with its own colour and size.
final class Sky {
    private let mesh = Geometry.sphere(radius: skyRadius, widthSegments: 48, heightSegments: 32).upload()
    private let haze: MTLTexture = Sky.milkyWay

    /// Painted once per launch (it takes a moment) and shared by every new night.
    static let milkyWay: MTLTexture = GPU.shared.texture(paintMilkyWay(1024, 512), srgb: false)

    /// The plane of the galaxy, tilted so the band crosses the sky in front of the viewer.
    private static func paintMilkyWay(_ w: Int, _ h: Int) -> Canvas {
        let N = simd_normalize(SIMD3<Double>(-0.55, 0.62, 0.56))
        // A basis in the plane of the band, to measure position along it.
        let T1 = simd_normalize(SIMD3<Double>(0, 0, -1) - N * (N.z * -1))
        let T2 = simd_cross(N, T1)
        let c = Canvas(w, h)
        c.setPixels { x, y in
            let lat = (0.5 - (Double(y) + 0.5) / Double(h)) * Double.pi
            let cl = cos(lat), sl = sin(lat)
            let lon = ((Double(x) + 0.5) / Double(w) - 0.5) * 2 * Double.pi
            let d = SIMD3<Double>(cl * cos(lon), sl, cl * sin(lon))
            let b = simd_dot(d, N)
            let along = atan2(simd_dot(d, T2), simd_dot(d, T1))
            let core = exp(-(b * b) / 0.012)
            let wide = exp(-(b * b) / 0.09)
            // Mottled brightness along the band, big patches and finer knots.
            let patches = fbm2(along * 1.3 + 2, b * 5 + 9, 3)
            let knots = fbm2(along * 3.5, b * 14 + 3, 4)
            var haze = wide * 0.28 * (0.3 + patches) + core * (0.35 + 1.0 * knots * knots)
            // Dust: dark lanes threaded through the core, and the great rift down its middle.
            let lanes = fbm2(along * 6 + 7, b * 26 + 1, 4)
            haze *= 1 - 0.85 * smoothstep(0.52, 0.7, lanes) * core
            let riftCentre = 0.04 * sin(along * 2.2 + 1) + 0.02 * sin(along * 5.1)
            let rift = exp(-pow((b - riftCentre) / 0.03, 2)) * (0.35 + 0.65 * fbm2(along * 4 + 5, 1.5, 3))
            haze *= 1 - 0.7 * rift
            // Colour: a warm bulge, cooler blue-white arms, with pink and teal nebulae here and there.
            let warmth = core * (0.35 + 0.65 * patches)
            var r = lerp(0.62, 1.0, warmth), g = lerp(0.72, 0.9, warmth), bl = lerp(1.0, 0.72, warmth)
            let pink = smoothstep(0.62, 0.8, fbm2(along * 3 + 11, b * 12 + 5, 3)) * core
            let teal = smoothstep(0.64, 0.82, fbm2(along * 2.6 + 23, b * 10 + 17, 3)) * wide
            r += pink * 0.5; g -= pink * 0.15; bl += pink * 0.1
            g += teal * 0.35; bl += teal * 0.3; r -= teal * 0.15
            func sat(_ v: Double) -> Double { clamp(v, 0, 1) * 255 }
            return (sat(r * haze * 0.9), sat(g * haze * 0.9), sat(bl * haze * 0.9))
        }
        return c
    }

    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        ctx.use("skyVertex", "skyFragment", depthWrite: false)
        e.setFragmentTexture(haze, index: 3)
        e.setFragmentSamplerState(GPU.shared.skySampler, index: 3)
        mesh.draw(e)
    }
}

/// The moon: a sphere wrapped in NASA's Lunar Reconnaissance Orbiter colour map, with its height
/// map as a bump map, lit by its own sun so the phase and the relief along the terminator are real.
/// (Maps: NASA's Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720.)
final class Moon {
    private struct Params { var model: simd_float4x4; var sun: V4; var opacity: V4 }

    private let mesh: GPUMesh
    private let colorMap: MTLTexture?
    private let bumpMap: MTLTexture?
    private var params: Params

    init() {
        let distance = skyRadius * 0.9
        // Drawn about twice its real size, as the eye remembers it low over the trees.
        let radius = distance * tan(0.55 * .pi / 180)
        mesh = Geometry.sphere(radius: radius, widthSegments: 96, heightSegments: 64).upload()
        colorMap = Assets.url("lroc_color_2k.jpg").flatMap { GPU.shared.load($0, srgb: true) }
        bumpMap = Assets.url("ldem_3_8bit.jpg").flatMap { GPU.shared.load($0, srgb: false) }
        let toViewer = -moonDir
        // The moon's own sun, off to the left and a little toward us: a waning gibbous.
        let right = moonDir.cross(V3(0, 1, 0)).normalized
        let sun = (right * -0.9 + toViewer * 0.62 + V3(0, 0.1, 0)).normalized
        params = Params(model: simd_float4x4(translation: moonDir * distance) * simd_float4x4(quatFromTo(V3(1, 0, 0), toViewer)),
                        sun: V4(sun, 0), opacity: .zero)
    }

    func draw(_ ctx: DrawContext, moon: Float) {
        params.opacity.x = clamp(moon, 0, 1)
        guard params.opacity.x > 0.01, let colorMap, let bumpMap else { return }
        let e = ctx.encoder
        ctx.use("moonVertex", "moonFragment", blend: .alpha)
        e.setVertexBytes(&params, length: MemoryLayout<Params>.stride, index: 2)
        e.setFragmentBytes(&params, length: MemoryLayout<Params>.stride, index: 3)
        e.setFragmentTexture(colorMap, index: 3)
        e.setFragmentTexture(bumpMap, index: 4)
        // Only the near side: with depth writes off, the far hemisphere would draw over it.
        e.setCullMode(.back)
        mesh.draw(e)
        e.setCullMode(.none)
    }
}

/// Shooting stars: a streak that crosses a few degrees of sky in half a second, now and then.
final class Meteors {
    private struct Active { let start: V3, dir: V3; var t: Float; let duration: Float, travel: Float, length: Float, width: Float }
    private let mesh = Geometry.plane(1, 1).upload()
    private let texture: MTLTexture
    private var timer = rnd(10, 30)
    private var active: Active?
    private var model = matrix_identity_float4x4
    private var opacity: Float = 0

    init() {
        // White, fading in along the streak to its bright head, and soft across it.
        let w = 256, h = 16
        let c = Canvas(w, h)
        let d = c.data
        for y in 0..<h {
            let fy = (Double(y) + 0.5) / Double(h)
            let keep = 1 - min(1, abs(fy - 0.5) / 0.5)
            for x in 0..<w {
                let fx = (Double(x) + 0.5) / Double(w)
                let along = fx < 0.75 ? fx / 0.75 * 0.5 : 0.5 + (fx - 0.75) / 0.25 * 0.5
                let a = UInt8(clamp(along * keep, 0, 1) * 255)
                let i = (y * w + x) * 4
                d[i] = a; d[i + 1] = a; d[i + 2] = a; d[i + 3] = a
            }
        }
        texture = GPU.shared.texture(c, srgb: true)
    }

    func update(dt: Float) {
        let R = skyRadius * 0.8
        if var a = active {
            a.t += dt
            let k = a.t / a.duration
            if k >= 1 {
                active = nil
                return
            }
            active = a
            let head = (a.start + a.dir * (a.travel * k)).normalized * R
            let tangent = (a.dir - head * (a.dir.dot(head) / head.lengthSquared)).normalized
            let normal = (-head).normalized
            let side = tangent.cross(normal).normalized
            let pos = head + tangent * (-a.length * R / 2)
            model = simd_float4x4(basisX: tangent, y: side, z: normal, position: pos) * simd_float4x4(scale: V3(a.length * R, a.width * R, 1))
            opacity = sin(k * .pi) * 0.9
            return
        }
        timer -= dt
        if timer > 0 { return }
        timer = rnd(12, 40)
        let az = rnd(-0.8, 0.8), el = rnd(0.45, 0.9)
        let start = V3(sin(az) * cos(el), sin(el), -cos(az) * cos(el))
        let dir = V3(rnd(-1, 1), rnd(-0.9, -0.3), rnd(-0.4, 0.4)).normalized
        // Sizes as fractions of the sky radius (a streak a few degrees long).
        active = Active(start: start, dir: dir, t: 0, duration: rnd(0.35, 0.6), travel: rnd(0.06, 0.12),
                        length: rnd(0.03, 0.06), width: rnd(0.001, 0.0018))
    }

    func draw(_ ctx: DrawContext, camera: V3) {
        guard active != nil else { return }
        Std.begin(ctx, blend: .additive)
        // Follows the camera, as the sky does.
        let m = simd_float4x4(translation: camera) * model
        Std.draw(ctx, mesh, StdParams(model: m, color: V3(1.6, 1.7, 2.0), opacity: opacity, roughness: 1,
                                      flags: [.map, .unlit, .noFog, .doubleSided, .clampMap]), map: texture)
    }
}

/// The moon maps live in the web version's `html/assets`; the app bundle gets a copy (see build.sh).
enum Assets {
    static func url(_ name: String) -> URL? {
        let parts = name.split(separator: ".")
        if let u = Bundle.main.url(forResource: String(parts[0]), withExtension: String(parts[1])) { return u }
        // Running from the package (`swift run`): find the assets in the repository.
        let here = URL(fileURLWithPath: #filePath)
        let u = here.deletingLastPathComponent().appendingPathComponent("../../../html/assets/\(name)").standardized
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
}

extension Shaders {
    static let sky = """

    // MARK: - Sky

    struct SkyOut { float4 position [[position]]; float3 dir; };

    vertex SkyOut skyVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        SkyOut o;
        float3 p = verts[vid * 2].xyz;
        o.dir = p;
        o.position = F.viewProj * float4(p + F.camera.xyz, 1.0);
        return o;
    }

    /// One layer of stars on a grid of cells: most faint and white, a few bright, each with its own
    /// colour from blue-white through yellow to orange, and a soft halo on the brightest.
    float3 starLayer(float2 uv, float cells, float threshold, float gain, float seed, float time) {
        float2 g = uv * float2(cells * 2.0, cells);
        float2 cell = floor(g), f = fract(g);
        float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
        if (r1 < threshold) return float3(0.0);
        float2 off = float2(r2, r3) * 0.7 + 0.15;
        float dist = length(f - off);
        float bright = pow((r1 - threshold) / (1.0 - threshold), 6.0) * gain + 0.03;
        float tw = 0.75 + 0.25 * sin(time * q(0.8 + r3 * 2.5) + r2 * 6.2831);
        float3 tint = r4 < 0.22 ? float3(0.72, 0.82, 1.0) : r4 < 0.6 ? float3(0.95, 0.96, 1.0) : r4 < 0.86 ? float3(1.0, 0.9, 0.72) : float3(1.0, 0.72, 0.5);
        float size = 0.07 + 0.12 * pow(bright / (gain + 0.03), 0.5);
        float star = sstep(size, 0.0, dist) * bright * tw;
        star += exp(-dist * dist / 0.03) * bright * 0.12 * step(0.985, r1);
        return tint * star;
    }

    fragment float4 skyFragment(SkyOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                texture2d<float> hazeMap [[texture(3)]], sampler hs [[sampler(3)]]) {
        float uTime = F.misc.x, uMoon = F.misc.y;
        float3 d = normalize(in.dir);
        float h = d.y;
        float3 zenith = float3(0.002, 0.003, 0.010);
        float3 horizon = float3(0.018, 0.026, 0.055);
        float3 col = mix(horizon, zenith, pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
        // Faint green airglow low on the horizon (oxygen at 557.7 nm, the aurora's own line).
        col += float3(0.012, 0.03, 0.02) * exp(-max(h, 0.0) * 12.0);
        // The aurora lights the whole sky a little.
        col += F.aurora.xyz * 0.05 * (0.4 + 0.6 * exp(-max(h, 0.0) * 3.0));

        float2 uv = float2(atan2(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
        float3 haze = hazeMap.sample(hs, tv(uv)).rgb;
        float hazeAmt = dot(haze, float3(0.33));
        if (h > -0.02) {
            float3 stars = starLayer(uv, 380.0, 0.75, 1.5, 0.0, uTime)
                         + starLayer(uv, 760.0, 0.84, 0.8, 5.0, uTime) * (0.7 + 1.5 * hazeAmt)
                         + starLayer(uv, 1400.0, 0.9, 0.35, 11.0, uTime) * (0.5 + 2.0 * hazeAmt);
            col += stars * (1.0 - uMoon * 0.35) * smoothstep(-0.02, 0.08, h);
        }
        // Moonlight washes out the faint stars and most of the Milky Way.
        col += haze * 0.22 * (1.0 - uMoon * 0.6);

        // The moon's halo, and a hint of the 22-degree ice halo in cold air.
        float cosm = dot(d, F.moonDir.xyz);
        float halo = exp((cosm - 1.0) * 90.0) * 0.05 + exp((cosm - 1.0) * 900.0) * 0.25;
        float ring = exp(-pow((acos(clamp(cosm, -1.0, 1.0)) - 0.384) / 0.012, 2.0)) * 0.012;
        col += float3(0.5, 0.6, 0.85) * (halo + ring) * uMoon;

        // Fade into the fog just above the horizon, so the land meets the sky seamlessly.
        col = mix(col, F.fogColor.xyz, sstep(0.05, -0.01, h));
        return float4(col, 1.0);
    }

    // MARK: - Moon

    struct MoonParams { float4x4 model; float4 sun; float4 opacity; };
    struct MoonOut { float4 position [[position]]; float2 uv; float3 n; float3 rel; };

    vertex MoonOut moonVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], constant MoonParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        MoonOut o;
        o.uv = float2(a.w, b.w);
        float3x3 m = float3x3(P.model[0].xyz, P.model[1].xyz, P.model[2].xyz);
        o.n = normalize(m * b.xyz);
        float4 wp = P.model * float4(a.xyz, 1.0);
        // Follows the camera, as the sky does, so it sits at infinity.
        wp.xyz += F.camera.xyz;
        o.rel = wp.xyz - F.camera.xyz;
        o.position = F.viewProj * wp;
        return o;
    }

    fragment float4 moonFragment(MoonOut in [[stage_in]], constant MoonParams& P [[buffer(3)]],
                                 texture2d<float> colorMap [[texture(3)]], texture2d<float> bumpMap [[texture(4)]], sampler s [[sampler(1)]]) {
        float3 albedo = colorMap.sample(s, tv(in.uv)).rgb;
        // Bump the normal with the height map so craters stand out along the terminator.
        float h = bumpMap.sample(s, tv(in.uv)).r;
        float3 n = perturbByHeight(normalize(in.n), in.rel, h, 1.4);
        float lit = max(dot(n, P.sun.xyz), 0.0);
        return float4(albedo * (lit * 3.2 + 0.012), P.opacity.x);
    }

    """
}
