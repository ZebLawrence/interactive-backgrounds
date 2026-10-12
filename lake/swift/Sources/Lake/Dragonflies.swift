import CoreGraphics
import Metal
import simd

private struct Kind { let thorax: String; let abdomen: String; let bands: String; let eyes: String; let wingTint: V3 }

/// Blue darners, green darners, meadowhawks and skimmers.
private let kinds = [
    Kind(thorax: "#2a6fd6", abdomen: "#1b3f8f", bands: "#0b1020", eyes: "#1f7fbf", wingTint: V3(0.85, 0.9, 1.0)),
    Kind(thorax: "#3f9a3a", abdomen: "#2d62c9", bands: "#102014", eyes: "#3a8a3a", wingTint: V3(0.9, 0.95, 0.85)),
    Kind(thorax: "#8a2a1a", abdomen: "#c83b1e", bands: "#3a0f08", eyes: "#7a2a1a", wingTint: V3(1.0, 0.9, 0.8)),
    Kind(thorax: "#6c7fa8", abdomen: "#9fb2d6", bands: "#1a2030", eyes: "#3a4a6a", wingTint: V3(0.9, 0.9, 0.95)),
]

/// Body parts in metres for a 7.5 cm dragonfly, +x forward; the wings are four quads with three
/// ghost copies each for the blur of flight.
private final class DragonflyParts {
    static let shared = DragonflyParts()
    let thorax: GPUMesh, abdomen: GPUMesh, bands: GPUMesh, eyes: GPUMesh
    let wingVertices: MTLBuffer, wingIndices: MTLBuffer, wingIndexCount: Int
    let wingTexture: MTLTexture

    private init() {
        thorax = Geometry.sphere(radius: 1, widthSegments: 16, heightSegments: 12).transformed(simd_float4x4(scale: V3(0.009, 0.0065, 0.006))).upload()
        let head = Geometry.sphere(radius: 0.0038, widthSegments: 12, heightSegments: 10).translated(V3(0.011, 0.001, 0))
        let eye = Geometry.sphere(radius: 0.0028, widthSegments: 10, heightSegments: 8)
        eyes = MeshData.merged([eye.translated(V3(0.0125, 0.0015, 0.0022)), eye.translated(V3(0.0125, 0.0015, -0.0022))]).upload()
        // The abdomen: ten tapering segments, alternately coloured and banded.
        var even: [MeshData] = [], odd: [MeshData] = [head]
        for i in 0..<10 {
            let t = Float(i) / 10
            let r = 0.0028 * (1 - t * 0.55) + (i == 0 ? 0.0006 : 0)
            let g = Geometry.cylinder(top: r * 0.92, bottom: r, height: 0.0046, radialSegments: 10)
                .transformed(simd_float4x4(translation: V3(-0.008 - Float(i) * 0.0046, 0, 0)) * simd_float4x4(rotationZ: .pi / 2))
            if i % 2 == 1 { odd.append(g) } else { even.append(g) }
        }
        abdomen = MeshData.merged(even).upload()
        bands = MeshData.merged(odd).upload()

        // (position, u), (side, fore/hind, ghost, v) per vertex.
        var verts: [V4] = [], idx: [UInt32] = []
        var base: UInt32 = 0
        let fore = (len: Float(0.046), w: Float(0.0105), root: Float(0.0025), sweep: Float(0.08))
        let hind = (len: Float(0.044), w: Float(0.013), root: Float(-0.003), sweep: Float(-0.08))
        for side: Float in [1, -1] {
            for (k, W) in [(Float(0), fore), (Float(1), hind)] {
                for ghost in 0..<3 {
                    let cols = 4
                    for c in 0...cols {
                        let s = Float(c) / Float(cols)
                        let x = W.root + sin(W.sweep) * W.len * s, z = side * W.len * s
                        verts += [V4(x - W.w * 0.5, 0, z, s), V4(side, k, Float(ghost), 0)]
                        verts += [V4(x + W.w * 0.5, 0, z, s), V4(side, k, Float(ghost), 1)]
                    }
                    for c in 0..<UInt32(cols) {
                        let a = base + c * 2, b = a + 1, cc = a + 2, d = a + 3
                        idx += [a, cc, b, b, cc, d]
                    }
                    base += UInt32((cols + 1) * 2)
                }
            }
        }
        wingVertices = GPU.shared.buffer(verts)
        wingIndices = GPU.shared.buffer(idx)
        wingIndexCount = idx.count
        wingTexture = GPU.shared.texture(DragonflyParts.wingImage(), srgb: true)
    }

