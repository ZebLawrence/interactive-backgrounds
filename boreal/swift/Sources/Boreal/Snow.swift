import Foundation
import Metal
import simd

// Falling snow, and the clumps and powder that fall from shaken trees or fly up where an owl strikes.
//
// Real snowflakes fall at 0.5-1.5 m/s (dendrites are slowest), rocking and spiralling a few
// centimetres as they go, and follow the wind almost at once because they are so light. Snow
// dropped from a branch falls as clumps that break up into a drifting cloud of powder.

/// One point sprite: position and size in metres, opacity.
private struct Sprite { var p: V4; var a: V4 }

/// Per-frame sprite buffers, one per frame in flight, and the draw.
private final class SpriteBuffers {
    private let buffers: [MTLBuffer]
    let capacity: Int

    init(capacity: Int) {
        self.capacity = capacity
        buffers = (0..<FrameRing.count).map { _ in GPU.shared.buffer(length: capacity * MemoryLayout<Sprite>.stride) }
    }

    /// Fill this frame's buffer with `fill(pointer)` (returns how many) and draw them.
    func draw(_ ctx: DrawContext, color: V3, _ fill: (UnsafeMutablePointer<Sprite>) -> Int) {
        let buf = buffers[ctx.slot]
        let n = fill(buf.contents().bindMemory(to: Sprite.self, capacity: capacity))
        guard n > 0 else { return }
        var c = V4(color, 0)
        let e = ctx.encoder
        ctx.use("snowSpriteVertex", "snowSpriteFragment", blend: .alpha)
        e.setVertexBuffer(buf, offset: 0, index: 0)
        e.setFragmentBytes(&c, length: 16, index: 3)
        e.drawPrimitives(type: .point, vertexStart: 0, vertexCount: n)
    }
}

/// The colour of snow lit by the moon and the aurora (linear).
private func litSnow(_ light: Light, _ gain: Float) -> V3 {
    let m = light.moon
    return V3(0.11 + 0.5 * m * 0.65, 0.12 + 0.55 * m * 0.65, 0.16 + 0.7 * m * 0.65) * gain + light.aurora * (gain * 2.2)
}

final class Snowfall {
    private let count: Int
    private let ground: HeightFn
    // Flakes live in a box in front of the viewer, from the eye out to 45 m.
    private let boxX: Float = 26, boxZ0: Float = 1.5, boxZ1: Float = -46, boxY: Float = 16
    private var pos: [V3]
    private var vel: [V3]
    private var size: [Float]
    private var alpha: [Float]
    private var fall: [Float]
    /// Rocking rate, radius, phase.
    private var wob: [V3]
    private var base: [Float]
    /// 0..1, eased toward the setting.
    private(set) var amount: Float = 0
    private var t: Float = 0
    private let sprites: SpriteBuffers

    init(count: Int, ground: @escaping HeightFn) {
        self.count = count
        self.ground = ground
        pos = [V3](repeating: .zero, count: count)
        vel = [V3](repeating: .zero, count: count)
        size = [Float](repeating: 0, count: count)
        alpha = [Float](repeating: 0, count: count)
        fall = [Float](repeating: 0, count: count)
        wob = [V3](repeating: .zero, count: count)
        base = [Float](repeating: 0, count: count)
        sprites = SpriteBuffers(capacity: count)
        for i in 0..<count {
            respawn(i, anywhere: true)
            // Mostly single crystals and small aggregates of 3-8 mm; a few big clumped flakes.
            let big = chance(0.12)
            size[i] = big ? rnd(0.008, 0.016) : rnd(0.003, 0.008)
            fall[i] = big ? rnd(0.7, 1.0) : rnd(0.45, 0.85)
            wob[i] = V3(rnd(0.6, 1.6) * TAU, rnd(0.01, 0.05), rnd(0, TAU))
            base[i] = rnd(0.55, 1)
        }
    }

    /// Wider further out, so the box roughly fills the view.
    private func half(_ z: Float) -> Float { 3 + (boxX - 3) * clamp(-z / 40, 0, 1) }

    private func respawn(_ i: Int, anywhere: Bool) {
        let z = rnd(boxZ1, boxZ0)
        let h = half(z)
        pos[i] = V3(rnd(-h, h), anywhere ? rnd(0, boxY) : boxY + rnd(0, 2), z)
    }

