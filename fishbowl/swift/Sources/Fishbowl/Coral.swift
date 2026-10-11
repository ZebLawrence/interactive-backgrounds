import SceneKit
import simd

/// Static reef pieces (brain, branching and table corals, live rock), merged into one mesh and
/// coloured from a shaded palette: each row is a colour, running dark (u = 0) to pale (u = 1).
final class CoralReef {
    enum Tone: Int, CaseIterable {
        // Rows blend into their neighbours where a triangle spans two tones, so the rock tones sit
        // next to the coralline algae colour that patches them.
        case pink, orange, purple, tan, teal, bone, red, green, rock, coralline, rockPurple

        var color: RGBA {
            switch self {
            case .pink: return RGBA(0.92, 0.46, 0.52)
            case .orange: return RGBA(0.95, 0.52, 0.22)
            case .purple: return RGBA(0.56, 0.32, 0.68)
            case .tan: return RGBA(0.82, 0.70, 0.42)
            case .teal: return RGBA(0.30, 0.62, 0.55)
            case .bone: return RGBA(0.88, 0.84, 0.76)
            case .red: return RGBA(0.78, 0.18, 0.18)
            case .green: return RGBA(0.35, 0.78, 0.45)
            case .rock: return RGBA(0.40, 0.37, 0.33)
            case .coralline: return RGBA(0.62, 0.42, 0.50)
            case .rockPurple: return RGBA(0.42, 0.33, 0.40)
            }
        }
    }

    private var mesh = Mesh()
    /// Which piece each vertex belongs to (for baking occlusion).
    private var pieceOfVertex: [Int] = []
    /// Spheres approximating each piece, for contact shadows on the reef and the sand.
    private(set) var occluders: [Occluder] = []
    private(set) var node: SCNNode!
    private(set) var material: SCNMaterial!

    // MARK: - Pieces

    /// A domed brain coral with meandering grooves.
    func addBrain(at base: V3, radius: Float, tone: Tone) {
        var m = Mesh.icosphere(subdivisions: radius > 0.35 ? 5 : 4)
        let s = (0..<3).map { _ in rnd(0...(2 * .pi)) }
        let f = rnd(11...14)
        var shades: [Float] = []
        for i in m.positions.indices {
            let p = m.positions[i]
            // Contours of a warped noise field make winding valleys between rounded ridges.
            let g = sin(f * p.x + 2.5 * sin(9 * p.y + s[0])) + sin(f * p.y + 2.5 * sin(9 * p.z + s[1]))
                + sin(f * p.z + 2.5 * sin(9 * p.x + s[2]))
            let ridge = abs(sin(g * 1.6))
            var q = p * (1 + 0.045 * (ridge - 0.5))
            q.y = max(q.y * 0.72, -0.08)
            m.positions[i] = q * radius
            shades.append(0.25 + 0.65 * ridge)
        }
        m.uvs = shades.map { uv(tone, $0) }
        add(m, at: base, occluder: (V3(0, radius * 0.3, 0), radius * 0.85))
    }

    /// A staghorn-style coral: tapering branches that split, with pale growing tips.
    func addBranching(at base: V3, height: Float, tone: Tone) {
        var m = Mesh()
        let maxDepth = 4
        func grow(from p: V3, dir: V3, len: Float, radius: Float, depth: Int) {
            let bend = V3(rnd(-0.3...0.3), rnd(-0.1...0.2), rnd(-0.3...0.3))
            let mid = p + (dir + bend * 0.4).normalized * (len * 0.5)
            let end = mid + (dir + bend).normalized * (len * 0.5)
            let last = depth == maxDepth
            let t0 = Float(depth) / Float(maxDepth + 1), t1 = Float(depth + 1) / Float(maxDepth + 1)
            let tipR = last ? radius * 0.35 : radius * 0.75
            m.append(PlantBed.tube(points: [p, mid, end], radii: [radius, radius * 0.88, tipR], sides: 7,
                                   uv: { t, _ in self.uv(tone, 0.2 + 0.75 * (t0 + (t1 - t0) * t)) }))
            if last {
                m.append(cap(at: end, radius: tipR, tone: tone))
                return
            }
            for _ in 0..<Int.random(in: 2...3) {
                let d = (dir * 0.6 + V3(rnd(-1...1), rnd(0.3...1), rnd(-1...1)).normalized * 0.7).normalized
                grow(from: end, dir: d, len: len * rnd(0.7...0.85), radius: radius * 0.75, depth: depth + 1)
            }
        }
        grow(from: .zero, dir: V3(0, 1, 0), len: height * 0.32, radius: height * 0.07, depth: 0)
        add(m, at: base, occluder: (V3(0, height * 0.4, 0), height * 0.3))
    }

