import CoreGraphics
import Metal
import simd

// MARK: - Species

/// Colours and markings, painted onto a 1024x512 image (u along the body from the nose, v round the
/// body from the belly over the back and down again, mirrored for the two flanks).
private struct Spots { let color: RGBA; let n: Int; let r: (Double, Double); let band: (Double, Double); var halo: RGBA? = nil }

private struct Species {
    let back: RGBA, side: RGBA, belly: RGBA
    let band: RGBA?
    let fin: RGBA
    let finEdge: Bool
    var vermiculate = false
    let spots: [Spots]
    let metal: Float, rough: Float
}

private let species: [String: Species] = [
    "rainbow": Species(back: RGBA(0.34, 0.42, 0.27), side: RGBA(0.76, 0.78, 0.74), belly: RGBA(0.95, 0.95, 0.92),
                       band: RGBA(0.92, 0.45, 0.5, 0.55), fin: RGBA(0.5, 0.45, 0.4), finEdge: false,
                       spots: [Spots(color: .bytes(10, 12, 10, 0.9), n: 420, r: (0.5, 1.6), band: (0.26, 0.5))],
                       metal: 0.35, rough: 0.42),
    "brook": Species(back: RGBA(0.2, 0.3, 0.17), side: RGBA(0.5, 0.47, 0.3), belly: RGBA(0.9, 0.5, 0.18),
                     band: nil, fin: RGBA(0.85, 0.42, 0.14), finEdge: true, vermiculate: true,
                     spots: [Spots(color: .bytes(230, 200, 90, 0.85), n: 140, r: (1.2, 2.4), band: (0.22, 0.4)),
                             Spots(color: .bytes(210, 50, 30, 0.95), n: 55, r: (1.0, 1.8), band: (0.18, 0.32), halo: .bytes(90, 130, 230, 0.6))],
                     metal: 0.15, rough: 0.55),
    "brown": Species(back: RGBA(0.36, 0.3, 0.16), side: RGBA(0.78, 0.66, 0.36), belly: RGBA(0.92, 0.86, 0.68),
                     band: nil, fin: RGBA(0.6, 0.45, 0.25), finEdge: false,
                     spots: [Spots(color: .bytes(15, 12, 8, 0.95), n: 170, r: (1.4, 3.2), band: (0.2, 0.5), halo: .bytes(240, 225, 180, 0.55)),
                             Spots(color: .bytes(200, 45, 30, 0.9), n: 40, r: (1.0, 1.8), band: (0.18, 0.3), halo: .bytes(240, 225, 180, 0.5))],
                     metal: 0.25, rough: 0.5),
]

