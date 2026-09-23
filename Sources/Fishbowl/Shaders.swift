import SceneKit

/// SceneKit shader modifiers (Metal). Custom functions are declared before `#pragma arguments`
/// and carry unique prefixes because several modifiers can end up in the same program.
enum Shaders {
    /// Shader time wraps every `Tank.timeWrap` seconds. This declares a function that rounds an angular
    /// frequency to a whole number of cycles per wrap, so every animation is exactly periodic and the
    /// wrap is invisible. Each modifier gets its own name, as several can share one program.
    static func quantizer(_ name: String) -> String {
        let k = Tank.timeWrap / (2 * Double.pi)
        return "float \(name)(float w) { return floor(w * \(k) + 0.5) / \(k); }\n"
    }

    /// Quantise an angular frequency on the CPU, matching `qw` in the shaders.
    static func quantize(_ w: Float) -> Float {
        let k = Float(Tank.timeWrap / (2 * Double.pi))
        return (w * k).rounded() / k
    }

    /// Bends a fish sideways in a travelling wave that grows toward the tail.
    /// Must stay in sync with `Fish.lateralOffset(atX:)`.
    static let swim = """
    #pragma arguments
    float swimFreq;
    float swimOffset;
    float swimAmp;
    float noseX;
    float bodyLen;
    #pragma body
    // The tail-beat phase runs on the GPU; the CPU only adjusts frequency/offset/amplitude when
    // the fish's rhythm changes (see `Fish.updateSwimUniforms`).
    float swimPhase = scn_frame.time * swimFreq + swimOffset;
    float s = max(0.0, (noseX - _geometry.position.x) / bodyLen);
    float env = swimAmp * (0.08 + s * s);
    float k = 3.2;
    float wave = swimPhase - s * k;
    float off = env * sin(wave);
    float dOffDs = swimAmp * 2.0 * s * sin(wave) - env * k * cos(wave);
    float slope = -dOffDs / bodyLen;
    _geometry.position.z += off;
    _geometry.normal = normalize(float3(_geometry.normal.x - slope * _geometry.normal.z,
                                        _geometry.normal.y, _geometry.normal.z));
    """

    /// Sways every seaweed blade in one merged mesh. Per-vertex data arrives in the colour channel
    /// (height fraction, blade height, phase, amplitude). Water pushed by the cursor bends blades
    /// that appear near it on screen.
    static let sway = quantizer("swayQ") + """
    #pragma arguments
    float curX;
    float curY;
    float curVX;
    float eyeDist;
    #pragma body
    float4 d = _geometry.color;
    _geometry.color = float4(1.0);
    float v = d.x;
    float h = d.y;
    float ph = d.z;
    float amp = d.w;
    float t = scn_frame.time;
    float spd = 0.6 + 0.5 * fract(ph * 7.13);
    float sway = amp * (sin(t * swayQ(spd) + v * 2.2 + ph) + 0.4 * sin(t * swayQ(spd * 1.7) + v * 4.0 + ph * 2.0));
    float w = pow(v, 1.6);
    float3 p = _geometry.position.xyz;
    float f = eyeDist / (eyeDist - p.z);
    float baseY = (p.y - v * h) * f;
    float inRange = step(baseY - 0.2, curY) * step(curY, baseY + h * f + 0.6);
    float prox = clamp(1.0 - abs(p.x * f - curX) / 1.5, 0.0, 1.0) * inRange;
    float bend = clamp(curVX * 0.07, -0.8, 0.8) * prox;
    _geometry.position.x += (sway + bend) * w;
    _geometry.position.z += (0.5 * sway * cos(ph) - abs(bend) * 0.3) * w;
    """