    /// A table coral: a wavy plate on a short stalk, paler toward the rim.
    func addTable(at base: V3, radius: Float, tone: Tone) {
        var m = PlantBed.tube(points: [V3(0, 0, 0), V3(0, radius * 0.25, 0), V3(0, radius * 0.45, 0)],
                              radii: [radius * 0.22, radius * 0.14, radius * 0.18], sides: 10,
                              uv: { _, _ in self.uv(tone, 0.3) })
        let rings = 8, segs = 40
        let phase = rnd(0...(2 * .pi))
        func plate(offset: Float) -> Mesh {
            var p = Mesh()
            for r in 0...rings {
                let t = Float(r) / Float(rings)
                for s in 0...segs {
                    let a = Float(s) / Float(segs) * 2 * .pi
                    let rr = radius * t * (1 + 0.08 * sin(a * 5 + phase))
                    let y = radius * 0.45 + radius * (0.12 * t * t + 0.05 * t * sin(a * 3 + phase)) + offset
                    p.positions.append(V3(cos(a) * rr, y, sin(a) * rr))
                    p.uvs.append(uv(tone, 0.3 + 0.65 * t))
                }
            }
            for r in 0..<rings {
                for s in 0..<segs {
                    let a = r * (segs + 1) + s, b = a + segs + 1
                    if offset >= 0 { p.quad(a, a + 1, b, b + 1) } else { p.quad(a + 1, a, b + 1, b) }
                }
            }
            return p
        }
        m.append(plate(offset: 0))
        m.append(plate(offset: -radius * 0.05))
        add(m, at: base, occluder: (V3(0, radius * 0.5, 0), radius * 0.8))
    }

    /// A porous lump of live rock, for building reef mounds.
    func addRock(at base: V3, size: V3, tone: Tone) {
        var m = Mesh.icosphere(subdivisions: 3)
        let s = (0..<5).map { _ in rnd(0...(2 * .pi)) }
        var shades: [Float] = []
        for i in m.positions.indices {
            let p = m.positions[i]
            let bump = 1 + 0.14 * sin(p.x * 3 + s[0]) * cos(p.z * 2.5 + s[1]) + 0.08 * sin(p.y * 5 + s[2])
            // Small pits and nodules give it a rough, porous look.
            let pits = sin(p.x * 17 + s[3]) * sin(p.y * 19 + s[4]) * sin(p.z * 15)
            var q = p * (bump + 0.05 * pits) * size
            q.y = max(q.y, -size.y * 0.35)
            m.positions[i] = q
            shades.append(0.35 + 0.35 * (pits * 0.5 + 0.5) + 0.2 * max(0, p.y))
        }
        // Blotches of pink coralline algae on the upper surfaces.
        let blotch = (0..<3).map { _ in rnd(0...(2 * .pi)) }
        m.uvs = m.positions.indices.map { i in
            let p = m.positions[i] / size
            let n = sin(p.x * 7 + blotch[0]) * sin(p.z * 7 + blotch[1]) + 0.6 * sin(p.y * 9 + p.x * 3 + blotch[2])
            let coralline = n > 0.55 && p.y > 0
            return uv(coralline ? .coralline : tone, shades[i])
        }
        add(m, at: base, occluder: (.zero, (size.x + size.y + size.z) / 3 * 0.95), rotation: rnd(0...(2 * .pi)))
    }

    /// A clump of finger (pillar) coral: upright rounded columns.
    func addFingers(at base: V3, size: Float, tone: Tone) {
        var m = Mesh()
        for _ in 0..<Int.random(in: 5...9) {
            let off = V3(rnd(-1...1), 0, rnd(-1...1)) * (size * 0.35)
            let h = size * rnd(0.5...1.0), r = size * rnd(0.07...0.11)
            let lean = V3(rnd(-0.15...0.15), 0, rnd(-0.15...0.15)) * h
            let pts = [off, off + V3(0, h * 0.5, 0) + lean * 0.3, off + V3(0, h, 0) + lean]
            m.append(PlantBed.tube(points: pts, radii: [r * 1.1, r, r * 0.95], sides: 8,
                                   uv: { t, _ in self.uv(tone, 0.35 + 0.5 * t) }))
            m.append(cap(at: pts[2], radius: r * 0.95, tone: tone))
        }
        add(m, at: base, occluder: (V3(0, size * 0.35, 0), size * 0.45))
    }

    /// A cluster of button polyps (zoanthids): little stalked discs with pale centres.
    func addPolyps(at base: V3, radius: Float, tone: Tone) {
        var m = Mesh()
        for _ in 0..<Int.random(in: 8...14) {
            let a = rnd(0...(2 * .pi)), d = radius * sqrt(rnd(0...1))
            let p = V3(cos(a) * d, 0, sin(a) * d)
            let r = radius * rnd(0.16...0.24), h = radius * rnd(0.15...0.35)
            m.append(PlantBed.tube(points: [p, p + V3(0, h, 0)], radii: [r * 0.6, r * 0.7], sides: 7,
                                   uv: { _, _ in self.uv(tone, 0.3) }))
            // The disc: a flat fan from a bright centre to a darker rim.
            let top = p + V3(0, h, 0)
            let c = m.positions.count
            m.positions.append(top + V3(0, r * 0.15, 0))
            m.uvs.append(uv(tone, 1.0))
            for k in 0...10 {
                let ang = Float(k) / 10 * 2 * .pi
                m.positions.append(top + V3(cos(ang) * r, 0, sin(ang) * r))
                m.uvs.append(uv(tone, 0.5))
            }
            for k in 0..<10 { m.triangle(c, c + 2 + k, c + 1 + k) }
        }
        add(m, at: base, occluder: (V3(0, radius * 0.2, 0), radius * 0.7))
    }

