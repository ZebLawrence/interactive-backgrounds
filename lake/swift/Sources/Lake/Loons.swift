import CoreGraphics
import Metal
import simd

/// Common loons out on the water: paddling slowly, turning to look at a resting cursor, diving when
/// startled and on their own, and surfacing again somewhere else with a ring. Built from a lathe
/// body, a tube neck, a head and a dagger bill, painted: black head and neck with the white
/// necklace, a chequered back, white breast, red eye.
private final class LoonParts {
    static let shared = LoonParts()
    let body: GPUMesh, neck: GPUMesh, head: GPUMesh, bill: GPUMesh, eyes: GPUMesh
    let bodyTexture: MTLTexture, neckTexture: MTLTexture
    /// The head and neck turn about the base of the neck.
    static let pivot = V3(0.6, 0.06, 0)

    private init() {
        // Body: a lathe along +x, tail at x = 0, breast at x = 0.78. The hull sits low in the water.
        let n = 40
        let pts: [V2] = (0...n).map { i in
            let t = Float(i) / Float(n)
            return V2(0.145 * pow(sin(.pi * pow(t, 0.85)), 0.75) + 0.004, t * 0.78)
        }
        var body = Geometry.lathe(pts, segments: 36).transformed(simd_float4x4(rotationZ: -.pi / 2))
        // Flatten the hull a little and raise the tail.
        for i in body.positions.indices {
            let p = body.positions[i]
            body.positions[i] = V3(p.x, p.y * 0.85 + pow(1 - p.x / 0.78, 3) * 0.06, p.z * 1.1)
        }
        body.computeVertexNormals()
        self.body = body.upload()
        // Neck: a tube curving up from the shoulders, with the head and bill on top.
        neck = Geometry.tube(Curve3([V3(0.6, 0.06, 0), V3(0.7, 0.15, 0), V3(0.73, 0.27, 0), V3(0.73, 0.36, 0)]),
                             tubularSegments: 16, radius: 0.045, radialSegments: 14).upload()
        head = Geometry.sphere(radius: 1, widthSegments: 24, heightSegments: 16)
            .transformed(simd_float4x4(translation: V3(0.76, 0.4, 0)) * simd_float4x4(scale: V3(0.075, 0.062, 0.058))).upload()
        bill = Geometry.cone(radius: 0.019, height: 0.13, radialSegments: 12)
            .transformed(simd_float4x4(translation: V3(0.88, 0.395, 0)) * simd_float4x4(rotationZ: -.pi / 2)).upload()
        let eye = Geometry.sphere(radius: 0.009, widthSegments: 10, heightSegments: 8)
        eyes = MeshData.merged([eye.translated(V3(0.785, 0.41, 0.05)), eye.translated(V3(0.785, 0.41, -0.05))]).upload()
        bodyTexture = GPU.shared.texture(LoonParts.bodyImage(), srgb: true)
        neckTexture = GPU.shared.texture(LoonParts.neckImage(), srgb: true)
    }