private func skinImage(_ sp: Species) -> Canvas {
    let w = 1024.0, h = 512.0, half = h / 2
    let c = Canvas(Int(w), Int(h))
    let ctx = c.ctx
    // Base gradient over half the height (belly to back), mirrored for the other flank.
    func paintHalf(_ y0: Double, flip: Bool) {
        ctx.saveGState()
        ctx.translateBy(x: 0, y: y0)
        if flip {
            ctx.translateBy(x: 0, y: half)
            ctx.scaleBy(x: 1, y: -1)
        }
        c.clipped(CGRect(x: 0, y: 0, width: w, height: half)) {
            c.linearGradient(from: .zero, to: CGPoint(x: 0, y: half),
                             [(0, sp.belly), (0.42, sp.side), (0.75, sp.back.mix(sp.side, 0.3)), (1, sp.back)])
        }
        // Scale sheen: fine diagonal rows catching the light.
        ctx.setAlpha(0.07)
        for x in stride(from: 0.0, to: w, by: 7) {
            c.fill(Int(x / 7) % 2 == 1 ? RGBA(1, 1, 1) : RGBA(0, 0, 0))
            c.fillRect(x, 0, 3, half)
        }
        ctx.setAlpha(1)
        if let band = sp.band {
            c.clipped(CGRect(x: w * 0.14, y: half * 0.3, width: w * 0.86, height: half * 0.3)) {
                c.linearGradient(from: CGPoint(x: 0, y: half * 0.3), to: CGPoint(x: 0, y: half * 0.6),
                                 [(0, band.alpha(0)), (0.5, band), (1, band.alpha(0))])
            }
        }
        if sp.vermiculate {
            // Worm-tracks of pale marbling across the back.
            c.stroke(.bytes(190, 200, 150, 0.75))
            ctx.setLineWidth(2.2)
            ctx.setLineCap(.round)
            for _ in 0..<260 {
                var x = rndD(w * 0.12, w), y = rndD(half * 0.62, half)
                ctx.beginPath()
                ctx.move(to: CGPoint(x: x, y: y))
                for _ in 0..<6 {
                    let a = fbm2(x * 0.02, y * 0.02, 2) * .pi * 4
                    x += cos(a) * 6
                    y += sin(a) * 4
                    ctx.addLine(to: CGPoint(x: x, y: y))
                }
                ctx.strokePath()
            }
        }
        for S in sp.spots {
            for _ in 0..<S.n {
                // Spots sit on the upper flank and back: the band is a fraction of the way from belly to back.
                let x = rndD(w * 0.1, w * 0.98)
                let yy = half * (1 - (S.band.0 + (S.band.1 - S.band.0) * Double.random(in: 0..<1)))
                let r = rndD(S.r.0, S.r.1) * (1 + 0.6 * (1 - yy / half))
                if let halo = S.halo {
                    c.fill(halo)
                    c.dot(x, yy, r * 1.9)
                }
                c.fill(S.color)
                c.fillEllipse(x, yy, r, r * rndD(0.8, 1.1))
            }
        }
        // Head: the gill cover's curve, a darker cheek, and the eye with its gold ring.
        c.stroke(.bytes(30, 30, 25, 0.5))
        ctx.setLineWidth(3)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: w * 0.2, y: half * 0.1))
        ctx.addQuadCurve(to: CGPoint(x: w * 0.19, y: half * 0.95), control: CGPoint(x: w * 0.24, y: half * 0.5))
        ctx.strokePath()
        c.stroke(.bytes(40, 30, 25, 0.6))
        ctx.setLineWidth(2)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: 0, y: half * 0.42))
        ctx.addQuadCurve(to: CGPoint(x: w * 0.11, y: half * 0.36), control: CGPoint(x: w * 0.05, y: half * 0.4))
        ctx.strokePath()
        let ex = w * 0.085, ey = half * 0.62
        c.fill(.bytes(210, 170, 70))
        c.dot(ex, ey, 15)
        c.fill(RGBA(hex: "#0a0a0c"))
        c.dot(ex, ey, 9.5)
        c.fill(RGBA(1, 1, 1, 0.7))
        c.dot(ex - 3, ey - 3, 2.2)
        ctx.restoreGState()
    }
    paintHalf(0, flip: false)
    paintHalf(half, flip: true)
    return c
}

/// A translucent fin membrane with rays.
private func finImage(_ sp: Species) -> Canvas {
    let w = 256.0, h = 256.0
    let c = Canvas(Int(w), Int(h))
    c.fill(sp.fin.alpha(0.85))
    c.fillRect(0, 0, w, h)
    c.stroke(.bytes(20, 15, 10, 0.35))
    for i in 0..<14 {
        let x = (Double(i) + 0.5) / 14 * w
        c.line(x, h, x + rndD(-8, 8), 0, width: 2)
    }
    if sp.finEdge {
        c.fill(RGBA(1, 1, 1, 0.9))
        c.fillRect(0, 0, w, 22)
        c.fill(RGBA(0, 0, 0, 0.6))
        c.fillRect(0, 22, w, 10)
    }
    return c
}

// MARK: - Shared geometry and skins

/// The body is a tube of elliptical rings along the x axis, nose at +0.5 and tail at -0.5 (the fish
/// swims along +x); the fins are flat fans. Positions are in units of body length.
private final class TroutParts {
    static let shared = TroutParts()
    let body: GPUMesh
    let fins: GPUMesh
    private var skins: [String: (skin: MTLTexture, fin: MTLTexture)] = [:]

