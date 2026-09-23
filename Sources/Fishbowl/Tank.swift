import AppKit
import SceneKit
import SpriteKit
import simd

/// The cursor in screen points (relative to this tank's screen), with smoothed velocity.
struct Cursor {
    var screen = CGPoint(x: -10_000, y: -10_000)
    var present = false
    var vel = CGVector.zero
    var speed: CGFloat = 0
    var stillTime: Float = 0

    mutating func update(global: CGPoint, frame: CGRect, dt: Float) {
        let local = CGPoint(x: global.x - frame.minX, y: global.y - frame.minY)
        let inside = frame.insetBy(dx: -40, dy: -40).contains(global)
        if inside && present && dt > 0 {
            let v = CGVector(dx: (local.x - screen.x) / CGFloat(dt), dy: (local.y - screen.y) / CGFloat(dt))
            vel = CGVector(dx: vel.dx + (v.dx - vel.dx) * 0.35, dy: vel.dy + (v.dy - vel.dy) * 0.35)
        } else {
            vel = .zero
        }
        present = inside
        screen = local
        speed = hypot(vel.dx, vel.dy)
        stillTime = speed < 25 ? stillTime + dt : 0
    }
}

/// A 3D aquarium filling one screen.
///
/// World layout: 1 unit = 100 screen points. The front glass is the plane z = 0 and exactly fills
/// the screen; the tank extends back to z = -depth. The camera sits in front of the glass on the
/// +z axis, so any screen point maps to a point on the glass and a ray into the tank.
final class Tank: NSObject {
    let view: RenderView
    let scene = SCNScene()
    let screenFrame: CGRect
    private let overlay: Overlay
    private let cameraNode = SCNNode()
    private(set) var lighting: Lighting!

    let width: Float
    let height: Float
    let depth: Float
    /// Camera distance in front of the glass.
    let eyeDistance: Float
    let surfaceY: Float
    private let floorBase: Float

    private(set) var fish: [Fish] = []
    private var food: [Food] = []
    private var plantBed: PlantBed?
    /// Big scenery (reef mounds, corals) as spheres that fish steer around.
    private(set) var obstacles: [(center: V3, radius: Float)] = []
    /// Where the clownfish live.
    private(set) var anemoneTop: V3?
    private var schoolGoals: [String: (point: V3, timer: Float)] = [:]
    private(set) var cursor = Cursor()

    private var displayLink: CADisplayLink?
    private var lastTimestamp: CFTimeInterval?
    private var clock: Double = 0
    private var rippleTimer: Float = 0
    private var shafts: [(node: SCNNode, phase: Float)] = []

    /// For testing without a real mouse: returns a global cursor position for a given time.
    var fakeMouse: ((Float) -> CGPoint)?

    init(view: RenderView, screenFrame: CGRect) {
        self.view = view
        self.screenFrame = screenFrame
        width = Float(screenFrame.width) / 100
        height = Float(screenFrame.height) / 100
        depth = clamp(height * 0.75, 5, 9)
        let fov: Float = 40
        eyeDistance = (height / 2) / tan(fov / 2 * .pi / 180)
        let menuBar = Float(NSStatusBar.system.thickness) / 100
        surfaceY = height / 2 - menuBar * 0.3
        floorBase = -height / 2 + 0.3
        overlay = Overlay(size: screenFrame.size)
        super.init()
        build(fov: fov)
        let r = view.renderer
        r.scene = scene
        r.pointOfView = cameraNode
        r.overlaySKScene = overlay
        r.isPlaying = true
        applySettings()
    }

    /// Dims the glow from above at night.
    func setSkyGlow(_ amount: Float) { overlay.setSkyGlow(CGFloat(amount)) }

