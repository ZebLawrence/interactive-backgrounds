import AppKit
import Metal
import simd

/// The cursor in screen points (relative to this grove's screen, y up), with smoothed velocity,
/// how long it has rested, and whether the viewer is paying attention (moved in the last 5 s).
struct Cursor {
    var x: Float = 0, y: Float = 0
    var vx: Float = 0, vy: Float = 0
    var speed: Float = 0
    var rest: Float = 0
    var last: CGPoint?
    var attention: Float = 0
    var lastMove: Float = -100
    var inside = false
    var point: CGPoint { CGPoint(x: CGFloat(x), y: CGFloat(y)) }
}

/// What the creatures need to know about the cursor this frame.
struct CursorInfo {
    /// The cursor is over this screen.
    let inside: Bool
    /// Where it meets the snow, if it does.
    let hit: V3?
    /// Seconds it has rested.
    let rest: Float
    /// Points per second.
    let speed: Float
    /// 1 if it moved in the last five seconds.
    let attention: Float
    /// In screen points, y up.
    let x: Float
    let y: Float
    /// The hare nearest the cursor's spot on the snow: the one that comes to look.
    let nearestHare: Hare?
}

/// A gust from a fast cursor: a blob of moving air in screen space.
struct Gust {
    var x: Float, y: Float, vx: Float, vy: Float, r: Float, s: Float, s0: Float
    var wx: Float, wy: Float, wz: Float, age: Float, life: Float
}

/// An ambient gust front, rolling west to east through the crowns.
struct GustFront { var x: Float; let w: Float; let s: Float; let v: Float }

private let eye: Float = 1.6
private let basePitch: Float = -0.03

/// Toward the sun (low in the south-west, behind the grove's left) and toward the moon.
let sunDir = V3(-0.52, 0.36, -0.78).normalized
let moonDir = V3(0.46, 0.5, -0.73).normalized

/// The grove filling one screen: a quaking-aspen grove in falling snow. Lays out the grove and what
/// lives in it, owns the camera, the lights and the weather, turns the cursor into gusts, glances
/// and clicks, and steps every system.
///
/// Units are metres. The viewer stands among the trunks at the origin, eye 1.6 m above the snow,
/// looking north (-z) into the grove. East is +x.
final class Aspen {
    let screenFrame: CGRect
    var screenW: Float { Float(screenFrame.width) }
    var screenH: Float { Float(screenFrame.height) }
    let fov: Float
    let aspect: Float
    /// Screen points per metre at one metre: a projected size is `size * pointScale / distance`.
    let pointScale: Float
    let near: Float = 0.15
    let far: Float = 20000

    private(set) var cursor = Cursor()
    /// Seconds since the grove was made.
    private(set) var clock: Double = 0
    var time: Float { Float(clock) }
    /// Shaders see time modulo `timeWrap`.
    var renderTime: Float { Float(clock.truncatingRemainder(dividingBy: timeWrap)) }

    let exactHeight: HeightFn
    /// The snow's surface height at (x, z), cached on a grid over the near ground.
    let height: HeightFn
    private(set) var cameraPosition: V3
    private var pan = V2.zero
    private(set) var cameraTurn = simd_quatf.identity
    private var viewProj = matrix_identity_float4x4

    let sky = Sky()
    let moon = Moon()
    let weather = Weather()
    var light = Light()
    let snowpack: Snowpack
    let horizon: Horizon
    let tufts: Tufts
    let grove: Grove
    let suckers: Grove
    let sticks: Grove
    let snowfall: Snowfall
    let puffs = Puffs(max: 3500)
    private let hareKit = HareKit.shared
    private let hareTraits: [HareTraits]
    private(set) var hares: [Hare] = []
    private(set) var grouse: Grouse!

    private var gusts: [Gust] = []
    private var gustTimer: Float = 0
    private var front: GustFront?
    private var frontTimer = rnd(20, 50)
    /// The ambient wind at the crowns (m/s in x and z).
    private(set) var wind = V2(0.5, 0.1)

    private var sunShadowMatrix = matrix_identity_float4x4
    private var moonShadowMatrix = matrix_identity_float4x4

