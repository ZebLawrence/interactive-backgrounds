import Foundation
import Metal
import simd

// The real night sky, shared by every macOS app that has one: a port of assets/sky/realsky.js.
//
// This file is copied unchanged into each app's Sources (Meadow, Lake, Boreal, Aspen, Arch, Balloons); the
// copy in assets/sky/ is the one to edit. It needs nothing from its app beyond `GPU.shared.device` and the
// app's `Frame` uniform starting with `viewProj`, so it carries its own shaders and pipelines.
//
//   the Milky Way   NASA/Goddard SVS's Deep Star Maps 2020, 8192 x 4096, the bright stars taken out of it.
//                   The apps get it as ASTC 4x4 (milkyway.astc, made from Hangar's milkyway.ktx2 by
//                   assets/sky/tools/prepare-macos.sh), drawn on a sphere so the map mips properly.
//   the stars       the Hipparcos catalogue, 118,218 stars to V 12 (Hangar's stars.bin), drawn as points.
//
// The sky turns about the celestial pole once a sidereal day. Each app says where it is (latitude, which way
// north lies, or the painted band to match) and the pole and the starting hour follow, as on the web.
//
// Use: make one `RealSky` per scene, call `update(dt:)` every step, `fade` for the night / weather amount,
// `starFraction` 0.25 in Low Power, and `draw(_:frame:samples:)` right after the painted sky dome, in every
// pass the dome is drawn in. `ready` is false if neither file could be found; the app then keeps its painted
// Milky Way and hashed stars, as the web pages do when the fetch fails.

/// A sidereal day in seconds: how long the sky takes to come back round.
let siderealDay = 86164.0905

final class RealSky {
    typealias D3 = SIMD3<Double>

    // MARK: - The celestial frame

    private static let deg = Double.pi / 180
    private static let tau = 2 * Double.pi

    private static func radec(_ ra: Double, _ dec: Double) -> D3 {
        D3(cos(dec * deg) * cos(ra * deg), cos(dec * deg) * sin(ra * deg), sin(dec * deg))
    }
    /// Sgr A*, at the heart of the bulge.
    static let galacticCenter = radec(266.405, -28.936)
    /// The north galactic pole: the normal of the band's plane.
    static let galacticPole = radec(192.8595, 27.1283)
    /// The angle between the galactic pole and the celestial pole.
    static let bandToPole = acos(abs(galacticPole.z))

    /// Map value to linear radiance, times the exposure these backgrounds are graded at (realsky.js).
    static let milkyWayGain: Float = 0.42
    /// Linear brightness of a V 0 star's centre pixel.
    static let starGain: Float = 2.4

    /// ICRS (x toward RA 0, z toward the north celestial pole) to world (y up, azimuth atan2(z, x)).
    struct CelestialFrame {
        let latitude: Double
        let north: Double
        let pole: D3
        private let e1: D3, e2: D3
        private(set) var angle: Double = 0
        private(set) var x = D3(1, 0, 0), y = D3(0, 1, 0)

        init(latitude: Double, north: Double, angle: Double = 0) {
            self.latitude = latitude
            self.north = north
            let lat = latitude * RealSky.deg
            pole = D3(cos(lat) * cos(north), sin(lat), cos(lat) * sin(north))
            let seed = abs(pole.y) > 0.9 ? D3(1, 0, 0) : D3(0, 1, 0)
            e1 = simd_normalize(seed - pole * simd_dot(seed, pole))
            e2 = simd_cross(pole, e1)
            setAngle(angle)
        }

        mutating func setAngle(_ a: Double) {
            angle = a
            let c = cos(a), s = sin(a)
            x = e1 * c + e2 * s
            y = e2 * c - e1 * s
        }

        /// The sky's turn over `dt` seconds: negative, which makes stars rise in the east.
        mutating func advance(_ dt: Double) { setAngle(angle - RealSky.tau * dt / siderealDay) }

        func toWorld(_ d: D3) -> D3 { x * d.x + y * d.y + pole * d.z }

