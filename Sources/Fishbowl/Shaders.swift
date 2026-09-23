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
    #pragma body
    float3 wp = (scn_frame.inverseViewTransform * float4(_surface.position, 1.0)).xyz;
    float3 wn = normalize((scn_frame.inverseViewTransform * float4(_surface.normal, 0.0)).xyz);
    float t = scn_frame.time;
    float2 cp = wp.xz * 1.3 + float2(wp.y * 0.3, 0.0);
    cp += 0.3 * float2(sin(cp.y * 1.3 + t * cauQ(0.35)), cos(cp.x * 1.1 - t * cauQ(0.3)));
    float c = cauCells(cp, t, 0.9);
    float up = clamp(wn.y * 0.8 + 0.2, 0.0, 1.0);
    _surface.emission.rgb += float3(0.55, 0.85, 0.9) * c * up * causticStrength * (0.2 + _surface.diffuse.rgb);
    """

    /// The underside of the water surface: bright, shimmering bands.
    static let surface = quantizer("surfQ") + """
    #pragma body
    float3 wp = (scn_frame.inverseViewTransform * float4(_surface.position, 1.0)).xyz;
    float t = scn_frame.time;
    float2 p = wp.xz * 0.9;
    float w = sin(p.x * 2.1 + t * surfQ(0.9) + sin(p.y * 1.7 - t * surfQ(0.6)) * 1.5)
            * sin(p.y * 2.6 - t * surfQ(0.7) + sin(p.x * 1.3 + t * surfQ(0.5)));
    float b = pow(0.5 + 0.5 * w, 3.0);
    _surface.diffuse = float4(mix(float3(0.06, 0.30, 0.40), float3(0.45, 0.80, 0.88), b), 1.0);
    """
}