    private init() {
        let rings = 44, around = 18
        func halfHeight(_ t: Float) -> Float {
            0.105 * pow(sin(.pi * pow(t, 0.72)), 0.9) * (1 - 0.55 * smoothstep(0.6, 0.9, t)) + 0.022 * smoothstep(0.65, 1, t)
        }
        var m = MeshData()
        for r in 0...rings {
            let t = Float(r) / Float(rings)
            let a = halfHeight(t), b = halfHeight(t) * (0.55 - 0.1 * t) + 0.004
            for k in 0...around {
                let th = Float(k) / Float(around) * TAU
                // Fuller belly than back.
                let y = -cos(th) * a * (cos(th) > 0 ? 1.05 : 0.92)
                m.positions.append(V3(0.5 - t, y, sin(th) * b))
                m.uvs.append(V2(t, Float(k) / Float(around)))
            }
        }
        for r in 0..<rings {
            for k in 0..<around {
                let a = UInt32(r * (around + 1) + k), b = a + 1, c = a + UInt32(around + 1), d = c + 1
                m.indices += [a, b, c, b, d, c]
            }
        }
        m.computeVertexNormals()
        body = m.upload()

        /// A fin: a fan of quads from a root segment along the body to an outer edge.
        func fin(_ root0: V3, _ root1: V3, _ tip0: V3, _ tip1: V3) -> MeshData {
            var g = MeshData()
            let segs = 6
            for i in 0...segs {
                let t = Float(i) / Float(segs)
                g.positions += [lerp(root0, root1, t), lerp(tip0, tip1, t)]
                g.uvs += [V2(t, 1), V2(t, 0)]
            }
            for i in 0..<segs {
                let a = UInt32(i * 2), b = a + 1, c = a + 2, d = a + 3
                g.indices += [a, b, c, b, d, c]
            }
            g.computeVertexNormals()
            return g
        }
        // Fin positions are written nose-to-tail in 0...1.25; the body runs the other way.
        func V(_ x: Float, _ y: Float, _ z: Float) -> V3 { V3(0.5 - x, y, z) }
        fins = MeshData.merged([
            // Tail: forked, flaring from the peduncle.
            fin(V(0.97, 0.03, 0), V(0.97, -0.03, 0), V(1.2, 0.15, 0), V(1.2, -0.15, 0)),
            // Dorsal, adipose and anal along the midline.
            fin(V(0.38, 0.1, 0), V(0.56, 0.085, 0), V(0.46, 0.19, 0), V(0.6, 0.14, 0)),
            fin(V(0.78, 0.055, 0), V(0.84, 0.05, 0), V(0.83, 0.1, 0), V(0.86, 0.075, 0)),
            fin(V(0.72, -0.07, 0), V(0.82, -0.05, 0), V(0.8, -0.14, 0), V(0.86, -0.08, 0)),
            // Pectorals and pelvics, paired, angled down and back.
            fin(V(0.24, -0.06, 0.045), V(0.27, -0.075, 0.04), V(0.36, -0.12, 0.11), V(0.4, -0.13, 0.09)),
            fin(V(0.24, -0.06, -0.045), V(0.27, -0.075, -0.04), V(0.36, -0.12, -0.11), V(0.4, -0.13, -0.09)),
            fin(V(0.55, -0.09, 0.03), V(0.6, -0.085, 0.025), V(0.64, -0.15, 0.06), V(0.68, -0.14, 0.05)),
            fin(V(0.55, -0.09, -0.03), V(0.6, -0.085, -0.025), V(0.64, -0.15, -0.06), V(0.68, -0.14, -0.05)),
        ]).upload()
    }

    func textures(_ name: String) -> (skin: MTLTexture, fin: MTLTexture) {
        if let t = skins[name] { return t }
        let sp = species[name]!
        let t = (GPU.shared.texture(skinImage(sp), srgb: true), GPU.shared.texture(finImage(sp), srgb: true))
        skins[name] = t
        return t
    }
}

// MARK: - One trout

final class Trout {
    enum State { case cruise, hold, rise, dive, investigate, flee }

    let speciesName: String
    let length: Float
    var pos = V3.zero
    var vel = V3.zero
    var heading = rnd(0, TAU)
    private var pitch: Float = 0
    private var roll: Float = 0
    var state = State.cruise
    var timer = rnd(2, 8)
    private var riseTimer = rnd(30, 120)
    private var wanderPhase = rnd(0, TAU)
    private var target: V3?
    private let phaseOffset = rnd(0, TAU)
    private var phase = rnd(0, TAU)
    private var burst: Float = 0
    private var rose = false
    private var amp: Float = 0.03
    private var turn: Float = 0
    private var tint = V3(1, 1, 1)

    init(species name: String) {
        speciesName = name
        length = name == "brook" ? rnd(0.26, 0.36) : rnd(0.32, 0.48)
    }

