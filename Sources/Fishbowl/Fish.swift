import SceneKit
import simd

final class Fish {
    let species: Species
    let model: FishModel
    let node = SCNNode()
    private let materials: [SCNMaterial]  // body and fins: each has the swim modifier
    private let eyes: SCNNode
    /// Shark only: the lower jaw swings on this pivot; the upper teeth stay with the head.
    private var jawPivot: SCNNode?
    private var upperTeeth: SCNNode?
    private var palate: SCNNode?
    private var lowerTeeth: SCNNode?
    /// 0 = shut, 1 = gaping wide.
    var mouthOpen: Float = 0

    var pos: V3
    var vel: V3
    let size: Float

    private var goal = V3.zero
    private var goalTimer: Float = 0
    private(set) var fear: Float = 0
    private var fleeDir = V3.zero

    // Swim rhythm as last sent to the shader: phase(t) = swimFreq * t + swimOffset.
    private var swimFreq: Float = 0
    private var swimOffset = rnd(0...(2 * .pi))
    private var swimAmp: Float = 0
    /// Sideways curve of the body while turning (world units at the tail joint), as sent / as wanted.
    private var swimBend: Float = 0
    private var targetBend: Float = 0
    private var sinceBendUpdate: Float = 1
    private var lastForward = V3(1, 0, 0)
    private var smoothedAmp: Float = 0
    private var sinceRhythmUpdate: Float = 1
    private var renderTime: Float = 0
    private var orientation = simd_quatf(angle: 0, axis: V3(0, 1, 0))
    private var yaw: Float = 0
    private var roll: Float = 0

    /// Personality: curious fish come over to inspect a resting cursor.
    private let curiosity = rnd(0...1)
    private let speedJitter = rnd(0.8...1.2)
    /// Where a curious fish hovers relative to the cursor: beside it, and well out toward the viewer.
    private let hoverOffset = V3(rnd(0.45...1.0) * (Bool.random() ? 1 : -1), rnd(-0.4...0.4), rnd(0.8...3.5))
    let schoolOffset = V3(rnd(-0.9...0.9), rnd(-0.5...0.5), rnd(-0.9...0.9))

    /// Screen-points-per-second in the species data → world units per second.
    static let speedUnit: Float = 1.2 / 100

