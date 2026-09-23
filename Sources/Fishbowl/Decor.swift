import SceneKit
import simd

// MARK: - Seaweed

/// All the seaweed in the tank as a single mesh (one draw call). Blades sway in a vertex shader,
/// which also bends them with the "current" from a moving cursor.
final class Seaweed {
    struct Blade {
        var base: V3
        var height: Float
        var width: Float
        var colorIndex: Int
    }

    static let palette = [RGBA(0.16, 0.52, 0.22), RGBA(0.22, 0.60, 0.18), RGBA(0.10, 0.42, 0.26), RGBA(0.36, 0.55, 0.16),
                          RGBA(0.27, 0.50, 0.20), RGBA(0.55, 0.20, 0.16), RGBA(0.62, 0.30, 0.14)]

    let node: SCNNode
    private let material: SCNMaterial
    private var smoothedVX: Float = 0

    init(blades: [Blade]) {
        let n = Float(Seaweed.palette.count)
        var m = Mesh()
        for blade in blades {
            let rows = 14
            let seed = rnd(0...10)
            let lean = rnd(-0.12...0.12) * blade.height
            let phase = rnd(0...(2 * .pi))
            let amp = rnd(0.06...0.14) * blade.height / 2.5
            let u0 = Float(blade.colorIndex) / n
            var b = Mesh()
            for r in 0...rows {
                let v = Float(r) / Float(rows)
                let half = blade.width / 2 * (1 - pow(v, 3) * 0.95) * (0.85 + 0.15 * sin(v * 9 + seed))
                let cx = blade.width * 0.3 * sin(v * 5 + seed)
                let z = lean * v * v
                let y = v * blade.height
                b.positions += [V3(cx - half, y, z), V3(cx + half, y, z)]
                b.uvs += [V2(u0 + 0.1 / n, 1 - v), V2(u0 + 0.9 / n, 1 - v)]
                let data = SIMD4<Float>(v, blade.height, phase, amp)
                b.colors += [data, data]
            }
            for r in 0..<rows {
                let a = r * 2
                b.triangle(a, a + 1, a + 2)
                b.triangle(a + 1, a + 3, a + 2)
            }
            b.computeNormals()
            let rot = simd_float4x4(simd_quatf(angle: rnd(0...(2 * .pi)), axis: V3(0, 1, 0)))
            m.append(b, transform: simd_float4x4(translation: blade.base) * rot)
        }
        let geo = m.geometry()
        material = SCNMaterial()
        material.lightingModel = .physicallyBased
        material.diffuse.contents = Seaweed.atlas()
        material.roughness.contents = 0.55
        material.isDoubleSided = true
        material.shaderModifiers = [.geometry: Shaders.sway, .surface: Shaders.caustics]
        material.setValue(0.4, forKey: "causticStrength")
        for key in ["curX", "curY", "curVX", "eyeDist"] { material.setValue(Float(0), forKey: key) }
        geo.materials = [material]
        node = SCNNode(geometry: geo)
    }

    func update(dt: Float, tank: Tank) {
        let c = tank.cursor
        let vx = c.present ? Float(c.vel.dx) / 100 : 0
        // Ease the current in and out so blades swing back smoothly after the cursor passes.
        smoothedVX += (vx - smoothedVX) * min(1, dt * (abs(vx) > abs(smoothedVX) ? 10 : 2.5))
        let g = tank.cursorGlassPoint
        material.setValue(g.x, forKey: "curX")
        material.setValue(g.y, forKey: "curY")
        material.setValue(smoothedVX, forKey: "curVX")
        material.setValue(tank.eyeDistance, forKey: "eyeDist")
    }

