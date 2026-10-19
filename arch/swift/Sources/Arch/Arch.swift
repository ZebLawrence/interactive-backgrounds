import AppKit
import Metal
import simd

/// The cursor in screen points (relative to this screen, y up), with smoothed velocity.
struct Cursor {
    var screen = CGPoint(x: -10_000, y: -10_000)
    var present = false
    var vel = CGVector.zero
    var speed: Float = 0
    var stillTime: Float = 0

    mutating func update(_ p: CGPoint, inside: Bool, dt: Float) {
        if inside && present && dt > 0 {
            let vx = (p.x - screen.x) / CGFloat(dt), vy = (p.y - screen.y) / CGFloat(dt)
            vel = CGVector(dx: vel.dx + (vx - vel.dx) * 0.35, dy: vel.dy + (vy - vel.dy) * 0.35)
        } else {
            vel = .zero
        }
        present = inside
        screen = p
        speed = Float(hypot(vel.dx, vel.dy))
        stillTime = speed < 25 ? stillTime + dt : 0
    }
}

/// The cursor's fingertip in the world: on the water if the cursor is over water, else in the air.
struct Finger {
    var point = V3.zero
    var inWater = false
    var valid = false
    var prev: V3?
}

/// A splash: anything within `radius` of it startles.
struct Startle { let x: Float, z: Float, radius: Float }

private let gravity: Float = 9.81

/// A tossed stone: from the hand to where you clicked, then a plunk (or a thump on the shore).
final class Stone {
    var pos: V3
    private var vel: V3
    private var spin = rnd(0, TAU)
    let size = rnd(0.035, 0.055)
    private(set) var sinking = false
    private(set) var settled = false
    private(set) var done = false

    init(from: V3, target: V3) {
        pos = from
        let to = target - pos
        let D = max(hypot(to.x, to.z), 0.01)
        let vh = clamp(D / 1.3, 4, 18)
        let T = D / vh
        vel = V3(to.x / D * vh, (target.y - pos.y + gravity * T * T / 2) / T, to.z / D * vh)
    }

    /// Above the water while it flies or rests on the shore; under it once it sinks.
    var layers: Layers { sinking ? .below : .surface }

    var model: simd_float4x4 { compose(pos, quatAxis(spin, 0.3, 1, 0.2), V3(size, size * 0.6, size * 0.85)) }

    func update(dt: Float, scene: Arch) {
        if settled { return }
        vel.y -= gravity * dt
        pos += vel * dt
        spin += dt * 18
        let ground = groundHeight(pos.x, pos.z)
        if ground > 0 && pos.y <= ground && vel.y < 0 {
            scene.dust(V3(pos.x, ground + 0.05, pos.z), n: 6, size: 0.25)
            pos.y = ground + size * 0.3
            settled = true
            done = true
            return
        }
        if pos.y <= 0 && vel.y < 0 && !sinking {
            pos.y = 0
            scene.splash(pos.x, pos.z, size: size * 6, speed: vel.length)
            vel *= 0.2
            sinking = true
        }
        if sinking {
            vel *= exp(-dt * 3)
            vel.y = -0.6
            if pos.y < floorHeight(pos.x, pos.z) - 0.1 || pos.y < -12 { done = true }
        }
    }
}

/// The scene filling one screen: a lake under a natural bridge at night, the aurora over it, the
/// craft hovering beneath. Owns the camera, the lights, the cursor's verbs, and steps every
/// system. Units are metres; the water is y = 0, the viewer stands on the near bank at the origin,
/// the bridge is 150 m away toward -z.
final class Arch {
    let screenFrame: CGRect
    var screenW: Float { Float(screenFrame.width) }
    var screenH: Float { Float(screenFrame.height) }
    let fov: Float
    let aspect: Float
    let focal: Float
    /// Screen points per metre at one metre, for point sprites.
    let pointScale: Float
    let near: Float = 0.2
    let far: Float = 60_000
    private let basePitch = Ref.pitch

    private(set) var cursor = Cursor()
    private(set) var clock: Double = 0
    var renderTime: Float { Float(clock.truncatingRemainder(dividingBy: timeWrap)) }
    /// The viewer's eye: where the reference picture was taken from.
    let cameraPosition = V3(0, Ref.eyeY, 0)
    private(set) var cameraTurn = simd_quatf.identity
    private var cameraInverse = simd_quatf.identity
    private var cameraAngles = V2.zero