    /// u runs round the body: 0 and 1 are the belly, 0.5 the back. v runs along it.
    static func bodyImage() -> Canvas {
        let w = 1024.0, h = 512.0
        let c = Canvas(Int(w), Int(h))
        c.fill(RGBA(hex: "#f2f2f0"))
        c.fillRect(0, 0, w, h)
        // The dark back: a broad saddle, black with rows of white chequers along the shoulders.
        let black = RGBA.bytes(10, 10, 12)
        c.clipped(CGRect(x: 0, y: h * 0.06, width: w, height: h * 0.9)) {
            c.linearGradient(from: .zero, to: CGPoint(x: w, y: 0),
                             [(0, black.alpha(0)), (0.24, black.alpha(0)), (0.3, black), (0.7, black), (0.76, black.alpha(0)), (1, black.alpha(0))])
        }
        // Chequers: rows of white rectangles across the back, large in the middle, fine at the edges.
        for row in 0..<7 {
            let u = 0.33 + Double(row) * 0.057
            let x = u * w
            let big = abs(u - 0.5) < 0.1
            let cw = big ? 14.0 : 8, ch = big ? 9.0 : 6, step = big ? 22.0 : 14
            var y = h * 0.14
            while y < h * 0.86 {
                if !chance(0.12) {
                    c.fill(.bytes(245, 245, 245, big ? 1 : 0.85))
                    c.fillRect(x - cw / 2 + rndD(-1, 1), y + Double(row % 2) * step * 0.5, cw, ch)
                }
                y += step
            }
        }
        // Flanks: fine dark streaks on white toward the waterline.
        c.fill(.bytes(20, 20, 22, 0.5))
        for _ in 0..<400 {
            let side = chance(0.5) ? rndD(0.2, 0.28) : rndD(0.72, 0.8)
            c.fillRect(side * w + rndD(-6, 6), rndD(h * 0.15, h * 0.85), 2, rndD(3, 9))
        }
        // The tail end darkens; the breast is pure white.
        let tail = RGBA.bytes(15, 15, 18, 0.9)
        c.clipped(CGRect(x: 0, y: 0, width: w, height: h * 0.14)) {
            c.linearGradient(from: .zero, to: CGPoint(x: 0, y: h * 0.14), [(0, tail), (1, tail.alpha(0))])
        }
        return c
    }

    /// u runs up the neck from the shoulders (0) to the head (1); v runs round it.
    static func neckImage() -> Canvas {
        let w = 512.0, h = 256.0
        let c = Canvas(Int(w), Int(h))
        c.fill(RGBA(hex: "#0c0d10"))
        c.fillRect(0, 0, w, h)
        // A faint green-purple sheen band.
        c.linearGradient(from: .zero, to: CGPoint(x: 0, y: h),
                         [(0, .bytes(20, 60, 40, 0.25)), (0.5, .bytes(60, 30, 70, 0.2)), (1, .bytes(20, 60, 40, 0.25))])
        // The necklace: a band of vertical white stripes round the middle of the neck, broken at the back.
        c.fill(RGBA(hex: "#f4f4f2"))
        var v = 0.08
        while v < 0.92 {
            c.fillRect(w * 0.42, v * h, w * 0.14, h * 0.038)
            v += 0.075
        }
        // A lower half-collar of fine stripes where the neck meets the chest.
        v = 0.25
        while v < 0.75 {
            c.fillRect(w * 0.1, v * h, w * 0.12, h * 0.022)
            v += 0.05
        }
        return c
    }
}

final class Loon {
    enum State { case paddle, approach, dive, under, surface }

    var pos = V3.zero
    private var heading = rnd(0, TAU)
    private var speed: Float = 0.2
    private var lookYaw: Float = 0
    private var lookTarget: Float = 0
    private(set) var state = State.paddle
    private var timer = rnd(5, 20)
    private var diveTimer = rnd(40, 120)
    /// 0 afloat, 1 fully under.
    private var submerged: Float = 0
    private let bobPhase = rnd(0, TAU)
    private var wanderPhase = rnd(0, TAU)
    private var scanTimer = rnd(2, 6)
    private var model = matrix_identity_float4x4

    func dive(lake: Lake) {
        if state == .dive || state == .under || state == .surface { return }
        state = .dive
        timer = 0.7
        lake.disturb(pos.x, pos.z, radius: 0.5, amount: -0.02, ring: 0.8)
    }

    func update(dt: Float, lake: Lake) {
        let cursor = lake.cursor
        timer -= dt
        diveTimer -= dt
        let bounds = lake.loonBounds

        // Startles: a fast cursor sweeping close, or a stone landing near by.
        if state == .paddle || state == .approach {
            let scr = lake.project(pos)
            if cursor.present && cursor.speed > 600 && scr.depth > 1 {
                let dpx = Float(hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y))
                if dpx < (120 + min(Float(cursor.speed), 2500) * 0.06) / (1 + scr.depth / 40) { dive(lake: lake) }
            }
            for s in lake.startles where hypot(pos.x - s.x, pos.z - s.z) < s.radius * 1.5 { dive(lake: lake) }
        }

