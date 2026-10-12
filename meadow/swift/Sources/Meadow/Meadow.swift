import AppKit
import Metal
import simd

/// The cursor in screen points (relative to this meadow's screen, y up), with smoothed velocity.
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

/// How many fireflies: a few, a meadow full, or a swarm.
enum Density: String, CaseIterable {
    case few, normal, many

    var scale: Float {
        switch self {
        case .few: return 0.45
        case .normal: return 1
        case .many: return 2
        }
    }

    var title: String {
        switch self {
        case .few: return "A Few"
        case .normal: return "A Meadow Full"
        case .many: return "A Swarm"
        }
    }
}

/// The meadow filling one screen. Units are metres. The camera stands at the origin, a little
/// above the grass, looking toward -z; the tree line is about 90 m away. A screen point maps to a
/// ray, and the ray to a point on the ground, so the cursor has a position in the world.
final class Meadow {
    let screenFrame: CGRect
    var screenW: CGFloat { screenFrame.width }
    var screenH: CGFloat { screenFrame.height }
    let area: Float
    let fov: Float = 50
    let aspect: Float
    /// Pixels (points) per unit at unit depth: the camera's focal length in screen points.
    let focal: Float
    private let basePitch: Float = -7 * .pi / 180

    private(set) var cursor = Cursor()
    private(set) var clock: Double = 0
    private(set) var storm: Float
    private(set) var moon: Float
    private var cursorStrength: Float = 0
    private var cursorGround = V3(0, 0, -10)
    private var trail = [V4](repeating: .zero, count: Shaders.trailCount)
    private var trailIndex = 0
    private var lastTrail = V3(1e9, 0, 1e9)
    private var rings: [(x: Float, z: Float, age: Float)] = []
    private var ringUniforms = [V4](repeating: .zero, count: Shaders.ringCount)
    private var gust: Float = 0
    private var gustTarget: Float = 0
    private var gustTimer = rnd(3, 8)
    private var cameraAngles = V2.zero

    let cameraPosition: V3
    private var cameraTurn = simd_quatf(angle: 0, axis: V3(0, 1, 0))
    private var cameraInverse = simd_quatf(angle: 0, axis: V3(0, 1, 0))

    // Shared shader inputs (see `Frame` in the shaders).
    let windDir = V2(0.8, 0.6) / simd_length(V2(0.8, 0.6))
    private(set) var wind: Float = 1
    private let moonDir = V3(0.42, 0.26, -0.88).normalized
    private let moonColor = V3(0.55, 0.65, 0.9)
    private var moonLight: Float = 1
    private var skyLight = V3(0.09, 0.11, 0.18)
    private var fogColor = V3.zero
    private var fogNear: Float = 15
    private var fogFar: Float = 160

    // Distance fades to pure black, so the horizon is only what the sky lights.
    private static let nightSkylight = V3(0.09, 0.11, 0.18)
    private static let stormSkylight = V3(0.05, 0.055, 0.075)

    private let ground: Ground
    private let grass: GrassField
    private let sky: Sky
    private let moonSphere: Moon
    private let meteors: Meteors
    private let horizon: Horizon
    private let mist: Mist
    private let rain: Rain
    private let lightning: Lightning
    private(set) var swarm: Swarm!

    /// For testing without a real mouse: returns a global cursor position for a given time.
    var fakeMouse: ((Float) -> CGPoint)?

    init(screenFrame: CGRect, settings: Settings) {
        self.screenFrame = screenFrame
        area = Float(screenFrame.width * screenFrame.height) / (1512 * 982)
        aspect = Float(screenFrame.width / screenFrame.height)
        focal = Float(screenFrame.height / 2) / tan(fov / 2 * .pi / 180)
        storm = settings.storm ? 1 : 0
        moon = settings.moonlight ? 1 : 0
        cameraPosition = V3(0, groundHeight(0, 0) + 1.25, 0)

        let fov = self.fov, aspect = self.aspect
        let halfWidth = { (d: Float) in d * (tan(fov / 2 * .pi / 180) * aspect + 0.07) + 1.0 }
        ground = Ground()
        grass = GrassField(layout: Layout(halfWidth: halfWidth, area: area))
        sky = Sky()
        moonSphere = Moon(direction: moonDir)
        meteors = Meteors()
        horizon = Horizon(halfWidth: halfWidth)
        mist = Mist(halfWidth: halfWidth)
        rain = Rain()
        lightning = Lightning()
        setCameraTurn(yaw: 0, pitch: 0)
        setDensity(settings.density)
        applyBlends()
    }

    // MARK: - Geometry helpers

    /// Half the width of the meadow in view `d` metres out, with room for the camera to pan.
    func halfWidth(_ d: Float) -> Float { d * (tan(fov / 2 * .pi / 180) * aspect + 0.07) + 1.0 }

    private func setCameraTurn(yaw: Float, pitch: Float) {
        cameraTurn = simd_quatf(angle: yaw, axis: V3(0, 1, 0)) * simd_quatf(angle: basePitch + pitch, axis: V3(1, 0, 0))
        cameraInverse = cameraTurn.inverse
    }