    func start() {
        let link = view.displayLink(target: self, selector: #selector(step(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
        applySettings()
    }

    func stop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    func setPaused(_ paused: Bool) {
        displayLink?.isPaused = paused
        view.renderer.isPlaying = !paused
        lastTimestamp = nil
    }

    func applySettings() {
        let s = Settings.shared
        let fps = Float(s.framesPerSecond)
        displayLink?.preferredFrameRateRange = CAFrameRateRange(minimum: fps / 2, maximum: fps, preferred: fps)
        view.sampleCount = s.lowPower ? 1 : 4
    }

    // MARK: - Geometry helpers

    func floorHeight(x: Float, z: Float) -> Float {
        // Gentle dunes, sloping up toward the back like a real aquascape.
        floorBase + 0.12 * sin(x * 0.45 + 0.7) + 0.08 * sin(x * 1.1 + z * 0.6 + 2.1)
            + 0.06 * sin(z * 0.9 + x * 0.2) - z * 0.07
    }

    /// Half the visible width of the tank at depth z (the view frustum widens toward the back).
    func halfWidth(atZ z: Float) -> Float { width / 2 * (eyeDistance - z) / eyeDistance }

    struct Bounds { var minX, maxX, minY, maxY, minZ, maxZ: Float }

    func bounds(at p: V3, bodyLength: Float) -> Bounds {
        let hw = halfWidth(atZ: p.z) - bodyLength * 0.6
        return Bounds(minX: -hw, maxX: hw,
                      minY: floorHeight(x: p.x, z: p.z) + 0.25 + bodyLength * 0.4,
                      maxY: surfaceY - 0.45 - bodyLength * 0.3,
                      minZ: -depth + 0.6, maxZ: -0.35 - bodyLength * 0.3)
    }

    func randomPoint(band: ClosedRange<CGFloat>, near p: V3? = nil) -> V3 {
        let z = rnd((-depth + 0.8)...(-0.6))
        let hw = halfWidth(atZ: z) - 0.8
        var x = rnd(-hw...hw)
        if let p { x = clamp(p.x + rnd(-6.5...6.5), -hw, hw) }
        let lo = floorHeight(x: x, z: z) + 0.5
        let hi = surfaceY - 0.9
        let y = lo + (hi - lo) * Float(rand(band))
        return V3(x, y, z)
    }

    /// Screen position (points) of a world point.
    func project(_ p: V3) -> CGPoint {
        let f = eyeDistance / (eyeDistance - p.z)
        return CGPoint(x: screenFrame.width / 2 + CGFloat(p.x * f * 100),
                       y: screenFrame.height / 2 + CGFloat(p.y * f * 100))
    }

    func screenDistance(_ p: V3, _ s: CGPoint) -> CGFloat {
        let q = project(p)
        return hypot(q.x - s.x, q.y - s.y)
    }

    /// Where the cursor touches the front glass.
    var cursorGlassPoint: V3 {
        V3(Float(cursor.screen.x - screenFrame.width / 2) / 100, Float(cursor.screen.y - screenFrame.height / 2) / 100, 0)
    }

    func closestPointOnCursorRay(_ p: V3) -> V3 {
        let eye = V3(0, 0, eyeDistance)
        let dir = (cursorGlassPoint - eye).normalized
        return eye + dir * simd_dot(p - eye, dir)
    }

    // MARK: - Setup

    private func build(fov: Float) {
        // Camera: looking straight into the tank; the glass plane exactly fills the view.
        let camera = SCNCamera()
        camera.fieldOfView = CGFloat(fov)
        camera.projectionDirection = .vertical
        camera.zNear = 0.5
        camera.zFar = Double(eyeDistance + depth + 30)
        camera.wantsHDR = true
        camera.wantsExposureAdaptation = false
        camera.exposureOffset = 0.1
        camera.bloomIntensity = 0.5
        camera.bloomThreshold = 0.85
        camera.bloomBlurRadius = 10
        camera.vignettingIntensity = 0.7
        camera.vignettingPower = 0.9
        camera.saturation = 1.05
        cameraNode.camera = camera
        cameraNode.simdPosition = V3(0, 0, eyeDistance)
        scene.rootNode.addChildNode(cameraNode)

        // Water: backdrop, fog for depth, and a matching environment for reflections.
        // The backdrop is exactly the fog colour, so distant sand and surface dissolve into it seamlessly.
        // (Colours and light levels are set by `Lighting`, which blends between day and night.)
        scene.lightingEnvironment.contents = Art.waterGradient(width: 256, height: 128)
        scene.fogStartDistance = CGFloat(eyeDistance + 0.5)
        scene.fogEndDistance = CGFloat(eyeDistance + depth + 5)
        scene.fogDensityExponent = 1.2
        lighting = Lighting(scene: scene, surfaceY: surfaceY, floorY: floorHeight(x: 0, z: -depth * 0.45),
                            depth: depth, eyeDistance: eyeDistance)

        // Scenery first: the sand bakes its contact shadows from what's standing on it.
        let occluders = buildScenery()
        buildSand(occluders: occluders)
        buildShafts()
        buildParticles()
        populate()
        lighting.update(dt: 0, tank: self)
    }

    private func buildSand(occluders: [Occluder]) {
        // Extends well past the fog distance so its far edge dissolves into the water.
        let backZ = -depth - 14, frontZ: Float = 2
        let hw = halfWidth(atZ: backZ) + 2
        let nx = 120, nz = 70
        // Contact shadows are baked into a map covering the part of the floor with things on it.
        let aoFarZ = -depth - 1, aoNearZ: Float = 1
        let aoMaxX = halfWidth(atZ: aoFarZ) + 0.5, aoMinX = -aoMaxX
        let ao = Occlusion.floorMap(minX: aoMinX, maxX: aoMaxX, nearZ: aoNearZ, farZ: aoFarZ, width: 1536,
                                    floor: floorHeight, occluders: occluders)
        var m = Mesh()
        for j in 0...nz {
            let z = frontZ + (backZ - frontZ) * Float(j) / Float(nz)
            for i in 0...nx {
                let x = -hw + 2 * hw * Float(i) / Float(nx)
                m.positions.append(V3(x, floorHeight(x: x, z: z), z))
                m.uvs.append(V2(x / 2.5, z / 2.5))
                m.uvs2.append(V2((x - aoMinX) / (aoMaxX - aoMinX), (z - aoNearZ) / (aoFarZ - aoNearZ)))
            }
        }
        for j in 0..<nz {
            for i in 0..<nx {
                let a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1
                // Rows run toward -z, so this winding faces up.
                m.triangle(a, b, c)
                m.triangle(b, d, c)
            }
        }
        m.computeNormals()
        let geo = m.geometry()
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = Art.sand
        mat.diffuse.wrapS = .repeat
        mat.diffuse.wrapT = .repeat
        mat.roughness.contents = 0.95
        mat.multiply.contents = ao
        mat.multiply.mappingChannel = 1
        mat.multiply.wrapS = .clamp
        mat.multiply.wrapT = .clamp
        mat.shaderModifiers = [.surface: Shaders.caustics]
        mat.setValue(0.55, forKey: "causticStrength")
        Lighting.prepareCaustics(mat)
        lighting.causticMaterials.append(mat)
        geo.materials = [mat]
        let node = SCNNode(geometry: geo)
        node.castsShadow = false
        scene.rootNode.addChildNode(node)
    }

    /// Builds the reef and plants; returns spheres approximating them for the sand's contact shadows.
    private func buildScenery() -> [Occluder] {
        let reef = CoralReef()
        let plants = PlantBed()
        let D = depth
        func floorAt(_ x: Float, _ z: Float) -> V3 { V3(x, floorHeight(x: x, z: z), z) }

        // Reef mounds at the back: piles of live rock crowned with coral, with sea fans behind.
        let moundSides: [Float] = Bool.random() ? [-1, 1] : [1, -1]
        for (i, side) in moundSides.enumerated() {
            let z = -D * rnd(0.68...0.8)
            let cx = side * halfWidth(atZ: z) * rnd(0.3...0.5)
            let scale = rnd(1.0...1.35)
            var top: Float = floorHeight(x: cx, z: z)
            for _ in 0..<Int.random(in: 5...7) {
                let ox = rnd(-1.2...1.2) * scale, oz = rnd(-0.6...0.6) * scale
                let size = V3(rnd(0.6...1.1), rnd(0.5...0.85), rnd(0.5...0.9)) * scale
                // Rocks near the middle sit higher, so the pile rises to a peak.
                let lift = size.y * (0.25 + 0.5 * max(0, 1 - abs(ox) / (1.2 * scale)))
                let c = floorAt(cx + ox, z + oz) + V3(0, lift, 0)
                reef.addRock(at: c, size: size, tone: Bool.random() ? .rock : .rockPurple)
                if abs(ox) < 0.7 * scale { top = max(top, c.y + size.y * 0.75) }
                obstacles.append((c, max(size.x, size.z) * 0.95))
                encrust(reef, rock: c, size: size)
            }
            let peak = V3(cx, top - 0.15, z)
            if i == 0 {
                reef.addBranching(at: peak, height: rnd(1.4...1.9), tone: [.purple, .teal, .pink].randomElement()!)
            } else {
                reef.addTable(at: peak, radius: rnd(0.7...0.95), tone: [.tan, .teal].randomElement()!)
            }
            obstacles.append((peak + V3(0, 0.5, 0), 0.8))
            reef.addBrain(at: floorAt(cx - side * 1.3 * scale, z + 0.9) - V3(0, 0.03, 0), radius: rnd(0.4...0.55),
                          tone: [.tan, .orange, .bone].randomElement()!)
            plants.addSeaFan(at: floorAt(cx + rnd(-0.6...0.6), z - 0.9), height: rnd(1.8...2.6), facing: rnd(-0.35...0.35),
                             tone: i == 0 ? .fanPurple : .fanRed)
            // An Anubias-like rosette of dark leaves tucked at the mound's foot.
            plants.addSword(at: floorAt(cx + side * 1.4 * scale, z + 0.7), size: 0.45, leaves: 7, width: 0.2, tone: .darkGreen)
        }

        // Coral gardens: small mixed patches across the middle of the floor.
        for _ in 0..<max(4, Int(width / 3)) {
            let z = -D * rnd(0.25...0.6)
            let c = floorAt(halfWidth(atZ: z) * rnd(-0.85...0.85), z)
            for _ in 0..<Int.random(in: 2...4) {
                let p = floorAt(c.x + rnd(-0.5...0.5), c.z + rnd(-0.4...0.4)) - V3(0, 0.03, 0)
                addSmallCoral(reef, at: p, scale: rnd(0.8...1.2))
            }
        }

        // Larger corals dotted across the middle of the floor.
        for k in 0..<2 {
            let z = -D * rnd(0.35...0.55)
            let x = (k == 0 ? -1 : 1) * halfWidth(atZ: z) * rnd(0.1...0.35)
            let c = floorAt(x, z)
            reef.addBrain(at: c - V3(0, 0.03, 0), radius: rnd(0.3...0.45), tone: [.teal, .tan, .orange].randomElement()!)
            obstacles.append((c, 0.45))
        }
        for _ in 0..<3 {
            let z = -D * rnd(0.3...0.6)
            let x = halfWidth(atZ: z) * rnd(-0.75...0.75)
            reef.addBranching(at: floorAt(x, z) - V3(0, 0.05, 0), height: rnd(0.55...0.85),
                              tone: [.pink, .orange, .purple, .red].randomElement()!)
        }

        // A sea anemone near the front, which the clownfish call home.
        let az = -rnd(1.8...2.4)
        let ax = (Bool.random() ? -1 : 1) * halfWidth(atZ: az) * rnd(0.25...0.45)
        let anemoneBase = floorAt(ax, az) - V3(0, 0.03, 0)
        plants.addAnemone(at: anemoneBase, radius: 0.32)
        reef.addRock(at: anemoneBase - V3(0, 0.05, 0), size: V3(0.4, 0.2, 0.35), tone: .rock)
        anemoneTop = anemoneBase + V3(0, 0.45, 0)

        // Scattered stones and pebbles.
        for _ in 0..<7 {
            let z = rnd((-D + 0.5)...(-0.6))
            let x = halfWidth(atZ: z) * rnd(-0.9...0.9)
            let r = rnd(0.15...0.4)
            reef.addRock(at: floorAt(x, z) + V3(0, r * 0.15, 0), size: V3(r * rnd(1...1.5), r * rnd(0.5...0.8), r), tone: .rock)
        }
        for _ in 0..<80 {
            let z = -D * pow(rnd(0.05...1), 1.5)
            let x = halfWidth(atZ: z) * rnd(-0.95...0.95)
            reef.addPebble(at: floorAt(x, z), radius: rnd(0.025...0.07),
                           tone: [.rock, .rockPurple, .bone, .tan].randomElement()!)
        }

        // Plants: tall framing clusters in the front corners, more along the back and sides.
        for side: Float in [-1, 1] {
            let z = rnd(-1.4 ... -0.7)
            let x = side * halfWidth(atZ: z) * rnd(0.82...0.95)
            if side < 0 {
                for _ in 0..<7 {
                    let p = floorAt(x + rnd(-0.35...0.35), z + rnd(-0.3...0.3))
                    plants.addBlade(at: p, height: rnd(0.4...1.0) * min(height * 0.55, 5), width: rnd(0.16...0.3),
                                    tone: [.green, .brightGreen, .olive].randomElement()!)
                }
            } else {
                let tone: PlantBed.Tone = Bool.random() ? .rotala : .red
                for _ in 0..<6 {
                    plants.addStem(at: floorAt(x + rnd(-0.35...0.35), z + rnd(-0.3...0.3)),
                                   height: rnd(0.5...1.0) * min(height * 0.5, 4.5), tone: tone)
                }
            }
        }
        for k in 0..<max(4, Int(width / 3)) {
            let z = -D * rnd(0.55...0.95)
            let x = halfWidth(atZ: z) * rnd(-0.95...0.95)
            if k % 2 == 0 {
                for _ in 0..<Int.random(in: 4...7) {
                    let p = floorAt(x + rnd(-0.4...0.4), z + rnd(-0.4...0.4))
                    plants.addBlade(at: p, height: rnd(0.4...1.0) * min(height * 0.5, 4.5), width: rnd(0.14...0.26),
                                    tone: [.green, .darkGreen, .olive, .maroon].randomElement()!)
                }
            } else {
                let tone = [PlantBed.Tone.lime, .brightGreen, .rotala].randomElement()!
                for _ in 0..<Int.random(in: 4...6) {
                    plants.addStem(at: floorAt(x + rnd(-0.35...0.35), z + rnd(-0.35...0.35)),
                                   height: rnd(0.5...1.0) * min(height * 0.45, 4), tone: tone)
                }
            }
        }
        for side: Float in [-1, 1] {
            let z = -D * rnd(0.3...0.5)
            plants.addSword(at: floorAt(side * halfWidth(atZ: z) * rnd(0.6...0.8), z), size: rnd(0.9...1.3),
                            leaves: Int.random(in: 10...14), width: rnd(0.16...0.22), tone: [.green, .brightGreen].randomElement()!)
        }

        reef.finish(floor: floorHeight)
        scene.rootNode.addChildNode(reef.node)
        lighting.causticMaterials.append(reef.material)
        plants.finish()
        scene.rootNode.addChildNode(plants.node)
        lighting.causticMaterials.append(plants.material)
        plantBed = plants
        return reef.occluders + plants.occluders
    }

    /// Grow a few small corals over the upper surface of a rock.
    private func encrust(_ reef: CoralReef, rock c: V3, size: V3) {
        for _ in 0..<Int.random(in: 4...6) {
            let a = rnd(0...(2 * .pi)), up = rnd(0.35...1.0)
            let dir = V3(cos(a) * (1 - up * 0.7), up, sin(a) * (1 - up * 0.7)).normalized
            // Roughly on the rock's (lumpy) surface in that direction.
            let p = c + dir * size * 0.95
            addSmallCoral(reef, at: p, scale: rnd(0.8...1.4))
        }
    }

    private func addSmallCoral(_ reef: CoralReef, at p: V3, scale s: Float) {
        switch Int.random(in: 0..<5) {
        case 0: reef.addBrain(at: p, radius: 0.22 * s, tone: [.tan, .teal, .orange, .bone, .green].randomElement()!)
        case 1: reef.addBranching(at: p, height: 0.5 * s, tone: [.pink, .purple, .orange, .red].randomElement()!)
        case 2: reef.addFingers(at: p, size: 0.45 * s, tone: [.bone, .tan, .orange, .pink].randomElement()!)
        default: reef.addPolyps(at: p, radius: 0.2 * s, tone: [.green, .orange, .teal, .pink].randomElement()!)
        }
    }

    private func buildShafts() {
        let mat = SCNMaterial()
        mat.lightingModel = .constant
        mat.diffuse.contents = Art.lightShaft
        mat.blendMode = .add
        mat.writesToDepthBuffer = false
        mat.isDoubleSided = true
        let billboard = SCNBillboardConstraint()
        billboard.freeAxes = .Y
        for _ in 0..<max(5, Int(width / 2.5)) {
            let z = rnd((-depth + 0.5)...(-1.0))
            // Start above the top of the view at this depth, so shafts come in from off-screen.
            let top = (height / 2) * (eyeDistance - z) / eyeDistance + 0.5
            let h = rnd((height * 0.7)...(height * 1.2))
            let plane = SCNPlane(width: CGFloat(rnd(0.6...1.8)), height: CGFloat(h))
            plane.materials = [mat]
            let node = SCNNode(geometry: plane)
            let x = rnd(-halfWidth(atZ: z)...halfWidth(atZ: z))
            node.simdPosition = V3(x, top - h / 2, z)
            node.constraints = [billboard]
            node.castsShadow = false
            node.opacity = 0.1
            scene.rootNode.addChildNode(node)
            shafts.append((node, rnd(0...(2 * .pi))))
        }
    }

    private func buildParticles() {
        // Drifting specks ("marine snow") throughout the water.
        let snow = SCNParticleSystem()
        snow.particleImage = Art.dot
        snow.birthRate = CGFloat(width * height * depth / 30)
        snow.particleLifeSpan = 30
        snow.particleLifeSpanVariation = 10
        snow.emitterShape = SCNBox(width: CGFloat(width * 1.6), height: CGFloat(height), length: CGFloat(depth), chamferRadius: 0)
        snow.birthLocation = .volume
        snow.particleVelocity = 0.04
        snow.particleVelocityVariation = 0.04
        snow.spreadingAngle = 180
        snow.acceleration = SCNVector3(0, -0.004, 0)
        snow.particleSize = 0.018
        snow.particleSizeVariation = 0.012
        // Lit particles: they glint in the spotlight's beam at night and fade into the dark elsewhere.
        snow.particleColor = RGBA(0.8, 0.95, 1, 0.35).ns
        snow.blendMode = .additive
        snow.isLightingEnabled = true
        snow.warmupDuration = 30
        snow.fresnelExponent = 0
        let node = SCNNode()
        node.simdPosition = V3(0, 0, -depth / 2)
        node.addParticleSystem(snow)
        scene.rootNode.addChildNode(node)
    }

    private func populate() {
        let areaFactor = clamp(Float(screenFrame.width * screenFrame.height) / (1512 * 982), 0.5, 2.5)
        for sp in Species.all {
            let count = max(1, Int((Float(sp.population) * areaFactor).rounded()))
            for _ in 0..<count { addFish(sp) }
        }
    }

    // MARK: - Public actions

    func addFish(_ sp: Species) {
        let f = Fish(species: sp, at: randomPoint(band: sp.band))
        f.setCausticScale(lighting.fishCausticScale)
        fish.append(f)
        scene.rootNode.addChildNode(f.node)
    }

    func removeFish() {
        guard !fish.isEmpty else { return }
        let f = fish.remove(at: Int.random(in: 0..<fish.count))
        f.node.runAction(.sequence([.fadeOut(duration: 0.6), .removeFromParentNode()]))
    }

    /// Drop flakes of food where the cursor ray meets a plane a little behind the glass.
    func dropFood(atScreen p: CGPoint, count: Int = 6) {
        let g = V3(Float(p.x - screenFrame.width / 2) / 100, Float(p.y - screenFrame.height / 2) / 100, 0)
        let eye = V3(0, 0, eyeDistance)
        let z: Float = -1.4
        let hit = eye + (g - eye) * ((eyeDistance - z) / eyeDistance)
        let start = V3(hit.x, min(hit.y, surfaceY - 0.2), z)
        for _ in 0..<count {
            let f = Food(at: start + V3(rnd(-0.25...0.25), rnd(-0.1...0.1), rnd(-0.3...0.3)))
            food.append(f)
            scene.rootNode.addChildNode(f.node)
        }
        overlay.ripple(at: p, scale: 0.6)
    }

    func dropFoodRandomly() {
        for _ in 0..<3 {
            dropFood(atScreen: CGPoint(x: CGFloat.random(in: screenFrame.width * 0.15...screenFrame.width * 0.85),
                                       y: screenFrame.height * 0.8), count: 5)
        }
    }

    // MARK: - Helpers used by fish

    func nearestFood(to p: V3, within maxDist: Float) -> Food? {
        var best: Food?
        var bestD = maxDist
        for f in food where !f.eaten {
            let d = simd_distance(p, f.pos)
            if d < bestD { bestD = d; best = f }
        }
        return best
    }

    func eat(_ f: Food) { f.eaten = true }

    func applyFishCaustics(_ scale: Float) {
        for f in fish { f.setCausticScale(scale) }
    }

    /// At night, fish are drawn to the spotlight: often returns a point in its beam instead.
    func wanderPoint(band: ClosedRange<CGFloat>, near p: V3) -> V3 {
        guard lighting.night > 0.5, Float.random(in: 0...1) < 0.65 else { return randomPoint(band: band, near: p) }
        let lo = floorBase + 0.6, hi = surfaceY - 0.9
        let axis = lighting.pointInBeam(atY: lo + (hi - lo) * Float(rand(band)))
        let z = clamp(axis.z + rnd(-1.2...1.2), -depth + 0.8, -0.6)
        let x = clamp(axis.x + rnd(-0.8...0.8), -halfWidth(atZ: z) + 0.8, halfWidth(atZ: z) - 0.8)
        return V3(x, max(axis.y, floorHeight(x: x, z: z) + 0.5), z)
    }

    func schoolGoal(for sp: Species) -> V3? { schoolGoals[sp.id]?.point }


    // MARK: - Frame loop

    /// Shaders only see time modulo `timeWrap`, keeping float precision no matter how long the
    /// app runs. Every animation frequency in the shaders is quantised so the wrap is seamless.
    static let timeWrap: Double = 3600
    static func renderTime(_ clock: Double) -> Double { clock.truncatingRemainder(dividingBy: timeWrap) }

    /// The (wrapped) time the next frame will be rendered at; fish use it to keep shader phases continuous.
    var renderTime: Float { Float(Tank.renderTime(clock)) }

    @objc private func step(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = Float(min(now - (lastTimestamp ?? now), 1.0 / 15))
        lastTimestamp = now
        clock += Double(dt)

        let global = fakeMouse?(Float(clock)) ?? NSEvent.mouseLocation
        cursor.update(global: global, frame: screenFrame, dt: dt)

        if cursor.present && cursor.speed > 900 {
            rippleTimer -= dt
            if rippleTimer <= 0 {
                rippleTimer = 0.07
                overlay.ripple(at: cursor.screen, scale: 0.45)
            }
        }

        updateSchools(dt: dt)
        for f in fish { f.update(dt: dt, tank: self) }
        plantBed?.update(dt: dt, tank: self)

        food.removeAll { f in
            let alive = f.update(dt: dt, floor: floorHeight(x: f.pos.x, z: f.pos.z) + 0.02)
            if !alive { f.node.removeFromParentNode() }
            return !alive
        }

        for (node, phase) in shafts {
            node.opacity = CGFloat((0.07 + 0.06 * sin(Float(clock) * 0.25 + phase)) * (1 - lighting.night))
        }
        lighting.update(dt: dt, tank: self)

        view.draw(atTime: Tank.renderTime(clock))
    }

    private func updateSchools(dt: Float) {
        for sp in Species.all where sp.schooling {
            let members = fish.filter { $0.species.id == sp.id }
            guard !members.isEmpty else { schoolGoals[sp.id] = nil; continue }
            let centre = members.map(\.pos).reduce(.zero, +) / Float(members.count)
            var g = schoolGoals[sp.id] ?? (centre, 0)
            g.timer -= dt
            if g.timer <= 0 || simd_distance(centre, g.point) < 0.9 {
                g = (wanderPoint(band: sp.band, near: centre), rnd(6...14))
            }
            schoolGoals[sp.id] = g
        }
    }
}

/// 2D layer drawn over the 3D view: a soft glow of light from above, reflections on the glass, and
/// ripples where the cursor stirs.
final class Overlay: SKScene {
    private let skyGlow: SKSpriteNode