        switch state {
        case .paddle:
            wanderPhase += dt * 0.2
            heading += sin(wanderPhase + bobPhase) * 0.12 * dt
            speed = lerp(speed, 0.12 + 0.12 * (0.5 + 0.5 * sin(wanderPhase * 0.7)), dt * 0.5)
            if diveTimer <= 0 {
                dive(lake: lake)
                diveTimer = rnd(60, 180)
            }
            // A fingertip held still for a while draws the nearest loon in, slowly, to have a look.
            if cursor.present && cursor.stillTime > 5 && lake.finger.inWater && pos.distance(to: lake.finger.point) < 45 && lake.loonApproacher === self {
                state = .approach
            }
        case .approach:
            let f = lake.finger
            if !cursor.present || cursor.stillTime < 1 || !f.inWater {
                state = .paddle
                break
            }
            let to = f.point - pos
            let d = hypot(to.x, to.z)
            heading = lerpAngle(heading, atan2(-to.z, to.x), min(1, dt * 0.4))
            speed = lerp(speed, d > 7 ? 0.3 : 0.0, dt * 0.6)
        case .dive:
            // Nose down and slip under.
            submerged = min(1, submerged + dt / 0.7)
            speed = lerp(speed, 0.6, dt * 3)
            if timer <= 0 {
                state = .under
                timer = rnd(20, 45)
                submerged = 1
            }
        case .under:
            if timer <= 0 {
                // Surface somewhere else, within the loons' water.
                for _ in 0..<30 {
                    let a = rnd(0, TAU), r = rnd(8, 30)
                    let x = pos.x + cos(a) * r, z = pos.z + sin(a) * r
                    if z < bounds.near && z > bounds.far && abs(x) < bounds.halfWidth(-z) * 0.85 {
                        pos = V3(x, 0, z)
                        break
                    }
                }
                heading = rnd(0, TAU)
                state = .surface
                timer = 1.0
                speed = 0.05
                lake.disturb(pos.x, pos.z, radius: 0.6, amount: -0.02, ring: 1.0)
            }
        case .surface:
            submerged = max(0, submerged - dt / 1.0)
            if timer <= 0 {
                state = .paddle
                submerged = 0
                timer = rnd(5, 20)
            }
        }

        // Move, and keep to the loons' water with gentle turns.
        let fwd = V3(cos(heading), 0, -sin(heading))
        if state != .under { pos += fwd * (speed * dt) }
        let hw = bounds.halfWidth(-pos.z) * 0.85
        if abs(pos.x) > hw || pos.z > bounds.near || pos.z < bounds.far {
            // Out of the loons' water: turn back toward the middle of it.
            let home = atan2(-((bounds.near + bounds.far) / 2 - pos.z), -pos.x)
            if state == .paddle { heading = lerpAngle(heading, home, min(1, dt * 0.5)) }
        }
        // The wake: a shallow moving dent under the hull.
        if state != .under && speed > 0.05 {
            lake.disturb(pos.x + fwd.x * 0.25, pos.z + fwd.z * 0.25, radius: 0.45, amount: -0.00025 * speed / 0.25 * dt * 60)
        }

        // Looking about: toward a resting fingertip if it is near, otherwise an idle scan.
        scanTimer -= dt
        if cursor.present && cursor.stillTime > 1.2 && lake.finger.valid && pos.distance(to: lake.finger.point) < 40 {
            let to = lake.finger.point - pos
            lookTarget = clamp(angleDiff(atan2(-to.z, to.x), heading), -1.6, 1.6)
        } else if scanTimer <= 0 {
            scanTimer = rnd(3, 9)
            lookTarget = rnd(-0.9, 0.9)
        }
        lookYaw = lerp(lookYaw, lookTarget, min(1, dt * 1.5))

