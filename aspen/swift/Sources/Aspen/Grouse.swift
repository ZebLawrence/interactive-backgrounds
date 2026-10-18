import Metal
import simd

// Ruffed grouse: a procedural bird that roosts under the snow, bursts out when flushed, flies low
// and fast through the trunks, picks aspen buds in a crown, and dives back into the snow to roost.
//
// Bonasa umbellus: 40-50 cm, chicken-shaped, mottled grey-brown (the grey morph in the north),
// with a small crest, a black ruff at the sides of the neck, barred flanks and a fan tail with a
// broad black band near its pale tip. In winter it lives largely on the buds of aspens, picked
// at dusk and dawn from the crowns, and when the snow is deep it roosts under it: it dives in
// from flight, tunnels a short way, and sits in a snug chamber. Disturbed, it explodes out in
// a thunder of wingbeats, flies off low at up to 40 km/h on short wings, bursts of flapping
// alternating with glides, and settles again within a hundred metres.

/// A tube lofted along t (0..1) and round a (0..2pi) by `at(t, a)`; uv = (c / sides, t).
private func lofted(_ rows: Int, _ sides: Int, _ at: (Float, Float) -> V3) -> MeshData {
    var m = MeshData()
    for r in 0...rows {
        for c in 0...sides {
            let t = Float(r) / Float(rows), a = Float(c) / Float(sides) * TAU
            m.positions.append(at(t, a))
            m.uvs.append(V2(Float(c) / Float(sides), t))
        }
    }
    for r in 0..<rows {
        for c in 0..<sides {
            let a = UInt32(r * (sides + 1) + c), b = a + 1, d = a + UInt32(sides + 1), e = d + 1
            m.indices += [a, d, b, b, d, e]
        }
    }
    m.computeVertexNormals()
    return m
}

/// A swelling along t: sin(pi t)^k (clamped so the ends never go negative).
private func bulb(_ k: Float, _ t: Float) -> Float { pow(max(0, sin(.pi * clamp(t, 0, 1))), k) }

/// The bird's parts, built once and shared.
private final class GrouseParts {
    static let shared = GrouseParts()
    let body: GPUMesh, head: GPUMesh, crest: GPUMesh, eye: GPUMesh, beak: GPUMesh
    let wings: [GPUMesh]      // left (side -1), right (side 1)
    let tail: GPUMesh
    let legs: [GPUMesh]       // left, right
    let toe: GPUMesh

    private init() {
        // The body: plump, the breast deep, rising into a short neck at the front.
        body = lofted(24, 22) { t, a in
            let ry = 0.07 * bulb(0.42, t) * (1 - 0.25 * t * t), rz = 0.062 * bulb(0.42, t) * (1 - 0.2 * t * t)
            let neck = smoothstep(0.75, 1, t)
            return V3(-0.15 + 0.27 * t, 0.01 * sin(.pi * t) + neck * 0.05 + sin(a) * (ry * (1 - neck * 0.55)), cos(a) * rz * (1 - neck * 0.5))
        }.upload()
        head = lofted(12, 14) { t, a in
            V3(-0.02 + 0.055 * t, 0.012 - 0.01 * t * t + sin(a) * 0.021 * bulb(0.35, t), cos(a) * 0.019 * bulb(0.35, t))
        }.upload()
        crest = lofted(8, 8) { t, a in
            V3(0.004 - 0.028 * t, 0.018 + 0.022 * t + sin(a) * 0.005 * bulb(0.4, t), cos(a) * 0.01 * bulb(0.4, t))
        }.upload()
        eye = Geometry.sphere(radius: 0.0045, widthSegments: 10, heightSegments: 8).upload()
        beak = Geometry.cone(radius: 0.006, height: 0.016, radialSegments: 8).upload()
        // Wings: a card each, 0.11 chord (x) by 0.19 span (z); uv.y along the span.
        wings = [-1, 1].map { (side: Float) in
            var g = Geometry.plane(0.11, 0.19, 4, 8).transformed(simd_float4x4(rotationX: -.pi / 2))
            g = g.translated(V3(-0.03, 0, side * 0.095))
            // uv.y must run from the shoulder (0) to the tip (1) on both wings. The plane's v is 1
            // at the shoulder of the right wing and at the tip of the left, so the right one is
            // flipped. (The web version flips the left one instead, which puts both wings' rounded
            // tips at the shoulder and leaves square ends outboard.)
            if side > 0 { g.uvs = g.uvs.map { V2($0.x, 1 - $0.y) } }
            return g.upload()
        }
        // The tail: a fan card, its vertices spread sideways with distance from the base.
        var tg = Geometry.plane(0.17, 0.15, 8, 6)
            .transformed(simd_float4x4(rotationY: .pi / 2) * simd_float4x4(rotationX: -.pi / 2))
            .translated(V3(-0.075, 0, 0))
        for i in tg.positions.indices {
            let x = tg.positions[i].x, z = tg.positions[i].z
            let along = -x / 0.15
            tg.positions[i].z = z * along
            tg.uvs[i] = V2(z / 0.17 + 0.5, along)
        }
        tg.computeVertexNormals()
        tail = tg.upload()
        // Feathered to the toes: a fluffy stub each side.
        legs = [-1, 1].map { (side: Float) in
            lofted(6, 10) { t, a in
                V3(cos(a) * 0.016 * bulb(0.4, t), -0.045 - 0.04 * t, side * 0.025 + sin(a) * 0.016 * bulb(0.4, t))
            }.upload()
        }
        toe = Geometry.cylinder(top: 0.0025, bottom: 0.0015, height: 0.03, radialSegments: 5).upload()
    }
}

