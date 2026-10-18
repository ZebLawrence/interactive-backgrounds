import CoreGraphics
import Foundation
import Metal

// The bark, painted once at launch into textures rather than computed per pixel every frame, so
// the detail is the same resolution from the foot of a trunk to its crown and the hardware's
// mipmaps handle distance (no shimmer as the trunks sway). A port of the web version's bark.js.
//
// Three textures, all in metres:
// - the feature map: 1 m round by 4 m up, 1024 px per metre: the chalky mottle, the weathered
//   grey bands, lenticels in loose rows, the black eyes of shed branches with their pale raised
//   rims and dark tears, and the odd canker. Alpha is a height for the bump.
// - the detail tile: 20 cm square at 5 px per millimetre: the fine grain of the powdery bloom
//   (r), the grain of rough bark (g), vertical fibres (b) and a height (a). Tiles seamlessly.
// - the rough tile: 1 m round by 2 m up: the furrowed, plated bark of a trunk's foot, with the
//   crest height in alpha. Tiles seamlessly.
// Every trunk samples them at its own offset, and squeezed round its own circumference, so no
// two trunks show the same eyes.
//
// They are uploaded in the web version's row order (row 0 of the data is texture row 0, flipY
// off), so the shaders sample them at their uv directly.

/// Value noise on a lattice that wraps every `nx` x `ny` cells, so the result tiles.
@inline(__always) private func periodicNoise(_ x: Double, _ y: Double, _ nx: Int, _ ny: Int) -> Double {
    let xf = floor(x), yf = floor(y)
    let fx = x - xf, fy = y - yf
    let ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    let xi = Int(xf), yi = Int(yf)
    let k = Double(nx) * 0.37
    @inline(__always) func h(_ i: Int, _ j: Int) -> Double {
        let ii = ((i % nx) + nx) % nx, jj = ((j % ny) + ny) % ny
        let s = sin(Double(ii) * 127.1 + Double(jj) * 311.7 + k) * 43758.5453
        return s - floor(s)
    }
    return lerp(lerp(h(xi, yi), h(xi + 1, yi), ux), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), ux), uy)
}

/// Tiling fractal noise over a `w` x `h` metre tile, base frequency `f` cells per tile.
private func pfbm(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ f: Int, _ octaves: Int = 4) -> Double {
    var v = 0.0, amp = 0.5, sum = 0.0
    var fx = f, fy = max(1, Int((Double(f) * h / w).rounded()))
    for i in 0..<octaves {
        v += periodicNoise(x / w * Double(fx) + Double(i) * 3.1, y / h * Double(fy) + Double(i) * 7.7, fx, fy) * amp
        sum += amp
        amp *= 0.5
        fx *= 2
        fy *= 2
    }
    return v / sum
}

/// A byte as a Uint8ClampedArray stores it (rounded, clamped).
@inline(__always) private func clampedByte(_ v: Double) -> UInt8 { UInt8(clamp(v.rounded(.toNearestOrEven), 0, 255)) }
/// A byte as a Uint8Array stores it (truncated).
@inline(__always) private func truncByte(_ v: Double) -> UInt8 { UInt8(clamp(v, 0, 255)) }

final class BarkTextures {
    static let shared = BarkTextures()

    let feature: MTLTexture
    let detail: MTLTexture
    let rough: MTLTexture

    /// Feature map pixels per metre, and metres up per repeat of the feature map and the rough tile.
    static let px = 1024
    static let featH = 4
    static let roughH = 2

    private init() {
        let p = BarkTextures.paint()
        feature = GPU.shared.data(p.feature, width: BarkTextures.px, height: BarkTextures.px * BarkTextures.featH, srgb: true)
        detail = GPU.shared.data(p.detail, width: 1024, height: 1024, srgb: false)
        rough = GPU.shared.data(p.rough, width: BarkTextures.px, height: BarkTextures.px * BarkTextures.roughH, srgb: true)
    }

    struct Painted { let feature: [UInt8]; let detail: [UInt8]; let rough: [UInt8] }

