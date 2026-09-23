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
    private var reflection: Reflection?
    private var frameIndex = 0

    let width: Float
    let height: Float
    let depth: Float
    /// Camera distance in front of the glass.
    let eyeDistance: Float
    let surfaceY: Float
    private let floorBase: Float

    private(set) var fish: [Fish] = []
    private var food: [Food] = []
    private var seaweed: Seaweed?
    private var fishBubbles: SCNParticleSystem!
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
        view.prepass = { [weak self] commandBuffer, time, size in
            guard let self, let reflection = self.reflection else { return }
            // The water moves slowly, so at 60 fps the mirror image is refreshed every other frame.
            self.frameIndex += 1
            if Settings.shared.lowPower || self.frameIndex % 2 == 0 {
                reflection.render(atTime: time, commandBuffer: commandBuffer, size: size)
            }
        }
        applySettings()
    }

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
        let water = RGBA(0.035, 0.2, 0.29)
        scene.background.contents = water.ns
        scene.lightingEnvironment.contents = Art.waterGradient(width: 256, height: 128)
        scene.lightingEnvironment.intensity = 0.9
        scene.fogColor = water.ns
        scene.fogStartDistance = CGFloat(eyeDistance + 0.5)
        scene.fogEndDistance = CGFloat(eyeDistance + depth + 5)
        scene.fogDensityExponent = 1.2

        // Lights: sunlight from above casting shadows, a soft fill from the viewer, blue ambient.
        let sun = SCNLight()
        sun.type = .directional
        sun.color = RGBA(0.85, 0.96, 1.0).ns
        sun.intensity = 1500
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

        let fill = SCNLight()
        fill.type = .directional
        fill.color = RGBA(0.6, 0.85, 0.95).ns
        fill.intensity = 450
        let fillNode = SCNNode()
        fillNode.light = fill
        fillNode.simdEulerAngles = V3(-0.35, 0, 0)
        scene.rootNode.addChildNode(fillNode)

        let ambient = SCNLight()
        ambient.type = .ambient
        ambient.color = RGBA(0.25, 0.5, 0.6).ns
        ambient.intensity = 250
        let ambientNode = SCNNode()
        ambientNode.light = ambient
        scene.rootNode.addChildNode(ambientNode)

        buildSand()
        buildSurface(camera: camera)
        buildScenery()
        buildShafts()
        buildParticles()
        populate()
    }

    private func buildSand() {
        // Extends well past the fog distance so its far edge dissolves into the water.
        let backZ = -depth - 14, frontZ: Float = 2
        let hw = halfWidth(atZ: backZ) + 2
        let nx = 120, nz = 70
        var m = Mesh()
        for j in 0...nz {
            let z = frontZ + (backZ - frontZ) * Float(j) / Float(nz)
            for i in 0...nx {
                let x = -hw + 2 * hw * Float(i) / Float(nx)
                m.positions.append(V3(x, floorHeight(x: x, z: z), z))
                m.uvs.append(V2(x / 2.5, z / 2.5))
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
        mat.shaderModifiers = [.surface: Shaders.caustics]
        mat.setValue(0.55, forKey: "causticStrength")
        geo.materials = [mat]
        let node = SCNNode(geometry: geo)
        node.castsShadow = false
        scene.rootNode.addChildNode(node)
    }

    private func buildSurface(camera: SCNCamera) {
        // A fine grid (world space, facing down) that the wave shader displaces.
        let frontZ: Float = 2, backZ = -depth - 14
        let hw = halfWidth(atZ: backZ) + 2
        let nx = 140, nz = 90
        var m = Mesh()
        for j in 0...nz {
            // Denser rows near the glass, where the surface is closest and largest on screen.
            let f = pow(Float(j) / Float(nz), 1.6)
            let z = frontZ + (backZ - frontZ) * f
            for i in 0...nx {
                m.positions.append(V3(-hw + 2 * hw * Float(i) / Float(nx), surfaceY, z))
                // SceneKit silently skips this mesh without texture coordinates, so give it some.
                m.uvs.append(V2(Float(i) / Float(nx), f))
            }
        }
        for j in 0..<nz {
            for i in 0..<nx {
                let a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1
                m.triangle(a, c, b)
                m.triangle(b, c, d)
            }
        }
        m.computeNormals()
        let geo = m.geometry()

        let mirror = Reflection(device: view.device, scene: scene, mainCamera: camera,
                                mirrorY: surfaceY, eyeDistance: eyeDistance,
                                pixelSize: screenFrame.size * (NSScreen.main?.backingScaleFactor ?? 2))
        reflection = mirror
        let mat = SCNMaterial()
        mat.lightingModel = .constant
        mat.isDoubleSided = true
        mat.shaderModifiers = [.geometry: Shaders.surfaceWaves, .surface: Shaders.surface]
        mat.setValue(mirror.property, forKey: "reflectionTexture")
        geo.materials = [mat]
        let node = SCNNode(geometry: geo)
        node.categoryBitMask = Reflection.surfaceCategory
        node.castsShadow = false
        scene.rootNode.addChildNode(node)
    }

    private func buildScenery() {
        // Rocks, scattered across the floor; all merged into one mesh.
        var rocks = Mesh()
        let rockCount = max(5, Int(width / 2.2))
        for i in 0..<rockCount {
            let z = rnd((-depth + 0.3)...(-0.4))
            let hw = halfWidth(atZ: z)
            let x = -hw + 2 * hw * (Float(i) + rnd(0.15...0.85)) / Float(rockCount)
            let r = rnd(0.25...0.8)
            let rock = Rock.mesh(size: V3(r * rnd(1...1.6), r * rnd(0.55...0.9), r * rnd(0.8...1.3)), tone: Int.random(in: 0..<Rock.tones.count - 1))
            let place = simd_float4x4(translation: V3(x, floorHeight(x: x, z: z) + r * 0.2, z))
                * simd_float4x4(simd_quatf(angle: rnd(0...(2 * .pi)), axis: V3(0, 1, 0)))
            rocks.append(rock, transform: place)
        }
        // The bubbler: a small rock with a stream of bubbles rising from it.
        let bz = -depth * rnd(0.35...0.6)
        let bx = halfWidth(atZ: bz) * rnd(0.25...0.6)
        let bubblerTop = V3(bx, floorHeight(x: bx, z: bz) + 0.3, bz)
        rocks.append(Rock.mesh(size: V3(0.45, 0.3, 0.4), tone: Rock.tones.count - 1),
                     transform: simd_float4x4(translation: V3(bx, floorHeight(x: bx, z: bz) + 0.08, bz)))
        let rockGeo = rocks.geometry()
        rockGeo.materials = [Rock.material()]
        scene.rootNode.addChildNode(SCNNode(geometry: rockGeo))
        buildBubbles(from: bubblerTop)

        // Seaweed clusters: mostly toward the back, a few near the front corners to frame the view.
        var blades: [Seaweed.Blade] = []
        let clusters = max(6, Int(width / 1.8))
        for i in 0..<clusters {
            let frontCorner = i < 2
            let z: Float = frontCorner ? rnd(-1.5 ... -0.6) : rnd((-depth + 0.4)...(-depth * 0.35))
            let hw = halfWidth(atZ: z)
            let x: Float = frontCorner
                ? (i == 0 ? -1 : 1) * hw * rnd(0.8...0.95)
                : -hw + 2 * hw * (Float(i - 2) + rnd(0.1...0.9)) / Float(clusters - 2)
            // Mostly greens; occasionally a red cluster.
            let base = rnd(0...1) < 0.2 ? Int.random(in: 5...6) : Int.random(in: 0...4)
            let maxH = min(height * (frontCorner ? 0.55 : 0.5), 5)
            for _ in 0..<Int.random(in: 4...8) {
                let px = x + rnd(-0.35...0.35), pz = z + rnd(-0.35...0.35)
                blades.append(Seaweed.Blade(base: V3(px, floorHeight(x: px, z: pz) - 0.05, pz),
                                            height: rnd(0.35...1.0) * maxH,
                                            width: rnd(0.14...0.28),
                                            colorIndex: base >= 5 || Bool.random() ? base : Int.random(in: 0...4)))
            }
        }
        let weed = Seaweed(blades: blades)
        scene.rootNode.addChildNode(weed.node)
        seaweed = weed
    }

    private func bubbleSystem(size: CGFloat) -> SCNParticleSystem {
        let p = SCNParticleSystem()
        p.particleImage = Art.bubble
        p.particleSize = size
        p.particleSizeVariation = size * 0.6
        p.particleColor = NSColor(white: 1, alpha: 0.9)
        p.blendMode = .additive
        p.isLightingEnabled = false
        p.emittingDirection = SCNVector3(0, 1, 0)
        p.spreadingAngle = 8
        p.acceleration = SCNVector3(0, 0.25, 0)
        p.particleLifeSpan = 30
        p.particleDiesOnCollision = true
        return p
    }

    private func buildBubbles(from top: V3) {
        // Bubbles pop when they hit the surface.
        let surfaceCollider = SCNNode(geometry: SCNBox(width: CGFloat(width * 4), height: 0.1, length: CGFloat(depth * 4), chamferRadius: 0))
        surfaceCollider.simdPosition = V3(0, surfaceY + 0.05, -depth / 2)
        surfaceCollider.opacity = 0
        scene.rootNode.addChildNode(surfaceCollider)

        let stream = bubbleSystem(size: 0.07)
        stream.birthRate = 5
        stream.particleVelocity = 0.5
        stream.particleVelocityVariation = 0.2
        stream.emitterShape = SCNSphere(radius: 0.05)
        stream.colliderNodes = [surfaceCollider]
        let emitter = SCNNode()
        emitter.simdPosition = top
        emitter.addParticleSystem(stream)
        scene.rootNode.addChildNode(emitter)

        // One-shot puff used when a fish is startled.
        fishBubbles = bubbleSystem(size: 0.035)
        fishBubbles.birthRate = 20
        fishBubbles.emissionDuration = 0.12
        fishBubbles.loops = false
        fishBubbles.emitterShape = SCNSphere(radius: 0.03)
        fishBubbles.particleVelocity = 0.2
        fishBubbles.particleVelocityVariation = 0.18
        fishBubbles.spreadingAngle = 20
        fishBubbles.colliderNodes = [surfaceCollider]
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
            let h = rnd((height * 0.6)...(height * 1.1))
            let plane = SCNPlane(width: CGFloat(rnd(0.6...1.8)), height: CGFloat(h))
            plane.materials = [mat]
            let node = SCNNode(geometry: plane)
            let z = rnd((-depth + 0.5)...(-1.0))
            let x = rnd(-halfWidth(atZ: z)...halfWidth(atZ: z))
            node.simdPosition = V3(x, surfaceY - h / 2, z)
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
        snow.particleColor = RGBA(0.8, 0.95, 1, 0.2).ns
        snow.blendMode = .additive
        snow.isLightingEnabled = false
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

    func schoolGoal(for sp: Species) -> V3? { schoolGoals[sp.id]?.point }

    func spawnBubbles(at p: V3) {
        scene.addParticleSystem(fishBubbles, transform: SCNMatrix4MakeTranslation(CGFloat(p.x), CGFloat(p.y), CGFloat(p.z)))
    }

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
        seaweed?.update(dt: dt, tank: self)

        food.removeAll { f in
            let alive = f.update(dt: dt, floor: floorHeight(x: f.pos.x, z: f.pos.z) + 0.02)
            if !alive { f.node.removeFromParentNode() }
            return !alive
        }

        for (node, phase) in shafts {
            node.opacity = CGFloat(0.07 + 0.06 * sin(Float(clock) * 0.25 + phase))
        }

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
                g = (randomPoint(band: sp.band, near: centre), rnd(6...14))
            }
            schoolGoals[sp.id] = g
        }
    }
}

/// 2D layer drawn over the 3D view: reflections on the glass and ripples where the cursor stirs.
final class Overlay: SKScene {
    override init(size: CGSize) {
        super.init(size: size)
        scaleMode = .resizeFill
        backgroundColor = .clear
        for (x, w, a) in [(0.05, 0.035, 0.06), (0.095, 0.01, 0.045), (0.93, 0.02, 0.035)] as [(CGFloat, CGFloat, CGFloat)] {
            let s = SKSpriteNode(texture: Art.glassStreak, size: CGSize(width: size.width * w, height: size.height * 0.9))
            s.position = CGPoint(x: size.width * x, y: size.height * 0.5)
            s.alpha = a
            s.blendMode = .add
            addChild(s)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

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
