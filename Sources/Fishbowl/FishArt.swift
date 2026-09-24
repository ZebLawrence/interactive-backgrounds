import CoreGraphics

/// Procedurally painted images for one species, all in "fish space": points, body centred on
/// the origin, nose toward +x. The 3D model maps these onto its body, fins and tail.
struct FishArt {
    /// Side-view skin, projected onto both flanks of the body.
    let skin: CGImage
    let skinRect: CGRect
    /// Dorsal + anal fins on one transparent sheet through the middle of the body.
    let fins: CGImage
    let finsRect: CGRect
    let tail: CGImage
    let tailRect: CGRect
    let pectoral: CGImage
    let pectoralSize: CGSize
    /// Fins, tail and pectoral fin packed into one image so a fish's fins draw in a single call.
    /// The UV rects locate each part (top-left origin, as SceneKit samples textures).
    let finAtlas: CGImage
    let finsUV: CGRect
    let tailUV: CGRect
    let pectoralUV: CGRect

    private static var cache: [String: FishArt] = [:]

    static func forSpecies(_ s: Species) -> FishArt {
        if let a = cache[s.id] { return a }
        let a = FishArt(s)
        cache[s.id] = a
        return a
    }

    private init(_ s: Species) {
        (skin, skinRect) = FishArt.makeSkin(s)
        (fins, finsRect) = FishArt.makeFins(s)
        (tail, tailRect) = FishArt.makeTail(s)
        (pectoral, pectoralSize) = FishArt.makePectoral(s)

        // Stack the three images vertically (1px gap) into one atlas.
        let parts = [fins, tail, pectoral]
        let w = parts.map(\.width).max()!
        let h = parts.map(\.height).reduce(0, +) + 2 * parts.count
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: Art.colorSpace,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        var rects: [CGRect] = []
        var top = 0
        for img in parts {
            // CG draws bottom-up; record UVs top-down.
            ctx.draw(img, in: CGRect(x: 0, y: h - top - img.height, width: img.width, height: img.height))
            rects.append(CGRect(x: 0, y: CGFloat(top) / CGFloat(h),
                                width: CGFloat(img.width) / CGFloat(w), height: CGFloat(img.height) / CGFloat(h)))
            top += img.height + 2
        }
        finAtlas = ctx.makeImage()!
        (finsUV, tailUV, pectoralUV) = (rects[0], rects[1], rects[2])
    }

    // MARK: - Outline

    /// Top half of the body outline as a cubic Bezier from the tail joint (t = 0) to the nose (t = 1).
    /// The body is symmetric about y = 0.
    static func topCurve(_ s: Species, _ t: CGFloat) -> CGPoint {
        let a = s.length / 2, b = s.height / 2, L = s.length
        var p0 = CGPoint(x: -a, y: b * 0.36)
        var p1 = CGPoint(x: -a + 0.3 * L, y: 1.6 * b)
        var p2 = CGPoint(x: a - 0.04 * L, y: 0.85 * b)
        let p3 = CGPoint(x: a, y: 0)
        if s.shape == .shark {
            // Torpedo: thickest a third of the way back, tapering to a long pointed snout.
            p0 = CGPoint(x: -a, y: b * 0.3)
            p1 = CGPoint(x: -a + 0.5 * L, y: 1.45 * b)
            p2 = CGPoint(x: a - 0.15 * L, y: 0.9 * b)
        }
        let u = 1 - t
        let w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t
        return CGPoint(x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
                       y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y)
    }

    /// The body's half-height at x, found by sampling the outline.
    static func halfHeight(_ s: Species, atX x: CGFloat) -> CGFloat {
        var prev = topCurve(s, 0)
        for i in 1...64 {
            let p = topCurve(s, CGFloat(i) / 64)
            if p.x >= x {
                let t = (x - prev.x) / max(p.x - prev.x, 1e-4)
                return prev.y + (p.y - prev.y) * t
            }
            prev = p
        }
        return prev.y
    }