    func forward() -> V3 { V3(cos(heading) * cos(pitch), sin(pitch), -sin(heading) * cos(pitch)) }

    /// Startle: bolt away from a point, a C-start.
    func startle(from: V3, strength: Float = 1) {
        var away = V3(pos.x - from.x, 0, pos.z - from.z).normalized
        if away.lengthSquared < 0.5 { away = V3(cos(heading + 1.5), 0, -sin(heading + 1.5)) }
        vel = away * (1.6 * strength) + V3(0, -0.5 * strength, 0)
        heading = atan2(-away.z, away.x)
        state = .flee
        timer = rnd(0.9, 1.6)
        burst = 1
    }

    /// Begin a rise toward the surface at a point.
    private func rise(at: V3) {
        target = V3(at.x, -0.03, at.z)
        state = .rise
        timer = 6
        rose = false
    }

    func update(dt: Float, lake: Lake) {
        let bounds = lake.fishBounds
        let cursor = lake.cursor

        // Reactions to the cursor, in screen space so near and far fish feel the same.
        let scr = lake.project(pos)
        if cursor.present && scr.depth > 0.5 && cursor.speed > 450 && state != .flee {
            let dpx = Float(hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y))
            let radius = (150 + min(Float(cursor.speed), 2500) * 0.09) / (1 + scr.depth / 12)
            if dpx < radius { startle(from: lake.closestPointOnCursorRay(pos)) }
        }
        for s in lake.startles {
            let d = hypot(pos.x - s.x, pos.z - s.z)
            if d < s.radius && state != .flee { startle(from: V3(s.x, 0, s.z), strength: clamp(1.4 - d / s.radius, 0.5, 1.2)) }
        }

        timer -= dt
        riseTimer -= dt
        let headingBefore = heading
        var acc = V3.zero
        var want: Float = 0.3 // cruising speed, m/s
        switch state {
        case .cruise:
            // A slow S-path, veering now and then.
            wanderPhase += dt * 0.25
            heading += sin(wanderPhase * 1.7 + phaseOffset) * 0.35 * dt
            want = 0.22 + 0.12 * sin(phaseOffset + Float(lake.clock) * 0.1)
            if timer <= 0 {
                state = chance(0.55) ? .hold : .cruise
                timer = rnd(4, 12)
            }
            if riseTimer <= 0 {
                let f = V3(forward().x, 0, forward().z).normalized
                let at = pos + f * rnd(1.2, 3)
                if at.z < -1.5 && abs(at.x) < bounds.halfWidth(-at.z) { rise(at: at) }
                riseTimer = rnd(45, 140) * (lake.rain > 0.5 ? 0.5 : 1)
            }
        case .hold:
            // Holding station, finning gently, facing roughly across the view.
            want = 0.04
            heading += (cos(heading) >= 0 ? 1 : -1) * 0.08 * dt * 0.3
            if timer <= 0 {
                state = .cruise
                timer = rnd(6, 16)
            }
        case .rise:
            let to = target! - pos
            let d = to.length
            want = clamp(0.25 + d * 0.3, 0.3, 0.7)
            heading = lerpAngle(heading, atan2(-to.z, to.x), min(1, dt * 3))
            pitch = lerp(pitch, clamp(atan2(to.y, hypot(to.x, to.z)), -0.9, 0.9), min(1, dt * 3))
            if !rose && d < length * 0.35 {
                // The sip: a ring and a flash of flank as the fish rolls at the surface.
                rose = true
                lake.disturb(target!.x, target!.z, radius: 0.16, amount: -0.012 * length / 0.35, ring: 0.5)
                roll = rnd(0.6, 1.1) * (coin() ? 1 : -1)
                timer = 0.5
            }
            if rose && timer <= 0 {
                state = .dive
                timer = rnd(1.5, 3)
                target = pos + V3(rnd(-1, 1), -rnd(0.6, 1.0), rnd(-1, 1))
            }
            if !rose && timer <= 0 {
                state = .cruise
                timer = rnd(4, 10)
            }
        case .dive:
            let to = target! - pos
            want = 0.45
            heading = lerpAngle(heading, atan2(-to.z, to.x), min(1, dt * 2))
            pitch = lerp(pitch, clamp(atan2(to.y, hypot(to.x, to.z)), -0.9, 0.9), min(1, dt * 3))
            if timer <= 0 || to.length < 0.2 {
                state = .cruise
                timer = rnd(4, 10)
            }
        case .investigate:
            // Come up under the fingertip and hang there, nosing at it.
            let f = lake.finger
            if !f.inWater || !cursor.present || cursor.stillTime < 0.4 {
                state = .cruise
                timer = rnd(3, 8)
                break
            }
            let goal = V3(f.point.x, -0.22, f.point.z)
            let to = goal - pos
            let d = to.length
            want = clamp(d * 0.35, 0.03, 0.35)
            if d > 0.15 {
                heading = lerpAngle(heading, atan2(-to.z, to.x), min(1, dt * 2))
                pitch = lerp(pitch, clamp(atan2(to.y, hypot(to.x, to.z)), -0.7, 0.7), min(1, dt * 2))
            } else {
                pitch = lerp(pitch, 0.15, dt * 2)
                // Now and then a nudge at the surface: a tiny ring under the finger.
                if Float.random(in: 0..<1) < dt * 0.25 { lake.disturb(goal.x, goal.z, radius: 0.1, amount: -0.004, ring: 0.2) }
            }
            if timer <= 0 {
                state = .dive
                timer = 2
                target = pos + V3(rnd(-2, 2), -0.8, rnd(-2, 2))
            }
        case .flee:
            want = 0
            burst = max(0, burst - dt * 1.2)
            if timer <= 0 {
                state = .cruise
                timer = rnd(4, 10)
            }
        }

