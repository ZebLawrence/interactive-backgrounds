import CoreGraphics
import Foundation
import Metal
import simd

// The snow: a deep, wind-rippled snowpack that glitters in the moonlight, keeps the craters and
// wing prints the owls leave, and slowly fills them in again; and the far horizon of spruce spires
// and low hills.

typealias HeightFn = (Float, Float) -> Float

/// A tree well: the snow is shallower under a spruce, where the branches caught it.
struct Well { let x: Float, z: Float, r: Float, depth: Float }

/// The print map covers the clearing where the owls hunt: 48 m square, 4.7 cm a texel.
enum PrintMap {
    static let x0: Float = -24, z0: Float = -50, size: Float = 48
    static let res = 1024
    /// The byte value of undisturbed snow, and bytes per metre of depth.
    static let zero: Int = 200
    static let scale: Float = 400
}

/// The snow's surface height (m) at (x, z), before any prints.
func makeHeight(wells: [Well]) -> HeightFn {
    // Bucket the tree wells on a 10 m grid so each lookup checks only its neighbours.
    var grid: [Int: [Well]] = [:]
    func key(_ i: Int, _ j: Int) -> Int { i * 10007 + j }
    for w in wells { grid[key(Int(floor(w.x / 10)), Int(floor(w.z / 10))), default: []].append(w) }
    let cells = grid
    return { x, z in
        let dx = Double(x), dz = Double(z)
        // Gentle swells of drifted snow over the bog, hummocks, and the land rising far off.
        var h = (fbm2(dx / 38 + 3.1, dz / 38 + 7.7, 4) - 0.5) * 1.1
        h += (fbm2(dx / 9 + 11, dz / 9 + 5, 3) - 0.5) * 0.35
        // Snow-buried hummocks (tussocks and low shrubs under the snow), a little lumpy.
        let hum = noise2(dx / 3.4 + 40, dz / 3.4 + 13)
        h += smoothstep(0.6, 0.95, hum) * 0.13
        let d = hypot(dx, dz + 30)
        h += smoothstep(120, 420, d) * 9 * (0.6 + 0.4 * noise2(dx / 60, dz / 60))
        // The viewer stands on a low rise at the forest edge, looking down over the bog.
        h *= smoothstep(1.5, 8, hypot(dx, dz)) * 0.8 + 0.2
        h += 1.9 * exp(-(dx * dx + (dz - 2) * (dz - 2)) / 70)
        var hf = Float(h)
        // Tree wells.
        let i0 = Int(floor(x / 10)), j0 = Int(floor(z / 10))
        for i in (i0 - 1)...(i0 + 1) {
            for j in (j0 - 1)...(j0 + 1) {
                guard let list = cells[key(i, j)] else { continue }
                for w in list {
                    let r = hypot(x - w.x, z - w.z) / w.r
                    if r < 1.4 { hf -= w.depth * exp(-r * r * 2.2) }
                }
            }
        }
        return hf
    }
}

/// The same height function sampled once onto a 25 cm grid over the near ground, for the many
/// cheap lookups (every snowflake, every frame); the exact function beyond it.
func cacheHeight(_ height: @escaping HeightFn, x0: Float = -40, z0: Float = -70, w: Float = 80, d: Float = 80, step: Float = 0.25) -> HeightFn {
    let nx = Int((w / step).rounded()) + 1, nz = Int((d / step).rounded()) + 1
    var grid = [Float](repeating: 0, count: nx * nz)
    grid.withUnsafeMutableBufferPointer { g in
        let base = g.baseAddress!
        DispatchQueue.concurrentPerform(iterations: nz) { j in
            for i in 0..<nx { base[j * nx + i] = height(x0 + Float(i) * step, z0 + Float(j) * step) }
        }
    }
    let cells = grid
    return { x, z in
        let fx = (x - x0) / step, fz = (z - z0) / step
        if fx < 0 || fz < 0 || fx >= Float(nx - 1) || fz >= Float(nz - 1) { return height(x, z) }
        let i = Int(fx), j = Int(fz), u = fx - Float(i), v = fz - Float(j)
        let k = j * nx + i
        return (cells[k] * (1 - u) + cells[k + 1] * u) * (1 - v) + (cells[k + nx] * (1 - u) + cells[k + nx + 1] * u) * v
    }
}