    static func finPath(_ f: FinSpec, _ s: Species, top: Bool) -> CGPath {
        let a = s.length / 2, b = s.height / 2, L = s.length
        let sign: CGFloat = top ? 1 : -1
        let back = -a + f.start * L, front = -a + f.end * L
        let baseY = 0.4 * b
        let tip = CGPoint(x: back + (front - back) * 0.15 - f.sweep * L, y: b * 0.85 + f.height)
        let path = CGMutablePath()
        path.move(to: CGPoint(x: front, y: baseY * sign))
        path.addQuadCurve(to: CGPoint(x: tip.x, y: tip.y * sign),
                          control: CGPoint(x: front - 0.15 * (front - back), y: tip.y * sign))
        path.addQuadCurve(to: CGPoint(x: back, y: baseY * sign),
                          control: CGPoint(x: tip.x + (back - tip.x) * 0.7, y: (tip.y + baseY) * 0.45 * sign))
        path.closeSubpath()
        return path
    }

    private static func paintFin(_ ctx: CGContext, _ path: CGPath, _ s: Species, from: CGPoint, to: CGPoint) {
        if s.shape == .shark {
            // Solid, like the body: dark at the base, a little lighter toward the tip.
            ctx.saveGState()
            ctx.addPath(path)
            ctx.clip()
            Art.linear(ctx, [s.top, s.top.lighter(0.12)], from: from, to: to)
            ctx.restoreGState()
            return
        }
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        Art.linear(ctx, [s.fin, s.fin.lighter(0.25).alpha(s.fin.a * 0.55)], from: from, to: to)
        // Fin rays.
        ctx.setStrokeColor(s.fin.darker(0.35).alpha(0.3).cg)
        ctx.setLineWidth(0.5)
        for i in 0...12 {
            let t = CGFloat(i) / 12
            ctx.move(to: CGPoint(x: lerp(from.x - s.length * 0.4, from.x + s.length * 0.4, t), y: from.y))
            ctx.addLine(to: CGPoint(x: lerp(to.x - s.length * 0.6, to.x + s.length * 0.2, t), y: to.y))
        }
        ctx.strokePath()
        ctx.restoreGState()
        if let edge = s.finEdge {
            ctx.addPath(path)
            ctx.setStrokeColor(edge.cg)
            ctx.setLineWidth(1.4)
            ctx.strokePath()
        }
    }


    // MARK: - Skin

    private static func makeSkin(_ s: Species) -> (CGImage, CGRect) {
        let a = s.length / 2, b = s.height / 2, L = s.length
        let rect = CGRect(x: -a - 2, y: -b - 2, width: L + 4, height: s.height + 4)
        let img = Art.image(size: rect.size) { ctx in
            ctx.translateBy(x: -rect.minX, y: -rect.minY)
            // Countershading: dark back, light belly. Real lighting adds the shape on top.
            Art.linear(ctx, [s.top, s.mid, s.belly], [0.05, 0.45, 0.95],
                       from: CGPoint(x: 0, y: b), to: CGPoint(x: 0, y: -b))
            paintPattern(ctx, s)
            // Gill cover (sharks have gill slits instead, drawn with their pattern).
            if s.shape != .shark {
                let gx = a - 0.3 * L
                ctx.setStrokeColor(s.top.darker(0.4).alpha(0.35).cg)
                ctx.setLineWidth(max(0.6, L * 0.015))
                ctx.move(to: CGPoint(x: gx, y: b * 0.65))
                ctx.addQuadCurve(to: CGPoint(x: gx, y: -b * 0.6), control: CGPoint(x: gx + L * 0.09, y: 0))
                ctx.strokePath()
            }
            // Mouth.
            ctx.setStrokeColor(RGBA(0, 0, 0, 0.4).cg)
            ctx.setLineWidth(0.7)
            ctx.move(to: CGPoint(x: a, y: -b * 0.08))
            ctx.addLine(to: CGPoint(x: a - L * 0.07, y: -b * 0.16))
            ctx.strokePath()
        }
        return (img, rect)
    }

