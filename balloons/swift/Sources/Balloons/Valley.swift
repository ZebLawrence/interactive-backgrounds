import AppKit
import Metal
import simd

/// The cursor in screen points (relative to this valley's screen, y up), with smoothed velocity.
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

/// How many balloons: a handful, a fiesta, or the whole sky.
enum Density: String, CaseIterable {
    case few, normal, many

    var count: Int {
        switch self {
        case .few: return 7
        case .normal: return 13
        case .many: return 22
        }
    }

    var title: String {
        switch self {
        case .few: return "A Handful"
        case .normal: return "A Fiesta"
        case .many: return "The Whole Sky"
        }
    }
}

private let dawnFog = V3(0.78, 0.55, 0.42)
private let nightFog = V3(0.012, 0.014, 0.03)
/// The sun's DirectionalLight (0xffc693) and the burners' PointLights (0xffa552), in linear light.
private let sunLight = RGBA(hex: "#ffc693").linear
private let burnerLight = RGBA(hex: "#ffa552").linear
let burnerLightCount = 6

/// The valley filling one screen. Units are metres. The viewer stands on a knoll at the origin
/// looking toward -z, over a valley floor some thirty metres below, to mountains a few kilometres
/// off. A screen point maps to a ray, so balloons can be hit-tested on screen and the cursor's
/// motion turned into a wind vector in the world.
final class Valley {
    let screenFrame: CGRect
    var screenW: CGFloat { screenFrame.width }
    var screenH: CGFloat { screenFrame.height }
    let fov: Float
    let aspect: Float
    /// Pixels (points) per unit at unit depth: the camera's focal length in screen points.
    let focal: Float
    private let basePitch: Float = -2 * .pi / 180

    private(set) var cursor = Cursor()
    private(set) var clock: Double = 0
    private(set) var night: Float
    let cameraPosition: V3
    private(set) var cameraTurn = simd_quatf(angle: 0, axis: V3(0, 1, 0))
    private var cameraInverse = simd_quatf(angle: 0, axis: V3(0, 1, 0))
    private var cameraAngles = V2.zero

    /// The cursor's gust: direction in the world, strength, and where on screen it blew.
    private var gust = (dir: V3.zero, strength: Float(0), screen: CGPoint.zero, speed: Float(0))
    /// Gusts that come and go on their own.
    private var ambient = (dir: V3(1, 0, 0), strength: Float(0), target: Float(0), timer: rnd(3, 10), active: false)
    private let windPhase = rnd(0, TAU)
    private var burnQueue: [(at: Double, balloon: Balloon)] = []

    // Lights and fog (see `Frame` in the shaders).
    let sunDir = V3(0.88, 0.2, -0.42).normalized
    private var sunIntensity: Float = 2
    private var hemiSky = V3.zero
    private var hemiGround = V3.zero
    private var hemiIntensity: Float = 0.6
    private var fogColor = dawnFog
    private var fogNear: Float = 150
    private var fogFar: Float = 6000
    private var burnerSlots = [(light: V4, color: V4, glint: V4)](repeating: (.zero, .zero, .zero), count: burnerLightCount)
    private let shadowMatrix: simd_float4x4

    private let sky = Sky()
    private let mountains = Mountains()
    private let mist = Mist()
    private let ground = Ground()
    private let grass: Grass
    private(set) var balloons: [Balloon] = []
    private var flock: Flock?

    /// For testing without a real mouse: returns a global cursor position for a given time.
    var fakeMouse: ((Float) -> CGPoint)?

    init(screenFrame: CGRect, settings: Settings, fov: Float = 50) {
        self.screenFrame = screenFrame
        self.fov = fov
        aspect = Float(screenFrame.width / screenFrame.height)
        focal = Float(screenFrame.height / 2) / tan(fov / 2 * .pi / 180)
        night = settings.nightGlow ? 1 : 0
        cameraPosition = V3(0, groundHeight(0, 0) + 1.7, 0)

        // The sun's shadows cover the knoll and the air just above it: a tight, high-resolution map
        // over the near grass, since blades are only a few centimetres wide.
        let target = V3(0, 12, -32)
        shadowMatrix = simd_float4x4(orthoLeft: -60, right: 60, bottom: -45, top: 55, near: 250, far: 600)
            * simd_float4x4(lookAt: target + sunDir * 400, target: target)

        let fovRad = fov / 2 * .pi / 180, aspect = self.aspect
        grass = Grass(halfWidth: { d in d * tan(fovRad) * aspect })
        setCameraTurn(yaw: 0, pitch: 0)
        setDensity(settings.density)
        // Starting at night, the fleet begins low over the field, lit for the glow, then flies on.
        if night > 0.5 {
            for b in balloons {
                b.pos = b.tether
                b.vel = .zero
                b.heat = 0.5
            }
        }
        setBirds(settings.birds)
        applyBlends()
    }

