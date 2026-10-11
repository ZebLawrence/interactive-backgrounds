import SceneKit
import simd

/// One fish's behaviour: where it wants to go (wandering, schooling, food, curiosity, fear) and how
/// it moves and turns there. Drawing and animation live in its `FishRig`.
final class Fish {
    let species: Species
    let model: FishModel
    let rig: FishRig
    var node: SCNNode { rig.node }
    /// Shark only: 0 = shut, 1 = gaping wide.
    var mouthOpen: Float {
        get { rig.mouthOpen }
        set { rig.mouthOpen = newValue }
    }

    var pos: V3
    var vel: V3
    let size: Float

    private var goal = V3.zero
    private var goalTimer: Float = 0
    private(set) var fear: Float = 0
    private var fleeDir = V3.zero

    private(set) var orientation = simd_quatf(angle: 0, axis: V3(0, 1, 0))
    private var yaw: Float = 0
    private var roll: Float = 0
    private var lastForward = V3(1, 0, 0)

    /// Personality: curious fish come over to inspect a resting cursor.
    private let curiosity = rnd(0...1)
    private let speedJitter = rnd(0.8...1.2)
    /// Where a curious fish hovers relative to the cursor: beside it, and well out toward the viewer.
    private let hoverOffset = V3(rnd(0.45...1.0) * (Bool.random() ? 1 : -1), rnd(-0.4...0.4), rnd(0.8...3.5))
    let schoolOffset = V3(rnd(-0.9...0.9), rnd(-0.5...0.5), rnd(-0.9...0.9))

    /// Swimming style: a few tail beats that speed the fish up, then a coast while it slows.
    private let stroke: Stroke
    private var beating = Bool.random()
    private var strokeTimer: Float = rnd(0...0.5)
    /// Smoothed version of what goes to `rig.thrust`, so the tail eases in and out of a glide.
    private var thrust: Float = 1

    /// C-start escape: time left in the current one, whether its push-off is still to come, and
    /// how long before another can fire.
    private var escapeTimer: Float = 0
    private var escapeKick = false
    private var escapeCooldown: Float = 0

    /// Screen-points-per-second in the species data → world units per second.
    static let speedUnit: Float = 1.2 / 100

    init(species: Species, at p: V3) {
        self.species = species
        stroke = Stroke.forSpecies(species)
        let model = FishModel.forSpecies(species)
        self.model = model
        size = rnd(0.85...1.15)
        rig = FishRig(model: model, size: size)
        pos = p
        let angle = rnd(0...(2 * .pi))
        vel = V3(cos(angle), 0, sin(angle)) * Float(species.cruise) * Fish.speedUnit * 0.5
        yaw = atan2(-vel.z, vel.x)
        orientation = simd_quatf(angle: yaw, axis: V3(0, 1, 0))
        lastForward = forward
        rig.node.simdPosition = pos
        rig.node.simdOrientation = orientation
    }

    var forward: V3 { orientation.act(V3(1, 0, 0)) }
    var nose: V3 { pos + forward * (model.length * 0.5 * size) }

    // MARK: - Behaviour

