import SceneKit
import simd

/// Materials for fish bodies: the painted skin plus, in the surface shader, each fish's own colour
/// (`personalize`) and the angle-dependent sheen of real scales (`skin`).
enum FishMaterials {
    static func body(_ s: Species, _ art: FishArt) -> SCNMaterial {
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = art.skin
        mat.roughness.contents = s.roughness ?? (s.pattern == .metallic ? 0.3 : 0.4)
        mat.metalness.contents = s.shape == .shark ? 0 : (s.pattern == .metallic ? 0.35 : 0.08)
        // Overlapping scales: about 24 along the body whatever the species' size.
        let scaleSize = s.length / 24
        mat.normal.contents = Detail.scales
        mat.normal.wrapS = .repeat
        mat.normal.wrapT = .repeat
        mat.normal.contentsTransform = SCNMatrix4MakeScale(art.skinRect.width / (scaleSize * 8),
                                                           art.skinRect.height / (scaleSize * 0.8 * 10), 1)
        mat.normal.intensity = s.pattern == .metallic ? 0.8 : (s.shape == .shark ? 0.12 : 0.5)
        mat.shaderModifiers = [.geometry: FishShaders.swim, .surface: skin]
        mat.setValue(0.35, forKey: "causticStrength")
        Lighting.prepareCaustics(mat)
        let sheen = Sheen(s)
        mat.setValue(vec(sheen.mask, sheen.swing, sheen.glow, sheen.sparkle), forKey: "fishSheen")
        // Until personalised: the species' own colours, no patches.
        mat.setValue(vec(0, 1, 1, 1), forKey: "fishLook")
        mat.setValue(vec(0, 0, 0, 0), forKey: "fishMorph")
        mat.setValue(vec(1, 1, 1, Float(art.skinRect.width / art.skinRect.height)), forKey: "fishPale")
        return mat
    }

    // MARK: - Variety

    /// Per-fish touches, applied once to each fish's own copy of its body material: a slight shift
    /// of hue, saturation and brightness for every fish, plus colour morphs for goldfish and bettas.
    static func personalize(_ mat: SCNMaterial, species s: Species) {
        var look = Look(hue: rnd(-0.05...0.05), saturation: rnd(0.9...1.1), value: rnd(0.9...1.08))
        switch s.id {
        case Species.goldfish.id: look = goldfishMorph(look)
        case Species.betta.id: look = bettaMorph(look)
        case Species.clownfish.id:
            // From pale tangerine to deep red-orange.
            look.hue = rnd(-0.1...0.04)
            look.saturation = rnd(0.95...1.15)
            look.value = rnd(0.82...1.05)
        case Species.neonTetra.id:
            look.hue = rnd(-0.03...0.03)
            look.value = rnd(0.94...1.05)
        case Species.shark.id:
            look = Look(hue: 0, saturation: rnd(0.9...1.1), value: rnd(0.95...1.04))
        default: break
        }
        mat.setValue(vec(look.hue, look.saturation, look.value, look.sheen), forKey: "fishLook")
        mat.setValue(vec(look.pale, look.dark, look.speckle, rnd(0...50)), forKey: "fishMorph")
        let skin = FishArt.forSpecies(s).skinRect
        mat.setValue(vec(look.paleColor.x, look.paleColor.y, look.paleColor.z, Float(skin.width / skin.height)),
                     forKey: "fishPale")
    }

    /// One fish's colouring, as sent to the shader.
    private struct Look {
        /// Hue rotation (radians), saturation and brightness multipliers applied to the painted skin.
        var hue: Float
        var saturation: Float
        var value: Float
        /// Scales the species' iridescence (some morphs shimmer less).
        var sheen: Float = 1
        /// Coverage (0...1) of pale blotches, black blotches and dark speckles.
        var pale: Float = 0
        var dark: Float = 0
        var speckle: Float = 0
        var paleColor = V3(0.97, 0.94, 0.88)
    }

    /// Fancy goldfish come in a handful of classic colourings; plain orange is the most common.
    private static func goldfishMorph(_ base: Look) -> Look {
        var l = base
        switch rnd(0...1) {
        case ..<0.38: // orange
            break
        case ..<0.58: // red and white
            l.hue = rnd(-0.1 ... -0.05)
            l.saturation = rnd(1.05...1.15)
            l.value = rnd(0.8...0.9)
            l.pale = rnd(0.4...0.6)
        case ..<0.74: // calico: orange, pearly blue-white and black, freckled
            l.saturation = rnd(0.8...0.95)
            l.pale = rnd(0.35...0.5)
            l.dark = rnd(0.3...0.45)
            l.speckle = 1
            l.paleColor = V3(0.84, 0.88, 0.92)
        case ..<0.87: // lemon
            l.hue = rnd(0.1...0.15)
            l.saturation = rnd(0.85...0.95)
            l.value = rnd(1.12...1.2)
        case ..<0.94: // black and orange
            l.dark = rnd(0.45...0.6)
        default: // all white
            l.pale = 1
            l.sheen = 1.2
        }
        return l
    }