    /// All three, RGBA bytes. The feature map and the rough tile draw on one seeded sequence, in
    /// the web version's order, so the eyes and plates land where they do there; the detail tile
    /// needs no random numbers and is painted alongside.
    static func paint() -> Painted {
        let rng = Seeded(90210)
        var detail: [UInt8] = []
        let group = DispatchGroup()
        DispatchQueue.global(qos: .userInitiated).async(group: group) { detail = paintDetail() }
        let feature = paintFeatures(rng)
        let rough = paintRough(rng)
        group.wait()
        return Painted(feature: feature, detail: detail, rough: rough)
    }

    /// Relief baked into the colour: the sky lights slopes that face up and leaves the undersides
    /// of rims and the floors of pits in shade, so the height shows even in flat light. `rgba` is
    /// shaded in place from the height in `hgt` (every fourth byte, mid grey flat); the map wraps.
    private static func reliefShade(_ rgba: UnsafeMutablePointer<UInt8>, _ hgt: UnsafePointer<UInt8>, _ W: Int, _ H: Int, _ k: Double,
                                    clamped: Bool) {
        nonisolated(unsafe) let hgt = hgt
        DispatchQueue.concurrentPerform(iterations: H) { j in
            @inline(__always) func hAt(_ i: Int, _ j: Int) -> Double {
                Double(hgt[((((j % H) + H) % H) * W + (((i % W) + W) % W)) * 4]) / 255
            }
            for i in 0..<W {
                // Light from above and a little from the left; slopes over three pixels.
                let dy = hAt(i, j - 2) - hAt(i, j + 2)
                let dx = hAt(i - 2, j) - hAt(i + 2, j)
                let h = hAt(i, j)
                var shade = 1 + k * (dy * 1.0 + dx * 0.25) - (0.5 - h) * 0.2
                shade = max(0.3, min(1.5, shade))
                let q = (j * W + i) * 4
                for c in 0..<3 {
                    let v = min(255, Double(rgba[q + c]) * shade)
                    rgba[q + c] = clamped ? clampedByte(v) : truncByte(v)
                }
            }
        }
    }

    // MARK: - The feature map

    private struct Wrinkle { let x, y, len, w: Double; let raised: Bool; let wave, bend, k: Double }
    private struct Lenticel { let x, y, len, ht, ang: Double }
    private struct Tear { let ox, wdt, L, a, b, jx, jy: Double }
    private struct Eye { let x, y, w, hh, tilt: Double; var tears: [Tear] }
    private struct Canker { let x, y: Double; let pts: [CGPoint]; let cracks: [(CGPoint, CGPoint)] }

    static func paintFeatures(_ rng: Seeded) -> [UInt8] {
        let W = px, H = px * featH
        let FH = Double(featH), PX = Double(px)
        let R = { (lo: Double, hi: Double) in lo + rng.next() * (hi - lo) }

        // The mottle, computed at a quarter resolution (it is soft) and scaled up.
        let mw = W / 4, mh = H / 4
        let mottle = Canvas(mw, mh)
        let md = mottle.data
        // White bark: a chalky white with only a breath of the green living bark and grey weathering.
        let cream = [0.90, 0.90, 0.88], green = [0.82, 0.84, 0.78], chalk = [0.97, 0.97, 0.96], grey = [0.80, 0.80, 0.79]
        DispatchQueue.concurrentPerform(iterations: mh) { j in
            let y = Double(j) / Double(mh) * FH
            let band = smoothstep(0.55, 0.85, pfbm(0.5, y, 1, FH, 1, 2) * 0.5 + pfbm(0.2, y, 1, FH, 2, 2) * 0.5)
            for i in 0..<mw {
                let x = Double(i) / Double(mw)
                let m1 = pfbm(x, y, 1, FH, 2, 4)
                let m2 = pfbm(x + 0.3, y + 1.1, 1, FH, 6, 4)
                let tg = smoothstep(0.3, 0.72, m1 * 0.6 + m2 * 0.4)
                let ch = smoothstep(0.45, 0.85, m2) * 0.5
                let tb = band * 0.6 * smoothstep(0.3, 0.7, m2)
                let q = (j * mw + i) * 4
                for k in 0..<3 {
                    var v = lerp(cream[k], green[k], tg)
                    v = lerp(v, chalk[k], ch)
                    v = lerp(v, grey[k], tb)
                    md[q + k] = clampedByte(v * 255)
                }
                md[q + 3] = 255
            }
        }

        let fc = Canvas(W, H)
        // Scaled up with smoothing, as `drawImage` does. The canvas's y-down transform is undone
        // first so the image lands upright (row 0 at the top).
        if let img = mottle.ctx.makeImage() {
            fc.ctx.saveGState()
            fc.ctx.concatenate(CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: CGFloat(H)))
            fc.ctx.interpolationQuality = .high
            fc.ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
            fc.ctx.restoreGState()
        }
        // The height map: mid grey is flat.
        let hc = Canvas(W, H)
        hc.fill(RGBA(hex: "#808080"))
        hc.fillRect(0, 0, Double(W), Double(H))