// MARK: - Far moon shadows

/// The shadow map covers the near clearing; beyond it every tree still throws a long shadow toward
/// the viewer (the moon is low in front), so the snow darkens with distance as the forest thickens.
/// They're baked once: each tree's shadow is a run of discs along the ground away from the moon, one
/// per slice of its crown, as wide as the crown at that height.
enum CanopyMap { static let x0: Float = -230, z0: Float = -300, w: Float = 460, d: Float = 310, px: Float = 2 }

struct Caster { let x: Float, z: Float, height: Float, crownBase: Float, maxR: Float }

func bakeCanopy(_ casters: [Caster], moonDir: V3) -> MTLTexture {
    let C = CanopyMap.self
    let nx = Int((C.w * C.px).rounded()), nz = Int((C.d * C.px).rounded())
    var acc = [Float](repeating: 0, count: nx * nz)
    let flat = hypot(moonDir.x, moonDir.z)
    let sx = -moonDir.x / flat, sz = -moonDir.z / flat
    let run = flat / moonDir.y            // metres of shadow per metre of height
    func disc(_ cx: Float, _ cz: Float, _ r: Float, _ k: Float) {
        let i0 = max(0, Int(floor((cx - r - C.x0) * C.px))), i1 = min(nx - 1, Int(ceil((cx + r - C.x0) * C.px)))
        let j0 = max(0, Int(floor((cz - r - C.z0) * C.px))), j1 = min(nz - 1, Int(ceil((cz + r - C.z0) * C.px)))
        if i0 > i1 || j0 > j1 { return }
        for j in j0...j1 {
            for i in i0...i1 {
                let dx = C.x0 + (Float(i) + 0.5) / C.px - cx, dz = C.z0 + (Float(j) + 0.5) / C.px - cz
                let v = k * smoothstep(r, r * 0.55, hypot(dx, dz))
                let q = j * nx + i
                if v > acc[q] { acc[q] = v }
            }
        }
    }
    for t in casters {
        var y: Float = 0.3
        while y < t.height {
            let f = (y - t.crownBase) / max(0.1, t.height - t.crownBase)
            let r = f < 0 ? 0.15 : t.maxR * pow(max(0, 1 - f), 0.9) + 0.12
            disc(t.x + sx * y * run, t.z + sz * y * run, r, f < 0 ? 0.7 : 0.9)
            y += 0.5
        }
    }
    // A light blur for the penumbra.
    var out = [UInt8](repeating: 0, count: nx * nz)
    for j in 0..<nz {
        for i in 0..<nx {
            var s: Float = 0, n: Float = 0
            for b in -1...1 {
                for a in -1...1 {
                    let ii = i + a, jj = j + b
                    if ii < 0 || jj < 0 || ii >= nx || jj >= nz { continue }
                    s += acc[jj * nx + ii]
                    n += 1
                }
            }
            out[j * nx + i] = UInt8((s / n * 255).rounded())
        }
    }
    return GPU.shared.data(out, width: nx, height: nz, channels: 1)
}

// MARK: - The snowpack

/// The snow's surface: a grid dense in the clearing and coarse toward the horizon, lit as three's
/// standard material with the prints and the wind ripples in its normal, a sparse glitter of
/// crystal facets in the moonlight (and fainter in the aurora's), and the baked moon shadows.
final class Snowpack {
    private let height: HeightFn
    private var prints: [UInt8]
    private let printTex: MTLTexture
    /// The bounding box (texels) of every print not yet fully filled in, and of what changed since the last upload.
    private var dirty: (i0: Int, j0: Int, i1: Int, j1: Int)?
    private var upload: (i0: Int, j0: Int, i1: Int, j1: Int)?
    private var fillTimer: Float = 0
    var canopy: MTLTexture?
    private let mesh: GPUMesh
    private let ripples = Snowpack.rippleTexture

