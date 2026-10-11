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
    static let caustics = causticsShader()

    /// Caustics plus surface detail for the reef, whose UVs only index a colour palette: a tileable
    /// normal map is projected along the three world axes and blended by the surface's facing.
    static let reefSurface = causticsShader(extraArguments: """
        texture2d<float> detailNormal;
        float detailScale;
        float detailStrength;
        """, preBody: """
        float3 dwp = (scn_frame.inverseViewTransform * float4(_surface.position, 1.0)).xyz;
        float3 dwn = normalize((scn_frame.inverseViewTransform * float4(_surface.normal, 0.0)).xyz);
        float3 bw = pow(abs(dwn), float3(4.0));
        bw /= (bw.x + bw.y + bw.z);
        constexpr sampler dsmp(filter::linear, mip_filter::linear, address::repeat);
        float2 tx = detailNormal.sample(dsmp, dwp.zy * detailScale).xy * 2.0 - 1.0;
        float2 ty = detailNormal.sample(dsmp, dwp.xz * detailScale).xy * 2.0 - 1.0;
        float2 tz = detailNormal.sample(dsmp, dwp.xy * detailScale).xy * 2.0 - 1.0;
        float3 bump = float3(0.0, tx.y, tx.x) * bw.x + float3(ty.x, 0.0, ty.y) * bw.y + float3(tz.x, tz.y, 0.0) * bw.z;
        dwn = normalize(dwn + bump * detailStrength);
        _surface.normal = normalize((scn_frame.viewTransform * float4(dwn, 0.0)).xyz);
        """)

    static func causticsShader(extraArguments: String = "", preBody: String = "") -> String {
        quantizer("cauQ") + """
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
    \(extraArguments)
    #pragma body
    \(preBody)
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
    }

    /// The visible night-time spotlight beam: an additive cone, brightest where seen edge-on through
    /// its middle. It fades in from darkness near the top rather than starting at a hard edge.
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
    float a = pow(facing, 3.0) * mix(0.3, 1.0, h) * beamStrength * smoothstep(beamTop + 0.5, beamTop - 1.5, wp.y);
    _surface.diffuse = float4(float3(1.0, 0.93, 0.78) * a, 1.0);
    """

    /// Discard pixels outside a texture's shape so it can be drawn fully opaque.
    static let alphaCutout = """
    #pragma body
    if (_output.color.a < 0.5) { discard_fragment(); }
    _output.color.a = 1.0;
    """
}