        /// ICRS to world as a matrix.
        var matrix: simd_float4x4 {
            func f(_ v: D3) -> SIMD4<Float> { SIMD4<Float>(Float(v.x), Float(v.y), Float(v.z), 0) }
            return simd_float4x4(columns: (f(x), f(y), f(pole), SIMD4<Float>(0, 0, 0, 1)))
        }

        /// The turn that puts the band's plane where `normal` has it, the galactic centre as high as that allows.
        mutating func bestAngle(for normal: D3) -> Double {
            let target = simd_normalize(normal)
            func score(_ a: Double) -> Double {
                setAngle(a)
                return acos(min(1, abs(simd_dot(toWorld(RealSky.galacticPole), target))))
            }
            let step = 0.25 * RealSky.deg
            var best = Double.infinity
            var a = 0.0
            while a < RealSky.tau { best = min(best, score(a)); a += step }
            var chosen = 0.0, highest = -Double.infinity
            a = 0
            while a < RealSky.tau {
                if score(a) <= best + 2 * RealSky.deg {
                    let h = toWorld(RealSky.galacticCenter).y
                    if h > highest { highest = h; chosen = a }
                }
                a += step
            }
            return chosen
        }

        /// The galactic centre near its highest, `before` hours short of culmination.
        mutating func bestAngleForCore(before: Double = 1.5) -> Double {
            let step = 0.25 * RealSky.deg
            var best = 0.0, highest = -Double.infinity
            var a = 0.0
            while a < RealSky.tau {
                setAngle(a)
                let h = toWorld(RealSky.galacticCenter).y
                if h > highest { highest = h; best = a }
                a += step
            }
            return best + RealSky.tau * before * 3600 / siderealDay
        }

        /// The hour whose galactic equator tops out closest to `target` degrees within `spread` of `viewAzimuth`.
        mutating func bestAngleForView(_ viewAzimuth: Double, target: Double = 90, spread: Double = 55 * RealSky.deg) -> Double {
            let g = RealSky.galacticPole
            let c = RealSky.galacticCenter
            let a1 = simd_normalize(c - g * simd_dot(c, g))
            let a2 = simd_cross(g, a1)
            var ring: [D3] = []
            var l = 0.0
            while l < RealSky.tau { ring.append(a1 * cos(l) + a2 * sin(l)); l += 3 * RealSky.deg }
            func wrap(_ a: Double) -> Double {
                let t = RealSky.tau
                return abs(((((a + Double.pi).truncatingRemainder(dividingBy: t)) + t).truncatingRemainder(dividingBy: t)) - Double.pi)
            }
            let want = sin(target * RealSky.deg)
            var best = 0.0, closest = Double.infinity
            var a = 0.0
            while a < RealSky.tau {
                setAngle(a)
                var top = -1.0
                for p in ring {
                    let w = toWorld(p)
                    if wrap(atan2(w.z, w.x) - viewAzimuth) <= spread { top = max(top, w.y) }
                }
                let miss = abs(top - want)
                if top > -1 && miss < closest { closest = miss; best = a }
                a += 0.5 * RealSky.deg
            }
            return best
        }
    }

    /// The azimuths of north at which the band's plane can fall where `normal` has it, nearest `prefer` first.
    static func fitNorth(latitude: Double, normal: D3, prefer: Double = -Double.pi / 2) -> [Double] {
        let n = simd_normalize(normal)
        let lat = latitude * deg
        let r = hypot(n.x, n.z)
        if r < 1e-6 { return [] }
        let rhs = (cos(bandToPole) - sin(lat) * n.y) / (cos(lat) * r)
        var out: [Double] = []
        for v in [rhs, -rhs] where abs(v) <= 1 {
            let phi = atan2(n.z, n.x), d = acos(v)
            out += [phi + d, phi - d]
        }
        func wrap(_ a: Double) -> Double { ((a.truncatingRemainder(dividingBy: tau)) + tau).truncatingRemainder(dividingBy: tau) }
        func away(_ a: Double) -> Double { abs(((wrap(a - prefer) + Double.pi).truncatingRemainder(dividingBy: tau)) - Double.pi) }
        return out.map(wrap).sorted { away($0) < away($1) }
    }

