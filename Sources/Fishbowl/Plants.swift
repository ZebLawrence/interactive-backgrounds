import SceneKit
import simd

/// Everything that sways, merged into one mesh (one draw call): ribbon seaweed, sword plants, stem
/// plants, sea anemones and sea fans. The sway shader bends each vertex by how far up its plant it is;
/// that height fraction, the plant's height, a phase and an amplitude travel in the colour channel.
final class PlantBed {
    /// Vertical colour gradients (bottom, middle, top) in the plant atlas; `veined` adds a midrib.
    enum Tone: Int, CaseIterable {
        case green, brightGreen, darkGreen, olive, lime, red, maroon, rotala, anemone, fanPurple, fanRed

        var gradient: (RGBA, RGBA, RGBA) {
            switch self {
            case .green: return (RGBA(0.06, 0.26, 0.11), RGBA(0.16, 0.52, 0.22), RGBA(0.30, 0.66, 0.30))
            case .brightGreen: return (RGBA(0.10, 0.32, 0.10), RGBA(0.24, 0.62, 0.18), RGBA(0.50, 0.80, 0.30))
            case .darkGreen: return (RGBA(0.03, 0.16, 0.10), RGBA(0.08, 0.36, 0.22), RGBA(0.16, 0.48, 0.30))
            case .olive: return (RGBA(0.18, 0.24, 0.08), RGBA(0.36, 0.50, 0.16), RGBA(0.55, 0.64, 0.26))
            case .lime: return (RGBA(0.20, 0.40, 0.08), RGBA(0.48, 0.74, 0.20), RGBA(0.72, 0.88, 0.38))
            case .red: return (RGBA(0.25, 0.10, 0.06), RGBA(0.55, 0.20, 0.16), RGBA(0.75, 0.32, 0.20))
            case .maroon: return (RGBA(0.18, 0.05, 0.08), RGBA(0.40, 0.12, 0.18), RGBA(0.58, 0.22, 0.28))
            case .rotala: return (RGBA(0.14, 0.38, 0.14), RGBA(0.62, 0.52, 0.18), RGBA(0.92, 0.36, 0.22))
            case .anemone: return (RGBA(0.45, 0.28, 0.40), RGBA(0.78, 0.45, 0.62), RGBA(0.98, 0.82, 0.88))
            case .fanPurple: return (RGBA(0.30, 0.12, 0.38), RGBA(0.52, 0.24, 0.62), RGBA(0.70, 0.42, 0.80))
            case .fanRed: return (RGBA(0.40, 0.08, 0.10), RGBA(0.72, 0.18, 0.20), RGBA(0.92, 0.40, 0.34))
            }
        }

        var veined: Bool {
            switch self {
            case .anemone, .fanPurple, .fanRed: return false
            default: return true
            }
        }
    }

    private var mesh = Mesh()
    private(set) var node: SCNNode!
    private(set) var material: SCNMaterial!
    private var smoothedVX: Float = 0

    // MARK: - Plant builders (world-space bases)

    /// A tall ribbon of seaweed (eelgrass).
    func addBlade(at base: V3, height: Float, width: Float, tone: Tone) {
        let rows = 14
        let seed = rnd(0...10)
        let lean = rnd(-0.12...0.12) * height
        var b = Mesh()
        for r in 0...rows {
            let v = Float(r) / Float(rows)
            let half = width / 2 * (1 - pow(v, 3) * 0.95) * (0.85 + 0.15 * sin(v * 9 + seed))
            let cx = width * 0.3 * sin(v * 5 + seed)
            let z = lean * v * v
            b.positions += [V3(cx - half, v * height, z), V3(cx + half, v * height, z)]
            b.uvs += [uv(tone, 0.1, v), uv(tone, 0.9, v)]
        }
        for r in 0..<rows { b.quad(r * 2, r * 2 + 1, r * 2 + 2, r * 2 + 3) }
        emit(b, at: base, height: height, amp: rnd(0.06...0.14) * height / 2.5)
    }

