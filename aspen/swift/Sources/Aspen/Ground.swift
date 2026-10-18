import CoreGraphics
import Foundation
import Metal
import simd

// The snow: a soft, rolling snowpack that keeps the prints of hares, the grouse's roost and burst,
// and the pits of fallen snow, and slowly fills them in; the baked shadows of the far trunks and
// the contact shade round every trunk base; the dead grass that pokes through it; and the far
// grove wall where the trunks fade into the haze.

typealias HeightFn = (Float, Float) -> Float

/// A shallow well round a trunk.
struct Well { let x: Float, z: Float, r: Float, depth: Float }
/// A buried shrub or log: a lump under the snow.
struct Lump { let x: Float, z: Float, r: Float, h: Float }
/// Snow banked along a fallen trunk lying from (x, z) along (dx, dz).
struct Capsule { let x: Float, z: Float, dx: Float, dz: Float, L: Float, r: Float, h: Float }

/// The print map covers the ground where the animals live: 64 m square, 3.1 cm a texel.
enum PrintMap {
    static let x0: Float = -32, z0: Float = -58, size: Float = 64
    static let res = 2048
    /// The byte value of undisturbed snow, and bytes per metre of depth.
    static let zero: Int = 200
    static let scale: Float = 400
}

/// The snow's surface height (m) at (x, z), before any prints.
func makeHeight(wells: [Well], lumps: [Lump], capsules: [Capsule]) -> HeightFn {
    enum Item { case well(Well), lump(Lump), capsule(Capsule) }
    var grid: [Int: [Item]] = [:]
    func key(_ i: Int, _ j: Int) -> Int { i * 10007 + j }
    func put(_ item: Item, _ x: Float, _ z: Float, _ r: Float) {
        for i in Int(floor((x - r) / 10))...Int(floor((x + r) / 10)) {
            for j in Int(floor((z - r) / 10))...Int(floor((z + r) / 10)) {
                grid[key(i, j), default: []].append(item)
            }
        }
    }
    for w in wells { put(.well(w), w.x, w.z, w.r * 1.6) }
    for l in lumps { put(.lump(l), l.x, l.z, l.r * 1.4) }
    for c in capsules { put(.capsule(c), c.x, c.z, c.L + c.r * 2) }
    let cells = grid
    return { x, z in
        let dx = Double(x), dz = Double(z)
        // Gentle swells of drifted snow over the grove floor, and a lumpier scale of hummocks.
        var h = (fbm2(dx / 26 + 3.1, dz / 26 + 7.7, 4) - 0.5) * 0.9
        h += (fbm2(dx / 7 + 11, dz / 7 + 5, 3) - 0.5) * 0.28
        let hum = noise2(dx / 2.6 + 40, dz / 2.6 + 13)
        h += smoothstep(0.6, 0.95, hum) * 0.1
        // The land rises a little far off, so the grove floor doesn't read as a plane.
        let d = hypot(dx, dz + 40)
        h += smoothstep(90, 300, d) * 3 * (0.6 + 0.4 * noise2(dx / 50, dz / 50))
        var hf = Float(h)
        if let list = cells[key(Int(floor(x / 10)), Int(floor(z / 10)))] {
            for item in list {
                switch item {
                case .well(let o):
                    // Round a trunk the snow is a little lower (the trunk's warmth and the crown
                    // above), with a small collar banked right against the bark.
                    let r = hypot(x - o.x, z - o.z) / o.r
                    if r < 1.6 { hf -= o.depth * exp(-r * r * 2.0) * smoothstep(0.1, 0.5, r) }
                    if r < 0.6 { hf += o.depth * 0.8 * (1 - smoothstep(0.15, 0.6, r)) }
                case .lump(let o):
                    let r = hypot(x - o.x, z - o.z) / o.r
                    if r < 1.3 { hf += o.h * exp(-r * r * 2.6) }
                case .capsule(let o):
                    // Snow banked along a fallen trunk.
                    let px = x - o.x, pz = z - o.z
                    let along = clamp(px * o.dx + pz * o.dz, 0, o.L)
                    let dist = hypot(px - o.dx * along, pz - o.dz * along) / o.r
                    if dist < 2.5 { hf += o.h * exp(-dist * dist * 0.8) }
                }
            }
        }
        return hf
    }
}