    private(set) var finger = Finger()
    var startles: [Startle] = []
    private var stones: [Stone] = []
    private var keptStones: [Stone] = []
    private var breeze = (angle: Float.pi / 2, strength: Float(0.12), target: Float(0.12), timer: rnd(10, 30), gust: Float(0))
    /// The breeze over the water: direction (x, z) and strength 0..1.
    private(set) var wind = V3(0, 1, 0.12)
    /// 0..1, eased toward the Rain setting.
    private(set) var rain: Float = 0
    private let lightState: LightState
    private var light = LightState.Out()
    /// What the rock shader draws itself (the craft sets the beam and lamps; the rain the wet).
    var rockLights = RockLights()
    private var moonShadowMatrix = matrix_identity_float4x4

    let sky = Sky()
    let moon = Moon()
    let aurora = Aurora()
    let terrain: Terrain
    let bridge: Bridge
    let sim: WaveSim
    let rings = Rings()
    let water = Water()
    let floor: Floor
    let rainfall = Rain()
    let lightning = Lightning()
    let shrubs: Shrubs
    let blocks: Blocks
    let puffs = Puffs(max: 400)
    let drops = Puffs(max: 400, tint: V3(1.3, 1.4, 1.5))
    private let stoneMesh = Geometry.sphere(radius: 1, widthSegments: 12, heightSegments: 9).upload()
    private(set) var craft: Craft!
    private var craftOn: Bool

    /// For testing without a real mouse: returns a global cursor position for a given time.
    var fakeMouse: ((Float) -> CGPoint)?
    /// For testing: aim the camera at a world point with a narrow field of view (degrees).
    var look: (at: V3, fov: Float)?

    /// `--hide terrain,water,...`: leave parts out, to measure what a frame costs.
    /// The reflection and refraction are drawn at this fraction of the screen's resolution: the
    /// ripples bend and blur them anyway, and the night water is opaque within a metre or two.
    static let mirrorScale: Float = 0.5