    /// Stands the sky up at `latitude` and picks the hour to start at (realsky.js, `placeSky`).
    static func placeSky(latitude: Double, matchBand: D3?, north: Double?, preferNorth: Double = -Double.pi / 2,
                         viewAzimuth: Double?, viewAltitude: Double = 90) -> CelestialFrame {
        let candidates: [Double]
        if let north { candidates = [north] }
        else if let matchBand { candidates = fitNorth(latitude: latitude, normal: matchBand, prefer: preferNorth) + [preferNorth] }
        else { candidates = [preferNorth] }
        var best: (frame: CelestialFrame, score: Double)?
        for az in candidates {
            var frame = CelestialFrame(latitude: latitude, north: az)
            guard let band = matchBand else {
                let a = viewAzimuth.map { frame.bestAngleForView($0, target: viewAltitude) } ?? frame.bestAngleForCore()
                frame.setAngle(a)
                return frame
            }
            frame.setAngle(frame.bestAngle(for: band))
            let height = frame.toWorld(galacticCenter).y
            let tilt = acos(min(1, abs(simd_dot(frame.toWorld(galacticPole), simd_normalize(band)))))
            // A turn that misses the painted plane is worse than one that shows less of the bulge.
            let score = height - 6 * tilt
            if best == nil || score > best!.score { best = (frame, score) }
            if north != nil { break }
        }
        return best!.frame
    }

    // MARK: - The sky

    private(set) var frame: CelestialFrame
    let radius: Float
    /// The night / weather amount: 0 hides the real sky (daylight, a storm ceiling, overcast).
    var fade: Float = 1
    /// The y of the direction over which the sky fades in above the horizon: (end, start) of a smoothstep.
    var horizon: SIMD2<Float>
    /// Low Power draws the brightest part of the catalogue (it is stored brightest first).
    var starFraction: Float = 1
    /// Point sprites are sized in device pixels: the screen's backing scale.
    var pointScale: Float = 2
    var gain = RealSky.milkyWayGain
    var starGain = RealSky.starGain
    /// Whether anything real is up; if not, the app keeps its painted sky.
    var ready: Bool { RealSky.assets.map != nil || RealSky.assets.stars != nil }

    /// opts as realsky.js: `matchBand` (the painted band's normal, world space) with `north` nil solves north
    /// for it; `north` fixes it; with neither band nor view the hour shows the galactic centre near its highest;
    /// with `viewAzimuth` the hour stands the band at `viewAltitude` degrees across that view.
    init(latitude: Double, north: Double? = nil, matchBand: SIMD3<Float>? = nil, viewAzimuth: Double? = nil,
         viewAltitude: Double = 90, radius: Float, horizon: SIMD2<Float> = SIMD2(0, 0.09)) {
        self.radius = radius
        self.horizon = horizon
        frame = RealSky.placeSky(latitude: latitude, matchBand: matchBand.map { D3(Double($0.x), Double($0.y), Double($0.z)) },
                                 north: north, viewAzimuth: viewAzimuth, viewAltitude: viewAltitude)
    }

    /// Turns the sky. `speed` multiplies the sidereal rate, for testing.
    func update(dt: Float, speed: Double = 1) { frame.advance(Double(dt) * speed) }

    /// A named ICRS direction in world space now, for tests and logs.
    func direction(_ icrs: D3) -> SIMD3<Float> {
        let w = frame.toWorld(icrs)
        return SIMD3<Float>(Float(w.x), Float(w.y), Float(w.z))
    }

    private struct Params {
        var model: simd_float4x4
        var gain: Float, fade: Float, horizonEnd: Float, horizonStart: Float
        var scale: Float, radius: Float, _pad1: Float = 0, _pad2: Float = 0
    }