    /// Screen position (points, y up) and depth of a world point, through the camera as turned.
    func project(_ p: V3) -> (x: CGFloat, y: CGFloat, depth: Float) {
        let q = cameraInverse.act(p - cameraPosition)
        let depth = max(-q.z, 0.01)
        let f = focal / depth
        return (screenW / 2 + CGFloat(q.x * f), screenH / 2 + CGFloat(q.y * f), depth)
    }

    /// The line of sight through a screen point.
    private func ray(_ s: CGPoint) -> (origin: V3, dir: V3) {
        let local = V3(Float(s.x - screenW / 2) / focal, Float(s.y - screenH / 2) / focal, -1)
        return (cameraPosition, cameraTurn.act(local).normalized)
    }

    /// Where the line of sight through a screen point meets the ground (or, above the horizon, a far point).
    func groundPoint(_ s: CGPoint) -> V3 {
        let (origin, dir) = ray(s)
        var t: Float = 45
        if dir.y < -0.004 {
            t = (groundHeight(0, -10) - origin.y) / dir.y
            for _ in 0..<3 {
                let p = origin + dir * t
                t = (groundHeight(p.x, p.z) - origin.y) / dir.y
            }
        }
        t = clamp(t, 0.6, 60)
        return origin + dir * t
    }

    /// The point on the cursor's line of sight at world depth z.
    func cursorPoint(atDepth z: Float) -> V3 {
        let (origin, dir) = ray(cursor.screen)
        let dz = min(dir.z, -0.05)
        return origin + dir * ((z - origin.z) / dz)
    }

    func closestPointOnCursorRay(_ p: V3) -> V3 {
        let (origin, dir) = ray(cursor.screen)
        return origin + dir * max(0, (p - origin).dot(dir))
    }

    // MARK: - Public actions

    func setDensity(_ d: Density) {
        swarm = Swarm(meadow: self, density: d.scale)
    }

    /// A clap at a screen point: a ring runs out through the grass and nearby fireflies startle.
    func clap(atScreen s: CGPoint) {
        let p = groundPoint(s)
        if rings.count >= Shaders.ringCount { rings.removeFirst() }
        rings.append((p.x, p.z, 0))
        swarm.clap(at: p, radius: 7)
    }

    // MARK: - Frame loop

    /// Shaders see time modulo `timeWrap`.
    var renderTime: Float { Float(clock.truncatingRemainder(dividingBy: timeWrap)) }

    /// Near a screen edge the camera turns a few degrees toward it, and drifts back when it leaves.
    private func updateCamera(dt: Float) {
        let maxYaw: Float = 3.5 * .pi / 180, maxPitch: Float = 2 * .pi / 180
        var target = V2.zero
        if cursor.present {
            let w = Float(screenW), h = Float(screenH)
            let x = Float(cursor.screen.x), y = Float(cursor.screen.y)
            let zoneX = w * 0.12, zoneY = h * 0.12
            let right = smoothstep(w - zoneX, w, x) - smoothstep(zoneX, 0, x)
            let up = smoothstep(h - zoneY, h, y) - smoothstep(zoneY, 0, y)
            target = V2(-right * maxYaw, up * maxPitch)
        }
        let before = cameraAngles
        cameraAngles += (target - cameraAngles) * min(1, dt * 1.2)
        if simd_distance(before, cameraAngles) > 1e-7 { setCameraTurn(yaw: cameraAngles.x, pitch: cameraAngles.y) }
    }

    private func updateCursorPush(dt: Float) {
        let want: Float = cursor.present ? 1 : 0
        cursorStrength += clamp(want - cursorStrength, -dt * 3, dt * 3)
        if cursor.present { cursorGround = groundPoint(cursor.screen) }
        let g = cursorGround
        let radius = 0.6 + g.distance(to: cameraPosition) * 0.08

        // Leave a trail of flattened grass behind the cursor that slowly springs back.
        if cursor.present && g.distance(to: lastTrail) > radius * 0.5 {
            trail[trailIndex] = V4(g.x, g.z, radius * 0.9, 0.85)
            trailIndex = (trailIndex + 1) % Shaders.trailCount
            lastTrail = g
        }
        for i in trail.indices where trail[i].w > 0 { trail[i].w = max(0, trail[i].w - dt * 0.3) }

        rings = rings.compactMap { r in
            let age = r.age + dt
            return age < 1.4 ? (r.x, r.z, age) : nil
        }
        for i in 0..<Shaders.ringCount {
            if i < rings.count {
                let r = rings[i]
                ringUniforms[i] = V4(r.x, r.z, 0.3 + r.age * 7, 1.6 * (1 - r.age / 1.4))
            } else {
                ringUniforms[i] = .zero
            }
        }
    }

