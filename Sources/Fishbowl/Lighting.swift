import AppKit
import SceneKit
import simd

/// Day/night lighting. By day, sunlight comes down through the surface; at night the tank goes dark
/// apart from a lamp hanging above the water that swivels to aim at the cursor, with a visible beam,
/// caustics only inside its cone, and a bright patch where it enters the surface. Switching fades over ~2 s.
final class Lighting {
    let sun = SCNLight()
    let fill = SCNLight()
    let ambient = SCNLight()
    let spot = SCNLight()
    private let spotNode = SCNNode()
    /// Pivots at the lamp; the beam cone hangs from it along its -y axis.
    private let beamPivot = SCNNode()
    private let beamMaterial = SCNMaterial()

    /// Materials using `Shaders.caustics` that should confine caustics to the spotlight at night.
    var causticMaterials: [SCNMaterial] = []
    var surfaceMaterial: SCNMaterial?

    /// 0 = day, 1 = night (animated).
    private(set) var night: Float
    /// Where the lamp hangs, above the middle of the water.
    let spotPosition: V3
    /// The point the lamp is aimed at (follows the cursor, in the lamp's z plane).
    private(set) var spotTarget: V3
    /// Half-angle of the spotlight cone.
    let spotHalfAngle: Float = 16 * .pi / 180
    private let spotHeight: Float = 5
    private let floorY: Float
    private let surfaceY: Float
    private var lastApplied: Float = -1
    private var sentTarget = V3(repeating: .nan)
    private var spotConstantsSent = false

    static let dayWater = RGBA(0.035, 0.2, 0.29)
    static let nightWater = RGBA(0.004, 0.022, 0.045)

    init(scene: SCNScene, surfaceY: Float, floorY: Float, depth: Float, eyeDistance: Float) {
        night = Settings.shared.nightMode ? 1 : 0
        spotPosition = V3(0, surfaceY + spotHeight, -depth * 0.45)
        spotTarget = V3(0, (surfaceY + floorY) / 2, spotPosition.z)
        self.floorY = floorY
        self.surfaceY = surfaceY

        // Sunlight from above casting shadows, a soft fill from the viewer, blue ambient.
        sun.type = .directional
        sun.castsShadow = true
        sun.shadowMapSize = CGSize(width: 2048, height: 2048)
        sun.shadowSampleCount = 8
        sun.shadowRadius = 4
        sun.shadowColor = NSColor(white: 0, alpha: 0.5)
        sun.automaticallyAdjustsShadowProjection = true
        sun.maximumShadowDistance = CGFloat(eyeDistance + depth + 2)
        let sunNode = SCNNode()
        sunNode.light = sun
        sunNode.simdEulerAngles = V3(-.pi / 2 + 0.3, 0.25, 0)
        scene.rootNode.addChildNode(sunNode)

        fill.type = .directional
        fill.color = RGBA(0.6, 0.85, 0.95).ns
        let fillNode = SCNNode()
        fillNode.light = fill
        fillNode.simdEulerAngles = V3(-0.35, 0, 0)
        scene.rootNode.addChildNode(fillNode)

        ambient.type = .ambient
        let ambientNode = SCNNode()
        ambientNode.light = ambient
        scene.rootNode.addChildNode(ambientNode)

        // The night spotlight, hanging above the water.
        spot.type = .spot
        spot.color = RGBA(1.0, 0.94, 0.82).ns
        // Fully lit in the middle of the beam, fading out a little beyond its visible edge.
        spot.spotInnerAngle = CGFloat(spotHalfAngle * 2 * 180 / .pi) * 0.3
        spot.spotOuterAngle = CGFloat(spotHalfAngle * 2 * 180 / .pi) * 1.35
        spot.castsShadow = true
        spot.shadowMapSize = CGSize(width: 2048, height: 2048)
        spot.shadowSampleCount = 8
        spot.shadowRadius = 3
        spot.shadowColor = NSColor(white: 0, alpha: 0.7)
        spot.zNear = 1
        spot.zFar = CGFloat((spotHeight + surfaceY - floorY) * 1.5)
        spotNode.light = spot
        spotNode.simdPosition = spotPosition
        scene.rootNode.addChildNode(spotNode)

        // A soft visible beam: a long cone with its tip at the lamp. The surface and sand hide the
        // parts above the water and below the floor.
        let beamLength: Float = 32
        let cone = SCNCone(topRadius: 0, bottomRadius: CGFloat(beamLength * tan(spotHalfAngle)), height: CGFloat(beamLength))
        cone.radialSegmentCount = 64
        beamMaterial.lightingModel = .constant
        beamMaterial.blendMode = .add
        beamMaterial.writesToDepthBuffer = false
        beamMaterial.shaderModifiers = [.surface: Shaders.beam]
        beamMaterial.setValue(Float(0), forKey: "beamStrength")
        beamMaterial.setValue(surfaceY, forKey: "beamTop")
        beamMaterial.setValue(floorY, forKey: "beamBottom")
        cone.materials = [beamMaterial]
        let beamNode = SCNNode(geometry: cone)
        beamNode.castsShadow = false
        beamNode.simdPosition = V3(0, -beamLength / 2, 0)
        beamPivot.addChildNode(beamNode)
        beamPivot.simdPosition = spotPosition
        scene.rootNode.addChildNode(beamPivot)
        aim()
    }

