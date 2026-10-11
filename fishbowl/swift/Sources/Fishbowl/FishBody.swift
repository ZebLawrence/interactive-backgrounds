import SceneKit
import simd

/// The body's cross-section at one point along its length, in species points (see `FishArt`):
/// how far the back rises above the centre line, how far the belly drops below it, and the
/// half-width side to side (widest at the centre line).
struct BodySection {
    var top: Float
    var bottom: Float
    var halfWidth: Float
}

extension BodyProfile {
    /// Height of this half of the outline at `t` along the body (0 = tail joint, 1 = nose), as a
    /// fraction of half the species' height.
    func height(at t: CGFloat) -> CGFloat {
        let t = clamp(t, 0, 1)
        if t < peak {
            // Rising from the peduncle: a smooth swell, or pinched flat just ahead of the tail.
            let u = t / peak
            let swell = 1 - pow(1 - u, rear), pinched = u * u * (3 - 2 * u)
            return peduncle + (depth - peduncle) * lerp(swell, pinched, pinch)
        }
        let v = (t - peak) / (1 - peak)
        return depth * pow(max(0, 1 - pow(v, head)), snout)
    }
}

/// The 3D body of a species: a loft of cross-sections along the side-view outline, with the painted
/// skin wrapped round it. Other parts (fins, eyes, the shark's jaw) are placed using `section(atX:)`.
///
/// Each cross-section is two superellipses: a narrower ridge along the back and a fuller belly
/// (see `BodyProfile.roundness`). The skin's u runs along the body in points; its v is the distance
/// over the skin from the flank's centre line, so the flanks show the side-view painting at its true
/// height while the back and belly get their own strips of the image instead of a smear.
struct FishBody {
    let species: Species
    let mesh: Mesh

    /// Vertices round each cross-section (a multiple of 4, so the midlines and flanks get a vertex).
    static let ring = 28
    /// Arc-length samples per ring segment.
    private static let arcSteps = 4

    init(species s: Species, art: FishArt) {
        species = s
        let count = 36, ring = FishBody.ring
        let a = Float(s.length / 2)
        let rect = art.skinRect
        func uv(_ x: Float, _ arc: Float) -> V2 {
            V2(Float((CGFloat(x) - rect.minX) / rect.width), 1 - Float((CGFloat(arc) - rect.minY) / rect.height))
        }
        var m = Mesh()
        for i in 0...count {
            // Denser toward both ends, where the outline curves fastest.
            let t = Float(i) / Float(count)
            let f = 0.5 * t + 0.25 * (1 - cos(.pi * t))
            let x = -a + 2 * a * f
            let section = FishBody.section(s, atX: CGFloat(x))
            let arcs = FishBody.arcs(section, s)
            let equator = arcs[arcs.count / 2]
            for j in 0..<ring {
                let th = Float(j) / Float(ring) * 2 * .pi
                let p = FishBody.ringPoint(section, s, angle: th)
                m.positions.append(V3(x, p.x, p.y))
                // Both flanks share the image, mirrored, so it meets itself along the midlines.
                let k = (j <= ring / 2 ? j : ring - j) * FishBody.arcSteps
                m.uvs.append(uv(x, equator - arcs[k]))
            }
        }
        for i in 0..<count {
            for j in 0..<ring {
                let a = i * ring + j, b = i * ring + (j + 1) % ring
                m.quad(a, b, a + ring, b + ring)
            }
        }
        // Round off the tail end with a short cone, tucked into the root of the tail fin.
        let end = FishBody.section(s, atX: CGFloat(-a))
        let tip = V3(-a - (end.top + end.bottom) * 0.25, (end.top - end.bottom) / 2, 0)
        let center = m.positions.count
        m.positions.append(tip)
        m.uvs.append(uv(tip.x, tip.y))
        for j in 0..<ring { m.triangle(center, (j + 1) % ring, j) }
        mesh = m
    }

    /// Cross-section at x (species points), clamped to the body.
    func section(atX x: Float) -> BodySection {
        FishBody.section(species, atX: CGFloat(x))
    }

    /// The body as geometry, scaled to world units.
    func geometry(unit u: Float) -> SCNGeometry {
        var m = mesh
        m.positions = m.positions.map { $0 * u }
        m.computeNormals()
        return m.geometry()
    }

    // MARK: - Shape

    /// Cross-section of a species' body at x (species points).
    static func section(_ s: Species, atX x: CGFloat) -> BodySection {
        let t = clamp((x + s.length / 2) / s.length, 0, 1)
        let b = s.height / 2
        let top = s.backProfile.height(at: t) * b, bottom = s.bellyProfile.height(at: t) * b
        // Thin toward the tail (the peduncle is flattened side to side), rounder through the head.
        let taper = 0.45 + 0.55 * min(1, t / 0.4)
        return BodySection(top: Float(top), bottom: Float(bottom),
                           halfWidth: Float((top + bottom) / 2 * s.thickness * taper))
    }

    /// The point (y, z) on a cross-section at `angle` round it: 0 is the dorsal midline, π/2 the
    /// middle of the +z flank, π the ventral midline. Each half is a superellipse, so a belly with
    /// roundness 2 (the shark's) is exactly elliptical.
    static func ringPoint(_ c: BodySection, _ s: Species, angle th: Float) -> V2 {
        let up = cos(th), side = sin(th)
        let e = Float(2 / (up >= 0 ? s.backProfile.roundness : s.bellyProfile.roundness))
        let y = pow(abs(up), e) * (up >= 0 ? c.top : -c.bottom)
        let z = pow(abs(side), e) * c.halfWidth * (side >= 0 ? 1 : -1)
        return V2(y, z)
    }

    /// Distance over the skin from the dorsal midline to evenly spaced angles down one flank to the
    /// ventral midline (`ring / 2 * arcSteps + 1` values; the middle one is the flank's centre line).
    static func arcs(_ c: BodySection, _ s: Species) -> [Float] {
        let n = ring / 2 * arcSteps
        var out: [Float] = [0]
        var prev = ringPoint(c, s, angle: 0)
        for k in 1...n {
            let p = ringPoint(c, s, angle: Float(k) / Float(n) * .pi)
            out.append(out[k - 1] + simd_length(p - prev))
            prev = p
        }
        return out
    }

    /// Distance over the skin from the flank's centre line up to the dorsal midline and down to the
    /// ventral midline at x: how much of the skin image the body wraps there.
    static func girth(_ s: Species, atX x: CGFloat) -> (up: CGFloat, down: CGFloat) {
        let arcs = arcs(section(s, atX: x), s)
        let equator = arcs[arcs.count / 2]
        return (CGFloat(equator), CGFloat(arcs[arcs.count - 1] - equator))
    }
}
