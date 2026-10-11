import SceneKit
import simd

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
