import SceneKit
import simd

/// The body's cross-section at one point along its length, in species points (see `FishArt`):
/// how far the back rises above the centre line, how far the belly drops below it, and the
/// half-width side to side.
struct BodySection {
    var top: Float
    var bottom: Float
    var halfWidth: Float
}

/// The 3D body of a species: a loft of cross-sections along the side-view outline, with the painted
/// skin mapped onto it. Other parts (fins, eyes, the shark's jaw) are placed using `section(atX:)`.
struct FishBody {
    /// Loft stations from the tail joint (first) to the nose (last), in species points.
    let stations: [(x: Float, section: BodySection)]
    let mesh: Mesh

    init(species s: Species, art: FishArt) {
        let count = 30, ring = 22
        var stations: [(x: Float, section: BodySection)] = []
        var m = Mesh()
        for i in 0...count {
            let t = CGFloat(i) / CGFloat(count)
            let pt = FishArt.topCurve(s, t)
            let hy = Float(pt.y)
            // Thin toward the tail, rounder through the head.
            let taper = Float(0.45 + 0.55 * min(1, t / 0.4))
            let section = BodySection(top: hy, bottom: hy, halfWidth: hy * Float(s.thickness) * taper)
            stations.append((Float(pt.x), section))
            for j in 0..<ring {
                let th = Float(j) / Float(ring) * 2 * .pi
                let up = cos(th)
                let p = V3(Float(pt.x), up * (up >= 0 ? section.top : section.bottom), section.halfWidth * sin(th))
                m.positions.append(p)
                // Project the side-view skin straight onto both flanks.
                m.uvs.append(V2(Float((CGFloat(p.x) - art.skinRect.minX) / art.skinRect.width),
                                1 - Float((CGFloat(p.y) - art.skinRect.minY) / art.skinRect.height)))
            }
        }
        for i in 0..<count {
            for j in 0..<ring {
                let a = i * ring + j, b = i * ring + (j + 1) % ring
                m.quad(a, b, a + ring, b + ring)
            }
        }
        // Cap the tail end.
        let center = m.positions.count
        m.positions.append(V3(stations[0].x, 0, 0))
        m.uvs.append(V2(Float((CGFloat(stations[0].x) - art.skinRect.minX) / art.skinRect.width), 0.5))
        for j in 0..<ring { m.triangle(center, (j + 1) % ring, j) }
        self.stations = stations
        mesh = m
    }

    /// Cross-section at x (species points), interpolated between stations and clamped at the ends.
    func section(atX x: Float) -> BodySection {
        guard let k = stations.firstIndex(where: { $0.x >= x }), k > 0 else {
            return x <= stations[0].x ? stations[0].section : stations[stations.count - 1].section
        }
        let p = stations[k - 1], q = stations[k]
        let t = (x - p.x) / max(q.x - p.x, 1e-4)
        return BodySection(top: p.section.top + (q.section.top - p.section.top) * t,
                           bottom: p.section.bottom + (q.section.bottom - p.section.bottom) * t,
                           halfWidth: p.section.halfWidth + (q.section.halfWidth - p.section.halfWidth) * t)
    }

    /// The body as geometry, scaled to world units.
    func geometry(unit u: Float) -> SCNGeometry {
        var m = mesh
        m.positions = m.positions.map { $0 * u }
        m.computeNormals()
        return m.geometry()
    }
}
