import Foundation
import Metal
import simd

let skyRadius: Float = 8000

/// The light of the moment: the hemisphere light, the two key lights and the haze, eased toward
/// the settings by `Weather`.
struct Light {
    var sun: Float = 0
    var night: Float = 0
    var snowing: Float = 0
    var sky = V3(0.7, 0.73, 0.8)
    var ground = V3(0.62, 0.64, 0.68)
    var hemi: Float = 2.6
    var sunColor = V3(1, 1, 1)
    var sunI: Float = 0.3
    var moonColor = V3(0.7, 0.78, 1)
    var moonI: Float = 0
    var fog = V3(0.56, 0.58, 0.62)
    var fogNear: Float = 12
    var fogFar: Float = 150
    /// The sky's light on an upward face (the web version's `uSkyLight`), for custom shaders.
    var skyLight = V3(0.6, 0.62, 0.66)
}

/// Weather: eases the sun and night amounts toward the settings, with the overcast thinning and
/// thickening on its own, and sets the light and fog from them.
final class Weather {
    private var t = rnd(0, 1000)
    private var sun: Float = 0
    private var night: Float = 0
    /// 0..1, the overcast thinning a little now and then.
    private var thin: Float = 0

    private struct State { let sky: V3, ground: V3, hemi: Float, key: V3, keyI: Float, fog: V3 }

    // Linear colours of the light in each state.
    private static let overcast = State(sky: V3(0.70, 0.73, 0.80), ground: V3(0.62, 0.64, 0.68), hemi: 2.6, key: V3(0.9, 0.9, 0.92), keyI: 0.3, fog: V3(0.56, 0.58, 0.62))
    private static let sunny = State(sky: V3(0.46, 0.58, 0.82), ground: V3(0.72, 0.74, 0.78), hemi: 2.0, key: V3(1.0, 0.92, 0.80), keyI: 3.2, fog: V3(0.66, 0.70, 0.78))
    private static let nightState = State(sky: V3(0.05, 0.065, 0.12), ground: V3(0.045, 0.05, 0.07), hemi: 0.9, key: V3(0.7, 0.78, 1.0), keyI: 0.75, fog: V3(0.006, 0.008, 0.014))

    /// When starting (dt 0) the amounts jump straight to the settings, so a night launch is dark from the first frame.
    func update(dt: Float, settings: Settings, out L: inout Light, snowing: Float) {
        t += dt
        // The cloud thins and thickens over minutes; in Sunlight mode the sun comes and goes a little too.
        let wobble = sin(t * 0.011) * sin(t * 0.0073 + 1.1)
        thin = approach(thin, 0.5 + 0.5 * wobble, 20, dt)
        let sunTarget: Float = settings.sunlight ? 0.8 + 0.2 * thin : 0.08 * thin
        let nightTarget: Float = settings.night ? 1 : 0
        if dt == 0 {
            sun = sunTarget
            night = nightTarget
        } else {
            sun = approach(sun, sunTarget, 5, dt)
            night = approach(night, nightTarget, 2.5, dt)
        }
        let O = Weather.overcast, S = Weather.sunny, N = Weather.nightState
        let daySky = lerp(O.sky, S.sky, sun), dayGround = lerp(O.ground, S.ground, sun)
        let dayHemi = lerp(O.hemi, S.hemi, sun), dayKey = lerp(O.key, S.key, sun)
        let dayKeyI = lerp(O.keyI, S.keyI, sun), dayFog = lerp(O.fog, S.fog, sun)
        // At night the moon is the key light; under cloud it is only a glow.
        let nightKeyI = N.keyI * (0.03 + 0.97 * sun)
        let nightHemi = N.hemi * (0.6 + 0.4 * sun)
        L.sun = sun
        L.night = night
        L.snowing = snowing
        L.sky = lerp(daySky, N.sky, night)
        L.ground = lerp(dayGround, N.ground, night)
        L.hemi = lerp(dayHemi, nightHemi, night)
        L.sunColor = dayKey
        L.sunI = dayKeyI * (1 - night)
        L.moonColor = N.key
        L.moonI = nightKeyI * night
        // Falling snow lightens and thickens the haze by day, and greys the dark at night a little.
        let snowFog = V3(0.70, 0.71, 0.74), snowNightFog = V3(0.02, 0.023, 0.03)
        let dFog = lerp(dayFog, snowFog, snowing * (1 - sun * 0.5))
        let nFog = lerp(N.fog, snowNightFog, snowing)
        L.fog = lerp(dFog, nFog, night)
        L.skyLight = L.sky * (L.hemi / .pi)
        // Falling snow closes the haze in; at night it closes in further.
        L.fogNear = lerp(lerp(12, 5, snowing), 8, night)
        L.fogFar = lerp(lerp(150, 70, snowing), lerp(110, 60, snowing), night)
    }
}

