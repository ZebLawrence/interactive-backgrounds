import SceneKit
import simd

/// A species' eyes: one eyeball mesh (looking along +z, a slight corneal bulge over the iris) shared
/// by both eyes, a painted iris texture, and where each eye sits on the head.
struct EyeModel {
    /// One eye's placement in model space (world units).
    struct Socket {
        let center: V3
        /// Resting gaze: out to the side, a little forward and up.
        let neutral: V3
        /// Unit vectors across the gaze: toward the nose, and up.
        let fore: V3
        let up: V3
        /// Turns the eyeball mesh (+z) to the resting gaze.
        let base: simd_quatf
    }

    let geometry: SCNGeometry
    /// Model-space x of the eyes (world units), so they can follow the swim wave.
    let x: Float
    let radius: Float
    let sockets: [Socket]
    /// How far an eye can swivel from rest (radians); up/down is about half of this.
    let reach: Float

    init(species s: Species, body: FishBody, unit u: Float) {
        let isShark = s.shape == .shark
        let ex = Float(s.length / 2 - 0.17 * s.length)
        let section = body.section(atX: ex)
        let er = Float(max(1.9, min(s.length * 0.075, s.height / 2 * 0.34)) * s.eyeScale)
        // A little above the middle of the head, sunk into the flank so a domed cap shows.
        let mid = (section.top - section.bottom) / 2
        let half = (section.top + section.bottom) / 2
        let ey = mid + 0.3 * half
        let rel = (ey - mid) / max(half, 1e-3)
        let surface = section.halfWidth * (1 - rel * rel).squareRoot()
        let ez = max(surface - 0.4 * er, 0.5 * er)
        x = ex * u
        radius = er * u
        reach = isShark ? 0.3 : 0.55

        sockets = [1, -1].map { (side: Float) in
            let n = V3(0.3, 0.08, side).normalized
            let fore = (V3(1, 0, 0) - n * n.x).normalized
            let up = simd_cross(n, fore) * (simd_cross(n, fore).y >= 0 ? 1 : -1)
            return Socket(center: V3(ex, ey, ez * side) * u, neutral: n, fore: fore, up: up,
                          base: simd_quatf(from: V3(0, 0, 1), to: n))
        }

        // Unit eyeball looking along +z. The iris texture is projected straight on from the front
        // (texture radius 0.5 = the eye's silhouette); the back just shows the outer rim colour.
        var sphere = Mesh.icosphere(subdivisions: 3)
        sphere.uvs = sphere.positions.map { p in
            let xy = p.z > 0 ? V2(p.x, p.y) : simd_normalize(V2(p.x, p.y) + V2(1e-4, 0))
            return V2(0.5 + xy.x * 0.5, 0.5 - xy.y * 0.5)
        }
        // The cornea bulges a little over the iris.
        sphere.positions = sphere.positions.map { p in
            let t = clamp((p.z - 0.55) / 0.45, 0, 1)
            return p * (1 + 0.14 * t * t * (3 - 2 * t))
        }
        sphere.computeNormals()
        geometry = sphere.geometry()

        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = EyeModel.iris(s)
        mat.roughness.contents = isShark ? 0.25 : 0.4
        // A wet, glassy cornea over the matte iris.
        mat.clearCoat.contents = 1
        mat.clearCoatRoughness.contents = 0.03
        geometry.materials = [mat]
    }

    /// The front of the eye: black pupil, a coloured iris with radial fibres, a bright ring at the
    /// pupil and a gold or silver one at its edge. A shark's is nearly all black.
    static func iris(_ s: Species) -> CGImage {
        let isShark = s.shape == .shark
        let size: CGFloat = 64, c = CGPoint(x: 32, y: 32), r: CGFloat = 32
        let iris = r * 0.8, pupil = r * (isShark ? 0.5 : 0.42)
        let warm = s.eye.r >= s.eye.b
        let ring = isShark ? RGBA(0.16, 0.18, 0.17) : (warm ? RGBA(0.95, 0.78, 0.38) : RGBA(0.86, 0.90, 0.92))
        // Beyond the iris the eyeball is mostly hidden in the head; tint it like the skin around it.
        let rim = isShark ? s.top.darker(0.5) : s.mid.darker(0.55)
        return Art.image(size: CGSize(width: size, height: size), scale: 1) { ctx in
            ctx.setFillColor(rim.cg)
            ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
            // Iris: lighter near the pupil, darker toward the edge.
            let base = isShark ? RGBA(0.07, 0.08, 0.08) : s.eye
            Art.radial(ctx, [base.lighter(0.1), base.darker(0.25), base.darker(0.65)], [0.45, 0.7, 1], center: c, radius: iris)
            ctx.saveGState()
            ctx.addEllipse(in: CGRect(x: c.x - iris, y: c.y - iris, width: iris * 2, height: iris * 2))
            ctx.clip()
            ctx.setLineCap(.round)
            for i in 0..<70 {
                let a = CGFloat(i) / 70 * 2 * .pi + rand(-0.03...0.03)
                let r0 = pupil + rand(0...2), r1 = iris * rand(0.7...1)
                let light = Bool.random()
                ctx.setStrokeColor((light ? base.lighter(0.45) : base.darker(0.55)).alpha(rand(0.15...0.45)).cg)
                ctx.setLineWidth(rand(0.6...1.4))
                ctx.move(to: CGPoint(x: c.x + cos(a) * r0, y: c.y + sin(a) * r0))
                ctx.addLine(to: CGPoint(x: c.x + cos(a) * r1, y: c.y + sin(a) * r1))
                ctx.strokePath()
            }
            ctx.restoreGState()
            // Limbal ring and pupillary ring.
            ctx.setStrokeColor(ring.alpha(isShark ? 0.6 : 0.9).cg)
            ctx.setLineWidth(2.2)
            ctx.strokeEllipse(in: CGRect(x: c.x - iris + 1, y: c.y - iris + 1, width: iris * 2 - 2, height: iris * 2 - 2))
            if !isShark {
                ctx.setStrokeColor(ring.lighter(0.3).cg)
                ctx.setLineWidth(2)
                let pr = pupil + 1.2
                ctx.strokeEllipse(in: CGRect(x: c.x - pr, y: c.y - pr, width: pr * 2, height: pr * 2))
            }
            Art.radial(ctx, [RGBA(0.02, 0.03, 0.05), RGBA(0.005, 0.005, 0.01)], center: c, radius: pupil)
        }
    }
}