    // MARK: - Geometry helpers

    func halfWidth(_ d: Float) -> Float { d * tan(fov / 2 * .pi / 180) * aspect }

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
    func ray(_ s: CGPoint) -> (origin: V3, dir: V3) {
        let local = V3(Float(s.x - screenW / 2) / focal, Float(s.y - screenH / 2) / focal, -1)
        return (cameraPosition, cameraTurn.act(local).normalized)
    }

    func closestPointOnCursorRay(_ p: V3) -> V3 {
        let (origin, dir) = ray(cursor.screen)
        return origin + dir * max(0, (p - origin).dot(dir))
    }

    /// The balloon under a screen point, if any: the nearest whose envelope covers it.
    func balloonAt(_ s: CGPoint, slack: Float = 12) -> Balloon? {
        var best: Balloon?, bestDepth = Float.infinity
        for b in balloons {
            let scr = project(b.centre)
            if scr.depth < 1 { continue }
            let r = b.screenRadius(depth: scr.depth, focal: focal) * 1.1 + slack
            if Float(hypot(scr.x - s.x, scr.y - s.y)) < r && scr.depth < bestDepth {
                best = b
                bestDepth = scr.depth
            }
        }
        return best
    }

    /// The balloon nearest a screen point, measured in envelope radii.
    func nearestBalloon(_ s: CGPoint) -> Balloon? {
        var best: Balloon?, bestD = Float.infinity
        for b in balloons {
            let scr = project(b.centre)
            let d = Float(hypot(scr.x - s.x, scr.y - s.y)) / (b.screenRadius(depth: scr.depth, focal: focal) + 1)
            if d < bestD {
                best = b
                bestD = d
            }
        }
        return best
    }

    // MARK: - Wind

    /// The prevailing wind at a point: slow, and veering round over the minutes, plus any passing gust.
    func windAt(_ p: V3) -> V3 {
        let clock = Float(self.clock)
        let t = clock * 0.02 + windPhase
        let strength = 1.4 + 0.5 * sin(t * 0.7 + p.y * 0.01)
        let base = V3(sin(t) * strength, 0, cos(t * 0.83 + 1.0) * strength * 0.6)
        // A passing gust, uneven across the valley.
        return base + ambient.dir * (ambient.strength * (0.7 + 0.5 * sin(p.x * 0.013 + p.z * 0.009 + clock * 0.3)))
    }

    /// The cursor's gust on a balloon: a push along the cursor's motion, fading with distance from it.
    func gustAt(_ b: Balloon) -> V3 {
        if gust.strength <= 0.001 { return .zero }
        let scr = project(b.centre)
        let d = Float(hypot(scr.x - gust.screen.x, scr.y - gust.screen.y))
        let radius = (240 + min(gust.speed, 2500) * 0.12) / (1 + scr.depth / 500)
        let falloff = exp(-pow(d / radius, 2))
        return gust.dir * (gust.strength * 7 * falloff)
    }

    /// Soft walls keep every balloon somewhere in view.
    func keepInView(_ b: Balloon) {
        let lim = halfWidth(-b.pos.z) * 0.85
        if abs(b.pos.x) > lim { b.vel.x -= (b.pos.x - (b.pos.x > 0 ? lim : -lim)) * 0.05 }
        if b.pos.z > -70 { b.vel.z -= (b.pos.z + 70) * 0.05 }
        if b.pos.z < -950 { b.vel.z += (-950 - b.pos.z) * 0.05 }
    }

    // MARK: - Fleet

    func setDensity(_ d: Density) {
        while balloons.count > d.count { balloons.removeLast() }
        while balloons.count < d.count { addBalloon() }
        assignTethers()
    }

    private func addBalloon() {
        let b = Balloon(index: balloons.count + Int(floor(rnd(0, 1000))))
        // Spread through the valley: a couple close, most in the middle distance, some far off.
        let depth = balloons.count < 2 ? rnd(80, 160) : 70 + 850 * pow(Float.random(in: 0..<1), 1.4)
        let x = rnd(-0.8, 0.8) * halfWidth(depth), z = -depth
        // Low enough to stay in frame: between a little below eye level and a third of the depth above it.
        let eye = cameraPosition.y
        let alt = max(groundHeight(x, z) + 25, eye - depth * 0.02, lerp(eye - depth * 0.3, eye + depth * 0.12, Float.random(in: 0..<1)))
        b.pos = V3(x, alt, z)
        b.targetAlt = alt
        b.vel = windAt(b.pos)
        balloons.append(b)
    }

