extension Shaders {
    static let water = """

    // MARK: - The wave simulation

    /// One step of the 2D wave equation on the height field (r = now, g = before), with a little
    /// velocity damping and a touch of diffusion: the finest ripples die within a second, the broad
    /// rings of a stone last. P: x = (c dt / dx)^2, y = damping, z = smoothing, w = splat count.
    kernel void waveStep(texture2d<float, access::read> prev [[texture(0)]], texture2d<float, access::write> next [[texture(1)]],
                         constant float4& P [[buffer(0)]], constant float4* splats [[buffer(1)]],
                         uint2 gid [[thread_position_in_grid]]) {
        int n = int(prev.get_width());
        if (int(gid.x) >= n || int(gid.y) >= n) return;
        int2 g = int2(gid);
        float2 c = prev.read(gid).rg;
        float l = prev.read(uint2(max(g.x - 1, 0), g.y)).r, r = prev.read(uint2(min(g.x + 1, n - 1), g.y)).r;
        float d = prev.read(uint2(g.x, max(g.y - 1, 0))).r, u = prev.read(uint2(g.x, min(g.y + 1, n - 1))).r;
        float lap = l + r + d + u - 4.0 * c.r;
        float h = c.r + (c.r - c.g) * (1.0 - P.y) + P.x * lap + P.z * lap * 0.25;
        float2 vUv = (float2(gid) + 0.5) / float(n);
        // Dents pressed in this frame.
        int count = int(P.w);
        for (int i = 0; i < count; i++) {
            float4 s = splats[i];
            float2 dv = vUv - s.xy;
            float q2 = dot(dv, dv) / (s.z * s.z);
            if (q2 < 4.0) h += s.w * exp(-q2 * 2.0) * (1.0 - q2 * 0.25);
        }
        // Soak up waves near the edge of the patch so they do not reflect back from it.
        float2 e = min(vUv, 1.0 - vUv);
        float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
        h *= mix(0.9, 1.0, edge);
        next.write(float4(h, c.r * mix(0.9, 1.0, edge), 0.0, 1.0), gid);
    }

    /// The heights into (slope x, slope z, height), which the surface reads filtered and mipmapped.
    kernel void waveSlopes(texture2d<float, access::read> hgt [[texture(0)]], texture2d<float, access::write> out [[texture(1)]],
                           constant float4& P [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
        int n = int(hgt.get_width());
        if (int(gid.x) >= n || int(gid.y) >= n) return;
        int2 g = int2(gid);
        float l = hgt.read(uint2(max(g.x - 1, 0), g.y)).r, r = hgt.read(uint2(min(g.x + 1, n - 1), g.y)).r;
        float d = hgt.read(uint2(g.x, max(g.y - 1, 0))).r, u = hgt.read(uint2(g.x, min(g.y + 1, n - 1))).r;
        out.write(float4((r - l) * P.x, (u - d) * P.x, hgt.read(gid).r, 1.0), gid);
    }

    // MARK: - The surface

    #define RING_N \(maxRings)

    struct WaterParams {
        float4x4 mirror;        // world to the mirror camera's clip space (unclipped)
        float4 sim;             // xy = origin of the simulated patch, z = its extent, w = ring count
        float4 rings[RING_N];   // x, z, age, amplitude
    };

    struct WaterOut { float4 position [[position]]; float3 world; float4 mirror; float viewZ; };

    vertex WaterOut waterVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], constant WaterParams& W [[buffer(2)]]) {
        float4 wp = float4(verts[vid * 2].xyz, 1.0);
        WaterOut o;
        o.world = wp.xyz;
        o.mirror = W.mirror * wp;
        float4 mv = F.view * wp;
        o.viewZ = -mv.z;
        o.position = F.proj * mv;
        return o;
    }

    /// View-space z (negative in front) from a depth-buffer value, for Metal's 0...1 depth.
    inline float viewZ(constant Frame& F, float d) {
        float n = F.screen.z, f = F.screen.w;
        float zs = f / (n - f);
        return zs * n / (-(d + zs));
    }

    /// One analytic ring: a packet whose leading edge moves out at the group speed, widening and
    /// fading as it goes. Returns the slope along the radius.
    float ringSlope(float r, float age, float amp) {
        if (age < 0.0 || age > 30.0) return 0.0;
        float R = 0.55 * age;
        float w = 0.3 + 0.1 * R;
        float lam = 0.22 + 0.05 * R;
        float x = (r - R) / w;
        if (abs(x) > 3.0) return 0.0;
        float env = amp * exp(-x * x) / (1.0 + R * 0.6) * exp(-age * 0.08);
        float ph = (r - R) * 6.2831853 / lam;
        float dEnv = env * (-2.0 * x / w);
        return dEnv * cos(ph) - env * sin(ph) * 6.2831853 / lam;
    }

    /// Rain: a hashed field of little expanding rings, each lasting well under a second and reaching
    /// a few hand-widths across before it dies, as a raindrop's capillary ring does. (The wave
    /// simulation cannot do this: it has one wave speed and no dispersion, so its rings grow into
    /// stone-sized ones.)
    float2 rainSlope(float time, float2 p, float scale, float density) {
        float2 g = p * scale;
        float2 cell = floor(g), f = fract(g) - 0.5;
        float2 acc = float2(0.0);
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            float2 o = float2(float(i), float(j));
            float2 h = hash22(cell + o);
            // Each cell gets a drop every cycle, at its own moment; the cycle count re-seeds the spot.
            float cyc = time * 1.4 + h.x;
            float t = fract(cyc);
            float2 h2 = hash22(cell + o + floor(cyc) * 0.37);
            if (h2.x > density) continue;
            float2 c = o + h2 - 0.5;
            float r = length(f - c);
            float R = t * 0.45;
            float w = 0.05 + 0.04 * t;
            float x = (r - R) / w;
            if (abs(x) < 3.0) {
                float env = exp(-x * x) * (1.0 - t) * (1.0 - t) * 0.5;
                float ph = (r - R) * 40.0;
                float s = env * (-2.0 * x / w) * cos(ph) - env * sin(ph) * 40.0;
                acc += s * (f - c) / max(r, 1e-3);
            }
        }
        return acc / scale;
    }

    fragment float4 waterFragment(WaterOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant WaterParams& W [[buffer(1)]],
                                  texture2d<float> reflection [[texture(0)]], texture2d<float> refraction [[texture(1)]],
                                  depth2d<float> refrDepth [[texture(2)]], texture2d<float> waves [[texture(3)]],
                                  sampler ps [[sampler(0)]], sampler ws [[sampler(1)]]) {
        float time = F.misc.x, night = F.misc.z, rain = F.misc.w;
        float3 toEye = F.camera.xyz - in.world;
        float dist = length(toEye);
        float3 V = toEye / dist;
        float2 p = in.world.xz;

        // Slope of the surface, from every source.
        float2 slope = float2(0.0);
        float2 suv = (p - W.sim.xy) / W.sim.z;
        if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
            float2 e = min(suv, 1.0 - suv);
            float inside = smoothstep(0.0, 0.03, min(e.x, e.y));
            slope += waves.sample(ws, suv).xy * inside;
        }
        int ringCount = int(W.sim.w);
        for (int i = 0; i < ringCount; i++) {
            float4 rg = W.rings[i];
            float2 d = p - rg.xy;
            float r = length(d);
            float s = ringSlope(r, rg.z, rg.w);
            if (s != 0.0) slope += s * d / max(r, 1e-3);
        }
        // The breeze: fine capillary ripples running downwind, strongest where a cat's paw crosses the
        // water, fading into a gentle large-scale unevenness far out where the detail would alias.
        float2 wdir = normalize(F.wind.xy + float2(1e-4, 0.0));
        float along = dot(p, wdir), across = dot(p, float2(-wdir.y, wdir.x));
        float paw = pow(fbm(float2(along * 0.05 - time * q(0.08) * 1.0, across * 0.07) + 3.1), 2.0) * 1.8 + 0.25;
        float detail = 1.0 / (1.0 + dist * 0.06);
        float fineAmp = F.wind.z * paw * detail * 0.045;
        float t1 = time * q(1.4), t2 = time * q(0.9);
        float n1 = vnoise(float2(along * 9.0 - t1 * 2.6, across * 5.0) + 7.0);
        float2 r1 = float2(n1 - vnoise(float2(along * 9.0 - t1 * 2.6 + 0.07, across * 5.0) + 7.0),
                           n1 - vnoise(float2(along * 9.0 - t1 * 2.6, across * 5.0 + 0.07) + 7.0)) / 0.07;
        float n2 = vnoise(float2(along * 3.5 - t2 * 1.4, across * 2.4) + 19.0);
        float2 r2 = float2(n2 - vnoise(float2(along * 3.5 - t2 * 1.4 + 0.1, across * 2.4) + 19.0),
                           n2 - vnoise(float2(along * 3.5 - t2 * 1.4, across * 2.4 + 0.1) + 19.0)) / 0.1;
        float2 wind = (r1 * 0.6 + r2) * fineAmp;
        slope += float2(wind.x * wdir.x - wind.y * wdir.y, wind.x * wdir.y + wind.y * wdir.x);
        // A broad, slow swell so the far water is never glassy-flat.
        slope += float2(vnoise(p * 0.12 + time * q(0.05)) - 0.5, vnoise(p.yx * 0.12 - time * q(0.04) + 5.0) - 0.5) * 0.012 * F.wind.z;
        if (rain > 0.001) {
            float near = 1.0 / (1.0 + dist * 0.02);
            slope += rainSlope(time, p, 4.0, 0.6) * rain * near * 1.2 + rainSlope(time, p + 31.0, 1.6, 0.5) * rain * near * 0.5;
        }
        float3 N = normalize(float3(-slope.x, 1.0, -slope.y));

        // Reflection of the shore and sky, bent by the ripples. The offset shrinks with distance:
        // the same slope moves a far reflection fewer pixels.
        float2 mndc = in.mirror.xy / in.mirror.w;
        float2 muv = float2(mndc.x * 0.5 + 0.5, 0.5 - mndc.y * 0.5);
        float bend = clamp(1.0 / (1.0 + dist * 0.015), 0.05, 1.0);
        float2 ruv = clamp(muv + float2(N.x * 0.35, -N.z * 0.8) * bend, float2(0.001), float2(0.999));
        float3 refl = reflection.sample(ps, ruv).rgb;

        // What is under the surface, refracted, and how much water it is seen through.
        float2 suvScreen = in.position.xy / F.screen.xy;
        float2 fuv = clamp(suvScreen - float2(N.x * 0.25, -N.z * 0.5) * bend, float2(0.001), float2(0.999));
        float dRefr = -viewZ(F, refrDepth.sample(ps, fuv));
        if (dRefr < in.viewZ) {
            fuv = suvScreen;
            dRefr = -viewZ(F, refrDepth.sample(ps, fuv));
        }
        // Along the view ray: view-space depth scaled by the ray's length per unit depth.
        float column = max(dRefr - in.viewZ, 0.0) * (dist / in.viewZ);
        float3 under = refraction.sample(ps, fuv).rgb;
        // Clear lake water: red goes first, blue-green lingers.
        float3 trans = exp(-float3(0.42, 0.26, 0.18) * column);
        float3 skyLight = mix(float3(0.36, 0.3, 0.38), float3(0.03, 0.035, 0.06), night);
        // Light scattered back out of the water itself: a veil of skylight that hides the bed beyond a few metres.
        float3 deep = mix(float3(0.03, 0.075, 0.075), float3(0.003, 0.006, 0.009), night) * (0.6 + 0.4 * skyLight.g / 0.3);
        float3 refr = under * trans + deep * (1.0 - trans);

        // Fresnel for water: glassy at a grazing angle, nearly see-through looking down.
        float cosT = clamp(dot(V, N), 0.0, 1.0);
        float Fr = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        float3 col = mix(refr, refl, Fr);

        // Glitter: the moon's image broken up by the ripples, and the last of the afterglow.
        float3 R = reflect(-V, N);
        float moonSpec = pow(max(dot(R, F.moonDir.xyz), 0.0), 1400.0);
        col += float3(0.9, 0.92, 1.0) * moonSpec * 6.0 * night * Fr * 3.0;
        // The sun's glitter path: a sharp core on each ripple facet, a soft spread around it.
        float sd = max(dot(R, F.sunDir.xyz), 0.0);
        float sunSpec = pow(sd, 900.0) * 4.0 + pow(sd, 60.0) * 0.5;
        col += float3(1.0, 0.6, 0.3) * sunSpec * (1.0 - night) * (1.0 - rain) * Fr * 1.6;

        return float4(applyFog(F, col, dist), 1.0);
    }

    // MARK: - The lake bed

    struct BedOut { float4 position [[position]]; float3 world; float3 normal; };

    vertex BedOut bedVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        BedOut o;
        o.world = verts[vid * 2].xyz;
        o.normal = verts[vid * 2 + 1].xyz;
        o.position = F.viewProj * float4(o.world, 1.0);
        return o;
    }

    /// Pebbles: a jittered grid of rounded stones, each with its own size, colour and dome.
    float4 pebbles(float2 p, float scale) {
        float2 g = p * scale;
        float2 cell = floor(g), f = fract(g);
        float best = 10.0; float2 bo = float2(0.0); float2 bc = float2(0.0); float br = 0.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            float2 o = float2(float(i), float(j));
            float2 hh = hash22(cell + o);
            float2 c = o + 0.2 + hh * 0.6;
            float rad = 0.28 + 0.2 * hash21(cell + o + 3.7);
            float d = length(f - c) / rad;
            if (d < best) { best = d; bo = f - c; bc = cell + o; br = rad; }
        }
        float stone = sstep(1.0, 0.9, best);
        // Shade the dome: the slope faces the light on one side and away on the other.
        float2 sl = bo / max(br, 1e-3);
        float dome = clamp(0.55 + 0.45 * sqrt(max(1.0 - best * best, 0.0)) - 0.35 * dot(sl, float2(0.6, 0.8)), 0.1, 1.3);
        return float4(stone, dome, hash21(bc + 1.3), hash21(bc + 9.1));
    }

    float3 bedColor(float2 p) {
        float sandN = fbm(p * 1.5) * 0.5 + fbm(p * 7.0) * 0.5;
        float grain = hash21(floor(p * 400.0)) * 0.35 + 0.825;
        float3 sand = mix(float3(0.5, 0.44, 0.32), float3(0.36, 0.32, 0.24), sandN) * grain;
        float4 big = pebbles(p, 7.0);
        float4 small = pebbles(p + 13.0, 18.0);
        // Granite greys, warm sandstone, the odd dark basalt and a pale quartz, each speckled.
        float3 stoneCol = mix(mix(float3(0.4, 0.38, 0.34), float3(0.58, 0.5, 0.4), big.z), float3(0.33, 0.34, 0.36), step(0.7, big.w));
        stoneCol = mix(stoneCol, float3(0.22, 0.2, 0.19), step(0.88, big.w));
        stoneCol = mix(stoneCol, float3(0.72, 0.68, 0.6), step(0.95, big.w));
        stoneCol *= 0.85 + 0.3 * fbm(p * 60.0 + big.z * 10.0);
        float3 smallCol = mix(float3(0.36, 0.33, 0.28), float3(0.55, 0.5, 0.42), small.z) * (0.85 + 0.3 * fbm(p * 90.0));
        float3 col = sand;
        col = mix(col, smallCol * small.y, small.x * 0.85);
        col = mix(col, stoneCol * big.y, big.x);
        // A film of algae in the hollows, greener farther out.
        float algae = smoothstep(0.45, 0.7, fbm(p * 0.6 + 7.0)) * (1.0 - big.x * 0.7);
        return mix(col, float3(0.2, 0.3, 0.14), algae * 0.6);
    }

    /// The bed as a standard material (roughness 0.9) that takes the key light's shadows, with the
    /// pebbles, the contact occlusion and the caustics painted into its albedo.
    fragment float4 bedFragment(BedOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant float4& P [[buffer(1)]],
                                texture2d<float> waves [[texture(0)]], texture2d<float> ao [[texture(1)]],
                                depth2d<float> shadowMap [[texture(2)]], sampler s [[sampler(0)]], sampler cmp [[sampler(1)]]) {
        float2 p = in.world.xz;
        float3 col = bedColor(p);
        // Caustics: the ripples focus the light where the surface is concave.
        float2 suv = (p - P.xy) / P.z;
        float caustic = 1.0;
        if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
            float tx = P.w * 2.0;
            float hc = waves.sample(s, suv).z;
            float hl = waves.sample(s, suv - float2(tx, 0.0)).z, hr = waves.sample(s, suv + float2(tx, 0.0)).z;
            float hd = waves.sample(s, suv - float2(0.0, tx)).z, hu = waves.sample(s, suv + float2(0.0, tx)).z;
            caustic = clamp(1.0 - (hl + hr + hd + hu - 4.0 * hc) * 220.0, 0.75, 1.5);
        }
        // Contact shadow: the bed is darker where rocks, logs and reed stems sit on it.
        float2 auv = (p - float2(\(aoRegion.x0), \(aoRegion.z0))) / float2(\(aoRegion.w), \(aoRegion.d));
        float occlusion = 1.0;
        if (auv.x > 0.0 && auv.x < 1.0 && auv.y > 0.0 && auv.y < 1.0) occlusion = ao.sample(s, tv(auv)).r;
        float3 albedo = col * caustic * occlusion;
        float3 n = normalize(in.normal);
        float shadow = keyShadow(F, shadowMap, cmp, in.world, n);
        float3 c = standardLight(F, albedo, n, in.world, 0.9, 0.0, shadow, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    """
}