    /// A wing: translucent membrane, longitudinal veins, a net of cross-veins and the dark pterostigma.
    static func wingImage() -> Canvas {
        let w = 1024.0, h = 320.0
        let c = Canvas(Int(w), Int(h))
        let ctx = c.ctx
        // The outline: a long rounded blade, broader at the base.
        let outline = CGMutablePath()
        outline.move(to: CGPoint(x: 0, y: h * 0.5))
        outline.addCurve(to: CGPoint(x: w * 0.98, y: h * 0.3), control1: CGPoint(x: w * 0.1, y: h * 0.02), control2: CGPoint(x: w * 0.75, y: 0))
        outline.addCurve(to: CGPoint(x: w * 0.7, y: h * 0.98), control1: CGPoint(x: w, y: h * 0.5), control2: CGPoint(x: w * 0.9, y: h * 0.95))
        outline.addCurve(to: CGPoint(x: 0, y: h * 0.5), control1: CGPoint(x: w * 0.4, y: h), control2: CGPoint(x: w * 0.1, y: h * 0.9))
        outline.closeSubpath()
        c.clipped(outline) {
            c.fill(RGBA(1, 1, 1, 0.38))
            c.fillRect(0, 0, w, h)
            // Cross-veins: a fine irregular mesh.
            c.stroke(.bytes(30, 25, 20, 0.55))
            ctx.setLineWidth(1.2)
            var x = 0.0
            while x < w {
                ctx.beginPath()
                ctx.move(to: CGPoint(x: x + sin(x) * 3, y: 0))
                for y in stride(from: 14.0, through: h, by: 14) { ctx.addLine(to: CGPoint(x: x + sin(y * 0.4 + x) * 3, y: y)) }
                ctx.strokePath()
                x += 11
            }
            var y = 0.0
            while y < h {
                ctx.beginPath()
                ctx.move(to: CGPoint(x: 0, y: y + sin(y) * 3))
                for x in stride(from: 12.0, through: w, by: 12) { ctx.addLine(to: CGPoint(x: x, y: y + sin(x * 0.35 + y) * 3)) }
                ctx.strokePath()
                y += 13
            }
            // Longitudinal veins: heavier, running from the root to the tip.
            c.stroke(.bytes(25, 20, 15, 0.9))
            for (y0, y1, lw) in [(0.5, 0.3, 3.5), (0.5, 0.12, 2.5), (0.5, 0.5, 2.2), (0.5, 0.72, 2.2), (0.5, 0.9, 2.0)] {
                ctx.setLineWidth(lw)
                ctx.beginPath()
                ctx.move(to: CGPoint(x: 0, y: h * y0))
                ctx.addCurve(to: CGPoint(x: w * 0.98, y: h * lerp(y1, 0.4, 0.5)), control1: CGPoint(x: w * 0.3, y: h * lerp(y0, y1, 0.6)),
                             control2: CGPoint(x: w * 0.7, y: h * y1))
                ctx.strokePath()
            }
            // Pterostigma: the dark cell near the tip of the leading edge.
            c.fill(.bytes(40, 25, 15, 0.95))
            c.fillRect(w * 0.82, h * 0.09, w * 0.07, h * 0.06)
        }
        // (As on the web, the closing stroke follows the last path drawn, the trailing vein.)
        c.stroke(.bytes(25, 20, 15, 0.95))
        ctx.setLineWidth(3)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: 0, y: h * 0.5))
        ctx.addCurve(to: CGPoint(x: w * 0.98, y: h * lerp(0.9, 0.4, 0.5)), control1: CGPoint(x: w * 0.3, y: h * lerp(0.5, 0.9, 0.6)),
                     control2: CGPoint(x: w * 0.7, y: h * 0.9))
        ctx.strokePath()
        return c
    }
}

/// A dragonfly's wing draw (`WingParams` in the shaders).
private struct WingParams {
    var model: simd_float4x4
    /// x = flying (0 perched ... 1), y = beat phase.
    var motion: V4
    var tint: V4
}

final class Dragonfly {
    enum State { case hover, dart, toPerch, perched, toFinger, onFinger }

    private let kind: Kind
    var pos = V3.zero
    private var vel = V3.zero
    private var heading = rnd(0, TAU)
    private(set) var state = State.hover
    private var timer = rnd(1, 3)
    var target: V3?
    private var perch: Perch?
    private var beat = rnd(0, TAU)
    private var flying: Float = 1
    private var jitter = V3.zero
    private var model = matrix_identity_float4x4

    fileprivate init(kind: Kind) { self.kind = kind }

    func pickWaypoint(_ lake: Lake) -> V3 {
        let b = lake.dragonflyBounds
        let z = rnd(b.far, b.near)
        return V3(rnd(-1, 1) * b.halfWidth(-z) * 0.9, rnd(0.15, 1.4), z)
    }