/// The sky dome. Overcast: a pale grey stratus, brighter toward the hidden sun and the horizon,
/// its mottling drifting slowly. Sun: the cloud thins into broken cumulus over blue, with the sun's
/// disc and glare. Night: a deep blue, stars hashed in the shader, and the moon's halo.
final class Sky {
    private let mesh = Geometry.sphere(radius: skyRadius, widthSegments: 48, heightSegments: 32).upload()

    func draw(_ ctx: DrawContext) {
        ctx.use("skyVertex", "skyFragment", depthWrite: false)
        mesh.draw(ctx.encoder)
    }
}

/// The moon: a sphere wrapped in NASA's Lunar Reconnaissance Orbiter colour map, with its height
/// map as a bump map, lit by its own sun so the phase and the relief along the terminator are
/// real. (Maps: NASA's Scientific Visualization Studio CGI Moon Kit, svs.gsfc.nasa.gov/4720.)
final class Moon {
    private struct Params { var model: simd_float4x4; var sun: V4; var opacity: V4 }

    private let mesh: GPUMesh
    private let colorMap: MTLTexture?
    private let bumpMap: MTLTexture?
    private var params: Params

    init() {
        let distance = skyRadius * 0.9
        // Drawn about twice its real size, as the eye remembers it over the trees.
        let radius = distance * tan(0.55 * .pi / 180)
        mesh = Geometry.sphere(radius: radius, widthSegments: 96, heightSegments: 64).upload()
        colorMap = Assets.url("lroc_color_2k.jpg").flatMap { GPU.shared.load($0, srgb: true) }
        bumpMap = Assets.url("ldem_3_8bit.jpg").flatMap { GPU.shared.load($0, srgb: false) }
        let toViewer = -moonDir
        // The moon's own sun, off to the right and a little toward us: a waxing gibbous.
        let right = moonDir.cross(V3(0, 1, 0)).normalized
        let sun = (right * 0.9 + toViewer * 0.62 + V3(0, 0.1, 0)).normalized
        params = Params(model: simd_float4x4(translation: moonDir * distance) * simd_float4x4(quatFromTo(V3(1, 0, 0), toViewer)),
                        sun: V4(sun, 0), opacity: .zero)
    }