    /// Where each balloon starts when the app opens at night: spaced out low over the field.
    private func assignTethers() {
        var taken: [V3] = []
        for b in balloons {
            var p: V3?
            for _ in 0..<40 {
                let z = -rnd(60, 300), x = rnd(-0.75, 0.75) * halfWidth(-z)
                // Hovering on their tethers, high enough to clear the long grass on the knoll.
                if taken.allSatisfy({ hypot($0.x - x, $0.z - z) > 26 }) {
                    p = V3(x, groundHeight(x, z) + 24 + 6 * b.scale, z)
                    break
                }
            }
            let tether = p ?? V3(rnd(-100, 100), groundHeight(0, -200) + 30, -200)
            taken.append(tether)
            b.tether = tether
        }
    }

    func setBirds(_ on: Bool) {
        if on && flock == nil { flock = Flock(count: 48) }
        if !on { flock = nil }
    }

    // MARK: - Public actions

    /// A click: fire the balloon under the cursor, or failing that the nearest one.
    func click(atScreen s: CGPoint) {
        (balloonAt(s) ?? nearestBalloon(s))?.fire(night > 0.5 ? 4 : 2.5)
    }

    func fireRandom() {
        balloons.randomElement()?.fire(night > 0.5 ? 4 : 2.5)
    }

    /// Everyone burns, in a ragged wave across the field.
    func fireAll() {
        for b in balloons { burnQueue.append((clock + Double(rnd(0, 1.6)), b)) }
    }

    /// Envelopes shoulder past each other rather than passing through.
    private func separateBalloons(dt: Float) {
        for i in balloons.indices {
            for j in (i + 1)..<balloons.count {
                let a = balloons[i], b = balloons[j]
                let ca = a.centre, cb = b.centre
                let d = ca.distance(to: cb)
                let minD = 8.6 * (a.scale + b.scale) + 1.5
                if d >= minD || d < 1e-3 { continue }
                let dir = (cb - ca) / d
                let push = minD - d
                // Move them apart and bleed off the closing speed, softly, like two soft hulls meeting.
                let k = min(1, dt * 2.5)
                a.pos -= dir * (push * 0.5 * k)
                b.pos += dir * (push * 0.5 * k)
                let closing = (b.vel - a.vel).dot(dir)
                if closing < 0 {
                    a.vel += dir * (closing * 0.5)
                    b.vel -= dir * (closing * 0.5)
                }
            }
        }
    }