    init(height: @escaping HeightFn) {
        self.height = height
        let res = PrintMap.res
        let initial = [UInt8](repeating: UInt8(PrintMap.zero), count: res * res)
        let tex = GPU.shared.dynamicR8(width: res, height: res)
        initial.withUnsafeBytes { tex.replace(region: MTLRegionMake2D(0, 0, res, res), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: res) }
        prints = initial
        printTex = tex
        // 480 rows rather than the web version's 760: the same surface to the eye (the slivers of
        // triangle toward the horizon cost more than they show), and a millisecond less a frame.
        mesh = Snowpack.geometry(height, n: 480, extent: 460).upload()
    }

    /// A grid denser in the middle of the clearing and coarse toward the horizon.
    private static func geometry(_ height: @escaping HeightFn, n: Int, extent: Float) -> MeshData {
        let cz: Float = -16
        func warp(_ t: Float) -> Float { (t < 0 ? -1 : 1) * extent * pow(abs(t), 2.1) }
        var m = MeshData()
        let count = (n + 1) * (n + 1)
        m.positions = [V3](repeating: .zero, count: count)
        m.positions.withUnsafeMutableBufferPointer { buf in
            let p = buf.baseAddress!
            DispatchQueue.concurrentPerform(iterations: n + 1) { j in
                let z = cz + warp(Float(j) / Float(n) * 2 - 1)
                for i in 0...n {
                    let x = warp(Float(i) / Float(n) * 2 - 1)
                    p[j * (n + 1) + i] = V3(x, height(x, z), z)
                }
            }
        }
        m.uvs = [V2](repeating: .zero, count: count)
        m.indices.reserveCapacity(n * n * 6)
        for j in 0..<n {
            for i in 0..<n {
                let a = UInt32(j * (n + 1) + i), b = a + 1, c = a + UInt32(n + 1), d = c + 1
                m.indices += [a, c, b, b, c, d]
            }
        }
        m.computeVertexNormals()
        return m
    }