/// Which plumage a part wears (`GrouseParams.kind` in the shaders).
private enum Plumage: Float { case body = 0, head = 1, wing = 2, tail = 3 }

private struct GrouseParams { var model: simd_float4x4; var kind: V4 }

final class Grouse {
    enum State: String { case roost, burst, fly, alight, perch, descend }

    private struct Perch { let tree: TreeInstance; let f: Float; let off: V3 }
    private struct Wing { let pivot: Node; let ghost: Node; let side: Float }

    private unowned let scene: Aspen
    private let root = Node("grouse")
    private let body = Node("body")
    private let neck = Node("neck")
    private let head = Node("head")
    private let tailG = Node("tail")
    private let legs = Node("legs")
    private var wings: [Wing] = []

    private(set) var pos = V3.zero
    private var vel = V3.zero
    private var yaw: Float = 0
    private var pitch: Float = 0
    private(set) var state = State.roost
    private var timer: Float = 0
    /// When it next comes out on its own to feed (seconds of roosting).
    private var nextSelf = rnd(240, 480)
    private var flap: Float = 0          // wing phase
    private var flapRate: Float = 0      // beats per second, eased
    private var wingK: Float = 0         // 0 folded .. 1 spread
    private var tailK: Float = 0.3       // fan
    private var headBob: Float = 0
    private var glide: Float = 0
    private var perchTime: Float = 0
    private var alightFrom = V3.zero
    private var perch: Perch?
    private var roost = V3.zero
    private var dive = V3.zero

    init(scene: Aspen) {
        self.scene = scene
        build()
        roostSomewhere()
        root.visible = false
    }

    // MARK: - Build