/// The same height function sampled once onto a 20 cm grid over the near ground, for the many
/// cheap lookups (every snowflake, every frame); the exact function beyond it.
func cacheHeight(_ height: @escaping HeightFn, x0: Float = -45, z0: Float = -75, w: Float = 90, d: Float = 85, step: Float = 0.2) -> HeightFn {
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

// MARK: - Baked maps

/// R: the sun's shadows of every trunk the shadow map can't reach (a run of discs along the ground
/// away from the sun, one per slice of the trunk and the crown). Covers 400 x 260 m at 2 texels a metre.
enum CanopyMap { static let x0: Float = -200, z0: Float = -240, w: Float = 400, d: Float = 260, px: Float = 2 }
/// Contact shade, the ambient light cut off round the foot of every trunk and under every log:
/// finer (12 cm a texel) and over the near ground only.
enum ContactMap { static let x0: Float = -48, z0: Float = -84, w: Float = 96, d: Float = 90, px: Float = 8 }

struct Caster { let x: Float, z: Float, height: Float, crownBase: Float, maxR: Float, baseR: Float }

/// A disc of contact shade, or (with `L`) a run of them along something lying on the ground.
struct Contact {
    var x: Float, z: Float, dx: Float = 0, dz: Float = 0, L: Float = 0, r: Float, k: Float
}

func bakeCanopy(_ casters: [Caster], sunDir: V3) -> MTLTexture {
    let C = CanopyMap.self
    let nx = Int((C.w * C.px).rounded()), nz = Int((C.d * C.px).rounded())
    var acc = [Float](repeating: 0, count: nx * nz)
    let flat = hypot(sunDir.x, sunDir.z)
    let sx = -sunDir.x / flat, sz = -sunDir.z / flat
    let run = flat / sunDir.y            // metres of shadow per metre of height
    func disc(_ cx: Float, _ cz: Float, _ r: Float, _ k: Float, _ soft: Float = 0.55) {
        let i0 = max(0, Int(floor((cx - r - C.x0) * C.px))), i1 = min(nx - 1, Int(ceil((cx + r - C.x0) * C.px)))
        let j0 = max(0, Int(floor((cz - r - C.z0) * C.px))), j1 = min(nz - 1, Int(ceil((cz + r - C.z0) * C.px)))
        if i0 > i1 || j0 > j1 { return }
        for j in j0...j1 {
            for i in i0...i1 {
                let dx = C.x0 + (Float(i) + 0.5) / C.px - cx, dz = C.z0 + (Float(j) + 0.5) / C.px - cz
                let v = k * smoothstep(r, r * soft, hypot(dx, dz))
                let q = j * nx + i
                if v > acc[q] { acc[q] = v }
            }
        }
    }
    for t in casters {
        var y: Float = 0.3
        while y < t.height {
            let f = (y - t.crownBase) / max(0.1, t.height - t.crownBase)
            let r = f < 0 ? t.baseR * (1 - y / t.height * 0.6) + 0.3 : t.maxR * sin(.pi * min(1, f)) * 0.5 + 0.3
            disc(t.x + sx * y * run, t.z + sz * y * run, r, f < 0 ? 0.8 : 0.35)
            y += 0.6
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

/// Contact shade: the sky's light cut off where something stands on the snow, darkest right at
/// the foot and fading out over a radius or two.
func bakeContact(_ contacts: [Contact]) -> MTLTexture {
    let C = ContactMap.self
    let nx = Int((C.w * C.px).rounded()), nz = Int((C.d * C.px).rounded())
    var acc = [Float](repeating: 0, count: nx * nz)
    func spot(_ cx: Float, _ cz: Float, _ r: Float, _ k: Float) {
        let reach = r * 2.2
        let i0 = max(0, Int(floor((cx - reach - C.x0) * C.px))), i1 = min(nx - 1, Int(ceil((cx + reach - C.x0) * C.px)))
        let j0 = max(0, Int(floor((cz - reach - C.z0) * C.px))), j1 = min(nz - 1, Int(ceil((cz + reach - C.z0) * C.px)))
        if i0 > i1 || j0 > j1 { return }
        for j in j0...j1 {
            for i in i0...i1 {
                let dx = C.x0 + (Float(i) + 0.5) / C.px - cx, dz = C.z0 + (Float(j) + 0.5) / C.px - cz
                let u = hypot(dx, dz) / r
                let v = k * exp(-u * u * 1.6)
                let q = j * nx + i
                acc[q] = 1 - (1 - acc[q]) * (1 - v)
            }
        }
    }
    for c in contacts {
        if c.L > 0 {
            var s: Float = 0
            while s <= c.L {
                spot(c.x + c.dx * s, c.z + c.dz * s, c.r, c.k)
                s += c.r * 0.5
            }
        } else {
            spot(c.x, c.z, c.r, c.k)
        }
    }
    let out = acc.map { UInt8((min(1, $0) * 255).rounded()) }
    return GPU.shared.data(out, width: nx, height: nz, channels: 1)
}

// MARK: - The snowpack

/// The snow's surface: a grid denser in front of the viewer and coarse toward the horizon, lit as
/// three's standard material with the prints and the fine grain in its normal, a glitter of
/// crystal facets in sunlight, and the baked shadows and contact shade.
final class Snowpack {
    private let height: HeightFn
    private var prints: [UInt8]
    private let printTex: MTLTexture
    /// The bounding box (texels) of every print not yet fully filled in, and of what changed since the last upload.
    private var dirty: (i0: Int, j0: Int, i1: Int, j1: Int)?
    private var upload: (i0: Int, j0: Int, i1: Int, j1: Int)?
    private var fillTimer: Float = 0
    var canopy: MTLTexture?
    var contact: MTLTexture?
    private let mesh: GPUMesh
    private let grain = Snowpack.grainTexture

    init(height: @escaping HeightFn) {
        self.height = height
        let res = PrintMap.res
        let initial = [UInt8](repeating: UInt8(PrintMap.zero), count: res * res)
        let tex = GPU.shared.dynamicR8(width: res, height: res)
        initial.withUnsafeBytes { tex.replace(region: MTLRegionMake2D(0, 0, res, res), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: res) }
        prints = initial
        printTex = tex
        mesh = Snowpack.geometry(height, n: 720, extent: 300).upload()
    }

    /// A grid denser in front of the viewer and coarse toward the horizon.
    private static func geometry(_ height: @escaping HeightFn, n: Int, extent: Float) -> MeshData {
        let cz: Float = -12
        func warp(_ t: Float) -> Float { (t < 0 ? -1 : 1) * extent * pow(abs(t), 2.2) }
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

    /// The fine texture of settled snow (soft lumps where flakes piled, and a few wind ripples),
    /// painted once as the slope of its height over a 16 m tile, rather than computed per pixel
    /// every frame as the web version does: the same look at a fraction of the cost, and the
    /// mipmaps keep it from shimmering far off.
    static let tile: Double = 16
    static let grainTexture: MTLTexture = {
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
        /// Fractal periodic noise at `cells` per tile, doubling each octave.
        func pfbm(_ u: Double, _ v: Double, _ cells: Int, _ octaves: Int) -> Double {
            var sum = 0.0, amp = 0.5, c = cells, total = 0.0
            for o in 0..<octaves {
                sum += pn(u * Double(c) + Double(o) * 3.1, v * Double(c) + Double(o) * 7.7, c) * amp
                total += amp
                amp *= 0.5
                c *= 2
            }
            return sum / total
        }
        // u, v in tile units (0..1).
        func height(_ u: Double, _ v: Double) -> Double {
            // Soft lumps (the web version's fbm(p * 2.2), vnoise(p * 9), vnoise(p * 40)).
            var r = pfbm(u, v, 35, 4) * 0.02 * 2 * 0.47 + pn(u * 144, v * 144, 144) * 0.006 + pn(u * 640, v * 640, 640) * 0.0015
            // Wind ripples about 0.9 m apart, running across (0.79, 0.62), warped and in patches.
            let phase = 2 * Double.pi * (14 * u + 11 * v) + pfbm(u, v, 5, 3) * 5
            let rip = sin(phase) * 0.5 + 0.5
            r += rip * rip * smoothstep(0.45, 0.75, pfbm(u + 0.3, v + 0.6, 2, 3)) * 0.006
            return r
        }
        var h = [Float](repeating: 0, count: n * n)
        h.withUnsafeMutableBufferPointer { buf in
            let b = buf.baseAddress!
            DispatchQueue.concurrentPerform(iterations: n) { j in
                for i in 0..<n { b[j * n + i] = Float(height(Double(i) / Double(n), Double(j) / Double(n))) }
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

    func inMap(_ x: Float, _ z: Float) -> Bool {
        x > PrintMap.x0 + 1 && x < PrintMap.x0 + PrintMap.size - 1 && z > PrintMap.z0 + 1 && z < PrintMap.z0 + PrintMap.size - 1
    }

    /// Apply `depthAt(dx, dz)` (metres, negative down) over a square of half-size `reach` round (x, z).
    func stamp(_ x: Float, _ z: Float, reach: Float, _ depthAt: (Float, Float) -> Float) {
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

    /// A hare's landing: the classic set of four, the two long hind feet side by side ahead of the
    /// two small fore feet, one behind the other. `heading` is the direction of travel, radians
    /// from +x toward +z; `scale` the hare's size.
    func stampHare(_ x: Float, _ z: Float, heading: Float, scale: Float = 1) {
        let fx = cos(heading), fz = sin(heading), sx = -fz, sz = fx
        struct Foot { let f: Float, s: Float, l: Float, w: Float, d: Float }
        let feet = [Foot(f: 0.12, s: 0.085, l: 0.15, w: 0.075, d: 0.07), Foot(f: 0.12, s: -0.085, l: 0.15, w: 0.075, d: 0.07),
                    Foot(f: -0.12, s: 0.02, l: 0.06, w: 0.045, d: 0.05), Foot(f: -0.25, s: -0.03, l: 0.06, w: 0.045, d: 0.05)]
        stamp(x, z, reach: 0.45 * scale) { dx, dz in
            let f = (dx * fx + dz * fz) / scale, s = (dx * sx + dz * sz) / scale
            var h: Float = 0
            for ft in feet {
                let u = (f - ft.f) / ft.l, v = (s - ft.s) / ft.w
                let r = (u * u + v * v).squareRoot()
                // A flat-floored print with steep walls, and a rim of pushed-up snow round it.
                if r < 1 { h -= ft.d * (1 - smoothstep(0.55, 1, r)) }
                else if r < 1.5 { h += 0.012 * (1 - (r - 1) / 0.5) * (ft.l > 0.1 ? 1 : 0.6) }
                // More thrown up behind the hind feet, where they pushed off.
                if u < -0.9 && u > -1.8 && abs(v) < 1.4 && ft.l > 0.1 { h += 0.012 * (1 - abs(v) / 1.4) }
            }
            return h
        }
    }

    /// The grouse bursting out: a ragged crater where it lay, the snow thrown back round it.
    func stampBurst(_ x: Float, _ z: Float, heading: Float) {
        let fx = cos(heading), fz = sin(heading)
        stamp(x, z, reach: 0.75) { dx, dz in
            let d = hypot(dx, dz)
            let a = atan2(dz, dx)
            let ragged = 0.22 + 0.06 * sin(a * 5 + x) + 0.03 * sin(a * 9 + z)
            var h: Float = 0
            let r = d / ragged
            if r < 1 { h -= 0.2 * (1 - r * r) }
            // The rim and the spray thrown out, mostly behind the direction it left.
            let back = -(dx * fx + dz * fz) / max(d, 1e-3)
            let rim = exp(-pow((r - 1.25) / 0.3, 2))
            h += rim * (0.03 + 0.03 * max(back, 0))
            return h
        }
    }

    /// Where the grouse dived in: a small hole with a short tunnel, soon drifted over.
    func stampRoost(_ x: Float, _ z: Float, heading: Float) {
        let fx = cos(heading), fz = sin(heading)
        stamp(x, z, reach: 0.5) { dx, dz in
            let f = dx * fx + dz * fz, s = -dx * fz + dz * fx
            let hole = hypot(f / 0.1, s / 0.09)
            var h: Float = hole < 1 ? -0.12 * (1 - hole * hole) : 0
            if f > 0 && f < 0.4 && abs(s) < 0.08 { h -= 0.03 * (1 - f / 0.4) }
            return h
        }
    }

    /// A clump of snow fallen from a tree: a small dent with the clump's own lump in it.
    func stampClump(_ x: Float, _ z: Float, size: Float) {
        stamp(x, z, reach: size * 2) { dx, dz in
            let r = hypot(dx, dz) / size
            if r > 1.6 { return 0 }
            return -0.03 * exp(-r * r * 1.5) + 0.02 * exp(-r * r * 6)
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
        e.setFragmentTexture(contact ?? GPU.shared.blank, index: 5)
        e.setFragmentTexture(grain, index: 6)
        mesh.draw(e)
    }
}

// MARK: - Dead grass

/// A tuft of dead grass or shrub stems poking through the snow.
struct Tuft { var x: Float, y: Float = 0, z: Float, rot: Float, scale: Float }

/// Dead grass and shrub stems poking through the snow: tufts of thin tan blades, instanced.
final class Tufts {
    private let vertices: MTLBuffer
    private let indices: MTLBuffer
    private let indexCount: Int
    private let instances: MTLBuffer
    private let count: Int

    init(_ tufts: [Tuft], rng: Seeded) {
        let R = { (lo: Float, hi: Float) in rng.r(lo, hi) }
        var m = MeshData()
        var colors: [V3] = [], phases: [Float] = []
        let blades = 9
        for _ in 0..<blades {
            let a = R(0, TAU), lean = R(0.15, 0.7), L = R(0.14, 0.42), w = R(0.004, 0.009)
            let dx = cos(a) * sin(lean), dz = sin(a) * sin(lean), dy = cos(lean)
            let bend = R(0.1, 0.5)
            let shade = R(0.6, 1.0)
            var c = V3(0.42, 0.31, 0.15) * shade
            if rng() < 0.3 { c = V3(0.2, 0.16, 0.1) * shade }   // darker woody stems
            let base = UInt32(m.positions.count)
            let segs = 3
            for s in 0...segs {
                let t = Float(s) / Float(segs)
                let px = dx * t * L + dx * bend * t * t * L * 0.5, pz = dz * t * L + dz * bend * t * t * L * 0.5
                let py = dy * t * L - bend * t * t * L * 0.4 - 0.05
                let sx = -sin(a) * w * (1 - t), sz = cos(a) * w * (1 - t)
                m.positions += [V3(px - sx, py, pz - sz), V3(px + sx, py, pz + sz)]
                colors += [c, c]
                phases += [t, t]
            }
            for s in 0..<UInt32(segs) {
                let k = base + s * 2
                m.indices += [k, k + 2, k + 1, k + 1, k + 2, k + 3]
            }
        }
        m.computeVertexNormals()
        // (position, phase), (normal, 0), (colour, 0) per vertex.
        var verts: [V4] = []
        for i in m.positions.indices { verts += [V4(m.positions[i], phases[i]), V4(m.normals[i], 0), V4(colors[i], 0)] }
        vertices = GPU.shared.buffer(verts)
        indices = GPU.shared.buffer(m.indices)
        indexCount = m.indices.count
        let mats = tufts.map { compose(V3($0.x, $0.y, $0.z), quatAxis($0.rot, 0, 1, 0), V3(repeating: $0.scale)) }
        instances = GPU.shared.buffer(mats)
        count = tufts.count
    }

    func draw(_ ctx: DrawContext) {
        guard count > 0 else { return }
        let e = ctx.encoder
        ctx.use("tuftVertex", "tuftFragment")
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.setVertexBuffer(instances, offset: 0, index: 3)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint32, indexBuffer: indices,
                                indexBufferOffset: 0, instanceCount: count)
    }
}

// MARK: - The far grove wall

/// Pale trunks drawn in metres on a canvas, standing where the real trees end and the haze takes
/// over, so the grove never shows a back edge.
final class Horizon {
    private let mesh: GPUMesh
    private let texture: MTLTexture

    init(height: HeightFn, rng: Seeded) {
        let dist: Float = 125, widthDeg: Float = 170, heightM: Float = 26
        let lenM = dist * widthDeg * .pi / 180
        let px = min(10, 14000 / lenM)
        texture = Horizon.mask(Horizon.wall(Double(lenM), Double(heightM), Double(px), rng))
        let segs = 64, half = widthDeg / 2 * .pi / 180
        var g = Geometry.plane(1, 1, segs, 1)
        for i in g.positions.indices {
            let u = g.positions[i].x + 0.5, v = g.positions[i].y + 0.5
            let a = -half + u * half * 2
            let x = sin(a) * dist, z = -cos(a) * dist
            g.positions[i] = V3(x, height(x, z) - 1 + v * heightM, z)
        }
        mesh = g.upload()
    }

    /// Brightness (r) and coverage (g) from the canvas, un-premultiplied. Row 0 is the top.
    private static func mask(_ c: Canvas) -> MTLTexture {
        let w = c.width, h = c.height, d = c.data
        var out = [UInt8](repeating: 0, count: w * h * 2)
        for i in 0..<(w * h) {
            let a = d[i * 4 + 3]
            out[i * 2] = a == 0 ? 0 : UInt8(min(255, Int(d[i * 4]) * 255 / Int(a)))
            out[i * 2 + 1] = a
        }
        return GPU.shared.data(out, width: w, height: h, channels: 2)
    }

    private static func wall(_ widthM: Double, _ heightM: Double, _ px: Double, _ rng: Seeded) -> Canvas {
        let w = Int((widthM * px).rounded()), h = Int((heightM * px).rounded())
        let R = { (lo: Double, hi: Double) in lo + rng.next() * (hi - lo) }
        let c = Canvas(w, h)
        let ctx = c.ctx
        ctx.saveGState()
        ctx.scaleBy(x: px, y: px)
        let W = widthM, H = heightM
        // Trunks: pale, with darker bases and black eyes; crowns: a grey mist of twigs.
        var x = -1.0
        while x < W + 1 {
            let base = H - R(0.2, 1.2), top = R(0.5, 4), r = R(0.08, 0.2)
            let lean = R(-0.03, 0.03)
            let v = R(170, 215) / 255
            let path = CGMutablePath()
            path.move(to: CGPoint(x: x - r, y: base))
            path.addLine(to: CGPoint(x: x + r, y: base))
            path.addLine(to: CGPoint(x: x + lean * (base - top) + r * 0.35, y: top))
            path.addLine(to: CGPoint(x: x + lean * (base - top) - r * 0.35, y: top))
            path.closeSubpath()
            c.clipped(path) {
                c.linearGradient(from: CGPoint(x: 0, y: base), to: CGPoint(x: 0, y: top),
                                 [(0, RGBA(v * 0.35, v * 0.35, v * 0.35)), (0.1, RGBA(v, v, v * 0.96)), (1, RGBA(v * 0.85, v * 0.85, v * 0.82))])
            }
            c.fill(RGBA.bytes(40, 38, 34))
            var y = base - 2
            while y > top + 4 {
                defer { y -= R(0.8, 2.5) }
                if rng.next() < 0.5 { continue }
                let cx = x + lean * (base - y)
                c.fillEllipse(cx + R(-r, r) * 0.5, y, R(0.06, 0.12), R(0.03, 0.05))
            }
            // The crown: a few rising strokes.
            c.stroke(RGBA.bytes(90, 86, 80, 0.7))
            for _ in 0..<5 {
                let y0 = top + R(2, 9), cx = x + lean * (base - y0)
                let dir = R(-1, 1)
                let lw = R(0.04, 0.09)
                c.line(cx, y0, cx + dir * R(1.5, 3), y0 - R(2.5, 5), width: lw)
            }
            x += R(0.9, 2.6)
        }
        ctx.restoreGState()
        // The twig mist over everything, denser in the upper part.
        let d = c.data
        DispatchQueue.concurrentPerform(iterations: h) { yy in
            let my = Double(yy) / Double(h)
            let mist = smoothstep(0.75, 0.15, my) * 0.55
            for xx in 0..<w {
                let i = (yy * w + xx) * 4
                let n = fbm2(Double(xx) / px / 2.5, Double(yy) / px / 2.5, 3)
                let a = mist * smoothstep(0.35, 0.75, n) * 255
                if a > Double(d[i + 3]) {
                    let g = UInt8(120 * a / 255)
                    d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = UInt8(a)
                }
            }
        }
        return c
    }

    func draw(_ ctx: DrawContext) {
        let e = ctx.encoder
        ctx.use("horizonVertex", "horizonFragment")
        e.setFragmentTexture(texture, index: 3)
        mesh.draw(e)
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
    constant float4 contactRect = float4(\(ContactMap.x0), \(ContactMap.z0), \(ContactMap.w), \(ContactMap.d));

    float printH(texture2d<float> prints, sampler s, float2 p) {
        float2 uv = (p - printRect.xy) / printRect.z;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
        return (prints.sample(s, uv).r * 255.0 - \(PrintMap.zero).0) / \(PrintMap.scale);
    }

    fragment float4 snowpackFragment(SnowOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                     depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                     texture2d<float> prints [[texture(3)]], texture2d<float> canopy [[texture(4)]],
                                     texture2d<float> contact [[texture(5)]], texture2d<float> grainTex [[texture(6)]],
                                     sampler rs [[sampler(0)]], sampler cs [[sampler(1)]], sampler cmp [[sampler(2)]]) {
        float3 n = normalize(in.normal);
        float geo = geometryRoughness(n);
        float snowCavity = 0.0;
        {
            float2 p = in.world.xz;
            float e = printRect.z * printRect.w;
            float h0 = printH(prints, cs, p);
            float hx = printH(prints, cs, p + float2(e, 0.0)) - printH(prints, cs, p - float2(e, 0.0));
            float hz = printH(prints, cs, p + float2(0.0, e)) - printH(prints, cs, p - float2(0.0, e));
            // The grain's slope, painted once (Snowpack.grainTexture); faded with distance as the web version does.
            float fine = 1.0 - smoothstep(14.0, 50.0, length(in.world - F.camera.xyz));
            float2 gs = fine > 0.0 ? grainTex.sample(rs, p / \(Float(Snowpack.tile))).rg * fine : float2(0.0);
            float3 g = float3(hx / (2.0 * e) + gs.x, 0.0, hz / (2.0 * e) + gs.y);
            float3 nW = normalize(float3(-g.x, 1.0, -g.z));
            n = normalize(n + (nW - float3(0.0, 1.0, 0.0)));
            float slope = length(float2(hx, hz)) / (2.0 * e);
            snowCavity = clamp(-h0 * 9.0 + slope * 0.35, 0.0, 0.6);
        }
        float3 albedo = float3(0.905, 0.922, 0.965);       // #f4f6fb in linear
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, albedo, n, in.world, 0.8, 0.0, shadow, geo);
        {
            // Glitter: each centimetre of the surface holds a crystal facet tilted its own way; when
            // one happens to mirror the sun (or the moon) into the eye it flashes.
            float3 V = normalize(F.camera.xyz - in.world);
            float2 cellP = in.world.xz / 0.012;
            float2 cell = floor(cellP);
            float2 f = fract(cellP) - 0.5;
            float2 r = hash22(cell);
            float r3 = hash21(cell + 7.3);
            float3 facet = normalize(float3((r.x - 0.5) * 2.4, 1.0, (r.y - 0.5) * 2.4));
            float3 H = normalize(F.keyDir.xyz + V);
            float spec = pow(max(dot(facet, H), 0.0), 500.0);
            float dotMask = sstep(0.3, 0.08, length(f)) * step(0.9, r3);
            float px = length(fwidth2(cellP));
            float resolve = 1.0 / (1.0 + px * px * 4.0);
            float uSun = F.misc.y, uNight = F.misc.z;
            float key = mix(uSun * 1.0, uSun * 0.5, uNight);
            float glint = spec * dotMask * resolve * key * 2.0;
            c += float3(1.0, 0.98, 0.95) * glint;
        }
        // Shaded snow in a print looks blue.
        c *= mix(float3(1.0), float3(0.58, 0.66, 0.84), snowCavity);
        {
            float2 cuv = (in.world.xz - canopyRect.xy) / canopyRect.zw;
            float baked = (cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0) ? canopy.sample(cs, cuv).r : 0.0;
            // The sun's shadows of the trunks the shadow map can't reach.
            c *= 1.0 - baked * 0.55 * F.misc.y * (1.0 - F.misc.z);
            // Contact shade round the trunks, the suckers, the grass and under the fallen wood: the
            // sky's light is cut off there, so it is bluer as well as darker.
            float2 kuv = (in.world.xz - contactRect.xy) / contactRect.zw;
            float k = (kuv.x > 0.0 && kuv.y > 0.0 && kuv.x < 1.0 && kuv.y < 1.0) ? contact.sample(cs, kuv).r : 0.0;
            c *= mix(float3(1.0), float3(0.3, 0.35, 0.47), k);
            // Far off, the snow is seen between trunks and under crowns: it greys down a touch.
            float far = length(in.world - F.camera.xyz);
            c *= 1.0 - 0.12 * smoothstep(40.0, 150.0, far);
        }
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    // MARK: - Dead grass

    struct TuftOut { float4 position [[position]]; float3 world; float3 normal; float3 color; };

    vertex TuftOut tuftVertex(uint vid [[vertex_id]], uint iid [[instance_id]], device const float4* verts [[buffer(0)]],
                              constant Frame& F [[buffer(1)]], device const float4x4* inst [[buffer(3)]]) {
        float4 a = verts[vid * 3], b = verts[vid * 3 + 1], col = verts[vid * 3 + 2];
        float3 p = a.xyz;
        // Stems nod in the wind, most at the tips.
        float w = length(F.wind.xy) * 0.03 + 0.01;
        float ph = F.misc.x * 1.7 + p.x * 3.0 + p.z * 2.0;
        p.xz += float2(sin(ph), cos(ph * 1.3)) * w * a.w * a.w;
        float4x4 m = inst[iid];
        float4 wp = m * float4(p, 1.0);
        TuftOut o;
        o.world = wp.xyz;
        o.normal = transformNormal(m, b.xyz);
        o.color = col.xyz;
        o.position = F.viewProj * wp;
        return o;
    }

    fragment float4 tuftFragment(TuftOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                 depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]], sampler cmp [[sampler(2)]]) {
        float3 n = normalize(in.normal);
        if (!front) n = -n;
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, in.color, n, in.world, 0.9, 0.0, shadow, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    // MARK: - The far grove wall

    struct HorizonOut { float4 position [[position]]; float2 uv; };

    vertex HorizonOut horizonVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        HorizonOut o;
        o.uv = float2(a.w, b.w);
        o.position = F.viewProj * float4(a.xyz, 1.0);
        return o;
    }

    fragment float4 horizonFragment(HorizonOut in [[stage_in]], constant Frame& F [[buffer(0)]],
                                    texture2d<float> map [[texture(3)]], sampler s [[sampler(1)]]) {
        float2 m = map.sample(s, tv(in.uv)).rg;
        if (m.g < 0.4) discard_fragment();
        float3 bark = float3(0.6, 0.6, 0.52) * m.r * 1.5 * F.skyLight.xyz;
        // Mostly haze by here.
        return float4(mix(bark, F.fogColor.xyz, 0.78), 1.0);
    }

    """
}