    private func scatter(from: V3) {
        var away = (pos - from).normalized
        if away.lengthSquared < 0.5 { away = V3(0, 1, 0) }
        vel = away * 3.5 + V3(0, 1.2, 0)
        state = .dart
        var t = pos + away * rnd(2, 4) + V3(0, rnd(0.3, 1.0), 0)
        t.y = clamp(t.y, 0.2, 2.0)
        target = t
        perch = nil
        timer = 2
    }

    func update(dt: Float, lake: Lake) {
        let cursor = lake.cursor
        timer -= dt

        // A fast cursor close by scatters them (screen space).
        if cursor.present && cursor.speed > 450 {
            let scr = lake.project(pos)
            if scr.depth > 0.3 {
                let dpx = Float(hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y))
                if dpx < (170 + min(Float(cursor.speed), 2500) * 0.08) / (1 + scr.depth / 10) { scatter(from: lake.closestPointOnCursorRay(pos)) }
            }
        }
        for s in lake.startles where hypot(pos.x - s.x, pos.z - s.z) < s.radius * 0.8 && pos.y < 1 { scatter(from: V3(s.x, 0, s.z)) }

        let shelter = lake.rain > 0.5
        let time = lake.renderTime
        switch state {
        case .hover:
            // Hanging in the air with small corrections, then off to the next spot.
            jitter += (V3(rnd(-1, 1), rnd(-0.6, 0.6), rnd(-1, 1)) * 0.06 - jitter) * min(1, dt * 4)
            let goal = target.map { $0 + jitter } ?? pos
            vel += ((goal - pos) * 4 - vel) * min(1, dt * 6)
            if timer <= 0 || shelter {
                if lake.fingerPercher === self && lake.finger.valid && cursor.stillTime > 2.5 && !shelter {
                    state = .toFinger
                    timer = 8
                } else if shelter || chance(0.3) {
                    if let p = lake.perches.randomElement() {
                        perch = p
                        state = .toPerch
                        timer = 8
                    }
                } else {
                    target = pickWaypoint(lake)
                    state = .dart
                    timer = 6
                }
            }
        case .dart:
            let to = (target ?? pos) - pos
            let d = to.length
            vel += (to.normalized * clamp(d * 2.5, 0.4, 2.8) - vel) * min(1, dt * 5)
            if d < 0.08 || timer <= 0 {
                state = .hover
                timer = rnd(1.5, 5)
            }
        case .toPerch:
            let goal = lake.reeds.perchTop(perch!, time: time, wind: lake.wind) + V3(0, 0.015, 0)
            let to = goal - pos
            let d = to.length
            vel += (to.normalized * clamp(d * 2.5, 0.25, 2.5) - vel) * min(1, dt * 5)
            if d < 0.03 {
                state = .perched
                timer = shelter ? rnd(20, 60) : rnd(6, 25)
                vel = .zero
            }
            if timer <= 0 {
                state = .hover
                timer = 2
                target = pos
            }
        case .perched:
            pos = lake.reeds.perchTop(perch!, time: time, wind: lake.wind) + V3(0, 0.015, 0)
            vel = .zero
            if (timer <= 0 && !shelter) || (shelter && timer <= 0 && chance(0.3)) {
                timer = 3
                state = .dart
                target = pickWaypoint(lake)
                vel = V3(0, 0.5, 0)
            }
        case .toFinger:
            let f = lake.finger
            if !cursor.present || cursor.stillTime < 0.5 || !f.valid {
                state = .hover
                timer = rnd(1, 3)
                target = pos
                break
            }
            let to = f.point + V3(0, 0.012, 0) - pos
            let d = to.length
            vel += (to.normalized * clamp(d * 2.2, 0.2, 2.5) - vel) * min(1, dt * 5)
            if d < 0.025 {
                state = .onFinger
                vel = .zero
                timer = rnd(15, 60)
            }
            if timer <= 0 {
                state = .hover
                timer = 2
                target = pos
            }
        case .onFinger:
            let f = lake.finger
            // Lifts off as soon as the finger moves.
            if !cursor.present || cursor.speed > 40 || !f.valid || timer <= 0 {
                state = .dart
                target = pos + V3(rnd(-0.6, 0.6), rnd(0.2, 0.5), rnd(-0.6, 0.6))
                vel = V3(0, 0.6, 0)
                timer = 3
                break
            }
            pos = f.point + V3(0, 0.012, 0)
            vel = .zero
        }