    private func build() {
        let parts = GrouseParts.shared
        func plumage(_ mesh: GPUMesh, _ kind: Plumage) -> Node {
            let n = Node()
            n.draw = { ctx, m in
                let card = kind == .wing || kind == .tail
                ctx.use("grouseVertex", "grouseFragment", shadowFragment: card ? "grouseShadowFragment" : nil, alphaToCoverage: card)
                var p = GrouseParams(model: m, kind: V4(kind.rawValue, 0, 0, 0))
                ctx.encoder.setVertexBytes(&p, length: MemoryLayout<GrouseParams>.stride, index: 2)
                ctx.encoder.setFragmentBytes(&p, length: MemoryLayout<GrouseParams>.stride, index: 1)
                mesh.draw(ctx.encoder)
            }
            return n
        }
        func plain(_ mesh: GPUMesh, _ hex: String, roughness: Float) -> Node {
            let n = Node()
            let color = RGBA(hex: hex).linear
            n.draw = { ctx, m in
                Std.begin(ctx)
                Std.draw(ctx, mesh, StdParams(model: m, color: color, roughness: roughness, flags: []))
            }
            return n
        }

        root.add(body)
        body.add(plumage(parts.body, .body))
        // Head on the neck, with a crest.
        neck.position = V3(0.11, 0.065, 0)
        body.add(neck)
        neck.add(head)
        head.add(plumage(parts.head, .head))
        head.add(plumage(parts.crest, .head))
        for side: Float in [-1, 1] {
            let eye = plain(parts.eye, "#100c08", roughness: 0.15)
            eye.position = V3(0.012, 0.016, side * 0.016)
            head.add(eye)
        }
        let beak = plain(parts.beak, "#3a3028", roughness: 0.6)
        beak.rotation = V3(0, 0, -.pi / 2)
        beak.position = V3(0.04, 0.004, 0)
        head.add(beak)
        // Wings: hinged at the shoulder, lying along the flank when folded.
        for (i, side) in [Float(-1), 1].enumerated() {
            let pivot = Node("wing")
            pivot.position = V3(0.02, 0.03, side * 0.04)
            body.add(pivot)
            pivot.add(plumage(parts.wings[i], .wing))
            // A second, ghost copy for the blur of a fast beat.
            let ghost = plumage(parts.wings[i], .wing)
            ghost.visible = false
            ghost.castShadow = false
            pivot.add(ghost)
            wings.append(Wing(pivot: pivot, ghost: ghost, side: side))
        }
        // The tail: a fan card hinged at the rump, folded narrow or spread wide.
        tailG.position = V3(-0.13, 0.02, 0)
        body.add(tailG)
        tailG.add(plumage(parts.tail, .tail))
        // Short feathered legs with three grey toes gripping below.
        for (i, side) in [Float(-1), 1].enumerated() {
            legs.add(plumage(parts.legs[i], .body))
            for k in 0..<3 {
                let toe = plain(parts.toe, "#4a4038", roughness: 0.9)
                toe.rotation = V3(0, Float(k - 1) * 0.55, -.pi / 2)
                toe.position = V3(0.012, -0.088, side * 0.025)
                legs.add(toe)
            }
        }
        body.add(legs)
    }

    // MARK: - Behaviour

    /// The home ground where it roosts: the open snow in front of the viewer.
    private func roostSomewhere() {
        for _ in 0..<40 {
            let z = rnd(-24, -8), half = min(11, -z * 0.5)
            let x = rnd(-half, half)
            if !scene.openSnow(x, z, 1) { continue }
            roost = V3(x, scene.height(x, z), z)
            return
        }
        roost = V3(0, scene.height(0, -12), -12)
    }

    /// A click on the snow at `p`: if it is roosting, it bursts out there.
    func flush(_ p: V3) -> Bool {
        if state != .roost { return false }
        if !scene.openSnow(p.x, p.z, 0.6) { return false }
        roost = p
        burst()
        return true
    }

    private func burst() {
        let s = scene
        pos = roost
        pos.y += 0.05
        state = .burst
        timer = 0
        yaw = rnd(0, TAU)
        pitch = 0.9
        vel = .zero
        flapRate = 13
        wingK = 1
        tailK = 1
        root.visible = true
        s.snowpack.stampBurst(roost.x, roost.z, heading: -yaw)
        s.puffs.burst(roost.x, roost.y, roost.z, strength: 1.6, spread: 0.4)
        choosePerch()
    }

    /// A crown to fly to: a branch high in a tree 12-40 m off, in view.
    private func choosePerch() {
        let options = scene.grove.trees.filter { t in
            let d = hypot(t.x - pos.x, t.z - pos.z), dist = hypot(t.x, t.z)
            return d > 12 && d < 40 && dist > 12 && dist < 48 && t.height > 10 && abs(atan2(t.x, -t.z)) < 0.6
        }
        guard let t = options.randomElement() else { perch = nil; return }
        let a = rnd(0, TAU)
        perch = Perch(tree: t, f: rnd(0.68, 0.8), off: V3(cos(a), 0, sin(a)) * (t.maxR * rnd(0.3, 0.6)))
    }

    private func perchPoint(_ p: Perch) -> V3 { scene.grove.pointUp(p.tree, p.f) + p.off }

    /// Somewhere in the open to dive into the snow.
    private func chooseDive() {
        roostSomewhere()
        dive = roost
    }

