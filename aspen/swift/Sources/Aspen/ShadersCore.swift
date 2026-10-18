/// Metal shaders, compiled at launch (`GPU`). Ported from the web version's GLSL, plus the parts of
/// three.js the web version leans on: MeshStandardMaterial's lighting (the hemisphere light and the
/// two key lights, sun and moon, each with its shadow map, with GGX highlights), its fog, and the
/// post-processing (bloom, the vignette, tone mapping).
///
/// Texture orientation: images drawn on a `Canvas` are uploaded with row 0 at the top, while the web
/// version's UVs follow WebGL (v = 0 at the bottom), so those are sampled at `tv(uv)` = (u, 1 - v).
/// Data textures (the bark, the prints, the baked shadow maps) are uploaded in the web version's row
/// order with flipY off, so they are sampled at `uv` directly.
enum Shaders {
    static var source: String { core + tree + ground + sky + snow + hare + grouse }

    static let core = """
    #include <metal_stdlib>
    using namespace metal;

    /// Everything shared by every draw in a pass (written by `FrameUniforms`).
    struct Frame {
        float4x4 viewProj;
        float4x4 view;
        float4x4 proj;
        float4x4 shadow0;       // world to the sun's shadow camera (clip space)
        float4x4 shadow1;       // world to the moon's
        float4 camera;          // xyz = camera position
        float4 misc;            // x = time (wraps hourly), y = sun (0..1), z = night, w = snowing
        float4 wind;            // xy = the ambient wind at the crowns (m/s, x and z)
        float4 sunDir;
        float4 moonDir;
        float4 keyDir;          // the glints' light: the sun by day, the moon at night
        float4 sunColor;        // linear colour x intensity; w = 1 if its shadow map is live
        float4 moonColor;
        float4 hemiSky;         // the hemisphere light's sky colour x intensity
        float4 hemiGround;
        float4 skyLight;        // the sky's light on an upward face (uSkyLight)
        float4 fogColor;
        float4 fog;             // x = near, y = far
        float4 screen;          // xy = drawable size in pixels, z = pixels per metre at 1 m (point sprites), w = 1 with MSAA
    };

    constant float QK = \(timeWrap / (2 * Double.pi));
    /// Round an angular frequency to a whole number of cycles per hourly wrap.
    inline float q(float w) { return floor(w * QK + 0.5) / QK; }
    /// GLSL-style smoothstep that also works with e0 > e1.
    inline float sstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
    /// WebGL UV (v up) to Metal texture coordinates (row 0 at the top), for canvas images.
    inline float2 tv(float2 uv) { return float2(uv.x, 1.0 - uv.y); }
    /// GLSL's mod (floored).
    inline float fmodGL(float x, float y) { return x - y * floor(x / y); }
    inline float fwidthf(float x) { return abs(dfdx(x)) + abs(dfdy(x)); }
    inline float2 fwidth2(float2 x) { return abs(dfdx(x)) + abs(dfdy(x)); }

    /// Fog by distance from the camera, with a density exponent of 1.3: by day the grove sinks into
    /// snow haze the colour of the sky, at night into the dark.
    inline float fogAmount(constant Frame& F, float dist) {
        return pow(clamp((dist - F.fog.x) / (F.fog.y - F.fog.x), 0.0, 1.0), 1.3);
    }
    inline float3 applyFog(constant Frame& F, float3 c, float dist) { return mix(c, F.fogColor.xyz, fogAmount(F, dist)); }

    // The web version's NOISE_GLSL.
    float hash21(float2 p) { p = fract(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
    float2 hash22(float2 p) { float3 q3 = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973)); q3 += dot(q3, q3.yzx + 33.33); return fract((q3.xx + q3.yz) * q3.zy); }
    float vnoise(float2 p) {
        float2 i = floor(p), f = fract(p); float2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + float2(1.0, 0.0)), u.x), mix(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), u.x), u.y);
    }
    float vnoise1(float x) { float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), u); }
    float fbm(float2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }

    // MARK: - The key lights' shadow maps (three.js's DirectionalLightShadow: bias -0.0004, normal bias 0.05)

    float keyShadow(float4x4 m, depth2d<float> map, sampler cmp, float3 world, float3 normal) {
        float4 c = m * float4(world + normal * 0.05, 1.0);
        float3 p = c.xyz / c.w;
        float2 uv = float2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
        float z = p.z - 0.0004;
        // Outside the shadow camera's box everything is lit.
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || z > 1.0) return 1.0;
        float2 texel = 1.0 / float2(map.get_width(), map.get_height());
        float lit = 0.0;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) lit += map.sample_compare(cmp, uv + float2(x, y) * texel, z);
        }
        return lit / 9.0;
    }

    /// One filtered tap of the shadow map (a 2x2 percentage-closer in hardware): for thin things
    /// like twigs, whose own shadowing nobody can see in detail.
    float keyShadowFast(float4x4 m, depth2d<float> map, sampler cmp, float3 world, float3 normal) {
        float4 c = m * float4(world + normal * 0.05, 1.0);
        float3 p = c.xyz / c.w;
        float2 uv = float2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
        float z = p.z - 0.0004;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || z > 1.0) return 1.0;
        return map.sample_compare(cmp, uv, z);
    }

    float2 keyShadowsFast(constant Frame& F, depth2d<float> sunMap, depth2d<float> moonMap, sampler cmp, float3 world, float3 normal) {
        float s = F.sunColor.w > 0.5 ? keyShadowFast(F.shadow0, sunMap, cmp, world, normal) : 1.0;
        float m = F.moonColor.w > 0.5 ? keyShadowFast(F.shadow1, moonMap, cmp, world, normal) : 1.0;
        return float2(s, m);
    }

    /// Both key lights' shadows at a point: x = the sun's, y = the moon's.
    float2 keyShadows(constant Frame& F, depth2d<float> sunMap, depth2d<float> moonMap, sampler cmp, float3 world, float3 normal) {
        float s = F.sunColor.w > 0.5 ? keyShadow(F.shadow0, sunMap, cmp, world, normal) : 1.0;
        float m = F.moonColor.w > 0.5 ? keyShadow(F.shadow1, moonMap, cmp, world, normal) : 1.0;
        return float2(s, m);
    }

    // MARK: - MeshStandardMaterial's lighting (three.js r170, physically based)

    float3 brdfGGX(float3 l, float3 v, float3 n, float3 f0, float roughness) {
        float alpha = roughness * roughness;
        float3 h = normalize(l + v);
        float dotNL = saturate(dot(n, l)), dotNV = saturate(dot(n, v));
        float dotNH = saturate(dot(n, h)), dotVH = saturate(dot(v, h));
        float fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
        float3 Fr = f0 * (1.0 - fresnel) + fresnel;
        float a2 = alpha * alpha;
        float gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
        float gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
        float V = 0.5 / max(gv + gl, 1e-6);
        float denom = dotNH * dotNH * (a2 - 1.0) + 1.0;
        float D = M_1_PI_F * a2 / (denom * denom);
        return Fr * (V * D);
    }

    /// Roughness grows where the geometric normal changes fast across a pixel (three.js's geometryRoughness).
    inline float geometryRoughness(float3 n) {
        float3 dxy = max(abs(dfdx(n)), abs(dfdy(n)));
        return max(max(dxy.x, dxy.y), dxy.z);
    }

    /// The sun, the moon (each with its shadow) and the hemisphere light on a surface; no emissive, no fog.
    float3 standardLight(constant Frame& F, float3 albedo, float3 n, float3 world, float roughness, float metalness,
                         float2 shadow, float geoRough) {
        float3 v = normalize(F.camera.xyz - world);
        float3 diffuse = albedo * (1.0 - metalness);
        float3 f0 = mix(float3(0.04), albedo, metalness);
        float r = min(max(roughness, 0.0525) + geoRough, 1.0);
        float3 brdf = diffuse * M_1_PI_F;
        float3 c = saturate(dot(n, F.sunDir.xyz)) * F.sunColor.xyz * shadow.x * (brdf + brdfGGX(F.sunDir.xyz, v, n, f0, r));
        c += saturate(dot(n, F.moonDir.xyz)) * F.moonColor.xyz * shadow.y * (brdf + brdfGGX(F.moonDir.xyz, v, n, f0, r));
        float3 hemi = mix(F.hemiGround.xyz, F.hemiSky.xyz, 0.5 * n.y + 0.5);
        return c + hemi * brdf;
    }

    /// Tilt a normal by a bump height's screen-space gradient (the method of three's bump map).
    float3 perturbByHeight(float3 n, float3 pos, float h, float scale) {
        float3 sx = dfdx(pos), sy = -dfdy(pos);
        float hx = dfdx(h) * scale, hy = -dfdy(h) * scale;
        float3 r1 = cross(sy, n), r2 = cross(n, sx);
        float det = dot(sx, r1);
        float3 g = sign(det) * (hx * r1 + hy * r2);
        return normalize(abs(det) * n - g);
    }

    // MARK: - Standard parts (eyes, noses, beaks, legs)

    struct StdParams {
        float4x4 model;
        float4 color;       // linear albedo; a = opacity
        float4 emissive;
        float4 material;    // x = roughness, y = metalness, z = flags: 1 map, 2 receives shadow, 4 double-sided, 8 clamp the map, 16 unlit, 32 no fog
        float4 uv;          // xy = repeat, zw = offset
    };

    struct StdInstance { float4x4 model; float4 color; };

    struct StdOut { float4 position [[position]]; float3 world; float3 normal; float2 uv; float4 color; };

    /// A normal through `m`'s inverse transpose (its cofactor matrix, up to scale), so stretched
    /// parts shade correctly.
    inline float3 transformNormal(float4x4 m, float3 n) {
        float3 c0 = m[0].xyz, c1 = m[1].xyz, c2 = m[2].xyz;
        float3 t = float3x3(cross(c1, c2), cross(c2, c0), cross(c0, c1)) * n;
        // A degenerate vertex (the pinched end of a lofted ear) has no normal; normalising zero gives
        // NaN, and one NaN pixel is enough for the bloom to blacken a square of the screen.
        return length_squared(t) > 1e-20 ? normalize(t) : float3(0.0, 1.0, 0.0);
    }

    StdOut stdOut(constant Frame& F, float4x4 model, float3 p, float3 n, float2 uv, float4 color) {
        float4 w = model * float4(p, 1.0);
        StdOut o;
        o.world = w.xyz;
        o.normal = transformNormal(model, n);
        o.uv = uv;
        o.color = color;
        o.position = F.viewProj * w;
        return o;
    }

    /// `verts`: (position xyz, u), (normal xyz, v) per vertex.
    vertex StdOut stdVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                            constant Frame& F [[buffer(1)]], constant StdParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        return stdOut(F, P.model, a.xyz, b.xyz, float2(a.w, b.w), P.color);
    }

    vertex StdOut stdInstancedVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                                     constant Frame& F [[buffer(1)]], constant StdParams& P [[buffer(2)]],
                                     device const StdInstance* inst [[buffer(3)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        return stdOut(F, P.model * inst[iid].model, a.xyz, b.xyz, float2(a.w, b.w), P.color * inst[iid].color);
    }

    fragment float4 stdFragment(StdOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                constant StdParams& P [[buffer(1)]], texture2d<float> map [[texture(0)]],
                                depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                sampler rs [[sampler(0)]], sampler cs [[sampler(1)]], sampler cmp [[sampler(2)]]) {
        int flags = int(P.material.z + 0.5);
        float4 albedo = in.color;
        if (flags & 1) {
            float2 uv = in.uv * P.uv.xy + P.uv.zw;
            albedo *= (flags & 8) ? map.sample(cs, tv(uv)) : map.sample(rs, tv(uv));
        }
        float3 c;
        if (flags & 16) {
            c = albedo.rgb;
        } else {
            float3 n = length_squared(in.normal) > 1e-12 ? normalize(in.normal) : float3(0.0, 1.0, 0.0);
            if ((flags & 4) && !front) n = -n;
            float geo = geometryRoughness(n);
            float2 shadow = (flags & 2) ? keyShadows(F, sunMap, moonMap, cmp, in.world, n) : float2(1.0);
            c = standardLight(F, albedo.rgb, n, in.world, P.material.x, P.material.y, shadow, geo);
        }
        c += P.emissive.rgb;
        if (!(flags & 32)) c = applyFog(F, c, length(in.world - F.camera.xyz));
        return float4(c, albedo.a);
    }

    // MARK: - Standard parts in the key lights' shadow passes

    struct ShadowOut { float4 position [[position]]; };

    /// In a shadow pass `F.viewProj` is the light's matrix (the pass writes its own `Frame`).
    vertex ShadowOut stdShadowVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                     constant Frame& F [[buffer(1)]], constant StdParams& P [[buffer(2)]]) {
        ShadowOut o;
        o.position = F.viewProj * (P.model * float4(verts[vid * 2].xyz, 1.0));
        return o;
    }

    vertex ShadowOut stdInstancedShadowVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                                              constant Frame& F [[buffer(1)]], constant StdParams& P [[buffer(2)]],
                                              device const StdInstance* inst [[buffer(3)]]) {
        ShadowOut o;
        o.position = F.viewProj * (P.model * inst[iid].model * float4(verts[vid * 2].xyz, 1.0));
        return o;
    }

    // MARK: - Post-processing: three.js's UnrealBloomPass, then the vignette and tone mapping

    struct PostOut { float4 position [[position]]; float2 uv; };

    vertex PostOut postVertex(uint vid [[vertex_id]]) {
        float2 p = float2(float((vid << 1) & 2), float(vid & 2));
        PostOut o;
        o.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
        o.uv = float2(p.x, 1.0 - p.y);
        return o;
    }

    /// Keep only what's brighter than the threshold.
    fragment float4 highPassFragment(PostOut in [[stage_in]], texture2d<float> src [[texture(0)]], sampler s [[sampler(0)]],
                                     constant float4& P [[buffer(0)]]) {
        float4 c = src.sample(s, in.uv);
        // A NaN or infinite pixel would be blurred over a whole bloom level into a black square.
        if (any(!isfinite(c))) return float4(0.0);
        float v = dot(c.rgb, float3(0.299, 0.587, 0.114));
        float a = smoothstep(P.x, P.x + 0.01, v);
        return mix(float4(0.0), c, a);
    }

    /// One direction of a separable Gaussian. P: xy = direction x texel size, z = kernel radius.
    fragment float4 blurFragment(PostOut in [[stage_in]], texture2d<float> src [[texture(0)]], sampler s [[sampler(0)]],
                                 constant float4& P [[buffer(0)]], constant float* weights [[buffer(1)]]) {
        float weightSum = weights[0];
        float3 sum = src.sample(s, in.uv).rgb * weightSum;
        int radius = int(P.z);
        for (int i = 1; i < radius; i++) {
            float w = weights[i];
            float2 off = P.xy * float(i);
            sum += (src.sample(s, in.uv + off).rgb + src.sample(s, in.uv - off).rgb) * w;
            weightSum += 2.0 * w;
        }
        return float4(sum / weightSum, 1.0);
    }

    /// The five blurred levels, weighted. Alpha carries the summed weight, as in three.js, where
    /// the composite is then added to the scene with source-alpha blending.
    fragment float4 bloomCompositeFragment(PostOut in [[stage_in]], sampler s [[sampler(0)]],
                                           texture2d<float> b0 [[texture(0)]], texture2d<float> b1 [[texture(1)]],
                                           texture2d<float> b2 [[texture(2)]], texture2d<float> b3 [[texture(3)]],
                                           texture2d<float> b4 [[texture(4)]],
                                           constant float4& f0 [[buffer(0)]], constant float4& f1 [[buffer(1)]]) {
        float strength = f1.y;
        return strength * (f0.x * b0.sample(s, in.uv) + f0.y * b1.sample(s, in.uv) + f0.z * b2.sample(s, in.uv)
                         + f0.w * b3.sample(s, in.uv) + f1.x * b4.sample(s, in.uv));
    }

    float3 rrtAndOdtFit(float3 v) {
        float3 a = v * (v + 0.0245786) - 0.000090537;
        float3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return a / b;
    }

    /// three.js's ACESFilmicToneMapping.
    float3 acesFilmic(float3 color) {
        const float3x3 inputMat = float3x3(float3(0.59719, 0.07600, 0.02840), float3(0.35458, 0.90834, 0.13383), float3(0.04823, 0.01566, 0.83777));
        const float3x3 outputMat = float3x3(float3(1.60475, -0.10208, -0.00327), float3(-0.53108, 1.10813, -0.07276), float3(-0.07367, -0.00605, 1.07602));
        color *= 1.0 / 0.6;
        color = inputMat * color;
        color = rrtAndOdtFit(color);
        color = outputMat * color;
        return saturate(color);
    }

    float3 linearToSRGB(float3 c) {
        return select(pow(c, float3(0.41666)) * 1.055 - 0.055, c * 12.92, c <= 0.0031308);
    }

    /// Scene + bloom, then the web version's GradeShader (a soft vignette, in linear HDR), then ACES and sRGB.
    fragment float4 outputFragment(PostOut in [[stage_in]], sampler s [[sampler(0)]],
                                   texture2d<float> scene [[texture(0)]], texture2d<float> bloom [[texture(1)]],
                                   constant float4& debug [[buffer(0)]]) {
        float3 c = scene.sample(s, in.uv).rgb;
        if (any(!isfinite(c))) return debug.x > 0.5 ? float4(1.0, 0.0, 1.0, 1.0) : float4(0.0, 0.0, 0.0, 1.0);
        float4 b = bloom.sample(s, in.uv);
        c += b.rgb * b.a;
        float d = length(in.uv - 0.5) * 1.35;
        c *= 1.0 - 0.22 * pow(clamp(d, 0.0, 1.0), 2.6);
        c = max(c, 0.0);
        return float4(linearToSRGB(acesFilmic(c)), 1.0);
    }

    """
}
