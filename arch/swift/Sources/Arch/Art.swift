import CoreGraphics
import Foundation

/// A simple sRGB colour value that is easy to mix and convert.
struct RGBA {
    var r: Double, g: Double, b: Double, a: Double

    init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        self.r = r; self.g = g; self.b = b; self.a = a
    }

    /// From a CSS hex string like "#3a5a2a".
    init(hex: String, _ a: Double = 1) {
        let v = Int(hex.dropFirst(), radix: 16) ?? 0
        self.init(Double((v >> 16) & 255) / 255, Double((v >> 8) & 255) / 255, Double(v & 255) / 255, a)
    }

    /// From 0...255 components, as CSS `rgba(...)` writes them.
    static func bytes(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> RGBA { RGBA(r / 255, g / 255, b / 255, a) }

    func alpha(_ x: Double) -> RGBA { RGBA(r, g, b, x) }
    func mix(_ o: RGBA, _ t: Double) -> RGBA { RGBA(lerp(r, o.r, t), lerp(g, o.g, t), lerp(b, o.b, t), lerp(a, o.a, t)) }

    var cg: CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: a) }

    /// Converted to linear light, for shader uniforms (three.js's `Color.setRGB(..., SRGBColorSpace)`).
    var linear: V3 { V3(Float(srgbToLinear(r)), Float(srgbToLinear(g)), Float(srgbToLinear(b))) }
}

func srgbToLinear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }

/// A Core Graphics bitmap with the Canvas 2D conventions the web version draws with: the origin
/// at the top-left, y down, in pixels. Pixel row 0 is the top of the image.
final class Canvas {
    let width: Int
    let height: Int
    let ctx: CGContext
    let gray: Bool

    static let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

    /// `gray`: one coverage channel (for silhouette masks), drawn white on black.
    init(_ w: Int, _ h: Int, gray: Bool = false) {
        width = w
        height = h
        self.gray = gray
        if gray {
            ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        } else {
            ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: Canvas.srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        ctx.setShouldAntialias(true)
        ctx.setAllowsAntialiasing(true)
        ctx.interpolationQuality = .high
        ctx.setLineCap(.butt)
    }

    var data: UnsafeMutablePointer<UInt8> { ctx.data!.assumingMemoryBound(to: UInt8.self) }

    /// Fill every pixel from a function of (x, y) returning 0...255 RGB (opaque), rows in parallel.
    func setPixels(_ f: @escaping (Int, Int) -> (Double, Double, Double)) {
        let d = data, w = width
        DispatchQueue.concurrentPerform(iterations: height) { y in
            for x in 0..<w {
                let (r, g, b) = f(x, y)
                let i = (y * w + x) * 4
                d[i] = UInt8(clamp(r, 0, 255))
                d[i + 1] = UInt8(clamp(g, 0, 255))
                d[i + 2] = UInt8(clamp(b, 0, 255))
                d[i + 3] = 255
            }
        }
    }

    // MARK: - Canvas 2D-style drawing

    func fill(_ c: RGBA) { ctx.setFillColor(c.cg) }
    func stroke(_ c: RGBA) { ctx.setStrokeColor(c.cg) }

    func fillRect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) {
        ctx.fill(CGRect(x: x, y: y, width: w, height: h))
    }

    func line(_ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double, width: Double) {
        ctx.setLineWidth(width)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: x0, y: y0))
        ctx.addLine(to: CGPoint(x: x1, y: y1))
        ctx.strokePath()
    }

    func dot(_ x: Double, _ y: Double, _ r: Double) {
        ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
    }

    /// An ellipse rotated by `rotation` about its centre, as `ctx.ellipse(...)` draws it.
    func ellipsePath(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double, _ rotation: Double) -> CGPath {
        var t = CGAffineTransform(translationX: x, y: y).rotated(by: rotation)
        return CGPath(ellipseIn: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2), transform: &t)
    }

    func fillEllipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double, _ rotation: Double = 0) {
        ctx.addPath(ellipsePath(x, y, rx, ry, rotation))
        ctx.fillPath()
    }

    func gradient(_ stops: [(Double, RGBA)]) -> CGGradient {
        CGGradient(colorsSpace: Canvas.srgb, colors: stops.map(\.1.cg) as CFArray, locations: stops.map { CGFloat($0.0) })!
    }

    /// Fill the current clip with a linear gradient, extended past both ends (as Canvas does).
    func linearGradient(from p0: CGPoint, to p1: CGPoint, _ stops: [(Double, RGBA)]) {
        ctx.drawLinearGradient(gradient(stops), start: p0, end: p1, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }

    /// Fill the current clip with a two-circle radial gradient, extended past both ends.
    func radialGradient(_ c0: CGPoint, _ r0: Double, _ c1: CGPoint, _ r1: Double, _ stops: [(Double, RGBA)]) {
        ctx.drawRadialGradient(gradient(stops), startCenter: c0, startRadius: r0, endCenter: c1, endRadius: r1,
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }

    /// Run `draw` clipped to `path`.
    func clipped(_ path: CGPath, _ draw: () -> Void) {
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        draw()
        ctx.restoreGState()
    }

    func clipped(_ rect: CGRect, _ draw: () -> Void) {
        ctx.saveGState()
        ctx.clip(to: rect)
        draw()
        ctx.restoreGState()
    }
}

/// Shared procedural images.
enum Art {
    /// A soft radial blob, white fading to transparent, for mist and glows.
    static func blob(_ size: Int = 256, hardness: Double = 0) -> Canvas {
        let c = Canvas(size, size)
        let s = Double(size), m = CGPoint(x: s / 2, y: s / 2)
        c.radialGradient(m, 0, m, s / 2, [(0, RGBA(1, 1, 1, 1)), (0.25 + hardness * 0.5, RGBA(1, 1, 1, 0.55)),
                                          (0.6, RGBA(1, 1, 1, 0.14)), (1, RGBA(1, 1, 1, 0))])
        return c
    }

    /// A thin vertical streak for rain, drawn on a square so it fits a point sprite.
    static func streak(_ size: Int = 128) -> Canvas {
        let c = Canvas(size, size)
        let w = Double(size), h = Double(size)
        let stops: [(Double, RGBA)] = [(0, RGBA(1, 1, 1, 0)), (0.5, RGBA(1, 1, 1, 1)), (1, RGBA(1, 1, 1, 0))]
        c.clipped(CGRect(x: w * 0.46, y: 0, width: w * 0.08, height: h)) {
            c.linearGradient(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: h), stops)
        }
        // A softer copy over it (the web version redraws it through a 1px blur).
        c.ctx.setAlpha(0.6)
        c.clipped(CGRect(x: w * 0.46 - 1, y: 0, width: w * 0.08 + 2, height: h)) {
            c.linearGradient(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: h), stops)
        }
        c.ctx.setAlpha(1)
        return c
    }
}
