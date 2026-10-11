import SceneKit

/// Shader modifiers that animate fish (body and fins).
enum FishShaders {
    /// Uniforms of the swim wave, shared by body and fins (see `FishRig.updateSwimRhythm`).
    private static let swimArguments = """
    float swimFreq;
    float swimOffset;
    float swimAmp;
    float swimBend;
    float noseX;
    float bodyLen;
    """

    /// The travelling wave's phase and envelope at the vertex; `swimBody` then applies it.
    /// The tail-beat phase runs on the GPU; the CPU only adjusts frequency/offset/amplitude when the
    /// fish's rhythm changes. `swimBend` curves the whole body into an arc while turning.
    private static let swimSetup = """
    float t = scn_frame.time;
    float swimPhase = t * swimFreq + swimOffset;
    float s = max(0.0, (noseX - _geometry.position.x) / bodyLen);
    float env = swimAmp * (0.08 + s * s);
    float k = 3.2;
    float wave = swimPhase - s * k;
    """

    /// Bends the vertex sideways in a travelling wave that grows toward the tail.
    /// Must stay in sync with `FishRig.lateralOffset(atX:)`.
    private static let swimBody = """
    float off = env * sin(wave) + swimBend * s * s;
    float dOffDs = swimAmp * 2.0 * s * sin(wave) - env * k * cos(wave) + swimBend * 2.0 * s;
    float slope = -dOffDs / bodyLen;
    _geometry.position.z += off;
    _geometry.normal = normalize(float3(_geometry.normal.x - slope * _geometry.normal.z,
                                        _geometry.normal.y, _geometry.normal.z));
    """

    /// The body: the swim wave, plus breathing near the head. The mouth opens and closes in a slow
    /// rhythm (wide for a moment after a gulp) and the gill covers flare out as it closes.
    /// Breathing values are set once per fish (`gulpTime` once per gulp): see `FishRig`.
    static let swim = """
    #pragma arguments
    \(swimArguments)
    float breathFreq;
    float breathPhase;
    float mouthAmp;
    float gillAmp;
    float gillX;
    float gulpTime;
    #pragma body
    \(swimSetup)
    float3 bn = _geometry.normal;
    if (s < gillX + 0.03) {
        float breath = sin(t * breathFreq + breathPhase);
        float sinceGulp = t - gulpTime;
        float gulp = sinceGulp < 0.0 ? 0.0 : smoothstep(0.0, 0.08, sinceGulp) * (1.0 - smoothstep(0.2, 0.65, sinceGulp));
        // Which way round the body the vertex faces: x = up/down, y = sideways.
        float2 around = normalize(bn.yz + float2(1e-5, 0.0));
        // Mouth: the lips part at the tip of the snout, the lower jaw dropping further.
        float gape = mouthAmp * bodyLen * (0.25 * max(0.0, breath) + 1.6 * gulp);
        float lip = 1.0 - smoothstep(0.0, 0.08, s);
        _geometry.position.y += gape * lip * (around.x < 0.0 ? 1.3 * around.x : 0.6 * around.x);
        _geometry.position.x -= gape * 1.6 * lip * lip * (1.0 - abs(around.x));
        // Gill covers: the rear edge (bowed forward at mid-height, like the painted one) lifts off
        // the flank, lit and shaded as it tilts.
        float flare = gillAmp * bodyLen * (max(0.0, -breath) + gulp * 0.6) * abs(around.y);
        float edge = gillX - 0.045 * around.y * around.y;
        float rise = smoothstep(edge - 0.12, edge - 0.005, s);
        float drop = 1.0 - smoothstep(edge - 0.005, edge + 0.03, s);
        float dRise = (s > edge - 0.12 && s < edge - 0.005) ? 1.0 / 0.115 : 0.0;
        float dDrop = (s > edge - 0.005 && s < edge + 0.03) ? -1.0 / 0.035 : 0.0;
        float side = sign(_geometry.position.z);
        _geometry.position.z += side * flare * rise * drop;
        // d(offset)/dx = -d(offset)/ds / bodyLen.
        float gSlope = -side * flare * (dRise * drop + rise * dDrop) / bodyLen;
        bn = normalize(float3(bn.x - gSlope * bn.z, bn.y, bn.z));
        _geometry.normal = bn;
    }
    \(swimBody)
    """