    /// `air(x, y, z)` gives the air velocity at a point.
    func update(dt: Float, air: (Float, Float, Float) -> V3, snowing: Bool) {
        t += dt
        // Snow comes and goes in heavier and lighter spells.
        let spell = 0.55 + 0.45 * sin(t * 0.011) * sin(t * 0.0071 + 1.3)
        amount = approach(amount, snowing ? spell : 0, 8, dt)
        let active = amount
        // Light flakes follow the air within a fraction of a second.
        let relax = 1 - exp(-dt / 0.35)
        for i in 0..<count {
            // Flakes past the active fraction fade out where they are rather than popping.
            let on: Float = Float(i) / Float(count) < active ? 1 : 0
            alpha[i] = approach(alpha[i], on * base[i], 1.5, dt)
            if alpha[i] < 0.001 && on == 0 { continue }
            var p = pos[i]
            let a = air(p.x, p.y, p.z)
            var v = vel[i]
            v.x += (a.x - v.x) * relax
            v.z += (a.z - v.z) * relax
            v.y += (a.y - fall[i] - v.y) * relax
            vel[i] = v
            let w = wob[i].x, r = wob[i].y, ph = wob[i].z + t * w
            p.x += (v.x + cos(ph) * r * w) * dt
            p.y += v.y * dt
            p.z += (v.z + sin(ph) * r * w) * dt
            pos[i] = p
            let h = half(p.z) + 2
            if p.y < ground(p.x, p.z) || p.z > boxZ0 + 1 || p.z < boxZ1 - 1 || abs(p.x) > h + 2 || p.y > boxY + 4 {
                respawn(i, anywhere: false)
                // Re-enter on the upwind side if the wind blew it out sideways.
                if abs(pos[i].x) > h { pos[i].x = (pos[i].x > 0 ? -1 : 1) * h * 0.98 }
                alpha[i] = 0
            }
        }
    }

    func draw(_ ctx: DrawContext, light: Light) {
        sprites.draw(ctx, color: litSnow(light, 1.0)) { out in
            var n = 0
            for i in 0..<count where alpha[i] > 0.002 {
                out[n] = Sprite(p: V4(pos[i], size[i]), a: V4(alpha[i], 0, 0, 0))
                n += 1
            }
            return n
        }
    }
}

final class Puffs {
    private struct Puff {
        var live = false
        var p = V3(0, -100, 0), v = V3.zero
        var age: Float = 0, life: Float = 1, size: Float = 0, grow: Float = 0, a: Float = 0
        var clump = false, drag: Float = 1
    }

    private let max: Int
    private var p: [Puff]
    private var next = 0
    private(set) var liveCount = 0
    private let sprites: SpriteBuffers

    init(max: Int = 3000) {
        self.max = max
        p = [Puff](repeating: Puff(), count: max)
        sprites = SpriteBuffers(capacity: max)
    }

    private func spawn(_ o: Puff) {
        for n in 0..<max {
            let i = (next + n) % max
            if p[i].live { continue }
            var q = o
            q.live = true
            q.age = 0
            p[i] = q
            next = (i + 1) % max
            return
        }
    }

    /// Snow falling from a tree: clumps that drop and break, and a veil of powder.
    func treeShed(_ x: Float, _ y: Float, _ z: Float, r: Float, amount: Float, push: V2) {
        let clumps = Int(clamp((amount * 60).rounded(), 1, 10))
        for _ in 0..<clumps {
            let a = rnd(0, TAU), d = Float.random(in: 0..<1).squareRoot() * r
            spawn(Puff(p: V3(x + cos(a) * d, y + rnd(-0.5, 0.5), z + sin(a) * d),
                       v: V3(push.x * 0.4 + rnd(-0.2, 0.2), rnd(-0.6, 0), push.y * 0.4 + rnd(-0.2, 0.2)),
                       life: rnd(1.5, 3), size: rnd(0.04, 0.09), a: 0.95, clump: true, drag: 0.15))
        }
        let powder = Int(clamp((amount * 70).rounded(), 2, 14))
        for _ in 0..<powder {
            let a = rnd(0, TAU), d = Float.random(in: 0..<1).squareRoot() * r
            spawn(Puff(p: V3(x + cos(a) * d, y + rnd(-0.8, 0.8), z + sin(a) * d),
                       v: V3(push.x * 0.7 + rnd(-0.3, 0.3), rnd(-0.4, 0.1), push.y * 0.7 + rnd(-0.3, 0.3)),
                       life: rnd(3, 6.5), size: rnd(0.25, 0.6), grow: rnd(0.15, 0.35), a: rnd(0.04, 0.09), drag: 1.2))
        }
    }

