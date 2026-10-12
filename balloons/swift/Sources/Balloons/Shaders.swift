/// Metal shaders, compiled at launch (`GPU`). Ported from the web version's GLSL, plus the parts of
/// three.js the web version leans on: MeshStandardMaterial's lighting (the sun, the hemisphere light
/// and the burners' point lights, with GGX highlights), its normal and bump mapping, the sun's
/// shadow map, the fog, and the post-processing (bloom, grade, tone mapping).
///
/// Textures are uploaded with row 0 at the top (as drawn), while the web version's UVs follow
/// WebGL (v = 0 at the bottom), so the shaders sample at `tv(uv)` = (u, 1 - v).
enum Shaders {
    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    #define BURNER_N \(burnerLightCount)

    /// Everything shared by every draw in a frame (written by `FrameUniforms`).
    struct Frame {
        float4x4 viewProj;
        float4x4 view;
        float4x4 proj;
        float4x4 shadow;        // world to the sun's shadow camera (clip space)
        float4 camera;          // xyz = camera position
        float4 misc;            // x = time (wraps hourly), y = drawable height in pixels, z = night (0 dawn ... 1 night glow)
        float4 sunDir;          // xyz = toward the sun
        float4 sunColor;        // the sun's light: linear colour x intensity
        float4 hemiSky;         // the hemisphere light's sky colour x intensity
        float4 hemiGround;      // ... and its ground colour
        float4 fogColor;
        float4 fog;             // x = near, y = far
        float4 gust;            // the gust the grass feels: xy = direction on the ground, z = strength
        float4 burners[BURNER_N];       // burners glinting off the grass: xyz, intensity
        float4 lights[BURNER_N];        // the burners' point lights: xyz; w = 1 when lit
        float4 lightColor[BURNER_N];    // linear colour x intensity
    };

    constant float QK = \(timeWrap / (2 * Double.pi));
    /// Round an angular frequency to a whole number of cycles per hourly wrap.
    inline float q(float w) { return floor(w * QK + 0.5) / QK; }
    /// GLSL-style smoothstep that also works with e0 > e1.
    inline float sstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
    /// WebGL UV (v up) to Metal texture coordinates (row 0 at the top).
    inline float2 tv(float2 uv) { return float2(uv.x, 1.0 - uv.y); }
    /// Screen-space derivatives in y as WebGL measures them (window y up).
    inline float2 dfdyGL(float2 v) { return -dfdy(v); }
    inline float3 dfdyGL(float3 v) { return -dfdy(v); }

    /// Fog by distance from the camera, with a density exponent of 1.3, as every background uses.
    inline float fogAmount(constant Frame& F, float dist) {
        return pow(clamp((dist - F.fog.x) / (F.fog.y - F.fog.x), 0.0, 1.0), 1.3);
    }
    inline float3 applyFog(constant Frame& F, float3 c, float dist) { return mix(c, F.fogColor.xyz, fogAmount(F, dist)); }