    func update(dt: Float, tank: Tank) {
        let sp = species
        let cruise = Float(sp.cruise) * Fish.speedUnit * speedJitter
        let burst = Float(sp.burst) * Fish.speedUnit
        let c = tank.cursor
        var desired = V3.zero
        var lookAt: V3?
        let depthFrac = clamp(-pos.z / tank.depth, 0, 1)
        let fearBefore = fear

        // --- Startle: react to where the fish *appears* relative to a fast-moving cursor.
        if c.present {
            let sp2 = tank.project(pos)
            let dScreen = Float(hypot(sp2.x - c.screen.x, sp2.y - c.screen.y))
            let speed = Float(c.speed)
            let moving = speed > 140
            let radius = (110 + min(speed, 2500) * 0.1) * (1 - 0.45 * depthFrac)
            if dScreen < radius && (moving || dScreen < 45) {
                let intensity = moving ? min(1.4, 0.45 + speed / 900) : 0.5
                let startle = min(1, (1 - dScreen / radius) * intensity)
                if startle > fear {
                    fear = startle
                    goalTimer = 0
                }
                // Away from the cursor's line of sight, and back from the glass where the "hand" is.
                var away = (pos - tank.closestPointOnCursorRay(pos)).normalized + V3(0, 0, -0.7)
                if moving {
                    // Dart sideways out of the cursor's path.
                    let mv = V3(Float(c.vel.dx), Float(c.vel.dy), 0).normalized
                    let side = V3(-mv.y, mv.x, 0)
                    away += side * (simd_dot(away, side) >= 0 ? 0.8 : -0.8)
                }
                fleeDir = away.normalized
            }
        }
        // --- A hunting shark nearby: scatter.
        if let threat = tank.shark?.threat(to: self) {
            if threat.intensity > fear {
                fear = threat.intensity
                goalTimer = 0
            }
            fleeDir = threat.away
        }
        fear = max(0, fear - dt * 0.55)
        let panic = escape(dt: dt, fearBefore: fearBefore, burst: burst)

        // --- Pick what we're swimming toward.
        var target: V3
        var targetSpeed = cruise
        var feeding = false
        if fear < 0.35, let food = tank.nearestFood(to: pos, within: 7.5) {
            target = food.pos
            targetSpeed = cruise * 2.2
            feeding = true
            if simd_distance(nose, food.pos) < max(0.1, model.length * 0.25 * size) {
                tank.eat(food)
                rig.gulp()
            }
        } else if c.present && c.stillTime > 0.7 && fear < 0.05 && curiosity > 0.45
                    && tank.screenDistance(pos, c.screen) < 420 {
            // Swim up close, beside the cursor's line of sight (so it appears next to the cursor on
            // screen), and turn to face the viewer.
            let g = tank.cursorGlassPoint
            let z = min(hoverOffset.z, tank.frontZ - 0.8)
            let f = (tank.eyeDistance - z) / tank.eyeDistance
            target = V3((g.x + hoverOffset.x) * f, (g.y + hoverOffset.y) * f, z)
            targetSpeed = cruise * 1.2
            lookAt = V3(g.x * f, g.y * f, z + 3)
        } else if sp.schooling, let g = tank.schoolGoal(for: sp) {
            target = g + schoolOffset
        } else {
            goalTimer -= dt
            if goalTimer <= 0 || simd_distance(pos, goal) < 0.3 { pickGoal(in: tank) }
            target = goal
        }
        let toTarget = target - pos
        // Close to where it wants to be (hovering by the cursor, waiting at food, at the anemone):
        // hold station on the pectorals instead of beating the tail.
        let hovering = toTarget.length < 0.6 && vel.length < cruise * 0.6 && fear < 0.1
        let propelling = updateStroke(dt: dt, sustained: feeding || fear > 0.2, hovering: hovering)
        let surging = propelling && !hovering
        let pace = surging ? stroke.boost : 1
        desired += toTarget.normalized * (targetSpeed * pace * min(1, toTarget.length / 1.0) * (1 - fear))

        // --- Neighbours: personal space, and schooling with our own kind.
        var align = V3.zero, centre = V3.zero, n: Float = 0
        let myRadius = model.length * size
        for o in tank.fish where o !== self {
            let dv = pos - o.pos
            let d = dv.length
            let minD = (myRadius + o.model.length * o.size) * 0.55 + 0.05
            if d < minD && d > 0.0001 {
                desired += dv.normalized * ((1 - d / minD) * cruise * 1.6)
            }
            if sp.schooling && o.species.id == sp.id && d < 1.6 {
                align += o.vel
                centre += o.pos
                n += 1
            }
        }
        if n > 0 {
            desired += (align / n - vel) * 0.35
            desired += (centre / n - pos).normalized * (cruise * 0.25)
        }

        // --- Steer around big scenery (reef mounds, corals).
        for o in tank.obstacles {
            let dv = pos - o.center
            let d = dv.length
            let r = o.radius + myRadius * 0.5 + 0.2
            if d < r && d > 0.0001 { desired += dv.normalized * ((1 - d / r) * cruise * 3) }
        }

        // --- Stay inside the tank (soft walls).
        let b = tank.bounds(at: pos, bodyLength: myRadius)
        let push = cruise * 2.5
        let m: Float = 0.9
        if pos.x < b.minX + m { desired.x += (b.minX + m - pos.x) / m * push }
        if pos.x > b.maxX - m { desired.x -= (pos.x - (b.maxX - m)) / m * push }
        if pos.y < b.minY + m * 0.6 { desired.y += (b.minY + m * 0.6 - pos.y) / (m * 0.6) * push }
        if pos.y > b.maxY - m * 0.6 { desired.y -= (pos.y - (b.maxY - m * 0.6)) / (m * 0.6) * push }
        if pos.z < b.minZ + m { desired.z += (b.minZ + m - pos.z) / m * push }
        if pos.z > b.maxZ - m * 0.5 { desired.z -= (pos.z - (b.maxZ - m * 0.5)) / (m * 0.5) * push }

        // --- Flee.
        desired += fleeDir * (burst * fear)

        // --- Coasting: the fins can still steer, but without the tail nothing adds speed; water
        // drag slowly bleeds it off (braking toward a slower goal is still allowed).
        if !propelling && panic < 0.01 {
            vel *= max(0, 1 - stroke.drag * dt)
            let coast = vel.length
            let want = desired.length
            if want > coast { desired *= coast / want }
        }

        // Tail beats also make for quicker turns and pickup than a glide.
        let agility = (1.6 + 7 * panic) * (surging ? stroke.pickup : 1)
        rig.thrust = thrust
        move(desired: desired, dt: dt, cruise: cruise,
             maxSpeed: (cruise * 1.4 + (burst - cruise * 1.4) * panic) * pace,
             agility: agility,
             maxClimb: cruise * 0.8 + burst * panic * 0.5,
             excitement: panic, lookAt: lookAt, bounds: b, tank: tank)
    }