    private static func makeFins(_ s: Species) -> (CGImage, CGRect) {
        let L = s.length, a = L / 2, b = s.height / 2
        let sweep = max(s.dorsal.sweep, s.anal.sweep)
        let finH = max(s.dorsal.height, s.anal.height)
        let rect = CGRect(x: -a - L * sweep - 4, y: -(b + finH + 4), width: L * (1 + sweep) + 8, height: 2 * (b + finH + 4))
        let img = Art.image(size: rect.size) { ctx in
            ctx.translateBy(x: -rect.minX, y: -rect.minY)
            paintFin(ctx, finPath(s.dorsal, s, top: true), s,
                     from: CGPoint(x: 0, y: b * 0.5), to: CGPoint(x: 0, y: b + s.dorsal.height))
            paintFin(ctx, finPath(s.anal, s, top: false), s,
                     from: CGPoint(x: 0, y: -b * 0.5), to: CGPoint(x: 0, y: -b - s.anal.height))
        }
        return (img, rect)
    }

    private static func paintPattern(_ ctx: CGContext, _ s: Species) {
        let L = s.length, a = L / 2, b = s.height / 2
        switch s.pattern {
        case .neon:
            // Red lower rear half.
            ctx.saveGState()
            ctx.clip(to: CGRect(x: -a, y: -b * 1.2, width: 0.62 * L, height: b * 1.15))
            Art.linear(ctx, [RGBA(0.95, 0.08, 0.14, 0.95), RGBA(0.95, 0.08, 0.14, 0.95), RGBA(0.95, 0.08, 0.14, 0)],
                       [0, 0.7, 1], from: CGPoint(x: -a, y: 0), to: CGPoint(x: -a + 0.62 * L, y: 0))
            ctx.restoreGState()
            // Glowing blue stripe.
            let stripe = CGRect(x: -a + 0.1 * L, y: b * 0.02, width: 0.76 * L, height: b * 0.36)
            ctx.saveGState()
            ctx.addPath(CGPath(roundedRect: stripe, cornerWidth: stripe.height / 2, cornerHeight: stripe.height / 2, transform: nil))
            ctx.clip()
            Art.linear(ctx, [RGBA(0.1, 0.5, 1.0), RGBA(0.35, 0.98, 1.0), RGBA(0.15, 0.65, 1.0)],
                       from: CGPoint(x: stripe.minX, y: 0), to: CGPoint(x: stripe.maxX, y: 0))
            ctx.restoreGState()

        case .metallic:
            // Scales come from the body's normal map (see `Detail.scales`).
            break

        case .shark:
            // Crisp white underside along the lower flank, with a softly feathered, slightly wavy edge.
            let belly = CGMutablePath()
            belly.move(to: CGPoint(x: -a - 4, y: -b * 1.4))
            for i in 0...24 {
                let t = CGFloat(i) / 24
                let x = -a - 4 + (L + 8) * t
                // The line rises toward the head, like a real shark's countershading.
                let y = -b * 0.22 + b * 0.2 * t + b * 0.05 * sin(t * 19)
                belly.addLine(to: CGPoint(x: x, y: y))
            }
            belly.addLine(to: CGPoint(x: a + 4, y: -b * 1.4))
            belly.closeSubpath()
            ctx.saveGState()
            ctx.setShadow(offset: .zero, blur: b * 0.12, color: RGBA(0.95, 0.95, 0.93).cg)
            ctx.addPath(belly)
            ctx.setFillColor(RGBA(0.95, 0.95, 0.93).cg)
            ctx.fillPath()
            ctx.restoreGState()
            // Gill slits.
            ctx.setStrokeColor(s.top.darker(0.5).alpha(0.55).cg)
            ctx.setLineWidth(1.1)
            for k in 0..<5 {
                let x = a - 0.24 * L - CGFloat(k) * 0.03 * L
                ctx.move(to: CGPoint(x: x, y: b * 0.35))
                ctx.addQuadCurve(to: CGPoint(x: x - 0.01 * L, y: -b * 0.3), control: CGPoint(x: x + 0.012 * L, y: 0))
            }
            ctx.strokePath()

        case .angel:
            for (c, w) in [(0.84, 0.05), (0.58, 0.07), (0.30, 0.06)] as [(CGFloat, CGFloat)] {
                let x = -a + c * L
                ctx.setFillColor(RGBA(0.08, 0.08, 0.08, 0.72).cg)
                ctx.fill(CGRect(x: x - w * L / 2, y: -b * 1.3, width: w * L, height: b * 2.6))
            }

        case .clown:
            for (c, w) in [(0.08, 0.07), (0.47, 0.13), (0.78, 0.11)] as [(CGFloat, CGFloat)] {
                let x = -a + c * L
                let band = CGMutablePath()
                let half = w * L / 2, bow = w * L * 0.7
                band.move(to: CGPoint(x: x - half, y: -b * 1.3))
                band.addQuadCurve(to: CGPoint(x: x - half, y: b * 1.3), control: CGPoint(x: x - half + bow, y: 0))
                band.addLine(to: CGPoint(x: x + half, y: b * 1.3))
                band.addQuadCurve(to: CGPoint(x: x + half, y: -b * 1.3), control: CGPoint(x: x + half + bow, y: 0))
                band.closeSubpath()
                ctx.addPath(band)
                ctx.setStrokeColor(RGBA(0.05, 0.04, 0.04).cg)
                ctx.setLineWidth(2.2)
                ctx.strokePath()
                ctx.addPath(band)
                ctx.setFillColor(RGBA(0.98, 0.98, 0.96).cg)
                ctx.fillPath()
            }
        }
    }