        let perched = state == .perched || state == .onFinger
        if !perched {
            pos += vel * dt
            pos.y = max(pos.y, state == .toFinger ? 0.005 : 0.05)
            let b = lake.dragonflyBounds
            let hw = b.halfWidth(-pos.z) * 1.1
            if abs(pos.x) > hw { pos.x = pos.x > 0 ? hw : -hw }
            pos.z = clamp(pos.z, b.far - 2, b.near + 1)
            if hypot(vel.x, vel.z) > 0.15 { heading = lerpAngle(heading, atan2(-vel.z, vel.x), min(1, dt * 6)) }
        } else if state == .onFinger {
            let eye = lake.cameraPosition
            heading = lerpAngle(heading, atan2(-(eye.z - pos.z), eye.x - pos.x), min(1, dt * 2))
        }
        flying = lerp(flying, perched ? 0 : 1, min(1, dt * 8))
        // Wingbeat around 30 Hz: far too fast to resolve, so the ghosts carry the blur; the beat
        // phase just needs to keep moving.
        beat = (beat + dt * TAU * 30 * flying).truncatingRemainder(dividingBy: TAU)
        let pitch: Float = perched ? -0.15 : clamp(-vel.y * 0.15, -0.4, 0.4)
        model = compose(pos, quatAxis(heading, 0, 1, 0) * quatAxis(pitch, 0, 0, 1))
    }

    func drawBody(_ ctx: DrawContext) {
        let p = DragonflyParts.shared
        func part(_ hex: String, _ r: Float, _ m: Float) -> StdParams {
            StdParams(model: model, color: RGBA(hex: hex).linear, roughness: r, metalness: m)
        }
        Std.draw(ctx, p.thorax, part(kind.thorax, 0.35, 0.3))
        Std.draw(ctx, p.abdomen, part(kind.abdomen, 0.3, 0.35))
        Std.draw(ctx, p.bands, part(kind.bands, 0.4, 0.2))
        Std.draw(ctx, p.eyes, part(kind.eyes, 0.15, 0.4))
    }

    func drawWings(_ ctx: DrawContext) {
        let p = DragonflyParts.shared, e = ctx.encoder
        var w = WingParams(model: model * simd_float4x4(translation: V3(0.001, 0.004, 0)), motion: V4(flying, beat, 0, 0), tint: V4(kind.wingTint, 0))
        e.setVertexBytes(&w, length: MemoryLayout<WingParams>.stride, index: 2)
        e.setFragmentBytes(&w, length: MemoryLayout<WingParams>.stride, index: 1)
        e.drawIndexedPrimitives(type: .triangle, indexCount: p.wingIndexCount, indexType: .uint32, indexBuffer: p.wingIndices, indexBufferOffset: 0)
    }
}

final class Dragonflies {
    private unowned let lake: Lake
    private(set) var list: [Dragonfly] = []

    init(lake: Lake, count: Int) {
        self.lake = lake
        setCount(count)
    }

    func setCount(_ n: Int) {
        while list.count > n { list.removeLast() }
        while list.count < n {
            let d = Dragonfly(kind: kinds.randomElement()!)
            d.pos = d.pickWaypoint(lake)
            d.target = d.pos
            list.append(d)
        }
    }

    func update(dt: Float) {
        // The nearest free dragonfly is the one that may come to the finger, if the fingertip is
        // held over their own stretch of water.
        lake.fingerPercher = nil
        let b = lake.dragonflyBounds, fp = lake.finger.point
        if lake.finger.valid && fp.z > b.far - 1 && fp.z < b.near + 1 && abs(fp.x) < b.halfWidth(-fp.z) * 1.1 && fp.y < 2.5 {
            var best: Dragonfly?, bd = Float.infinity
            for d in list {
                if d.state == .onFinger { best = d; break }
                if d.state != .hover && d.state != .toFinger { continue }
                let dist = d.pos.distance(to: fp)
                if dist < bd && dist < 12 {
                    bd = dist
                    best = d
                }
            }
            lake.fingerPercher = best
        }
        for d in list { d.update(dt: dt, lake: lake) }
    }

    func drawBodies(_ ctx: DrawContext) {
        guard ctx.pass != .refraction else { return }
        Std.begin(ctx)
        for d in list { d.drawBody(ctx) }
    }

    /// The wings blend, so they are drawn after everything opaque.
    func drawWings(_ ctx: DrawContext) {
        guard ctx.pass != .refraction else { return }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("wingVertex", "wingFragment", blend: .alpha, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(DragonflyParts.shared.wingVertices, offset: 0, index: 0)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(DragonflyParts.shared.wingTexture, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        for d in list { d.drawWings(ctx) }
    }
}