    /// A rosette of broad, arching leaves (Amazon sword; short and wide for an Anubias look).
    func addSword(at base: V3, size: Float, leaves: Int, width: Float, tone: Tone) {
        var plant = Mesh()
        var top: Float = 0.01
        for i in 0..<leaves {
            let az = Float(i) / Float(leaves) * 2 * .pi + rnd(-0.3...0.3)
            let rise = rnd(0.55...1.25)
            let len = size * rnd(0.6...1.0)
            let leaf = PlantBed.leafMesh(length: len, width: width * rnd(0.8...1.2), rise: rise, droop: len * 0.35, tone: tone, uvFn: uv)
            top = max(top, leaf.positions.map(\.y).max() ?? 0)
            plant.append(leaf, transform: simd_float4x4(simd_quatf(angle: az, axis: V3(0, 1, 0))))
        }
        emit(plant, at: base, height: top, amp: 0.04 * top)
    }

    /// A tall stem with pairs of small leaves all the way up (Rotala / Ludwigia).
    func addStem(at base: V3, height: Float, tone: Tone) {
        var plant = Mesh()
        let seed = rnd(0...10)
        let lean = V3(rnd(-0.15...0.15), 0, rnd(-0.15...0.15)) * height
        func stemPoint(_ v: Float) -> V3 {
            V3(sin(v * 3 + seed) * 0.04, v * height, cos(v * 2.5 + seed) * 0.04) + lean * (v * v)
        }
        // Stem: two crossed thin ribbons.
        let rows = 12
        for (dx, dz) in [(Float(1), Float(0)), (Float(0), Float(1))] {
            var s = Mesh()
            for r in 0...rows {
                let v = Float(r) / Float(rows)
                let p = stemPoint(v), w: Float = 0.012
                s.positions += [p - V3(dx, 0, dz) * w, p + V3(dx, 0, dz) * w]
                s.uvs += [uv(tone, 0.45, v * 0.8), uv(tone, 0.55, v * 0.8)]
            }
            for r in 0..<rows { s.quad(r * 2, r * 2 + 1, r * 2 + 2, r * 2 + 3) }
            plant.append(s)
        }
        // Whorls of three leaves, rotating up the stem, smaller near the top.
        var y: Float = 0.1
        var az = rnd(0...(2 * .pi))
        while y < height * 0.97 {
            let v = y / height
            for side: Float in [0, 2 * .pi / 3, 4 * .pi / 3] {
                let len = (0.22 + 0.08 * sin(v * .pi)) * (1 - v * 0.35)
                // Colour follows the plant's height (not the leaf), so red species turn red toward the top.
                let leaf = PlantBed.leafMesh(length: len, width: len * 0.34, rise: 0.45, droop: len * 0.25, tone: tone,
                                             rows: 5, uvFn: { tone, u, _ in self.uv(tone, u, v) })
                plant.append(leaf, transform: simd_float4x4(translation: stemPoint(v))
                    * simd_float4x4(simd_quatf(angle: az + side, axis: V3(0, 1, 0))))
            }
            az += .pi / 3 + rnd(-0.2...0.2)
            y += rnd(0.08...0.11)
        }
        emit(plant, at: base, height: height, amp: rnd(0.04...0.08) * height / 2)
    }

    /// A sea anemone: a short column with a crown of swaying, tapering tentacles.
    func addAnemone(at base: V3, radius: Float) {
        var a = Mesh()
        let column: Float = radius * 0.5
        a.append(PlantBed.tube(points: [V3(0, 0, 0), V3(0, column * 0.6, 0), V3(0, column, 0)],
                               radii: [radius * 0.55, radius * 0.6, radius * 0.75], sides: 14,
                               uv: { t, u in self.uv(.anemone, u, 0.05 + 0.15 * t) }))
        var top: Float = column
        for _ in 0..<90 {
            let ang = rnd(0...(2 * .pi)), r = radius * sqrt(rnd(0.05...1))
            let out = V3(cos(ang), 0, sin(ang))
            let len = radius * rnd(0.8...1.4)
            let root = V3(0, column, 0) + out * r
            let dir = (out * (0.25 + r / radius * 0.8) + V3(0, 1, 0)).normalized
            var pts: [V3] = [], radii: [Float] = []
            for k in 0...5 {
                let t = Float(k) / 5
                pts.append(root + dir * (len * t) + out * (len * 0.3 * t * t) - V3(0, len * 0.15 * t * t, 0))
                radii.append(radius * 0.085 * (1 - t * 0.8))
            }
            top = max(top, pts.map(\.y).max()!)
            a.append(PlantBed.tube(points: pts, radii: radii, sides: 5,
                                   uv: { t, u in self.uv(.anemone, u, 0.3 + 0.7 * t) }))
        }
        emit(a, at: base, height: top, amp: 0.05 * top)
    }