    /// The nearest trunk ahead within `reach`, for steering: which side it lies (1 or -1), or nil.
    private func trunkAhead(_ dir: V3, _ reach: Float) -> Float? {
        var best: Float?, bestD = reach
        for t in scene.grove.trees {
            if let p = perch, t === p.tree { continue }
            let dx = t.x - pos.x, dz = t.z - pos.z
            let along = dx * dir.x + dz * dir.z
            if along < 0 || along > reach { continue }
            let cross = dx * dir.z - dz * dir.x
            if abs(cross) > t.baseR + 0.5 { continue }
            if along < bestD {
                bestD = along
                best = cross > 0 ? 1 : cross < 0 ? -1 : 1
            }
        }
        return best
    }

    /// Something sudden nearby: a perched bird may take off for another crown.
    func startle(_ p: V3, _ strength: Float) {
        if state == .perch && strength > 0.8 && chance(0.5) {
            choosePerch()
            state = .fly
            timer = 0
            flapRate = 11
        }
    }

    func update(dt: Float, scene s: Aspen, info: CursorInfo) {
        timer += dt
        switch state {
        case .roost:
            // Now and then it comes out on its own to feed.
            if timer > nextSelf { burst() }
        case .burst:
            // Straight up out of the snow, then levelling off into flight.
            let k = timer
            vel.y = lerp(5, 1.5, smoothstep(0, 0.6, k))
            let fwd = V3(cos(yaw), 0, -sin(yaw))
            let speed = lerp(1, 8, smoothstep(0.1, 0.9, k))
            vel.x = fwd.x * speed
            vel.z = fwd.z * speed
            pos += vel * dt
            pitch = lerp(0.9, 0.15, smoothstep(0.1, 0.9, k))
            if k > 0.9 {
                state = .fly
                timer = 0
                glide = 0
            }
        case .fly:
            // Toward the perch, low between the trunks; bursts of flapping and glides.
            let target = perch.map(perchPoint) ?? V3(pos.x, pos.y, pos.z - 30)
            let to = target - pos
            let dist = to.length
            let flat = hypot(to.x, to.z)
            // Cruise about 3 m up until the last stretch, then rise to the perch.
            let cruiseY = s.height(pos.x, pos.z) + 3 + sin(timer * 0.7) * 0.6
            let wantY = flat < 25 ? lerp(target.y + 0.3, min(cruiseY, target.y), smoothstep(8, 25, flat)) : min(cruiseY, target.y)
            let dir = V3(to.x, 0, to.z).normalized
            // Steer round the trunk ahead.
            var steer: Float = 0
            if let side = trunkAhead(dir, 5), flat > 3 { steer = -side * 1.4 }
            let wantYaw = atan2(-dir.z, dir.x) + steer
            let turn: Float = flat < 6 ? 5 : 2.2
            yaw += clamp(angleTo(yaw, wantYaw), -turn * dt, turn * dt)
            let speed: Float = flat < 6 ? lerp(2, 8, smoothstep(0, 6, flat)) : 8
            let fwd = V3(cos(yaw), 0, -sin(yaw))
            vel.x = approach(vel.x, fwd.x * speed, 0.3, dt)
            vel.z = approach(vel.z, fwd.z * speed, 0.3, dt)
            vel.y = approach(vel.y, clamp((wantY - pos.y) * 2, -4, 4), 0.3, dt)
            pos += vel * dt
            pitch = approach(pitch, clamp(vel.y * 0.12, -0.4, 0.5) + (flat < 4 ? 0.6 : 0), 0.3, dt)
            // Flap then glide, flapping harder when climbing.
            glide += dt
            let climbing = vel.y > 0.5
            let period: Float = climbing ? 1.6 : 1.3
            let phase = glide.truncatingRemainder(dividingBy: period)
            let flapping = climbing || phase < 0.75 || flat < 6
            flapRate = approach(flapRate, flapping ? 11 : 0, 0.15, dt)
            wingK = 1
            tailK = approach(tailK, flat < 5 ? 1 : 0.35, 0.3, dt)
            if dist < 1.2 && perch != nil {
                // Close enough: flare and settle onto the branch.
                state = .alight
                timer = 0
                alightFrom = pos
                flapRate = 9
            }
            if perch == nil && timer > 12 {
                choosePerch()
                if perch == nil {
                    chooseDive()
                    state = .descend
                    timer = 0
                }
            }
        case .alight:
            // Braking with the wings forward and the tail fanned, feet reaching for the branch.
            guard let p = perch else { state = .fly; break }
            let k = smoothstep(0, 1, min(1, timer / 0.55))
            pos = lerp(alightFrom, perchPoint(p), k)
            pos.y += sin(k * .pi) * 0.15
            pitch = approach(pitch, 0.7, 0.15, dt)
            tailK = approach(tailK, 1, 0.15, dt)
            wingK = 1
            flapRate = approach(flapRate, 6, 0.3, dt)
            if k >= 1 {
                state = .perch
                timer = 0
                perchTime = rnd(40, 90)
                vel = .zero
            }
        case .perch:
            // Sitting in the crown, picking buds: the head reaches and bobs; it settles its feathers.
            guard let p = perch else { state = .fly; break }
            pos = perchPoint(p)
            pitch = approach(pitch, 0.1, 0.5, dt)
            wingK = approach(wingK, 0, 0.6, dt)
            tailK = approach(tailK, 0.25, 1, dt)
            flapRate = approach(flapRate, 0, 0.3, dt)
            headBob = max(0, sin(timer * 2.3) * 0.5 + sin(timer * 0.7)) * 0.4
            if timer > perchTime {
                chooseDive()
                state = .descend
                timer = 0
                flapRate = 10
            }
        case .descend:
            // Down toward the chosen spot, then a folded-wing plunge into the snow.
            let to = dive - pos
            let flat = hypot(to.x, to.z)
            let dir = V3(to.x, 0, to.z).normalized
            let side = trunkAhead(dir, 5)
            let wantYaw = atan2(-dir.z, dir.x) + (side != nil && flat > 3 ? -side! * 1.4 : 0)
            yaw += clamp(angleTo(yaw, wantYaw), -2.2 * dt, 2.2 * dt)
            let fwd = V3(cos(yaw), 0, -sin(yaw))
            let plunge = flat < 2.5
            let speed: Float = plunge ? 6 : flat < 10 ? lerp(4, 9, smoothstep(2.5, 10, flat)) : 9
            if flat < 6 {
                // The last stretch is flown straight at the spot, the body turning to follow.
                vel.x = approach(vel.x, dir.x * speed, 0.15, dt)
                vel.z = approach(vel.z, dir.z * speed, 0.15, dt)
                yaw = atan2(-vel.z, vel.x)
            } else {
                vel.x = approach(vel.x, fwd.x * speed, 0.3, dt)
                vel.z = approach(vel.z, fwd.z * speed, 0.3, dt)
            }
            let wantY = plunge ? dive.y - 0.3 : max(dive.y + 1.5, pos.y - 3 * dt * 10)
            vel.y = approach(vel.y, plunge ? -5 : clamp((wantY - pos.y) * 1.5, -4, 2), 0.25, dt)
            pos += vel * dt
            pitch = approach(pitch, plunge ? -0.7 : -0.2, 0.25, dt)
            wingK = approach(wingK, plunge ? 0.15 : 1, 0.2, dt)
            flapRate = approach(flapRate, plunge ? 0 : 9, 0.2, dt)
            tailK = approach(tailK, 0.3, 0.3, dt)
            if pos.y < s.height(pos.x, pos.z) - 0.05 {
                // In: a hole in the snow, a puff, and it is gone.
                roost = dive
                roost.y = s.height(roost.x, roost.z)
                s.snowpack.stampRoost(pos.x, pos.z, heading: -yaw)
                s.puffs.burst(pos.x, roost.y, pos.z, strength: 0.6, spread: 0.25)
                state = .roost
                timer = 0
                nextSelf = rnd(240, 480)
                root.visible = false
            }
        }
        if state == .roost { return }
        applyBody(dt)
    }