    /// The moon shows at night when the cloud has broken (Sunlight mode doubles as a clear sky).
    func draw(_ ctx: DrawContext, night: Float, sun: Float) {
        params.opacity.x = clamp(night, 0, 1) * clamp(sun, 0, 1)
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

    fragment float4 skyFragment(SkyOut in [[stage_in]], constant Frame& F [[buffer(0)]]) {
        float uTime = F.misc.x, uSun = F.misc.y, uNight = F.misc.z, uSnowing = F.misc.w;
        float3 d = normalize(in.dir);
        float h = d.y;
        // Cloud texture: slow-drifting stratus mottling, in a sky-centred projection.
        float2 cuv = d.xz / (abs(h) + 0.25);
        float drift = uTime * q(0.004);
        float strat = fbm(cuv * 1.6 + float2(drift, drift * 0.4)) * 0.6 + fbm(cuv * 5.0 - float2(drift * 0.7, 0.0)) * 0.4;
        float cosS = dot(d, F.sunDir.xyz);

        // Overcast: flat pale grey, a little darker overhead, brightest low and toward the sun.
        float3 ovHorizon = float3(0.56, 0.58, 0.62);
        float3 ovZenith = float3(0.30, 0.33, 0.39);
        float3 overcast = mix(ovHorizon, ovZenith, pow(clamp(h * 1.2, 0.0, 1.0), 0.6));
        overcast *= 0.9 + 0.22 * (strat - 0.5);
        overcast += float3(0.16, 0.15, 0.13) * exp((cosS - 1.0) * 6.0) * (0.5 + 0.5 * strat);
        // Falling snow: the sky goes to a flat, very light grey, the cloud lost in the flakes.
        overcast = mix(overcast, float3(0.70, 0.71, 0.74) * (0.96 + 0.08 * strat), uSnowing * 0.85);

        // Broken cloud and sun: blue sky with cumulus, sunlit on their sunward edges. (Each mode's
        // sky is only worked out while it shows; the web version computes all three everywhere.)
        float3 day = overcast;
        float cum = 0.0;
        if (uSun > 0.001) {
        float3 blue = mix(float3(0.42, 0.55, 0.78), float3(0.14, 0.26, 0.58), pow(clamp(h * 1.3, 0.0, 1.0), 0.7));
        cum = smoothstep(0.42, 0.6, fbm(cuv * 2.2 + float2(drift * 1.5, 7.0)) + 0.15 * strat - 0.1 * uSun);
        float3 cloudCol = mix(float3(0.5, 0.52, 0.58), float3(1.05, 1.0, 0.95), 0.4 + 0.6 * clamp(cosS, 0.0, 1.0));
        float3 sunny = mix(blue, cloudCol, cum * 0.85);
        float disc = exp((cosS - 1.0) * 2200.0) * 12.0 + exp((cosS - 1.0) * 60.0) * 0.5 + exp((cosS - 1.0) * 8.0) * 0.25;
        sunny += float3(1.0, 0.95, 0.85) * disc * (1.0 - cum * 0.85);
        // Haze near the horizon.
        sunny = mix(sunny, float3(0.7, 0.72, 0.76), sstep(0.3, -0.02, h) * 0.75);

        day = mix(overcast, sunny, uSun);
        }

        float3 col = day;
        if (uNight > 0.001) {
        // Night: deep blue, stars, the moon's halo and a hint of the 22-degree ice halo.
        float3 night = mix(float3(0.012, 0.018, 0.04), float3(0.002, 0.004, 0.012), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
        float2 uv = float2(atan2(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
        if (uSun > 0.001 && h > -0.02) {
            float3 stars = starLayer(uv, 380.0, 0.75, 1.2, 0.0, uTime) + starLayer(uv, 760.0, 0.84, 0.6, 5.0, uTime) + starLayer(uv, 1400.0, 0.9, 0.3, 11.0, uTime);
            night += stars * smoothstep(-0.02, 0.08, h);
        }
        float cosM = dot(d, F.moonDir.xyz);
        float halo = exp((cosM - 1.0) * 90.0) * 0.05 + exp((cosM - 1.0) * 900.0) * 0.25;
        float ring = exp(-pow((acos(clamp(cosM, -1.0, 1.0)) - 0.384) / 0.012, 2.0)) * 0.012;
        night += float3(0.5, 0.6, 0.85) * (halo + ring);
        // Snow cloud at night: the stars dim behind the overcast, the cloud faintly moonlit.
        float3 nightCloud = float3(0.02, 0.025, 0.04) * (0.7 + 0.6 * strat) + float3(0.06, 0.07, 0.1) * exp((cosM - 1.0) * 6.0);
        night = mix(nightCloud, night, uSun);

        col = mix(day, night, uNight);
        }
        // Fade into the haze just above the horizon, so the far grove meets the sky seamlessly.
        col = mix(col, F.fogColor.xyz, sstep(0.06, -0.01, h));
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
        float h = bumpMap.sample(s, tv(in.uv)).r;
        float3 n = perturbByHeight(normalize(in.n), in.rel, h, 1.4);
        float lit = max(dot(n, P.sun.xyz), 0.0);
        return float4(albedo * (lit * 3.2 + 0.012), P.opacity.x);
    }

    """
}