    /// A sea fan (gorgonian): a flat, lacy lattice of thin branches that sways gently.
    func addSeaFan(at base: V3, height: Float, facing angle: Float, tone: Tone) {
        var fan = Mesh()
        func grow(from p: V3, dir: V3, len: Float, radius: Float, depth: Int) {
            let bend = V3(rnd(-0.25...0.25), rnd(-0.05...0.1), 0)
            let mid = p + (dir + bend * 0.5).normalized * (len * 0.5)
            let end = mid + (dir + bend).normalized * (len * 0.5)
            let t0 = Float(depth) / 6, t1 = Float(depth + 1) / 6
            fan.append(PlantBed.tube(points: [p, mid, end], radii: [radius, radius * 0.9, radius * 0.8], sides: 4,
                                     uv: { t, u in self.uv(tone, u, t0 + (t1 - t0) * t) }))
            guard depth < 5 else { return }
            for side: Float in [-1, 1] {
                let spread = rnd(0.25...0.55) * side
                let d = V3(dir.x * cos(spread) - dir.y * sin(spread), dir.x * sin(spread) + dir.y * cos(spread), 0)
                grow(from: end, dir: V3(d.x, max(d.y, 0.15), 0).normalized, len: len * rnd(0.72...0.85),
                     radius: radius * 0.8, depth: depth + 1)
            }
        }
        grow(from: .zero, dir: V3(0, 1, 0), len: height * 0.3, radius: 0.025, depth: 0)
        let top = fan.positions.map(\.y).max()!
        fan.positions = fan.positions.map { $0 * (height / top) }
        emit(fan, at: base, height: height, amp: 0.015 * height, rotation: angle)
    }

    // MARK: - Finish

    /// Build the merged geometry once all plants have been added.
    func finish() {
        mesh.computeNormals()
        let geo = mesh.geometry()
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = PlantBed.atlas()
        mat.roughness.contents = 0.55
        mat.isDoubleSided = true
        mat.shaderModifiers = [.geometry: Shaders.sway, .surface: Shaders.caustics]
        mat.setValue(0.4, forKey: "causticStrength")
        Lighting.prepareCaustics(mat)
        for key in ["curX", "curY", "curVX", "eyeDist"] { mat.setValue(Float(0), forKey: key) }
        geo.materials = [mat]
        material = mat
        node = SCNNode(geometry: geo)
        mesh = Mesh()
    }

    func update(dt: Float, tank: Tank) {
        let c = tank.cursor
        let vx = c.present ? Float(c.vel.dx) / 100 : 0
        // Ease the current in and out so plants swing back smoothly after the cursor passes.
        smoothedVX += (vx - smoothedVX) * min(1, dt * (abs(vx) > abs(smoothedVX) ? 10 : 2.5))
        let g = tank.cursorGlassPoint
        material.setValue(g.x, forKey: "curX")
        material.setValue(g.y, forKey: "curY")
        material.setValue(smoothedVX, forKey: "curVX")
        material.setValue(tank.eyeDistance, forKey: "eyeDist")
    }

    // MARK: - Helpers

    /// Append a plant built in local space (base at the origin, y up), tagging each vertex with the
    /// data the sway shader needs.
    private func emit(_ plant: Mesh, at base: V3, height: Float, amp: Float, rotation: Float = rnd(0...(2 * .pi))) {
        var p = plant
        let phase = rnd(0...(2 * .pi))
        p.colors = p.positions.map { SIMD4(clamp($0.y / height, 0, 1), height, phase, amp) }
        p.normals = []
        mesh.append(p, transform: simd_float4x4(translation: base) * simd_float4x4(simd_quatf(angle: rotation, axis: V3(0, 1, 0))))
    }

    private func uv(_ tone: Tone, _ u: Float, _ v: Float) -> V2 {
        let n = Float(Tone.allCases.count)
        return V2((Float(tone.rawValue) + 0.08 + clamp(u, 0, 1) * 0.84) / n, 1 - clamp(v, 0.01, 0.99))
    }

