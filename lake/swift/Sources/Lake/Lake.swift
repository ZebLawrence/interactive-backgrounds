import AppKit
import Metal
import simd

/// The cursor in screen points (relative to this lake's screen, y up), with smoothed velocity.
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

/// How much life: a quiet evening, a living lake, or teeming.
enum Density: String, CaseIterable {
    case few, normal, many

    var counts: (fish: Int, loons: Int, dragonflies: Int) {
        switch self {
        case .few: return (5, 1, 4)
        case .normal: return (9, 2, 8)
        case .many: return (15, 4, 14)
        }
    }

    var title: String {
        switch self {
        case .few: return "A Quiet Evening"
        case .normal: return "A Living Lake"
        case .many: return "Teeming"
        }
    }
}

/// Where a kind of creature lives: from `near` to `far` in z, within the view.
struct Bounds {
    let near: Float
    let far: Float
    let halfWidth: (Float) -> Float
}

/// A splash or a skip: anything within `radius` of it startles.
struct Startle { let x: Float; let z: Float; let radius: Float }

/// The cursor's fingertip in the world: on the water if the cursor is over water, else in the air.
struct Finger {
    var point = V3.zero
    var inWater = false
    var valid = false
    var prev: V3?
}

private let gravity: Float = 9.81

/// A skipped stone: thrown from the hand to where you clicked, then hopping on across the water in
/// shrinking bounds until it runs out of speed and sinks.
final class Stone {
    var pos = V3(0.3, 1.15, -0.4)
    private var vel: V3
    private var hops: Int
    private(set) var sinking = false
    private var sink: Float = 0
    private var spin = rnd(0, TAU)
    private let size = rnd(0.028, 0.04)
    private(set) var done = false

    init(target: V3) {
        let to = target - pos
        let D = hypot(to.x, to.z)
        let vh = clamp(D / 1.1, 7, 26)
        let T = D / vh
        vel = V3(to.x / D * vh, (gravity * T * T / 2 - pos.y) / T, to.z / D * vh)
        hops = Int(floor(rnd(3, 8)))
    }

    /// Above the water while it flies; under it once it sinks.
    var layers: Layers { sinking ? .below : .surface }

    var model: simd_float4x4 {
        compose(pos, quatAxis(spin, 0, 1, 0) * quatAxis(0.18 * sin(spin * 0.3), 1, 0, 0), V3(size, size * 0.35, size * 0.85))
    }

    func update(dt: Float, lake: Lake) {
        if !sinking {
            vel.y -= gravity * dt
            pos += vel * dt
            spin += dt * 25
            if pos.y <= 0 && vel.y < 0 {
                pos.y = 0
                let vh = hypot(vel.x, vel.z)
                // Each touch presses the water down and startles anything close.
                let strength = clamp(vh / 12, 0.4, 1.2)
                lake.disturb(pos.x, pos.z, radius: 0.12 + 0.04 * strength, amount: -0.03 * strength, ring: 1.0 * strength)
                lake.startles.append(Startle(x: pos.x, z: pos.z, radius: 4 + 2 * strength))
                // The next hop is shorter and lower; the stone keeps most of its forward speed.
                let hopLen = (vh * 2 * abs(vel.y) / gravity) * 0.58
                if hops > 0 && vh > 3 && hopLen > 0.3 {
                    hops -= 1
                    let newVh = vh * 0.86
                    vel.x *= newVh / vh
                    vel.z *= newVh / vh
                    vel.y = gravity * hopLen / (2 * newVh)
                } else {
                    sinking = true
                    lake.disturb(pos.x, pos.z, radius: 0.16, amount: -0.04, ring: 1.2)
                    vel *= 0.3
                }
            }
        } else {
            // Sinking: slows, drifts down, and is gone.
            sink += dt
            vel *= exp(-dt * 3)
            vel.y = -0.5
            pos += vel * dt
            spin += dt * 4
            if sink > 3 || pos.y < -3 { done = true }
        }
    }
}

private let duskFog = V3(0.44, 0.37, 0.47)
private let nightFog = V3(0.008, 0.01, 0.022)
private let rainFog = V3(0.3, 0.32, 0.36)

/// The last of the sun: sixteen degrees up over the ridges to the left, an hour from setting. It
/// is the key light, and every shadow on the shore runs from it.
let sunDir = V3(-0.6, 0.29, -0.8).normalized
/// The moon, up to the right.
let moonDir = V3(0.3, 0.3, -0.9).normalized