    // MARK: - Tail

    private static func makeTail(_ s: Species) -> (CGImage, CGRect) {
        let T = s.tailLength, S = s.tailSpread, p = s.height / 2 * 0.45
        let overlap: CGFloat = 4
        let size = CGSize(width: T * 1.1 + overlap + 4, height: 2 * S * 1.15 + 6)
        let origin = CGPoint(x: size.width - overlap - 1, y: size.height / 2)

        let path = CGMutablePath()
        switch s.tailStyle {
        case .forked:
            path.move(to: CGPoint(x: overlap, y: p))
            path.addQuadCurve(to: CGPoint(x: -T, y: S), control: CGPoint(x: -T * 0.45, y: p + S * 0.25))
            path.addQuadCurve(to: CGPoint(x: -T * 0.55, y: 0), control: CGPoint(x: -T * 0.72, y: S * 0.3))
            path.addQuadCurve(to: CGPoint(x: -T, y: -S), control: CGPoint(x: -T * 0.72, y: -S * 0.3))
            path.addQuadCurve(to: CGPoint(x: overlap, y: -p), control: CGPoint(x: -T * 0.45, y: -p - S * 0.25))
        case .fan:
            path.move(to: CGPoint(x: overlap, y: p))
            path.addQuadCurve(to: CGPoint(x: -T * 0.8, y: S), control: CGPoint(x: -T * 0.4, y: S * 0.85))
            path.addCurve(to: CGPoint(x: -T * 0.8, y: -S), control1: CGPoint(x: -T * 1.1, y: S * 0.6),
                          control2: CGPoint(x: -T * 1.1, y: -S * 0.6))
            path.addQuadCurve(to: CGPoint(x: overlap, y: -p), control: CGPoint(x: -T * 0.4, y: -S * 0.85))
        case .shark:
            // Long upper lobe sweeping up and back, short lower lobe.
            path.move(to: CGPoint(x: overlap, y: p))
            path.addQuadCurve(to: CGPoint(x: -T, y: S * 1.05), control: CGPoint(x: -T * 0.45, y: p + S * 0.35))
            path.addQuadCurve(to: CGPoint(x: -T * 0.3, y: S * 0.05), control: CGPoint(x: -T * 0.62, y: S * 0.3))
            path.addQuadCurve(to: CGPoint(x: -T * 0.55, y: -S * 0.6), control: CGPoint(x: -T * 0.35, y: -S * 0.25))
            path.addQuadCurve(to: CGPoint(x: overlap, y: -p), control: CGPoint(x: -T * 0.2, y: -p - S * 0.2))
        case .flowing:
            path.move(to: CGPoint(x: overlap, y: p))
            path.addCurve(to: CGPoint(x: -T * 0.95, y: S * 0.9), control1: CGPoint(x: -T * 0.3, y: S * 1.1),
                          control2: CGPoint(x: -T * 0.7, y: S * 1.12))
            // Scalloped trailing edge.
            let n = 5
            for i in 1...n {
                let y = S * 0.9 - CGFloat(i) * (1.9 * S / CGFloat(n))
                let prevY = y + 1.9 * S / CGFloat(n)
                path.addQuadCurve(to: CGPoint(x: -T * (i % 2 == 0 ? 1.0 : 0.9), y: y),
                                  control: CGPoint(x: -T * 1.08, y: (y + prevY) / 2))
            }
            path.addCurve(to: CGPoint(x: overlap, y: -p), control1: CGPoint(x: -T * 0.7, y: -S * 1.15),
                          control2: CGPoint(x: -T * 0.3, y: -S * 1.0))
        }
        path.closeSubpath()

        let img = Art.image(size: size) { ctx in
            ctx.translateBy(x: origin.x, y: origin.y)
            ctx.saveGState()
            ctx.addPath(path)
            ctx.clip()
            if s.shape == .shark {
                Art.linear(ctx, [s.top, s.top.lighter(0.1)], from: CGPoint(x: 0, y: 0), to: CGPoint(x: -T, y: 0))
                ctx.restoreGState()
                return
            }
            let tipAlpha: CGFloat = s.tailStyle == .flowing ? 0.4 : 0.6
            Art.linear(ctx, [s.fin.darker(0.08), s.fin.lighter(0.2).alpha(s.fin.a * tipAlpha)],
                       from: CGPoint(x: 0, y: 0), to: CGPoint(x: -T, y: 0))
            ctx.setStrokeColor(s.fin.darker(0.35).alpha(0.3).cg)
            ctx.setLineWidth(0.55)
            for k in -6...6 {
                let f = CGFloat(k) / 6
                ctx.move(to: CGPoint(x: overlap, y: f * p * 0.8))
                ctx.addQuadCurve(to: CGPoint(x: -T * 1.05, y: f * S * 1.05),
                                 control: CGPoint(x: -T * 0.5, y: f * S * 0.55))
            }
            ctx.strokePath()
            ctx.restoreGState()
            ctx.addPath(path)
            ctx.setStrokeColor((s.finEdge ?? RGBA(1, 1, 1, 0.18)).cg)
            ctx.setLineWidth(s.finEdge == nil ? 0.6 : 1.4)
            ctx.strokePath()
        }
        // Place the image so its attach point sits just inside the back of the body.
        let attachX = -s.length / 2 + 1
        return (img, CGRect(x: attachX - origin.x, y: -origin.y, width: size.width, height: size.height))
    }

    // MARK: - Pectoral fin

    private static func makePectoral(_ s: Species) -> (CGImage, CGSize) {
        let size = CGSize(width: max(6, s.length * 0.26 * s.pectoralScale), height: max(4, s.length * 0.16 * s.pectoralScale))
        let img = Art.image(size: size) { ctx in
            let w = size.width, h = size.height
            let path = CGMutablePath()
            path.move(to: CGPoint(x: w, y: h / 2))
            path.addQuadCurve(to: CGPoint(x: 1, y: h * 0.35), control: CGPoint(x: w * 0.4, y: h))
            path.addQuadCurve(to: CGPoint(x: w, y: h / 2), control: CGPoint(x: w * 0.35, y: 0))
            ctx.addPath(path)
            ctx.clip()
            if s.shape == .shark {
                // Pale underneath, slate on top, like the body.
                Art.linear(ctx, [s.top, s.mid], from: CGPoint(x: 0, y: h), to: CGPoint(x: 0, y: 0))
                return
            }
            Art.linear(ctx, [s.fin.lighter(0.1), s.fin.lighter(0.3).alpha(s.fin.a * 0.4)],
                       from: CGPoint(x: w, y: 0), to: CGPoint(x: 0, y: 0))
        }
        return (img, size)
    }
}
