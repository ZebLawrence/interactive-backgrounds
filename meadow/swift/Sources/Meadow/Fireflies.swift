import Metal
import simd

// MARK: - Species

/// Each lantern glows in a slow, peaceful rhythm of its own, fading in and out rather than
/// flashing: the Big Dipper's long rising glow, the synchronous firefly's shared pulse (which falls
/// into step with its neighbours), Photuris's pair of glows high over the meadow, and the blue
/// ghost's faint steady light low in the grass. Only a fright or a clap switches a lantern abruptly.
struct FireflySpecies {
    enum Kind { case dipper, synchronous, photuris, ghost }

    let kind: Kind
    let name: String
    let color: RGBA
    let count: Int
    let speed: Float
    let agility: Float
    let height: ClosedRange<Float>
    let period: ClosedRange<Float>
    let light: Float
    let curious: Double
    let sync: Bool
    let zone: (near: Float, far: Float)

    static let dipper = FireflySpecies(kind: .dipper, name: "Big Dipper", color: RGBA(0.88, 1.0, 0.40),
                                       count: 48, speed: 0.28, agility: 1.1, height: 0.3...1.6, period: 9...13,
                                       light: 0.7, curious: 0.4, sync: false, zone: (1.5, 20))
    static let synchronous = FireflySpecies(kind: .synchronous, name: "Synchronous", color: RGBA(0.98, 1.0, 0.50),
                                            count: 64, speed: 0.33, agility: 1.4, height: 0.4...2.0, period: 12...13.5,
                                            light: 0.55, curious: 0.85, sync: true, zone: (1.5, 22))
    static let photuris = FireflySpecies(kind: .photuris, name: "Photuris", color: RGBA(0.62, 1.0, 0.62),
                                         count: 20, speed: 0.6, agility: 2.0, height: 1.0...3.2, period: 8...11,
                                         light: 0.45, curious: 0.25, sync: false, zone: (2, 28))
    static let ghost = FireflySpecies(kind: .ghost, name: "Blue ghost", color: RGBA(0.66, 0.78, 1.0),
                                      count: 16, speed: 0.12, agility: 0.7, height: 0.08...0.45, period: 18...30,
                                      light: 0.7, curious: 0.15, sync: false, zone: (1.2, 14))

    static let all = [dipper, synchronous, photuris, ghost]

    /// Brightness 0...1 of the lantern at `phase` (0...1 through its cycle).
    func flash(_ phase: Float) -> Float {
        /// A glow that eases in and out over the fraction `width` of the cycle starting at `from`.
        func glow(_ from: Float, _ width: Float) -> Float {
            let u = (phase - from) / width
            return u >= 0 && u < 1 ? pow(sin(u * .pi), 1.6) : 0
        }
        switch kind {
        case .dipper: return glow(0, 0.28)                              // one long glow
        case .synchronous: return glow(0, 0.4)                          // a slow shared pulse
        case .photuris: return glow(0, 0.2) + glow(0.26, 0.16) * 0.75   // two glows close together
        case .ghost: return 0.26 + 0.12 * sin(phase * TAU)              // a faint steady light
        }
    }
}

// MARK: - One firefly

final class Firefly {
    enum Mode { case wander, gather, flee, hide }

    let species: FireflySpecies
    var pos = V3.zero
    var vel = V3.zero
    private var goal = V3.zero
    private var goalTimer: Float = 0
    var phase = Float.random(in: 0..<1)
    private let period: Float
    var mode = Mode.wander
    private var fleeDir = V3.zero
    var fleeTimer: Float = 0
    private var dark: Float = 0
    var clapFlash: Float = 0
    private var gatherRolled = false
    private var gatherOffset = V3.zero
    private var gatherTimer: Float = 0
    private var gatherDepth: Float = 0
    private var bobPhase = rnd(0, TAU)
    private let bobRate = rnd(0.8, 1.6)
    private(set) var brightness: Float = 0
    /// Kuramoto coupling, worked out by the swarm each frame.
    var sumSin: Float = 0
    var neighbours = 0
    /// Each firefly keeps to its own stretch of the meadow.
    private let zMin: Float
    private let zMax: Float

    init(species: FireflySpecies, meadow: Meadow) {
        self.species = species
        period = rnd(species.period)
        let (near, far) = species.zone
        let mid = rnd(near + 1, far - 1)
        zMin = -min(far, mid + rnd(3, 8))
        zMax = -max(near, mid - rnd(3, 8))
        pos = randomPoint(meadow)
        goal = randomPoint(meadow)
    }

    private func randomPoint(_ m: Meadow) -> V3 {
        let z = rnd(zMin, zMax)
        let hw = m.halfWidth(-z) * 0.9
        let x = rnd(-hw, hw)
        return V3(x, groundHeight(x, z) + rnd(species.height), z)
    }