/// The lake filling one screen. Units are metres. The viewer stands at the water's edge at the
/// origin, eye 1.5 m above the surface, looking out toward -z across the lake to the far shore.
final class Lake {
    let screenFrame: CGRect
    var screenW: CGFloat { screenFrame.width }
    var screenH: CGFloat { screenFrame.height }
    let fov: Float
    let aspect: Float
    let focal: Float
    private let basePitch: Float = -4.5 * .pi / 180
    let near: Float = 0.2
    let far: Float = skyRadius * 1.4

    private(set) var cursor = Cursor()
    private(set) var clock: Double = 0
    private(set) var night: Float
    private(set) var rain: Float
    let cameraPosition = V3(0, 1.5, 0)
    private(set) var cameraTurn = simd_quatf(angle: 0, axis: V3(0, 1, 0))
    private var cameraInverse = simd_quatf(angle: 0, axis: V3(0, 1, 0))
    private var cameraAngles = V2.zero

    private(set) var finger = Finger()
    var startles: [Startle] = []
    private var stones: [Stone] = []
    private var breeze = (angle: rnd(0, TAU), strength: Float(0.3), target: Float(0.3), timer: rnd(10, 30))
    /// The breeze over the water: direction (x, z) and strength.
    private(set) var wind = V3(0.8, 0.6, 0.3)
    var loonApproacher: Loon?
    var fingerPercher: Dragonfly?

    // Light and fog (see `Frame` in the shaders).
    private var fogColor = duskFog
    private var fogNear: Float = 200
    private var fogFar: Float = 5000
    private var hemiSky = V3.zero
    private var hemiGround = V3.zero
    private var keyColor = V3.zero
    private var keyDir = sunDir
    private var shadowMatrix = matrix_identity_float4x4

    let sim: WaveSim
    let rings = Rings()
    private let water = Water()
    private let sky = Sky()
    private let moon = Moon()
    private let shore: Shore
    private let mist: Mist
    private let rainFx = Rain()
    let reeds: Reeds
    private let bedLife: BedLife
    private let bed: LakeBed
    let lilies: Lilies
    /// Everywhere a dragonfly may land: reed tops and lily pads.
    let perches: [Perch]
    private let stoneMesh = Geometry.sphere(radius: 1, widthSegments: 14, heightSegments: 10).upload()

    let fishBounds: Bounds
    let loonBounds: Bounds
    let dragonflyBounds: Bounds
    private(set) var shoal: Shoal!
    private(set) var loons: Loons!
    private(set) var dragonflies: Dragonflies!

    /// For testing without a real mouse: returns a global cursor position for a given time.
    var fakeMouse: ((Float) -> CGPoint)?

