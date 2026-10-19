import Foundation
import Metal
import simd

// The night sky over Glen Canyon: a Bortle-1 vault with the Milky Way and thousands of stars,
// airglow at the horizon, a moon behind the viewer that lights the bridge, and the light state that
// sets the shared uniforms from the moon and the aurora.

let skyRadius: Float = 8000

/// The moon: behind the viewer, high to the right, so it lights the near face of the arch and the
/// walls, and the Milky Way stands in the dark sky over the bridge.
let moonDir = V3(-0.3, 0.34, 0.89).normalized
/// The bounce light, in the sun's slot of the shared lighting: from sunlit rock below, throwing a
/// little warm light up under the span (three's DirectionalLight from (0, -40, -120) at (0, 40, -200)).
let sunDir = V3(0, -80, 80).normalized

/// The light: eases the moon and the aurora toward the settings. The moon is drawn stronger and
/// warmer than a real one, as the reference image has it: a low gibbous moon behind the viewer's
/// shoulder, raking the bridge and the cliffs.
final class LightState {
    private(set) var moon: Float
    private(set) var aurora: Float

    /// Starts where the settings have it, so nothing shows at load that was switched off.
    init(settings: Settings) {
        moon = settings.moonlight ? 1 : 0
        aurora = settings.aurora ? 1 : 0
    }

    struct Out {
        var sky = V3(0.07, 0.085, 0.15), ground = V3(0.04, 0.03, 0.03), hemi: Float = 1.7
        var key = V3(1, 0.72, 0.46), keyI: Float = 1.3
        var bounce = V3(0.9, 0.55, 0.3), bounceI: Float = 0.12
        var fog = V3(0.006, 0.009, 0.018), fogNear: Float = 120, fogFar: Float = 900
    }

    func update(dt: Float, settings: Settings, auroraLevel: Float) -> Out {
        moon = approach(moon, settings.moonlight ? 1 : 0, 2.5, dt)
        aurora = approach(aurora, settings.aurora ? 1 : 0, 3, dt)
        let aur = aurora * clamp(auroraLevel, 0, 2.5) / 2.5
        var o = Out()
        o.sky = lerp(V3(0.07, 0.085, 0.15), V3(0.08, 0.2, 0.12), aur * 0.7)
        o.hemi = 1.7 + 0.8 * aur
        o.keyI = 1.3 * moon
        o.bounceI = 0.12 * moon
        o.fog = lerp(V3(0.006, 0.009, 0.018), V3(0.01, 0.03, 0.02), aur * 0.6)
        return o
    }
}

/// The sky dome: a deep blue-black vault, greener low down where the aurora's light scatters, the
/// Milky Way painted once onto an equirectangular image, four layers of stars hashed in the shader,
/// the moon's glow; in the rain a lid of grey cloud lit from within by the lightning.
final class Sky {
    private let mesh = Geometry.sphere(radius: skyRadius, widthSegments: 64, heightSegments: 40).upload()
    private let haze: MTLTexture = Sky.milkyWay

    /// Painted once per launch and shared by every new night.
    static let milkyWay: MTLTexture = GPU.shared.texture(paint(1536, 768), srgb: false)

    private static func paint(_ w: Int, _ h: Int) -> Canvas {
        let N = simd_normalize(SIMD3<Double>(0.62, 0.55, 0.56))
        let T1 = simd_normalize(SIMD3<Double>(0, 0, -1) - N * (-N.z))
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
            let patches = fbm2(along * 1.3 + 2, b * 5 + 9, 3)
            let knots = fbm2(along * 3.5, b * 14 + 3, 4)
            var haze = wide * 0.28 * (0.3 + patches) + core * (0.35 + 1.0 * knots * knots)
            let lanes = fbm2(along * 6 + 7, b * 26 + 1, 4)
            haze *= 1 - 0.85 * smoothstep(0.52, 0.7, lanes) * core
            let riftCentre = 0.04 * sin(along * 2.2 + 1) + 0.02 * sin(along * 5.1)
            let rift = exp(-pow((b - riftCentre) / 0.03, 2)) * (0.35 + 0.65 * fbm2(along * 4 + 5, 1.5, 3))
            haze *= 1 - 0.7 * rift
            let bulge = exp(-pow((along - 0.9) / 0.9, 2))
            haze *= 1 + 1.4 * bulge
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

    /// Seen directly and in the water's reflection.
    func draw(_ ctx: DrawContext, moon: Float) {
        guard ctx.shows(.surface) else { return }
        let e = ctx.encoder
        ctx.use("archSkyVertex", "archSkyFragment", depthWrite: false)
        var m = V4(moon, 0, 0, 0)
        e.setFragmentBytes(&m, length: 16, index: 3)
        e.setFragmentTexture(haze, index: 3)
        e.setFragmentSamplerState(GPU.shared.skySampler, index: 3)
        mesh.draw(e)
    }
}

/// The moon: NASA's LRO colour map on a sphere with the LRO height map for relief, lit by its own
/// sun for a waxing gibbous. (NASA Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720.)
final class Moon {
    private struct Params { var model: simd_float4x4; var sun: V4; var opacity: V4 }