    /// `--hide trees,snowpack,...`: leave parts out, to measure what a frame costs.
    static let hidden: Set<String> = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--hide"), i + 1 < a.count else { return [] }
        return Set(a[i + 1].split(separator: ",").map(String.init))
    }()

    static let follow: (what: String, fov: Float)? = {
        let a = CommandLine.arguments
        for what in ["hare", "grouse"] {
            if let i = a.firstIndex(of: "--look-\(what)") {
                return (what, i + 1 < a.count ? Float(a[i + 1]) ?? 8 : 8)
            }
        }
        return nil
    }()

    /// For testing without a real mouse: returns a global cursor position for a given time.
    var fakeMouse: ((Float) -> CGPoint)?
    /// For testing: aim the camera at a world point with a narrow field of view (degrees).
    var look: (at: V3, fov: Float)?

    init(screenFrame: CGRect, settings: Settings, fov: Float = 50) {
        self.screenFrame = screenFrame
        self.fov = fov
        aspect = Float(screenFrame.width / screenFrame.height)
        pointScale = Float(screenFrame.height) / (2 * tan(fov * .pi / 360))
        // `--seed N` lays out the same grove every time (for comparing test renders).
        let args = CommandLine.arguments
        let seed = args.firstIndex(of: "--seed").flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil }
        let rng = Seeded(seed ?? Int.random(in: 0..<1_000_000_000))

        // --- Layout ---------------------------------------------------------------------------
        var layout = Aspen.layout(rng)
        exactHeight = makeHeight(wells: layout.wells, lumps: layout.lumps, capsules: layout.capsules)
        height = cacheHeight(exactHeight)
        for i in layout.trees.indices { layout.trees[i].y = height(layout.trees[i].x, layout.trees[i].z) - 0.04 }
        for i in layout.suckers.indices { layout.suckers[i].y = height(layout.suckers[i].x, layout.suckers[i].z) - 0.02 }
        for i in layout.sticks.indices { layout.sticks[i].y = height(layout.sticks[i].x, layout.sticks[i].z) + layout.sticks[i].lift }
        for i in layout.tufts.indices { layout.tufts[i].y = height(layout.tufts[i].x, layout.tufts[i].z) }
        cameraPosition = V3(0, height(0, 0) + eye, 0)

        // --- Ground ---------------------------------------------------------------------------
        snowpack = Snowpack(height: height)
        horizon = Horizon(height: exactHeight, rng: rng)
        tufts = Tufts(layout.tufts, rng: rng)

        // --- Trees ----------------------------------------------------------------------------
        let bark = BarkTextures.shared
        grove = Grove(variants: layout.variants, trees: layout.trees, bark: bark)
        suckers = Grove(variants: layout.saplingVariants, trees: layout.suckers, bark: bark)
        sticks = Grove(variants: layout.stickVariants, trees: layout.sticks, bark: bark)

        // --- Snow in the air ------------------------------------------------------------------
        snowfall = Snowfall(count: 20000, ground: height)

        // --- Creatures ------------------------------------------------------------------------
        hareTraits = HareTraits.make(rng, 3)

        computeShadowMatrices()
        bakeShadows(layout)
        grouse = Grouse(scene: self)
        setHares(settings.hares.count)
        setCamera()
        weather.update(dt: 0, settings: settings, out: &light, snowing: 0)
        // Start with a little settled sway so nothing is frozen on the first frame.
        for _ in 0..<30 { grove.update(dt: 1.0 / 30, time: 0, wind: { [unowned self] x, z in self.windAt(x, z) }, snowing: false) { _, _, _ in } }
    }

    // MARK: - Layout

    struct Layout {
        var variants: [TreeVariant] = []
        var trees: [TreeInstance] = []
        var wells: [Well] = []
        var lumps: [Lump] = []
        var capsules: [Capsule] = []
        var saplingVariants: [TreeVariant] = []
        var suckers: [TreeInstance] = []
        var stickVariants: [TreeVariant] = []
        var sticks: [TreeInstance] = []
        var tufts: [Tuft] = []
    }

    private static func layout(_ rng: Seeded) -> Layout {
        let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
        var L = Layout()
        for _ in 0..<6 { L.variants.append(buildAspen(rng, R(16, 23), detail: 1)) }
        let midStart = L.variants.count
        for _ in 0..<4 { L.variants.append(buildAspen(rng, R(15, 22), detail: 0.6)) }
        let farStart = L.variants.count
        for _ in 0..<4 {
            let v = buildAspen(rng, R(14, 21), detail: 0.3)
            v.castShadow = false
            L.variants.append(v)
        }
        let youngStart = L.variants.count
        for _ in 0..<4 { L.variants.append(buildAspen(rng, R(3.5, 9), detail: 1, young: true)) }
        for _ in 0..<4 { L.saplingVariants.append(buildAspen(rng, R(0.5, 1.5), detail: 1, sapling: true)) }
        for _ in 0..<4 {
            let s = buildStick(rng, R(1, 3), R(0.025, 0.06))
            L.stickVariants.append(s)
        }
        let log = buildStick(rng, R(6, 9), R(0.16, 0.22))
        L.stickVariants.append(log)

        struct Taken { let x: Float, z: Float, r: Float }
        var taken: [Taken] = []
        func free(_ x: Float, _ z: Float, _ r: Float) -> Bool { taken.allSatisfy { hypot($0.x - x, $0.z - z) > r + $0.r } }
        func add(_ t: TreeInstance, r: Float) {
            L.trees.append(t)
            taken.append(Taken(x: t.x, z: t.z, r: r))
        }
        func inView(_ x: Float, _ z: Float, _ slack: Float = 0) -> Bool { abs(atan2(x, -z)) < 0.82 + slack }

        // Big trunks framing the view, close by at the sides.
        let framing: [(Float, Float)] = [(-2.4, -2.3), (3.1, -3.8), (-5.4, -7.6), (6.8, -8.5), (-1.4, -12.5), (2.6, -16)]
        for (x, z) in framing {
            let fx = x + R(-0.4, 0.4), fz = z + R(-0.6, 0.6)
            add(TreeInstance(x: fx, z: fz, rot: R(0, TAU), scale: R(1.05, 1.3), variant: Int(R(0, 6)), load: R(0.7, 1)), r: 1.4)
        }
        // The grove: a jittered grid with openings, thinning a little with distance.
        var gz: Float = -120
        while gz < 2 {
            var gx: Float = -110
            while gx < 110 {
                defer { gx += 2.3 }
                let x = gx + R(-1, 1), z = gz + R(-1, 1)
                let dist = hypot(x, z)
                if z > 1.5 { continue }
                if dist > 14 && !inView(x, z, 0.1) { continue }
                // Nothing right in the viewer's face.
                if z > -7 && abs(x) < 1.4 { continue }
                let patch = Float(noise2(Double(x / 14 + 3), Double(z / 14 + 9)))
                let keep = (0.5 + 0.5 * patch) * (dist < 30 ? 0.8 : dist < 65 ? 0.65 : 0.45)
                if rng() > keep { continue }
                // Young trees, suckers grown up, stand among the big ones.
                if dist < 70 && rng() < 0.22 && free(x, z, 0.7) {
                    add(TreeInstance(x: x, z: z, rot: R(0, TAU), scale: R(0.8, 1.2), variant: youngStart + Int(R(0, 4)), load: R(0.6, 1)), r: 0.6)
                    continue
                }
                if !free(x, z, 1.5) { continue }
                let variant = dist < 30 ? Int(R(0, 6)) : dist < 65 ? midStart + Int(R(0, 4)) : farStart + Int(R(0, 4))
                add(TreeInstance(x: x, z: z, rot: R(0, TAU), scale: R(0.85, 1.15), variant: variant, load: R(0.6, 1)), r: 1.3)
            }
            gz += 2.3
        }
        for t in L.trees {
            let v = L.variants[t.variant]
            if hypot(t.x, t.z) < 80 { L.wells.append(Well(x: t.x, z: t.z, r: v.baseR * t.scale * 5 + 0.3, depth: 0.07)) }
        }
        // Buried shrubs and logs: lumps under the snow.
        for _ in 0..<60 {
            let x = R(-45, 45), z = R(-70, 2)
            if !free(x, z, 0.8) { continue }
            L.lumps.append(Lump(x: x, z: z, r: R(0.6, 1.8), h: R(0.12, 0.4)))
        }
        // A fallen trunk, half buried, in the near ground.
        do {
            let x = R(2, 6) * (rng() < 0.5 ? 1 : -1), z = R(-9, -14), rot = R(0, TAU)
            let dx = cos(rot), dz = -sin(rot)
            let s = TreeInstance(x: x, z: z, rot: rot, scale: 1, variant: L.stickVariants.count - 1, load: 1)
            s.lift = -log.radius * 0.45
            L.sticks.append(s)
            L.capsules.append(Capsule(x: x, z: z, dx: dx, dz: dz, L: log.length, r: log.radius, h: log.radius * 0.5))
            taken.append(Taken(x: x + dx * log.length / 2, z: z + dz * log.length / 2, r: log.length / 2))
        }
        // Fallen branches poking out of the snow.
        for _ in 0..<40 {
            let x = R(-30, 30), z = R(-40, 1)
            if !inView(x, z) || !free(x, z, 0.9) { continue }
            let vi = Int(R(0, 4))
            let s = TreeInstance(x: x, z: z, rot: R(0, TAU), scale: R(0.8, 1.2), variant: vi, load: R(0.6, 1))
            s.lift = -L.stickVariants[vi].radius * 0.5
            L.sticks.append(s)
            if L.sticks.count > 16 { break }
        }
        // Aspen suckers in clumps, and dead grass everywhere.
        for _ in 0..<26 {
            let cx = R(-32, 32), cz = R(-45, -1.5)
            if !inView(cx, cz) || (cz > -6 && abs(cx) < 2) { continue }
            let n = 3 + Int(R(0, 4))
            for _ in 0..<n {
                let x = cx + R(-0.9, 0.9), z = cz + R(-0.9, 0.9)
                if !free(x, z, 0.25) { continue }
                L.suckers.append(TreeInstance(x: x, z: z, rot: R(0, TAU), scale: R(0.8, 1.3), variant: Int(R(0, 4)), load: R(0.5, 1)))
            }
        }
        for _ in 0..<1400 {
            let x = R(-40, 40), z = R(-50, 1)
            if !inView(x, z, 0.1) || (z > -4 && abs(x) < 1.2) { continue }
            if noise2(Double(x / 5 + 7), Double(z / 5 + 2)) < 0.45 { continue }
            L.tufts.append(Tuft(x: x, z: z, rot: R(0, TAU), scale: R(0.6, 1.4)))
            if L.tufts.count >= 500 { break }
        }
        return L
    }

    /// Bake the sun's shadows of every trunk outside the shadow map onto the snow, and the contact
    /// shade at the foot of every trunk and along the fallen wood.
    private func bakeShadows(_ layout: Layout) {
        let m = sunShadowMatrix
        func inMap(_ p: V3) -> Bool {
            let c = m * V4(p, 1)
            return abs(c.x / c.w) < 1 && abs(c.y / c.w) < 1
        }
        var casters: [Caster] = [], contacts: [Contact] = []
        for t in grove.trees {
            let v = grove.variants[t.variant]
            let real = v.castShadow && inMap(V3(t.x, t.y, t.z)) && inMap(V3(t.x, t.y + t.height, t.z))
            casters.append(Caster(x: t.x, z: t.z, height: real ? 0 : t.height, crownBase: t.crownBase, maxR: t.maxR, baseR: t.baseR))
            contacts.append(Contact(x: t.x, z: t.z, r: t.baseR * 3.0 + 0.25, k: 1.0))
        }
        for s in sticks.trees {
            let v = sticks.variants[s.variant]
            contacts.append(Contact(x: s.x, z: s.z, dx: cos(s.rot), dz: -sin(s.rot), L: v.length * s.scale, r: v.radius * s.scale * 2.5 + 0.08, k: 0.85))
        }
        for s in suckers.trees { contacts.append(Contact(x: s.x, z: s.z, r: 0.12, k: 0.5)) }
        for t in layout.tufts { contacts.append(Contact(x: t.x, z: t.z, r: 0.1 * t.scale, k: 0.35)) }
        snowpack.canopy = bakeCanopy(casters, sunDir: sunDir)
        snowpack.contact = bakeContact(contacts)
    }

    /// Not within a trunk, a log or a sucker clump.
    func openSnow(_ x: Float, _ z: Float, _ margin: Float = 0.4) -> Bool {
        for t in grove.trees where hypot(t.x - x, t.z - z) < t.baseR + margin { return false }
        for s in sticks.trees {
            let v = sticks.variants[s.variant]
            let dx = cos(s.rot), dz = -sin(s.rot)
            let along = clamp((x - s.x) * dx + (z - s.z) * dz, 0, v.length * s.scale)
            if hypot(x - s.x - dx * along, z - s.z - dz * along) < v.radius * s.scale + margin { return false }
        }
        return true
    }

    // MARK: - Creatures

    func setHares(_ n: Int) {
        while hares.count > n { hares.removeLast() }
        while hares.count < n {
            let h = Hare(kit: hareKit, traits: hareTraits[hares.count], scene: self)
            // Each starts somewhere in the open snow in view, sitting.
            for _ in 0..<40 {
                let z = rnd(-22, -6), half = min(10, -z * 0.5)
                let x = rnd(-half, half)
                if !openSnow(x, z, 0.8) || hares.contains(where: { hypot($0.pos.x - x, $0.pos.z - z) < 4 }) { continue }
                h.place(x, z, yaw: rnd(0, TAU))
                break
            }
            h.timer = rnd(6, 20) + Float(hares.count) * 8
            hares.append(h)
        }
    }

    // MARK: - Camera and screen

    private func setCamera() {
        // `--look-hare fov` / `--look-grouse fov`: follow a creature, for close-ups.
        if let f = Aspen.follow {
            if f.what == "hare", let h = hares.first { look = (h.pos + V3(0, 0.25, 0), f.fov) }
            if f.what == "grouse", let g = grouse { look = (g.pos, f.fov) }
        }
        if let look {
            let f = (look.at - cameraPosition).normalized
            let yaw = atan2(-f.x, -f.z), pitch = asin(clamp(f.y, -1, 1))
            cameraTurn = simd_quatf(euler: V3(pitch, yaw, 0), order: "YXZ")
        } else {
            cameraTurn = simd_quatf(euler: V3(basePitch + pan.y, pan.x, 0), order: "YXZ")
        }
        viewProj = projection * view
    }

    var currentFov: Float { look?.fov ?? fov }

    private var projection: simd_float4x4 {
        simd_float4x4(perspectiveFovY: currentFov * .pi / 180, aspect: aspect, near: near, far: far)
    }

    private var view: simd_float4x4 {
        (simd_float4x4(translation: cameraPosition) * simd_float4x4(cameraTurn)).inverse
    }

    /// Screen position (points, y up) of a world point, or nil if behind the camera.
    func project(_ p: V3) -> CGPoint? {
        let c = viewProj * V4(p, 1)
        if c.w <= 0.01 { return nil }
        return CGPoint(x: CGFloat((c.x / c.w * 0.5 + 0.5) * screenW), y: CGFloat((c.y / c.w * 0.5 + 0.5) * screenH))
    }

    /// A ray from the eye through a screen point (points, y up from the bottom).
    func ray(_ pt: CGPoint) -> (origin: V3, dir: V3) {
        let f = 1 / tan(currentFov * .pi / 360)
        let nx = (Float(pt.x) / screenW * 2 - 1) * aspect / f, ny = (Float(pt.y) / screenH * 2 - 1) / f
        return (cameraPosition, cameraTurn.act(V3(nx, ny, -1)).normalized)
    }

    /// Where a screen point meets the snow, or nil for the sky.
    func groundHit(_ pt: CGPoint) -> V3? {
        let (origin, dir) = ray(pt)
        if dir.y > -0.002 { return nil }
        var t = origin.y / -dir.y
        for _ in 0..<4 {
            let p = origin + dir * t
            t = (origin.y - height(p.x, p.z)) / -dir.y
        }
        if t > 400 { return nil }
        var p = origin + dir * t
        p.y = height(p.x, p.z)
        return p
    }

    /// The nearest trunk under a screen point, within 45 m, or nil.
    func trunkHit(_ pt: CGPoint) -> TreeInstance? {
        var best: TreeInstance?, bestD = Float.infinity
        let px = Float(pt.x), py = Float(pt.y)
        for t in grove.trees {
            let dist = hypot(t.x, t.z)
            if dist > 45 { continue }
            guard let b = project(grove.pointUp(t, 0)), let u = project(grove.pointUp(t, 0.98)) else { continue }
            // Distance from the point to the trunk's screen segment, against its screen width.
            let dx = Float(u.x - b.x), dy = Float(u.y - b.y), len2 = dx * dx + dy * dy
            let s = len2 > 0 ? clamp(((px - Float(b.x)) * dx + (py - Float(b.y)) * dy) / len2, 0, 1) : 0
            let qx = Float(b.x) + dx * s, qy = Float(b.y) + dy * s
            let width = t.baseR * (1 - s * 0.7) * pointScale / dist
            let d = hypot(px - qx, py - qy)
            if d < width + 8 && dist < bestD { bestD = dist; best = t }
        }
        return best
    }

    // MARK: - Clicks

    /// A click on the desktop: a trunk shivers and drops its snow; the snow flushes the grouse.
    func click(atScreen pt: CGPoint) {
        if let tree = trunkHit(pt) {
            grove.strike(tree)
            startle(grove.pointUp(tree, 0), 1)
            return
        }
        guard let hit = groundHit(pt), hit.distance(to: cameraPosition) <= 60 else { return }
        if snowpack.inMap(hit.x, hit.z) {
            flushAt(hit)
        } else {
            puffs.burst(hit.x, hit.y, hit.z, strength: 0.08, spread: 0.1)
            startle(hit, 0.6)
        }
    }

    /// The grouse bursts out of the snow at `p` (if it is roosting; otherwise a puff and a start).
    func flushAt(_ p0: V3) {
        var p = p0
        // A click right against a trunk or a log flushes from the open snow beside it.
        if !openSnow(p.x, p.z, 0.6) {
            var r: Float = 0.5
            search: while r <= 1.5 {
                var a: Float = 0
                while a < TAU {
                    let q = V3(p.x + cos(a) * r, 0, p.z + sin(a) * r)
                    if openSnow(q.x, q.z, 0.6) {
                        p = V3(q.x, height(q.x, q.z), q.z)
                        break search
                    }
                    a += TAU / 8
                }
                r += 0.5
            }
        }
        if grouse.flush(p) {
            startle(p, 1.2)
            return
        }
        puffs.burst(p.x, p.y, p.z, strength: 0.12, spread: 0.15)
        startle(p, 0.6)
    }

    func flushSomewhere() {
        for _ in 0..<40 {
            let z = rnd(-24, -7), half = min(12, -z * 0.5)
            let x = rnd(-half, half)
            if !openSnow(x, z, 0.8) { continue }
            flushAt(V3(x, height(x, z), z))
            return
        }
    }

    /// Something sudden at `p`: the hares nearby react.
    func startle(_ p: V3, _ strength: Float) {
        for h in hares { h.startle(p, strength) }
        // A perched grouse flies off when something happens close by (the web version tells only the hares).
        grouse?.startle(p, strength)
    }

    // MARK: - Wind

    /// The ambient wind at the crowns at (x, z), m/s.
    func windAt(_ x: Float, _ z: Float) -> V2 {
        let t = time
        let wob = 0.7 + 0.5 * sin(t * 0.05 + x * 0.02) * sin(t * 0.031 + z * 0.03)
        var w = wind * wob
        // A passing gust front, rolling across the grove from the west.
        if let f = front {
            let d = x - f.x
            let k = exp(-(d * d) / (f.w * f.w)) * f.s
            w.x += k
            w.y += k * 0.2
        }
        return w
    }

    /// The air's velocity at a point, including the cursor's gusts (for snow in the air).
    func airAt(_ x: Float, _ y: Float, _ z: Float) -> V3 {
        let w = windAt(x, z)
        // Among the trunks the air is calm; the wind is up in the crowns.
        let low = 0.25 + 0.75 * smoothstep(2, 14, y - cameraPosition.y + eye)
        var out = V3(w.x * low, 0, w.y * low)
        if !gusts.isEmpty {
            let c = viewProj * V4(x, y, z, 1)
            if c.w > 0.01 {
                let sx = (c.x / c.w * 0.5 + 0.5) * screenW, sy = (c.y / c.w * 0.5 + 0.5) * screenH
                for g in gusts {
                    let dx = sx - g.x, dy = sy - g.y
                    let d2 = dx * dx + dy * dy
                    if d2 > g.r * g.r * 4 { continue }
                    let k = g.s * exp(-d2 / (g.r * g.r))
                    out += V3(g.wx, g.wy, g.wz) * k
                }
            }
        }
        return out
    }

    // MARK: - Frame

    func step(dt: Float, settings: Settings) {
        clock += Double(dt)
        let global = fakeMouse?(Float(clock)) ?? NSEvent.mouseLocation
        let inside = screenFrame.contains(global)
        let pointer = CGPoint(x: global.x - screenFrame.minX, y: global.y - screenFrame.minY)
        var c = cursor

        // --- The cursor: speed, rest, attention ------------------------------------------------
        if inside {
            if let last = c.last {
                let dx = Float(pointer.x - last.x), dy = Float(pointer.y - last.y)
                let k = 1 - exp(-dt / 0.08)
                c.vx += ((dt > 0 ? dx / dt : 0) - c.vx) * k
                c.vy += ((dt > 0 ? dy / dt : 0) - c.vy) * k
                if hypot(dx, dy) > 1.5 { c.lastMove = time }
            }
            c.last = pointer
            c.x = Float(pointer.x)
            c.y = Float(pointer.y)
        } else {
            c.last = nil
            c.vx *= 0.8
            c.vy *= 0.8
        }
        c.inside = inside
        c.speed = hypot(c.vx, c.vy)
        c.rest = inside && c.speed < 40 ? c.rest + dt : 0
        c.attention = inside && time - c.lastMove < 5 ? 1 : 0
        cursor = c

        // Pan the view a touch toward the cursor's side of the screen.
        let nx = inside ? clamp(c.x / screenW * 2 - 1, -1, 1) : 0
        let ny = inside ? clamp(c.y / screenH * 2 - 1, -1, 1) : 0
        pan.x = approach(pan.x, -nx * 0.035, 2.5, dt)
        pan.y = approach(pan.y, ny * 0.018, 2.5, dt)
        setCamera()

        // --- Gusts from a fast cursor ---------------------------------------------------------
        gustTimer -= dt
        if inside && c.speed > 700 && gustTimer <= 0 {
            gustTimer = 0.05
            let right = cameraTurn.act(V3(1, 0, 0))
            var fwd = cameraTurn.act(V3(0, 0, -1))
            fwd.y = 0
            fwd = fwd.normalized
            let sp = min(c.speed / 260, 5)
            let dir = (right * (c.vx / c.speed) + V3(0, 1, 0) * (c.vy / c.speed * 0.6) + fwd * 0.35).normalized
            gusts.append(Gust(x: c.x, y: c.y, vx: c.vx * 0.3, vy: c.vy * 0.3, r: 150, s: sp, s0: sp,
                              wx: dir.x, wy: dir.y, wz: dir.z, age: 0, life: 1.6))
            if gusts.count > 40 { gusts.removeFirst() }
        }
        for i in gusts.indices {
            gusts[i].age += dt
            gusts[i].x += gusts[i].vx * dt
            gusts[i].y += gusts[i].vy * dt
            gusts[i].vx *= exp(-dt * 2)
            gusts[i].vy *= exp(-dt * 2)
            gusts[i].r += 60 * dt
            gusts[i].s = gusts[i].s0 * (1 - smoothstep(0.2, gusts[i].life, gusts[i].age))
        }
        gusts.removeAll { $0.age >= $0.life }

        // An ambient gust front now and then, rolling west to east through the crowns.
        frontTimer -= dt
        if front == nil && frontTimer <= 0 { front = GustFront(x: -90, w: rnd(10, 22), s: rnd(1.6, 3.2), v: rnd(2.5, 4)) }
        if var f = front {
            f.x += f.v * dt
            if f.x > 90 {
                front = nil
                frontTimer = rnd(30, 90)
            } else {
                front = f
            }
        }

        // --- Trees: the cursor's gusts shake them ---------------------------------------------
        if !gusts.isEmpty {
            for t in grove.trees {
                if hypot(t.x, t.z) > 60 { continue }
                guard let s = project(grove.pointUp(t, 0.7)) else { continue }
                for g in gusts {
                    let dx = Float(s.x) - g.x, dy = Float(s.y) - g.y
                    let reach = g.r + 60
                    if dx * dx + dy * dy > reach * reach { continue }
                    let k = g.s * exp(-(dx * dx + dy * dy) / (reach * reach)) * dt * 0.3 / (t.height / 12).squareRoot()
                    grove.shake(t, g.wx * k, g.wz * k + g.wy * k * 0.3)
                }
            }
        }
        let snowing = settings.snowfall
        let windFn: (Float, Float) -> V2 = { [unowned self] x, z in self.windAt(x, z) }
        grove.update(dt: dt, time: renderTime, wind: windFn, snowing: snowing) { [unowned self] t, amount, f in
            if hypot(t.x, t.z) > 80 { return }
            let p = self.grove.pointUp(t, f)
            self.puffs.treeShed(p.x, p.y, p.z, r: t.maxR * 0.7, amount: amount, push: V2(t.vx, t.vz))
        }
        suckers.update(dt: dt, time: renderTime, wind: windFn, snowing: snowing) { _, _, _ in }
        sticks.update(dt: dt, time: renderTime, wind: { _, _ in .zero }, snowing: snowing) { _, _, _ in }

        // --- Creatures ------------------------------------------------------------------------
        let hit = inside ? groundHit(c.point) : nil
        // The hare nearest the cursor's spot is the one that comes to look; the others watch.
        var nearest: Hare?, nd = Float.infinity
        if let hit {
            for h in hares {
                let d = hypot(h.pos.x - hit.x, h.pos.z - hit.z)
                if d < nd { nd = d; nearest = h }
            }
        }
        let info = CursorInfo(inside: inside, hit: hit, rest: c.rest, speed: c.speed, attention: c.attention, x: c.x, y: c.y, nearestHare: nearest)
        for h in hares { h.update(dt: dt, scene: self, info: info) }
        grouse.update(dt: dt, scene: self, info: info)

        // --- Sky and light --------------------------------------------------------------------
        weather.update(dt: dt, settings: settings, out: &light, snowing: snowfall.amount)

        // --- Snow -----------------------------------------------------------------------------
        let air: (Float, Float, Float) -> V3 = { [unowned self] x, y, z in self.airAt(x, y, z) }
        snowfall.update(dt: dt, air: air, snowing: snowing)
        puffs.update(dt: dt, air: air, ground: height)
        snowpack.update(dt: dt, snowing: snowing)
    }

    /// What everyone is doing (the `--log` flag).
    func log() {
        print(String(format: "sun %.2f night %.2f snowing %.2f, cursor (%.0f, %.0f) rest %.1f", light.sun, light.night, light.snowing,
                     cursor.x, cursor.y, cursor.rest))
        if let hit = groundHit(cursor.point) { print(String(format: "cursor on the snow at (%.1f, %.1f)", hit.x, hit.z)) }
        let cascading = grove.trees.filter { $0.cascade != nil }.count
        let sway = grove.trees.map { hypot($0.sx, $0.sz) }.max() ?? 0
        let speed = grove.trees.map { hypot($0.vx, $0.vz) }.max() ?? 0
        let bare = grove.trees.filter { $0.load < $0.maxLoad - 0.05 }.count
        print(String(format: "puffs %d, trees cascading %d, shed some %d, top sway %.2f m, top speed %.2f m/s", puffs.liveCount, cascading, bare, sway, speed))
        for h in hares { print("hare \(h.debugDescription)") }
        print("grouse \(grouse!.debugDescription)")
    }

    // MARK: - Lights and drawing

    /// Each key light's shadow camera: 72 m square round a point 22 m out, as the web version's.
    private func computeShadowMatrices() {
        func matrix(_ dir: V3) -> simd_float4x4 {
            let target = V3(0, 0, -22)
            return simd_float4x4(orthoLeft: -36, right: 36, bottom: -36, top: 36, near: 20, far: 340)
                * simd_float4x4(lookAt: target + dir * 160, target: target)
        }
        sunShadowMatrix = matrix(sunDir)
        moonShadowMatrix = matrix(moonDir)
    }

    var clearColor: MTLClearColor {
        MTLClearColor(red: Double(light.fog.x), green: Double(light.fog.y), blue: Double(light.fog.z), alpha: 1)
    }

    private func frame(viewProj: simd_float4x4, view: simd_float4x4, proj: simd_float4x4, drawableSize: V2, msaa: Bool) -> FrameUniforms {
        let L = light
        var f = FrameUniforms()
        f.matrix(viewProj)
        f.matrix(view)
        f.matrix(proj)
        f.matrix(sunShadowMatrix)
        f.matrix(moonShadowMatrix)
        f.vec(V4(cameraPosition, 0))
        f.vec(V4(renderTime, L.sun, L.night, L.snowing))
        f.vec(V4(wind.x, wind.y, 0, 0))
        f.vec(V4(sunDir, 0))
        f.vec(V4(moonDir, 0))
        f.vec(V4(L.night > 0.5 ? moonDir : sunDir, 0))
        f.vec(V4(L.sunColor * L.sunI, L.sunI > 0.01 ? 1 : 0))
        f.vec(V4(L.moonColor * L.moonI, L.moonI > 0.01 ? 1 : 0))
        f.vec(V4(L.sky * L.hemi, 0))
        f.vec(V4(L.ground * L.hemi, 0))
        f.vec(V4(L.skyLight, 0))
        f.vec(V4(L.fog, 0))
        f.vec(V4(L.fogNear, L.fogFar, 0, 0))
        // Point sprites are sized in drawable pixels.
        let scale = pointScale * drawableSize.y / screenH * (fov / currentFov)
        f.vec(V4(drawableSize.x, drawableSize.y, scale, msaa ? 1 : 0))
        return f
    }

    /// Write this frame's shared uniforms for the camera and the two key lights. Returns which key
    /// lights are up (and need their shadow maps drawn).
    /// `msaa`: whether the main pass is multisampled (without it, the cut-outs that use alpha to
    /// coverage fall back to a plain cut at one half).
    func writeFrames(main: MTLBuffer, sun: MTLBuffer, moon: MTLBuffer, drawableSize: V2, msaa: Bool) -> (sun: Bool, moon: Bool) {
        let proj = projection, view = self.view
        frame(viewProj: proj * view, view: view, proj: proj, drawableSize: drawableSize, msaa: msaa).copy(into: main)
        frame(viewProj: sunShadowMatrix, view: view, proj: proj, drawableSize: drawableSize, msaa: msaa).copy(into: sun)
        frame(viewProj: moonShadowMatrix, view: view, proj: proj, drawableSize: drawableSize, msaa: msaa).copy(into: moon)
        return (light.sunI > 0.01, light.moonI > 0.01)
    }

    /// Draw one pass: in a shadow pass only what casts shadows; in the main pass the opaque parts,
    /// then the sky, then everything that blends.
    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        e.setCullMode(.none)
        e.setFrontFacing(.counterClockwise)
        let H = Aspen.hidden
        if !H.contains("trees") { grove.draw(ctx) }
        if !H.contains("suckers") { suckers.draw(ctx) }
        if !H.contains("sticks") { sticks.draw(ctx) }
        if !H.contains("tufts") { tufts.draw(ctx) }
        if !H.contains("hares") { for h in hares { h.draw(ctx) } }
        if !H.contains("grouse") { grouse.draw(ctx) }
        if ctx.isShadow { return }
        if !H.contains("snowpack") { snowpack.draw(ctx) }
        horizon.draw(ctx)
        // The sky after everything opaque, so only the sky that shows is shaded.
        sky.draw(ctx)
        moon.draw(ctx, night: light.night, sun: light.sun)
        // Then what blends: the hares' contact shadows, the snow in the air.
        for h in hares { h.drawShadowBlob(ctx) }
        if !H.contains("snow") {
            snowfall.draw(ctx, light: light)
            puffs.draw(ctx, light: light)
        }
    }
}

/// Builds the `Frame` uniform block: five matrices, then float4s, all 16-byte aligned.
struct FrameUniforms {
    static let floatCount = 16 * 5 + 4 * 14
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