        // Everything is drawn in metres; features near an edge are drawn again across it so the
        // map tiles. (Copies that land wholly outside the map are skipped: they would draw nothing.)
        let wraps: [(Double, Double)] = [(0, 0), (-1, 0), (1, 0), (0, -FH), (0, FH), (-1, -FH), (1, -FH), (-1, FH), (1, FH)]
        func each(_ fn: (Double, Double) -> Void) {
            for (ox, oy) in wraps {
                for c in [fc, hc] {
                    c.ctx.saveGState()
                    c.ctx.translateBy(x: ox * PX, y: oy * PX)
                    c.ctx.scaleBy(x: PX, y: PX)
                }
                fn(ox, oy)
                for c in [fc, hc] { c.ctx.restoreGState() }
            }
        }
        func shows(_ ox: Double, _ oy: Double, _ x0: Double, _ x1: Double, _ y0: Double, _ y1: Double) -> Bool {
            x1 + ox > -0.01 && x0 + ox < 1.01 && y1 + oy > -0.01 && y0 + oy < FH + 0.01
        }
        /// Stroke `path` with a linear gradient (canvas `strokeStyle = gradient`).
        func gradientStroke(_ c: Canvas, _ path: CGPath, width: Double, cap: CGLineCap, from: CGPoint, to: CGPoint, _ stops: [(Double, RGBA)]) {
            c.ctx.saveGState()
            c.ctx.setLineWidth(width)
            c.ctx.setLineCap(cap)
            c.ctx.addPath(path)
            c.ctx.replacePathWithStrokedPath()
            c.ctx.clip()
            c.linearGradient(from: from, to: to, stops)
            c.ctx.restoreGState()
        }
        func strokePath(_ c: Canvas, _ path: CGPath, _ color: RGBA, width: Double) {
            c.stroke(color)
            c.ctx.setLineWidth(width)
            c.ctx.setLineCap(.butt)
            c.ctx.addPath(path)
            c.ctx.strokePath()
        }
        func fillPath(_ c: Canvas, _ path: CGPath, _ color: RGBA) {
            c.fill(color)
            c.ctx.addPath(path)
            c.ctx.fillPath()
        }
        func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }

        // Every feature is decided before it is drawn, so its copies across the edges match.
        // Horizontal wrinkles: the bark is ringed with long, faint, slightly wavy ridges and grooves,
        // a few centimetres apart, running part way round the trunk.
        var wrinkles: [Wrinkle] = []
        var y = 0.0
        while y < FH {
            let n = 1 + Int(floor(R(0, 4)))
            for _ in 0..<n {
                let x = rng.next(), yy = y + R(-0.003, 0.003), len = R(0.03, 0.28), w = R(0.0006, 0.0018)
                let raised = rng.next() < 0.6
                let wave = R(0.0005, 0.003), bend = R(-0.006, 0.006), k = R(0.3, 1)
                wrinkles.append(Wrinkle(x: x, y: yy, len: len, w: w, raised: raised, wave: wave, bend: bend, k: k))
            }
            y += R(0.006, 0.028)
        }
        each { ox, oy in
            for r in wrinkles {
                guard shows(ox, oy, r.x - 0.01, r.x + r.len + 0.01, r.y - 0.012, r.y + 0.012) else { continue }
                let path = CGMutablePath()
                path.move(to: pt(r.x, r.y))
                path.addQuadCurve(to: pt(r.x + r.len, r.y + r.bend * 0.3), control: pt(r.x + r.len * 0.5, r.y + r.bend + r.wave))
                // Height: a raised ridge or a groove, soft-edged, fading at the ends.
                let v = r.raised ? 1.0 : 0.0, a = 0.4 * r.k
                gradientStroke(hc, path, width: r.w, cap: .round, from: pt(r.x, 0), to: pt(r.x + r.len, 0),
                               [(0, RGBA(v, v, v, 0)), (0.2, RGBA(v, v, v, a)), (0.8, RGBA(v, v, v, a)), (1, RGBA(v, v, v, 0))])
                // A whisper of it in the colour too.
                let cv = r.raised ? RGBA.bytes(255, 255, 252) : RGBA.bytes(70, 66, 60), ca = (r.raised ? 0.12 : 0.07) * r.k
                gradientStroke(fc, path, width: r.w * 0.8, cap: .round, from: pt(r.x, 0), to: pt(r.x + r.len, 0),
                               [(0, cv.alpha(0)), (0.2, cv.alpha(ca)), (0.8, cv.alpha(ca)), (1, cv.alpha(0))])
            }
        }

        // Lenticels: short dark dashes in loose rows, with a thread of pale bark lifted just below.
        var lents: [Lenticel] = []
        y = 0.02
        while y < FH {
            let density = R(0.1, 0.7)
            var x = R(0, 0.05)
            while x < 1 {
                defer { x += R(0.04, 0.16) }
                if rng.next() > density { continue }
                let yy = y + R(-0.006, 0.006), len = R(0.006, 0.024), ht = R(0.003, 0.0048), ang = R(-0.06, 0.06)
                lents.append(Lenticel(x: x, y: yy, len: len, ht: ht, ang: ang))
            }
            y += R(0.03, 0.09)
        }
        each { ox, oy in
            for l in lents {
                guard shows(ox, oy, l.x - 0.02, l.x + 0.02, l.y - 0.01, l.y + 0.015) else { continue }
                let dash = CGPath(roundedRect: CGRect(x: -l.len / 2, y: -l.ht / 2, width: l.len, height: l.ht),
                                  cornerWidth: l.ht / 2, cornerHeight: l.ht / 2, transform: nil)
                for (c, col) in [(fc, RGBA.bytes(44, 38, 32, 0.8)), (hc, RGBA.bytes(0, 0, 0, 0.7))] {
                    c.ctx.saveGState()
                    c.ctx.translateBy(x: l.x, y: l.y)
                    c.ctx.rotate(by: l.ang)
                    fillPath(c, dash, col)
                    c.ctx.restoreGState()
                }
                let thread = CGMutablePath()
                thread.move(to: pt(-l.len / 2, 0))
                thread.addLine(to: pt(l.len / 2, 0))
                for (c, col) in [(fc, RGBA.bytes(255, 255, 250, 0.35)), (hc, RGBA.bytes(255, 255, 255, 0.6))] {
                    c.ctx.saveGState()
                    c.ctx.translateBy(x: l.x, y: l.y + l.ht * 0.8)
                    c.ctx.rotate(by: l.ang)
                    strokePath(c, thread, col, width: 0.0012)
                    c.ctx.restoreGState()
                }
            }
        }

        // Eyes: the scars of shed branches.
        var eyes: [Eye] = []
        for _ in 0..<9 {
            let w = R(0.045, 0.11)
            let x = rng.next(), ey = R(0, FH), hh = w * R(0.38, 0.7), tilt = R(-0.15, 0.15)
            var e = Eye(x: x, y: ey, w: w, hh: hh, tilt: tilt, tears: [])
            if rng.next() < 0.6 {
                let L = R(0.25, 0.6)
                for _ in 0..<8 {
                    let ox = R(-w * 0.3, w * 0.3), wdt = R(0.004, 0.014), tl = L * R(0.5, 1), a = R(0.2, 1), b = R(0.2, 1)
                    let jx = R(-0.01, 0.01), jy = R(-0.01, 0.01)
                    e.tears.append(Tear(ox: ox, wdt: wdt, L: tl, a: a, b: b, jx: jx, jy: jy))
                }
            }
            eyes.append(e)
        }
        func lens(_ w: Double, _ hh: Double) -> CGPath {
            let p = CGMutablePath()
            p.move(to: pt(-w, 0))
            p.addQuadCurve(to: pt(w, 0), control: pt(0, -hh * 2))
            p.addQuadCurve(to: pt(-w, 0), control: pt(0, hh * 2))
            p.closeSubpath()
            return p
        }
        each { ox, oy in
            for e in eyes {
                guard shows(ox, oy, e.x - e.w - 0.15, e.x + e.w + 0.15, e.y - 0.15, e.y + 0.8) else { continue }
                let hh = e.hh
                for c in [fc, hc] {
                    c.ctx.saveGState()
                    c.ctx.translateBy(x: e.x, y: e.y)
                    c.ctx.rotate(by: e.tilt)
                }
                // The tear below: soft, ragged, fading.
                for t in e.tears {
                    let p = CGMutablePath()
                    p.move(to: pt(t.ox - t.wdt, hh * 0.3))
                    p.addLine(to: pt(t.ox + t.wdt, hh * 0.3))
                    p.addLine(to: pt(t.ox + t.wdt * t.a + t.jx, hh * 0.5 + t.L))
                    p.addLine(to: pt(t.ox - t.wdt * t.b + t.jy, hh * 0.5 + t.L))
                    p.closeSubpath()
                    fc.clipped(p) {
                        fc.linearGradient(from: pt(0, hh * 0.5), to: pt(0, hh * 0.5 + t.L),
                                          [(0, RGBA.bytes(30, 26, 22, 0.09)), (1, RGBA.bytes(30, 26, 22, 0))])
                    }
                }
                // The rim: a pale raised ring, darker toward the core.
                let outer = lens(e.w, hh)
                fc.clipped(outer) {
                    fc.radialGradient(.zero, e.w * 0.5, .zero, e.w,
                                      [(0, RGBA.bytes(96, 92, 84)), (0.7, RGBA.bytes(158, 155, 148)), (1, RGBA.bytes(200, 198, 194))])
                }
                strokePath(fc, outer, RGBA.bytes(60, 54, 44, 0.5), width: 0.0015)
                fillPath(hc, outer, RGBA(hex: "#c8c8c8"))
                // The core: the black scar, with a slit of light along its top.
                let core = lens(e.w * 0.74, hh * 0.62)
                fillPath(fc, core, RGBA(hex: "#120e0b"))
                fillPath(hc, core, RGBA(hex: "#303030"))
                let slit = CGMutablePath()
                slit.move(to: pt(-e.w * 0.5, -hh * 0.15))
                slit.addQuadCurve(to: pt(e.w * 0.5, -hh * 0.15), control: pt(0, -hh * 0.9))
                strokePath(fc, slit, RGBA.bytes(90, 84, 70, 0.6), width: 0.0012)
                for c in [fc, hc] { c.ctx.restoreGState() }
            }
        }

        // Cankers: rare, ragged black wounds with a few cracks of lighter wood showing.
        var cankers: [Canker] = []
        for _ in 0..<2 {
            let r = R(0.03, 0.09)
            var pts: [CGPoint] = [], cracks: [(CGPoint, CGPoint)] = []
            var a = 0.0
            while a < Double.pi * 2 {
                let px = cos(a) * r * R(0.6, 1.3)
                let py = sin(a) * r * R(0.6, 1.3) * 1.4
                pts.append(pt(px, py))
                a += Double.pi * 2 / 28
            }
            for _ in 0..<4 {
                let x0 = R(-r, r) * 0.5, y0 = R(-r, r), x1 = R(-r, r) * 0.5, y1 = R(-r, r)
                cracks.append((pt(x0, y0), pt(x1, y1)))
            }
            let x = rng.next(), cy = R(0, FH)
            cankers.append(Canker(x: x, y: cy, pts: pts, cracks: cracks))
        }
        each { ox, oy in
            for k in cankers {
                guard shows(ox, oy, k.x - 0.2, k.x + 0.2, k.y - 0.2, k.y + 0.2) else { continue }
                for c in [fc, hc] {
                    c.ctx.saveGState()
                    c.ctx.translateBy(x: k.x, y: k.y)
                }
                let wound = CGMutablePath()
                wound.move(to: k.pts[0])
                for p in k.pts { wound.addLine(to: p) }
                wound.closeSubpath()
                fillPath(fc, wound, RGBA(hex: "#1a1512"))
                fillPath(hc, wound, RGBA(hex: "#404040"))
                for cr in k.cracks {
                    let p = CGMutablePath()
                    p.move(to: cr.0)
                    p.addLine(to: cr.1)
                    strokePath(fc, p, RGBA.bytes(110, 100, 80, 0.5), width: 0.0015)
                }
                for c in [fc, hc] { c.ctx.restoreGState() }
            }
        }

        // Both canvases are opaque (filled first), so their bytes need no un-premultiplying.
        let rgba = fc.data, hgt = hc.data
        reliefShade(rgba, hgt, W, H, 1.6, clamped: true)
        var out = [UInt8](repeating: 0, count: W * H * 4)
        out.withUnsafeMutableBufferPointer { o in
            let op = o.baseAddress!
            DispatchQueue.concurrentPerform(iterations: H) { j in
                for i in (j * W)..<((j + 1) * W) {
                    op[i * 4] = rgba[i * 4]
                    op[i * 4 + 1] = rgba[i * 4 + 1]
                    op[i * 4 + 2] = rgba[i * 4 + 2]
                    op[i * 4 + 3] = hgt[i * 4]
                }
            }
        }
        return out
    }

    // MARK: - The detail tile

    static func paintDetail() -> [UInt8] {
        let N = 1024, T = 0.2
        var out = [UInt8](repeating: 0, count: N * N * 4)
        out.withUnsafeMutableBufferPointer { o in
            let op = o.baseAddress!
            DispatchQueue.concurrentPerform(iterations: N) { j in
                let y = Double(j) / Double(N) * T
                for i in 0..<N {
                    let x = Double(i) / Double(N) * T
                    // Powdery bloom: a soft, even grain, no pits.
                    let bloom = pfbm(x, y, T, T, 4, 3)
                    let grainR = clamp(0.5 + (bloom - 0.5) * 0.8, 0, 1)
                    // Rough-bark grain: harsher, more contrast.
                    let rough = pfbm(x + 0.07, y + 0.03, T, T, 8, 4)
                    let grainG = clamp(0.5 + (rough - 0.5) * 2.2, 0, 1)
                    // Fine horizontal fibres: long across, fine up.
                    let fibre = periodicNoise(Double(i) / Double(N) * 3, Double(j) / Double(N) * 48, 3, 48) * 0.6
                        + periodicNoise(Double(i) / Double(N) * 8, Double(j) / Double(N) * 160, 8, 160) * 0.4
                    let q = (j * N + i) * 4
                    op[q] = truncByte(grainR * 255)
                    op[q + 1] = truncByte(grainG * 255)
                    op[q + 2] = truncByte(fibre * 255)
                    op[q + 3] = truncByte(clamp(0.5 + (bloom - 0.5) * 0.3 + (fibre - 0.5) * 0.5, 0, 1) * 255)
                }
            }
        }
        return out
    }

    // MARK: - The rough tile: furrowed, plated bark

    static func paintRough(_ rng: Seeded) -> [UInt8] {
        let W = px, H = px * roughH
        let RH = Double(roughH), PX = Double(px)
        let strips = 52
        var stripW: [Double] = [], stripH: [Double] = []
        for _ in 0..<strips {
            stripW.append(0.6 + rng.next() * 0.9)
            stripH.append(rng.next())
        }
        let plateRate = stripH.map { ((5 + $0 * 6) * RH).rounded() / RH }
        /// A random number per plate, the same every time for the same plate.
        @inline(__always) func shade(_ s: Int, _ cy: Int) -> Double { Seeded((s * 1000 + cy) * 7919 + 13).next() }
        // Deliberate departure from the web version: there the foot bark is furrow (0.25, 0.235,
        // 0.22) and crest (0.42, 0.4, 0.37), which reads as near-black "burnt stumps" all along the
        // grove. Here it is a lighter, weathered grey-brown, with the same furrow/crest structure.
        let furrow = [0.30, 0.285, 0.265], crest = [0.58, 0.555, 0.51]
        var out = [UInt8](repeating: 0, count: W * H * 4)
        out.withUnsafeMutableBufferPointer { o in
            let op = o.baseAddress!
            DispatchQueue.concurrentPerform(iterations: H) { j in
                let y = Double(j) / PX
                for i in 0..<W {
                    let x = Double(i) / PX
                    // The strips wander across the trunk.
                    let wander = (pfbm(x, y, 1, RH, 3, 3) - 0.5) * 3.0 + (pfbm(x + 0.4, y + 0.2, 1, RH, 12, 2) - 0.5) * 0.8
                    let sx = x * Double(strips) + wander
                    let sxf = floor(sx)
                    let s = ((Int(sxf) % strips) + strips) % strips, f = sx - sxf
                    var c = 1 - abs(f * 2 - 1)
                    c = pow(c, stripW[s])
                    let py = y * plateRate[s] + stripH[s] * 10
                    let cyf = floor(py), fy = py - cyf
                    let cy = Int(cyf)
                    let per = Int((plateRate[s] * RH).rounded()), cyp = ((cy % per) + per) % per
                    let brk = smoothstep(0.1, 0, min(fy, 1 - fy)) * (shade(s, cyp + 500) > 0.2 ? 1 : 0)
                    c *= 1 - brk * 0.8
                    let hp = shade(s, cyp + 1000)
                    c *= 0.45 + 0.7 * hp
                    if hp < 0.06 { c *= 0.3 }
                    // JavaScript's % keeps the sign of the dividend, as truncatingRemainder does.
                    let sub = 1 - abs((sx * 3 + stripH[s]).truncatingRemainder(dividingBy: 1) * 2 - 1)
                    c *= 0.75 + 0.25 * sub
                    let plates = pfbm(x + 0.5, y + 0.7, 1, RH, 8, 2)
                    let cr = smoothstep(0.1, 0.9, c * (0.7 + 0.5 * plates))
                    let fine = pfbm(x * 7 + 0.3, y * 7 + 0.1, 7, 7 * RH, 20, 2)
                    let q = (j * W + i) * 4
                    for k in 0..<3 { op[q + k] = truncByte(lerp(furrow[k], crest[k], cr) * (0.78 + 0.44 * fine) * 255) }
                    op[q + 3] = truncByte(clamp(0.15 + cr * 0.75, 0, 1) * 255)
                }
            }
            // The ridges lit from above, shaded below.
            var hgt = [UInt8](repeating: 0, count: W * H * 4)
            for i in 0..<(W * H) { hgt[i * 4] = op[i * 4 + 3] }
            hgt.withUnsafeBufferPointer { reliefShade(op, $0.baseAddress!, W, H, 0.3, clamped: false) }
        }
        return out
    }
}