    init(screenFrame: CGRect, settings: Settings, fov: Float = 50) {
        self.screenFrame = screenFrame
        self.fov = fov
        aspect = Float(screenFrame.width / screenFrame.height)
        focal = Float(screenFrame.height / 2) / tan(fov / 2 * .pi / 180)
        night = settings.night ? 1 : 0
        rain = settings.rain ? 1 : 0
        let t = tan(fov / 2 * .pi / 180), aspect = self.aspect
        let halfWidth: (Float) -> Float = { d in d * t * aspect }

        sim = WaveSim(size: settings.lowPower ? 1536 : 2048)
        shore = Shore(halfWidth: halfWidth)
        mist = Mist(halfWidth: halfWidth)
        reeds = Reeds(halfWidth: halfWidth)
        bedLife = BedLife(halfWidth: halfWidth, stems: reeds.bases)
        bed = LakeBed(ao: bedLife.aoTexture)
        lilies = Lilies(halfWidth: halfWidth)
        perches = reeds.perches + lilies.perches
        fishBounds = Bounds(near: -1.8, far: -28, halfWidth: halfWidth)
        loonBounds = Bounds(near: -14, far: -60, halfWidth: halfWidth)
        dragonflyBounds = Bounds(near: -1.2, far: -16, halfWidth: halfWidth)

        setCameraTurn(yaw: 0, pitch: 0)
        let counts = settings.density.counts
        shoal = Shoal(lake: self, count: counts.fish)
        loons = Loons(lake: self, count: counts.loons)
        dragonflies = Dragonflies(lake: self, count: counts.dragonflies)
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

    /// Where a screen point meets the water, if it does within `maxDist` metres.
    func waterPoint(_ s: CGPoint, maxDist: Float = 150) -> V3? {
        let (origin, dir) = ray(s)
        if dir.y >= -1e-4 { return nil }
        let t = -origin.y / dir.y
        if t > maxDist { return nil }
        return origin + dir * t
    }

    // MARK: - Disturbing the water

    /// A dent in the water: simulated near by, an analytic ring far out.
    func disturb(_ x: Float, _ z: Float, radius: Float, amount: Float, ring: Float = 0) {
        if sim.splat(x, z, radius: radius, amount: amount) { return }
        if ring > 0 { rings.add(x, z, amp: ring * 0.006, time: clock) }
    }

    /// Skip a stone toward a screen point.
    func skipStone(atScreen s: CGPoint) {
        var target: V3
        if let w = waterPoint(s, maxDist: 400) {
            target = w
        } else {
            let (_, dir) = ray(s)
            var h = V3(dir.x, 0, dir.z).normalized
            if h.lengthSquared < 0.5 || h.z > -0.2 { h = V3(0, 0, -1) }
            target = h * 60
            target.y = 0
        }
        if target.z > -2 { target.z = -2 }
        stones.append(Stone(target: target))
    }

    /// The fingertip follows the cursor; dragged through the water it leaves a wake.
    private func updateFinger() {
        let c = cursor
        if !c.present {
            finger = Finger()
            return
        }
        let wasInWater = finger.inWater ? finger.prev : nil
        if let wp = waterPoint(c.screen, maxDist: 120) {
            finger.point = V3(wp.x, 0, wp.z)
            finger.inWater = true
            finger.valid = true
        } else {
            let (origin, dir) = ray(c.screen)
            finger.point = origin + dir * 6
            finger.inWater = false
            finger.valid = finger.point.y < 4
        }
        // A finger dragged through the water leaves a wake: dents along its path, deeper the faster it moves.
        let f = finger.point
        if finger.inWater && inSim(f.x, f.z) {
            let segLen = wasInWater.map { $0.distance(to: f) } ?? 0
            let speed = Float(c.speed)
            // A hand cannot cross two metres of water in a frame: that is a jump, not a drag.
            if let from = wasInWater, speed > 30 && segLen < 2 {
                let n = clamp(Int(ceil(segLen / 0.05)), 1, 8)
                let amount = -0.004 * clamp(speed / 600, 0.4, 1.6)
                for i in 1...n {
                    let p = lerp(from, f, Float(i) / Float(n))
                    _ = sim.splat(p.x, p.z, radius: 0.06 + 0.03 * clamp(speed / 1000, 0, 1), amount: amount / Float(n).squareRoot())
                }
            } else if wasInWater == nil {
                _ = sim.splat(f.x, f.z, radius: 0.08, amount: -0.005)
            }
        }
        finger.prev = finger.inWater ? f : nil
    }

    /// What everyone is doing (the `--log` flag).
    func log() {
        print(String(format: "night %.2f rain %.2f wind (%.2f, %.2f) x %.2f, finger %@ (%.1f, %.1f)", night, rain, wind.x, wind.y, wind.z,
                     finger.inWater ? "in water" : (finger.valid ? "in air" : "none"), finger.point.x, finger.point.z))
        for t in shoal.fish { print(String(format: "trout %@ (%.1f, %.2f, %.1f) %@", t.speciesName, t.pos.x, t.pos.y, t.pos.z, "\(t.state)")) }
        for l in loons.list { print(String(format: "loon (%.1f, %.1f) %@", l.pos.x, l.pos.z, "\(l.state)")) }
        for d in dragonflies.list { print(String(format: "dragonfly (%.2f, %.2f, %.2f) %@", d.pos.x, d.pos.y, d.pos.z, "\(d.state)")) }
    }

    // MARK: - Population and modes

    func setDensity(_ d: Density) {
        let c = d.counts
        shoal.setCount(c.fish)
        loons.setCount(c.loons)
        dragonflies.setCount(c.dragonflies)
    }

    // MARK: - Frame loop

    /// Shaders see time modulo `timeWrap`.
    var renderTime: Float { Float(clock.truncatingRemainder(dividingBy: timeWrap)) }

    /// Near a screen edge the camera turns a few degrees toward it, and drifts back when it leaves.
    private func updateCamera(dt: Float) {
        let maxYaw: Float = 3 * .pi / 180, maxPitch: Float = 1.5 * .pi / 180
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
        cameraAngles += (target - cameraAngles) * min(1, dt * 1.0)
        if simd_distance(before, cameraAngles) > 1e-7 { setCameraTurn(yaw: cameraAngles.x, pitch: cameraAngles.y) }
    }

    /// The breeze: veering slowly, freshening and dying over minutes; stronger in the rain.
    private func updateBreeze(dt: Float) {
        breeze.timer -= dt
        if breeze.timer <= 0 {
            breeze.target = rnd(0.1, 0.7)
            breeze.timer = rnd(20, 60)
        }
        breeze.strength += clamp(breeze.target - breeze.strength, -dt * 0.01, dt * 0.01)
        breeze.angle += dt * 0.004 * sin(Float(clock) * 0.013 + 1)
        wind = V3(cos(breeze.angle), sin(breeze.angle), breeze.strength * (1 + rain * 0.8))
    }

    private func updateBlends(dt: Float, settings: Settings) {
        let before = (night, rain)
        night += clamp((settings.night ? 1 : 0) - night, -dt * 0.2, dt * 0.2)
        rain += clamp((settings.rain ? 1 : 0) - rain, -dt * 0.25, dt * 0.25)
        if before != (night, rain) { applyBlends() }
    }

    private func applyBlends() {
        let n = night, r = rain
        fogColor = lerp(lerp(duskFog, rainFog, r), nightFog, n)
        fogNear = lerp(lerp(200, 60, r), 40, n)
        fogFar = lerp(lerp(5000, 1600, r), 1800, n)
        let hemi = lerp(2.0, 0.7, n)
        hemiSky = V3(lerp(lerp(0.55, 0.45, r), 0.1, n), lerp(0.47, 0.12, n), lerp(lerp(0.63, 0.52, r), 0.22, n)) * hemi
        hemiGround = V3(lerp(0.06, 0.01, n), lerp(0.08, 0.012, n), lerp(0.09, 0.02, n)) * hemi
        // The key light swings from the afterglow to the moon as night falls, and dims in the rain.
        keyDir = lerp(sunDir, moonDir, n).normalized
        keyColor = V3(lerp(1.0, 0.62, n), lerp(0.6, 0.7, n), lerp(0.36, 1.0, n)) * (lerp(6.0, 1.6, n) * (1 - r * 0.9))
        // Its shadow map covers the near thirty metres of the lake, where the bed, rocks and reeds can be seen.
        let target = V3(0, -3, -14)
        shadowMatrix = simd_float4x4(orthoLeft: -30, right: 30, bottom: -18, top: 18, near: 40, far: 220)
            * simd_float4x4(lookAt: target + keyDir * 120, target: target)
    }

    func step(dt: Float, settings: Settings) {
        clock += Double(dt)
        let global = fakeMouse?(Float(clock)) ?? NSEvent.mouseLocation
        cursor.update(global: global, frame: screenFrame, dt: dt)
        updateCamera(dt: dt)
        updateBlends(dt: dt, settings: settings)
        updateBreeze(dt: dt)
        startles.removeAll()
        updateFinger()
        for s in stones { s.update(dt: dt, lake: self) }
        stones.removeAll { $0.done }
        shoal.update(dt: dt)
        loons.update(dt: dt)
        dragonflies.update(dt: dt)
        mist.update(dt: dt, night: night, rain: rain, wind: wind)
        rings.update(time: clock)
        sim.advance(dt: dt)
    }

    // MARK: - Cameras

    private var projection: simd_float4x4 {
        simd_float4x4(perspectiveFovY: fov * .pi / 180, aspect: aspect, near: near, far: far)
    }

    private var view: simd_float4x4 {
        (simd_float4x4(translation: cameraPosition) * simd_float4x4(cameraTurn)).inverse
    }

    /// The mirror camera: the viewer's camera reflected in the plane of the water.
    private var mirror: (position: V3, view: simd_float4x4) {
        let p = V3(cameraPosition.x, -cameraPosition.y, cameraPosition.z)
        var f = cameraTurn.act(V3(0, 0, -1)), up = cameraTurn.act(V3(0, 1, 0))
        f.y = -f.y
        up.y = -up.y
        return (p, simd_float4x4(lookAt: p, target: p + f, up: up))
    }

    /// The mirror's projection with its near plane tilted onto the water (an oblique near plane, as
    /// three's Reflector does), so nothing below the surface shows in the reflection.
    private func clippedProjection(_ proj: simd_float4x4, view: simd_float4x4) -> simd_float4x4 {
        let plane = view.inverse.transpose * V4(0, 1, 0, 0)
        let q = proj.inverse * V4(plane.x < 0 ? -1 : 1, plane.y < 0 ? -1 : 1, 1, 1)
        let c = plane * (1 / simd_dot(plane, q))
        var m = proj
        m.columns.0.z = c.x
        m.columns.1.z = c.y
        m.columns.2.z = c.z
        m.columns.3.z = c.w
        return m
    }

    // MARK: - Drawing

    /// The reflection is cleared to the fog, as the web version clears it.
    var fogClear: MTLClearColor { MTLClearColor(red: Double(fogColor.x), green: Double(fogColor.y), blue: Double(fogColor.z), alpha: 1) }

    private func frame(viewProj: simd_float4x4, view: simd_float4x4, proj: simd_float4x4, eye: V3, drawableHeight: Float,
                       drawableSize: V2) -> FrameUniforms {
        var f = FrameUniforms()
        f.matrix(viewProj)
        f.matrix(view)
        f.matrix(proj)
        f.matrix(shadowMatrix)
        f.vec(V4(eye, 0))
        f.vec(V4(renderTime, drawableHeight, night, rain))
        f.vec(V4(wind, 0))
        f.vec(V4(sunDir, 0))
        f.vec(V4(moonDir, 0))
        f.vec(V4(keyDir, 0))
        f.vec(V4(keyColor, 0))
        f.vec(V4(hemiSky, 0))
        f.vec(V4(hemiGround, 0))
        f.vec(V4(fogColor, 0))
        f.vec(V4(fogNear, fogFar, 0, 0))
        f.vec(V4(drawableSize.x, drawableSize.y, near, far))
        return f
    }

    /// Write this frame's shared uniforms for the main camera and the mirrored one, and the water's own.
    func writeFrames(main: MTLBuffer, mirror mirrorBuffer: MTLBuffer, water waterBuffer: MTLBuffer, drawableSize: V2) {
        let proj = projection, view = self.view
        frame(viewProj: proj * view, view: view, proj: proj, eye: cameraPosition, drawableHeight: drawableSize.y,
              drawableSize: drawableSize).copy(into: main)
        let m = mirror
        let clipped = clippedProjection(proj, view: m.view)
        frame(viewProj: clipped * m.view, view: m.view, proj: clipped, eye: m.position, drawableHeight: drawableSize.y,
              drawableSize: drawableSize).copy(into: mirrorBuffer)
        water.write(into: waterBuffer, mirror: proj * m.view, rings: rings, sim: sim)
    }

    /// The key light's shadow map: with the camera on the BELOW layer, the casters are the reeds,
    /// the rocks, weeds, logs and fish.
    func drawShadows(_ e: MTLRenderCommandEncoder, frame: MTLBuffer) {
        e.setDepthStencilState(GPU.shared.depthWrite)
        e.setCullMode(.none)
        e.setVertexBuffer(frame, offset: 0, index: 1)
        reeds.drawShadow(e)
        bedLife.drawShadow(e)
        shoal.drawShadow(e)
    }

    /// Draw one pass: the opaque parts, then everything that blends.
    func draw(_ ctx: DrawContext, water waterBuffer: MTLBuffer, reflection: MTLTexture?, refraction: MTLTexture?,
              refractionDepth: MTLTexture?) {
        let e = ctx.encoder
        e.setCullMode(.none)
        e.setFrontFacing(.counterClockwise)
        switch ctx.pass {
        case .refraction:
            // The bed last of the opaque parts, so what lies on it hides it before it's shaded.
            bedLife.draw(ctx)
            reeds.draw(ctx)
            lilies.draw(ctx)
            Std.begin(ctx)
            for s in stones where s.layers.visible(in: ctx.pass) {
                Std.draw(ctx, stoneMesh, StdParams(model: s.model, color: RGBA(hex: "#4a4744").linear, roughness: 0.7, metalness: 0.05))
            }
            shoal.drawBodies(ctx)
            bed.draw(ctx, sim: sim)
            shoal.drawFins(ctx)
        case .main, .reflection:
            shore.draw(ctx)
            reeds.draw(ctx)
            loons.draw(ctx)
            dragonflies.drawBodies(ctx)
            Std.begin(ctx)
            for s in stones where s.layers.visible(in: ctx.pass) {
                Std.draw(ctx, stoneMesh, StdParams(model: s.model, color: RGBA(hex: "#4a4744").linear, roughness: 0.7, metalness: 0.05))
            }
            if ctx.pass == .main, let reflection, let refraction, let refractionDepth {
                water.draw(ctx, params: waterBuffer, sim: sim, reflection: reflection, refraction: refraction, depth: refractionDepth)
            }
            lilies.draw(ctx)
            // The sky after everything opaque, so only the sky that shows is shaded.
            sky.draw(ctx)
            // Then what blends: the moon, the mist, the wings, the rain.
            moon.draw(ctx, night: night, rain: rain)
            mist.draw(ctx, eye: cameraPosition)
            dragonflies.drawWings(ctx)
            if ctx.pass == .main { rainFx.draw(ctx, rain: rain) }
        }
    }
}

/// Builds the `Frame` uniform block: four matrices, then float4s, all 16-byte aligned.
struct FrameUniforms {
    static let floatCount = 16 * 4 + 4 * 12
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
