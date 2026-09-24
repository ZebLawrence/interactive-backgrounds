import SceneKit
import simd

/// An optional predator. It lurks in the haze at the back of the tank, now and then swims into the
/// scene to catch a fish, then retreats into the shadows again. Fish near a hunting shark scatter.
final class Shark {
    enum State {
        case lurking(until: Float)
        case hunting(target: Fish, since: Float)
        case retreating
    }

    let body: Fish
    private(set) var state: State
    private var clock: Float = 0
    private var patrol: V3
    private var biteTimer: Float = 0
    /// For testing: start hunting almost immediately.
    static var huntSoon = false

    init(tank: Tank) {
        body = Fish(species: .shark, at: V3(0, 0, 0))
        body.node.simdScale = V3(repeating: 1)
        patrol = .zero
        state = .lurking(until: Shark.huntSoon ? 2 : rnd(15...40))
        patrol = lurkPoint(tank)
        body.pos = lurkPoint(tank)
        body.node.opacity = 0
        body.node.runAction(.fadeIn(duration: 2))
    }

    var pos: V3 { body.pos }

    // MARK: - Behaviour

    func update(dt: Float, tank: Tank) {
        clock += dt
        let sp = body.species
        let cruise = Float(sp.cruise) * Fish.speedUnit
        var desired = V3.zero
        var speed = cruise
        var excitement: Float = 0
        // How wide the mouth should be, and how fast it gets there.
        var gape: Float = 0
        var jawRate: Float = 3

        switch state {
        case .lurking(let until):
            // Slow patrols around the hazy region behind the tank.
            speed = cruise * 1.6
            if simd_distance(pos, patrol) < 1.5 { patrol = lurkPoint(tank) }
            desired = (patrol - pos).normalized * speed
            if clock > until, let prey = pickPrey(tank) {
                state = .hunting(target: prey, since: clock)
            }

        case .hunting(let prey, let since):
            guard tank.fish.contains(where: { $0 === prey }), clock - since < 10 else {
                state = .retreating
                break
            }
            // Aim a little ahead of the prey; charge in from the dark, then lunge from close range.
            let lead = prey.pos + prey.vel * 0.35
            let d = simd_distance(body.nose, prey.pos)
            let close = body.model.length * 0.7
            speed = d > close ? 5.5 : 9
            excitement = d > close ? 0.7 : 1
            desired = (lead - pos).normalized * speed
            // Jaws part as it closes in, and gape wide for the final lunge.
            gape = d > close * 1.6 ? 0.15 : 1
            jawRate = 6
            if d < 0.3 + prey.model.length * prey.size * 0.5 {
                tank.eaten(prey)
                state = .retreating
                patrol = lurkPoint(tank)
                biteTimer = 0.5
            }

        case .retreating:
            // Back into the dark quickly, easing off as it disappears into the murk.
            speed = pos.z > -tank.depth - 6 ? 4.5 : 2
            excitement = 0.5
            desired = (patrol - pos).normalized * speed
            if pos.z < -tank.depth - 10 || simd_distance(pos, patrol) < 2 {
                state = .lurking(until: clock + rnd(30...110))
            }
        }

        if biteTimer > 0 {
            biteTimer -= dt
            gape = 0
            jawRate = 18
        }
        body.mouthOpen += (gape - body.mouthOpen) * min(1, dt * jawRate)

        // Steer around the reef.
        for o in tank.obstacles {
            let dv = pos - o.center
            let d = dv.length
            let r = o.radius + body.model.length * 0.4 + 0.3
            if d < r && d > 0.0001 { desired += dv.normalized * ((1 - d / r) * speed * 2) }
        }

        // Soft walls: turn back well before reaching the edge of its space.
        let b = roamBounds(tank, x: pos.x, z: pos.z)
        let m: Float = 1.5, push = max(speed, cruise * 2) * 1.5
        if pos.x < b.minX + m { desired.x += (b.minX + m - pos.x) / m * push }
        if pos.x > b.maxX - m { desired.x -= (pos.x - (b.maxX - m)) / m * push }
        if pos.y < b.minY + m * 0.5 { desired.y += (b.minY + m * 0.5 - pos.y) / (m * 0.5) * push }
        if pos.y > b.maxY - m * 0.5 { desired.y -= (pos.y - (b.maxY - m * 0.5)) / (m * 0.5) * push }
        if pos.z < b.minZ + m { desired.z += (b.minZ + m - pos.z) / m * push }
        if pos.z > b.maxZ - m { desired.z -= (pos.z - (b.maxZ - m)) / m * push }
        body.move(desired: desired, dt: dt, cruise: cruise, maxSpeed: speed, agility: 1.2 + 3.5 * excitement,
                  maxClimb: speed * 0.5, excitement: excitement, lookAt: nil, bounds: b, tank: tank)
    }

    /// How a fish should react to the shark: flee direction and fear, or nil if it's not a threat.
    func threat(to fish: Fish) -> (away: V3, intensity: Float)? {
        let hunting: Bool
        let isPrey: Bool
        switch state {
        case .hunting(let prey, _): hunting = true; isPrey = prey === fish
        default: hunting = false; isPrey = false
        }
        // Scaled to the shark's size (these suit a ~3-unit-long shark).
        let reach = body.model.length / 3
        let radius: Float = (isPrey ? 4 : (hunting ? 3 : 1.6)) * reach
        let dv = fish.pos - pos
        let d = dv.length
        guard d < radius else { return nil }
        // Away from the shark and out of its path.
        let side = simd_cross(body.vel.normalized, V3(0, 1, 0))
        let away = (dv.normalized + side * (simd_dot(dv, side) >= 0 ? 0.7 : -0.7)).normalized
        return (away, min(1, (1 - d / radius) * (hunting ? 1.3 : 0.5)))
    }

    // MARK: - Helpers

    /// The space the shark may occupy at depth z, allowing for its size: inside what the camera can
    /// see, above the floor, from far back in the haze to a little behind the front of the tank.
    private func roamBounds(_ tank: Tank, x: Float, z: Float) -> Tank.Bounds {
        let len = body.model.length
        let hw = tank.halfWidth(atZ: z) - len * 0.35
        let hh = tank.halfHeight(atZ: z)
        return Tank.Bounds(minX: -hw, maxX: hw,
                           minY: tank.floorHeight(x: x, z: z) + len * 0.15 + 0.4,
                           maxY: min(tank.surfaceY, hh * 0.91) - len * 0.12 - 0.3,
                           minZ: -tank.depth - 13.5, maxZ: tank.frontZ - 2)
    }

    /// Deep in the haze behind where the fish swim, just short of where the fog turns opaque
    /// (14 units back), so only a faint shape shows. Always well inside its roaming space.
    private func lurkPoint(_ tank: Tank) -> V3 {
        let z = -tank.depth - rnd(11.5...13)
        let b0 = roamBounds(tank, x: 0, z: z)
        let x = rnd((b0.minX + 1.5)...(b0.maxX - 1.5))
        let b = roamBounds(tank, x: x, z: z)
        let lo = b.minY + 0.8, hi = max(lo, b.maxY - 0.8)
        return V3(x, lo + (hi - lo) * rnd(0.2...0.8), z)
    }

    /// A fish to go after: not too close to the viewer, and never a clownfish sheltering in its anemone.
    private func pickPrey(_ tank: Tank) -> Fish? {
        let candidates = tank.fish.filter { f in
            if f.pos.z > 1.5 { return false }
            if f.species.id == Species.clownfish.id, let home = tank.anemoneTop, simd_distance(f.pos, home) < 1 {
                return false
            }
            return true
        }
        return candidates.randomElement()
    }
}