    /// Lantern on: the pattern unless it's been scared dark, or a clap set it off.
    private func updateLantern(dt: Float, storm: Float) {
        dark = max(0, dark - dt)
        clapFlash = max(0, clapFlash - dt)
        var b = dark > 0 ? 0 : species.flash(phase)
        // A clap switches the lantern on at once; it then fades out over half a second.
        if clapFlash > 0 { b = max(b, min(1, clapFlash / 0.5)) }
        // In the rain they shelter in the grass and barely glow.
        b *= 1 - storm * 0.92
        brightness = b
    }

    func update(dt: Float, meadow m: Meadow, swarm: Swarm) {
        let sp = species
        let cursor = m.cursor
        let storm = m.storm
        let scr = m.project(pos)
        let distPx = cursor.present ? Float(hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y)) : .infinity
        let speed = Float(cursor.speed)

        // A fast cursor nearby: dart away from its line of sight and go dark for a while.
        if cursor.present && speed > 350 && mode != .flee {
            let radius = (90 + min(speed, 2500) * 0.08) / (1 + scr.depth / 14)
            if distPx < radius { startle(from: m.closestPointOnCursorRay(pos), fleeFor: 1.0 + rnd(0, 0.8), darkFor: 2.5) }
        }
        if speed > 120 { gatherRolled = false }

        if storm > 0.5 && mode != .flee { mode = .hide } else if mode == .hide && storm <= 0.5 { mode = .wander }

        // A resting cursor: curious ones drift over to hover around it.
        if mode == .wander && cursor.present && cursor.stillTime > 0.8 && !gatherRolled {
            gatherRolled = true
            let near = distPx < Float(m.screenW) * 0.45 ? 1.0 : 0.15
            if swarm.gathered < swarm.gatherCap && chance(sp.curious * near) {
                mode = .gather
                gatherDepth = clamp(pos.z, -12, -1.8)
                gatherTimer = 0
            }
        }
        if mode == .gather && !cursor.present { mode = .wander }

        // Where to head.
        var speedGoal = sp.speed, agility = sp.agility
        switch mode {
        case .wander:
            goalTimer -= dt
            if goalTimer <= 0 || pos.distance(to: goal) < 0.3 {
                goal = randomPoint(m)
                goalTimer = rnd(5, 12)
            }
        case .gather:
            gatherTimer -= dt
            if gatherTimer <= 0 {
                gatherTimer = rnd(1.5, 4)
                let r = rnd(0.3, 1.1), a = rnd(0, TAU), e = rnd(-0.6, 0.6)
                gatherOffset = V3(cos(a) * cos(e) * r, sin(e) * r, sin(a) * cos(e) * r)
            }
            goal = m.cursorPoint(atDepth: gatherDepth) + gatherOffset
            let minY = groundHeight(goal.x, goal.z) + 0.2
            if goal.y < minY { goal.y = minY }
            speedGoal = max(sp.speed, 0.55)
            agility = sp.agility + 0.6
        case .flee:
            fleeTimer -= dt
            goal = pos + fleeDir * 3
            speedGoal = 1.8
            agility = 4
            if fleeTimer <= 0 { mode = .wander; goalTimer = 0 }
        case .hide:
            goal = V3(pos.x, groundHeight(pos.x, pos.z) + 0.1, pos.z)
            speedGoal = 0.35
        }

        // Steer: ease the velocity toward where we want to go, slowing on arrival.
        let toGoal = goal - pos
        let dist = toGoal.length
        var desired = dist > 1e-4 ? toGoal * (min(speedGoal, dist * 1.5) / dist) : .zero
        // Soft walls: the meadow's visible edges and the ground.
        let hw = m.halfWidth(-pos.z) * 0.95
        if pos.x > hw { desired.x -= (pos.x - hw) * 2 }
        if pos.x < -hw { desired.x += (-hw - pos.x) * 2 }
        if pos.z > zMax { desired.z -= (pos.z - zMax) * 2 }
        if pos.z < zMin { desired.z += (zMin - pos.z) * 2 }
        let floorY = groundHeight(pos.x, pos.z) + 0.06
        if pos.y < floorY { desired.y += (floorY - pos.y) * 6 }
        vel += (desired - vel) * min(1, dt * agility)

        // The lantern.
        if sp.sync {
            // Kuramoto coupling with neighbours; stronger when gathered.
            let k = (0.35 + (mode == .gather ? 1.4 : 0)) / TAU
            phase += dt * (1 / period + (neighbours > 0 ? k * sumSin / Float(neighbours) : 0))
        } else {
            phase += dt / period
        }
        phase -= floor(phase)
        updateLantern(dt: dt, storm: storm)
        // The Big Dipper climbs as it flashes, drawing its "J" in the air.
        if sp.kind == .dipper && brightness > 0 && dark <= 0 { vel.y += dt * 0.35 * brightness }

