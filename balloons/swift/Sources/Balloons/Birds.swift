import Metal
import simd

/// A flock of swallows over the hillside: boids that scatter from a fast cursor and wheel around a
/// resting one, drawn as one instanced mesh with wings that flap in the shader.
final class Flock {
    private struct Bird { var pos: V3; var vel: V3; let phase: Float; let flapRate: Float }

    private var birds: [Bird] = []
    private let template: MTLBuffer
    private let vertexCount: Int
    private let instances: FrameRing

    init(count: Int) {
        var base = V3(rnd(-60, 60), 0, rnd(-140, -90))
        base.y = groundHeight(base.x, base.z) + 60
        for _ in 0..<count {
            birds.append(Bird(pos: base + V3(rnd(-25, 25), rnd(-10, 10), rnd(-25, 25)),
                              vel: V3(rnd(-1, 1), rnd(-0.2, 0.2), rnd(-1, 1)).normalized * 9,
                              phase: rnd(0, TAU), flapRate: rnd(9, 13)))
        }
        // A bird: a body and two wings, built from triangles. w is 0 on the body and ±1 at a wing tip.
        var tmpl: [V4] = []
        func tri(_ a: V3, _ b: V3, _ c: V3, _ w: V3) {
            tmpl += [V4(a, w.x), V4(b, w.y), V4(c, w.z)]
        }
        tri(V3(0, 0, 0.55), V3(-0.1, 0, -0.35), V3(0.1, 0, -0.35), V3(0, 0, 0))
        tri(V3(-0.08, 0, 0.25), V3(-0.08, 0, -0.12), V3(-0.8, 0.02, -0.02), V3(0, 0, -1))
        tri(V3(0.08, 0, 0.25), V3(0.8, 0.02, -0.02), V3(0.08, 0, -0.12), V3(0, 1, 0))
        tri(V3(-0.1, 0, -0.35), V3(-0.22, 0, -0.62), V3(0.0, 0, -0.5), V3(0, 0, 0))
        tri(V3(0.1, 0, -0.35), V3(0.0, 0, -0.5), V3(0.22, 0, -0.62), V3(0, 0, 0))
        template = GPU.shared.buffer(tmpl)
        vertexCount = tmpl.count
        instances = FrameRing(length: count * 2 * MemoryLayout<V4>.stride)
    }

    func update(dt: Float, valley: Valley) {
        let cursor = valley.cursor
        var centre = V3.zero
        for b in birds { centre += b.pos }
        centre /= Float(birds.count)
        let ground = groundHeight(centre.x, centre.z)
        // A resting cursor draws the flock to wheel around the point 130 m out along its line of sight.
        var attractor: V3?
        if cursor.present && cursor.stillTime > 1.2 {
            let (origin, dir) = valley.ray(cursor.screen)
            var a = origin + dir * 130
            a.y = max(a.y, groundHeight(a.x, a.z) + 20)
            attractor = a
        }
        let fast = cursor.present && cursor.speed > 400
        for i in birds.indices {
            var b = birds[i]
            var acc = V3.zero
            var near = 0
            var coh = V3.zero, ali = V3.zero, sep = V3.zero
            for (j, o) in birds.enumerated() where j != i {
                let d = b.pos.distance(to: o.pos)
                if d > 18 { continue }
                near += 1
                coh += o.pos
                ali += o.vel
                if d < 5 { sep += (b.pos - o.pos) * ((5 - d) / max(d, 0.1)) }
            }
            if near > 0 {
                acc += (coh / Float(near) - b.pos) * 0.12
                acc += (ali / Float(near) - b.vel) * 0.6
                acc += sep * 4
            }
            // Keep to the air over the hillside.
            let lo = ground + 25, hi = ground + 130
            if b.pos.y < lo { acc.y += (lo - b.pos.y) * 0.6 }
            if b.pos.y > hi { acc.y -= (b.pos.y - hi) * 0.6 }
            let lim: Float = 220
            if abs(b.pos.x) > lim { acc.x -= (b.pos.x > 0 ? 1 : -1) * (abs(b.pos.x) - lim) * 0.15 }
            if b.pos.z > -50 { acc.z -= (b.pos.z + 50) * 0.15 }
            if b.pos.z < -360 { acc.z += (-360 - b.pos.z) * 0.15 }
            // The cursor: wheel around a resting one, scatter from a fast one.
            if let attractor {
                let to = attractor - b.pos
                let dist = to.length
                let tangent = V3(0, 1, 0).cross(to).normalized
                acc += to.normalized * clamp((dist - 25) * 0.12, -4, 4)
                acc += tangent * 3
            }
            if fast {
                let scr = valley.project(b.pos)
                let dpx = Float(hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y))
                let radius = (160 + min(Float(cursor.speed), 2500) * 0.1) / (1 + scr.depth / 200)
                if dpx < radius { acc += (b.pos - valley.closestPointOnCursorRay(b.pos)).normalized * 40 }
            }
            // A little wander so the flock never settles into a lattice.
            acc += V3(rnd(-1, 1), rnd(-0.4, 0.4), rnd(-1, 1)) * 2.5
            b.vel += acc * dt
            // Never dive or climb vertically: the wings need a horizontal heading.
            let horiz = hypot(b.vel.x, b.vel.z)
            if horiz < 2 { b.vel.x += (b.vel.x >= 0 ? 2 : -2) - b.vel.x * 0.5 }
            b.vel.y = clamp(b.vel.y, -0.6 * max(horiz, 2), 0.6 * max(horiz, 2))
            let speed = b.vel.length
            if speed > 16 { b.vel *= 16 / speed }
            if speed < 7 { b.vel *= 7 / max(speed, 0.01) }
            b.pos += b.vel * dt
            birds[i] = b
        }
    }

    func draw(_ ctx: DrawContext) {
        let buf = instances[ctx.slot]
        let p = buf.contents().assumingMemoryBound(to: V4.self)
        for (i, b) in birds.enumerated() {
            p[i * 2] = V4(b.pos, b.phase)
            p[i * 2 + 1] = V4(b.vel, b.flapRate)
        }
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("birdVertex", "birdFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthWrite)
        e.setVertexBuffer(template, offset: 0, index: 0)
        e.setVertexBuffer(buf, offset: 0, index: 1)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 2)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: vertexCount, instanceCount: birds.count)
    }
}