    /// Draws the band and the stars, additively, behind whatever this pass has already drawn in front of the
    /// sky (they test depth but don't write it). Draw right after the painted dome.
    func draw(_ encoder: MTLRenderCommandEncoder, frame frameBuffer: MTLBuffer, frameOffset: Int = 0, samples: Int) {
        guard fade > 0.001 else { return }
        let assets = RealSky.assets
        guard assets.map != nil || assets.stars != nil else { return }
        let toWorld = frame.matrix
        let e = encoder
        e.setCullMode(.none)
        e.setDepthStencilState(RealSky.depthState)
        if let map = assets.map {
            // The sphere's own pole is local +y and its seam at RA 180: local (x, y, z) -> ICRS (x, z, y).
            let P = simd_float4x4(columns: (SIMD4(1, 0, 0, 0), SIMD4(0, 0, 1, 0), SIMD4(0, 1, 0, 0), SIMD4(0, 0, 0, 1)))
            var p = Params(model: toWorld * P, gain: gain, fade: fade, horizonEnd: horizon.x, horizonStart: horizon.y,
                           scale: pointScale, radius: radius * 0.995)
            e.setRenderPipelineState(RealSky.pipeline("realSkyMapVertex", "realSkyMapFragment", samples: samples))
            e.setVertexBuffer(RealSky.sphere.vertices, offset: 0, index: 0)
            e.setVertexBuffer(frameBuffer, offset: frameOffset, index: 1)
            e.setVertexBytes(&p, length: MemoryLayout<Params>.stride, index: 2)
            e.setFragmentBytes(&p, length: MemoryLayout<Params>.stride, index: 2)
            e.setFragmentTexture(map, index: 0)
            e.setFragmentSamplerState(RealSky.mapSampler, index: 0)
            e.drawIndexedPrimitives(type: .triangle, indexCount: RealSky.sphere.count, indexType: .uint32,
                                    indexBuffer: RealSky.sphere.indices, indexBufferOffset: 0)
        }
        if let stars = assets.stars {
            var p = Params(model: toWorld, gain: starGain, fade: fade, horizonEnd: horizon.x, horizonStart: horizon.y,
                           scale: pointScale, radius: radius * 0.99)
            let n = max(1, Int((Float(stars.count) * min(max(starFraction, 0), 1)).rounded()))
            e.setRenderPipelineState(RealSky.pipeline("realSkyStarVertex", "realSkyStarFragment", samples: samples))
            e.setVertexBuffer(stars.buffer, offset: 0, index: 0)
            e.setVertexBuffer(frameBuffer, offset: frameOffset, index: 1)
            e.setVertexBytes(&p, length: MemoryLayout<Params>.stride, index: 2)
            e.drawPrimitives(type: .point, vertexStart: 0, vertexCount: n)
        }
    }

    // MARK: - Assets, loaded once per launch and shared by every new scene

    private struct Stars { let buffer: MTLBuffer; let count: Int }
    private static let assets: (map: MTLTexture?, stars: Stars?) = (loadMap(), loadStars())