        pos += vel * dt
        bobPhase += dt * bobRate
    }

    /// Dart away from `from`, going dark for `darkFor` seconds.
    func startle(from: V3, fleeFor: Float, darkFor: Float) {
        let away = (pos - from).normalized
        fleeDir = (away + V3(rnd(-0.4, 0.4), rnd(-0.2, 0.3), rnd(-0.4, 0.4))).normalized
        if fleeDir.y < -0.1 { fleeDir.y = -0.1 }
        mode = .flee
        fleeTimer = fleeFor
        dark = max(dark, darkFor)
    }

    /// The point to draw: the position plus a little hover.
    var drawPosition: V3 { V3(pos.x, pos.y + sin(bobPhase) * 0.03, pos.z) }
}

// MARK: - The swarm

/// Owns the fireflies, draws them as glowing point sprites and feeds the brightest ones to the
/// grass and ground shaders as lights.
final class Swarm {
    private unowned let meadow: Meadow
    private(set) var flies: [Firefly] = []
    private(set) var gathered = 0
    let gatherCap = 40
    /// The brightest, nearest lanterns this frame: (position, light) and linear colour.
    private(set) var lights: [V4] = []
    private(set) var lightColors: [V3] = []

    private let staticData: MTLBuffer
    private let dynamicData: FrameRing

    init(meadow: Meadow, density: Float) {
        self.meadow = meadow
        let scale = density * clamp(meadow.area, 0.6, 2.0)
        for sp in FireflySpecies.all {
            for _ in 0..<Int((Float(sp.count) * scale).rounded()) { flies.append(Firefly(species: sp, meadow: meadow)) }
        }
        staticData = GPU.shared.buffer(flies.map { V4($0.species.color.linear, $0.species.kind == .ghost ? 0.14 : 0.2) })
        dynamicData = FrameRing(length: max(1, flies.count) * MemoryLayout<V4>.stride)
    }

    /// Everyone near `point` flashes at once and bolts.
    func clap(at point: V3, radius: Float) {
        for f in flies where f.pos.distance(to: point) <= radius {
            f.clapFlash = 0.5 + rnd(0, 0.15)
            f.startle(from: point, fleeFor: 1.2 + rnd(0, 0.6), darkFor: 3 + rnd(0, 1.5))
            f.fleeTimer += 0.3
        }
    }

    func update(dt: Float) {
        // Phase coupling for the synchronous species: each sees its neighbours' lanterns.
        let sync = flies.filter(\.species.sync)
        for f in sync { f.sumSin = 0; f.neighbours = 0 }
        for i in sync.indices {
            let a = sync[i]
            for j in (i + 1)..<sync.count {
                let b = sync[j]
                if a.pos.distanceSquared(b.pos) > 16 { continue }
                let s = sin((b.phase - a.phase) * TAU)
                a.sumSin += s; a.neighbours += 1
                b.sumSin -= s; b.neighbours += 1
            }
        }

        gathered = flies.reduce(0) { $0 + ($1.mode == .gather ? 1 : 0) }
        for f in flies { f.update(dt: dt, meadow: meadow, swarm: self) }

        // Pick the brightest (weighted toward the camera) as lights for the grass.
        let cam = meadow.cameraPosition
        var candidates: [(p: V3, w: Float, c: V3, score: Float)] = []
        for f in flies {
            let light = f.brightness * f.species.light
            guard light > 0.02 else { continue }
            let p = f.drawPosition
            candidates.append((p, light, f.species.color.linear, light / (1 + p.distanceSquared(cam) / 60)))
        }
        candidates.sort { $0.score > $1.score }
        lights = candidates.prefix(Shaders.lightCount).map { V4($0.p, $0.w) }
        lightColors = candidates.prefix(Shaders.lightCount).map(\.c)
    }

    func draw(_ ctx: DrawContext) {
        guard !flies.isEmpty else { return }
        let buf = dynamicData[ctx.slot]
        let p = buf.contents().assumingMemoryBound(to: V4.self)
        for (i, f) in flies.enumerated() { p[i] = V4(f.drawPosition, f.brightness) }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("fireflyVertex", "fireflyFragment", blend: .additive, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(buf, offset: 0, index: 0)
        e.setVertexBuffer(staticData, offset: 0, index: 1)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 2)
        e.drawPrimitives(type: .point, vertexStart: 0, vertexCount: flies.count)
    }
}

extension SIMD3 where Scalar == Float {
    func distanceSquared(_ o: V3) -> Float { simd_distance_squared(self, o) }
}
