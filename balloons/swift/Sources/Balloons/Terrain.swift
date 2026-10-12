import CoreGraphics
import Foundation
import Metal

/// What every part of the scene needs to draw itself into the frame.
struct DrawContext {
    let encoder: MTLRenderCommandEncoder
    /// The frame's shared uniforms (`Frame` in the shaders).
    let frame: MTLBuffer
    /// Multisample count of the scene pass (pipelines must match it).
    let samples: Int
    /// Which of the frames in flight this is, for per-frame buffers.
    let slot: Int
    /// The sun's shadow map, drawn earlier in the frame.
    let shadowMap: MTLTexture
}

/// Where the river runs: x as a function of z.
func riverX(_ z: Float) -> Float { 140 * sin(z / 520) + 60 * sin(z / 170 + 1.3) - 80 }

/// Height of the land at (x, z), in metres: the knoll the viewer stands on, rolling fields, the
/// river's dip, and foothills rising toward the mountains.
func groundHeight(_ x: Float, _ z: Float) -> Float {
    let d = hypot(x, z)
    let hill = 34 * exp(-pow(d / 115, 2)) + 12 * exp(-pow(d / 380, 2))
    let roll = Float(fbm2(Double(x / 400 + 3), Double(z / 400), 3) - 0.5) * 12
    let river = -5 * exp(-pow((x - riverX(z)) / 40, 2)) * clamp((-z - 150) / 100, 0, 1)
    let rise = max(0, -z - 2000)
    let foothills = rise * 0.18 + Float(fbm2(Double(x / 300), Double(z / 300 + 9), 3) - 0.5) * rise * 0.12
    return hill + roll + river + foothills
}

/// The land as one big displaced plane, painted from above with the valley's patchwork.
final class Ground {
    private let mesh: GPUMesh
    private let map: MTLTexture
    private let detail: MTLTexture