    /// The wind ripples (long low ridges across the prevailing wind, broken up and wandering) and the
    /// fine lumps of settled snow, painted once as the slope of their height over a 16 m tile, rather
    /// than computed per pixel every frame as the web version does: the same look at a fraction of
    /// the cost, and the mipmaps keep it from shimmering far off.
    static let tile: Double = 16
    static let rippleTexture: MTLTexture = {
        let n = 2048, T = tile
        // Value noise on a lattice wrapping every `period` cells, so the tile repeats seamlessly.
        func pn(_ x: Double, _ y: Double, _ period: Int) -> Double {
            let xi = Int(floor(x)), yi = Int(floor(y))
            let fx = x - Double(xi), fy = y - Double(yi)
            let ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
            func h(_ i: Int, _ j: Int) -> Double {
                let a = ((i % period) + period) % period, b = ((j % period) + period) % period
                return hash2(Double(a) + Double(period) * 0.37, Double(b))
            }
            return lerp(lerp(h(xi, yi), h(xi + 1, yi), ux), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), ux), uy)
        }
        /// The GLSL fbm (four octaves, amplitudes summing to 0.94) on a periodic lattice of `cells` per tile.
        func pfbm(_ u: Double, _ v: Double, _ cells: Int) -> Double {
            var sum = 0.0, amp = 0.5, c = cells
            for o in 0..<4 {
                sum += pn(u * Double(c) + Double(o) * 3.1, v * Double(c) + Double(o) * 7.7, c) * amp
                amp *= 0.5
                c *= 2
            }
            return sum
        }
        // u, v in tile units (0..1). Ridges about 0.7 m apart running across (0.79, 0.61), as the
        // web version's sin(q.x * 9.0), with the wavelength rounded so the tile repeats.
        func ripple(_ u: Double, _ v: Double) -> Double {
            let warp = pfbm(u, v, 6) * 6
            let r = sin(2 * Double.pi * (18 * u + 14 * v) + warp) * 0.5 + 0.5
            return r * r * smoothstep(0.3, 0.7, pfbm(u + 0.3, v + 0.6, 2)) * 0.012 + pfbm(u, v, 48) * 0.006
        }
        var h = [Float](repeating: 0, count: n * n)
        h.withUnsafeMutableBufferPointer { buf in
            let b = buf.baseAddress!
            DispatchQueue.concurrentPerform(iterations: n) { j in
                for i in 0..<n { b[j * n + i] = Float(ripple(Double(i) / Double(n), Double(j) / Double(n))) }
            }
        }
        // The slope (dh/dx, dh/dz) by central differences, wrapping round the tile.
        let texel = Float(T) / Float(n)
        var g = [Float16](repeating: 0, count: n * n * 2)
        for j in 0..<n {
            for i in 0..<n {
                let xp = h[j * n + (i + 1) % n], xm = h[j * n + (i + n - 1) % n]
                let zp = h[((j + 1) % n) * n + i], zm = h[((j + n - 1) % n) * n + i]
                g[(j * n + i) * 2] = Float16((xp - xm) / (2 * texel))
                g[(j * n + i) * 2 + 1] = Float16((zp - zm) / (2 * texel))
            }
        }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rg16Float, width: n, height: n, mipmapped: true)
        d.usage = .shaderRead
        d.storageMode = .shared
        let t = GPU.shared.device.makeTexture(descriptor: d)!
        g.withUnsafeBytes { t.replace(region: MTLRegionMake2D(0, 0, n, n), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: n * 4) }
        GPU.shared.generateMipmaps(t)
        return t
    }()

    /// Apply `depthAt(dx, dz)` (metres, negative down) over a square of half-size `reach` round (x, z).
    private func stamp(_ x: Float, _ z: Float, reach: Float, _ depthAt: (Float, Float) -> Float) {
        let res = PrintMap.res
        let texel = PrintMap.size / Float(res)
        let ci = (x - PrintMap.x0) / texel, cj = (z - PrintMap.z0) / texel
        let r = ceil(reach / texel)
        let j0 = max(0, Int(floor(cj - r))), j1 = min(res - 1, Int(ceil(cj + r)))
        let i0 = max(0, Int(floor(ci - r))), i1 = min(res - 1, Int(ceil(ci + r)))
        if i0 > i1 || j0 > j1 { return }
        for j in j0...j1 {
            for i in i0...i1 {
                let h = depthAt((Float(i) - ci) * texel, (Float(j) - cj) * texel)
                if h == 0 { continue }
                let k = j * res + i
                prints[k] = UInt8(clamp((Float(prints[k]) + h * PrintMap.scale).rounded(), 0, 255))
            }
        }
        extend(i0, j0, i1, j1)
    }

    /// An owl's strike: a pit where the feet and body went in, and either side the long impressions
    /// of the wings spread flat on the snow, ending in the fingered primaries; the tail fans behind.
    /// `heading` is the direction the owl was flying, radians from +x toward +z.
    func stampStrike(_ x: Float, _ z: Float, heading: Float, scale: Float = 1) {
        let fx = cos(heading), fz = sin(heading)    // forward
        let sx = -fz, sz = fx                       // to the owl's right
        stamp(x, z, reach: 0.95 * scale) { dx, dz in
            let f = (dx * fx + dz * fz) / scale, s = (dx * sx + dz * sz) / scale
            var h: Float = 0
            // The pit: an oval bowl with a little thrown-up rim.
            let pr = hypot(f / 0.24, s / 0.19)
            if pr < 1 { h -= 0.32 * pow(1 - pr * pr, 2) }
            h += 0.03 * exp(-pow((pr - 1.12) / 0.16, 2))
            // Wings: from the shoulders out to 0.72 m, the chord narrowing, swept slightly back.
            let as_ = abs(s)
            if as_ > 0.12 && as_ < 0.78 {
                let t = (as_ - 0.12) / 0.66
                let lead = 0.06 - t * 0.1, chord = lerp(0.3, 0.16, t)
                let ff = f - lead + t * 0.06
                if ff < 0 && ff > -chord {
                    let across = 1 - abs((ff + chord / 2) / (chord / 2))
                    var depth = 0.07 * smoothstep(0, 0.35, across) * (1 - t * 0.35)
                    // The primaries spread like fingers near the tip: grooves running outward.
                    if t > 0.55 {
                        let fingers = 0.5 + 0.5 * cos((ff / chord) * 6 * TAU / 2 * 2)
                        depth *= lerp(1, fingers, smoothstep(0.55, 0.8, t))
                    }
                    // Feather lines along the wing.
                    depth *= 0.85 + 0.15 * cos(ff / 0.025 * TAU)
                    h -= depth
                }
            }
            // The tail: a short fan behind the pit.
            let tf = -f - 0.2
            if tf > 0 && tf < 0.28 && abs(s) < 0.06 + tf * 0.35 { h -= 0.05 * (1 - tf / 0.28) }
            return h
        }
    }

    /// A vole's rustle: the faintest stir in the snow surface, a few crystals tossed up.
    func stampRustle(_ x: Float, _ z: Float) {
        stamp(x, z, reach: 0.12) { dx, dz in
            let d = hypot(dx, dz) / 0.12
            if d >= 1 { return 0 }
            return 0.012 * (1 - d * d) * (chance(0.5) ? 1 : -0.5)
        }
    }

    private func extend(_ i0: Int, _ j0: Int, _ i1: Int, _ j1: Int) {
        func grow(_ b: (i0: Int, j0: Int, i1: Int, j1: Int)?) -> (i0: Int, j0: Int, i1: Int, j1: Int) {
            guard let b else { return (i0, j0, i1, j1) }
            return (min(b.i0, i0), min(b.j0, j0), max(b.i1, i1), max(b.j1, j1))
        }
        dirty = grow(dirty)
        upload = grow(upload)
    }

    /// Falling snow fills the prints in, over ten minutes or so (slower without snowfall: drift).
    func update(dt: Float, snowing: Bool) {
        defer { flush() }
        guard let d = dirty else { return }
        fillTimer += dt
        if fillTimer < 2 { return }
        let step = fillTimer * (snowing ? 1 / 600 : 1 / 2400)
        fillTimer = 0
        let res = PrintMap.res, zero = PrintMap.zero
        var any = false
        for j in d.j0...d.j1 {
            for i in d.i0...d.i1 {
                let k = j * res + i
                let v = Int(prints[k])
                if v == zero { continue }
                // Ease toward undisturbed snow, always moving at least one step.
                let dd = Float(zero - v) * step
                let sgn = zero > v ? 1 : -1
                let nv = v + (abs(dd) < 1 ? (Float.random(in: 0..<1) < abs(dd) * 4 + 0.05 ? sgn : 0) : Int(dd.rounded()))
                prints[k] = UInt8(clamp(nv, 0, 255))
                if nv != zero { any = true }
            }
        }
        upload = d
        if !any { dirty = nil }
    }

    /// Copy the changed rows of the print map to the GPU.
    private func flush() {
        guard let u = upload else { return }
        upload = nil
        let res = PrintMap.res
        let w = u.i1 - u.i0 + 1, h = u.j1 - u.j0 + 1
        prints.withUnsafeBytes { buf in
            printTex.replace(region: MTLRegionMake2D(u.i0, u.j0, w, h), mipmapLevel: 0,
                             withBytes: buf.baseAddress! + u.j0 * res + u.i0, bytesPerRow: res)
        }
    }

    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        ctx.use("snowpackVertex", "snowpackFragment")
        e.setFragmentTexture(printTex, index: 3)
        e.setFragmentTexture(canopy ?? GPU.shared.blank, index: 4)
        e.setFragmentTexture(ripples, index: 5)
        mesh.draw(e)
    }
}