    /// Pose the body from the flight state: wings, tail, neck.
    private func applyBody(_ dt: Float) {
        flap += flapRate * dt * TAU
        // Keep the phase small so float precision holds over hours of flight.
        if flap > TAU * 1000 { flap = flap.truncatingRemainder(dividingBy: TAU) }
        let beat = sin(flap)
        root.position = pos
        root.rotation = V3(0, yaw, 0)
        body.rotation = V3(0, 0, pitch)
        let fold = 1 - wingK
        for w in wings {
            // Folded: along the flank, swept back. Spread: out to the side, beating up and down.
            let flapAngle = flapRate > 0.5 ? beat * 1.1 * min(1, flapRate / 8) : 0.15
            w.pivot.setRotation(w.side * (-flapAngle * wingK), fold * w.side * -1.3, fold * 0.9, order: "YZX")
            w.pivot.scale = V3(1, 1, 1 - fold * 0.45)
            // The ghost trails the beat to blur a fast wing.
            let fast = flapRate > 7
            w.ghost.visible = fast
            if fast { w.ghost.rotation = V3(w.side * (-(sin(flap - 1.2) - beat) * 1.1 * wingK), 0, 0) }
        }
        tailG.scale = V3(1, 1, 0.3 + 0.7 * tailK)
        tailG.rotation = V3(0, 0, state == .perch ? -0.3 : tailK * 0.2)
        neck.rotation = V3(0, 0, state == .perch ? -0.3 - headBob : 0.2 - pitch * 0.6)
        head.rotation = V3(0, 0, state == .perch ? -headBob * 0.5 : 0)
        legs.visible = state == .perch
    }

