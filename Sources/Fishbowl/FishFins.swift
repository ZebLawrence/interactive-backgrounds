import SceneKit
import simd

/// A species' fins: the dorsal/anal sheet, tail and both pectoral fins share one mesh and one atlas
/// texture (one draw call), bent by the same swim wave as the body.
enum FishFins {
    static func geometry(species s: Species, art: FishArt, body: FishBody, unit u: Float) -> SCNGeometry {
        var finMesh = Mesh.quad(art.finsRect, scale: u, segments: 14, uv: art.finsUV)
        finMesh.append(Mesh.quad(art.tailRect, scale: u, segments: 10, uv: art.tailUV))
        let ps = art.pectoralSize
        let pectoral = Mesh.quad(CGRect(x: -ps.width, y: -ps.height / 2, width: ps.width, height: ps.height),
                                 scale: u, uv: art.pectoralUV)
        let px = Float(s.length * 0.12)
        let halfWidth = body.section(atX: px).halfWidth
        for side: Float in [1, -1] {
            // Splayed out from the flank and angled down.
            let at = V3(px, Float(-s.height * 0.12), halfWidth * 0.9 * side) * u
            let rot = simd_float4x4(simd_quatf(angle: side * 0.55, axis: V3(0, 1, 0)) * simd_quatf(angle: 0.35, axis: V3(0, 0, 1)))
            finMesh.append(pectoral, transform: simd_float4x4(translation: at) * rot)
        }
        let geo = finMesh.geometry()
        geo.materials = [material(art.finAtlas, solid: s.shape == .shark)]
        return geo
    }

    /// Fins are translucent and faintly glowing, except a shark's, which are solid and matte.
    static func material(_ image: CGImage, solid: Bool) -> SCNMaterial {
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = image
        mat.roughness.contents = solid ? 0.85 : 0.5
        mat.isDoubleSided = true
        mat.writesToDepthBuffer = solid
        // A little self-illumination so thin fins glow when back-lit.
        mat.emission.contents = image
        mat.emission.intensity = solid ? 0 : 0.25
        if solid {
            // Cut out the fin shape and draw it opaque (blending made even fully opaque pixels look
            // see-through, as SceneKit routes any texture with alpha through its transparent pass).
            mat.blendMode = .replace
            mat.shaderModifiers = [.geometry: FishShaders.swim, .fragment: Shaders.alphaCutout]
        } else {
            mat.blendMode = .alpha
            mat.shaderModifiers = [.geometry: FishShaders.swim]
        }
        return mat
    }
}