// MARK: - The horizon

/// The horizon: black spruce spires standing on the far edge of the bog, and two ranges of low hills
/// beyond, each a curved band facing the viewer so it holds its distance across the view. The spires
/// are drawn in metres on a canvas fine enough (about 12 px per metre at 260 m) to stay sharp at 4K.
final class Horizon {
    private struct Band { let mesh: GPUMesh; let mask: MTLTexture; var params: V4x3 }
    /// The band's colours: tint, the moonlit snow on its lower slopes (x, y, z), w unused.
    struct V4x3 { var tint: V4; var snow: V4; var pad: V4 = .zero }
    private var bands: [Band] = []

    init(height: HeightFn) {
        // The far tree line: 160 degrees of it at 260 m.
        let treeDist: Float = 260, treeW: Float = 160, treeH: Float = 22
        let lenM = treeDist * treeW * .pi / 180
        let px = min(12, 16000 / lenM)
        bands.append(Band(mesh: Horizon.arc(treeDist, treeW, treeH, lift: height(0, -treeDist) + 2.5),
                          mask: Horizon.mask(Horizon.spireLine(Double(lenM), Double(treeH), Double(px))),
                          params: V4x3(tint: .zero, snow: .zero)))
        // Two ranges of low hills, 4 and 9 km off, their snow faintly moonlit.
        bands.append(Band(mesh: Horizon.arc(4200, 170, 380, lift: -60), mask: Horizon.mask(Horizon.hills(2.3)),
                          params: V4x3(tint: V4(0.003, 0.004, 0.007, 0), snow: V4(0.006, 0.008, 0.014, 0))))
        bands.append(Band(mesh: Horizon.arc(9000, 170, 700, lift: -150), mask: Horizon.mask(Horizon.hills(8.9)),
                          params: V4x3(tint: V4(0.006, 0.008, 0.014, 0), snow: V4(0.008, 0.011, 0.02, 0))))
    }

