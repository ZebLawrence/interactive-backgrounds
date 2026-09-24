import SceneKit
import simd

/// Builds the 3D model for a species once; each `Fish` then gets its own lightweight copy
/// (shared mesh data, private materials so its swim uniforms are independent).
/// A fish is three draw calls: body, all fins (one atlas texture), and both eyes.
final class FishModel {
    /// World units per species point. 1 world unit = 100 screen points at the glass, and fish are
    /// drawn 1.3x their nominal size so they read well on a full desktop.
    static let unit: Float = 1.3 / 100

    let species: Species
    let body: SCNGeometry
    let fins: SCNGeometry
    let eyes: SCNGeometry
    /// The shark's articulated mouth (nil for other species).
    let jaw: SharkJaw?
    /// Fish-space x of the eyes (world units), so they can follow the swim wave.
    let eyeX: Float
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

        // Body: a loft of elliptical cross-sections following the side-view outline.
        let stations = 30, ring = 22
        var m = Mesh()
        var halfSizes: [(x: Float, hy: Float, hz: Float)] = []
        for i in 0...stations {
            let t = CGFloat(i) / CGFloat(stations)
            let pt = FishArt.topCurve(s, t)
            let hy = Float(pt.y)
            // Thin toward the tail, rounder through the head.
            let taper = Float(0.45 + 0.55 * min(1, t / 0.4))
            let hz = hy * Float(s.thickness) * taper
            halfSizes.append((Float(pt.x), hy, hz))
            for j in 0..<ring {
                let th = Float(j) / Float(ring) * 2 * .pi
                let p = V3(Float(pt.x), hy * cos(th), hz * sin(th))
                m.positions.append(p * u)
                // Project the side-view skin straight onto both flanks.
                m.uvs.append(V2(Float((CGFloat(p.x) - art.skinRect.minX) / art.skinRect.width),
                                1 - Float((CGFloat(p.y) - art.skinRect.minY) / art.skinRect.height)))
            }
        }
        for i in 0..<stations {
            for j in 0..<ring {
                let a = i * ring + j, b = i * ring + (j + 1) % ring
                let c = a + ring, d = b + ring
                m.triangle(a, b, c)
                m.triangle(b, d, c)
            }
        }
        // Cap the tail end.
        let center = m.positions.count
        m.positions.append(V3(halfSizes[0].x * u, 0, 0))
        m.uvs.append(V2(Float((CGFloat(halfSizes[0].x) - art.skinRect.minX) / art.skinRect.width), 0.5))
        for j in 0..<ring { m.triangle(center, (j + 1) % ring, j) }
        m.computeNormals()
        body = m.geometry()
        body.materials = [FishModel.bodyMaterial(s, art)]

        // Dorsal/anal sheet, tail and both pectoral fins share one mesh and one atlas texture.
        var finMesh = Mesh.quad(art.finsRect, scale: u, segments: 14, uv: art.finsUV)
        finMesh.append(Mesh.quad(art.tailRect, scale: u, segments: 10, uv: art.tailUV))
        let ps = art.pectoralSize
        let pectoral = Mesh.quad(CGRect(x: -ps.width, y: -ps.height / 2, width: ps.width, height: ps.height),
                                 scale: u, uv: art.pectoralUV)
        let px = Float(s.length * 0.12)
        let pn = halfSizes.min { abs($0.x - px) < abs($1.x - px) }!
        for side: Float in [1, -1] {
            // Splayed out from the flank and angled down.
            let at = V3(px, Float(-s.height * 0.12), pn.hz * 0.9 * side) * u
            let rot = simd_float4x4(simd_quatf(angle: side * 0.55, axis: V3(0, 1, 0)) * simd_quatf(angle: 0.35, axis: V3(0, 0, 1)))
            finMesh.append(pectoral, transform: simd_float4x4(translation: at) * rot)
        }
        fins = finMesh.geometry()
        fins.materials = [FishModel.finMaterial(art.finAtlas, solid: s.shape == .shark)]

        // Eyes: two small spheres; each vertex picks pupil / iris / rim from a tiny palette texture.
        let ex = Float(s.length / 2 - 0.17 * s.length)
        let near = halfSizes.min { abs($0.x - ex) < abs($1.x - ex) }!
        let er = Float(max(1.9, min(s.length * 0.075, s.height / 2 * 0.34)) * s.eyeScale) * u
        eyeX = ex * u
        var eyeMesh = Mesh()
        var sphere = Mesh.icosphere(subdivisions: 2)
        for side: Float in [1, -1] {
            let outward = V3(0.25, 0.1, side).normalized
            sphere.uvs = sphere.positions.map { p in
                let d = simd_dot(p, outward)
                return Art.paletteUV(d > 0.72 ? 0 : (d > 0.3 ? 1 : 2), of: 3)
            }
            let center = V3(ex * u, Float(s.height / 2 * 0.2) * u, near.hz * 0.82 * u * side)
            eyeMesh.append(sphere, transform: simd_float4x4(translation: center) * simd_float4x4(diagonal: SIMD4(er, er, er, 1)))
        }
        eyes = eyeMesh.geometry()
        let eyeMat = SCNMaterial()
        eyeMat.lightingModel = .physicallyBased
        eyeMat.diffuse.contents = Art.palette([RGBA(0.01, 0.01, 0.02), s.eye, s.eye.lighter(0.4)])
        eyeMat.diffuse.magnificationFilter = .nearest
        eyeMat.roughness.contents = 0.12
        eyes.materials = [eyeMat]

        if s.shape == .shark {
            // Body half-height/width at any x, interpolated between loft stations.
            let stations = halfSizes
            jaw = SharkJaw(species: s, unit: u) { x in
                guard let k = stations.firstIndex(where: { $0.x >= x }), k > 0 else {
                    let e = x <= stations[0].x ? stations[0] : stations[stations.count - 1]
                    return (e.hy, e.hz)
                }
                let p = stations[k - 1], q = stations[k]
                let t = (x - p.x) / max(q.x - p.x, 1e-4)
                return (p.hy + (q.hy - p.hy) * t, p.hz + (q.hz - p.hz) * t)
            }
        } else {
            jaw = nil
        }
    }

    private static func bodyMaterial(_ s: Species, _ art: FishArt) -> SCNMaterial {
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
        mat.shaderModifiers = [.geometry: Shaders.swim, .surface: Shaders.caustics]
        mat.setValue(0.35, forKey: "causticStrength")
        Lighting.prepareCaustics(mat)
        return mat
    }

    /// Fins are translucent and faintly glowing, except a shark's, which are solid and matte.
    private static func finMaterial(_ image: CGImage, solid: Bool) -> SCNMaterial {
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
            mat.shaderModifiers = [.geometry: Shaders.swim, .fragment: Shaders.alphaCutout]
        } else {
            mat.blendMode = .alpha
            mat.shaderModifiers = [.geometry: Shaders.swim]
        }
        return mat
    }
}