    /// The painted betta is royal blue; others are turned to red, turquoise or purple.
    private static func bettaMorph(_ base: Look) -> Look {
        var l = base
        switch Int.random(in: 0..<4) {
        case 0: break // royal blue
        case 1: // red: little iridescence
            l.hue = rnd(2.55...2.7)
            l.saturation = rnd(1.1...1.25)
            l.sheen = 0.35
        case 2: // turquoise
            l.hue = rnd(-0.75 ... -0.6)
            l.value = rnd(1.0...1.1)
        default: // purple
            l.hue = rnd(0.7...0.85)
            l.sheen = 0.7
        }
        return l
    }

    // MARK: - Iridescence

    /// How a species' scales play with the light.
    private struct Sheen {
        /// 0 = none, 1 = only the saturated blue parts of the skin, 2 = the whole body.
        var mask: Float = 0
        /// How far (radians) the hue swings with viewing angle.
        var swing: Float = 0
        /// Extra brightness where the scales mirror the sun toward the viewer.
        var glow: Float = 0
        /// How strongly individual scales are tilted to catch the light (glints).
        var sparkle: Float = 0

        init(_ s: Species) {
            switch s.id {
            case Species.neonTetra.id: (mask, swing, glow, sparkle) = (1, 0.7, 0.6, 0)
            case Species.betta.id: (mask, swing, glow, sparkle) = (2, 0.55, 0.35, 0.12)
            case Species.goldfish.id: (mask, swing, glow, sparkle) = (2, 0.06, 0.1, 0.3)
            case Species.angelfish.id: (mask, swing, glow, sparkle) = (2, 0.04, 0.05, 0.12)
            default: break
            }
        }
    }