    /// A curved band facing the viewer.
    private static func arc(_ dist: Float, _ widthDeg: Float, _ heightM: Float, lift: Float) -> GPUMesh {
        let segs = 48, half = widthDeg / 2 * .pi / 180
        var g = Geometry.plane(1, 1, segs, 1)
        for i in g.positions.indices {
            let u = g.positions[i].x + 0.5, v = g.positions[i].y + 0.5
            let a = -half + u * half * 2
            g.positions[i] = V3(sin(a) * dist, lift + v * heightM, -cos(a) * dist)
        }
        return g.upload()
    }

    /// Coverage from the canvas's alpha. Row 0 is the top (sampled at tv(uv)).
    private static func mask(_ c: Canvas) -> MTLTexture {
        let n = c.width * c.height, d = c.data
        var out = [UInt8](repeating: 0, count: n)
        for i in 0..<n { out[i] = d[i * 4 + 3] }
        return GPU.shared.data(out, width: c.width, height: c.height, channels: 1)
    }

    /// Boreal spruce: narrow spires, drooping branches with upturned tips, the odd club top.
    private static func spireLine(_ widthM: Double, _ heightM: Double, _ px: Double) -> Canvas {
        let w = Int((widthM * px).rounded()), h = Int((heightM * px).rounded())
        let c = Canvas(w, h)
        let ctx = c.ctx
        ctx.scaleBy(x: px, y: px)
        let W = widthM, H = heightM
        c.fill(RGBA(0, 0, 0))
        c.stroke(RGBA(0, 0, 0))
        ctx.setLineCap(.round)
        func groundAt(_ x: Double) -> Double { H - 1.2 - fbm2(x / 60, 1.7, 3) * 2.5 }
        let ground = CGMutablePath()
        ground.move(to: CGPoint(x: 0, y: H))
        var gx = 0.0
        while gx <= W { ground.addLine(to: CGPoint(x: gx, y: groundAt(gx))); gx += 0.5 }
        ground.addLine(to: CGPoint(x: W, y: H))
        ground.closeSubpath()
        ctx.addPath(ground)
        ctx.fillPath()
        func spruce(_ x: Double, _ base: Double, _ height: Double) {
            let top = base - height
            let lean = rndD(-0.02, 0.02)
            c.line(x, base, x + lean * height, top, width: 0.1 + height * 0.01)
            let club = chance(0.25)
            var y = top + 0.15
            while y < base - 0.4 {
                let f = (y - top) / height
                let cx = x + lean * (base - y)
                // Narrow crowns: snow-country spruce shed snow by being slender.
                var len = (0.25 + f * 0.95) * rndD(0.6, 1.1) * (height / 12)
                if club && f < 0.15 { len *= 1.8 }
                for side in [-1.0, 1.0] {
                    if chance(0.12) { continue }
                    let droop = rndD(0.25, 0.6)
                    let ex = cx + side * cos(droop) * len, ey = y + sin(droop) * len
                    c.line(cx, y, ex, ey, width: 0.05 + len * 0.06)
                    c.line(ex, ey, ex + side * 0.08, ey - rndD(0.05, 0.15), width: 0.05)
                }
                y += rndD(0.18, 0.32)
            }
            c.line(x + lean * height, top, x + lean * height, top - 0.4, width: 0.05)
        }
        var x = -3.0
        while x < W + 3 {
            defer { x += rndD(0.7, 2.4) }
            let open = fbm2(x / 45 + 3, 2.2, 2) < 0.36
            if open && chance(0.8) { continue }
            let base = groundAt(x) + rndD(0, 0.8)
            spruce(x, base, rndD(5, 13) * (chance(0.06) ? 1.4 : 1))
        }
        return c
    }