    /// Ease moonlight and the storm in and out, and set everything that depends on them.
    private func updateBlends(dt: Float, settings: Settings) {
        let before = (storm, moon)
        storm += clamp((settings.storm ? 1 : 0) - storm, -dt * 0.35, dt * 0.35)
        moon += clamp((settings.moonlight ? 1 : 0) - moon, -dt * 0.5, dt * 0.5)
        // Gusts come and go, more in a storm.
        gustTimer -= dt
        if gustTimer <= 0 {
            gustTimer = rnd(5, 14)
            gustTarget = rnd(0, 0.45) + storm * rnd(0.3, 1.0)
        }
        gust += clamp(gustTarget - gust, -dt * 0.25, dt * 0.25)
        wind = lerp(0.7, 2.0, storm) + gust
        if before != (storm, moon) { applyBlends() }
    }

    private func applyBlends() {
        let s = storm, m = moon
        moonLight = m * (1 - s * 0.92)
        fogColor = .zero
        fogNear = lerp(15, 6, s)
        fogFar = lerp(160, 80, s)
        skyLight = lerp(Meadow.nightSkylight, Meadow.stormSkylight, s) * lerp(0.75, 1, m)
        moonSphere.update(moon: m, storm: s)
    }

    func step(dt: Float, settings: Settings) {
        clock += Double(dt)
        let global = fakeMouse?(Float(clock)) ?? NSEvent.mouseLocation
        cursor.update(global: global, frame: screenFrame, dt: dt)
        updateCamera(dt: dt)
        updateBlends(dt: dt, settings: settings)
        updateCursorPush(dt: dt)
        swarm.update(dt: dt)
        mist.update(dt: dt, halfWidth: halfWidth, wind: wind, windDir: windDir, storm: storm)
        meteors.update(dt: dt, storm: storm)
        rain.update(dt: dt, storm: storm, wind: wind, windDir: windDir)
        lightning.update(dt: dt, storm: storm)
    }

    // MARK: - Drawing

    /// Write this frame's shared uniforms (`Frame` in the shaders) into `buffer`.
    func writeFrame(into buffer: MTLBuffer, drawableHeight: Float) {
        let proj = simd_float4x4(perspectiveFovY: fov * .pi / 180, aspect: aspect, near: 0.1, far: skyRadius * 1.2)
        let view = (simd_float4x4(translation: cameraPosition) * simd_float4x4(cameraTurn)).inverse
        var f = FrameUniforms()
        f.matrix(proj * view)
        f.matrix(view)
        f.matrix(proj)
        // Firefly sprite scale: pixels per metre at one metre.
        f.vec(V4(cameraPosition, drawableHeight / (2 * tan(fov / 2 * .pi / 180))))
        f.vec(V4(renderTime, drawableHeight, 0, 0))
        f.vec(V4(windDir.x, windDir.y, wind, 0))
        let g = cursorGround
        f.vec(V4(g.x, g.z, 0.6 + g.distance(to: cameraPosition) * 0.08, cursorStrength * 1.1))
        trail.forEach { f.vec($0) }
        ringUniforms.forEach { f.vec($0) }
        for i in 0..<Shaders.lightCount { f.vec(i < swarm.lights.count ? swarm.lights[i] : .zero) }
        for i in 0..<Shaders.lightCount { f.vec(V4(i < swarm.lightColors.count ? swarm.lightColors[i] : .zero, 0)) }
        f.vec(V4(moonDir, moonLight))
        f.vec(V4(moonColor, 0))
        f.vec(V4(skyLight, 0))
        f.vec(V4(fogColor, 0))
        f.vec(V4(fogNear, fogFar, storm, lightning.flash))
        f.copy(into: buffer)
    }

    /// Draw the scene: the sky, the opaque land, then everything that glows or blends, back to front.
    func draw(_ ctx: DrawContext) {
        ctx.encoder.setCullMode(.none)
        sky.draw(ctx)
        horizon.draw(ctx)
        ground.draw(ctx)
        grass.draw(ctx)
        moonSphere.draw(ctx)
        meteors.draw(ctx)
        lightning.draw(ctx)
        mist.draw(ctx)
        swarm.draw(ctx)
        rain.draw(ctx)
    }
}

/// Builds the `Frame` uniform block: three matrices, then float4s, all 16-byte aligned.
struct FrameUniforms {
    static let floatCount = 16 * 3 + 4 * (4 + Shaders.trailCount + Shaders.ringCount + 2 * Shaders.lightCount + 5)
    static let length = floatCount * MemoryLayout<Float>.stride
    private var floats: [Float] = []

    init() { floats.reserveCapacity(FrameUniforms.floatCount) }

    mutating func matrix(_ m: simd_float4x4) {
        for c in [m.columns.0, m.columns.1, m.columns.2, m.columns.3] { vec(c) }
    }

    mutating func vec(_ v: V4) { floats += [v.x, v.y, v.z, v.w] }

    func copy(into buffer: MTLBuffer) {
        precondition(floats.count == FrameUniforms.floatCount, "Frame uniforms out of step with the shader struct")
        floats.withUnsafeBytes { buffer.contents().copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
    }
}
