import SceneKit
import simd

/// Builds the 3D model for a species once, from its parts; each `Fish` then gets its own
/// lightweight copy (shared mesh data, private materials so its swim uniforms are independent).
/// A fish is three draw calls: body, all fins (one atlas texture), and both eyes.
final class FishModel {
    /// World units per species point. 1 world unit = 100 screen points at the glass, and fish are
    /// drawn 1.3x their nominal size so they read well on a full desktop.
    static let unit: Float = 1.3 / 100

    let species: Species
    let shape: FishBody
    let body: SCNGeometry
    let fins: SCNGeometry
    let eyes: EyeModel
    /// The shark's articulated mouth (nil for other species).
    let jaw: SharkJaw?
    let noseX: Float
    let length: Float

    private static var cache: [String: FishModel] = [:]

    static func forSpecies(_ s: Species) -> FishModel {
        if let m = cache[s.id] { return m }
        let m = FishModel(s)
        cache[s.id] = m
        return m
    }

    private init(_ s: Species) {
        species = s
        let art = FishArt.forSpecies(s)
        let u = FishModel.unit
        length = Float(s.length) * u
        noseX = Float(s.length / 2) * u

        let shape = FishBody(species: s, art: art)
        self.shape = shape
        body = shape.geometry(unit: u)
        body.materials = [FishMaterials.body(s, art)]
        fins = FishFins.geometry(species: s, art: art, body: shape, unit: u)
        eyes = EyeModel(species: s, body: shape, unit: u)
        jaw = s.shape == .shark
            ? SharkJaw(species: s, unit: u) { x in
                let section = shape.section(atX: x)
                return (section.bottom, section.halfWidth)
            }
            : nil
    }
}