    private static func hills(_ seed: Double) -> Canvas {
        let w = 4096, h = 256
        let c = Canvas(w, h)
        c.fill(RGBA(1, 1, 1))
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: h))
        var x = 0
        while x <= w {
            let n = fbm2(Double(x) / 520 + seed, seed, 5)
            path.addLine(to: CGPoint(x: Double(x), y: Double(h) - 30 - n * n * 190))
            x += 4
        }
        path.addLine(to: CGPoint(x: w, y: h))
        path.closeSubpath()
        c.ctx.addPath(path)
        c.ctx.fillPath()
        return c
    }

    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        ctx.use("horizonVertex", "horizonFragment")
        for var b in bands {
            e.setFragmentBytes(&b.params, length: MemoryLayout<V4x3>.stride, index: 3)
            e.setFragmentTexture(b.mask, index: 3)
            b.mesh.draw(e)
        }
    }
}

extension Shaders {
    static let ground = """

    // MARK: - The snowpack

    struct SnowOut { float4 position [[position]]; float3 world; float3 normal; };

    vertex SnowOut snowpackVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        SnowOut o;
        o.world = verts[vid * 2].xyz;
        o.normal = verts[vid * 2 + 1].xyz;
        o.position = F.viewProj * float4(o.world, 1.0);
        return o;
    }

    constant float4 printRect = float4(\(PrintMap.x0), \(PrintMap.z0), \(PrintMap.size), \(1.0 / Float(PrintMap.res)));
    constant float4 canopyRect = float4(\(CanopyMap.x0), \(CanopyMap.z0), \(CanopyMap.w), \(CanopyMap.d));

    float printH(texture2d<float> prints, sampler s, float2 p) {
        float2 uv = (p - printRect.xy) / printRect.z;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
        return (prints.sample(s, uv).r * 255.0 - \(PrintMap.zero).0) / \(PrintMap.scale);
    }

    fragment float4 snowpackFragment(SnowOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                     depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                     texture2d<float> prints [[texture(3)]], texture2d<float> canopy [[texture(4)]],
                                     texture2d<float> ripples [[texture(5)]],
                                     sampler rs [[sampler(0)]], sampler cs [[sampler(1)]], sampler cmp [[sampler(2)]]) {
        float uMoon = F.misc.y;
        float3 n = length_squared(in.normal) > 1e-12 ? normalize(in.normal) : float3(0.0, 1.0, 0.0);
        float geo = geometryRoughness(n);
        float snowCavity = 0.0;
        float dist = length(in.world - F.camera.xyz);
        {
            float2 p = in.world.xz;
            float e = printRect.z * printRect.w;
            float h0 = printH(prints, cs, p);
            float hx = printH(prints, cs, p + float2(e, 0.0)) - printH(prints, cs, p - float2(e, 0.0));
            float hz = printH(prints, cs, p + float2(0.0, e)) - printH(prints, cs, p - float2(0.0, e));
            // The ripples' slope, painted once (Snowpack.rippleTexture), faded out with distance as
            // the web version does so they don't shimmer.
            float fine = 1.0 - smoothstep(25.0, 70.0, dist);
            float2 rs2 = fine > 0.0 ? ripples.sample(rs, p / \(Float(Snowpack.tile))).rg * fine : float2(0.0);
            float3 g = float3(hx / (2.0 * e) + rs2.x, 0.0, hz / (2.0 * e) + rs2.y);
            float3 nW = normalize(float3(-g.x, 1.0, -g.z));
            n = normalize(n + (nW - float3(0.0, 1.0, 0.0)));
            snowCavity = clamp(-h0 * 3.0, 0.0, 0.6);
        }
        float3 albedo = float3(0.888, 0.922, 1.0);       // #f2f6ff in linear
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, albedo, n, in.world, 0.82, 0.0, shadow, geo);
        // Glitter cells under about a sixth of a pixel can't flash (their weight below is under 1%),
        // so the far snow skips the work.
        float2 cellP = in.world.xz / 0.012;
        float cellPx = length(fwidth2(cellP));
        if (cellPx < 5.0) {
            // Glitter: each centimetre-sized cell of the surface holds a crystal facet tilted its own
            // way; when a facet happens to mirror the moon into the eye it flashes.
            float3 V = normalize(F.camera.xyz - in.world);
            float2 cell = floor(cellP);
            float2 f = fract(cellP) - 0.5;
            float2 r = hash22(cell);
            float r3 = hash21(cell + 7.3);
            // Crystals lie every which way, some steeply tilted (the moon is low, so only those can
            // mirror it back toward the viewer).
            float3 facet = normalize(float3((r.x - 0.5) * 2.4, 1.0, (r.y - 0.5) * 2.4));
            float3 H = normalize(F.moonDir.xyz + V);
            float spec = pow(max(dot(facet, H), 0.0), 500.0);
            // Only a few cells hold a facet big and flat enough to flash.
            float dotMask = sstep(0.3, 0.08, length(f)) * step(0.9, r3);
            // Once a cell is smaller than a couple of pixels a crisp glint can't be drawn, only
            // aliased into flashing squares: fade them out instead.
            float resolve = 1.0 / (1.0 + cellPx * cellPx * 4.0);
            float glint = spec * dotMask * resolve * uMoon * 2.4;
            // The aurora glints too, more faintly, in its own colour.
            float3 Ha = normalize(float3(0.0, 0.55, -0.83) + V);
            float specA = pow(max(dot(facet, Ha), 0.0), 900.0) * dotMask * resolve;
            c += float3(0.85, 0.92, 1.0) * glint + F.aurora.xyz * specA * 2.0;
        }
        c *= 1.0 - snowCavity;
        {
            // Moon shadows of the trees the shadow map can't reach, baked (see bakeCanopy).
            float2 cuv = (in.world.xz - canopyRect.xy) / canopyRect.zw;
            float shade = (cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0) ? canopy.sample(cs, cuv).r : 0.0;
            c *= 1.0 - shade * 0.8 * uMoon;
            // Far off, the snow is mostly seen between trunks and under boughs: it greys down.
            c *= 1.0 - 0.3 * smoothstep(70.0, 260.0, dist);
        }
        return float4(applyFog(F, c, dist), 1.0);
    }

    // MARK: - The horizon

    struct HorizonOut { float4 position [[position]]; float2 uv; };
    struct HorizonParams { float4 tint; float4 snow; float4 pad; };

    vertex HorizonOut horizonVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        HorizonOut o;
        o.uv = float2(a.w, b.w);
        // Bands at kilometres follow the camera, as the sky does (only its height matters here).
        o.position = F.viewProj * float4(a.xyz, 1.0);
        return o;
    }

    fragment float4 horizonFragment(HorizonOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                    constant HorizonParams& P [[buffer(3)]],
                                    texture2d<float> map [[texture(3)]], sampler s [[sampler(1)]]) {
        if (map.sample(s, tv(in.uv)).r < 0.5) discard_fragment();
        // Moonlit snow on the far slopes, fading up into dark forest.
        float3 c = P.tint.xyz + P.snow.xyz * (F.misc.y * 0.8 + 0.2) * (1.0 - in.uv.y) + F.aurora.xyz * 0.15 * (1.0 - in.uv.y);
        return float4(c, 1.0);
    }

    """
}