        // Steering toward the wanted speed along the heading (fish accelerate gently, brake with drag).
        let fwd = forward()
        if state != .flee {
            acc += (fwd * want - vel) * (state == .rise ? 2.5 : 1.2)
        } else {
            acc += vel * -1.8
        }
        // Stay in the shallows and off the bed, and in the frame.
        let bed = -bedDepth(min(pos.z, -0.01))
        let lo = bed + 0.35, hi: Float = -0.25
        if pos.y < lo { acc.y += (lo - pos.y) * 3 }
        if pos.y > hi && state != .rise && state != .investigate { acc.y -= (pos.y - hi) * 3 }
        if pos.z > bounds.near { acc.z -= (pos.z - bounds.near) * 1.5 }
        if pos.z < bounds.far { acc.z += (bounds.far - pos.z) * 1.5 }
        let hw = bounds.halfWidth(-pos.z) * 0.9
        if abs(pos.x) > hw { acc.x -= (pos.x - (pos.x > 0 ? hw : -hw)) * 1.5 }
        // Turn the heading toward where the walls are pushing, so the fish swims rather than slides.
        if acc.x != 0 || acc.z != 0 {
            let wallMag = hypot(acc.x, acc.z)
            if wallMag > 0.05 && state != .flee { heading = lerpAngle(heading, atan2(-acc.z, acc.x), min(1, dt * wallMag * 0.4)) }
        }
        vel += acc * dt
        let sp = vel.length
        if sp > 2.2 { vel *= 2.2 / sp }
        pos += vel * dt
        pos.y = min(pos.y, -0.02)

        // Orientation follows the velocity when moving, with a slow return of pitch and roll.
        let steered = state == .investigate || state == .rise || state == .dive
        if sp > 0.08 && !steered {
            heading = lerpAngle(heading, atan2(-vel.z, vel.x), min(1, dt * (state == .flee ? 8 : 2)))
            pitch = lerp(pitch, clamp(atan2(vel.y, hypot(vel.x, vel.z)), -0.6, 0.6), min(1, dt * 2))
        } else if !steered {
            pitch = lerp(pitch, 0, min(1, dt))
        }
        roll = lerp(roll, 0, min(1, dt * 1.5))