    /// Hand the pool of burner lights to the brightest burners.
    private func updateBurnLights() {
        let burning = balloons.filter { $0.burn > 0.02 }.sorted { $0.burn > $1.burn }
        let clock = Float(self.clock)
        for i in 0..<burnerLightCount {
            guard i < burning.count else { burnerSlots[i] = (.zero, .zero, .zero); continue }
            let b = burning[i]
            let p = b.pos + V3(0, -2.4 * b.scale, 0)
            let flicker = 0.85 + 0.15 * sin(clock * 23 + Float(i) * 1.7) * sin(clock * 31 + Float(i))
            let intensity = b.burn * 900 * b.scale * flicker
            burnerSlots[i] = (V4(p, 1), V4(burnerLight * intensity, 1), V4(p, b.burn * b.scale * flicker))
        }
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

    /// The cursor's motion becomes a gust of wind: direction from its velocity, fading over a couple of seconds.
    private func updateGust(dt: Float) {
        gust.strength *= exp(-dt / 1.6)
        if cursor.present && cursor.speed > 250 {
            let right = cameraTurn.act(V3(1, 0, 0)), up = cameraTurn.act(V3(0, 1, 0))
            let dir = (right * Float(cursor.vel.dx) + up * Float(cursor.vel.dy)).normalized
            let s = clamp(Float(cursor.speed) / 1500, 0.2, 2.5)
            if s > gust.strength { gust = (dir, s, cursor.screen, Float(cursor.speed)) }
        }
        // Rest the cursor on a balloon and its crew wave back.
        if cursor.present && cursor.stillTime > 0.6 { balloonAt(cursor.screen, slack: 0)?.wave() }
    }

    /// Gusts of wind that arrive on their own: a few seconds of push, then calm.
    private func updateAmbient(dt: Float) {
        ambient.timer -= dt
        if ambient.timer <= 0 {
            ambient.active.toggle()
            if ambient.active {
                let a = rnd(0, TAU)
                ambient.dir = V3(cos(a), 0, sin(a) * 0.5).normalized
                ambient.target = rnd(0.8, 2.2)
                ambient.timer = rnd(4, 10)
            } else {
                ambient.target = 0
                ambient.timer = rnd(8, 28)
            }
        }
        ambient.strength += clamp(ambient.target - ambient.strength, -dt * 0.4, dt * 0.6)
    }

    private func updateBlends(dt: Float, settings: Settings) {
        let before = night
        night += clamp((settings.nightGlow ? 1 : 0) - night, -dt * 0.25, dt * 0.25)
        if before != night { applyBlends() }
    }

    private func applyBlends() {
        let n = night
        fogColor = lerp(dawnFog, nightFog, n)
        fogNear = lerp(150, 60, n)
        fogFar = lerp(6000, 2200, n)
        sunIntensity = lerp(2.0, 0, n)
        hemiIntensity = lerp(0.6, 0.06, n)
        hemiSky = V3(lerp(0.54, 0.1, n), lerp(0.6, 0.12, n), lerp(0.85, 0.3, n))
        hemiGround = V3(lerp(0.6, 0.03, n), lerp(0.42, 0.03, n), lerp(0.28, 0.05, n))
    }

    func step(dt: Float, settings: Settings) {
        clock += Double(dt)
        let global = fakeMouse?(Float(clock)) ?? NSEvent.mouseLocation
        cursor.update(global: global, frame: screenFrame, dt: dt)
        updateCamera(dt: dt)
        updateBlends(dt: dt, settings: settings)
        updateGust(dt: dt)
        updateAmbient(dt: dt)
        let fireFor: Float = night > 0.5 ? 5 : 3
        burnQueue.removeAll { q in
            if q.at <= clock { q.balloon.fire(fireFor); return true }
            return false
        }
        for b in balloons { b.update(dt: dt, valley: self) }
        separateBalloons(dt: dt)
        updateBurnLights()
        // The grass feels the cursor's gust and the ambient one together.
        let combined = gust.dir * gust.strength + ambient.dir * (ambient.strength * 0.7)
        let cs = combined.length
        grass.update(dt: dt, dir: cs > 1e-4 ? combined / cs : V3(1, 0, 0), strength: cs)
        flock?.update(dt: dt, valley: self)
        mist.update(dt: dt, night: night)
    }

    // MARK: - Drawing

    /// Write this frame's shared uniforms (`Frame` in the shaders) into `buffer`.
    func writeFrame(into buffer: MTLBuffer, drawableHeight: Float) {
        let proj = simd_float4x4(perspectiveFovY: fov * .pi / 180, aspect: aspect, near: 0.5, far: skyRadius * 1.3)
        let view = (simd_float4x4(translation: cameraPosition) * simd_float4x4(cameraTurn)).inverse
        var f = FrameUniforms()
        f.matrix(proj * view)
        f.matrix(view)
        f.matrix(proj)
        f.matrix(shadowMatrix)
        f.vec(V4(cameraPosition, 0))
        f.vec(V4(renderTime, drawableHeight, night, 0))
        f.vec(V4(sunDir, 0))
        f.vec(V4(sunLight * sunIntensity, 0))
        f.vec(V4(hemiSky * hemiIntensity, 0))
        f.vec(V4(hemiGround * hemiIntensity, 0))
        f.vec(V4(fogColor, 0))
        f.vec(V4(fogNear, fogFar, 0, 0))
        f.vec(grass.gust)
        burnerSlots.forEach { f.vec($0.glint) }
        burnerSlots.forEach { f.vec($0.light) }
        burnerSlots.forEach { f.vec($0.color) }
        f.copy(into: buffer)
    }

    /// The sun's shadow pass: the long grass, the envelopes and the baskets.
    func drawShadows(_ e: MTLRenderCommandEncoder, frame: MTLBuffer) {
        e.setDepthStencilState(GPU.shared.depthWrite)
        e.setCullMode(.none)
        grass.drawShadow(e, frame: frame)
        e.setVertexBuffer(frame, offset: 0, index: 1)
        for b in balloons { b.drawShadow(e) }
    }

    /// Draw the scene: the opaque parts front to back (so the long grass hides the ground and the
    /// land hides the sky before they're shaded), then everything that blends, back to front.
    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        e.setCullMode(.none)
        e.setFrontFacing(.counterClockwise)
        grass.draw(ctx)
        ground.draw(ctx)
        e.setDepthStencilState(GPU.shared.depthWrite)
        for b in balloons { b.draw(ctx) }
        flock?.draw(ctx)
        mountains.draw(ctx)
        sky.draw(ctx)

        // Mist banks and burner flames, sorted far to near.
        mist.prepare(ctx)
        var blended: [(depth: Float, draw: () -> Void)] = []
        for (i, s) in mist.sprites.enumerated() {
            blended.append((s.pos.distance(to: cameraPosition), { self.mist.draw(ctx, sprite: i) }))
        }
        for b in balloons where b.flameVisible {
            blended.append((b.pos.distance(to: cameraPosition), { b.drawFlame(ctx, cameraTurn: self.cameraTurn) }))
        }
        for item in blended.sorted(by: { $0.depth > $1.depth }) { item.draw() }
    }
}

/// Builds the `Frame` uniform block: four matrices, then float4s, all 16-byte aligned.
struct FrameUniforms {
    static let floatCount = 16 * 4 + 4 * (9 + 3 * burnerLightCount)
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
