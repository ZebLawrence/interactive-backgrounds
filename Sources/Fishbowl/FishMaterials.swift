import SceneKit
import simd

/// Materials for fish bodies.
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
        mat.shaderModifiers = [.geometry: FishShaders.swim, .surface: Shaders.caustics]
        mat.setValue(0.35, forKey: "causticStrength")
        Lighting.prepareCaustics(mat)
        return mat
    }

    /// Per-fish touches, applied once to each fish's own copy of its body material.
    static func personalize(_ mat: SCNMaterial, species: Species) {}
}