    private let mesh: GPUMesh
    private let colorMap: MTLTexture?
    private let bumpMap: MTLTexture?
    private var params: Params

    init() {
        let distance = skyRadius * 0.95
        let radius = distance * tan(0.6 * .pi / 180)
        mesh = Geometry.sphere(radius: radius, widthSegments: 96, heightSegments: 64).upload()
        colorMap = Assets.url("lroc_color_2k.jpg").flatMap { GPU.shared.load($0, srgb: true) }
        bumpMap = Assets.url("ldem_3_8bit.jpg").flatMap { GPU.shared.load($0, srgb: false) }
        let toViewer = -moonDir
        let right = moonDir.cross(V3(0, 1, 0)).normalized
        let sun = (right * 0.9 + toViewer * 0.55 + V3(0, 0.1, 0)).normalized
        params = Params(model: simd_float4x4(translation: moonDir * distance) * simd_float4x4(quatFromTo(V3(1, 0, 0), toViewer)),
                        sun: V4(sun, 0), opacity: .zero)
    }

    /// Seen directly and in the water's reflection.
    func draw(_ ctx: DrawContext, opacity: Float) {
        params.opacity.x = clamp(opacity, 0, 1)
        guard ctx.shows(.surface), params.opacity.x > 0.01, let colorMap, let bumpMap else { return }
        let e = ctx.encoder
        ctx.use("archMoonVertex", "archMoonFragment", blend: .alpha)
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

/// The moon maps and the owner's photographs live in the web version's `html/assets`; the app
/// bundle gets a copy (see build.sh).
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

    struct ArchSkyOut { float4 position [[position]]; float3 dir; };

    vertex ArchSkyOut archSkyVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        ArchSkyOut o;
        float3 p = verts[vid * 2].xyz;
        o.dir = p;
        // Centred on the eye (the mirrored one in the reflection), so it sits at infinity.
        o.position = F.viewProj * float4(p + F.camera.xyz, 1.0);
        return o;
    }

    float3 archStarLayer(float2 uv, float cells, float threshold, float gain, float seed, float time) {
        float2 g = uv * float2(cells * 2.0, cells);
        float2 cell = floor(g), f = fract(g);
        float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
        if (r1 < threshold) return float3(0.0);
        float dist = length(f - (float2(r2, r3) * 0.7 + 0.15));
        float bright = pow((r1 - threshold) / (1.0 - threshold), 6.0) * gain + 0.03;
        float tw = 0.78 + 0.22 * sin(time * q(0.8 + r3 * 2.5) + r2 * 6.2831);
        float3 tint = r4 < 0.22 ? float3(0.72, 0.82, 1.0) : r4 < 0.6 ? float3(0.95, 0.96, 1.0) : r4 < 0.86 ? float3(1.0, 0.9, 0.72) : float3(1.0, 0.72, 0.5);
        float size = 0.07 + 0.12 * pow(bright / (gain + 0.03), 0.5);
        float star = sstep(size, 0.0, dist) * bright * tw;
        star += exp(-dist * dist / 0.03) * bright * 0.12 * step(0.985, r1);
        return tint * star;
    }

