import SceneKit
import simd

/// A species' fins: dorsal, anal, tail, pectoral and pelvic pairs (plus the tetra's adipose fin)
/// share one mesh and one atlas texture (one draw call). Each vertex carries its fin kind and its
/// distance from where the fin joins the body, so `FishShaders.fins` can move every fin on its own.
enum FishFins {
    /// Fin kinds as seen by `FishShaders.fins` (the integer part of the vertex colour's red channel).
    enum Kind: Float {
        /// Follows the body only.
        case rigid = 0
        /// Dorsal, anal and adipose fins: ripples travel along them; long ones trail the body wave.
        case median = 1
        case tail = 2
        /// Paired fins turn about the edge where they join the body.
        case pectoral = 3
        case pelvic = 4
    }

    static func geometry(species s: Species, art: FishArt, body: FishBody, unit u: Float) -> SCNGeometry {
        let shark = s.shape == .shark
        let flow = Float(flowiness(s))
        let L = Float(s.length), a = L / 2
        let pelvic = pelvicImage(s)
        let adipose: CGImage? = s.id == Species.neonTetra.id ? adiposeImage(s) : nil
        let (atlas, uv) = pack([art.fins, art.tail, art.pectoral, pelvic.image] + (adipose.map { [$0] } ?? []))
        var m = Mesh()

        // Dorsal and anal fins: the painted sheet through the middle of the body, split at the centre
        // line so each half follows the body's back or belly. The art is painted from the same outline
        // (`FishArt.outline`), so the shift is normally ~0; it keeps the two in step if they ever differ.
        let fr = art.finsRect
        for top in [true, false] {
            let half = CGRect(x: fr.minX, y: top ? 0 : fr.minY, width: fr.width, height: top ? fr.maxY : -fr.minY)
            var sheet = grid(half, image: fr, uv: uv[0], columns: 18, rows: 8)
            for i in sheet.positions.indices {
                let p = sheet.positions[i]
                let section = body.section(atX: p.x)
                let outline = FishArt.outline(s, atX: CGFloat(p.x))
                let artEdge = Float(top ? outline.top : outline.bottom)
                let shift = top ? section.top - artEdge : artEdge - section.bottom
                sheet.positions[i].y += shift
                let span = max(0, abs(p.y) - artEdge * 0.95) * u
                let along = (p.x - Float(fr.minX)) / Float(fr.width)
                sheet.colors.append(data(shark ? .rigid : .median, flow, span, along, Float(fr.width) * u))
            }
            m.append(sheet.scaled(u))
        }

        // Tail (the art already fits its root to the tail joint's back and belly heights).
        let tr = art.tailRect
        let attachX = -a + 1
        var tail = grid(tr, image: tr, uv: uv[1], columns: 12, rows: 8)
        let spread = Float(max(tr.maxY, -tr.minY))
        for i in tail.positions.indices {
            let p = tail.positions[i]
            let span = clamp((attachX - p.x) / Float(s.tailLength), 0, 1)
            tail.colors.append(data(shark ? .rigid : .tail, flow, span, p.y / spread, Float(s.tailLength) * u))
        }
        m.append(tail.scaled(u))

        // Pectoral fins: splayed out from the flank and angled down, low on the side of the head.
        let px = L * 0.12
        let pSec = body.section(atX: px)
        let pMid = (pSec.top - pSec.bottom) / 2, pHalf = (pSec.top + pSec.bottom) / 2
        m.append(pair(size: art.pectoralSize, uv: uv[2], kind: shark ? .rigid : .pectoral, flow: 0,
                      root: V3(px, pMid - pHalf * 0.24, pSec.halfWidth * 0.9), splay: 0.55, droop: 0.35, unit: u))

        // Pelvic fins, on the belly.
        let vx = a - pelvic.fromNose * L
        let vSec = body.section(atX: vx)
        m.append(pair(size: pelvic.size, uv: uv[3], kind: shark ? .rigid : .pelvic, flow: pelvic.flow,
                      root: V3(vx, -vSec.bottom * 0.88, vSec.halfWidth * 0.42), splay: pelvic.splay,
                      droop: pelvic.droop, unit: u))

        // The neon tetra's adipose fin: a little fleshy lobe on the back, behind the dorsal fin.
        if let adipose {
            let w = CGFloat(adipose.width) / Art.scale, h = CGFloat(adipose.height) / Art.scale
            let x = CGFloat(-a + 0.15 * L)
            let base = CGFloat(body.section(atX: Float(x)).top) - h * 0.3
            let r = CGRect(x: x - w / 2, y: base, width: w, height: h)
            var lobe = grid(r, image: r, uv: uv[4], columns: 3, rows: 2)
            for p in lobe.positions {
                lobe.colors.append(data(.median, 0.3, max(0, p.y - Float(base) - Float(h) * 0.3) * u,
                                        (p.x - Float(r.minX)) / Float(w), Float(w) * u))
            }
            m.append(lobe.scaled(u))
        }

        let geo = m.geometry()
        geo.materials = [material(atlas, solid: shark)]
        return geo
    }