    /// Powder thrown up by an owl's strike, or a few crystals tossed by a vole.
    func burst(_ x: Float, _ y: Float, _ z: Float, strength: Float, spread: Float = 0.35, dir: V3? = nil) {
        let n = Int((10 + strength * 70).rounded())
        for _ in 0..<n {
            let a = rnd(0, TAU), up = rnd(0.6, 2.2) * strength
            let out = rnd(0.2, 1.4) * strength
            let push = (dir ?? .zero) * strength
            spawn(Puff(p: V3(x + cos(a) * spread * Float.random(in: 0..<1), y + 0.02, z + sin(a) * spread * Float.random(in: 0..<1)),
                       v: V3(cos(a) * out + push.x, up, sin(a) * out + push.z),
                       life: rnd(1.5, 4) * (0.5 + strength), size: rnd(0.05, 0.25) * (0.4 + strength), grow: rnd(0.08, 0.25) * strength,
                       a: rnd(0.08, 0.2), drag: 1.6))
        }
    }

    func update(dt: Float, air: (Float, Float, Float) -> V3, ground: HeightFn) {
        var live = 0
        for i in 0..<max where p[i].live {
            live += 1
            var q = p[i]
            q.age += dt
            if q.age > q.life {
                p[i].live = false
                continue
            }
            let a = air(q.p.x, q.p.y, q.p.z)
            let k = 1 - exp(-dt * q.drag)
            q.v.x += (a.x - q.v.x) * k
            q.v.z += (a.z - q.v.z) * k
            // Clumps fall like small stones; powder settles slowly.
            q.v.y += q.clump ? -9.8 * dt : (-0.35 - q.v.y) * k
            q.p += q.v * dt
            let gy = ground(q.p.x, q.p.z)
            if q.p.y < gy {
                if q.clump {
                    // A clump bursts into a little powder where it lands.
                    p[i].live = false
                    if chance(0.5) {
                        spawn(Puff(p: V3(q.p.x, gy + 0.02, q.p.z), v: V3(rnd(-0.2, 0.2), rnd(0.1, 0.4), rnd(-0.2, 0.2)),
                                   life: rnd(1, 2), size: 0.08, grow: 0.12, a: 0.2, drag: 2))
                    }
                    continue
                }
                q.p.y = gy
                q.v.y = 0
            }
            q.size += q.grow * dt
            p[i] = q
        }
        liveCount = live
    }

    func draw(_ ctx: DrawContext, light: Light) {
        sprites.draw(ctx, color: litSnow(light, 0.5)) { out in
            var n = 0
            for q in p where q.live {
                let f = q.age / q.life
                let a = q.a * smoothstep(0, 0.08, f) * (1 - smoothstep(0.55, 1, f))
                if a < 0.001 { continue }
                out[n] = Sprite(p: V4(q.p, q.size), a: V4(a, 0, 0, 0))
                n += 1
            }
            return n
        }
    }
}

extension Shaders {
    static let snow = """

    // MARK: - Snow in the air: point sprites

    struct SpriteIn { float4 p; float4 a; };
    struct SpriteOut { float4 position [[position]]; float size [[point_size]]; float alpha; float blur; float dist; };

    vertex SpriteOut snowSpriteVertex(uint vid [[vertex_id]], device const SpriteIn* sprites [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        SpriteIn s = sprites[vid];
        float4 mv = F.view * float4(s.p.xyz, 1.0);
        float dist = max(-mv.z, 0.05);
        // Projected size in pixels; tiny flakes keep their light by growing fainter, not vanishing.
        float px = s.p.w * F.screen.z / dist;
        float shown = max(px, 1.6);
        float alpha = s.a.x * min(1.0, (px * px) / (shown * shown));
        // Flakes right in front of the eye are out of focus: bigger, softer, fainter.
        float defocus = sstep(2.5, 0.4, dist);
        shown *= 1.0 + defocus * 2.5;
        alpha *= 1.0 - defocus * 0.75;
        SpriteOut o;
        o.size = min(shown, 160.0);
        o.alpha = alpha;
        o.blur = defocus;
        o.dist = length(s.p.xyz - F.camera.xyz);
        o.position = F.proj * mv;
        return o;
    }

    fragment float4 snowSpriteFragment(SpriteOut in [[stage_in]], float2 pc [[point_coord]], constant Frame& F [[buffer(0)]],
                                       constant float4& color [[buffer(3)]]) {
        float2 p = pc - 0.5;
        float r = length(p) * 2.0;
        float a = mix(sstep(1.0, 0.35, r), sstep(1.0, 0.0, r) * 0.8, in.blur);
        if (a * in.alpha < 0.003) discard_fragment();
        return float4(color.rgb, a * in.alpha);
    }

    """
}