    /// Advance the burst-and-glide cycle and ease `thrust` toward it. Returns whether the fish is
    /// under power (false = coasting). `sustained` (fleeing, racing for food) keeps the tail going;
    /// `hovering` (which wins, e.g. waiting beside food) holds station with only a gentle scull.
    private func updateStroke(dt: Float, sustained: Bool, hovering: Bool) -> Bool {
        strokeTimer -= dt
        // A glide ends early once the fish has slowed right down (e.g. setting off from a hover).
        let slow = vel.length < Float(species.cruise) * Fish.speedUnit * 0.45
        if strokeTimer <= 0 || (!beating && slow && !hovering) {
            beating.toggle()
            strokeTimer = beating ? rnd(stroke.beat) : rnd(stroke.glide)
        }
        let powered = sustained || escapeTimer > 0 || beating
        let goal: Float = hovering
            ? clamp(0.1 + 0.6 * vel.length / (Float(species.cruise) * Fish.speedUnit), 0.1, 0.45)
            : (powered ? 1 : 0)
        // The tail picks up quickly and settles a little more gently.
        thrust += (goal - thrust) * min(1, dt * (goal > thrust ? 10 : 7))
        return powered || hovering
    }

    /// C-start: on the onset of a fright, curl hard into a C away from the threat, pivot toward the
    /// escape, then push off at burst speed. Returns the effective panic level (fear, or more while
    /// the escape is under way) for speed and turning limits.
    private func escape(dt: Float, fearBefore: Float, burst: Float) -> Float {
        escapeCooldown -= dt
        if fear > 0.4 && fearBefore <= 0.4 && escapeCooldown <= 0 {
            escapeTimer = 0.4
            escapeKick = true
            escapeCooldown = rnd(1.4...2.2)
            // Which side of the fish the escape lies on (its local +z / -z).
            let side = simd_dot(fleeDir, orientation.act(V3(0, 0, 1)))
            let sign: Float = abs(side) > 0.1 ? (side > 0 ? 1 : -1) : (Bool.random() ? 1 : -1)
            rig.curl(sign * (0.35 + 0.2 * min(1, fear)))
            // Stage one: pivot toward the escape without much forward travel.
            vel = fleeDir * (vel.length * 0.4)
        }
        guard escapeTimer > 0 else { return fear }
        escapeTimer -= dt
        if escapeKick && escapeTimer < 0.32 {
            // Stage two: the tail snaps back and the fish shoots off.
            escapeKick = false
            vel = fleeDir * max(vel.length, burst * (0.6 + 0.2 * fear))
        }
        return max(fear, min(1, escapeTimer / 0.25))
    }