    /// A resource from the app bundle, or (under `swift run`) from the repository.
    private static func url(_ name: String, _ ext: String, repoPath: String) -> URL? {
        if let u = Bundle.main.url(forResource: name, withExtension: ext) { return u }
        // Sources/<App>/RealSky.swift -> the repository root is four levels up.
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../").standardized
        let u = root.appendingPathComponent(repoPath)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    /// milkyway.astc: "MWASTC01", uint32 width, height, levels, then per level uint32 size and ASTC 4x4 blocks.
    private static func loadMap() -> MTLTexture? {
        let device = GPU.shared.device
        guard device.supportsFamily(.apple2) else {
            NSLog("Real sky: this GPU can't sample ASTC; keeping the painted Milky Way")
            return nil
        }
        guard let u = url("milkyway", "astc", repoPath: "assets/sky/build/milkyway.astc"),
              let data = try? Data(contentsOf: u, options: .alwaysMapped), data.count > 20,
              String(data: data.prefix(8), encoding: .ascii) == "MWASTC01" else {
            NSLog("Real sky: milkyway.astc is missing; keeping the painted Milky Way")
            return nil
        }
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> MTLTexture? in
            func u32(_ o: Int) -> Int { Int(raw.loadUnaligned(fromByteOffset: o, as: UInt32.self).littleEndian) }
            let w = u32(8), h = u32(12), levels = u32(16)
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .astc_4x4_srgb, width: w, height: h, mipmapped: true)
            d.mipmapLevelCount = min(levels, d.mipmapLevelCount)
            d.usage = .shaderRead
            d.storageMode = .shared
            guard let t = device.makeTexture(descriptor: d) else { return nil }
            var o = 20
            for level in 0..<d.mipmapLevelCount {
                guard o + 4 <= raw.count else { return nil }
                let size = u32(o); o += 4
                guard o + size <= raw.count else { return nil }
                let lw = max(1, w >> level), lh = max(1, h >> level)
                t.replace(region: MTLRegionMake2D(0, 0, lw, lh), mipmapLevel: level,
                          withBytes: raw.baseAddress! + o, bytesPerRow: ((lw + 3) / 4) * 16)
                o += size
            }
            return t
        }
    }

    /// stars.bin: ten bytes a star (int16 x, y, z of the unit vector x 32767, uint8 (V + 2) x 16, uint8 r, g, b),
    /// brightest first. On the GPU: float4 (direction x radius, V) and float4 (colour, 0).
    private static func loadStars() -> Stars? {
        guard let u = url("stars", "bin", repoPath: "hangar/html/data/stars.bin"),
              let data = try? Data(contentsOf: u), data.count >= 10 else {
            NSLog("Real sky: stars.bin is missing; keeping the hashed stars")
            return nil
        }
        let count = data.count / 10
        var out = [SIMD4<Float>](repeating: .zero, count: count * 2)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for i in 0..<count {
                let o = i * 10
                let x = Float(raw.loadUnaligned(fromByteOffset: o, as: Int16.self).littleEndian)
                let y = Float(raw.loadUnaligned(fromByteOffset: o + 2, as: Int16.self).littleEndian)
                let z = Float(raw.loadUnaligned(fromByteOffset: o + 4, as: Int16.self).littleEndian)
                let l = max(sqrt(x * x + y * y + z * z), 1)
                let mag = Float(raw[o + 6]) / 16 - 2
                out[i * 2] = SIMD4(x / l, y / l, z / l, mag)
                out[i * 2 + 1] = SIMD4(Float(raw[o + 7]) / 255, Float(raw[o + 8]) / 255, Float(raw[o + 9]) / 255, 0)
            }
        }
        guard let buffer = GPU.shared.device.makeBuffer(bytes: out, length: out.count * MemoryLayout<SIMD4<Float>>.stride) else { return nil }
        return Stars(buffer: buffer, count: count)
    }

    /// three's SphereGeometry(1, 128, 64): uv from the geometry (v = 1 at +y), so the map's seam doesn't show.
    private static let sphere: (vertices: MTLBuffer, indices: MTLBuffer, count: Int) = {
        let ws = 128, hs = 64
        var v: [SIMD4<Float>] = []   // position xyz, then (u, v, 0, 0)
        for iy in 0...hs {
            let fv = Float(iy) / Float(hs)
            for ix in 0...ws {
                let fu = Float(ix) / Float(ws)
                let phi: Float = fu * 2 * Float.pi, theta: Float = fv * Float.pi
                let st: Float = sin(theta)
                v.append(SIMD4<Float>(-cos(phi) * st, cos(theta), sin(phi) * st, 1))
                v.append(SIMD4<Float>(fu, 1 - fv, 0, 0))
            }
        }
        var idx: [UInt32] = []
        let row = ws + 1
        for iy in 0..<hs {
            for ix in 0..<ws {
                let top: Int = iy * row + ix, below: Int = (iy + 1) * row + ix
                let a = UInt32(top + 1), b = UInt32(top), c = UInt32(below), d = UInt32(below + 1)
                if iy != 0 { idx += [a, b, d] }
                if iy != hs - 1 { idx += [b, c, d] }
            }
        }
        let dev = GPU.shared.device
        return (dev.makeBuffer(bytes: v, length: v.count * 16)!, dev.makeBuffer(bytes: idx, length: idx.count * 4)!, idx.count)
    }()

    // MARK: - Pipelines

    private static let library: MTLLibrary = {
        do { return try GPU.shared.device.makeLibrary(source: shaderSource, options: nil) }
        catch { fatalError("Real sky shaders: \(error)") }
    }()

    private static var pipelines: [String: MTLRenderPipelineState] = [:]

    private static func pipeline(_ vertex: String, _ fragment: String, samples: Int) -> MTLRenderPipelineState {
        let key = "\(vertex)/\(samples)"
        if let p = pipelines[key] { return p }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = library.makeFunction(name: vertex)
        d.fragmentFunction = library.makeFunction(name: fragment)
        d.rasterSampleCount = samples
        d.depthAttachmentPixelFormat = GPU.depthFormat
        let c = d.colorAttachments[0]!
        c.pixelFormat = GPU.sceneFormat
        c.isBlendingEnabled = true
        c.rgbBlendOperation = .add
        c.sourceRGBBlendFactor = .one
        c.destinationRGBBlendFactor = .one
        c.alphaBlendOperation = .add
        c.sourceAlphaBlendFactor = .zero
        c.destinationAlphaBlendFactor = .one
        let p = try! GPU.shared.device.makeRenderPipelineState(descriptor: d)
        pipelines[key] = p
        return p
    }

    private static let depthState: MTLDepthStencilState = {
        let d = MTLDepthStencilDescriptor()
        d.depthCompareFunction = .lessEqual
        d.isDepthWriteEnabled = false
        return GPU.shared.device.makeDepthStencilState(descriptor: d)!
    }()

    private static let mapSampler: MTLSamplerState = {
        let d = MTLSamplerDescriptor()
        d.minFilter = .linear; d.magFilter = .linear; d.mipFilter = .linear
        d.sAddressMode = .repeat; d.tAddressMode = .clampToEdge
        d.maxAnisotropy = 8
        return GPU.shared.device.makeSamplerState(descriptor: d)!
    }()

    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct FrameHead { float4x4 viewProj; };   // the first member of every app's Frame
    struct Params { float4x4 model; float gain, fade, horizonEnd, horizonStart; float scale, radius, p1, p2; };

    float skyFade(constant Params& P, float3 d) {
        return P.fade * smoothstep(P.horizonEnd, P.horizonStart, normalize(d).y);
    }

    struct MapOut { float4 position [[position]]; float2 uv; float3 dir; };

    vertex MapOut realSkyMapVertex(uint vid [[vertex_id]], device const float4* v [[buffer(0)]],
                                   constant FrameHead& F [[buffer(1)]], constant Params& P [[buffer(2)]]) {
        float3 w = (P.model * float4(v[vid * 2].xyz, 1.0)).xyz;
        MapOut o;
        o.uv = v[vid * 2 + 1].xy;
        o.dir = w;
        // A unit sphere scaled to just inside the painted dome, centred on the world origin like the dome.
        o.position = F.viewProj * float4(w * P.radius, 1.0);
        return o;
    }

    fragment float4 realSkyMapFragment(MapOut in [[stage_in]], constant Params& P [[buffer(2)]],
                                       texture2d<float> map [[texture(0)]], sampler s [[sampler(0)]]) {
        return float4(map.sample(s, in.uv).rgb * P.gain * skyFade(P, in.dir), 0.0);
    }

    struct StarOut { float4 position [[position]]; float size [[point_size]]; float3 color; };

    // Brightness steps 1.52x a magnitude (flux to the 0.45), and the brightest grow and go past white, so
    // the naked-eye stars stand out and carry into the bloom (realsky.js).
    vertex StarOut realSkyStarVertex(uint vid [[vertex_id]], device const float4* s [[buffer(0)]],
                                     constant FrameHead& F [[buffer(1)]], constant Params& P [[buffer(2)]]) {
        float4 a = s[vid * 2];
        float3 w = (P.model * float4(a.xyz, 1.0)).xyz;
        float mag = a.w;
        float b = P.gain * exp2(-0.6 * mag) * skyFade(P, w);
        float big = clamp((2.0 - mag) / 3.5, 0.0, 1.0);
        StarOut o;
        o.color = s[vid * 2 + 1].rgb * min(b, 2.8);
        o.size = P.scale * (1.7 + 3.6 * big);
        o.position = b < 0.002 ? float4(2.0, 2.0, 2.0, 1.0) : F.viewProj * float4(w * P.radius, 1.0);
        return o;
    }

    fragment float4 realSkyStarFragment(StarOut in [[stage_in]], float2 pc [[point_coord]]) {
        float2 q = pc * 2.0 - 1.0;
        return float4(in.color * exp(-3.0 * dot(q, q)), 0.0);
    }
    """
}
