import CoreGraphics
import Metal

/// The visible extent of the meadow, for laying things out.
struct Layout {
    /// Half the width of the meadow in view `d` metres out.
    let halfWidth: (Float) -> Float
    /// The screen area relative to a laptop display (1512 x 982 points).
    let area: Float
}

/// The grass: tens of thousands of instanced blades that sway in the wind, part around the cursor
/// and spring back along its trail, plus wildflowers scattered among them. Everything moves on the
/// GPU; the CPU only places the instances once.
final class GrassField {
    private let layout: Layout

    private let bladeTemplate: MTLBuffer
    private let bladeIndices: MTLBuffer
    private let bladeIndexCount: Int
    private let blades: MTLBuffer
    let bladeCount: Int
    private let bladeSurface: MTLTexture

    private let flowerTemplate: MTLBuffer
    private let flowerIndices: MTLBuffer
    private let flowerIndexCount: Int
    private let flowers: MTLBuffer
    private let flowerCount: Int
    private let flowerAtlas: MTLTexture

    init(layout: Layout) {
        self.layout = layout
        let gpu = GPU.shared

        // Blades: a strip of 4 quads narrowing to a point; x runs -0.5...0.5, y is t in 0...1.
        let rows = 4
        var tmpl: [V2] = [], idx: [UInt16] = []
        for r in 0...rows {
            let t = Float(r) / Float(rows)
            tmpl += [V2(-0.5, t), V2(0.5, t)]
        }
        for r in 0..<rows {
            let a = UInt16(r * 2), b = a + 1, c = a + 2, d = a + 3
            idx += [a, b, c, b, d, c]
        }
        bladeTemplate = gpu.buffer(tmpl)
        bladeIndices = gpu.buffer(idx)
        bladeIndexCount = idx.count

        let table = GrassField.distanceTable(layout)
        let count = Int(min(table.cdf[table.bins], 90000).rounded())
        var inst: [V4] = []
        inst.reserveCapacity(count * 2)
        for _ in 0..<count {
            let d = GrassField.sampleDistance(table)
            let hw = layout.halfWidth(d)
            let x = rnd(-hw, hw), z = -d
            // Clumpy: height follows a slow noise so the meadow has tussocks and hollows.
            let clump = 0.5 + 0.5 * sin(x * 0.9 + z * 0.4) * cos(x * 0.3 - z * 0.8 + 1.0)
            let h = rnd(0.35, 0.75) * (0.75 + 0.5 * clump) * (1 + d / 30)
            inst.append(V4(x, groundHeight(x, z) - 0.02, z, h))
            inst.append(V4(rnd(0.018, 0.034) * (1 + d / 20), rnd(0, TAU), rnd(0, TAU), Float.random(in: 0..<1)))
        }
        blades = gpu.buffer(inst)
        bladeCount = count
        bladeSurface = gpu.texture(GrassField.bladeSurfaceImage(), srgb: false)

        // Flowers: two crossed strips, stem and head in one texture cell.
        var ftmpl: [V4] = [], fidx: [UInt16] = []
        var n: UInt16 = 0
        for yaw in [Float(0), Float.pi / 2] {
            let c = cos(yaw), s = sin(yaw)
            for t in [Float(0), 0.55, 0.8, 1] {
                for x in [Float(-0.5), 0.5] { ftmpl.append(V4(x * c, t, x * s, x + 0.5)) }
            }
            for r in 0..<3 {
                let a = n + UInt16(r * 2), b = a + 1, c2 = a + 2, d = a + 3
                fidx += [a, b, c2, b, d, c2]
            }
            n += 8
        }
        flowerTemplate = gpu.buffer(ftmpl)
        flowerIndices = gpu.buffer(fidx)
        flowerIndexCount = fidx.count

        let fcount = Int((150 * clamp(layout.area, 0.6, 2.2)).rounded())
        var finst: [V4] = []
        for i in 0..<fcount {
            // Flowers only where they can be seen: in the nearer meadow, in loose drifts.
            let d = 0.8 + 16 * pow(Float.random(in: 0..<1), 1.5)
            let hw = layout.halfWidth(d)
            let drift = Int.random(in: 0..<7)
            let cx = sin(Float(drift) * 2.1) * hw * 0.8
            let x = clamp(cx + rnd(-3, 3), -hw, hw), z = -d
            let kind = (drift + i) % 4
            let h = [Float(0.42), 0.33, 0.3, 0.6][kind] * rnd(0.85, 1.2) * (1 + d / 40)
            finst.append(V4(x, groundHeight(x, z) - 0.02, z, h))
            finst.append(V4(h * 0.5, rnd(0, TAU), rnd(0, TAU), Float(kind)))
        }
        flowers = gpu.buffer(finst)
        flowerCount = fcount
        flowerAtlas = gpu.texture(GrassField.flowerAtlasImage(), srgb: true)
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setDepthStencilState(gpu.depthWrite)
        e.setRenderPipelineState(gpu.pipeline("bladeVertex", "bladeFragment", samples: ctx.samples))
        e.setVertexBuffer(bladeTemplate, offset: 0, index: 0)
        e.setVertexBuffer(blades, offset: 0, index: 1)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 2)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(bladeSurface, index: 0)
        e.setFragmentSamplerState(gpu.repeatSampler, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: bladeIndexCount, indexType: .uint16, indexBuffer: bladeIndices,
                                indexBufferOffset: 0, instanceCount: bladeCount)

