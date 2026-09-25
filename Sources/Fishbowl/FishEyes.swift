import SceneKit
import simd

/// A species' eyes: two small spheres on the head; each vertex picks pupil / iris / rim from a tiny
/// palette texture.
struct EyeModel {
    let geometry: SCNGeometry
    /// Model-space x of the eyes (world units), so they can follow the swim wave.
    let x: Float

    init(species s: Species, body: FishBody, unit u: Float) {
        let ex = Float(s.length / 2 - 0.17 * s.length)
        let section = body.section(atX: ex)
        let er = Float(max(1.9, min(s.length * 0.075, s.height / 2 * 0.34)) * s.eyeScale) * u
        x = ex * u
        var eyeMesh = Mesh()
        var sphere = Mesh.icosphere(subdivisions: 2)
        for side: Float in [1, -1] {
            let outward = V3(0.25, 0.1, side).normalized
            sphere.uvs = sphere.positions.map { p in
                let d = simd_dot(p, outward)
                return Art.paletteUV(d > 0.72 ? 0 : (d > 0.3 ? 1 : 2), of: 3)
            }
            let center = V3(ex * u, Float(s.height / 2 * 0.2) * u, section.halfWidth * 0.82 * u * side)
            eyeMesh.append(sphere, transform: simd_float4x4(translation: center) * simd_float4x4(diagonal: SIMD4(er, er, er, 1)))
        }
        geometry = eyeMesh.geometry()
        let eyeMat = SCNMaterial()
        eyeMat.lightingModel = .physicallyBased
        eyeMat.diffuse.contents = Art.palette([RGBA(0.01, 0.01, 0.02), s.eye, s.eye.lighter(0.4)])
        eyeMat.diffuse.magnificationFilter = .nearest
        eyeMat.roughness.contents = 0.12
        geometry.materials = [eyeMat]
    }
}

/// One fish's eyes.
final class EyeRig {
    let node: SCNNode
    private let model: EyeModel

    init(model: EyeModel, parent: SCNNode) {
        self.model = model
        node = SCNNode(geometry: model.geometry)
        node.castsShadow = false
        parent.addChildNode(node)
    }

    /// Called every frame. `lateral` is the head's sideways swim offset at the eyes, so they stay
    /// on the body as it bends.
    func update(dt: Float, fish: Fish, tank: Tank, lateral: Float) {
        node.simdPosition = V3(0, 0, lateral)
    }
}
