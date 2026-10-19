import AppKit
import Metal
import simd

/// The cursor in screen points (relative to this screen, y up), with smoothed velocity, how long it
/// has rested, and whether the viewer is paying attention (moved in the last 5 s).
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

/// A gust from a fast cursor: a blob of moving air in screen space.
struct Gust {
    var x: Float, y: Float, vx: Float, vy: Float, r: Float, s: Float, s0: Float
    var wx: Float, wy: Float, wz: Float, age: Float, life: Float
}

/// An ambient gust front, rolling west to east across the clearing.
struct GustFront { var x: Float; let w: Float; let s: Float; let v: Float }

/// Where an owl can sit: a snag's broken top or a spruce's leader at the clearing's edge.
final class Perch {
    enum Kind { case snag, tip }
    let tree: TreeInstance
    let kind: Kind
    weak var owl: Owl?
    init(tree: TreeInstance, kind: Kind) { self.tree = tree; self.kind = kind }
}

/// What an owl is told about the cursor each frame: where to look (a point on the cursor's ray, or
/// the viewer if the cursor rests on the owl), whether it is being stared at, and attention.
struct OwlLook {
    var point: V3?
    var stare: Bool
    var attention: Float
}

/// A vole stirring with no owl free to hear it yet.
private struct PendingVole { let p: V3; var t: Float }

/// The light of the moment (see `Frame` in the shaders).
struct Light {
    /// 0..1: how much the moon is up (the Moonlight toggle fades it).
    var moon: Float = 1
    /// The light the aurora throws on the snow, linear RGB, and its overall level.
    var aurora = V3.zero
    var auroraLevel: Float = 0
    /// 0..1: how heavily it is snowing.
    var snowing: Float = 0
}

private let eye: Float = 1.6
private let basePitch: Float = 0.15
private let clearing = V2(0, -40)
let moonDir = V3(0.42, 0.33, -0.85).normalized
/// Unused here (the core shaders light by a sun and a moon); the sun never rises in Boreal Night.
let sunDir = V3(0, -1, 0)
private let fogColor = V3(0.004, 0.006, 0.012)
private let fogNear: Float = 40, fogFar: Float = 900

/// The scene filling one screen: a clearing in the spruce under the aurora. Lays out the forest
/// and the perches, owns the camera and the lights, turns the cursor into gusts, glances and
/// rustles, and steps every system.
///
/// Units are metres. The viewer stands at the south edge of a snowy muskeg clearing at the origin,
/// eye 1.6 m above the snow, looking north (-z) across the bog to the far tree line, with the aurora
/// over it. East is +x.
final class Boreal {
    let screenFrame: CGRect
    var screenW: Float { Float(screenFrame.width) }
    var screenH: Float { Float(screenFrame.height) }
    let fov: Float
    let aspect: Float
    /// Screen points per metre at one metre: a projected size is `size * pointScale / distance`.
    let pointScale: Float
    let near: Float = 0.15
    let far: Float = 200_000

    private(set) var cursor = Cursor()
    private(set) var clock: Double = 0
    var time: Float { Float(clock) }
    var renderTime: Float { Float(clock.truncatingRemainder(dividingBy: timeWrap)) }

    let exactHeight: HeightFn
    let height: HeightFn
    private(set) var cameraPosition: V3
    private let eyeY: Float
    private var pan = V2.zero
    private(set) var cameraTurn = simd_quatf.identity
    private var viewProj = matrix_identity_float4x4

    let sky = Sky()
    let moon = Moon()
    let meteors = Meteors()
    let aurora = Aurora()
    private(set) var light = Light()
    let snowpack: Snowpack
    let horizon: Horizon
    let forest: Forest
    let perches: [Perch]
    let snowfall: Snowfall
    let puffs = Puffs(max: 3500)
    private let owlKit = OwlKit.shared
    private let owlTraits: [OwlTraits]
    private(set) var owls: [Owl] = []
    private var pendingVoles: [PendingVole] = []

    private var gusts: [Gust] = []
    private var gustTimer: Float = 0
    private var front: GustFront?
    private var frontTimer = rnd(25, 60)
    /// The ambient wind at the tree tops (m/s in x and z).
    let wind = V2(0.6, 0.15)
    private var moonShadowMatrix = matrix_identity_float4x4