        // Riding the water: a slow bob and roll; nose down when diving.
        let t = Float(lake.clock)
        let bob = 0.012 * sin(t * quantize(0.6) + bobPhase) + 0.006 * sin(t * quantize(1.3) + bobPhase * 2)
        let rollA = 0.03 * sin(t * quantize(0.45) + bobPhase)
        let pitch: Float = state == .dive ? -submerged * 0.9 : (state == .surface ? -submerged * 0.4 : 0.02 * sin(t * quantize(0.5) + bobPhase))
        model = compose(V3(pos.x, -0.04 + bob - submerged * 0.7, pos.z), quatAxis(heading, 0, 1, 0) * quatAxis(pitch, 0, 0, 1) * quatAxis(rollA, 1, 0, 0))
    }

    func draw(_ ctx: DrawContext) {
        guard state != .under else { return }
        let p = LoonParts.shared
        let headModel = model * simd_float4x4(translation: LoonParts.pivot) * simd_float4x4(rotationY: lookYaw)
            * simd_float4x4(translation: -LoonParts.pivot)
        Std.draw(ctx, p.body, StdParams(model: model, color: V3(1, 1, 1), roughness: 0.6, metalness: 0.05, flags: [.map], uv: V4(1, 1, -0.25, 0)),
                 map: p.bodyTexture)
        Std.draw(ctx, p.neck, StdParams(model: headModel, color: V3(1, 1, 1), roughness: 0.5, metalness: 0.15, flags: [.map, .clampMap]),
                 map: p.neckTexture)
        Std.draw(ctx, p.head, StdParams(model: headModel, color: RGBA(hex: "#0b0c10").linear, roughness: 0.45, metalness: 0.2))
        Std.draw(ctx, p.bill, StdParams(model: headModel, color: RGBA(hex: "#1a1a1e").linear, roughness: 0.35, metalness: 0.3))
        Std.draw(ctx, p.eyes, StdParams(model: headModel, color: RGBA(hex: "#8a0f0f").linear, roughness: 0.3, metalness: 0,
                                        emissive: RGBA(hex: "#300000").linear))
    }
}

final class Loons {
    private unowned let lake: Lake
    private(set) var list: [Loon] = []

    init(lake: Lake, count: Int) {
        self.lake = lake
        setCount(count)
    }

    func setCount(_ n: Int) {
        while list.count > n { list.removeLast() }
        while list.count < n {
            let l = Loon()
            let b = lake.loonBounds
            for _ in 0..<40 {
                let z = rnd(b.far * 0.9, b.near - 4), x = rnd(-0.75, 0.75) * b.halfWidth(-z)
                if list.allSatisfy({ hypot($0.pos.x - x, $0.pos.z - z) > 8 }) {
                    l.pos = V3(x, 0, z)
                    break
                }
            }
            list.append(l)
        }
    }

    func update(dt: Float) {
        // Only the nearest loon to a resting fingertip comes over.
        let f = lake.finger
        lake.loonApproacher = f.inWater ? list.min { $0.pos.distance(to: f.point) < $1.pos.distance(to: f.point) } : nil
        for l in list { l.update(dt: dt, lake: lake) }
        // Loons keep their distance from one another.
        for i in list.indices {
            for j in (i + 1)..<list.count {
                let a = list[i], b = list[j]
                let d = a.pos.distance(to: b.pos)
                if d < 3 && d > 1e-3 {
                    let push = (a.pos - b.pos) * ((3 - d) / d * 0.5 * dt)
                    a.pos += push
                    b.pos -= push
                }
            }
        }
    }

    func draw(_ ctx: DrawContext) {
        guard ctx.pass != .refraction else { return }
        Std.begin(ctx)
        for l in list { l.draw(ctx) }
    }
}