    init(species: Species, at p: V3) {
        self.species = species
        let model = FishModel.forSpecies(species)
        self.model = model
        size = rnd(0.85...1.15)

        func instance(_ g: SCNGeometry) -> (SCNNode, SCNMaterial) {
            let copy = g.copy() as! SCNGeometry
            let mat = g.firstMaterial!.copy() as! SCNMaterial
            mat.setValue(model.noseX, forKey: "noseX")
            mat.setValue(model.length, forKey: "bodyLen")
            copy.materials = [mat]
            return (SCNNode(geometry: copy), mat)
        }
        let (bodyNode, bodyMat) = instance(model.body)
        let (finNode, finMat) = instance(model.fins)
        finNode.castsShadow = false
        materials = [bodyMat, finMat]
        eyes = SCNNode(geometry: model.eyes)
        eyes.castsShadow = false
        [bodyNode, finNode, eyes].forEach(node.addChildNode)
        if let jaw = model.jaw {
            let pivot = SCNNode()
            pivot.simdPosition = jaw.hinge
            let shell = SCNNode(geometry: jaw.shell)
            shell.simdPosition = -jaw.hinge
            let lower = SCNNode(geometry: jaw.lowerTeeth)
            lower.simdPosition = -jaw.hinge
            pivot.addChildNode(shell)
            pivot.addChildNode(lower)
            node.addChildNode(pivot)
            let upper = SCNNode(geometry: jaw.upperTeeth)
            node.addChildNode(upper)
            let roof = SCNNode(geometry: jaw.palate)
            node.addChildNode(roof)
            palate = roof
            [shell, lower, upper, roof].forEach { $0.castsShadow = false }
            jawPivot = pivot
            upperTeeth = upper
            lowerTeeth = lower
        }

        pos = p
        let angle = rnd(0...(2 * .pi))
        vel = V3(cos(angle), 0, sin(angle)) * Float(species.cruise) * Fish.speedUnit * 0.5
        yaw = atan2(-vel.z, vel.x)
        orientation = simd_quatf(angle: yaw, axis: V3(0, 1, 0))
        node.simdScale = V3(repeating: size)
        for mat in materials {
            mat.setValue(swimFreq, forKey: "swimFreq")
            mat.setValue(swimOffset, forKey: "swimOffset")
            mat.setValue(swimAmp, forKey: "swimAmp")
            mat.setValue(swimBend, forKey: "swimBend")
        }
        render()
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

        // --- Pick what we're swimming toward.
        var target: V3
        var targetSpeed = cruise
        if fear < 0.35, let food = tank.nearestFood(to: pos, within: 7.5) {
            target = food.pos
            targetSpeed = cruise * 2.2
            if simd_distance(nose, food.pos) < max(0.1, model.length * 0.25 * size) {
                tank.eat(food)
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
        desired += toTarget.normalized * (targetSpeed * min(1, toTarget.length / 1.0) * (1 - fear))

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

        move(desired: desired, dt: dt, cruise: cruise,
             maxSpeed: cruise * 1.4 + (burst - cruise * 1.4) * fear,
             agility: 1.6 + 7 * fear,
             maxClimb: cruise * 0.8 + burst * fear * 0.5,
             excitement: fear, lookAt: lookAt, bounds: b, tank: tank)
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

        // --- Flex into the turn: the body arcs with the tail swinging toward the inside of the curve.
        // Driven by how fast the fish is actually rotating (not where it wants to head).
        let fwd = forward
        let flatNow = V2(fwd.x, fwd.z), flatBefore = V2(lastForward.x, lastForward.z)
        let turnRate = dt > 0 ? angleDelta(atan2(-flatNow.y, flatNow.x), atan2(-flatBefore.y, flatBefore.x)) / dt : 0
        lastForward = fwd
        let flex = Float(species.flex)
        let maxBend = model.length * 0.3 * min(flex, 1.5)
        let bendGoal = clamp(-turnRate * model.length * 0.12 * flex, -maxBend, maxBend)
        targetBend += (bendGoal - targetBend) * min(1, dt * 6)
        updateBend(dt: dt)

        // --- Swimming animation: faster, bigger tail beats at speed.
        let hz = min(8, 1.1 + (speed / Fish.speedUnit) / (Float(species.length) * 0.9))
        let targetAmp = model.length * (0.035 + 0.05 * min(1, speed / (cruise * 2)) + 0.03 * excitement)
        smoothedAmp += (targetAmp - smoothedAmp) * min(1, dt * 3)
        renderTime = tank.renderTime
        updateSwimRhythm(hz: hz, dt: dt)

        render()
    }

    /// Setting shader values is expensive in SceneKit, so the tail-beat phase runs on the GPU and we
    /// only send a new frequency/amplitude when the rhythm has changed noticeably (at most ~6x/s).
    private func updateSwimRhythm(hz: Float, dt: Float) {
        sinceRhythmUpdate += dt
        let freq = Shaders.quantize(hz * 2 * .pi)
        let freqChanged = abs(freq - swimFreq) > swimFreq * 0.12
        let ampChanged = abs(smoothedAmp - swimAmp) > swimAmp * 0.12 + model.length * 0.002
        guard sinceRhythmUpdate > 0.16, freqChanged || ampChanged else { return }
        sinceRhythmUpdate = 0
        if freqChanged {
            // Keep the phase continuous at the moment of the switch.
            let t = renderTime
            swimOffset = (swimFreq * t + swimOffset - freq * t).truncatingRemainder(dividingBy: 2 * .pi)
            swimFreq = freq
            for mat in materials {
                mat.setValue(swimFreq, forKey: "swimFreq")
                mat.setValue(swimOffset, forKey: "swimOffset")
            }
        }
        if ampChanged {
            swimAmp = smoothedAmp
            for mat in materials { mat.setValue(swimAmp, forKey: "swimAmp") }
        }
    }

    /// Like the rhythm, the bend is only sent to the shader when it has changed noticeably.
    private func updateBend(dt: Float) {
        sinceBendUpdate += dt
        guard sinceBendUpdate > 0.08, abs(targetBend - swimBend) > model.length * 0.015 else { return }
        sinceBendUpdate = 0
        swimBend = abs(targetBend) < model.length * 0.01 ? 0 : targetBend
        for mat in materials { mat.setValue(swimBend, forKey: "swimBend") }
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

    private var causticScale: Float = 1

    /// Fish get no caustics or fin glow at night; only touched when the day/night blend steps.
    func setCausticScale(_ scale: Float) {
        guard scale != causticScale else { return }
        causticScale = scale
        materials[0].setValue(0.35 * scale, forKey: "causticStrength")
        materials[1].emission.intensity = CGFloat(0.25 * scale)
    }

    /// Same wave as `Shaders.swim`, so the rigid eyes follow the body.
    private func lateralOffset(atX x: Float) -> Float {
        let s = max(0, (model.noseX - x) / model.length)
        let phase = swimFreq * renderTime + swimOffset
        return swimAmp * (0.08 + s * s) * sin(phase - s * 3.2) + swimBend * s * s
    }

    // MARK: - Rendering

    private func render() {
        node.simdPosition = pos
        node.simdOrientation = orientation
        // The eyes are rigid, so shift them with the head's part of the swim wave.
        eyes.simdPosition = V3(0, 0, lateralOffset(atX: model.eyeX))
        if let jaw = model.jaw, let pivot = jawPivot {
            let lateral = V3(0, 0, lateralOffset(atX: jaw.midX))
            pivot.simdPosition = jaw.hinge + lateral
            // The lower jaw drops, front first, about the hinge at the back of the mouth.
            pivot.simdEulerAngles = V3(0, 0, -0.75 * mouthOpen)
            upperTeeth?.simdPosition = lateral
            palate?.simdPosition = lateral
            // The inside of the mouth only exists while it's open.
            let shut = mouthOpen < 0.03
            upperTeeth?.isHidden = shut
            lowerTeeth?.isHidden = shut
            palate?.isHidden = shut
        }
    }
}