        e.setRenderPipelineState(gpu.pipeline("flowerVertex", "flowerFragment", samples: ctx.samples))
        e.setVertexBuffer(flowerTemplate, offset: 0, index: 0)
        e.setVertexBuffer(flowers, offset: 0, index: 1)
        e.setFragmentTexture(flowerAtlas, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: flowerIndexCount, indexType: .uint16, indexBuffer: flowerIndices,
                                indexBufferOffset: 0, instanceCount: flowerCount)
    }

    // MARK: - Placement

    struct DistanceTable { let near: Float; let far: Float; let bins: Int; let cdf: [Float] }

    /// Blades thin out with distance, where they're too small to see anyway.
    static func distanceTable(_ layout: Layout) -> DistanceTable {
        let near: Float = 0.5, far: Float = 48, bins = 600
        var cdf: [Float] = [0]
        for i in 1...bins {
            let d = near + (far - near) * Float(i) / Float(bins)
            let density = 300 / (1 + pow(d / 4.5, 2))
            cdf.append(cdf[i - 1] + density * 2 * layout.halfWidth(d) * (far - near) / Float(bins))
        }
        return DistanceTable(near: near, far: far, bins: bins, cdf: cdf)
    }

    static func sampleDistance(_ t: DistanceTable) -> Float {
        let u = Float.random(in: 0..<1) * t.cdf[t.bins]
        var lo = 0, hi = t.bins
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1
            if t.cdf[mid] < u { lo = mid } else { hi = mid }
        }
        let f = (u - t.cdf[lo]) / max(t.cdf[hi] - t.cdf[lo], 1e-9)
        return t.near + (t.far - t.near) * (Float(lo) + f) / Float(t.bins)
    }

    // MARK: - Images

    /// The surface of a blade, tiling along its length: a grooved midrib with raised edges, parallel
    /// veins that wander a little, and fine longitudinal streaks. Grey level is height; the shader
    /// reads it for colour and tilts the normal across the blade from its slope.
    static func bladeSurfaceImage() -> Canvas {
        let w = 128, h = 512
        let c = Canvas(w, h)
        let tau = Double.pi * 2
        c.setPixels { x, y in
            // Streaks: noise stretched along the blade, tileable top to bottom.
            let ang = Double(y) / Double(h) * tau
            let streak = fbm2(Double(x) * 0.09, cos(ang) * 1.5, 3) * 0.6 + fbm2(Double(x) * 0.25 + 9, sin(ang) * 1.5 + 4, 2) * 0.4
            let v = (0.42 + 0.3 * streak) * 255
            return (v, v, v)
        }
        let W = Double(w), H = Double(h)
        // Veins: raised lines either side of the midrib, each wandering slightly, with a shadow.
        c.ctx.setLineCap(.round)
        for k in -4...4 where k != 0 {
            let x0 = W / 2 + Double(k) * W * 0.1
            let odd = abs(k) % 2 == 1
            func path(_ dx: Double) {
                c.ctx.beginPath()
                var first = true
                for y in stride(from: 0.0, through: H, by: 8) {
                    let p = CGPoint(x: x0 + dx + 1.5 * sin(y / H * tau * 2 + Double(k)), y: y)
                    if first { c.ctx.move(to: p); first = false } else { c.ctx.addLine(to: p) }
                }
            }
            c.stroke(RGBA(1, 1, 1, 0.55 + 0.3 * (odd ? 1 : 0)))
            c.ctx.setLineWidth(odd ? 2.2 : 3.0)
            path(0)
            c.ctx.strokePath()
            c.stroke(RGBA(0, 0, 0, 0.5))
            c.ctx.setLineWidth(1.6)
            path(2.4)
            c.ctx.strokePath()
        }
        // The midrib: a dark groove with a bright ridge each side.
        c.fill(RGBA(0, 0, 0, 0.7))
        c.fillRect(W / 2 - 3.5, 0, 7, H)
        c.fill(RGBA(1, 1, 1, 0.8))
        c.fillRect(W / 2 - 6, 0, 2.5, H)
        c.fillRect(W / 2 + 3.5, 0, 2.5, H)
        return c
    }

    /// An atlas of four wildflowers on stems: daisy, buttercup, clover and cow parsley.
    static func flowerAtlasImage() -> Canvas {
        let cell = 256.0, h = 512.0
        let c = Canvas(Int(cell * 4), Int(h))
        let ctx = c.ctx
        let tau = Double.pi * 2

        func stem(_ cx: Double, _ top: Double) {
            c.stroke(RGBA(hex: "#3a5a2a"))
            ctx.setLineWidth(7)
            ctx.setLineCap(.round)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: cx, y: h))
            ctx.addQuadCurve(to: CGPoint(x: cx, y: top), control: CGPoint(x: cx + 12, y: h * 0.6))
            ctx.strokePath()
            c.stroke(.bytes(120, 170, 90, 0.5))
            ctx.setLineWidth(2)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: cx - 2, y: h))
            ctx.addQuadCurve(to: CGPoint(x: cx - 2, y: top), control: CGPoint(x: cx + 10, y: h * 0.6))
            ctx.strokePath()
            // A leaf with a midrib.
            c.fill(RGBA(hex: "#3f6a2e"))
            c.fillEllipse(cx + 24, h * 0.72, 28, 10, -0.6)
            c.stroke(.bytes(160, 200, 120, 0.6))
            ctx.setLineWidth(1.5)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: cx + 2, y: h * 0.72 + 14))
            ctx.addLine(to: CGPoint(x: cx + 46, y: h * 0.72 - 14))
            ctx.strokePath()
        }

        /// Petals with veins running out from the base, and a darker base where they meet.
        func petals(_ cx: Double, _ cy: Double, _ n: Int, _ r: Double, _ len: Double, _ wide: Double, _ color: RGBA, _ vein: RGBA) {
            for i in 0..<n {
                let a = Double(i) / Double(n) * tau + Double(i % 2) * 0.08
                let px = cx + cos(a) * r, py = cy + sin(a) * r
                c.clipped(c.ellipsePath(px, py, len, len * wide, a)) {
                    c.radialGradient(CGPoint(x: cx, y: cy), r * 0.4, CGPoint(x: cx, y: cy), r + len, [(0, vein), (0.35, color), (1, color)])
                }
                // Three veins along the petal.
                c.stroke(vein)
                ctx.setLineWidth(1.2)
                for off in [-0.3, 0, 0.3] {
                    ctx.beginPath()
                    ctx.move(to: CGPoint(x: cx + cos(a) * r * 0.5, y: cy + sin(a) * r * 0.5))
                    let ex = px + cos(a) * len * 0.8 - sin(a) * len * wide * off
                    let ey = py + sin(a) * len * 0.8 + cos(a) * len * wide * off
                    ctx.addQuadCurve(to: CGPoint(x: ex, y: ey),
                                     control: CGPoint(x: px - sin(a) * len * wide * off * 0.6, y: py + cos(a) * len * wide * off * 0.6))
                    ctx.strokePath()
                }
            }
        }

        /// A disc of tiny florets, like a daisy's eye, spiralling outward.
        func disc(_ cx: Double, _ cy: Double, _ r: Double, _ colors: [String]) {
            c.fill(RGBA(hex: colors[0]))
            c.dot(cx, cy, r)
            for k in 0..<90 {
                let rr = r * 0.95 * (Double(k) / 90).squareRoot(), a = Double(k) * 2.39996
                c.fill(RGBA(hex: colors[1 + (k * 7) % (colors.count - 1)]))
                c.dot(cx + cos(a) * rr, cy + sin(a) * rr, r * 0.085 + rr * 0.04)
            }
        }

        // Daisy
        stem(cell * 0.5, 100)
        petals(cell * 0.5, 88, 15, 36, 32, 0.4, RGBA(hex: "#f2f0e4"), RGBA(hex: "#cfc9b2"))
        disc(cell * 0.5, 88, 20, ["#c9a52a", "#e8c23a", "#f0d35c", "#b8931f"])
        // Buttercup: glossy petals with a darker heart and a ring of stamens
        stem(cell * 1.5, 112)
        petals(cell * 1.5, 100, 5, 22, 30, 0.75, RGBA(hex: "#f4d23c"), RGBA(hex: "#d9a51a"))
        c.fill(RGBA(hex: "#b48a14"))
        c.dot(cell * 1.5, 100, 11)
        for k in 0..<18 {
            let a = Double(k) / 18 * tau, rr = 8 + Double(k % 2) * 4
            c.fill(RGBA(hex: k % 2 == 1 ? "#f7e27a" : "#8f6b0c"))
            c.dot(cell * 1.5 + cos(a) * rr, 100 + sin(a) * rr, 2.2)
        }
        // Clover: a ball of tiny florets, each with a pale tip
        stem(cell * 2.5, 116)
        for _ in 0..<60 {
            let a = rndD(0, tau), rr = Double.random(in: 0..<1).squareRoot() * 40
            let x = cell * 2.5 + cos(a) * rr, y = 96 + sin(a) * rr * 0.8
            c.fill(RGBA(hex: ["#b476c8", "#a265b8", "#c58ad6"].randomElement()!))
            c.fillEllipse(x, y, 11, 5, a)
            c.fill(.bytes(240, 215, 250, 0.85))
            c.fillEllipse(x + cos(a) * 6, y + sin(a) * 6, 4, 2.5, a)
        }
        // Cow parsley: an umbel of small white clusters on spokes
        stem(cell * 3.5, 96)
        for i in -3...3 {
            let x = cell * 3.5 + Double(i) * 26, y = 60 + Double(abs(i)) * 10
            c.stroke(RGBA(hex: "#4a6a34"))
            c.line(cell * 3.5, 96, x, y, width: 3)
            for _ in 0..<9 {
                let fx = x + rndD(-16, 16), fy = y + rndD(-10, 10)
                c.fill(RGBA(hex: ["#f4f2ea", "#e8e6dc", "#fbfaf5"].randomElement()!))
                c.dot(fx, fy, 6)
                c.fill(.bytes(200, 190, 150, 0.7))
                c.dot(fx, fy, 1.8)
            }
        }
        return c
    }
}