    fragment float4 archSkyFragment(ArchSkyOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant float4& S [[buffer(3)]],
                                    texture2d<float> hazeMap [[texture(3)]], sampler hs [[sampler(3)]]) {
        float uTime = F.misc.x, uAurora = F.misc.z, uRain = F.misc.w, uMoonI = S.x;
        float3 d = normalize(in.dir);
        float h = d.y;
        float2 uv = float2(atan2(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
        // The vault: a deep blue-black, greener low down where the aurora's light scatters.
        float3 night = mix(float3(0.02, 0.035, 0.07), float3(0.003, 0.005, 0.014), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
        night += float3(0.02, 0.035, 0.03) * exp(-max(h, 0.0) * 12.0) * 0.6;
        night += F.aurora.xyz * 0.5 * exp(-max(h, 0.0) * 3.0);
        float3 haze = hazeMap.sample(hs, tv(uv)).rgb;
        float hazeAmt = dot(haze, float3(0.33));
        float3 stars = archStarLayer(uv, 380.0, 0.75, 1.5, 0.0, uTime) + archStarLayer(uv, 760.0, 0.84, 0.8, 5.0, uTime) * (0.7 + 1.5 * hazeAmt)
                     + archStarLayer(uv, 1400.0, 0.9, 0.35, 11.0, uTime) * (0.5 + 2.0 * hazeAmt) + archStarLayer(uv, 2600.0, 0.93, 0.15, 23.0, uTime) * (0.3 + 2.5 * hazeAmt);
        // Under a bright aurora the fainter stars and the Milky Way wash out.
        float wash = 1.0 - 0.6 * clamp(uAurora, 0.0, 1.0);
        night += haze * 0.3 * wash + stars * (0.6 + 0.4 * wash);
        float cosm = dot(d, F.moonDir.xyz);
        night += float3(0.6, 0.6, 0.75) * (exp((cosm - 1.0) * 90.0) * 0.12 + exp((cosm - 1.0) * 600.0) * 0.3) * uMoonI;
        float3 col = night;
        // Rain: a lid of grey cloud slides over the vault, drifting on the wind, lit from within
        // where the lightning is and faintly everywhere by each flash.
        if (uRain > 0.001) {
            float2 cp = d.xz / max(h, 0.08) * 0.9 + float2(uTime * 0.01, 0.0);
            float cloud = fbm(cp);
            float3 grey = float3(0.025, 0.03, 0.045) * (0.5 + 1.1 * cloud);
            float near = exp((dot(d, F.flash.xyz) - 1.0) * 6.0);
            grey += float3(0.6, 0.66, 0.9) * F.flash.w * (0.15 + 0.6 * cloud) * (0.35 + 0.65 * near);
            float lid = uRain * smoothstep(-0.02, 0.15, h);
            col = mix(col, grey, lid);
        }
        col = mix(col, F.fogColor.xyz, sstep(0.04, -0.01, h));
        return float4(col, 1.0);
    }

    // MARK: - Moon

    struct ArchMoonParams { float4x4 model; float4 sun; float4 opacity; };
    struct ArchMoonOut { float4 position [[position]]; float2 uv; float3 n; float3 rel; };

    vertex ArchMoonOut archMoonVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                      constant Frame& F [[buffer(1)]], constant ArchMoonParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        ArchMoonOut o;
        o.uv = float2(a.w, b.w);
        float3x3 m = float3x3(P.model[0].xyz, P.model[1].xyz, P.model[2].xyz);
        o.n = normalize(m * b.xyz);
        float4 wp = P.model * float4(a.xyz, 1.0);
        wp.xyz += F.camera.xyz;
        o.rel = wp.xyz - F.camera.xyz;
        o.position = F.viewProj * wp;
        return o;
    }

    fragment float4 archMoonFragment(ArchMoonOut in [[stage_in]], constant ArchMoonParams& P [[buffer(3)]],
                                     texture2d<float> colorMap [[texture(3)]], texture2d<float> bumpMap [[texture(4)]], sampler s [[sampler(1)]]) {
        float3 albedo = colorMap.sample(s, tv(in.uv)).rgb;
        float h = bumpMap.sample(s, tv(in.uv)).r;
        float3 n = perturbByHeight(normalize(in.n), in.rel, h, 1.4);
        float lit = max(dot(n, P.sun.xyz), 0.0);
        float l = smoothstep(-0.02, 0.12, dot(normalize(in.n), P.sun.xyz)) * lit;
        return float4(albedo * (l * 3.0 + 0.02) * float3(1.0, 0.98, 0.94), P.opacity.x);
    }

    """
}