    /// For testing without a real mouse: returns a global cursor position for a given time.
    var fakeMouse: ((Float) -> CGPoint)?
    /// For testing: aim the camera at a world point with a narrow field of view (degrees).
    var look: (at: V3, fov: Float)?

    /// `--hide trees,snowpack,...`: leave parts out, to measure what a frame costs.
    static let hidden: Set<String> = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--hide"), i + 1 < a.count else { return [] }
        return Set(a[i + 1].split(separator: ",").map(String.init))
    }()

    /// `--look-owl fov`: follow the first owl with a narrow camera, for close-ups.
    static let followOwl: Float? = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--look-owl") else { return nil }
        return i + 1 < a.count ? Float(a[i + 1]) ?? 6 : 6
    }()

    init(screenFrame: CGRect, settings: Settings, fov: Float = 50) {
        self.screenFrame = screenFrame
        self.fov = fov
        aspect = Float(screenFrame.width / screenFrame.height)
        pointScale = Float(screenFrame.height) / (2 * tan(fov * .pi / 360))
        // `--seed N` lays out the same forest every time (for comparing test renders).
        let args = CommandLine.arguments
        let seed = args.firstIndex(of: "--seed").flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil }
        let rng = Seeded(seed ?? Int.random(in: 0..<1_000_000_000))

        // --- Layout ---------------------------------------------------------------------------
        let layout = Boreal.layout(rng)
        exactHeight = makeHeight(wells: layout.wells)
        height = cacheHeight(exactHeight)
        for t in layout.trees { t.y = height(t.x, t.z) - 0.05 }
        eyeY = height(0, 0) + eye
        cameraPosition = V3(0, eyeY, 0)

        // --- Ground and trees -----------------------------------------------------------------
        snowpack = Snowpack(height: height)
        horizon = Horizon(height: exactHeight)
        forest = Forest(variants: layout.variants, trees: layout.trees)
        perches = layout.perches

        // --- Snow in the air ------------------------------------------------------------------
        snowfall = Snowfall(count: 7000, ground: height)

        // --- Lights ---------------------------------------------------------------------------
        // The moon's shadow camera: 84 m square round a point 26 m out, as the web version's.
        let target = V3(0, 0, -26)
        moonShadowMatrix = simd_float4x4(orthoLeft: -42, right: 42, bottom: -42, top: 42, near: 20, far: 340)
            * simd_float4x4(lookAt: target + moonDir * 160, target: target)
        light.moon = settings.moonlight ? 1 : 0

        // --- Owls -----------------------------------------------------------------------------
        // Three individuals for the night, so adding owls brings in different birds.
        owlTraits = OwlTraits.make(rng, 3)
        bakeShadows(rng)
        setOwls(settings.owls.count)
        setCamera()
        // Start with a little settled sway so nothing is frozen on the first frame.
        for _ in 0..<30 { forest.update(dt: 1.0 / 30, time: 0, wind: { [unowned self] x, z in self.windAt(x, z) }, snowing: false) { _, _ in } }
    }

    // MARK: - Layout

    struct Layout {
        var variants: [TreeVariant] = []
        var trees: [TreeInstance] = []
        var wells: [Well] = []
        var perches: [Perch] = []
    }

    private static func layout(_ rng: Seeded) -> Layout {
        let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
        var L = Layout()
        // Tree variants: tall spruce near, a few saplings for the bog, simpler ones far off.
        // Near trees: four full white spruce and three slender black spruce.
        for i in 0..<7 { L.variants.append(buildSpruce(rng, R(8, 15), detail: 1, black: i >= 4)) }
        let saplingStart = L.variants.count
        for _ in 0..<3 { L.variants.append(buildSpruce(rng, R(1.6, 3.8), detail: 1, black: true)) }
        let midStart = L.variants.count
        for _ in 0..<4 { L.variants.append(buildSpruce(rng, R(8, 15), detail: 0.6)) }
        let farStart = L.variants.count
        for _ in 0..<4 {
            let v = buildSpruce(rng, R(8, 14), detail: 0.35)
            v.castShadow = false
            L.variants.append(v)
        }
        let snagStart = L.variants.count
        let snagDefs: [(x: Float, z: Float, h: Float)] = [
            (R(-4.2, -2.8), R(-10.5, -8.5), R(3.6, 4.3)),
            (R(5.5, 7.5), R(-19, -16), R(4.6, 5.6)),
            (R(-15, -12.5), R(-27, -23), R(5.8, 6.8)),
        ]
        for s in snagDefs { L.variants.append(buildSnag(rng, s.h)) }

        struct Taken { let x: Float, z: Float, r: Float }
        var taken: [Taken] = []
        func free(_ x: Float, _ z: Float, _ r: Float) -> Bool { taken.allSatisfy { hypot($0.x - x, $0.z - z) > r + $0.r } }
        func clearR(_ x: Float, _ z: Float) -> Float {
            let a = atan2(z - clearing.y, x - clearing.x)
            return 31 + 6 * sin(a * 2 + 1.3) + 4 * sin(a * 3 + 0.4) + 3 * Float(noise2(Double(cos(a) * 2 + 5), Double(sin(a) * 2)))
        }
        func add(_ t: TreeInstance, r: Float) {
            L.trees.append(t)
            taken.append(Taken(x: t.x, z: t.z, r: r))
        }

        // The snags first, each a perch.
        for (i, s) in snagDefs.enumerated() {
            add(TreeInstance(x: s.x, z: s.z, rot: R(0, TAU), scale: 1, variant: snagStart + i, load: 1, snag: true), r: 1.5)
        }
        // Big spruce framing the view either side of the viewer.
        let framing: [(Float, Float)] = [(-7.5, -5.5), (-11.5, -13), (-6.5, -19), (8.5, -4.5), (12, -12), (15.5, -21), (-17, -8), (19, -7)]
        for (x, z) in framing {
            let fx = x + R(-1, 1), fz = z + R(-1, 1)
            add(TreeInstance(x: fx, z: fz, rot: R(0, TAU), scale: R(0.95, 1.2), variant: Int(R(0, 4)), load: R(0.7, 1)), r: 2)
        }
        // The forest round the clearing, thinning into the bog.
        var nearCount = 0, farCount = 0
        var gz: Float = -240
        while gz < 6 {
            var gx: Float = -170
            while gx < 170 {
                defer { gx += 2.4 }
                let x = gx + R(-1, 1), z = gz + R(-1, 1)
                let dist = hypot(x, z)
                let az = atan2(x, -z)
                if z > 4 || (abs(az) > 1.3 && dist > 22) { continue }
                // Keep the view open in front of the viewer.
                if z < 2 && z > -16 && abs(x) < 4.5 + -z * 0.25 { continue }
                let dc = hypot(x - clearing.x, z - clearing.y) - clearR(x, z)
                let patch = Float(noise2(Double(x / 18 + 3), Double(z / 18 + 9)))
                if dc < 0 {
                    // Stunted black spruce dotted about the bog.
                    if rng() < 0.012 && dist > 7 && free(x, z, 1) {
                        add(TreeInstance(x: x, z: z, rot: R(0, TAU), scale: R(0.7, 1.2), variant: saplingStart + Int(R(0, 3)), load: R(0.85, 1)), r: 0.8)
                    }
                    continue
                }
                let keep = smoothstep(0, 10, dc) * (0.35 + 0.65 * patch) * (dist < 70 ? 0.6 : 0.45)
                if rng() > keep { continue }
                let isNear = dist < 70
                if isNear && nearCount > 130 { continue }
                if !isNear && farCount > 650 { continue }
                if !free(x, z, isNear ? 1.6 : 1.4) { continue }
                if isNear { nearCount += 1 } else { farCount += 1 }
                let variant = dist < 32 ? Int(R(0, 7)) : isNear ? midStart + Int(R(0, 4)) : farStart + Int(R(0, 4))
                add(TreeInstance(x: x, z: z, rot: R(0, TAU), scale: R(0.85, 1.15), variant: variant, load: R(0.55, 1)), r: isNear ? 1.6 : 1.4)
            }
            gz += 2.4
        }
        // Tree wells under the near trees.
        for t in L.trees {
            let v = L.variants[t.variant]
            if hypot(t.x, t.z) < 120 {
                L.wells.append(Well(x: t.x, z: t.z, r: max(0.6, v.maxR * t.scale * 0.85), depth: t.snag ? 0.12 : 0.22 * min(1, v.height / 6)))
            }
        }
        // Perches: the snags' broken tops and the leaders of a few spruce at the clearing's edge.
        L.perches = L.trees.filter { $0.snag }.map { Perch(tree: $0, kind: .snag) }
        let tips = L.trees.filter { t in
            !t.snag && t.variant < 7 && hypot(t.x, t.z) > 10 && hypot(t.x, t.z) < 34 && abs(atan2(t.x, -t.z)) < 0.7
        }.sorted { L.variants[$0.variant].height * $0.scale < L.variants[$1.variant].height * $1.scale }
        for t in tips.prefix(3) { L.perches.append(Perch(tree: t, kind: .tip)) }
        return L
    }

    /// Bake the moon shadows of every tree outside the shadow map (and of the far tree line) onto
    /// the snow, so the ground darkens toward the horizon the way the forest does.
    private func bakeShadows(_ rng: Seeded) {
        let m = moonShadowMatrix
        func inMap(_ p: V3) -> Bool {
            let c = m * V4(p, 1)
            return abs(c.x / c.w) < 1 && abs(c.y / c.w) < 1
        }
        var casters: [Caster] = []
        for t in forest.trees {
            let v = forest.variants[t.variant]
            let real = v.castShadow && inMap(V3(t.x, t.y, t.z)) && inMap(V3(t.x, t.y + t.height, t.z))
            if !real { casters.append(Caster(x: t.x, z: t.z, height: t.height, crownBase: t.crownBase, maxR: t.maxR)) }
        }
        // The spires of the far tree line, 260 m out.
        var a: Float = -1.4
        while a < 1.4 {
            let d = 258 + rng() * 6
            casters.append(Caster(x: sin(a) * d, z: -cos(a) * d, height: 5 + rng() * 8, crownBase: 0.5, maxR: 0.9 + rng() * 0.6))
            a += 0.006 + rng() * 0.008
        }
        snowpack.canopy = bakeCanopy(casters, moonDir: moonDir)
    }

    /// Where an owl sits on a perch, following the tree's sway.
    func perchPoint(_ perch: Perch) -> V3 {
        let t = perch.tree
        if perch.kind == .snag {
            let top = forest.variants[t.variant].top
            let c = cos(t.rot), s = sin(t.rot)
            return V3(t.x + top.x * c + top.z * s, t.y + top.y, t.z - top.x * s + top.z * c)
        }
        return forest.pointUp(t, 0.985) + V3(0, -0.12, 0)
    }

    func heightAt(_ x: Float, _ z: Float) -> Float { height(x, z) }

    // MARK: - Owls

    func setOwls(_ n: Int) {
        while owls.count > n {
            let o = owls.removeLast()
            if o.perch?.owl === o { o.perch?.owl = nil }
        }
        while owls.count < n {
            let o = Owl(kit: owlKit, traits: owlTraits[owls.count])
            // The first owl takes the nearest snag; others the free perches in order.
            guard let perch = perches.first(where: { $0.owl == nil }) else { break }
            perch.owl = o
            o.perch = perch
            o.root.position = perchPoint(perch)
            // Facing out over the clearing, roughly toward the viewer.
            o.yaw = atan2(-o.root.position.x, -o.root.position.z) + rnd(-0.5, 0.5)
            o.timer = rnd(20, 60) + Float(owls.count) * 25
            owls.append(o)
        }
    }

    private func freeOwl(_ p: V3) -> Owl? {
        var best: Owl?, bestD = Float.infinity
        for o in owls where o.state == .perch {
            let d = o.root.position.distance(to: p)
            if d < bestD { bestD = d; best = o }
        }
        return best
    }

    func selfHunt(_ owl: Owl) {
        let from = owl.root.position
        for _ in 0..<20 {
            let z = rnd(-30, -8), half = min(15, -z * 0.55)
            let x = rnd(-half, half)
            if hypot(x - from.x, z - from.z) > 24 { continue }
            if !inPrints(x, z) || !openSnow(x, z) { continue }
            owl.hunt(V3(x, height(x, z), z))
            return
        }
        relocate(owl)
    }

    func relocate(_ owl: Owl) {
        let options = perches.filter { $0.owl == nil && $0 !== owl.perch }
        guard let p = options.randomElement() else { return }
        owl.goTo(p, scene: self)
    }

    func choosePerch(_ owl: Owl, near: V3? = nil) -> Perch? {
        let ref = near ?? owl.root.position
        let options = perches.filter { $0.owl == nil || $0.owl === owl }
            .sorted { perchPoint($0).distance(to: ref) < perchPoint($1).distance(to: ref) }
        guard !options.isEmpty else { return nil }
        // Usually the nearest, sometimes the next.
        return options[chance(0.7) ? 0 : min(1, options.count - 1)]
    }

    func strike(_ owl: Owl, x: Float, z: Float, yaw: Float) {
        // The print map's heading runs from +x toward +z.
        let heading = atan2(cos(yaw), sin(yaw))
        snowpack.stampStrike(x, z, heading: heading)
        burstAt(x, height(x, z), z, strength: 1)
    }

    func burstAt(_ x: Float, _ y: Float, _ z: Float, strength: Float) { puffs.burst(x, y, z, strength: strength) }

    func inPrints(_ x: Float, _ z: Float) -> Bool {
        x > PrintMap.x0 + 1 && x < PrintMap.x0 + PrintMap.size - 1 && z > PrintMap.z0 + 1 && z < PrintMap.z0 + PrintMap.size - 1
    }

    /// Not under a tree.
    func openSnow(_ x: Float, _ z: Float) -> Bool {
        forest.trees.allSatisfy { t in hypot(t.x - x, t.z - z) > (t.snag ? 0.8 : t.maxR + 0.4) || hypot(t.x, t.z) > 60 }
    }

    // MARK: - Camera and screen

    private func setCamera() {
        if let f = Boreal.followOwl, let o = owls.first { look = (o.headWorld(), f) }
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
        if t > 600 { return nil }
        var p = origin + dir * t
        p.y = height(p.x, p.z)
        return p
    }

    // MARK: - Clicks

    /// A click on the desktop: on the near snow a vole stirs there; in the sky a surge starts on the aurora.
    func click(atScreen pt: CGPoint) {
        guard let hit = groundHit(pt), hit.distance(to: cameraPosition) <= 60, inPrints(hit.x, hit.z) else {
            let (_, dir) = ray(pt)
            if dir.y > 0.03 { aurora.flare(dir) }
            return
        }
        rustle(hit)
    }

    /// A vole stirs under the snow at `p`: the nearest owl hears it.
    func rustle(_ p: V3) {
        snowpack.stampRustle(p.x, p.z)
        puffs.burst(p.x, p.y, p.z, strength: 0.05, spread: 0.06)
        if let owl = freeOwl(p) {
            owl.hunt(p)
        } else if pendingVoles.count < 3 {
            pendingVoles.append(PendingVole(p: p, t: 8))
        }
    }

    func huntSomewhere() {
        for _ in 0..<30 {
            let z = rnd(-26, -8), half = min(14, -z * 0.5)
            let x = rnd(-half, half)
            if !inPrints(x, z) || !openSnow(x, z) { continue }
            rustle(V3(x, height(x, z), z))
            return
        }
    }

    func substorm() { aurora.substorm() }

    // MARK: - Wind

    /// The ambient wind near the tree tops at (x, z), m/s.
    func windAt(_ x: Float, _ z: Float) -> V2 {
        let t = time
        let wob = 0.7 + 0.5 * sin(t * 0.05 + x * 0.02) * sin(t * 0.031 + z * 0.03)
        var w = wind * wob
        // A passing gust front, rolling across the clearing from the west.
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
        let low = 0.35 + 0.65 * smoothstep(0, 10, y - eyeY + eye)
        var out = V3(w.x * low, 0, w.y * low)
        if !gusts.isEmpty {
            let c = viewProj * V4(x, y, z, 1)
            if c.w > 0.01 {
                let sx = (c.x / c.w * 0.5 + 0.5) * screenW, sy = (c.y / c.w * 0.5 + 0.5) * screenH
                for g in gusts {
                    let dx = sx - g.x, dy = sy - g.y
                    let d2 = dx * dx + dy * dy
                    if d2 > g.r * g.r * 4 { continue }
                    out += V3(g.wx, g.wy, g.wz) * (g.s * exp(-d2 / (g.r * g.r)))
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

        // An ambient gust front now and then, rolling west to east across the clearing.
        frontTimer -= dt
        if front == nil && frontTimer <= 0 { front = GustFront(x: -90, w: rnd(10, 22), s: rnd(1.8, 3.4), v: rnd(2.5, 4)) }
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
            for t in forest.trees {
                if t.snag || hypot(t.x, t.z) > 70 { continue }
                guard let s = project(forest.pointUp(t, 0.6)) else { continue }
                for g in gusts {
                    let dx = Float(s.x) - g.x, dy = Float(s.y) - g.y
                    let reach = g.r + 60
                    if dx * dx + dy * dy > reach * reach { continue }
                    let k = g.s * exp(-(dx * dx + dy * dy) / (reach * reach)) * dt * 2.2 / (t.height / 8).squareRoot()
                    forest.shake(t, g.wx * k, g.wz * k + g.wy * k * 0.3)
                }
            }
        }
        let snowing = settings.snowfall
        forest.update(dt: dt, time: renderTime, wind: { [unowned self] x, z in self.windAt(x, z) }, snowing: snowing) { [unowned self] t, amount in
            if hypot(t.x, t.z) > 80 { return }
            let mid = self.forest.pointUp(t, 0.55)
            self.puffs.treeShed(mid.x, mid.y, mid.z, r: t.maxR * 0.8, amount: amount, push: V2(t.vx, t.vz))
        }

        // --- Owls -------------------------------------------------------------------------------
        let hit = inside ? groundHit(c.point) : nil
        let cursorRay = inside && (c.attention > 0 || c.rest > 0.3) ? ray(c.point) : nil
        for o in owls {
            let head = o.headWorld()
            let s = project(head)
            let near = s != nil && inside ? hypot(Float(s!.x) - c.x, Float(s!.y) - c.y) : .infinity
            let stare = near < 70
            // A fast cursor sweeping past alarms it; again and again, and it leaves.
            if near < 170 && c.speed > 900 && o.state == .perch {
                o.alarm = min(2, o.alarm + dt * 3)
                if o.alarm > 1.3 && o.cooldown <= 0 {
                    let away = hit ?? cameraPosition
                    let options = perches.filter { $0.owl == nil }
                        .sorted { perchPoint($0).distance(to: away) > perchPoint($1).distance(to: away) }
                    if let p = options.first {
                        o.goTo(p, scene: self)
                        o.cooldown = 20
                        o.alarm = 0
                    }
                }
            }
            // A resting cursor, held a while over the snow somewhere else: it moves closer to look.
            if o.state == .perch && c.rest > 6, let hit, o.cooldown <= 0, let current = o.perch {
                let cur = perchPoint(current).distance(to: hit)
                if let best = choosePerch(o, near: hit), best !== current, perchPoint(best).distance(to: hit) < cur - 6 {
                    o.goTo(best, scene: self)
                    o.cooldown = 30
                } else {
                    o.cooldown = 3
                }
            }
            // The owl follows the cursor as if it were something moving between it and the viewer: a
            // point on the cursor's ray, short of the owl, so its face swings toward us as it watches.
            var point: V3?
            if stare {
                point = cameraPosition
            } else if let r = cursorRay {
                point = r.origin + r.dir * (head.distance(to: cameraPosition) * 0.6)
            }
            o.update(dt: dt, scene: self, look: OwlLook(point: point, stare: stare, attention: c.attention))
        }
        // Voles waiting for a free owl.
        for i in pendingVoles.indices { pendingVoles[i].t -= dt }
        pendingVoles = pendingVoles.filter { v in
            if v.t <= 0 { return false }
            if let owl = freeOwl(v.p) {
                owl.hunt(v.p)
                return false
            }
            return true
        }

        // --- Sky and light ----------------------------------------------------------------------
        light.moon = approach(light.moon, settings.moonlight ? 1 : 0, 1.2, dt)
        aurora.update(dt: dt, camera: cameraPosition)
        light.aurora = aurora.light
        light.auroraLevel = aurora.level
        meteors.update(dt: dt)

        // --- Snow -------------------------------------------------------------------------------
        let air: (Float, Float, Float) -> V3 = { [unowned self] x, y, z in self.airAt(x, y, z) }
        snowfall.update(dt: dt, air: air, snowing: snowing)
        light.snowing = snowfall.amount
        puffs.update(dt: dt, air: air, ground: height)
        snowpack.update(dt: dt, snowing: snowing)
    }

    /// What everyone is doing (the `--log` flag).
    func log() {
        print(String(format: "moon %.2f aurora %@ level %.2f, snowing %.2f, cursor (%.0f, %.0f) rest %.1f", light.moon,
                     aurora.debugDescription, light.auroraLevel, light.snowing, cursor.x, cursor.y, cursor.rest))
        if let hit = groundHit(cursor.point) { print(String(format: "cursor on the snow at (%.1f, %.1f)", hit.x, hit.z)) }
        let sway = forest.trees.map { hypot($0.sx, $0.sz) }.max() ?? 0
        print(String(format: "puffs %d, top sway %.2f m", puffs.liveCount, sway))
        for o in owls { print("owl \(o.debugDescription)") }
    }

    // MARK: - Drawing

    var clearColor: MTLClearColor { MTLClearColor(red: Double(fogColor.x), green: Double(fogColor.y), blue: Double(fogColor.z), alpha: 1) }

    private func frame(viewProj: simd_float4x4, view: simd_float4x4, proj: simd_float4x4, drawableSize: V2, msaa: Bool) -> FrameUniforms {
        let L = light
        let a = L.aurora, m = L.moon
        var f = FrameUniforms()
        f.matrix(viewProj)
        f.matrix(view)
        f.matrix(proj)
        f.matrix(moonShadowMatrix)       // shadow0: unused (no sun)
        f.matrix(moonShadowMatrix)       // shadow1: the moon's
        f.vec(V4(cameraPosition, 0))
        f.vec(V4(renderTime, m, L.auroraLevel, L.snowing))
        f.vec(V4(wind.x, wind.y, 0, 0))
        f.vec(V4(sunDir, 0))
        f.vec(V4(moonDir, 0))
        f.vec(V4(moonDir, 0))
        f.vec(V4(0, 0, 0, 0))                                                   // no sun
        f.vec(V4(V3(0.72, 0.8, 1.0) * (1.15 * m), m > 0.01 ? 1 : 0))            // the moon
        // The hemisphere light: a dark blue sky lit green by the aurora; moonlit snow throws a lot of
        // light back up, filling the undersides of the boughs and the owl's face.
        f.vec(V4(0.035 + a.x * 0.8, 0.05 + a.y * 0.8, 0.11 + a.z * 0.8, 0))
        f.vec(V4(0.03 + 0.1 * m + a.x * 0.8, 0.035 + 0.115 * m + a.y * 0.8, 0.05 + 0.16 * m + a.z * 0.8, 0))
        f.vec(V4(a, 0))
        f.vec(V4(fogColor, 0))
        f.vec(V4(fogNear, fogFar, 0, 0))
        // Point sprites are sized in drawable pixels.
        let scale = pointScale * drawableSize.y / screenH * (fov / currentFov)
        f.vec(V4(drawableSize.x, drawableSize.y, scale, msaa ? 1 : 0))
        return f
    }

    /// Write this frame's shared uniforms for the camera and the moon's shadow pass. Returns which
    /// key lights are up (only ever the moon).
    func writeFrames(main: MTLBuffer, sun: MTLBuffer, moon: MTLBuffer, drawableSize: V2, msaa: Bool) -> (sun: Bool, moon: Bool) {
        let proj = projection, view = self.view
        frame(viewProj: proj * view, view: view, proj: proj, drawableSize: drawableSize, msaa: msaa).copy(into: main)
        frame(viewProj: moonShadowMatrix, view: view, proj: proj, drawableSize: drawableSize, msaa: msaa).copy(into: moon)
        return (false, light.moon > 0.01)
    }

    /// Draw one pass: in a shadow pass only what casts shadows; in the main pass the opaque parts,
    /// then the sky, then everything that blends.
    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        e.setCullMode(.none)
        e.setFrontFacing(.counterClockwise)
        let H = Boreal.hidden
        if !H.contains("trees") { forest.draw(ctx) }
        if !H.contains("owls") { for o in owls { o.draw(ctx) } }
        if ctx.isShadow { return }
        if !H.contains("snowpack") { snowpack.draw(ctx) }
        horizon.draw(ctx)
        // The sky after everything opaque, so only the sky that shows is shaded.
        sky.draw(ctx)
        moon.draw(ctx, moon: light.moon)
        // Then what blends: the aurora, shooting stars, the snow in the air.
        if !H.contains("aurora") { aurora.draw(ctx) }
        meteors.draw(ctx, camera: cameraPosition)
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