    /// Fins are translucent, glowing where light shines through them (see `FishShaders.finGlow`),
    /// except a shark's, which are solid and matte.
    static func material(_ image: CGImage, solid: Bool) -> SCNMaterial {
        let mat = SCNMaterial()
        mat.lightingModel = .physicallyBased
        mat.diffuse.contents = image
        mat.roughness.contents = solid ? 0.85 : 0.5
        mat.isDoubleSided = true
        mat.writesToDepthBuffer = solid
        if solid {
            // Cut out the fin shape and draw it opaque (blending made even fully opaque pixels look
            // see-through, as SceneKit routes any texture with alpha through its transparent pass).
            mat.blendMode = .replace
            mat.shaderModifiers = [.geometry: FishShaders.fins, .fragment: Shaders.alphaCutout]
        } else {
            mat.blendMode = .alpha
            mat.shaderModifiers = [.geometry: FishShaders.fins, .surface: FishShaders.finGlow]
        }
        return mat
    }

    // MARK: - Species

    /// How loosely a species' fins flow (0 = stiff ... 1 = long and billowing, like a betta's).
    static func flowiness(_ s: Species) -> CGFloat {
        if s.shape == .shark { return 0 }
        let finHeight = max(s.dorsal.height, s.anal.height) / s.length
        let tail = s.tailStyle == .flowing ? s.tailLength / s.length : 0
        return min(1, 0.1 + finHeight * 0.55 + tail * 0.7)
    }

    /// Pelvic fins: where they sit (fraction of body length behind the nose), how they hang, and how
    /// they look. Angelfish trail long threads; a betta's hang like ribbons.
    private static func pelvicImage(_ s: Species) -> (image: CGImage, size: CGSize, fromNose: Float, splay: Float, droop: Float, flow: Float) {
        let L = s.length
        switch s.id {
        case Species.angelfish.id:
            let size = CGSize(width: L * 1.05, height: 3.2)
            let img = Art.image(size: size) { ctx in
                let path = CGMutablePath()
                path.move(to: CGPoint(x: size.width, y: 0.2))
                path.addQuadCurve(to: CGPoint(x: 0, y: 1.3), control: CGPoint(x: size.width * 0.4, y: 0.6))
                path.addQuadCurve(to: CGPoint(x: size.width, y: 3.0), control: CGPoint(x: size.width * 0.4, y: 2.2))
                path.closeSubpath()
                ctx.addPath(path)
                ctx.clip()
                // Pale threads with a dark band near the root, like the body's stripes.
                Art.linear(ctx, [RGBA(0.1, 0.1, 0.1, 0.8), RGBA(0.1, 0.1, 0.1, 0.8), s.fin.lighter(0.3).alpha(0.7),
                                 s.fin.lighter(0.5).alpha(0.35)], [0, 0.12, 0.2, 1],
                           from: CGPoint(x: size.width, y: 0), to: CGPoint(x: 0, y: 0))
            }
            return (img, size, 0.34, 0.12, 1.0, 0.9)
        case Species.betta.id:
            let size = CGSize(width: L * 0.62, height: L * 0.15)
            let img = Art.image(size: size) { ctx in
                let w = size.width, h = size.height
                let path = CGMutablePath()
                path.move(to: CGPoint(x: w, y: h * 0.25))
                path.addQuadCurve(to: CGPoint(x: 0, y: h * 0.3), control: CGPoint(x: w * 0.35, y: -h * 0.1))
                path.addQuadCurve(to: CGPoint(x: w, y: h * 0.8), control: CGPoint(x: w * 0.45, y: h * 1.1))
                path.closeSubpath()
                paint(ctx, path, s, size: size)
            }
            return (img, size, 0.32, 0.2, 0.95, 1)
        default:
            let shark = s.shape == .shark
            let size = CGSize(width: max(5, L * (shark ? 0.13 : 0.17)), height: max(3, L * (shark ? 0.08 : 0.075)))
            let img = Art.image(size: size) { ctx in
                let w = size.width, h = size.height
                let path = CGMutablePath()
                path.move(to: CGPoint(x: w, y: h * 0.15))
                path.addQuadCurve(to: CGPoint(x: 1, y: h * 0.3), control: CGPoint(x: w * 0.45, y: 0))
                path.addQuadCurve(to: CGPoint(x: w, y: h * 0.9), control: CGPoint(x: w * 0.4, y: h))
                path.closeSubpath()
                paint(ctx, path, s, size: size)
            }
            let fromNose: Float = shark ? 0.64 : (s.id == Species.clownfish.id ? 0.38 : 0.5)
            return (img, size, fromNose, shark ? 0.6 : 0.3, shark ? 0.45 : 0.6, 0.15)
        }
    }