    override init(size: CGSize) {
        skyGlow = SKSpriteNode(texture: Art.skyGlow, size: CGSize(width: size.width, height: size.height * 0.45))
        super.init(size: size)
        // Laid out in screen points; the renderer draws overlays in pixels, so scale to fit
        // (.resizeFill would reinterpret every position as pixels).
        scaleMode = .fill
        backgroundColor = .clear
        skyGlow.anchorPoint = CGPoint(x: 0, y: 1)
        skyGlow.position = CGPoint(x: 0, y: size.height)
        skyGlow.blendMode = .add
        addChild(skyGlow)
        for (x, w, a) in [(0.05, 0.035, 0.06), (0.095, 0.01, 0.045), (0.93, 0.02, 0.035)] as [(CGFloat, CGFloat, CGFloat)] {
            let s = SKSpriteNode(texture: Art.glassStreak, size: CGSize(width: size.width * w, height: size.height * 0.9))
            s.position = CGPoint(x: size.width * x, y: size.height * 0.5)
            s.alpha = a
            s.blendMode = .add
            addChild(s)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setSkyGlow(_ amount: CGFloat) { skyGlow.alpha = amount }

    func ripple(at p: CGPoint, scale: CGFloat) {
        let ring = SKSpriteNode(texture: Art.ring, size: CGSize(width: 120, height: 120))
        ring.position = p
        ring.setScale(0.15)
        ring.alpha = 0.14
        ring.blendMode = .add
        addChild(ring)
        ring.run(.sequence([
            .group([.scale(to: scale, duration: 0.8), .fadeOut(withDuration: 0.8)]),
            .removeFromParent(),
        ]))
    }
}