    /// Point the light and beam from the lamp toward `spotTarget`.
    private func aim() {
        let dir = (spotTarget - spotPosition).normalized
        spotNode.simdOrientation = simd_quatf(from: V3(0, 0, -1), to: dir)
        beamPivot.simdOrientation = simd_quatf(from: V3(0, -1, 0), to: dir)
    }

    /// A point along the beam at height y, for fish drawn to the light.
    func pointInBeam(atY y: Float) -> V3 {
        let dir = (spotTarget - spotPosition).normalized
        let t = (y - spotPosition.y) / min(dir.y, -0.05)
        return spotPosition + dir * t
    }

    /// Initial values for a material using `Shaders.caustics` (also used for fish bodies).
    static func prepareCaustics(_ mat: SCNMaterial) {
        for key in ["causticNight", "spotX", "spotY", "spotZ", "spotTX", "spotTY", "spotCos"] {
            mat.setValue(Float(0), forKey: key)
        }
    }

    /// Caustic and fin-glow multiplier for fish (neither makes sense in the dark).
    var fishCausticScale: Float { (1 - night).rounded(toStep: 0.1) }

    func update(dt: Float, tank: Tank) {
        let target: Float = Settings.shared.nightMode ? 1 : 0
        night += clamp(target - night, -dt * 0.5, dt * 0.5)

        // Aim at the cursor: the point on the cursor's line of sight in the lamp's depth plane.
        if night > 0, tank.cursor.present {
            let z = spotPosition.z
            let g = tank.cursorGlassPoint
            let f = (tank.eyeDistance - z) / tank.eyeDistance
            let hw = tank.halfWidth(atZ: z)
            let goal = V3(clamp(g.x * f, -hw, hw), clamp(g.y * f, floorY + 0.2, surfaceY - 0.4), z)
            // Re-aiming invalidates the light (and its shadow map), so stop once it has settled.
            if simd_distance(goal, spotTarget) > 0.002 {
                spotTarget += (goal - spotTarget) * min(1, dt * 5)
                aim()
            }
        }

        // Shader values are expensive to set, so only send the aim point when it has actually moved
        // (the lamp position and cone never change).
        if night > 0, !(simd_distance(spotTarget, sentTarget) < 0.003) {
            sentTarget = spotTarget
            for mat in spotMaterials {
                mat.setValue(spotTarget.x, forKey: "spotTX")
                mat.setValue(spotTarget.y, forKey: "spotTY")
            }
        }
        guard night != lastApplied else { return }
        lastApplied = night
        applyBlend(tank: tank)
    }

    private var spotMaterials: [SCNMaterial] { causticMaterials + [surfaceMaterial].compactMap { $0 } }

    private func applyBlend(tank: Tank) {
        if !spotConstantsSent {
            spotConstantsSent = true
            for mat in spotMaterials {
                mat.setValue(spotPosition.x, forKey: "spotX")
                mat.setValue(spotPosition.y, forKey: "spotY")
                mat.setValue(spotPosition.z, forKey: "spotZ")
                // A little wider than the beam so light fades out softly past its visible edge.
                mat.setValue(cos(spotHalfAngle * 1.3), forKey: "spotCos")
            }
        }
        let n = CGFloat(night)
        sun.intensity = lerp(1500, 60, n)
        sun.color = RGBA(0.85, 0.96, 1.0).mix(RGBA(0.5, 0.65, 1.0), n).ns
        fill.intensity = lerp(450, 15, n)
        ambient.intensity = lerp(250, 45, n)
        ambient.color = RGBA(0.25, 0.5, 0.6).mix(RGBA(0.1, 0.2, 0.4), n).ns
        spot.intensity = lerp(0, 3200, n)
        // Toggling shadows recompiles shaders, so only flip them at the ends of the fade.
        if night <= 0 || night >= 1 {
            spot.castsShadow = night > 0
            sun.castsShadow = night < 1
        } else {
            spot.castsShadow = true
            sun.castsShadow = true
        }
        beamMaterial.setValue(Float(0.09) * night, forKey: "beamStrength")
        beamPivot.isHidden = night <= 0

        let water = Lighting.dayWater.mix(Lighting.nightWater, n).ns
        tank.scene.fogColor = water
        tank.scene.background.contents = water
        tank.scene.lightingEnvironment.intensity = lerp(0.9, 0.1, n)
        for mat in causticMaterials { mat.setValue(night, forKey: "causticNight") }
        surfaceMaterial?.setValue(night, forKey: "surfNight")
        tank.applyFishCaustics(fishCausticScale)
    }
}

private extension Float {
    func rounded(toStep step: Float) -> Float { (self / step).rounded() * step }
}