    /// One vertical blade texture per palette colour, side by side.
    private static func atlas() -> CGImage {
        let w: CGFloat = 16, h: CGFloat = 128
        return Art.image(size: CGSize(width: w * CGFloat(palette.count), height: h), scale: 2) { ctx in
            for (i, color) in palette.enumerated() {
                let x0 = CGFloat(i) * w
                ctx.saveGState()
                ctx.clip(to: CGRect(x: x0, y: 0, width: w, height: h))
                Art.linear(ctx, [color.darker(0.5), color, color.lighter(0.25)], [0, 0.55, 1],
                           from: .zero, to: CGPoint(x: 0, y: h))
                ctx.setStrokeColor(color.lighter(0.45).alpha(0.4).cg)
                ctx.setLineWidth(1.2)
                ctx.move(to: CGPoint(x: x0 + w / 2, y: 0))
                ctx.addLine(to: CGPoint(x: x0 + w / 2, y: h))
                ctx.strokePath()
                ctx.setStrokeColor(color.lighter(0.3).alpha(0.18).cg)
                ctx.setLineWidth(0.6)
                for j in 0..<14 {
                    let y = CGFloat(j) * 9 + 4
                    ctx.move(to: CGPoint(x: x0 + w / 2, y: y))
                    ctx.addLine(to: CGPoint(x: x0 + 1, y: y + 6))
                    ctx.move(to: CGPoint(x: x0 + w / 2, y: y))
                    ctx.addLine(to: CGPoint(x: x0 + w - 1, y: y + 6))
                }
                ctx.strokePath()
                ctx.restoreGState()
            }
        }
    }
}

// MARK: - Rocks

enum Rock {
    static let tones = [RGBA(0.42, 0.40, 0.37), RGBA(0.36, 0.33, 0.30), RGBA(0.50, 0.46, 0.40),
                        RGBA(0.30, 0.31, 0.33), RGBA(0.38, 0.36, 0.34)]

    /// A lumpy rock mesh, flattened underneath. `tone` indexes `tones`, so many rocks share one material.
    static func mesh(size: V3, tone: Int) -> Mesh {
        var m = Mesh.icosphere(subdivisions: 3)
        let seeds = (0..<4).map { _ in rnd(0...(2 * .pi)) }
        for i in m.positions.indices {
            let p = m.positions[i]
            let bump = 1 + 0.12 * sin(p.x * 3 + seeds[0]) * cos(p.z * 2.5 + seeds[1])
                + 0.07 * sin(p.y * 5 + seeds[2]) + 0.05 * sin((p.x + p.z) * 7 + seeds[3])
            var q = p * bump * size
            q.y = max(q.y, -size.y * 0.35)
            m.positions[i] = q
        }
        m.computeNormals()
        m.uvs = Array(repeating: Art.paletteUV(tone, of: tones.count), count: m.positions.count)
        return m
    }

    static func material() -> SCNMaterial {
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = Art.palette(tones)
        mat.diffuse.magnificationFilter = .nearest
        mat.diffuse.minificationFilter = .nearest
        mat.roughness.contents = 0.85
        mat.shaderModifiers = [.surface: Shaders.caustics]
        mat.setValue(0.8, forKey: "causticStrength")
        return mat
    }
}

// MARK: - Food

final class Food {
    static let geometry: SCNGeometry = {
        let g = SCNSphere(radius: 0.028)
        g.segmentCount = 8
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = RGBA(0.72, 0.42, 0.18).ns
        mat.roughness.contents = 0.7
        g.materials = [mat]
        return g
    }()

    let node = SCNNode(geometry: Food.geometry)
    var pos: V3
    private var vy: Float = rnd(-0.15 ... -0.05)
    private var age: Float = 0
    private let wobble = rnd(0...(2 * .pi))
    var eaten = false

    init(at p: V3) {
        pos = p
        node.simdPosition = p
        node.simdScale = V3(rnd(0.8...1.2), rnd(0.5...0.8), rnd(0.8...1.2))
    }

    /// Returns false once the flake has dissolved or been eaten.
    func update(dt: Float, floor: Float) -> Bool {
        age += dt
        if pos.y > floor {
            vy = max(vy - 0.18 * dt, -0.26)
            pos.y = max(floor, pos.y + vy * dt)
            pos.x += sin(age * 2 + wobble) * 0.08 * dt
            node.simdEulerAngles += V3(dt * 0.6, dt * 0.4, 0)
        }
        node.simdPosition = pos
        let life: Float = 40
        node.opacity = CGFloat(clamp((life - age) / 4, 0, 1))
        return age < life && !eaten
    }
}
