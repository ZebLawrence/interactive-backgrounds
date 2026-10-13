extension Shaders {
    static let scene = """

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
        float star = sstep(size, 0.0, dist) * bright * tw;
        star += exp(-dist * dist / 0.03) * bright * 0.12 * step(0.985, r1);
        return tint * star;
    }

    struct SkyOut { float4 position [[position]]; float3 dir; };

    vertex SkyOut skyVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        SkyOut o;
        float3 p = verts[vid * 2].xyz;
        o.dir = p;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 skyFragment(SkyOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                texture2d<float> hazeMap [[texture(0)]], sampler s [[sampler(0)]]) {
        float time = F.misc.x, night = F.misc.z, rain = F.misc.w;
        float3 sunDir = F.sunDir.xyz, moonDir = F.moonDir.xyz, fogColor = F.fogColor.xyz;
        float3 d = normalize(in.dir);
        float h = d.y;
        float2 uv = float2(atan2(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
        // How close in azimuth to where the sun went down.
        float2 sa = normalize(sunDir.xz), da = normalize(d.xz + float2(1e-5, 0.0));
        float toSun = dot(sa, da) * 0.5 + 0.5;

        // Dusk, twenty minutes after sunset: an orange band where the sun went, pink and mauve above
        // it, violet-grey round the rest of the horizon, deep blue overhead.
        float3 glowH = float3(1.0, 0.52, 0.2), glowM = float3(0.95, 0.5, 0.42), farH = float3(0.5, 0.4, 0.52);
        float3 horizon = mix(farH, glowH, pow(toSun, 2.5));
        float3 mid = mix(float3(0.4, 0.32, 0.5), glowM, pow(toSun, 3.0) * 0.85);
        float3 zenith = float3(0.05, 0.08, 0.2);
        float3 dusk = mix(horizon, mid, smoothstep(0.0, 0.12, h));
        dusk = mix(dusk, zenith, smoothstep(0.06, 0.5, h));
        float sunGlow = exp(-max(h + 0.08, 0.0) * 7.0) * pow(toSun, 5.0);
        dusk += float3(1.0, 0.55, 0.2) * sunGlow * 0.6;
        // The sun itself, low and swollen in the haze, with its glow around it.
        float cosS = dot(d, sunDir);
        float glow = exp((cosS - 1.0) * 160.0) * 0.3 + exp((cosS - 1.0) * 1400.0) * 0.6 + pow(max(cosS, 0.0), 12.0) * 0.12;
        dusk += float3(1.0, 0.6, 0.3) * glow;
        float disc = smoothstep(0.99982, 0.99993, cosS);
        dusk += float3(2.0, 1.3, 0.75) * disc;
        // A yellow seam right on the horizon under the glow.
        dusk += float3(1.0, 0.8, 0.35) * exp(-max(h, 0.0) * 40.0) * pow(toSun, 8.0) * 0.5;
        // Venus, the evening star, low over the glow.
        float3 venusDir = normalize(float3(sunDir.x * 0.8 + 0.25, 0.2, sunDir.z));
        float cosV = dot(d, venusDir);
        float venus = smoothstep(0.9999975, 0.9999995, cosV) * 2.5 + exp((cosV - 1.0) * 400000.0) * 0.5;
        dusk += float3(1.0, 1.0, 0.95) * venus;
        // Thin bands of altostratus, lit underneath from the sunset side.
        float2 cp = d.xz / max(h, 0.05);
        float band = fbm(float2(cp.x * 0.22 + time * q(0.0025), cp.y * 1.6) * 1.1);
        float cloud = smoothstep(0.5, 0.74, band) * smoothstep(0.02, 0.14, h) * sstep(0.75, 0.25, h);
        float3 cloudCol = mix(float3(0.3, 0.26, 0.36), float3(1.0, 0.62, 0.42), pow(toSun, 2.5) * sstep(0.35, 0.05, h)) + float3(1.0, 0.5, 0.2) * glow * 0.4;
        dusk = mix(dusk, cloudCol, cloud * 0.7);
        // The first stars show at the zenith even at dusk.
        dusk += starLayer(time, uv, 380.0, 0.75, 1.5, 0.0) * smoothstep(0.2, 0.7, h) * 0.3;

        // Night: a dark vault, the Milky Way, three layers of stars, the moon's halo.
        float3 nightCol = mix(float3(0.035, 0.045, 0.09), float3(0.003, 0.005, 0.016), pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
        nightCol += float3(0.02, 0.045, 0.035) * exp(-max(h, 0.0) * 14.0) * 0.6;
        float3 haze = hazeMap.sample(s, tv(uv)).rgb;
        float hazeAmt = dot(haze, float3(0.33));
        float3 stars = starLayer(time, uv, 380.0, 0.75, 1.5, 0.0) + starLayer(time, uv, 760.0, 0.84, 0.8, 5.0) * (0.7 + 1.5 * hazeAmt)
                     + starLayer(time, uv, 1400.0, 0.9, 0.35, 11.0) * (0.5 + 2.0 * hazeAmt);
        nightCol += haze * 0.3 + stars;
        float cosm = dot(d, moonDir);
        nightCol += float3(0.5, 0.6, 0.85) * (exp((cosm - 1.0) * 90.0) * 0.14 + exp((cosm - 1.0) * 600.0) * 0.35);

        float3 col = mix(dusk, nightCol, night);

        // Rain: a low grey ceiling scrolling over, darker where it is thick.
        float2 rp = d.xz / max(h, 0.06) * 0.7 + float2(time * q(0.012), time * q(0.004));
        float rc = fbm(rp);
        float3 rainCol = mix(float3(0.3, 0.32, 0.36), float3(0.14, 0.15, 0.18), rc) * mix(1.0, 0.12, night);
        col = mix(col, rainCol, rain * smoothstep(-0.02, 0.1, h));

        col = mix(col, fogColor, sstep(0.1, -0.01, h));
        return float4(col, 1.0);
    }

    // MARK: - Moon

    struct MoonParams { float4x4 model; float4 sun; float4 opacity; };
    struct MoonOut { float4 position [[position]]; float2 uv; float3 n; float3 t; float3 b; };

    vertex MoonOut moonVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], constant MoonParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        MoonOut o;
        o.uv = float2(a.w, b.w);
        float3x3 m = float3x3(P.model[0].xyz, P.model[1].xyz, P.model[2].xyz);
        o.n = normalize(m * b.xyz);
        // Tangent frame for the bump: along u, along v.
        o.t = normalize(m * float3(-sin(o.uv.x * 6.2831853), 0.0, cos(o.uv.x * 6.2831853)));
        o.b = normalize(cross(o.n, o.t));
        o.position = F.viewProj * (P.model * float4(a.xyz, 1.0));
        return o;
    }

    fragment float4 moonFragment(MoonOut in [[stage_in]], constant MoonParams& P [[buffer(0)]],
                                 texture2d<float> colorMap [[texture(0)]], texture2d<float> bumpMap [[texture(1)]], sampler s [[sampler(0)]]) {
        float3 albedo = colorMap.sample(s, tv(in.uv)).rgb;
        float e = 1.0 / 2048.0;
        float hx = bumpMap.sample(s, tv(in.uv + float2(e, 0.0))).r - bumpMap.sample(s, tv(in.uv - float2(e, 0.0))).r;
        float hy = bumpMap.sample(s, tv(in.uv + float2(0.0, e))).r - bumpMap.sample(s, tv(in.uv - float2(0.0, e))).r;
        float3 n = normalize(in.n - in.t * hx * 6.0 - in.b * hy * 6.0);
        float lit = max(dot(n, P.sun.xyz), 0.0);
        // Soft terminator and a whisper of earthshine on the dark side.
        float l = smoothstep(-0.02, 0.12, dot(normalize(in.n), P.sun.xyz)) * lit;
        float3 col = albedo * (l * 2.4 + 0.03) * float3(1.0, 0.98, 0.94);
        return float4(col, P.opacity.x);
    }

    // MARK: - Textured quads: the shore's silhouettes and the ridges

    struct QuadParams {
        float4x4 model;
        float4 color;       // the dusk tint
        float4 extra;       // xyz = the night tint, w = the most fog allowed
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

    /// The pines across the water: cut out of a mask, dissolving into the haze (and the rain) with distance.
    fragment float4 silhouetteFragment(QuadOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant QuadParams& P [[buffer(1)]],
                                       texture2d<float> mask [[texture(0)]], sampler s [[sampler(0)]]) {
        if (mask.sample(s, tv(in.uv)).r < 0.5) discard_fragment();
        float f = min(fogAmount(F, in.dist), P.extra.w);
        f = max(f, F.misc.w * 0.35 * clamp(in.dist / 400.0, 0.0, 1.0));
        float3 tint = mix(P.color.rgb, P.extra.xyz, F.misc.z);
        return float4(mix(tint, F.fogColor.xyz, f), 1.0);
    }

    fragment float4 ridgeFragment(QuadOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant QuadParams& P [[buffer(1)]],
                                  texture2d<float> mask [[texture(0)]], sampler s [[sampler(0)]]) {
        if (mask.sample(s, tv(in.uv)).r < 0.5) discard_fragment();
        float f = min(fogAmount(F, in.dist), P.extra.w);
        f = max(f, F.misc.w * 0.85);
        return float4(mix(mix(P.color.rgb, P.extra.xyz, F.misc.z), F.fogColor.xyz, f), 1.0);
    }

    // MARK: - Mist on the far water

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
        float3 tint = F.fogColor.xyz * 1.15 + 0.03;
        return float4(applyFog(F, tint * t.rgb, in.dist), t.a * in.opacity);
    }

    // MARK: - Rain

    struct RainOut { float4 position [[position]]; float size [[point_size]]; float alpha; };

    /// `pos`: (x, y, z, seed). Each drop falls at about 6 m/s and wraps to the top of the box; the breeze slants it.
    vertex RainOut rainVertex(uint vid [[vertex_id]], device const float4* pos [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        float4 a = pos[vid];
        float boxH = 14.0;
        float fall = 6.0 + a.w * 2.0;
        float y = fmodGL(a.y - F.misc.x * fall, boxH);
        float3 p = float3(a.x + F.wind.x * F.wind.z * (boxH - y) * 0.15, y, a.z + F.wind.y * F.wind.z * (boxH - y) * 0.15);
        float4 mv = F.view * float4(p, 1.0);
        float dist = length(mv.xyz);
        RainOut o;
        o.size = clamp(260.0 / dist, 2.0, 40.0);
        o.alpha = clamp(1.6 - dist / 30.0, 0.15, 0.7);
        o.position = F.proj * mv;
        return o;
    }

    fragment float4 rainFragment(RainOut in [[stage_in]], float2 pc [[point_coord]], constant Frame& F [[buffer(0)]],
                                 texture2d<float> map [[texture(0)]], sampler s [[sampler(0)]]) {
        float a = map.sample(s, pc).a * in.alpha * F.misc.w;
        float3 c = mix(float3(0.75, 0.78, 0.85), float3(0.2, 0.22, 0.3), F.misc.z);
        return float4(c, a * 0.5);
    }

    // MARK: - Reeds (instanced)

    /// The sway shared by stalks, leaves and heads: a slow lean downwind with a flutter, growing up the stem.
    float3 swayAt(constant Frame& F, float3 base, float h, float t, float phase, float stiff) {
        float2 wdir = normalize(F.wind.xy + float2(1e-4, 0.0));
        float along = dot(base.xz, wdir);
        float time = F.misc.x;
        float wv = 0.6 + 0.3 * sin(time * q(0.35) - along * 0.4 + phase) + 0.15 * sin(time * q(0.9) - along * 0.9 + phase * 1.7);
        float lean = F.wind.z * wv * 0.14 * stiff;
        float a = lean * t * t;
        return base + float3(wdir.x * a * h, h * t, wdir.y * a * h);
    }

    /// A leaf arches out from the base along its own direction, more and more toward the tip.
    float3 archAt(constant Frame& F, float3 base, float h, float t, float phase, float stiff, float arch, float2 outDir) {
        float3 p = swayAt(F, base, h, t, phase, stiff);
        float reach = arch * h * t * t;
        p.xz += outDir * reach;
        p.y -= arch * arch * h * t * t * t * 0.45;
        return p;
    }

    struct ReedOut { float4 position [[position]]; float2 uv; float dist; float tone; float kind; float wy; float3 n; };

    /// A blade's point in the world. `inst`: (base xyz, height), (width, yaw, phase, tone + 10 x kind),
    /// (arch, out x, out z, -) per blade. Also returns the point a little further up (for the normal)
    /// and the direction across the blade.
    float3 reedPoint(constant Frame& F, float2 v, float4 a, float4 b, float4 c, thread float3& above, thread float3& across) {
        float kind = floor(b.w / 10.0);
        float t = v.y;
        float stiff = kind == 1.0 ? 0.6 : 1.0;
        // Leaves taper to a point over the last third; stalks stay even.
        float taper = kind == 1.0 ? 1.0 : (1.0 - smoothstep(0.55, 1.0, t) * 0.92);
        float3 p = archAt(F, a.xyz, a.w, t, b.z, stiff, c.x, c.yz);
        above = archAt(F, a.xyz, a.w, t + 0.01, b.z, stiff, c.x, c.yz);
        across = float3(cos(b.y), 0.0, sin(b.y));
        // A leaf twists a little along its length.
        float tw = kind == 2.0 ? sin(b.z + t * 2.5) * 0.5 * t : 0.0;
        across = normalize(across * cos(tw) + float3(0.0, sin(tw) * 0.4, 0.0));
        return p + across * v.x * b.x * taper;
    }

    vertex ReedOut reedVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float2* tmpl [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], device const float4* inst [[buffer(2)]]) {
        float2 v = tmpl[vid];
        float4 a = inst[iid * 3], b = inst[iid * 3 + 1], c = inst[iid * 3 + 2];
        float3 above, across;
        float3 p = reedPoint(F, v, a, b, c, above, across);
        float3 raw = cross(across, above - p);
        float3 n = length(raw) > 1e-6 ? normalize(raw) : float3(0.0, 0.0, 1.0);
        if (dot(n, F.camera.xyz - p) < 0.0) n = -n;
        float kind = floor(b.w / 10.0);
        float4 mv = F.view * float4(p, 1.0);
        ReedOut o;
        o.uv = float2(v.x + 0.5, v.y);
        o.dist = length(mv.xyz);
        o.tone = b.w - kind * 10.0;
        o.kind = kind;
        o.wy = p.y;
        o.n = n;
        o.position = F.proj * mv;
        return o;
    }

    vertex ShadowOut reedShadowVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float2* tmpl [[buffer(0)]],
                                      constant Frame& F [[buffer(1)]], device const float4* inst [[buffer(2)]]) {
        float3 above, across;
        ShadowOut o;
        o.position = F.shadow * float4(reedPoint(F, tmpl[vid], inst[iid * 3], inst[iid * 3 + 1], inst[iid * 3 + 2], above, across), 1.0);
        return o;
    }

    fragment float4 reedFragment(ReedOut in [[stage_in]], constant Frame& F [[buffer(0)]]) {
        float night = F.misc.z, rain = F.misc.w;
        float3 c;
        if (in.kind == 1.0) {
            // The stalk: pale green, rounded by shading the edges.
            c = mix(float3(0.36, 0.42, 0.2), float3(0.46, 0.5, 0.26), in.tone) * (0.6 + 0.6 * (1.0 - abs(in.uv.x - 0.5) * 1.6));
        } else if (in.kind == 2.0) {
            // A cattail leaf: blue-green, a pale midrib, drying to straw at the tip.
            float3 green = mix(float3(0.2, 0.34, 0.16), float3(0.3, 0.44, 0.2), in.tone);
            c = mix(green, float3(0.6, 0.52, 0.3), smoothstep(0.7, 1.0, in.uv.y) * (0.3 + 0.7 * in.tone));
            c *= 0.8 + 0.35 * sstep(0.08, 0.0, abs(in.uv.x - 0.5)) + 0.15 * sin(in.uv.x * 40.0);
        } else {
            // Reed grass: green at the water, straw at the tip, a dark midrib.
            float3 green = mix(float3(0.18, 0.28, 0.1), float3(0.3, 0.38, 0.15), in.tone);
            float3 straw = mix(float3(0.5, 0.42, 0.2), float3(0.62, 0.52, 0.3), in.tone);
            c = mix(green, straw, smoothstep(0.45, 1.0, in.uv.y) * (0.4 + 0.6 * in.tone));
            c *= 0.75 + 0.5 * smoothstep(0.0, 0.25, abs(in.uv.x - 0.5));
        }
        // Lit by the sky, brighter on top, with a backlit rim from the afterglow.
        float3 sky = mix(float3(0.55, 0.45, 0.55), float3(0.05, 0.06, 0.1), night) * (1.0 - rain * 0.4);
        float side = 0.6 + 0.4 * abs(in.n.z);
        c *= sky * side * (0.7 + 0.3 * in.uv.y);
        // Under the water the stems are dimmer and greener, and silted toward the bed.
        if (in.wy < 0.0) c *= mix(float3(0.45, 0.5, 0.4), float3(0.75, 0.8, 0.7), clamp(1.0 + in.wy, 0.0, 1.0));
        return float4(applyFog(F, c, in.dist), 1.0);
    }

    // MARK: - Reed heads (instanced): the cattail's spike and spire, the bulrush's tuft

    struct HeadOut { float4 position [[position]]; float dist; float tone; float y; float3 n; float2 uv; };

    /// `verts`: (position xyz, u), (normal xyz, v). `inst`: (base xyz, height), (scale, phase, tone, -).
    float3 headPlace(constant Frame& F, float4 a, float4 b, float3 pos, float3 nrm, thread float3& n) {
        float3 top = swayAt(F, a.xyz, a.w, 1.0, b.y, 0.6);
        float3 up = normalize(swayAt(F, a.xyz, a.w, 1.01, b.y, 0.6) - top);
        float3 side = normalize(cross(up, float3(0.0, 0.0, 1.0)));
        float3 fwd = cross(side, up);
        n = normalize(side * nrm.x + fwd * nrm.z + up * nrm.y);
        return top + (side * pos.x + fwd * pos.z + up * pos.y) * b.x;
    }

    vertex HeadOut reedHeadVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                                  constant Frame& F [[buffer(1)]], device const float4* inst [[buffer(2)]]) {
        float4 v0 = verts[vid * 2], v1 = verts[vid * 2 + 1], a = inst[iid * 2], b = inst[iid * 2 + 1];
        float3 n;
        float3 p = headPlace(F, a, b, v0.xyz, v1.xyz, n);
        float4 mv = F.view * float4(p, 1.0);
        HeadOut o;
        o.n = n;
        o.uv = float2(v0.w, v1.w);
        o.y = v0.y;
        o.tone = b.z;
        o.dist = length(mv.xyz);
        o.position = F.proj * mv;
        return o;
    }

    vertex ShadowOut reedHeadShadowVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                                          constant Frame& F [[buffer(1)]], device const float4* inst [[buffer(2)]]) {
        float3 n;
        float3 p = headPlace(F, inst[iid * 2], inst[iid * 2 + 1], verts[vid * 2].xyz, verts[vid * 2 + 1].xyz, n);
        ShadowOut o;
        o.position = F.shadow * float4(p, 1.0);
        return o;
    }

    /// The spike is a dense brown velvet; the spire above it is a pale dry stem. A bulrush's tuft is a
    /// drier, redder brown, its stalk green. T.x = 1 for tufts.
    fragment float4 reedHeadFragment(HeadOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant float4& T [[buffer(1)]]) {
        float night = F.misc.z, rain = F.misc.w;
        float3 velvet = mix(float3(0.28, 0.15, 0.08), float3(0.4, 0.22, 0.11), in.tone) * (0.92 + 0.12 * sin(in.uv.y * 90.0 + in.uv.x * 50.0));
        float3 c = in.y > 0.213 ? float3(0.5, 0.42, 0.26) : velvet;
        if (T.x > 0.5) c = in.y > 0.0 ? float3(0.36, 0.42, 0.2) : mix(float3(0.3, 0.17, 0.09), float3(0.4, 0.25, 0.13), in.tone);
        float3 sky = mix(float3(0.55, 0.45, 0.55), float3(0.05, 0.06, 0.1), night) * (1.0 - rain * 0.4);
        c *= sky * (0.45 + 0.45 * max(in.n.y, 0.0) + 0.35 * abs(in.n.z) + 0.15 * max(in.n.x, 0.0));
        return float4(applyFog(F, c, in.dist), 1.0);
    }

    // MARK: - Pondweed on the bed (instanced)

    struct WeedOut { float4 position [[position]]; float2 uv; float tone; float depth; float3 n; };

    /// The drift: a slow wave passing along the shore, each ribbon waving a beat apart.
    /// `inst`: (base xyz, height), (width, yaw, phase, tone).
    float3 weedPoint(constant Frame& F, float2 v, float4 a, float4 b, thread float3& n) {
        float3 base = a.xyz; float h = a.w;
        float w = b.x, yaw = b.y, phase = b.z;
        float t = v.y, time = F.misc.x;
        float s1 = sin(time * q(0.22) + base.x * 0.5 + phase) * 0.22 + sin(time * q(0.5) + phase * 2.1) * 0.08;
        float s2 = cos(time * q(0.17) + base.z * 0.4 + phase * 0.7) * 0.12;
        float2 lean = float2(s1, s2) * t * t;
        float3 p = base + float3(lean.x * h, h * t * (1.0 - 0.3 * dot(lean, lean)), lean.y * h);
        float3 across = float3(cos(yaw), 0.0, sin(yaw));
        // Ribbons taper to a rounded tip and curl a little across their width.
        float taper = 1.0 - smoothstep(0.75, 1.0, t) * 0.9;
        p += across * v.x * w * taper;
        float3 up = float3(2.0 * lean.x * h / max(t, 0.05), h, 2.0 * lean.y * h / max(t, 0.05));
        float3 raw = cross(across, normalize(up));
        n = length(raw) > 1e-6 ? normalize(raw) : float3(0.0, 0.0, 1.0);
        if (dot(n, F.camera.xyz - p) < 0.0) n = -n;
        return p;
    }

    vertex WeedOut weedVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float2* tmpl [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], device const float4* inst [[buffer(2)]]) {
        float3 n;
        float2 v = tmpl[vid];
        float3 p = weedPoint(F, v, inst[iid * 2], inst[iid * 2 + 1], n);
        WeedOut o;
        o.uv = float2(v.x + 0.5, v.y);
        o.tone = inst[iid * 2 + 1].w;
        o.depth = -p.y;
        o.n = n;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    vertex ShadowOut weedShadowVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float2* tmpl [[buffer(0)]],
                                      constant Frame& F [[buffer(1)]], device const float4* inst [[buffer(2)]]) {
        float3 n;
        ShadowOut o;
        o.position = F.shadow * float4(weedPoint(F, tmpl[vid], inst[iid * 2], inst[iid * 2 + 1], n), 1.0);
        return o;
    }

    fragment float4 weedFragment(WeedOut in [[stage_in]], constant Frame& F [[buffer(0)]]) {
        // Olive to bright green, a paler midrib, browning at the tips; darker the deeper it grows.
        float3 c = mix(float3(0.16, 0.3, 0.1), float3(0.3, 0.48, 0.14), in.tone);
        c = mix(c, float3(0.45, 0.38, 0.16), smoothstep(0.8, 1.0, in.uv.y) * 0.6);
        c *= 0.8 + 0.3 * sstep(0.1, 0.0, abs(in.uv.x - 0.5)) + 0.1 * sin(in.uv.x * 30.0);
        float3 sky = mix(float3(0.6, 0.5, 0.58), float3(0.06, 0.07, 0.12), F.misc.z);
        c *= sky * (0.55 + 0.45 * abs(in.n.y) + 0.25 * abs(in.n.z)) * exp(-in.depth * 0.35);
        return float4(c, 1.0);
    }

    // MARK: - Dragonfly wings

    struct WingParams { float4x4 model; float4 motion; float4 tint; };
    struct WingOut { float4 position [[position]]; float2 uv; float alpha; float dist; float3 n; };

    /// `verts`: (position xyz, u), (side, fore/hind, ghost, v). In flight the wings beat about the
    /// root: three ghosts at different phases make the blur; perched, only the first is drawn, held flat out.
    vertex WingOut wingVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], constant WingParams& W [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float side = b.x, hind = b.y, ghost = b.z;
        float flying = W.motion.x;
        float ang = flying * sin(W.motion.y + ghost * 2.1 + hind * 1.6) * 0.75;
        float c = cos(ang), s = sin(ang);
        float3 p = float3(a.x, a.y * c + a.z * side * s, a.z * c - a.y * side * s);
        WingOut o;
        o.n = normalize(float3(0.0, c, -side * s));
        o.alpha = mix(ghost < 0.5 ? 1.0 : 0.0, 0.42, flying);
        o.uv = float2(a.w, mix(b.w, 1.0 - b.w, step(0.5, side)));
        float4 mv = F.view * (W.model * float4(p, 1.0));
        o.dist = length(mv.xyz);
        o.position = F.proj * mv;
        return o;
    }

    fragment float4 wingFragment(WingOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant WingParams& W [[buffer(1)]],
                                 texture2d<float> map [[texture(0)]], sampler s [[sampler(0)]]) {
        float4 t = map.sample(s, tv(in.uv));
        if (t.a < 0.02) discard_fragment();
        float3 sky = mix(float3(0.6, 0.5, 0.6), float3(0.08, 0.09, 0.14), F.misc.z);
        // A thin-film glint across the membrane as it tilts to the light.
        float sheen = pow(abs(in.n.y), 3.0) * 0.5;
        float3 c = mix(t.rgb, W.tint.rgb, 0.5) * sky * (0.7 + sheen);
        return float4(applyFog(F, c, in.dist), t.a * in.alpha);
    }

    """
}