    init() {
        // PlaneGeometry(6000, 6000, 300, 300) laid flat and pushed out to z = -2800.
        let size: Float = 6000, segs = 300
        var m = MeshData()
        for iy in 0...segs {
            let z = -size / 2 + size * Float(iy) / Float(segs) - 2800
            for ix in 0...segs {
                let x = -size / 2 + size * Float(ix) / Float(segs)
                m.positions.append(V3(x, groundHeight(x, z), z))
                m.uvs.append(V2(Float(ix) / Float(segs), Float(iy) / Float(segs)))
            }
        }
        // Smooth normals from the triangles around each vertex.
        let row = UInt32(segs + 1)
        for iy in 0..<UInt32(segs) {
            for ix in 0..<UInt32(segs) {
                let a = iy * row + ix, b = a + 1, c = a + row, d = c + 1
                m.indices += [a, c, b, b, c, d]
            }
        }
        var normals = [V3](repeating: .zero, count: m.positions.count)
        for t in stride(from: 0, to: m.indices.count, by: 3) {
            let i0 = Int(m.indices[t]), i1 = Int(m.indices[t + 1]), i2 = Int(m.indices[t + 2])
            let p0 = m.positions[i0], p1 = m.positions[i1], p2 = m.positions[i2]
            let n = (p2 - p1).cross(p0 - p1)
            normals[i0] += n; normals[i1] += n; normals[i2] += n
        }
        m.normals = normals.map { $0.normalized }
        mesh = m.upload()
        map = GPU.shared.texture(Ground.valleyImage(), srgb: true)
        detail = GPU.shared.texture(Ground.grassDetailImage(), srgb: false)
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("groundVertex", "groundFragment", samples: ctx.samples))
        e.setDepthStencilState(gpu.depthWrite)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(map, index: 0)
        e.setFragmentTexture(detail, index: 1)
        e.setFragmentTexture(ctx.shadowMap, index: 2)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.setFragmentSamplerState(gpu.repeatSampler, index: 1)
        e.setFragmentSamplerState(gpu.shadowSampler, index: 2)
        mesh.draw(e)
    }

    /// The valley from above: fields, hedges, woods, a road, farms, and the river catching the sky.
    /// The canvas covers x in -3000...3000 and z from 200 (row 0) to -5800, as the web version draws it.
    static func valleyImage() -> Canvas {
        let S = 4096.0
        let c = Canvas(Int(S), Int(S))
        let ctx = c.ctx
        func px(_ x: Double) -> Double { (x + 3000) / 6000 * S }
        func pz(_ z: Double) -> Double { (200 - z) / 6000 * S }
        let greens = ["#3f6128", "#4a6c2e", "#557536", "#607f3e", "#73823e", "#8c7d3c", "#968646", "#807640", "#536f36", "#6b7d4a"]
        c.fill(RGBA(hex: "#4c6a32"))
        c.fillRect(0, 0, S, S)

        // Fields: a jittered grid of quads with hedgerows along their edges.
        let cell = 110.0
        let n = Int(6000 / cell)
        var nodes: [[CGPoint]] = []
        for j in 0...n {
            nodes.append((0...n).map { i in
                CGPoint(x: px(-3000 + Double(i) * cell + (hash2(Double(i), Double(j)) - 0.5) * cell * 0.6),
                        y: pz(200 - Double(j) * cell - (hash2(Double(j), Double(i) + 9) - 0.5) * cell * 0.6))
            })
        }
        let hedge = RGBA(hex: "#2f4a22")
        for j in 0..<n {
            for i in 0..<n {
                let q = [nodes[j][i], nodes[j][i + 1], nodes[j + 1][i + 1], nodes[j + 1][i]]
                let field = CGMutablePath()
                field.addLines(between: q)
                field.closeSubpath()
                c.fill(RGBA(hex: greens.randomElement()!))
                ctx.addPath(field)
                ctx.fillPath()
                var outline: CGPath = field
                // Ploughed fields show furrows. (As on the web, the hedge is then stroked along the
                // last furrow drawn rather than round the field.)
                if chance(0.15) {
                    let a = rndD(0, .pi)
                    c.clipped(field) {
                        c.stroke(.bytes(80, 60, 30, 0.35))
                        ctx.setLineWidth(1.2)
                        for k in stride(from: -80.0, to: 80, by: 4) {
                            c.line(q[0].x + cos(a) * k * 2 - sin(a) * 200, q[0].y + sin(a) * k * 2 + cos(a) * 200,
                                   q[0].x + cos(a) * k * 2 + sin(a) * 200, q[0].y + sin(a) * k * 2 - cos(a) * 200, width: 1.2)
                        }
                    }
                    let k = 76.0
                    let furrow = CGMutablePath()
                    furrow.move(to: CGPoint(x: q[0].x + cos(a) * k * 2 - sin(a) * 200, y: q[0].y + sin(a) * k * 2 + cos(a) * 200))
                    furrow.addLine(to: CGPoint(x: q[0].x + cos(a) * k * 2 + sin(a) * 200, y: q[0].y + sin(a) * k * 2 - cos(a) * 200))
                    outline = furrow
                }
                c.stroke(hedge)
                ctx.setLineWidth(2.2)
                ctx.addPath(outline)
                ctx.strokePath()
            }
        }

        // Woods: dark, lumpy copses.
        for _ in 0..<160 {
            let x = rndD(-3000, 3000), z = rndD(-5600, -250), r = rndD(30, 140)
            for _ in 0..<24 {
                c.fill(RGBA(hex: ["#2d4d26", "#35572c", "#294620", "#3a5f31"].randomElement()!))
                c.dot(px(x + rndD(-r, r)), pz(z + rndD(-r, r) * 0.7), rndD(8, 22))
            }
        }

        // The hill under the viewer is open meadow.
        let meadow = RGBA.bytes(78, 112, 50)
        let centre = CGPoint(x: px(0), y: pz(0))
        c.radialGradient(centre, 0, centre, 420 / 6000 * S, [(0, meadow), (0.7, meadow.alpha(0.9)), (1, meadow.alpha(0))])

        // A lane winding up the valley, with farms along it.
        func laneX(_ z: Double) -> Double { Double(riverX(Float(z))) + 160 + 50 * sin(z / 300) }
        c.stroke(RGBA(hex: "#b9ad94"))
        ctx.setLineWidth(2.5)
        ctx.setLineCap(.butt)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: px(laneX(-200)), y: pz(-200)))
        for z in stride(from: -240.0, to: -5800, by: -40) { ctx.addLine(to: CGPoint(x: px(laneX(z)), y: pz(z))) }
        ctx.strokePath()
        for _ in 0..<30 {
            let z = rndD(-5500, -300), x = laneX(z) + rndD(-40, 40)
            c.fill(RGBA(hex: ["#8a6a4e", "#a08264", "#6e5240"].randomElement()!))
            c.fillRect(px(x) - 3, pz(z) - 2, rndD(4, 8), rndD(3, 5))
        }

        // The river, bright with reflected sky, with a darker bank each side.
        ctx.setLineCap(.round)
        ctx.setLineJoin(.miter)
        for (w, col) in [(22.0, "#4d5a3f"), (14.0, "#cfc1b6"), (9.0, "#efe0d8")] {
            c.stroke(RGBA(hex: col))
            ctx.setLineWidth(w / 6000 * S)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: px(Double(riverX(-120))), y: pz(-120)))
            for z in stride(from: -140.0, to: -5800, by: -20) { ctx.addLine(to: CGPoint(x: px(Double(riverX(Float(z)))), y: pz(z))) }
            ctx.strokePath()
        }
        return c
    }

    /// A tileable grass detail map, multiplied into the ground close up.
    static func grassDetailImage() -> Canvas {
        let size = 512
        let c = Canvas(size, size)
        let tau = Double.pi * 2
        c.setPixels { x, y in
            let a = Double(x) / Double(size) * tau, b = Double(y) / Double(size) * tau
            let n = fbm2(cos(a) * 2 + cos(b) * 2, sin(a) * 2 + sin(b) * 2, 4)
            let v = 0.75 + 0.5 * n + (hash2(Double(x), Double(y)) - 0.5) * 0.15
            return (v * 235, v * 255, v * 215)
        }
        return c
    }
}