    /// Fins: each moves on its own before following the body's swim wave. Per-vertex data in the
    /// colour channel (see `FishFins.data`) says which fin a vertex belongs to and where on it.
    /// Pectorals scull, harder when hovering and flared out when braking; ripples run along the
    /// dorsal and anal fins; long flowing fins billow and trail behind the body wave.
    /// `finFrom`/`finTo` (hover, brake, -, -) ease over 0.4 s from `finTime`, so the CPU only sends
    /// new values now and then (see `FishRig.updateFins`).
    static let fins = Shaders.quantizer("finQ") + """
    #pragma arguments
    \(swimArguments)
    float finFreq;
    float finSeed;
    float4 finFrom;
    float4 finTo;
    float finTime;
    #pragma body
    float4 fd = _geometry.color;
    _geometry.color = float4(1.0);
    \(swimSetup)
    float sinceFin = t - finTime;
    float4 fs = mix(finFrom, finTo, sinceFin < 0.0 ? 1.0 : clamp(sinceFin / 0.4, 0.0, 1.0));
    float hover = fs.x;
    float brake = fs.y;
    float kind = floor(fd.x + 0.001);
    float flow = (fd.x - kind) * 2.0;
    float finPh = t * finFreq + finSeed;
    float3 fp = _geometry.position.xyz;
    float3 fn = _geometry.normal;
    if (kind > 2.5) {
        // Paired fins turn about their root edge: the tip swings between the root-to-tip
        // direction d and the outward face normal.
        float side = sign(fd.y);
        float dist = abs(fd.y);
        float3 d = float3(fd.z, fd.w, side * sqrt(max(0.0, 1.0 - fd.z * fd.z - fd.w * fd.w)));
        float3 outward = side * fn;
        float pelvic = step(3.5, kind);
        float ph = finPh + side * 0.7 + pelvic * 2.1;
        float amp = mix(mix(0.1, 0.45, hover), mix(0.05, 0.2, hover), pelvic);
        // Tucked in at speed, held out when hovering, flared wide when braking.
        float rest = mix(-0.3 * (1.0 - hover) + 0.1 + 0.9 * brake, 0.45 * brake, pelvic);
        float along = dist / bodyLen;
        float theta = rest + amp * sin(ph)
                    + flow * along * 0.4 * sin(t * finQ(finFreq * 0.5) + finSeed - along * 3.5);
        float c = cos(theta) - 1.0;
        float sn = sin(theta);
        fp += dist * (c * d + sn * outward);
        // Rowing: the tip also sweeps forward and back, a quarter beat out of step.
        fp.x += dist * amp * 0.35 * (1.0 - pelvic) * cos(ph);
        fn = fn * cos(theta) - side * d * sn;
    } else if (kind > 1.5) {
        // Tail: long tails trail behind the beat and billow on their own.
        float sp = fd.y;
        float yN = fd.z;
        float len = fd.w;
        float bph = t * finQ(finFreq * 0.55) + finSeed - 3.5 * sp + 1.8 * yN;
        float trail = env * 1.2 * (sin(wave - 1.3 * sp) - sin(wave));
        float billow = bodyLen * (0.005 + 0.05 * flow) * sin(bph);
        float lag = 0.15 + 0.6 * flow;
        float dz = sp * sp * (lag * trail + billow);
        float dzds = 2.0 * sp * (lag * trail + billow)
                   - sp * sp * bodyLen * (0.005 + 0.05 * flow) * 3.5 * cos(bph);
        float dzdy = sp * sp * bodyLen * (0.005 + 0.05 * flow) * 1.8 * cos(bph) / max(len * 0.7, 1e-4);
        fp.z += dz;
        fn = normalize(float3(fn.x + dzds / len * fn.z, fn.y - dzdy * fn.z, fn.z));
    } else if (kind > 0.5) {
        // Dorsal and anal fins: ripples run from front to back, more when hovering; long fins lag.
        float span = fd.y;
        float along = fd.z;
        float len = fd.w;
        float bend = 0.05 + 0.12 * hover + 0.18 * flow;
        float rph = t * finQ(finFreq * 1.2) + finSeed + 8.0 * along;
        float lag = flow * min(1.0, span / (0.3 * bodyLen));
        fp.z += span * bend * sin(rph) + lag * env * (sin(wave - 1.1) - sin(wave));
        float dzdx = span * bend * 8.0 / len * cos(rph);
        float dzdy = sign(fp.y) * (span > 0.0 ? bend * sin(rph) : 0.0);
        fn = normalize(float3(fn.x - dzdx * fn.z, fn.y - dzdy * fn.z, fn.z));
    }
    _geometry.position.xyz = fp;
    _geometry.normal = fn;
    \(swimBody)
    """

    /// Light shining through thin fins: they glow warmly where the sun (by day) or the night lamp
    /// lights them from behind, and stay subdued otherwise. `finGlow` = (from, to, since, night):
    /// the per-fish strength eases from `from` to `to` over 0.5 s after `since`; `lampPos` is the
    /// night lamp in world space.
    static let finGlow = """
    #pragma arguments
    float4 finGlow;
    float3 lampPos;
    #pragma body
    float sinceGlow = scn_frame.time - finGlow.z;
    float glow = mix(finGlow.x, finGlow.y, sinceGlow < 0.0 ? 1.0 : clamp(sinceGlow / 0.5, 0.0, 1.0));
    if (glow > 0.001) {
        float3 gwp = (scn_frame.inverseViewTransform * float4(_surface.position, 1.0)).xyz;
        // Toward the light: the sun (matches `Lighting`'s sun) or the lamp.
        float3 toSun = float3(0.073, 0.955, 0.287);
        float3 toLight = normalize(mix(toSun, normalize(lampPos - gwp), finGlow.w));
        float3 L = normalize((scn_frame.viewTransform * float4(toLight, 0.0)).xyz);
        float3 N = normalize(_surface.normal);
        float3 V = normalize(-_surface.position);
        // Light arriving on the far side of the fin from the viewer (a little even at grazing
        // angles, as thin fins scatter), plus a forward-scattered glow looking toward the light.
        float nv = dot(N, V);
        float through = clamp((-dot(N, L) * (nv < 0.0 ? -1.0 : 1.0) + 0.25) / 1.25, 0.0, 1.0);
        float ahead = pow(clamp(dot(-V, L), 0.0, 1.0), 4.0);
        float3 warm = mix(float3(1.0, 0.92, 0.75), float3(1.0, 0.85, 0.62), finGlow.w);
        _surface.emission.rgb += _surface.diffuse.rgb * warm * glow * (0.05 + 0.8 * through * through + 1.2 * ahead);
    }
    """
}