    private static func adiposeImage(_ s: Species) -> CGImage {
        let size = CGSize(width: s.length * 0.12, height: s.height * 0.3)
        return Art.image(size: size) { ctx in
            let w = size.width, h = size.height
            let path = CGMutablePath()
            path.move(to: CGPoint(x: w, y: 0))
            path.addQuadCurve(to: CGPoint(x: w * 0.25, y: h * 0.9), control: CGPoint(x: w * 0.8, y: h * 1.05))
            path.addQuadCurve(to: CGPoint(x: 0, y: 0), control: CGPoint(x: 0, y: h * 0.6))
            path.closeSubpath()
            ctx.addPath(path)
            ctx.clip()
            Art.linear(ctx, [s.fin.alpha(0.7), s.fin.lighter(0.3).alpha(0.4)],
                       from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: h))
        }
    }

    /// Fill a paired fin shape: solid like the body for the shark, else translucent with rays.
    private static func paint(_ ctx: CGContext, _ path: CGPath, _ s: Species, size: CGSize) {
        ctx.addPath(path)
        ctx.clip()
        let w = size.width, h = size.height
        if s.shape == .shark {
            Art.linear(ctx, [s.top, s.mid], from: CGPoint(x: 0, y: h), to: CGPoint(x: 0, y: 0))
            return
        }
        Art.linear(ctx, [s.fin.lighter(0.05), s.fin.lighter(0.3).alpha(s.fin.a * 0.45)],
                   from: CGPoint(x: w, y: 0), to: CGPoint(x: 0, y: 0))
        ctx.setStrokeColor(s.fin.darker(0.35).alpha(0.3).cg)
        ctx.setLineWidth(0.45)
        for k in 0...5 {
            let f = CGFloat(k) / 5
            ctx.move(to: CGPoint(x: w, y: h * (0.2 + 0.6 * f)))
            ctx.addLine(to: CGPoint(x: 0, y: h * (0.1 + 0.8 * f)))
        }
        ctx.strokePath()
    }

    // MARK: - Mesh building

    /// A paired fin on both sides. The image's right edge is the root; the fin is swung back and out
    /// by `splay`, then angled down by `droop` (radians). `root` is the right-hand root in species points.
    private static func pair(size: CGSize, uv: CGRect, kind: Kind, flow: Float, root: V3,
                             splay: Float, droop: Float, unit u: Float) -> Mesh {
        let r = CGRect(x: -size.width, y: -size.height / 2, width: size.width, height: size.height)
        let fin = grid(r, image: r, uv: uv, columns: kind == .pelvic && flow > 0.5 ? 12 : 4, rows: 1)
        var both = Mesh()
        for side: Float in [1, -1] {
            let rot = simd_float4x4(simd_quatf(angle: side * splay, axis: V3(0, 1, 0)) * simd_quatf(angle: droop, axis: V3(0, 0, 1)))
            let tip = rot * SIMD4<Float>(-1, 0, 0, 0)
            var piece = fin.scaled(u)
            piece.colors = fin.positions.map { data(kind, flow, side * (-$0.x * u + 1e-6), tip.x, tip.y) }
            both.append(piece, transform: simd_float4x4(translation: V3(root.x, root.y, root.z * side) * u) * rot)
        }
        return both
    }

    /// A flat grid over `r` (species points, normal +z) textured from the part of the atlas at `uv`,
    /// where `image` is the rectangle the whole image covers.
    private static func grid(_ r: CGRect, image: CGRect, uv: CGRect, columns: Int, rows: Int) -> Mesh {
        var m = Mesh()
        for j in 0...rows {
            for i in 0...columns {
                let x = Float(r.minX + r.width * CGFloat(i) / CGFloat(columns))
                let y = Float(r.minY + r.height * CGFloat(j) / CGFloat(rows))
                m.positions.append(V3(x, y, 0))
                let fu = (CGFloat(x) - image.minX) / image.width, fv = (CGFloat(y) - image.minY) / image.height
                m.uvs.append(V2(Float(uv.minX + fu * uv.width), Float(uv.minY + (1 - fv) * uv.height)))
            }
        }
        for j in 0..<rows {
            for i in 0..<columns {
                let a = j * (columns + 1) + i, c = a + columns + 1
                m.triangle(a, a + 1, c)
                m.triangle(a + 1, c + 1, c)
            }
        }
        m.normals = Array(repeating: V3(0, 0, 1), count: m.positions.count)
        return m
    }

    /// Per-vertex fin data for the shader: (kind + flow / 2, span, a, b). For median fins and the
    /// tail, span is the distance from the body (model units, or 0...1 of the tail) and a/b place the
    /// vertex along the fin; for paired fins span is the signed distance from the root edge
    /// (sign = side) and a/b are the x/y of the fin's root-to-tip direction.
    private static func data(_ kind: Kind, _ flow: Float, _ span: Float, _ a: Float, _ b: Float) -> SIMD4<Float> {
        SIMD4(kind.rawValue + clamp(flow, 0, 0.999) / 2, span, a, b)
    }

    /// Stack images vertically (2px gaps) into one atlas; returns each one's UV rect (top-left origin).
    private static func pack(_ parts: [CGImage]) -> (CGImage, [CGRect]) {
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
        return (ctx.makeImage()!, rects)
    }
}

private extension Mesh {
    func scaled(_ u: Float) -> Mesh {
        var m = self
        m.positions = m.positions.map { $0 * u }
        return m
    }
}