    /// Steer toward the `desired` velocity, stay inside `b`, turn to face the heading (or `lookAt`
    /// when nearly still), bank into turns and animate the tail. Shared by fish and the shark.
    func move(desired: V3, dt: Float, cruise: Float, maxSpeed: Float, agility: Float, maxClimb: Float,
              excitement: Float, lookAt: V3?, bounds b: Tank.Bounds, tank: Tank) {
        vel += (desired - vel) * min(1, dt * agility)
        vel = vel.limited(to: maxSpeed)
        // Fish rarely swim straight up or down.
        vel.y = clamp(vel.y, -maxClimb, maxClimb)
        pos += vel * dt
        pos.x = clamp(pos.x, b.minX - 0.2, b.maxX + 0.2)
        pos.y = clamp(pos.y, b.minY - 0.1, b.maxY + 0.1)
        pos.z = clamp(pos.z, b.minZ - 0.2, b.maxZ + 0.1)

        // --- Orientation: head along velocity (or toward what we're looking at), bank into turns.
        let speed = vel.length
        var heading = vel
        if let look = lookAt, speed < cruise * 0.6 { heading = look - pos }
        let flat = hypot(heading.x, heading.z)
        if flat > 0.02 || abs(heading.y) > 0.02 {
            let newYaw = flat > 0.01 ? atan2(-heading.z, heading.x) : yaw
            let pitch = clamp(atan2(heading.y, max(flat, 0.001)), -0.6, 0.6)
            let yawRate = angleDelta(newYaw, yaw) / max(dt, 0.001)
            yaw = newYaw
            roll += (clamp(-yawRate * 0.12, -0.5, 0.5) - roll) * min(1, dt * 3)
            let q = simd_quatf(angle: yaw, axis: V3(0, 1, 0))
                * simd_quatf(angle: pitch, axis: V3(0, 0, 1))
                * simd_quatf(angle: roll, axis: V3(1, 0, 0))
            orientation = simd_slerp(orientation, q, min(1, dt * (3 + 8 * excitement)))
        }

        // How fast the body is actually rotating (not where it wants to head), for the turn bend.
        let fwd = forward
        let turnRate = dt > 0
            ? angleDelta(atan2(-fwd.z, fwd.x), atan2(-lastForward.z, lastForward.x)) / dt : 0
        lastForward = fwd

        rig.node.simdPosition = pos
        rig.node.simdOrientation = orientation
        rig.animate(dt: dt, fish: self, speed: speed, cruise: cruise, excitement: excitement,
                    turnRate: turnRate, tank: tank)
    }

    private func pickGoal(in tank: Tank) {
        // Clownfish mostly stay close to their anemone.
        if species.id == Species.clownfish.id, let home = tank.anemoneTop, Float.random(in: 0...1) < 0.75 {
            goal = home + V3(rnd(-0.5...0.5), rnd(0.05...0.6), rnd(-0.45...0.45))
            goalTimer = rnd(2...5)
            return
        }
        goal = tank.wanderPoint(band: species.band, near: pos)
        goalTimer = rnd(4...11)
    }

    /// Fish get no caustics or fin glow at night.
    func setCausticScale(_ scale: Float) { rig.setCausticScale(scale) }
}

/// How a species swims when unhurried: bursts of tail beats (seconds) separated by glides (seconds).
/// During a burst it aims for `boost` x its cruise speed and responds `pickup` x faster; while
/// gliding, speed decays at `drag` per second. Tuned so the average pace stays near cruise.
private struct Stroke {
    var beat: ClosedRange<Float>
    var glide: ClosedRange<Float>
    var boost: Float
    var pickup: Float
    var drag: Float

    static func forSpecies(_ sp: Species) -> Stroke {
        switch sp.id {
        // Quick darts, short coasts.
        case Species.neonTetra.id: return Stroke(beat: 0.25...0.45, glide: 0.3...0.7, boost: 1.3, pickup: 3, drag: 1.5)
        // Slow, sparse beats and long, stately glides.
        case Species.angelfish.id: return Stroke(beat: 0.5...0.9, glide: 1.4...2.8, boost: 1.35, pickup: 1.6, drag: 0.45)
        // Busy little bursts.
        case Species.clownfish.id: return Stroke(beat: 0.3...0.6, glide: 0.2...0.45, boost: 1.1, pickup: 2, drag: 1.3)
        // Leisurely goldfish and betta.
        case Species.betta.id: return Stroke(beat: 0.7...1.2, glide: 0.9...1.7, boost: 1.1, pickup: 1.5, drag: 0.6)
        default: return Stroke(beat: 0.7...1.3, glide: 0.8...1.5, boost: 1.2, pickup: 1.5, drag: 0.65)
        }
    }
}