    // MARK: - Drawing

    func draw(_ ctx: DrawContext) {
        root.render(ctx)
    }

    var debugDescription: String {
        String(format: "%@ at (%.1f, %.2f, %.1f) yaw %.2f flap %.1f/s", state.rawValue, pos.x, pos.y, pos.z, yaw, flapRate)
    }
}

extension Shaders {
    static let grouse = """

    // MARK: - Ruffed grouse

    struct GrouseParams { float4x4 model; float4 kind; };
    struct GrouseOut { float4 position [[position]]; float3 world; float3 normal; float2 uv; };

    vertex GrouseOut grouseVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                  constant Frame& F [[buffer(1)]], constant GrouseParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float4 w = P.model * float4(a.xyz, 1.0);
        GrouseOut o;
        o.world = w.xyz;
        o.normal = transformNormal(P.model, b.xyz);
        o.uv = float2(a.w, b.w);
        o.position = F.viewProj * w;
        return o;
    }

    /// Feather by feather: overlapping scalloped rows, each feather grey-brown with a pale shaft
    /// streak and a darker tip, finely vermiculated, a few with a pale spot.
    float3 grouseMottle(float2 p, float scale) {
        float2 q2 = p * scale;
        // Stagger alternate rows so the feathers overlap like tiles.
        float row = floor(q2.y);
        q2.x += 0.5 * fmodGL(row, 2.0);
        float2 cell = floor(q2);
        float2 f = fract(q2);
        float h = hash21(cell), h2 = hash21(cell + 3.7);
        // The feather's rounded tip: the row above overlaps this one.
        float tipDist = length((f - float2(0.5, 0.0)) * float2(1.0, 0.7));
        float verm = vnoise(p * 900.0) * 0.5 + vnoise(p * 300.0) * 0.5;
        float3 dark = float3(0.07, 0.055, 0.045), mid = float3(0.2, 0.165, 0.13), pale = float3(0.38, 0.33, 0.27);
        float3 c = mix(dark, mid, h * 0.7 + verm * 0.3);
        // Pale shaft streak down the middle, and a dark band near the tip.
        float shaft = 1.0 - smoothstep(0.03, 0.08, abs(f.x - 0.5));
        c = mix(c, pale, shaft * 0.7 * smoothstep(0.2, 0.6, f.y));
        c = mix(c, dark, smoothstep(0.75, 0.95, f.y) * 0.5);
        c = mix(c, pale, step(0.85, h2) * (1.0 - smoothstep(0.1, 0.25, length(f - float2(0.5, 0.45)))) * 0.6);
        // The scalloped edge where the next row overlaps.
        float edge = smoothstep(0.55, 0.62, tipDist) * (1.0 - smoothstep(0.0, 0.12, f.y));
        c = mix(c, dark, edge * 0.5);
        c *= 0.85 + 0.3 * verm;
        return c;
    }

    /// The cards' silhouettes: kind 2 a wing, 3 the tail fan (uv.x across, uv.y along from the base).
    float grouseCardAlpha(float kind, float2 uv) {
        if (kind > 2.5) {
            // A fan: feathers radiate from the base; scalloped tip.
            float r = uv.y;
            float feather = abs(fract(uv.x * 9.0) - 0.5);
            float tipR = 0.96 - 0.06 * feather * feather * 4.0;
            return 1.0 - smoothstep(tipR, tipR + 0.03, r);
        }
        // A wing: short, broad and rounded, the leading edge nearly straight, the trailing edge
        // curving in to a rounded tip of fingered primaries.
        float y = uv.y, x = uv.x;
        float e = pow(abs((x - 0.42) / 0.58), 2.4) + pow(y, 3.2) + 0.25 * y * y * x;
        float a = 1.0 - smoothstep(0.9, 1.0, e);
        // Scallops along the trailing edge, feather by feather, and the fingered primaries.
        a *= 1.0 - 0.5 * smoothstep(0.78, 1.0, e + 0.08 * abs(fract(y * 8.0) - 0.5)) * step(0.5, x);
        a *= 1.0 - 0.5 * smoothstep(0.65, 1.0, y) * smoothstep(0.25, 0.5, abs(fract(x * 6.0) - 0.5)) * step(0.4, x);
        return a;
    }

    fragment float4 grouseFragment(GrouseOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                   constant GrouseParams& P [[buffer(1)]]) {
        float kind = P.kind.x;
        float2 uv = in.uv;
        float3 c;
        float alpha = 1.0;
        if (kind < 0.5) {
            // Round the body: uv.x is the angle (0.25 = top, 0.75 = belly), uv.y runs tail to breast.
            // 1 at the top of the back, -1 on the belly. (The web version takes the cosine here,
            // which puts the pale breast on the left flank.)
            float side = sin(uv.x * 6.2831);
            c = grouseMottle(float2(uv.x * 2.0, uv.y * 3.0), 26.0);
            // Pale feathers each with a dark crescent at the tip: barred underparts.
            float3 breast = mix(grouseMottle(float2(uv.x * 2.0 + 0.3, uv.y * 3.0), 26.0), float3(0.6, 0.55, 0.47), 0.6);
            c = mix(c, breast, smoothstep(0.2, 0.8, -side));
            // The black ruff at the sides of the neck.
            float ruff = smoothstep(0.78, 0.86, uv.y) * (1.0 - smoothstep(0.86, 0.92, uv.y)) * (1.0 - smoothstep(0.5, 0.9, abs(side)));
            c = mix(c, float3(0.02, 0.018, 0.015), ruff * 0.9);
        } else if (kind < 1.5) {
            c = grouseMottle(float2(uv.x * 2.0, uv.y), 30.0);
            // The pale throat, under the head.
            float side = sin(uv.x * 6.2831);
            c = mix(c, float3(0.5, 0.45, 0.38), smoothstep(0.2, 0.8, -side) * 0.6);
        } else {
            c = grouseMottle(float2(uv.x * 3.0, uv.y * 2.0), 16.0);
            alpha = grouseCardAlpha(kind, uv);
            if (kind > 2.5) {
                // The tail's black band near the tip, the pale edge, fine cross-barring.
                float r = uv.y;
                float band = smoothstep(0.72, 0.76, r) * (1.0 - smoothstep(0.86, 0.9, r));
                c = mix(c, float3(0.02, 0.018, 0.015), band * 0.95);
                c = mix(c, float3(0.55, 0.52, 0.45), smoothstep(0.9, 0.94, r));
                c *= 0.85 + 0.15 * smoothstep(0.4, 0.6, abs(sin(r * 70.0)));
            } else {
                // Barred coverts and darker primaries.
                c *= 0.8 + 0.2 * smoothstep(0.4, 0.6, abs(sin(uv.x * 40.0 + uv.y * 8.0)));
                c = mix(c, float3(0.12, 0.1, 0.08), smoothstep(0.55, 0.95, uv.x) * 0.5);
            }
            if (alpha < 0.05) discard_fragment();
            // Without multisampling there is no alpha to coverage: cut at one half instead (Low Power).
            if (F.screen.w < 0.5) { if (alpha < 0.5) discard_fragment(); alpha = 1.0; }
        }
        float3 n = normalize(in.normal);
        // The cards are double-sided.
        if (kind > 1.5 && !front) n = -n;
        float3 lit = standardLight(F, c, n, in.world, 0.9, 0.0, float2(1.0), geometryRoughness(n));
        return float4(applyFog(F, lit, length(in.world - F.camera.xyz)), alpha);
    }

    /// The cards in the key lights' shadow passes: only the feathered silhouette casts.
    fragment void grouseShadowFragment(GrouseOut in [[stage_in]], constant GrouseParams& P [[buffer(1)]]) {
        if (grouseCardAlpha(P.kind.x, in.uv) < 0.5) discard_fragment();
    }

    """
}