/// One fish's eyes. Each eye swivels on its own toward whatever catches its attention (a hunting
/// shark, food, the cursor) if it's on that eye's side; otherwise it rests, with a slow drift and
/// the odd quick glance. Moves are saccades: a fast jump, then a hold or slow pursuit.
final class EyeRig {
    let node: SCNNode
    private let model: EyeModel
    private let eyes: [Eye]
    /// How readily this fish watches the cursor.
    private let interest = rnd(0...1)
    private var clock = rnd(0...100)

    private final class Eye {
        let node: SCNNode
        let socket: EyeModel.Socket
        /// Gaze as (toward the nose, up) angles from rest: where it is, and where it's heading.
        var gaze = V2.zero
        var aim = V2.zero
        var glance = V2.zero
        var glanceTimer = rnd(0.5...3)
        let drift = V2(rnd(0...(2 * .pi)), rnd(0...(2 * .pi)))

        init(node: SCNNode, socket: EyeModel.Socket) {
            self.node = node
            self.socket = socket
        }
    }

    init(model: EyeModel, parent: SCNNode) {
        self.model = model
        let node = SCNNode()
        self.node = node
        eyes = model.sockets.map { socket in
            let eye = SCNNode(geometry: model.geometry)
            eye.castsShadow = false
            eye.simdPosition = socket.center
            eye.simdScale = V3(repeating: model.radius)
            eye.simdOrientation = socket.base
            node.addChildNode(eye)
            return Eye(node: eye, socket: socket)
        }
        parent.addChildNode(node)
    }

    /// Called every frame. `lateral` is the head's sideways swim offset at the eyes, so they stay
    /// on the body as it bends.
    func update(dt: Float, fish: Fish, tank: Tank, lateral: Float) {
        node.simdPosition = V3(0, 0, lateral)
        clock += dt
        let target = lookTarget(fish: fish, tank: tank).map { node.simdConvertPosition($0, from: nil) }
        let limit = V2(model.reach, model.reach * 0.5)
        for eye in eyes {
            let s = eye.socket
            var want: V2?
            if let t = target {
                let d = (t - s.center).normalized
                let dn = simd_dot(d, s.neutral)
                // Only if it's on this eye's side; a clamped direction keeps the eye turned "as far
                // as it goes" toward targets beyond its reach.
                if dn > -0.1 {
                    let a = V2(atan2(simd_dot(d, s.fore), dn), atan2(simd_dot(d, s.up), dn))
                    let e = a / limit
                    want = simd_length(e) > 1 ? a / simd_length(e) : a
                }
            }
            if want == nil {
                eye.glanceTimer -= dt
                if eye.glanceTimer <= 0 {
                    // Mostly glance fore/aft, and come back to rest between glances.
                    eye.glance = eye.glance == .zero && Float.random(in: 0...1) < 0.7
                        ? V2(rnd(-0.6...0.6), rnd(-0.3...0.3)) * limit : .zero
                    eye.glanceTimer = eye.glance == .zero ? rnd(1...4) : rnd(0.4...1.5)
                }
                let drift = V2(sin(clock * 0.31 + eye.drift.x), sin(clock * 0.19 + eye.drift.y)) * limit * 0.15
                want = eye.glance + drift
            }
            // Saccade to big changes; follow small ones slowly (smooth pursuit / lazy drift).
            let err = want! - eye.aim
            if simd_length(err) > 0.09 {
                eye.aim = want!
            } else {
                eye.aim += err * min(1, dt * 2.5)
            }
            eye.gaze += (eye.aim - eye.gaze) * min(1, dt * 25)
            let dir = (s.neutral + s.fore * tan(eye.gaze.x) + s.up * tan(eye.gaze.y)).normalized
            eye.node.simdOrientation = simd_quatf(from: s.neutral, to: dir) * s.base
        }
    }

    /// The world point this fish is most interested in, if any.
    private func lookTarget(fish: Fish, tank: Tank) -> V3? {
        if let shark = tank.shark {
            if shark.body === fish {
                if case .hunting(let prey, _) = shark.state { return prey.pos }
                return nil
            }
            if case .hunting = shark.state, simd_distance(fish.pos, shark.pos) < shark.body.model.length * 1.6 {
                return (shark.pos + shark.body.nose) / 2
            }
        }
        if let food = tank.nearestFood(to: fish.pos, within: 4) { return food.pos }
        let c = tank.cursor
        if c.present {
            let reach: CGFloat = c.stillTime > 0.5 ? 220 + 260 * CGFloat(interest) : 150
            if tank.screenDistance(fish.pos, c.screen) < reach {
                // Where the cursor appears: its line of sight, a little in front of the fish.
                let onRay = tank.closestPointOnCursorRay(fish.pos)
                return onRay + (V3(0, 0, tank.eyeDistance) - onRay).normalized * 1.5
            }
        }
        return nil
    }
}
