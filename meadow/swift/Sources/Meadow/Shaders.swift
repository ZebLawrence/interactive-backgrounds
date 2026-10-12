/// Metal shaders, compiled at launch (`GPU`). Ported from the web version's GLSL: the shared
/// chunks (fog, wind, the cursor's push, firefly light, moonlight), then each part of the scene,
/// then the post-processing (bloom, grade, tone mapping).
///
/// Textures are uploaded with row 0 at the top (as drawn), while the web version's UVs follow
/// WebGL (v = 0 at the bottom), so the shaders sample at `tv(uv)` = (u, 1 - v).
enum Shaders {
    /// Fixed array sizes, matching `FrameUniforms`.
    static let trailCount = 24
    static let ringCount = 4
    static let lightCount = 32

    static let source = """
    #include <metal_stdlib>
    using namespace metal;

    #define TRAIL_N 24
    #define RING_N 4
    #define LIGHT_N 32

    /// Everything shared by every draw in a frame (written by `FrameUniforms`).
    struct Frame {
        float4x4 viewProj;
        float4x4 view;
        float4x4 proj;
        float4 camera;      // xyz = camera position; w = firefly sprite scale (pixels per metre at 1 m)
        float4 misc;        // x = time (wraps hourly); y = drawable height in pixels
        float4 wind;        // xy = direction on the ground; z = strength
        float4 cursor;      // the cursor's ground point: x, z, radius, strength
        float4 trail[TRAIL_N];
        float4 rings[RING_N];
        float4 lights[LIGHT_N];   // the brightest fireflies: xyz, light
        float4 lightCol[LIGHT_N];
        float4 moonDir;     // xyz; w = moonlight
        float4 moonColor;
        float4 skyLight;
        float4 fogColor;
        float4 env;         // x = fog near, y = fog far, z = storm, w = lightning flash
    };

    constant float QK = \(timeWrap / (2 * Double.pi));
    /// Round an angular frequency to a whole number of cycles per hourly wrap.
    inline float q(float w) { return floor(w * QK + 0.5) / QK; }
    /// GLSL-style smoothstep that also works with e0 > e1.
    inline float sstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
    /// WebGL UV (v up) to Metal texture coordinates (row 0 at the top).
    inline float2 tv(float2 uv) { return float2(uv.x, 1.0 - uv.y); }

    /// Fog like SceneKit's: by distance from the camera, with a density exponent of 1.3.
    inline float fogAmount(constant Frame& F, float dist) {
        return pow(clamp((dist - F.env.x) / (F.env.y - F.env.x), 0.0, 1.0), 1.3);
    }
    inline float3 applyFog(constant Frame& F, float3 c, float dist) { return mix(c, F.fogColor.xyz, fogAmount(F, dist)); }

    /// How much the ground at `p` (xz) is pushed sideways: by the cursor, its trail and clap rings.
    float2 pushAt(constant Frame& F, float2 p) {
        float2 push = float2(0.0);
        {
            float2 d = p - F.cursor.xy; float r = length(d);
            push += d / max(r, 1e-4) * sstep(F.cursor.z, 0.0, r) * F.cursor.w;
        }
        for (int i = 0; i < TRAIL_N; i++) {
            float4 t = F.trail[i];
            if (t.w <= 0.0) continue;
            float2 d = p - t.xy; float r = length(d);
            push += d / max(r, 1e-4) * sstep(t.z, 0.0, r) * t.w;
        }
        for (int i = 0; i < RING_N; i++) {
            float4 g = F.rings[i];
            if (g.w <= 0.0) continue;
            float2 d = p - g.xy; float r = length(d);
            float x = (r - g.z) / (0.5 + g.z * 0.12);
            float band = exp(-x * x);
            push += d / max(r, 1e-4) * band * g.w;
        }
        return push;
    }

    /// Wind at `p`: travelling waves along the wind plus a flutter, scaled by the wind strength.
    float2 windAt(constant Frame& F, float2 p, float phase) {
        float t = F.misc.x;
        float2 dir = F.wind.xy;
        float along = dot(p, dir), across = dot(p, float2(dir.y, -dir.x));
        float w = 0.55 + 0.45 * sin(t * q(0.5) - along * 0.35 + phase)
                + 0.3 * sin(t * q(1.05) - along * 0.9 + across * 0.5 + phase * 1.7)
                + 0.18 * sin(t * q(0.17) - along * 0.08 + across * 0.11);
        float2 flutter = float2(sin(t * q(1.4) + phase * 2.0), cos(t * q(1.15) + phase)) * 0.08;
        return (dir * w + flutter) * F.wind.z;
    }

    /// Light from the brightest fireflies falling on a point, in each one's own colour.
    float3 fireflyLight(constant Frame& F, float3 p) {
        float3 glow = float3(0.0);
        for (int i = 0; i < LIGHT_N; i++) {
            float4 L = F.lights[i];
            if (L.w <= 0.0) continue;
            float3 d = L.xyz - p;
            float r2 = dot(d, d);
            glow += F.lightCol[i].xyz * (L.w * max(1.0 / (1.0 + r2 * 14.0) - 1.0 / (1.0 + 4.0 * 14.0), 0.0));
        }
        return glow;
    }

    /// Moon, sky and lightning on a surface with normal n, before firefly light and fog.
    float3 shade(constant Frame& F, float3 albedo, float3 n, float ao) {
        float ndl = max(dot(n, F.moonDir.xyz), 0.0);
        float3 moon = F.moonColor.xyz * (0.2 + 0.8 * ndl) * F.moonDir.w;
        float3 sky = F.skyLight.xyz * (0.6 + 0.4 * max(n.y, 0.0));
        float3 flash = float3(0.7, 0.75, 1.0) * F.env.w * (0.5 + 0.5 * max(n.y, 0.0)) * 1.3;
        return albedo * (moon + sky + flash) * ao;
    }

    /// Bend a stalk rooted at `base` by the wind and whatever is pushing on the ground there. The
    /// stalk is an arc of constant curvature: `t` runs 0 at the root to 1 at the tip, `h` is its
    /// length. Returns the bent point and the tangent there.
    void bendStalk(constant Frame& F, float3 base, float h, float t, float phase, float stiffness,
                   thread float3& p, thread float3& tangent) {
        float2 push = pushAt(F, base.xz) * 1.6 + windAt(F, base.xz, phase) * 0.55;
        // A natural lean of its own, so blades don't all stand to attention.
        push += float2(cos(phase * 3.7), sin(phase * 2.9)) * 0.12;
        float mag = length(push);
        float ang = min(mag * stiffness, 1.5);
        float2 dir = mag > 1e-4 ? push / mag : float2(1.0, 0.0);
        float a = ang * t;
        float along, up;
        if (ang < 1e-3) { along = 0.0; up = h * t; }
        else { along = h * (1.0 - cos(a)) / ang; up = h * sin(a) / ang; }
        p = base + float3(dir.x * along, up, dir.y * along);
        tangent = float3(dir.x * sin(a), cos(a), dir.y * sin(a));
    }

    // MARK: - Ground

    struct GroundOut { float4 position [[position]]; float3 world; float3 normal; };

    vertex GroundOut groundVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        GroundOut o;
        float3 p = verts[vid * 2].xyz;
        o.world = p;
        o.normal = verts[vid * 2 + 1].xyz;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 groundFragment(GroundOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                   texture2d<float> soilMap [[texture(0)]], sampler s [[sampler(0)]]) {
        float3 soil = soilMap.sample(s, tv(in.world.xz / 3.0)).rgb;
        float3 wide = soilMap.sample(s, tv(in.world.xz / 23.0 + 0.37)).rgb;
        float3 albedo = soil * (0.6 + 0.8 * wide.g) * 0.55;
        // Wetter and darker in the rain.
        albedo *= 1.0 - 0.35 * F.env.z;
        float3 c = shade(F, albedo, normalize(in.normal), 0.8);
        c += (albedo * 2.0 + 0.01) * fireflyLight(F, in.world);
        c = applyFog(F, c, length(in.world - F.camera.xyz));
        return float4(c, 1.0);
    }

    // MARK: - Grass blades (instanced)

    struct BladeOut {
        float4 position [[position]];
        float3 world; float3 normal; float3 across; float2 uv; float var; float len;
    };

    /// `tmpl`: the blade strip (x across -0.5...0.5, t up 0...1). `inst`: two float4 per blade:
    /// (base xyz, height), (width, yaw, phase, variety).
    vertex BladeOut bladeVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                device const float2* tmpl [[buffer(0)]], device const float4* inst [[buffer(1)]],
                                constant Frame& F [[buffer(2)]]) {
        float2 v = tmpl[vid];
        float t = v.y;
        float4 a = inst[iid * 2], b = inst[iid * 2 + 1];
        float3 base = a.xyz; float h = a.w;
        float w = b.x, yaw = b.y, phase = b.z;
        float3 p, tangent;
        bendStalk(F, base, h, t, phase, 1.0 + 0.8 * b.w, p, tangent);
        float3 across = float3(cos(yaw), 0.0, sin(yaw));
        p += across * v.x * w * (1.0 - t * t * 0.9);
        float3 n = normalize(cross(across, tangent));
        if (dot(n, F.camera.xyz - p) < 0.0) { n = -n; across = -across; }
        BladeOut o;
        o.normal = normalize(mix(n, float3(0.0, 1.0, 0.0), 0.35));
        o.across = across;
        o.uv = float2(v.x + 0.5, t);
        o.world = p;
        o.var = b.w;
        o.len = h;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 bladeFragment(BladeOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                  texture2d<float> surface [[texture(0)]], sampler s [[sampler(0)]]) {
        float t = in.uv.y;
        float3 root = float3(0.018, 0.045, 0.022);
        float3 tip = mix(float3(0.10, 0.21, 0.08), float3(0.17, 0.25, 0.10), in.var);
        // Some blades have gone to seed and turned straw-coloured.
        tip = mix(tip, float3(0.26, 0.22, 0.10), step(0.86, in.var) * 0.7);
        float3 albedo = mix(root, tip, t * t);
        // Veins and midrib: the surface map gives height; its slope tilts the normal.
        float2 suv = float2(in.uv.x, t * in.len * 2.5 + in.var * 3.0);
        float hgt = surface.sample(s, tv(suv)).r;
        float slope = surface.sample(s, tv(suv + float2(0.03, 0.0))).r - surface.sample(s, tv(suv - float2(0.03, 0.0))).r;
        albedo *= 0.3 + 1.3 * hgt;
        float3 n = normalize(in.normal + in.across * slope * 4.0);
        float ao = 0.3 + 0.7 * t;
        float3 c = shade(F, albedo, n, ao);
        // A glint of moonlight along the ridges of the veins.
        float3 hv = normalize(F.moonDir.xyz + normalize(F.camera.xyz - in.world));
        c += F.moonColor.xyz * pow(max(dot(n, hv), 0.0), 18.0) * 0.2 * F.moonDir.w * t * (0.5 + hgt);
        c += (albedo * 2.6 + 0.012) * fireflyLight(F, in.world) * ao;
        c = applyFog(F, c, length(in.world - F.camera.xyz));
        return float4(c, 1.0);
    }

    // MARK: - Wildflowers (instanced)

    struct FlowerOut { float4 position [[position]]; float3 world; float2 uv; float t; };

    /// `tmpl`: two crossed strips, (x, t, z, u). `inst`: (base xyz, height), (width, yaw, phase, kind).
    vertex FlowerOut flowerVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                  device const float4* tmpl [[buffer(0)]], device const float4* inst [[buffer(1)]],
                                  constant Frame& F [[buffer(2)]]) {
        float4 v = tmpl[vid];
        float t = v.y;
        float4 a = inst[iid * 2], b = inst[iid * 2 + 1];
        float3 p, tangent;
        bendStalk(F, a.xyz, a.w, t, b.z, 0.6, p, tangent);
        float c = cos(b.y), s = sin(b.y);
        float3 across = float3(v.x * c - v.z * s, 0.0, v.x * s + v.z * c);
        p += across * b.x;
        FlowerOut o;
        o.world = p;
        o.t = t;
        o.uv = float2((b.w + v.w) / 4.0, t);
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 flowerFragment(FlowerOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                   texture2d<float> atlas [[texture(0)]], sampler s [[sampler(0)]]) {
        float4 tex = atlas.sample(s, tv(in.uv));
        if (tex.a < 0.5) discard_fragment();
        float3 albedo = tex.rgb * 0.42;
        float3 c = shade(F, albedo, float3(0.0, 1.0, 0.0), 0.5 + 0.5 * in.t);
        c += (albedo * 2.2 + 0.01) * fireflyLight(F, in.world);
        c = applyFog(F, c, length(in.world - F.camera.xyz));
        return float4(c, 1.0);
    }

    // MARK: - Fireflies (point sprites)

    struct FlyOut { float4 position [[position]]; float size [[point_size]]; float bright; float3 color; };

    /// `dyn`: (xyz, brightness) per firefly, written each frame. `stat`: (linear rgb, size).
    vertex FlyOut fireflyVertex(uint vid [[vertex_id]], device const float4* dyn [[buffer(0)]],
                                device const float4* stat [[buffer(1)]], constant Frame& F [[buffer(2)]]) {
        float4 d = dyn[vid], s = stat[vid];
        float4 mv = F.view * float4(d.xyz, 1.0);
        FlyOut o;
        o.position = F.proj * mv;
        o.size = clamp(s.w * F.camera.w / max(-mv.z, 0.1), 3.0, 220.0);
        o.bright = d.w;
        o.color = s.xyz;
        return o;
    }

    fragment float4 fireflyFragment(FlyOut in [[stage_in]], float2 pc [[point_coord]]) {
        float2 q2 = pc - 0.5;
        float r = length(q2) * 2.0;
        if (r > 1.0) discard_fragment();
        float core = sstep(0.16, 0.0, r);
        float halo = exp(-r * r * 7.0) * 0.4;
        return float4(in.color * (core * 2.4 + halo) * in.bright, 1.0);
    }

    // MARK: - Sky dome

    float hash21(float2 p) { p = fract(p * float2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vnoise(float2 p) {
        float2 i = floor(p), f = fract(p); float2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + float2(1.0, 0.0)), u.x), mix(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(float2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }

    /// One layer of stars on a grid of cells: most faint and white, a few bright, each with its own
    /// colour from blue-white through yellow to orange, and a soft halo on the brightest.
    float3 starLayer(float time, float2 uv, float cells, float threshold, float gain, float seed) {
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

    struct SkyOut { float4 position [[position]]; float3 dir; };

    vertex SkyOut skyVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        SkyOut o;
        float3 p = verts[vid].xyz;
        o.dir = p;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 skyFragment(SkyOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                texture2d<float> hazeMap [[texture(0)]], sampler s [[sampler(0)]]) {
        float time = F.misc.x, moonAmt = F.moonDir.w, storm = F.env.z, flash = F.env.w;
        float3 d = normalize(in.dir);
        float h = d.y;
        float3 zenith = float3(0.003, 0.005, 0.016);
        float3 horizon = float3(0.035, 0.045, 0.09);
        float3 col = mix(horizon, zenith, pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
        // Faint airglow low on the horizon.
        col += float3(0.02, 0.045, 0.035) * exp(-max(h, 0.0) * 14.0);

        float2 uv = float2(atan2(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
        float3 haze = hazeMap.sample(s, tv(uv)).rgb;
        float hazeAmt = dot(haze, float3(0.33));
        float3 stars = starLayer(time, uv, 380.0, 0.75, 1.5, 0.0)
                     + starLayer(time, uv, 760.0, 0.84, 0.8, 5.0) * (0.7 + 1.5 * hazeAmt)
                     + starLayer(time, uv, 1400.0, 0.9, 0.35, 11.0) * (0.5 + 2.0 * hazeAmt);
        col += haze * 0.3;
        col += stars * (1.0 - moonAmt * 0.3);

        // The moon's halo.
        float cosm = dot(d, F.moonDir.xyz);
        float halo = exp((cosm - 1.0) * 70.0) * 0.22 + exp((cosm - 1.0) * 500.0) * 0.5;
        col += float3(0.5, 0.6, 0.85) * halo * moonAmt;

        // Storm: a low ceiling of cloud lit from within by lightning.
        float2 cp = d.xz / max(h, 0.08) * 0.9 + float2(time * q(0.01), 0.0);
        float cloud = fbm(cp);
        float3 stormCol = float3(0.025, 0.03, 0.045) * (0.5 + 1.1 * cloud);
        stormCol += float3(0.6, 0.66, 0.9) * flash * (0.15 + 0.6 * cloud);
        col = mix(col, stormCol, storm);
        col += float3(0.5, 0.55, 0.75) * flash * (1.0 - storm) * 0.3;

        // Fade into the fog just above the horizon, so the land meets the sky seamlessly.
        col = mix(col, F.fogColor.xyz, sstep(0.09, 0.0, h));
        return float4(col, 1.0);
    }

    // MARK: - Moon: NASA's LRO colour and height maps on a sphere lit by its own sun

    struct MoonParams {
        float4x4 model;
        float4 sunDir;      // toward the moon's sun (world)
        float4 sunColor;    // linear colour x intensity
        float4 ambient;     // earthshine, linear colour x intensity
        float4 params;      // x = opacity, y = bump scale
    };

    struct MoonOut { float4 position [[position]]; float3 world; float3 normal; float2 uv; };

    /// `verts`: (position xyz, u), (normal xyz, v) per vertex.
    vertex MoonOut moonVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], constant MoonParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float4 w = P.model * float4(a.xyz, 1.0);
        MoonOut o;
        o.world = w.xyz;
        o.normal = normalize((P.model * float4(b.xyz, 0.0)).xyz);
        o.uv = float2(a.w, b.w);
        o.position = F.viewProj * w;
        return o;
    }

    fragment float4 moonFragment(MoonOut in [[stage_in]], constant MoonParams& P [[buffer(0)]],
                                 texture2d<float> colorMap [[texture(0)]], texture2d<float> heightMap [[texture(1)]],
                                 sampler s [[sampler(0)]]) {
        float2 uv = tv(in.uv);
        float3 albedo = colorMap.sample(s, uv).rgb;
        // three.js's bump mapping (perturbNormalArb): screen-space height derivatives.
        float2 dSTdx = dfdx(uv), dSTdy = dfdy(uv);
        float hll = P.params.y * heightMap.sample(s, uv).r;
        float dBx = P.params.y * heightMap.sample(s, uv + dSTdx).r - hll;
        float dBy = P.params.y * heightMap.sample(s, uv + dSTdy).r - hll;
        float3 sigmaX = normalize(dfdx(in.world)), sigmaY = normalize(dfdy(in.world));
        float3 n = normalize(in.normal);
        float3 r1 = cross(sigmaY, n), r2 = cross(n, sigmaX);
        float det = dot(sigmaX, r1);
        float3 grad = sign(det) * (dBx * r1 + dBy * r2);
        n = normalize(abs(det) * n - grad);
        // Lambert, as a fully rough MeshStandardMaterial lights it.
        float ndl = max(dot(n, P.sunDir.xyz), 0.0);
        float3 c = albedo * (P.sunColor.xyz * ndl + P.ambient.xyz) / 3.14159265;
        return float4(c, P.params.x);
    }

    // MARK: - Textured quads: shooting stars, lightning, and the tree line and hills

    struct QuadParams {
        float4x4 model;
        float4 color;       // rgb tint; a = opacity
        float4 extra;       // silhouettes: x = fogged
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

    /// MeshBasicMaterial: colour x texture, opacity in alpha (blended additively).
    fragment float4 quadFragment(QuadOut in [[stage_in]], constant QuadParams& P [[buffer(0)]],
                                 texture2d<float> map [[texture(0)]], sampler s [[sampler(0)]]) {
        float4 t = map.sample(s, tv(in.uv));
        return float4(P.color.rgb * t.rgb, t.a * P.color.a);
    }

    /// A silhouette in the fog: cut out of a coverage mask, coloured by distance.
    fragment float4 silhouetteFragment(QuadOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant QuadParams& P [[buffer(1)]],
                                       texture2d<float> mask [[texture(0)]], sampler s [[sampler(0)]]) {
        if (mask.sample(s, tv(in.uv)).r < 0.5) discard_fragment();
        float f = fogAmount(F, in.dist);
        float3 c = mix(P.color.rgb, F.fogColor.xyz * 0.85, max(f, 1.0 - P.extra.x));
        return float4(c, 1.0);
    }

    // MARK: - Mist: huge soft sprites drifting downwind

    struct MistOut { float4 position [[position]]; float2 uv; float opacity; float dist; };

    /// `inst`: (centre xyz, opacity), (scale x, scale y, -, -) per sprite.
    vertex MistOut mistVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* inst [[buffer(0)]],
                              constant Frame& F [[buffer(1)]]) {
        float4 a = inst[iid * 2], b = inst[iid * 2 + 1];
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
        float3 c = applyFog(F, float3(0.35, 0.42, 0.6) * t.rgb, in.dist);
        return float4(c, t.a * in.opacity);
    }

    // MARK: - Rain

    struct RainOut { float4 position [[position]]; float size [[point_size]]; float dist; };

    vertex RainOut rainVertex(uint vid [[vertex_id]], device const float4* pos [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        float4 mv = F.view * float4(pos[vid].xyz, 1.0);
        RainOut o;
        o.position = F.proj * mv;
        // PointsMaterial with size attenuation: size x (half the drawable height) / depth.
        o.size = clamp(0.3 * F.misc.y * 0.5 / max(-mv.z, 0.05), 1.0, 511.0);
        o.dist = length(mv.xyz);
        return o;
    }

    fragment float4 rainFragment(RainOut in [[stage_in]], float2 pc [[point_coord]], constant Frame& F [[buffer(0)]],
                                 constant float4& P [[buffer(1)]], texture2d<float> map [[texture(0)]], sampler s [[sampler(0)]]) {
        float4 t = map.sample(s, float2(pc.x, 1.0 - pc.y));
        float3 c = applyFog(F, float3(0.55, 0.62, 0.8) * t.rgb, in.dist);
        return float4(c, t.a * P.x);
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
        c = max(mix(float3(l), c, 1.08), 0.0);
        float d = length(in.uv - 0.5) * 1.35;
        c *= 1.0 - 0.6 * pow(clamp(d, 0.0, 1.0), 2.6);
        return float4(linearToSRGB(acesFilmic(c)), 1.0);
    }
    """
}