    /// Moving caustic light on upward-facing surfaces (sand, rocks, plants, fish backs).
    /// Runs at the `.surface` stage so lighting and fog still apply afterwards.
    static let caustics = quantizer("cauQ") + """
    float cauHash(float2 p) {
        p = fract(p * float2(234.34, 435.345));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
    }
    float cauCells(float2 p, float t, float speed) {
        float2 ip = floor(p);
        float2 fp = fract(p);
        float d1 = 8.0;
        float d2 = 8.0;
        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                float2 g = float2(float(i), float(j));
                float h1 = cauHash(ip + g);
                float h2 = cauHash(ip + g + 17.17);
                float2 o = 0.5 + 0.42 * sin(t * cauQ(speed * (0.5 + 0.4 * h2)) + 6.2831 * float2(h1, h2));
                float d = length(g + o - fp);
                if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
            }
        }
        return pow(clamp(1.0 - (d2 - d1) * 1.7, 0.0, 1.0), 5.0);
    }
    #pragma arguments
    float causticStrength;
    float causticNight;
    float spotX;
    float spotY;
    float spotZ;
    float spotTX;
    float spotTY;
    float spotCos;
    #pragma body
    float3 wp = (scn_frame.inverseViewTransform * float4(_surface.position, 1.0)).xyz;
    float3 wn = normalize((scn_frame.inverseViewTransform * float4(_surface.normal, 0.0)).xyz);
    float t = scn_frame.time;
    float2 cp = wp.xz * 1.3 + float2(wp.y * 0.3, 0.0);
    cp += 0.3 * float2(sin(cp.y * 1.3 + t * cauQ(0.35)), cos(cp.x * 1.1 - t * cauQ(0.3)));
    float c = cauCells(cp, t, 0.9);
    float up = clamp(wn.y * 0.8 + 0.2, 0.0, 1.0);
    // At night, caustics only appear inside the spotlight's cone. The lamp hangs at spot(X,Y,Z)
    // and aims at (TX, TY) in the same z plane.
    float3 lamp = float3(spotX, spotY, spotZ);
    float3 aim = normalize(float3(spotTX, spotTY, spotZ) - lamp);
    float cosA = dot(normalize(wp - lamp), aim);
    float inSpot = smoothstep(spotCos, cos(acos(spotCos) * 0.4), cosA);
    float gain = mix(1.0, inSpot * 1.6, causticNight);
    float3 tint = mix(float3(0.55, 0.85, 0.9), float3(1.0, 0.92, 0.75), causticNight);
    _surface.emission.rgb += tint * c * up * causticStrength * gain * (0.2 + _surface.diffuse.rgb);
    """

    /// Sum of travelling sine waves for the water surface: returns (height, dh/dx, dh/dz).
    /// Shared by the geometry (big swells) and surface (fine ripples) stages under different names.
    private static func waveFunction(_ name: String, _ q: String, waves: [(dx: Double, dz: Double, k: Double, w: Double, a: Double)]) -> String {
        var body = "float3 \(name)(float2 p, float t) {\n    float3 r = float3(0.0);\n"
        for (i, wv) in waves.enumerated() {
            let len = (wv.dx * wv.dx + wv.dz * wv.dz).squareRoot()
            let dx = wv.dx / len, dz = wv.dz / len
            body += """
                float ph\(i) = dot(p, float2(\(dx), \(dz))) * \(wv.k) + t * \(q)(\(wv.w));
                r += float3(\(wv.a) * sin(ph\(i)), \(wv.a * wv.k * dx) * cos(ph\(i)), \(wv.a * wv.k * dz) * cos(ph\(i)));

            """
        }
        return body + "    return r;\n}\n"
    }

    /// Displaces the (downward-facing, world-space) surface mesh with gentle swells.
    static let surfaceWaves = quantizer("swellQ") + waveFunction("swell", "swellQ", waves: [
        (1.0, 0.35, 1.1, 0.9, 0.05), (-0.6, 1.0, 1.7, 1.2, 0.03), (0.3, -1.0, 2.6, 1.6, 0.018), (-1.0, -0.2, 3.7, 2.1, 0.01),
    ]) + """
    #pragma body
    float3 h = swell(_geometry.position.xz, scn_frame.time);
    _geometry.position.y += h.x;
    _geometry.normal = normalize(float3(h.y, -1.0, h.z));
    """