        // Tail: beats faster and wider the harder the fish works, barely at all when holding.
        let effort = clamp(sp / 0.6, 0.08, 1) + burst * 1.5
        phase = (phase + dt * TAU * (0.9 + 2.2 * effort)).truncatingRemainder(dividingBy: TAU)
        amp = 0.012 + 0.05 * clamp(effort, 0, 1.4)
        // Turning bends the body into the turn.
        let turnRate = dt > 1e-4 ? angleDiff(heading, headingBefore) / dt : 0
        turn = lerp(turn, clamp(turnRate * 0.25, -0.3, 0.3), min(1, dt * 3))
        // Fish are dimmer and bluer the deeper they swim; the water shader handles the view path,
        // this handles the light reaching them from above.
        let dim = exp(-(-pos.y) * 0.22)
        tint = V3(lerp(0.55, 1, dim), lerp(0.75, 1, dim), 1)
    }

    private var model: simd_float4x4 {
        compose(pos, quatAxis(heading, 0, 1, 0) * quatAxis(pitch, 0, 0, 1) * quatAxis(roll, 1, 0, 0), V3(repeating: length))
    }

    func params(fin: Bool) -> StdParams {
        let sp = species[speciesName]!
        var p = fin
            ? StdParams(model: model, color: V3(1, 1, 1), opacity: 0.9, roughness: 0.6, metalness: 0.05, flags: [.map, .doubleSided, .clampMap])
            : StdParams(model: model, color: tint, roughness: sp.rough, metalness: sp.metal, flags: [.map, .clampMap])
        p.swim = V4(phase, amp, turn, 1)
        return p
    }
}

// MARK: - The shoal

/// The trout in the shallows.
final class Shoal {
    private unowned let lake: Lake
    private(set) var fish: [Trout] = []
    private var investigateTimer: Float = 0

    init(lake: Lake, count: Int) {
        self.lake = lake
        setCount(count)
    }

    func setCount(_ n: Int) {
        while fish.count > n { fish.removeLast() }
        while fish.count < n {
            let f = Trout(species: ["rainbow", "rainbow", "brook", "brown"].randomElement()!)
            let b = lake.fishBounds
            let z = rnd(b.far * 0.9, b.near - 1)
            let x = rnd(-0.8, 0.8) * b.halfWidth(-z)
            f.pos = V3(x, -rnd(0.3, max(0.4, bedDepth(z) - 0.5)), z)
            f.vel = f.forward() * 0.2
            fish.append(f)
        }
    }

    func update(dt: Float) {
        // A resting fingertip in the water draws the nearest fish or two to investigate.
        let c = lake.cursor, f = lake.finger
        investigateTimer -= dt
        if c.present && c.stillTime > 1.5 && f.inWater && investigateTimer <= 0 {
            investigateTimer = 4
            let sorted = fish.filter { $0.state == .cruise || $0.state == .hold }
                .map { ($0, $0.pos.distance(to: f.point)) }.sorted { $0.1 < $1.1 }
            let already = fish.filter { $0.state == .investigate }.count
            for i in 0..<max(0, min(2 - already, sorted.count)) where sorted[i].1 < 14 {
                sorted[i].0.state = .investigate
                sorted[i].0.timer = rnd(10, 25)
            }
        }
        for t in fish { t.update(dt: dt, lake: lake) }
        // Keep the fish from swimming through one another.
        for i in fish.indices {
            for j in (i + 1)..<fish.count {
                let a = fish[i], b = fish[j]
                let d = a.pos.distance(to: b.pos), minD = (a.length + b.length) * 0.6
                if d < minD && d > 1e-3 {
                    let push = (a.pos - b.pos) * ((minD - d) / d * 0.5)
                    a.pos += push * 0.5
                    b.pos -= push * 0.5
                }
            }
        }
    }

    func drawShadow(_ e: MTLRenderCommandEncoder) {
        let parts = TroutParts.shared
        for t in fish {
            Std.drawShadow(e, parts.body, t.params(fin: false), vertex: "troutShadowVertex")
            Std.drawShadow(e, parts.fins, t.params(fin: true), vertex: "troutShadowVertex")
        }
    }

    func drawBodies(_ ctx: DrawContext) {
        guard ctx.pass == .refraction else { return }
        let parts = TroutParts.shared
        Std.begin(ctx, vertex: "troutVertex")
        for t in fish { Std.draw(ctx, parts.body, t.params(fin: false), map: parts.textures(t.speciesName).skin) }
    }

    /// The translucent fins, after everything opaque under the water.
    func drawFins(_ ctx: DrawContext) {
        guard ctx.pass == .refraction else { return }
        let parts = TroutParts.shared
        Std.begin(ctx, vertex: "troutVertex", blend: .alpha)
        for t in fish { Std.draw(ctx, parts.fins, t.params(fin: true), map: parts.textures(t.speciesName).fin) }
    }
}