    float hash21(float2 p) { p = fract(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vnoise(float2 p) {
        float2 i = floor(p), f = fract(p); float2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + float2(1.0, 0.0)), u.x), mix(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(float2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }

    // MARK: - The sun's shadow map (three.js's DirectionalLightShadow: bias -0.0003, normal bias 0.12)

    float sunShadow(constant Frame& F, depth2d<float> map, sampler cmp, float3 world, float3 normal) {
        float4 c = F.shadow * float4(world + normal * 0.12, 1.0);
        float3 p = c.xyz / c.w;
        float2 uv = float2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
        float z = p.z - 0.0003;
        // Outside the shadow camera's box everything is lit.
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || z > 1.0) return 1.0;
        float2 texel = 1.0 / float2(map.get_width(), map.get_height());
        float lit = 0.0;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) lit += map.sample_compare(cmp, uv + float2(x, y) * texel, z);
        }
        return lit / 9.0;
    }

    // MARK: - MeshStandardMaterial's lighting (three.js r170, physically based)

    float3 brdfGGX(float3 l, float3 v, float3 n, float3 f0, float roughness) {
        float alpha = roughness * roughness;
        float3 h = normalize(l + v);
        float dotNL = saturate(dot(n, l)), dotNV = saturate(dot(n, v));
        float dotNH = saturate(dot(n, h)), dotVH = saturate(dot(v, h));
        float fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
        float3 F = f0 * (1.0 - fresnel) + fresnel;
        float a2 = alpha * alpha;
        float gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
        float gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
        float V = 0.5 / max(gv + gl, 1e-6);
        float denom = dotNH * dotNH * (a2 - 1.0) + 1.0;
        float D = M_1_PI_F * a2 / (denom * denom);
        return F * (V * D);
    }

    /// Roughness grows where the geometric normal changes fast across a pixel (three.js's geometryRoughness).
    inline float geometryRoughness(float3 n) {
        float3 dxy = max(abs(dfdx(n)), abs(dfdy(n)));
        return max(max(dxy.x, dxy.y), dxy.z);
    }

    /// The sun (with its shadow), the burners' point lights (range 30 m, inverse-square) and the
    /// hemisphere light on a surface; no emissive and no fog.
    float3 standardLight(constant Frame& F, float3 albedo, float3 n, float3 world, float roughness, float metalness,
                         float shadow, float geoRough) {
        float3 v = normalize(F.camera.xyz - world);
        float3 diffuse = albedo * (1.0 - metalness);
        float3 f0 = mix(float3(0.04), albedo, metalness);
        float r = min(max(roughness, 0.0525) + geoRough, 1.0);
        float3 l = F.sunDir.xyz;
        float3 c = saturate(dot(n, l)) * F.sunColor.xyz * shadow * (diffuse * M_1_PI_F + brdfGGX(l, v, n, f0, r));
        for (int i = 0; i < BURNER_N; i++) {
            if (F.lights[i].w <= 0.0) continue;
            float3 d = F.lights[i].xyz - world;
            float dist = length(d);
            float3 ld = d / max(dist, 1e-4);
            float cut = saturate(1.0 - pow(dist / 30.0, 4.0));
            float3 col = F.lightColor[i].xyz * (1.0 / max(dist * dist, 0.01)) * cut * cut;
            c += saturate(dot(n, ld)) * col * (diffuse * M_1_PI_F + brdfGGX(ld, v, n, f0, r));
        }
        float3 hemi = mix(F.hemiGround.xyz, F.hemiSky.xyz, 0.5 * n.y + 0.5);
        return c + hemi * diffuse * M_1_PI_F;
    }

    // MARK: - Sky dome

    float3 starLayer(float time, float2 uv, float cells, float threshold, float gain, float seed) {
        float2 g = uv * float2(cells * 2.0, cells);
        float2 cell = floor(g), f = fract(g);
        float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
        if (r1 < threshold) return float3(0.0);
        float dist = length(f - (float2(r2, r3) * 0.7 + 0.15));
        float bright = pow((r1 - threshold) / (1.0 - threshold), 6.0) * gain + 0.03;
        float tw = 0.75 + 0.25 * sin(time * q(0.8 + r3 * 2.5) + r2 * 6.2831);
        float3 tint = r4 < 0.22 ? float3(0.72, 0.82, 1.0) : r4 < 0.6 ? float3(0.95, 0.96, 1.0) : r4 < 0.86 ? float3(1.0, 0.9, 0.72) : float3(1.0, 0.72, 0.5);
        float size = 0.07 + 0.12 * pow(bright / (gain + 0.03), 0.5);
        return tint * sstep(size, 0.0, dist) * bright * tw;
    }

    struct SkyOut { float4 position [[position]]; float3 dir; };

    vertex SkyOut skyVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        SkyOut o;
        float3 p = verts[vid * 2].xyz;
        o.dir = p;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 skyFragment(SkyOut in [[stage_in]], constant Frame& F [[buffer(0)]]) {
        float time = F.misc.x, night = F.misc.z;
        float3 sunDir = F.sunDir.xyz, fogColor = F.fogColor.xyz;
        float3 d = normalize(in.dir);
        float h = d.y;
        float cosS = dot(d, sunDir);

        // Dawn: warm at the horizon, violet through the middle, deep blue overhead, with the sun's glow.
        float3 horizon = fogColor * 1.15, mid = float3(0.45, 0.38, 0.58), zenith = float3(0.07, 0.15, 0.4);
        float3 dawn = mix(horizon, mid, smoothstep(0.0, 0.14, h));
        dawn = mix(dawn, zenith, smoothstep(0.08, 0.45, h));
        float glow = exp((cosS - 1.0) * 90.0) * 0.55 + exp((cosS - 1.0) * 900.0) * 0.9 + pow(max(cosS, 0.0), 10.0) * 0.18;
        dawn += float3(1.0, 0.7, 0.4) * glow;
        float disc = smoothstep(0.99985, 0.99994, cosS);
        dawn += float3(3.2, 2.4, 1.6) * disc;
        // Cirrus: streaks blown across the upper sky, lit from the sun's side.
        float2 cp = d.xz / max(h, 0.04);
        float c = fbm(float2(cp.x * 0.35 + time * q(0.003), cp.y * 1.4) * 1.2);
        float cir = smoothstep(0.48, 0.78, c) * smoothstep(0.03, 0.18, h) * sstep(0.9, 0.3, h) * 0.65;
        float3 cirCol = mix(float3(0.72, 0.5, 0.52), float3(1.0, 0.88, 0.72), clamp(glow * 1.5, 0.0, 1.0));
        dawn = mix(dawn, cirCol, cir);

        // Night: a dark blue vault full of stars.
        float3 nightCol = mix(float3(0.05, 0.07, 0.14), float3(0.008, 0.012, 0.04), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
        float2 uv = float2(atan2(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
        nightCol += starLayer(time, uv, 380.0, 0.75, 1.5, 0.0) + starLayer(time, uv, 760.0, 0.84, 0.8, 5.0);

        float3 col = mix(dawn, nightCol, night);
        col = mix(col, fogColor, sstep(0.1, -0.01, h));
        return float4(col, 1.0);
    }

    // MARK: - Textured quads: the mountain ridges and the burner flames

    struct QuadParams {
        float4x4 model;
        float4 color;       // ridges: linear tint
        float4 extra;       // ridges: x = most fog allowed; flames: x = burn
    };

    struct QuadOut { float4 position [[position]]; float2 uv; float dist; };

    /// A unit quad (x, y in -0.5...0.5, facing +z) drawn as a 4-vertex triangle strip.
    vertex QuadOut quadVertex(uint vid [[vertex_id]], constant Frame& F [[buffer(0)]], constant QuadParams& P [[buffer(1)]]) {
        float2 c = float2(float(vid & 1) - 0.5, float((vid >> 1) & 1) - 0.5);
        float4 w = P.model * float4(c, 0.0, 1.0);
        QuadOut o;
        o.uv = c + 0.5;
        o.dist = length((F.view * w).xyz);
        o.position = F.viewProj * w;
        return o;
    }

    /// A ridge silhouette dissolving into the haze, but only so far, so each stays a distinct layer.
    fragment float4 ridgeFragment(QuadOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant QuadParams& P [[buffer(1)]],
                                  texture2d<float> mask [[texture(0)]], sampler s [[sampler(0)]]) {
        if (mask.sample(s, tv(in.uv)).r < 0.5) discard_fragment();
        float f = min(fogAmount(F, in.dist), P.extra.x);
        float3 tint = mix(P.color.rgb, float3(0.006, 0.008, 0.016), F.misc.z);
        return float4(mix(tint, F.fogColor.xyz, f), 1.0);
    }

    /// The burner's flame: a noisy tongue of fire, white-hot at its core (blended additively).
    fragment float4 flameFragment(QuadOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant QuadParams& P [[buffer(1)]]) {
        float2 p = in.uv;
        float burn = P.extra.x;
        float n = fbm(float2(p.x * 4.0, p.y * 2.5 - F.misc.x * q(2.2)));
        float width = 0.42 - 0.3 * p.y;
        float core = sstep(width, width * 0.2, abs(p.x - 0.5) + (n - 0.5) * 0.25 * (0.3 + p.y));
        float env = smoothstep(0.0, 0.08, p.y) * sstep(1.0, 0.45, p.y);
        float a = clamp(core * env * burn, 0.0, 1.0);
        float3 col = mix(float3(1.0, 0.45, 0.08), float3(1.0, 0.95, 0.7), core * 0.8);
        return float4(col * a * 3.5, a);
    }

    // MARK: - Mist: huge soft sprites over the valley floor

    struct MistOut { float4 position [[position]]; float2 uv; float opacity; float dist; };

    /// `inst`: (centre xyz, opacity), (scale x, scale y, -, -).
    vertex MistOut mistVertex(uint vid [[vertex_id]], device const float4* inst [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        float4 a = inst[0], b = inst[1];
        float2 c = float2(float(vid & 1) - 0.5, float((vid >> 1) & 1) - 0.5);
        float4 mv = F.view * float4(a.xyz, 1.0);
        mv.xy += c * b.xy;
        MistOut o;
        o.uv = c + 0.5;
        o.opacity = a.w;
        o.dist = length(mv.xyz);
        o.position = F.proj * mv;
        return o;
    }

    fragment float4 mistFragment(MistOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                 texture2d<float> map [[texture(0)]], sampler s [[sampler(0)]]) {
        float4 t = map.sample(s, tv(in.uv));
        float3 tint = F.fogColor.xyz * 1.1 + 0.05;
        return float4(applyFog(F, tint * t.rgb, in.dist), t.a * in.opacity);
    }

    // MARK: - The land

    struct SurfaceOut { float4 position [[position]]; float3 world; float3 normal; float2 uv; };

    /// `verts`: (position xyz, u), (normal xyz, v) per vertex.
    vertex SurfaceOut groundVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        SurfaceOut o;
        o.world = a.xyz;
        o.normal = b.xyz;
        o.uv = float2(a.w, b.w);
        o.position = F.viewProj * float4(a.xyz, 1.0);
        return o;
    }

    fragment float4 groundFragment(SurfaceOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                   texture2d<float> map [[texture(0)]], texture2d<float> detail [[texture(1)]],
                                   depth2d<float> shadowMap [[texture(2)]],
                                   sampler s [[sampler(0)]], sampler rs [[sampler(1)]], sampler cmp [[sampler(2)]]) {
        float3 albedo = map.sample(s, tv(in.uv)).rgb;
        // Grass detail close to the viewer, so the hill isn't a blur of one texel.
        float3 det = detail.sample(rs, tv(in.world.xz / 9.0)).rgb * detail.sample(rs, tv(in.world.xz / 61.0 + 0.3)).rgb;
        albedo *= mix(float3(1.0), det, 0.8);
        // Under the long grass the ground is in its shade.
        albedo *= 1.0 - 0.55 * (1.0 - smoothstep(12.0, 85.0, length(in.world.xz)));
        float3 n = normalize(in.normal);
        float shadow = sunShadow(F, shadowMap, cmp, in.world, n);
        float3 c = standardLight(F, albedo, n, in.world, 0.95, 0.0, shadow, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    // MARK: - Long grass (instanced)

    /// Bend a blade by the wind and the gust. `tmpl`: x across -0.5...0.5, t up 0...1. `a`, `b`: the
    /// instance's (base xyz, height), (width, yaw, phase, variety).
    void bendBlade(constant Frame& F, float2 v, float4 a, float4 b, float3 eye,
                   thread float3& p, thread float3& n, thread float3& acrossOut) {
        float t = v.y;
        float3 base = a.xyz; float h = a.w;
        float w = b.x, yaw = b.y, phase = b.z, var = b.w;
        // Wind: slow waves rolling over the knoll, the cursor's gust (eased on the CPU), and a lean of its own.
        float2 wdir = normalize(float2(0.8, 0.4));
        float along = dot(base.xz, wdir);
        float time = F.misc.x;
        float wv = 0.5 + 0.4 * sin(time * q(0.45) - along * 0.3 + phase) + 0.25 * sin(time * q(1.1) - along * 0.8 + phase * 1.7);
        float2 push = wdir * wv * 0.45 + F.gust.xy * F.gust.z * 0.55;
        push += float2(cos(phase * 3.7), sin(phase * 2.9)) * 0.12;
        float mag = length(push);
        float ang = min(mag * (1.0 + 0.8 * var), 1.45);
        float2 dir = mag > 1e-4 ? push / mag : float2(1.0, 0.0);
        float an = ang * t;
        float along2, up;
        if (ang < 1e-3) { along2 = 0.0; up = h * t; } else { along2 = h * (1.0 - cos(an)) / ang; up = h * sin(an) / ang; }
        p = base + float3(dir.x * along2, up, dir.y * along2);
        float3 tangent = float3(dir.x * sin(an), cos(an), dir.y * sin(an));
        float3 across = float3(cos(yaw), 0.0, sin(yaw));
        p += across * v.x * w * (1.0 - t * t * 0.9);
        // A blade bent flat along its own width has no face: fall back to pointing up rather than NaN.
        float3 raw = cross(across, tangent);
        n = length(raw) > 1e-4 ? normalize(raw) : float3(0.0, 1.0, 0.0);
        if (dot(n, eye - p) < 0.0) { n = -n; across = -across; }
        n = normalize(mix(n, float3(0.0, 1.0, 0.0), 0.3));
        acrossOut = across;
    }

    struct BladeOut {
        float4 position [[position]];
        float3 world; float3 normal; float3 across; float2 uv; float var; float len;
    };

    vertex BladeOut bladeVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                device const float2* tmpl [[buffer(0)]], device const float4* inst [[buffer(1)]],
                                constant Frame& F [[buffer(2)]]) {
        float2 v = tmpl[vid];
        float4 a = inst[iid * 2], b = inst[iid * 2 + 1];
        float3 p, n, across;
        bendBlade(F, v, a, b, F.camera.xyz, p, n, across);
        BladeOut o;
        o.world = p; o.normal = n; o.across = across;
        o.uv = float2(v.x + 0.5, v.y);
        o.var = b.w; o.len = a.w;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 bladeFragment(BladeOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                  texture2d<float> surface [[texture(0)]], depth2d<float> shadowMap [[texture(1)]],
                                  sampler s [[sampler(0)]], sampler cmp [[sampler(1)]]) {
        float night = F.misc.z;
        float3 sunDir = F.sunDir.xyz;
        float t = in.uv.y;
        float3 root = float3(0.03, 0.06, 0.025);
        float3 tip = mix(float3(0.16, 0.3, 0.1), float3(0.3, 0.34, 0.12), in.var);
        tip = mix(tip, float3(0.42, 0.34, 0.14), step(0.85, in.var) * 0.7);
        float3 albedo = mix(root, tip, t * t);
        // Veins and midrib from the surface map; its slope tilts the normal across the blade.
        float2 suv = float2(in.uv.x, t * in.len * 2.5 + in.var * 3.0);
        float hgt = surface.sample(s, tv(suv)).r;
        float slope = surface.sample(s, tv(suv + float2(0.03, 0.0))).r - surface.sample(s, tv(suv - float2(0.03, 0.0))).r;
        albedo *= 0.3 + 1.3 * hgt;
        float3 n = normalize(in.normal + in.across * slope * 4.0);
        float shadow = sunShadow(F, shadowMap, cmp, in.world, normalize(in.normal));
        float ndl = max(dot(n, sunDir), 0.0);
        float3 sunCol = float3(1.0, 0.72, 0.45) * (1.0 - night);
        // Low sun: a warm key light, backlight glowing through the thin tips, cool sky fill.
        float3 sun = sunCol * (ndl * 1.7 + pow(max(-dot(n, sunDir), 0.0), 2.0) * t * 1.2) * shadow;
        float3 sky = mix(float3(0.4, 0.45, 0.65) * 0.45, float3(0.05, 0.06, 0.12), night);
        float ao = 0.3 + 0.7 * t;
        float3 c = albedo * (sun + sky) * ao;
        // A glint of sunlight along the ridges of the veins.
        float3 viewDir = normalize(F.camera.xyz - in.world);
        float3 hv = normalize(sunDir + viewDir);
        c += sunCol * pow(max(dot(n, hv), 0.0), 18.0) * 0.22 * shadow * t * (0.5 + hgt);
        // Burners across the valley catch the blades: a warm highlight where the burner's light
        // reflects off a blade toward the eye, plus a gentle glow on faces turned toward it.
        float3 burnerCol = float3(1.0, 0.62, 0.28);
        for (int i = 0; i < BURNER_N; i++) {
            float4 L = F.burners[i];
            if (L.w <= 0.0) continue;
            float3 toL = L.xyz - in.world;
            float d = length(toL);
            float3 l = toL / max(d, 0.1);
            float fall = L.w / (1.0 + d * d / 12000.0);
            float3 hb = normalize(l + viewDir);
            float spec = pow(max(dot(n, hb), 0.0), 28.0) * (0.6 + hgt);
            float diff = max(dot(n, l), 0.0);
            c += burnerCol * (spec * 1.5 + diff * 0.12 * albedo.g * 4.0) * fall * (0.3 + 0.7 * t) * mix(0.5, 1.3, night);
        }
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    // MARK: - Balloons

    struct PartParams {
        float4x4 model;
        float4 color;       // linear albedo
        float4 params;      // x = roughness, y = metalness, z = burn
    };

    /// Each gore bulges between its seams, most at the equator, not at the throat or crown.
    inline float3 bulged(float3 p, float3 n, float2 uv) {
        float bulge = (0.5 - 0.5 * cos(uv.x * 6.2831853 * \(gores).0)) * sin(uv.y * 3.14159) * 0.16;
        return p + n * bulge;
    }

    vertex SurfaceOut partVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                 constant Frame& F [[buffer(1)]], constant PartParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float4 w = P.model * float4(a.xyz, 1.0);
        SurfaceOut o;
        o.world = w.xyz;
        o.normal = normalize((P.model * float4(b.xyz, 0.0)).xyz);
        o.uv = float2(a.w, b.w);
        o.position = F.viewProj * w;
        return o;
    }

    vertex SurfaceOut envelopeVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                     constant Frame& F [[buffer(1)]], constant PartParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float2 uv = float2(a.w, b.w);
        float4 w = P.model * float4(bulged(a.xyz, b.xyz, uv), 1.0);
        SurfaceOut o;
        o.world = w.xyz;
        o.normal = normalize((P.model * float4(b.xyz, 0.0)).xyz);
        o.uv = uv;
        o.position = F.viewProj * w;
        return o;
    }

    /// A plain painted part: metal, cables, leather, the crew.
    fragment float4 partFragment(SurfaceOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant PartParams& P [[buffer(1)]]) {
        float3 n = normalize(in.normal);
        float3 c = standardLight(F, P.color.rgb, n, in.world, P.params.x, P.params.y, 1.0, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    /// The basket: woven wicker as colour and as a bump map (three.js's perturbNormalArb, scale 0.6).
    fragment float4 wickerFragment(SurfaceOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant PartParams& P [[buffer(1)]],
                                   texture2d<float> map [[texture(0)]], texture2d<float> bump [[texture(1)]],
                                   sampler s [[sampler(0)]], sampler rs [[sampler(1)]]) {
        float2 uv = in.uv * 3.0;
        float3 albedo = map.sample(rs, tv(uv)).rgb * P.color.rgb;
        float3 n = normalize(in.normal);
        float geo = geometryRoughness(n);
        float2 dSTdx = dfdx(uv), dSTdy = dfdyGL(uv);
        float hll = 0.6 * bump.sample(rs, tv(uv)).r;
        float dBx = 0.6 * bump.sample(rs, tv(uv + dSTdx)).r - hll;
        float dBy = 0.6 * bump.sample(rs, tv(uv + dSTdy)).r - hll;
        float3 sigmaX = normalize(dfdx(in.world)), sigmaY = normalize(dfdyGL(in.world));
        float3 r1 = cross(sigmaY, n), r2 = cross(n, sigmaX);
        float det = dot(sigmaX, r1);
        float3 grad = sign(det) * (dBx * r1 + dBy * r2);
        n = normalize(abs(det) * n - grad);
        float3 c = standardLight(F, albedo, n, in.world, P.params.x, P.params.y, 1.0, geo);
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    /// The envelope: its painted skin, the quilting as a normal map (repeated 2 x 4, scale 0.6, in a
    /// tangent frame from screen-space derivatives as three.js builds it), lit on both sides, and
    /// glowing from within while the burner fires, brightest near the throat.
    fragment float4 envelopeFragment(SurfaceOut in [[stage_in]], bool front [[front_facing]],
                                     constant Frame& F [[buffer(0)]], constant PartParams& P [[buffer(1)]],
                                     texture2d<float> skin [[texture(0)]], texture2d<float> normalMap [[texture(1)]],
                                     sampler s [[sampler(0)]], sampler rs [[sampler(1)]]) {
        float face = front ? 1.0 : -1.0;
        float3 albedo = skin.sample(s, tv(in.uv)).rgb;
        float3 n = normalize(in.normal) * face;
        float geo = geometryRoughness(n);
        float2 nuv = in.uv * float2(2.0, 4.0);
        float3 mapN = normalMap.sample(rs, tv(nuv)).xyz * 2.0 - 1.0;
        mapN.xy *= 0.6;
        float3 q0 = dfdx(in.world), q1 = dfdyGL(in.world);
        float2 st0 = dfdx(nuv), st1 = dfdyGL(nuv);
        float3 q1perp = cross(q1, n), q0perp = cross(n, q0);
        float3 T = q1perp * st0.x + q0perp * st1.x;
        float3 B = q1perp * st0.y + q0perp * st1.y;
        float detTB = max(dot(T, T), dot(B, B));
        float scale = detTB == 0.0 ? 0.0 : rsqrt(detTB);
        n = normalize(T * scale * face * mapN.x + B * scale * face * mapN.y + n * mapN.z);
        float3 c = standardLight(F, albedo, n, in.world, P.params.x, P.params.y, 1.0, geo);
        c += albedo * P.params.z * 2.4 * pow(clamp(1.0 - in.uv.y, 0.0, 1.0), 1.3);
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    // MARK: - The sun's shadow pass

    struct ShadowOut { float4 position [[position]]; };

    vertex ShadowOut partShadowVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                      constant Frame& F [[buffer(1)]], constant PartParams& P [[buffer(2)]]) {
        ShadowOut o;
        o.position = F.shadow * (P.model * float4(verts[vid * 2].xyz, 1.0));
        return o;
    }

    vertex ShadowOut envelopeShadowVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                          constant Frame& F [[buffer(1)]], constant PartParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        ShadowOut o;
        o.position = F.shadow * (P.model * float4(bulged(a.xyz, b.xyz, float2(a.w, b.w)), 1.0));
        return o;
    }

    /// The blades bend the same way in the shadow pass, so blade and shadow agree.
    vertex ShadowOut bladeShadowVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                       device const float2* tmpl [[buffer(0)]], device const float4* inst [[buffer(1)]],
                                       constant Frame& F [[buffer(2)]]) {
        float3 p, n, across;
        bendBlade(F, tmpl[vid], inst[iid * 2], inst[iid * 2 + 1], F.camera.xyz, p, n, across);
        ShadowOut o;
        o.position = F.shadow * float4(p, 1.0);
        return o;
    }

    // MARK: - Swallows (instanced)

    struct BirdOut { float4 position [[position]]; float dist; float light; };

    /// `tmpl`: (position xyz, wing) per vertex. `inst`: (position xyz, flap phase), (velocity xyz, flap rate).
    vertex BirdOut birdVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                              device const float4* tmpl [[buffer(0)]], device const float4* inst [[buffer(1)]],
                              constant Frame& F [[buffer(2)]]) {
        float4 v = tmpl[vid], a = inst[iid * 2], b = inst[iid * 2 + 1];
        float wing = v.w;
        float3 f = length(b.xyz) > 1e-4 ? normalize(b.xyz) : float3(0.0, 0.0, -1.0);
        float3 r = cross(f, float3(0.0, 1.0, 0.0));
        r = length(r) > 1e-3 ? normalize(r) : float3(1.0, 0.0, 0.0);
        float3 u = cross(r, f);
        float flap = sin(F.misc.x * q(b.w) + a.w);
        float3 local = v.xyz * 1.5;
        // Wings beat: the tips rise and fall, folding a little inward on the upstroke.
        local.y += abs(wing) * flap * 0.9;
        local.x *= 1.0 - abs(wing) * max(flap, 0.0) * 0.25;
        float3 p = a.xyz + r * local.x + u * local.y + f * local.z;
        float4 mv = F.view * float4(p, 1.0);
        BirdOut o;
        o.light = 0.5 + 0.5 * flap;
        o.dist = length(mv.xyz);
        o.position = F.proj * mv;
        return o;
    }

    fragment float4 birdFragment(BirdOut in [[stage_in]], constant Frame& F [[buffer(0)]]) {
        float3 c = mix(float3(0.05, 0.045, 0.06), float3(0.012, 0.012, 0.02), F.misc.z) * (0.8 + 0.4 * in.light);
        return float4(applyFog(F, c, in.dist), 1.0);
    }

    // MARK: - Post-processing: three.js's UnrealBloomPass, then the grade and tone mapping

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

    /// Scene + bloom, then a touch more saturation and a vignette (in linear HDR), then ACES and sRGB.
    fragment float4 outputFragment(PostOut in [[stage_in]], sampler s [[sampler(0)]],
                                   texture2d<float> scene [[texture(0)]], texture2d<float> bloom [[texture(1)]]) {
        float3 c = scene.sample(s, in.uv).rgb;
        float4 b = bloom.sample(s, in.uv);
        c += b.rgb * b.a;
        float l = dot(c, float3(0.2126, 0.7152, 0.0722));
        c = max(mix(float3(l), c, 1.06), 0.0);
        float d = length(in.uv - 0.5) * 1.35;
        c *= 1.0 - 0.45 * pow(clamp(d, 0.0, 1.0), 2.6);
        return float4(linearToSRGB(acesFilmic(c)), 1.0);
    }
    """
}