    static let hidden: Set<String> = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--hide"), i + 1 < a.count else { return [] }
        return Set(a[i + 1].split(separator: ",").map(String.init))
    }()

    /// `--look-craft fov`: follow the craft with a narrow camera, for close-ups.
    static let followCraft: Float? = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--look-craft") else { return nil }
        return i + 1 < a.count ? Float(a[i + 1]) ?? 8 : 8
    }()

    init(screenFrame: CGRect, settings: Settings, fov: Float = 50) {
        self.screenFrame = screenFrame
        self.fov = fov
        aspect = Float(screenFrame.width / screenFrame.height)
        focal = Float(screenFrame.height / 2) / tan(fov / 2 * .pi / 180)
        pointScale = focal
        let args = CommandLine.arguments
        let seed = args.firstIndex(of: "--seed").flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil }
        let rng = Seeded(seed ?? Int.random(in: 0..<1_000_000_000))
        lightState = LightState(settings: settings)
        terrain = Terrain()
        bridge = Bridge(rng: rng)
        sim = WaveSim(size: settings.lowPower ? 1536 : 2048)
        floor = Floor(sim: sim)
        shrubs = Shrubs(rng: rng)
        blocks = Blocks(rng: rng)
        craftOn = settings.craft
        setCameraTurn(yaw: 0, pitch: 0)
        craft = Craft(scene: self)
        light = lightState.update(dt: 0, settings: settings, auroraLevel: aurora.level)
        updateShadowCamera()
    }

    // MARK: - Geometry helpers

    private func setCameraTurn(yaw: Float, pitch: Float) {
        cameraTurn = quatAxis(yaw, 0, 1, 0) * quatAxis(basePitch + pitch, 1, 0, 0)
        cameraInverse = cameraTurn.inverse
    }

    /// Screen position (points, y up) and depth of a world point, through the camera as turned.
    func project(_ p: V3) -> (x: Float, y: Float, depth: Float) {
        let q = cameraInverse.act(p - cameraPosition)
        let depth = max(-q.z, 0.01)
        let f = focal / depth
        return (screenW / 2 + q.x * f, screenH / 2 + q.y * f, depth)
    }

    /// The line of sight through a screen point.
    func ray(_ s: CGPoint) -> (origin: V3, dir: V3) {
        let local = V3((Float(s.x) - screenW / 2) / focal, (Float(s.y) - screenH / 2) / focal, -1)
        return (cameraPosition, cameraTurn.act(local).normalized)
    }

    /// Where a screen point meets the water, if it does within `maxDist` metres, over the lake and in sight.
    func waterPoint(_ s: CGPoint, maxDist: Float = 300) -> V3? {
        let (origin, dir) = ray(s)
        if dir.y >= -1e-4 { return nil }
        let t = -origin.y / dir.y
        if t > maxDist { return nil }
        let p = origin + dir * t
        if groundHeight(p.x, p.z) > -0.05 { return nil }
        // Rock in the way?
        if rockHit(s, maxDist: t) != nil { return nil }
        return p
    }

    /// The first rock (ground or bridge) along a screen ray.
    func rockHit(_ s: CGPoint, maxDist: Float = 900) -> (point: V3, dist: Float)? {
        let (origin, dir) = ray(s)
        return rockRay(origin, dir, maxDist: maxDist)
    }

    /// The first rock along a world ray, marched in steps that grow with distance.
    func rockRay(_ origin: V3, _ dir: V3, maxDist: Float = 900) -> (point: V3, dist: Float)? {
        var p = origin
        var step: Float = 0.5
        var d: Float = 0
        while d < maxDist {
            p += dir * step
            if insideRock(p) { return (p, d) }
            if p.y > 400 { return nil }
            d += step
            step = clamp(d * 0.01, 0.5, 6)
        }
        return nil
    }

    /// Does a screen point land on the craft?
    private func craftHit(_ s: CGPoint) -> Bool {
        let (origin, dir) = ray(s)
        let c = craft.pos
        let t = (c - origin).dot(dir)
        if t < 0 { return false }
        return (origin + dir * t).distance(to: c) < 14
    }

    // MARK: - Disturbing the water

    /// A dent in the water: simulated near by, an analytic ring far out.
    func disturb(_ x: Float, _ z: Float, radius: Float, amount: Float, ring: Float = 0) {
        if sim.splat(x, z, radius: radius, amount: amount) { return }
        if ring > 0 { rings.add(x, z, amp: ring * 0.006, time: clock) }
    }

    func splash(_ x: Float, _ z: Float, size: Float, speed: Float) {
        let s = clamp(size, 0.1, 3), v = clamp(speed / 10, 0.3, 2.5)
        disturb(x, z, radius: 0.12 + s * 0.35, amount: -(0.015 + 0.04 * s) * v, ring: 1.2 * s * v)
        drops.burst(at: V3(x, 0.05, z), n: Int((10 + 50 * s * v).rounded()), size: 0.45 + s * 0.8 * v, vel: V3(0, 3.2 * v * (0.5 + s), 0))
        startles.append(Startle(x: x, z: z, radius: 4 + 5 * s * v))
    }

    func dust(_ at: V3, n: Int, size: Float) { puffs.burst(at: at, n: n, size: size) }

    private func keep(_ stone: Stone) {
        keptStones.append(stone)
        if keptStones.count > 40 { keptStones.removeFirst() }
    }

    // MARK: - Cursor verbs

    private func updateFinger(dt: Float) {
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
        let f = finger.point
        if finger.inWater && inSim(f.x, f.z) {
            let segLen = wasInWater.map { $0.distance(to: f) } ?? 0
            if let from = wasInWater, c.speed > 30 && segLen < 2 {
                let n = clamp(Int(ceil(segLen / 0.05)), 1, 8)
                let amount = -0.004 * clamp(c.speed / 600, 0.4, 1.6)
                for i in 1...n {
                    let p = lerp(from, f, Float(i) / Float(n))
                    _ = sim.splat(p.x, p.z, radius: 0.06 + 0.03 * clamp(c.speed / 1000, 0, 1), amount: amount / Float(n).squareRoot())
                }
            } else if wasInWater == nil {
                _ = sim.splat(f.x, f.z, radius: 0.08, amount: -0.005)
            }
        }
        finger.prev = finger.inWater ? f : nil
        if c.speed > 700 { breeze.gust = min(breeze.gust + dt * 2, 1) }
    }

    /// A click on the desktop: the craft, a stone onto the water or the shore, or a surge in the aurora.
    func click(atScreen s: CGPoint) {
        if craftOn && craftHit(s) {
            craft.rouse()
            return
        }
        let hand = cameraPosition + V3(0.3, -0.4, -0.4)
        if let wp = waterPoint(s, maxDist: 400) {
            stones.append(Stone(from: hand, target: wp))
            return
        }
        if let rock = rockHit(s, maxDist: 60) {
            var p = rock.point
            if groundHeight(p.x, p.z) < 6 && p.distance(to: cameraPosition) < 60 {
                p.y = groundHeight(p.x, p.z)
                stones.append(Stone(from: hand, target: p))
            }
            return
        }
        aurora.flare(ray(s).dir)
    }

    func surge() { aurora.substorm() }

    // MARK: - Frame loop

    /// Near a screen edge the camera turns a few degrees toward it, and drifts back when it leaves.
    private func updateCamera(dt: Float) {
        let maxYaw: Float = 3 * .pi / 180, maxPitch: Float = 1.5 * .pi / 180
        var target = V2.zero
        if cursor.present {
            let w = screenW, h = screenH
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

    /// A canyon's air moves in slow puffs, with now and then a gust off a fast cursor.
    private func updateBreeze(dt: Float) {
        breeze.timer -= dt
        if breeze.timer <= 0 {
            breeze.target = chance(0.5) ? rnd(0, 0.08) : rnd(0.1, 0.35)
            breeze.timer = rnd(20, 70)
        }
        breeze.strength += clamp(breeze.target - breeze.strength, -dt * 0.01, dt * 0.01)
        breeze.angle += sin(Float(clock) * 0.011) * 0.02 * dt
        breeze.gust = max(0, breeze.gust - dt * 0.35)
        let s = clamp(breeze.strength + breeze.gust * 0.6, 0, 1)
        wind = V3(cos(breeze.angle), sin(breeze.angle), s)
    }

    /// The moon's shadow camera: fitted round the box of everything that casts or catches its
    /// shadows (the near shore, the bridge, the walls round it), seen from the moon.
    private func updateShadowCamera() {
        let target = V3(-10, 30, -150)
        let pos = target + moonDir * 420
        let view = simd_float4x4(lookAt: pos, target: target)
        let bmin = V3(-150, -12, -215), bmax = V3(125, 100, 12)
        var lo = V3(repeating: .infinity), hi = V3(repeating: -.infinity)
        for i in 0..<8 {
            let c = V3(i & 1 != 0 ? bmax.x : bmin.x, i & 2 != 0 ? bmax.y : bmin.y, i & 4 != 0 ? bmax.z : bmin.z)
            let v = view * V4(c, 1)
            lo = simd_min(lo, V3(v.x, v.y, v.z))
            hi = simd_max(hi, V3(v.x, v.y, v.z))
        }
        let n = max(1, -hi.z - 5), f = -lo.z + 5
        moonShadowMatrix = simd_float4x4(orthoLeft: lo.x, right: hi.x, bottom: lo.y, top: hi.y, near: n, far: f) * view
    }

    func step(dt: Float, settings: Settings) {
        clock += Double(dt)
        let global = fakeMouse?(Float(clock)) ?? NSEvent.mouseLocation
        let inside = screenFrame.contains(global)
        cursor.update(CGPoint(x: global.x - screenFrame.minX, y: global.y - screenFrame.minY), inside: inside, dt: dt)
        updateCamera(dt: dt)
        aurora.update(dt: dt, camera: cameraPosition)
        light = lightState.update(dt: dt, settings: settings, auroraLevel: aurora.level)
        // Rain: the night closes in. The aurora and the moon dim behind the cloud, the fog draws
        // nearer, the lake is peppered with drops near the viewer (the far water's patter is drawn
        // by its shader), and the rock, the water and the craft are told how wet they are.
        rain = approach(rain, settings.rain ? 1 : 0, 2.5, dt)
        aurora.fade = lightState.aurora * (1 - 0.995 * rain)
        if rain > 0.001 {
            let n = Int((rain * 7).rounded())
            for _ in 0..<n { _ = sim.splat(simOrigin.x + rnd(0, simExtent), simOrigin.y + rnd(0, simExtent), radius: 0.1, amount: -0.003) }
        }
        // Lightning: now and then under the rain a bolt forks down the sky ahead; its flash lights
        // the clouds, the whole canyon and everything in it.
        lightning.update(dt: dt, storm: rain, camera: cameraPosition)
        water.rain = rain
        rockLights.wet = rain
        rainfall.update(camera: cameraPosition, rain: rain)
        updateBreeze(dt: dt)
        startles.removeAll()
        updateFinger(dt: dt)
        for s in stones { s.update(dt: dt, scene: self) }
        for s in stones where s.done && s.settled { keep(s) }
        stones.removeAll { $0.done }
        puffs.update(dt: dt)
        drops.update(dt: dt)
        craftOn = settings.craft
        if craftOn {
            for s in startles where hypot(s.x - craft.pos.x, s.z - craft.pos.z) < 40 { craft.startle(V3(s.x, 0, s.z), 0.6) }
            craft.update(dt: dt, scene: self)
        } else {
            rockLights.beam.w = 0
            rockLights.lamp.w = 0
        }
        if let f = Arch.followCraft { look = (craft.pos, f) }
        rings.update(time: clock)
        sim.advance(dt: dt)
    }

    /// What everyone is doing (the `--log` flag).
    func log() {
        print(String(format: "moon %.2f aurora %.2f (%@, level %.2f) rain %.2f flash %.2f wind (%.2f, %.2f) x %.2f",
                     lightState.moon, lightState.aurora, aurora.debugDescription, aurora.level, rain, lightning.flash.w, wind.x, wind.y, wind.z))
        print(String(format: "finger %@ (%.1f, %.1f), stones %d flying, %d kept", finger.inWater ? "in water" : (finger.valid ? "in air" : "none"),
                     finger.point.x, finger.point.z, stones.count, keptStones.count))
        if let hit = rockHit(cursor.screen) { print(String(format: "cursor on rock at (%.1f, %.1f, %.1f), %.0f m", hit.point.x, hit.point.y, hit.point.z, hit.dist)) }
        print("craft \(craft!.debugDescription)")
    }

    // MARK: - Cameras

    private var projection: simd_float4x4 {
        simd_float4x4(perspectiveFovY: (look?.fov ?? fov) * .pi / 180, aspect: aspect, near: near, far: far)
    }

    private var turn: simd_quatf {
        guard let look else { return cameraTurn }
        let f = (look.at - cameraPosition).normalized
        return simd_quatf(euler: V3(asin(clamp(f.y, -1, 1)), atan2(-f.x, -f.z), 0), order: "YXZ")
    }

    private var view: simd_float4x4 { (simd_float4x4(translation: cameraPosition) * simd_float4x4(turn)).inverse }

    /// The mirror camera: the viewer's camera reflected in the plane of the water.
    private var mirror: (position: V3, view: simd_float4x4) {
        let p = V3(cameraPosition.x, -cameraPosition.y, cameraPosition.z)
        var f = turn.act(V3(0, 0, -1)), up = turn.act(V3(0, 1, 0))
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

    var clearColor: MTLClearColor { MTLClearColor(red: Double(light.fog.x), green: Double(light.fog.y), blue: Double(light.fog.z), alpha: 1) }

    private func frame(viewProj: simd_float4x4, view: simd_float4x4, proj: simd_float4x4, eye: V3, drawableSize: V2, msaa: Bool) -> FrameUniforms {
        let L = light, r = rain, fl = lightning.flash
        var f = FrameUniforms()
        f.matrix(viewProj)
        f.matrix(view)
        f.matrix(proj)
        f.matrix(moonShadowMatrix)
        f.matrix(moonShadowMatrix)
        f.vec(V4(eye, 0))
        f.vec(V4(renderTime, lightState.moon, lightState.aurora, r))
        f.vec(V4(wind, 0))
        f.vec(V4(sunDir, 0))
        f.vec(V4(moonDir, 0))
        f.vec(V4(moonDir, 0))
        f.vec(V4(L.bounce * L.bounceI, 0))
        // The moon, dimmer under the cloud, and the lightning's flash on top.
        let keyI = L.keyI * (1 - 0.55 * r) + fl.w * 2.5
        f.vec(V4(L.key * keyI, keyI > 0.01 ? 1 : 0))
        let hemi = L.hemi * (1 - 0.2 * r) + fl.w * 2.5
        f.vec(V4(L.sky * hemi, 0))
        f.vec(V4(L.ground * hemi, 0))
        f.vec(V4(aurora.light * lightState.aurora * (1 - 0.9 * r), 0))
        f.vec(V4(L.fog, 0))
        f.vec(V4(lerp(L.fogNear, 50, r), lerp(L.fogFar, 420, r), 0, 0))
        let scale = pointScale * drawableSize.y / screenH * (fov / (look?.fov ?? fov))
        f.vec(V4(drawableSize.x, drawableSize.y, scale, msaa ? 1 : 0))
        f.vec(fl)
        if craftOn {
            f.vec(V4(craft.lamp.pos, craft.lamp.range))
            f.vec(V4(craft.lamp.color, 0))
            f.vec(V4(craft.eye.pos, craft.eye.range))
            f.vec(V4(craft.eye.color, 0))
        } else {
            for _ in 0..<4 { f.vec(.zero) }
        }
        // three's DirectionalLightShadow on the moon: bias -0.0008, normal bias 1.6 m (the rock is metres deep).
        f.vec(V4(1.6, 0.0008, 0, 0))
        f.vec(V4(L.sky * (L.hemi / .pi), 0))
        return f
    }

    /// Write this frame's shared uniforms for the camera, the mirrored camera, the moon's shadow pass
    /// and the water's own. Returns whether the moon's shadow map is needed.
    func writeFrames(main: MTLBuffer, mirror mirrorBuffer: MTLBuffer, moon moonBuffer: MTLBuffer, water waterBuffer: MTLBuffer,
                     drawableSize: V2, msaa: Bool) -> Bool {
        let proj = projection, view = self.view
        frame(viewProj: proj * view, view: view, proj: proj, eye: cameraPosition, drawableSize: drawableSize, msaa: msaa).copy(into: main)
        let m = mirror
        let clipped = clippedProjection(proj, view: m.view)
        frame(viewProj: clipped * m.view, view: m.view, proj: clipped, eye: m.position, drawableSize: drawableSize * Arch.mirrorScale, msaa: false).copy(into: mirrorBuffer)
        frame(viewProj: moonShadowMatrix, view: view, proj: proj, eye: cameraPosition, drawableSize: drawableSize, msaa: false).copy(into: moonBuffer)
        water.write(into: waterBuffer, mirror: proj * m.view, rings: rings, sim: sim)
        return light.keyI * (1 - 0.55 * rain) + lightning.flash.w > 0.01
    }

    /// Draw one pass. Each part draws only in the passes its layers allow: in the shadow pass what
    /// casts, in the reflection what stands above the water, in the refraction what lies under it.
    func draw(_ ctx: DrawContext, water waterParams: MTLBuffer? = nil) {
        let e = ctx.encoder
        e.setCullMode(.none)
        e.setFrontFacing(.counterClockwise)
        let H = Arch.hidden
        if !H.contains("terrain") {
            // The bridge first: it stands in front of most of the land, which then fails the depth test.
            bridge.draw(ctx, lights: rockLights)
            terrain.draw(ctx, lights: rockLights)
        }
        if !H.contains("shore") {
            blocks.draw(ctx, lights: rockLights)
            shrubs.draw(ctx)
        }
        let shown = (stones + keptStones).filter { ctx.shows($0.layers) }
        if !shown.isEmpty {
            Std.begin(ctx)
            for s in shown {
                Std.draw(ctx, stoneMesh, StdParams(model: s.model, color: RGBA(hex: "#6b5244").linear, roughness: 0.8, metalness: 0.02))
            }
        }
        if craftOn && !H.contains("craft") { craft.draw(ctx) }
        if ctx.isShadow { return }
        if ctx.pass == .refraction {
            if !H.contains("water") { floor.draw(ctx, sim: sim) }
            return
        }
        if ctx.pass == .main, let waterParams, !H.contains("water") { water.draw(ctx, params: waterParams, sim: sim) }
        // The sky after everything opaque, so only the sky that shows is shaded.
        sky.draw(ctx, moon: lightState.moon)
        moon.draw(ctx, opacity: lightState.moon * (1 - 0.97 * rain))
        // Then what blends.
        if !H.contains("aurora") { aurora.draw(ctx) }
        // The bolt, dust and drops stand above the water, so the reflection shows them too; each
        // checks its own layers, and the rain draws only in the main pass.
        lightning.draw(ctx)
        rainfall.draw(ctx)
        puffs.draw(ctx)
        drops.draw(ctx)
    }
}

/// Builds the `Frame` uniform block: five matrices, then float4s, all 16-byte aligned.
struct FrameUniforms {
    static let floatCount = 16 * 5 + 4 * 21
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