    /// The underside of the water surface, seen from below. At these grazing angles it is a mirror
    /// (total internal reflection) showing the tank upside down, rippled by the waves. Where a wave
    /// tilts toward the viewer steeply enough, light from above breaks through as bright glints.
    static let surface = quantizer("rippleQ") + waveFunction("ripple", "rippleQ", waves: [
        (0.8, 0.6, 7.0, 2.6, 0.006), (-0.5, 0.9, 9.5, 3.1, 0.004), (1.0, -0.4, 13.0, 3.7, 0.0025),
    ]) + """
    #pragma arguments
    texture2d<float> reflectionTexture;
    float surfNight;
    float spotX;
    float spotY;
    float spotZ;
    float spotTX;
    float spotTY;
    float spotCos;
    #pragma body
    float4x4 inv = scn_frame.inverseViewTransform;
    float3 wp = (inv * float4(_surface.position, 1.0)).xyz;
    float3 camPos = (inv * float4(0.0, 0.0, 0.0, 1.0)).xyz;
    float3 V = normalize(wp - camPos);
    float3 r = ripple(wp.xz, scn_frame.time);
    float3 n = normalize((inv * float4(_surface.normal, 0.0)).xyz + float3(r.y, 0.0, r.z));

    // Where this point would land in the mirrored render, nudged by the wave slope.
    float4 clip = scn_frame.projectionTransform * float4(_surface.position, 1.0);
    float2 ndc = clip.xy / clip.w;
    float dist = length(wp - camPos);
    float2 uv = ndc * 0.5 + 0.5 + n.xz * (0.9 / (1.0 + dist * 0.15));
    constexpr sampler smp(filter::linear, address::mirrored_repeat);
    float3 mirror = reflectionTexture.sample(smp, uv).rgb;

    // Snell's window: light only gets through where the incidence angle is under ~48.6 degrees.
    float cosI = -dot(V, n);
    float window = smoothstep(0.36, 0.62, cosI);
    // Sunlight scattering through the surface: facets tilted toward the viewer glow brighter.
    float tilt = clamp(0.5 + dot(n.xz, -V.xz) * 6.0, 0.0, 1.0);
    float3 glow = mix(float3(0.05, 0.26, 0.34), float3(0.38, 0.72, 0.8), tilt * tilt) * (1.0 - 0.93 * surfNight);
    float3 col = mirror * float3(0.95, 1.05, 1.08) * 0.85 + glow * 0.5;
    col = mix(col, mix(float3(0.75, 0.95, 1.0), float3(0.02, 0.04, 0.07), surfNight), window);
    // At night, a bright rippling patch where the spotlight's cone passes through the surface.
    float3 lamp = float3(spotX, spotY, spotZ);
    float3 aim = normalize(float3(spotTX, spotTY, spotZ) - lamp);
    float cosA = dot(normalize(wp - lamp), aim);
    float disc = smoothstep(cos(acos(spotCos) * 1.2), cos(acos(spotCos) * 0.2), cosA);
    col += float3(1.0, 0.92, 0.75) * disc * surfNight * (0.35 + 1.1 * tilt * tilt + window);
    _surface.diffuse = float4(col, 1.0);
    """

    /// The visible night-time spotlight beam: an additive cone, brightest where seen edge-on through
    /// its middle and toward the surface.
    static let beam = """
    #pragma arguments
    float beamStrength;
    float beamTop;
    float beamBottom;
    #pragma body
    float3 n = normalize(_surface.normal);
    float3 v = normalize(-_surface.position);
    float facing = abs(dot(n, v));
    float3 wp = (scn_frame.inverseViewTransform * float4(_surface.position, 1.0)).xyz;
    float h = clamp((wp.y - beamBottom) / (beamTop - beamBottom), 0.0, 1.0);
    // The cone starts at the lamp above the water; nothing above the surface should show
    // (it would otherwise appear in the surface reflection).
    float a = pow(facing, 3.0) * mix(0.3, 1.0, h) * beamStrength * step(wp.y, beamTop);
    _surface.diffuse = float4(float3(1.0, 0.93, 0.78) * a, 1.0);
    """
}