    /// The body's surface shader: caustics (with the night spotlight uniforms `Lighting` drives)
    /// preceded by the fish's own colouring and iridescence. Everything is worked out in view space.
    ///
    /// - `fishLook` (hue, saturation, value, sheen scale) recolours the skin; hue is a rotation about
    ///   the grey axis, so white bands, black bars and grey stay put.
    /// - `fishMorph` (pale, dark, speckle, seed) paints procedural blotches over the skin UVs;
    ///   `fishPale` is the pale blotches' colour and the skin's aspect ratio.
    /// - `fishSheen` (mask, swing, glow, sparkle): iridescence is masked by the painted colour, so a
    ///   repainted skin keeps working: saturated blue (the tetra stripe, a betta) or the whole body.
    ///   Like a thin film, the hue swings with the angle between the scales and the viewer (cyan
    ///   face-on, violet toward grazing) and brightens where they mirror the sun, Fresnel-weighted.
    ///   Sparkle tilts each scale of the normal map a little at random and makes it glossier, so
    ///   individual scales flash as the fish turns; being real lighting, it works under the night lamp too.
    static let skin = Shaders.causticsShader(extraArguments: """
        float4 fishLook;
        float4 fishMorph;
        float4 fishPale;
        float4 fishSheen;
        """, preBody: """
        float3 fc = _surface.diffuse.rgb;
        float fcLum = dot(fc, float3(0.2126, 0.7152, 0.0722));
        // Iridescent parts, judged from the painted colour before it is personalised.
        float fBlue = clamp((fc.b - max(fc.r, fc.g * 0.6)) / (fc.b + 0.04), 0.0, 1.0);
        float fMask = fishSheen.x > 1.5 ? 1.0 : smoothstep(0.45, 0.8, fBlue) * step(0.5, fishSheen.x);
        fMask *= fishLook.w;

        // This fish's own colour.
        fc = fmHue(fc, fishLook.x);
        float fcL = dot(fc, float3(0.2126, 0.7152, 0.0722));
        fc = max(mix(float3(fcL), fc, fishLook.y), 0.0) * fishLook.z;

        // Colour morphs: soft-edged blotches (paler toward the belly), black saddles on the back, freckles.
        float2 fuv = _surface.diffuseTexcoord * float2(fishPale.w, 1.0) + fishMorph.w;
        if (fishMorph.x > 0.0) {
            float n = fmFbm(fuv * 2.2) + (_surface.diffuseTexcoord.y - 0.5) * 0.35;
            float cover = fishMorph.x >= 1.0 ? 1.0 : smoothstep(0.02, 0.1, n - (1.0 - fishMorph.x) * 0.75 - 0.12);
            fc = mix(fc, fishPale.rgb * (0.55 + 0.6 * fcLum), cover);
        }
        if (fishMorph.y > 0.0) {
            float n = fmFbm(fuv * 3.1 + 7.3) - (_surface.diffuseTexcoord.y - 0.5) * 0.3;
            fc = mix(fc, float3(0.02, 0.018, 0.016), smoothstep(0.02, 0.08, n - (1.0 - fishMorph.y) * 0.75 - 0.1));
        }
        if (fishMorph.z > 0.0) {
            // Round freckles: one in about a third of the cells of a fine grid, each off-centre.
            float2 fp = fuv * 22.0 + 3.1;
            float2 fcell = floor(fp);
            float2 fo = float2(fmHash(fcell + 2.9), fmHash(fcell + 8.3)) * 0.5 + 0.25;
            float fr = 0.12 + 0.14 * fmHash(fcell + 4.7);
            float freckle = smoothstep(fr, fr * 0.6, length(fract(fp) - fo)) * step(0.66, fmHash(fcell));
            fc *= 1.0 - 0.85 * fishMorph.z * freckle;
        }

        float3 fn = normalize(_surface.normal);
        float3 fv = normalize(-_surface.position);
        // Glints: each scale is a small mirror at its own angle.
        if (fishSheen.w > 0.0) {
            float2 st = _surface.normalTexcoord * float2(8.0, 10.0);
            float col = floor(st.x);
            float2 sp = float2(st.x, st.y - 0.5 * fmod(abs(col), 2.0));
            float2 cell = floor(sp);
            // Strongest mid-scale, fading to the plain normal map at its rim, so scales stay round.
            float2 d = (fract(sp) - 0.5) * float2(1.0, 0.8);
            float dome = clamp(1.0 - dot(d, d) * 4.0, 0.0, 1.0) * fMask;
            float3 tilt = float3(fmHash(cell), fmHash(cell + 11.7), fmHash(cell + 23.1)) - 0.5;
            fn = normalize(fn + (scn_node.modelViewTransform * float4(tilt, 0.0)).xyz * fishSheen.w * dome);
            _surface.normal = fn;
            float shiny = step(0.6, fmHash(cell + 5.3)) * dome;
            _surface.roughness = mix(_surface.roughness, 0.15, shiny);
        }
        if (fishSheen.x > 0.0) {
            float3 fl = normalize((scn_frame.viewTransform * float4(0.07, 0.95, 0.29, 0.0)).xyz);
            float nv = clamp(dot(fn, fv), 0.0, 1.0);
            float nh = clamp(dot(fn, normalize(fl + fv)), 0.0, 1.0);
            float fres = pow(1.0 - nv, 3.0);
            // Thin-film-like swing: greener face-on, violet toward grazing and away from the light.
            float swing = clamp((nv - 0.55) * 2.2 + (nh - 0.75) * 1.2, -1.0, 1.0);
            float3 irid = fmHue(fc, -fishSheen.y * swing);
            float boost = 1.0 + fishSheen.z * (0.5 * fres + pow(nh, 12.0));
            fc = mix(fc, irid * boost, fMask);
        }
        _surface.diffuse.rgb = min(fc, 1.0);
        """)
        .replacingOccurrences(of: "#pragma arguments", with: helpers + "#pragma arguments")

    /// Functions used by `skin`; they must precede `#pragma arguments`.
    private static let helpers = """
    float3 fmHue(float3 c, float a) {
        const float3 k = float3(0.57735);
        float ca = cos(a);
        return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
    }
    float fmHash(float2 p) {
        p = fract(p * float2(127.1, 311.7));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
    }
    float fmNoise(float2 p) {
        float2 i = floor(p);
        float2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(fmHash(i), fmHash(i + float2(1.0, 0.0)), f.x),
                   mix(fmHash(i + float2(0.0, 1.0)), fmHash(i + float2(1.0, 1.0)), f.x), f.y);
    }
    float fmFbm(float2 p) {
        return 0.6 * fmNoise(p) + 0.28 * fmNoise(p * 2.13 + 1.7) + 0.12 * fmNoise(p * 4.37 + 4.1);
    }

    """

    private static func vec(_ x: Float, _ y: Float, _ z: Float, _ w: Float) -> NSValue {
        NSValue(scnVector4: SCNVector4(x, y, z, w))
    }
}