    /// A small smooth pebble.
    func addPebble(at base: V3, radius: Float, tone: Tone) {
        var m = Mesh.icosphere(subdivisions: 1)
        let squash = V3(rnd(0.8...1.3), rnd(0.45...0.7), rnd(0.8...1.2)) * radius
        m.positions = m.positions.map { $0 * squash }
        m.uvs = Array(repeating: uv(tone, rnd(0.4...0.8)), count: m.positions.count)
        add(m, at: base, occluder: (V3(0, radius * 0.4, 0), radius * 1.1))
    }

    // MARK: - Finish

    /// Build the merged geometry, baking contact shadows: darker where pieces meet the floor
    /// (`floor(x, z)` gives its height), face downward, or press against their neighbours.
    func finish(floor: (Float, Float) -> Float) {
        mesh.computeNormals()
        for i in mesh.positions.indices {
            let p = mesh.positions[i], n = mesh.normals[i]
            let aboveFloor = p.y - floor(p.x, p.z)
            var vis = 0.3 + 0.7 * smoothstep(-0.05, 0.5, aboveFloor)
            vis *= 0.8 + 0.2 * clamp(n.y * 0.5 + 0.5, 0, 1)
            vis *= Occlusion.visibility(at: p, normal: n, occluders: occluders, ignoring: pieceOfVertex[i], strength: 1)
            // Shade runs along u in the palette (dark → pale), so occlusion just darkens it.
            let shade = (mesh.uvs[i].x - 0.05) / 0.9
            mesh.uvs[i].x = 0.05 + clamp(shade * vis, 0, 1) * 0.9
        }
        let geo = mesh.geometry()
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = CoralReef.palette()
        mat.roughness.contents = 0.8
        mat.shaderModifiers = [.surface: Shaders.reefSurface]
        mat.setValue(0.7, forKey: "causticStrength")
        mat.setValue(SCNMaterialProperty(contents: Detail.rock), forKey: "detailNormal")
        mat.setValue(Float(1.1), forKey: "detailScale")
        mat.setValue(Float(0.7), forKey: "detailStrength")
        Lighting.prepareCaustics(mat)
        geo.materials = [mat]
        material = mat
        node = SCNNode(geometry: geo)
        mesh = Mesh()
        pieceOfVertex = []
    }

    // MARK: - Helpers

    private func add(_ piece: Mesh, at base: V3, occluder: (offset: V3, radius: Float),
                     rotation: Float = rnd(0...(2 * .pi))) {
        var p = piece
        p.normals = []
        let id = occluders.count
        occluders.append(Occluder(center: base + occluder.offset, radius: occluder.radius, piece: id))
        pieceOfVertex += Array(repeating: id, count: p.positions.count)
        mesh.append(p, transform: simd_float4x4(translation: base) * simd_float4x4(simd_quatf(angle: rotation, axis: V3(0, 1, 0))))
    }

    private func cap(at p: V3, radius: Float, tone: Tone) -> Mesh {
        var m = Mesh.icosphere(subdivisions: 1)
        m.positions = m.positions.map { p + $0 * radius }
        m.uvs = Array(repeating: uv(tone, 0.97), count: m.positions.count)
        m.normals = []
        return m
    }

    /// `shade` 0...1 runs dark to pale within the palette's normal range (occlusion can go darker).
    private func uv(_ tone: Tone, _ shade: Float) -> V2 {
        V2(0.05 + (0.15 + 0.85 * clamp(shade, 0, 1)) * 0.9, (Float(tone.rawValue) + 0.5) / Float(Tone.allCases.count))
    }

    /// Rows of colours, each shading from a deep shadow tone to a pale, sun-bleached tip.
    private static func palette() -> CGImage {
        let tones = Tone.allCases
        return Art.image(size: CGSize(width: 32, height: tones.count), scale: 1) { ctx in
            for tone in tones {
                let c = tone.color
                // CG rows count up from the bottom; UV rows count down from the top.
                let y = CGFloat(tones.count - 1 - tone.rawValue)
                ctx.saveGState()
                ctx.clip(to: CGRect(x: 0, y: y, width: 32, height: 1))
                // Shades 0.15...1 are the normal range; below that is extra depth for baked contact shadows.
                Art.linear(ctx, [c.darker(0.85), c.darker(0.55), c, c.lighter(0.45)], [0, 0.15, 0.62, 1],
                           from: CGPoint(x: 0, y: y), to: CGPoint(x: 32, y: y))
                ctx.restoreGState()
            }
        }
    }
}
