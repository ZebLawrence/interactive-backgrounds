import AppKit
import SpriteKit

/// Simple sRGB color value that is easy to mix and convert.
struct RGBA {
    var r: CGFloat, g: CGFloat, b: CGFloat, a: CGFloat

    init(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) {
        self.r = r; self.g = g; self.b = b; self.a = a
    }

    static let white = RGBA(1, 1, 1)
    static let black = RGBA(0, 0, 0)
    static let clear = RGBA(0, 0, 0, 0)

    var cg: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }
    var ns: NSColor { NSColor(srgbRed: r, green: g, blue: b, alpha: a) }

    func alpha(_ x: CGFloat) -> RGBA { RGBA(r, g, b, x) }
    func mix(_ o: RGBA, _ t: CGFloat) -> RGBA {
        RGBA(lerp(r, o.r, t), lerp(g, o.g, t), lerp(b, o.b, t), lerp(a, o.a, t))
    }
    func darker(_ t: CGFloat) -> RGBA { let c = mix(.black, t); return c.alpha(a) }
    func lighter(_ t: CGFloat) -> RGBA { let c = mix(.white, t); return c.alpha(a) }
}

/// Helpers for drawing procedural textures with Core Graphics.
enum Art {
    /// Images are rendered at 4 pixels per point so fish stay crisp up close to the glass.
    static let scale: CGFloat = 4
    static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    /// Draw into a bitmap of `size` points (origin bottom-left, y up).
    static func image(size: CGSize, scale: CGFloat = Art.scale, _ draw: (CGContext) -> Void) -> CGImage {
        let w = max(1, Int(ceil(size.width * scale)))
        let h = max(1, Int(ceil(size.height * scale)))
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.scaleBy(x: scale, y: scale)
        ctx.setShouldAntialias(true)
        ctx.setAllowsAntialiasing(true)
        ctx.interpolationQuality = .high
        draw(ctx)
        return ctx.makeImage()!
    }

    /// Same as `image`, wrapped as a SpriteKit texture (used by the 2D glass overlay).
    static func texture(size: CGSize, _ draw: (CGContext) -> Void) -> SKTexture {
        let tex = SKTexture(cgImage: image(size: size, scale: 2, draw))
        tex.filteringMode = .linear
        return tex
    }

    static func gradient(_ colors: [RGBA], _ locations: [CGFloat]? = nil) -> CGGradient {
        CGGradient(colorsSpace: colorSpace, colors: colors.map(\.cg) as CFArray, locations: locations)!
    }

    static func linear(_ ctx: CGContext, _ colors: [RGBA], _ locations: [CGFloat]? = nil,
                       from: CGPoint, to: CGPoint) {
        ctx.drawLinearGradient(gradient(colors, locations), start: from, end: to,
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }

    static func radial(_ ctx: CGContext, _ colors: [RGBA], _ locations: [CGFloat]? = nil,
                       center: CGPoint, radius: CGFloat) {
        ctx.drawRadialGradient(gradient(colors, locations), startCenter: center, startRadius: 0,
                               endCenter: center, endRadius: radius, options: [.drawsBeforeStartLocation])
    }

    // MARK: - Shared images

    /// A 1-pixel-tall strip of flat colours. Meshes pick a colour with `paletteUV`.
    static func palette(_ colors: [RGBA]) -> CGImage {
        image(size: CGSize(width: colors.count, height: 1), scale: 1) { ctx in
            for (i, c) in colors.enumerated() {
                ctx.setFillColor(c.cg)
                ctx.fill(CGRect(x: i, y: 0, width: 1, height: 1))
            }
        }
    }

    static func paletteUV(_ index: Int, of count: Int) -> V2 { V2((Float(index) + 0.5) / Float(count), 0.5) }

    static let dot: CGImage = image(size: CGSize(width: 16, height: 16), scale: 2) { ctx in
        radial(ctx, [RGBA(1, 1, 1, 1), RGBA(1, 1, 1, 0)], center: CGPoint(x: 8, y: 8), radius: 8)
    }

    /// Soft vertical beam of light, brightest at the top.
    static let lightShaft: CGImage = image(size: CGSize(width: 64, height: 256), scale: 1) { ctx in
        linear(ctx, [.clear, RGBA(1, 1, 1, 1), .clear], [0, 0.5, 1],
               from: CGPoint(x: 0, y: 0), to: CGPoint(x: 64, y: 0))
        ctx.setBlendMode(.destinationIn)
        linear(ctx, [.clear, RGBA(1, 1, 1, 0.35), .white], [0, 0.45, 1],
               from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: 256))
    }