    /// A lanceolate leaf growing along +x: rises at `rise` radians, then droops; slightly folded.
    static func leafMesh(length: Float, width: Float, rise: Float, droop: Float, tone: Tone, rows: Int = 10,
                         uvFn: (Tone, Float, Float) -> V2) -> Mesh {
        var m = Mesh()
        for r in 0...rows {
            let s = Float(r) / Float(rows)
            let x = length * s * cos(rise)
            let y = length * s * sin(rise) - droop * s * s
            let half = width / 2 * pow(sin(.pi * min(1, s * 1.05 + 0.02)), 0.8)
            let fold = half * 0.3
            m.positions += [V3(x, y + fold, -half), V3(x, y, 0), V3(x, y + fold, half)]
            m.uvs += [uvFn(tone, 0, s), uvFn(tone, 0.5, s), uvFn(tone, 1, s)]
        }
        for r in 0..<rows {
            let a = r * 3
            m.quad(a, a + 1, a + 3, a + 4)
            m.quad(a + 1, a + 2, a + 4, a + 5)
        }
        return m
    }

    /// A tube through `points` with the given radii; `uv(t, u)` maps along (t) and around (u).
    static func tube(points: [V3], radii: [Float], sides: Int, uv: (Float, Float) -> V2) -> Mesh {
        var m = Mesh()
        for (k, p) in points.enumerated() {
            let fwd = (k + 1 < points.count ? points[k + 1] - p : p - points[k - 1]).normalized
            let side = abs(fwd.y) < 0.9 ? simd_cross(fwd, V3(0, 1, 0)).normalized : simd_cross(fwd, V3(1, 0, 0)).normalized
            let up = simd_cross(side, fwd)
            let t = Float(k) / Float(points.count - 1)
            for j in 0...sides {
                let a = Float(j) / Float(sides) * 2 * .pi
                m.positions.append(p + (side * cos(a) + up * sin(a)) * radii[k])
                m.uvs.append(uv(t, Float(j) / Float(sides)))
            }
        }
        for k in 0..<(points.count - 1) {
            for j in 0..<sides {
                let a = k * (sides + 1) + j, b = a + sides + 1
                m.quad(a, a + 1, b, b + 1)
            }
        }
        return m
    }

    /// One column per tone: a vertical gradient, with a midrib and side veins for leafy tones.
    private static func atlas() -> CGImage {
        let w: CGFloat = 16, h: CGFloat = 128
        let tones = Tone.allCases
        return Art.image(size: CGSize(width: w * CGFloat(tones.count), height: h), scale: 2) { ctx in
            for tone in tones {
                let x0 = CGFloat(tone.rawValue) * w
                let (bottom, mid, top) = tone.gradient
                ctx.saveGState()
                ctx.clip(to: CGRect(x: x0, y: 0, width: w, height: h))
                Art.linear(ctx, [bottom, mid, top], [0, 0.55, 1], from: .zero, to: CGPoint(x: 0, y: h))
                if tone.veined {
                    ctx.setStrokeColor(mid.lighter(0.45).alpha(0.4).cg)
                    ctx.setLineWidth(1.2)
                    ctx.move(to: CGPoint(x: x0 + w / 2, y: 0))
                    ctx.addLine(to: CGPoint(x: x0 + w / 2, y: h))
                    ctx.strokePath()
                    ctx.setStrokeColor(mid.lighter(0.3).alpha(0.18).cg)
                    ctx.setLineWidth(0.6)
                    for j in 0..<14 {
                        let y = CGFloat(j) * 9 + 4
                        ctx.move(to: CGPoint(x: x0 + w / 2, y: y))
                        ctx.addLine(to: CGPoint(x: x0 + 1, y: y + 6))
                        ctx.move(to: CGPoint(x: x0 + w / 2, y: y))
                        ctx.addLine(to: CGPoint(x: x0 + w - 1, y: y + 6))
                    }
                    ctx.strokePath()
                }
                ctx.restoreGState()
            }
        }
    }
}

extension Mesh {
    /// Two triangles for the quad a-b (bottom edge) / c-d (top edge).
    mutating func quad(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
        triangle(a, b, c)
        triangle(b, d, c)
    }
}