    /// Vertical water gradient used for the backdrop and image-based lighting.
    static func waterGradient(width: CGFloat, height: CGFloat) -> CGImage {
        image(size: CGSize(width: width, height: height), scale: 1) { ctx in
            linear(ctx, [RGBA(0.012, 0.06, 0.11), RGBA(0.03, 0.19, 0.27), RGBA(0.05, 0.28, 0.37), RGBA(0.14, 0.52, 0.62)],
                   [0, 0.45, 0.62, 1], from: .zero, to: CGPoint(x: 0, y: height))
        }
    }

    /// Tileable-ish sand: mottled base with scattered grains.
    static let sand: CGImage = image(size: CGSize(width: 512, height: 512), scale: 1) { ctx in
        ctx.setFillColor(RGBA(0.66, 0.58, 0.42).cg)
        ctx.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
        for _ in 0..<260 {
            let r = rand(10...60)
            let c = CGPoint(x: rand(0...512), y: rand(0...512))
            let tone = Bool.random() ? RGBA(0.80, 0.71, 0.53, 0.18) : RGBA(0.45, 0.38, 0.27, 0.18)
            radial(ctx, [tone, tone.alpha(0)], center: c, radius: r)
        }
        for _ in 0..<9000 {
            let s = rand(0.8...2.4)
            let tones = [RGBA(0.9, 0.84, 0.7), RGBA(0.35, 0.3, 0.24), RGBA(0.75, 0.62, 0.45), RGBA(0.95, 0.95, 0.92)]
            ctx.setFillColor(tones.randomElement()!.alpha(rand(0.25...0.7)).cg)
            ctx.fillEllipse(in: CGRect(x: rand(0...512), y: rand(0...512), width: s, height: s))
        }
    }

    // MARK: - Overlay textures

    static let ring: SKTexture = texture(size: CGSize(width: 128, height: 128)) { ctx in
        ctx.setStrokeColor(RGBA(0.85, 1, 1, 0.9).cg)
        ctx.setLineWidth(3)
        ctx.strokeEllipse(in: CGRect(x: 4, y: 4, width: 120, height: 120))
        ctx.setStrokeColor(RGBA(0.85, 1, 1, 0.35).cg)
        ctx.setLineWidth(2)
        ctx.strokeEllipse(in: CGRect(x: 14, y: 14, width: 100, height: 100))
    }

    /// A soft vertical streak used to suggest light reflecting on the glass.
    static let glassStreak: SKTexture = texture(size: CGSize(width: 64, height: 256)) { ctx in
        ctx.saveGState()
        ctx.clip(to: CGRect(x: 0, y: 0, width: 64, height: 256))
        linear(ctx, [.clear, RGBA(1, 1, 1, 1), RGBA(1, 1, 1, 0.6), .clear], [0, 0.35, 0.6, 1],
               from: CGPoint(x: 0, y: 0), to: CGPoint(x: 64, y: 0))
        ctx.restoreGState()
        // Fade the streak out toward the top and bottom.
        ctx.setBlendMode(.destinationIn)
        linear(ctx, [.clear, .white, .white, .clear], [0, 0.25, 0.75, 1],
               from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: 256))
    }
}
