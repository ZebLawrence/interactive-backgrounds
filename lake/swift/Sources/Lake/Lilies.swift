import CoreGraphics
import Metal
import simd

/// Water lilies in the sheltered shallows at the sides: floating pads with their notch and
/// radiating veins, a few white flowers open among them, and stems running down to the bed. The
/// pads are perches for the dragonflies.
final class Lilies {
    private(set) var perches: [Perch] = []
    private let padMesh: GPUMesh
    private let pads: MTLBuffer
    private let padCount: Int
    private let padTexture: MTLTexture
    private let flowerMesh: GPUMesh
    private let flowers: MTLBuffer
    private let flowerCount: Int
    private let flowerTexture: MTLTexture
    private let stems: GPUMesh?

    init(halfWidth: (Float) -> Float) {
        var padList: [(x: Float, z: Float, size: Float, yaw: Float)] = []
        var flowerList: [StdInstance] = []
        var stemList: [(x: Float, z: Float)] = []
        // Patches in the lee of the reeds at each side, where the water is still and under a metre
        // and a half deep.
        for side: Float in [-1, 1] {
            for _ in 0..<2 {
                let z = -rnd(4.5, 14)
                let hw = halfWidth(-z)
                let cx = side * hw * rnd(0.6, 0.98), cz = z, r = rnd(1.0, 2.2)
                let n = Int((r * r * rnd(5, 8)).rounded())
                for _ in 0..<n {
                    let a = rnd(0, TAU), d = Float.random(in: 0..<1).squareRoot() * r
                    let x = cx + cos(a) * d, pz = cz + sin(a) * d * 0.75
                    if bedDepth(min(pz, -0.01)) > 1.6 { continue }
                    let size = rnd(0.09, 0.17)
                    if padList.contains(where: { hypot($0.x - x, $0.z - pz) < ($0.size + size) * 0.8 }) { continue }
                    padList.append((x, pz, size, rnd(0, TAU)))
                    stemList.append((x, pz))
                    if chance(0.45) { perches.append(Perch(base: V3(x, 0.004, pz), h: 0, phase: 0, stiff: 0, top: 0.012)) }
                }
                var f = Int(floor(rnd(1, 3.5)))
                while f > 0 {
                    let a = rnd(0, TAU), d = Float.random(in: 0..<1).squareRoot() * r * 0.8
                    let x = cx + cos(a) * d, pz = cz + sin(a) * d * 0.75
                    flowerList.append(StdInstance(model: compose(V3(x, 0.01, pz), quatAxis(rnd(0, TAU), 0, 1, 0), V3(repeating: rnd(0.8, 1.2)))))
                    stemList.append((x, pz))
                    f -= 1
                }
            }
        }
        let gpu = GPU.shared
        padMesh = Lilies.padGeometry().upload()
        let padInstances = padList.map { StdInstance(model: compose(V3($0.x, 0.004, $0.z), quatAxis($0.yaw, 0, 1, 0), V3(repeating: $0.size))) }
        pads = gpu.buffer(padInstances.isEmpty ? [StdInstance(model: matrix_identity_float4x4)] : padInstances)
        padCount = padInstances.count
        padTexture = gpu.texture(Lilies.padImage(), srgb: true)
        flowerMesh = Lilies.flowerGeometry().upload()
        flowers = gpu.buffer(flowerList.isEmpty ? [StdInstance(model: matrix_identity_float4x4)] : flowerList)
        flowerCount = flowerList.count
        flowerTexture = gpu.texture(Lilies.flowerImage(), srgb: true)
        // Stems: thin stalks from each pad and flower straight down to the bed, seen through the water.
        let parts = stemList.map { s -> MeshData in
            let depth = bedDepth(min(s.z, -0.01))
            return Geometry.cylinder(top: 0.004, bottom: 0.006, height: depth, radialSegments: 6)
                .translated(V3(s.x + rnd(-0.01, 0.01), -depth / 2, s.z + rnd(-0.01, 0.01)))
        }
        stems = parts.isEmpty ? nil : MeshData.merged(parts).upload()
    }

    func draw(_ ctx: DrawContext) {
        if ctx.pass == .refraction {
            guard let stems else { return }
            Std.begin(ctx)
            Std.draw(ctx, stems, StdParams(model: matrix_identity_float4x4, color: RGBA(hex: "#4a5a2a").linear, roughness: 0.8, metalness: 0))
            return
        }
        // Waxy but matte enough not to flare in the low sun.
        Std.begin(ctx, vertex: "stdInstancedVertex")
        if padCount > 0 {
            Std.draw(ctx, padMesh, StdParams(model: matrix_identity_float4x4, color: V3(1, 1, 1), roughness: 0.88, metalness: 0,
                                             flags: [.map, .doubleSided, .clampMap]),
                     map: padTexture, instances: pads, count: padCount)
        }
        if flowerCount > 0 {
            Std.draw(ctx, flowerMesh, StdParams(model: matrix_identity_float4x4, color: V3(1, 1, 1), roughness: 0.7, metalness: 0,
                                                flags: [.map, .doubleSided, .clampMap], emissive: RGBA(hex: "#2a2220").linear * 0.25),
                     map: flowerTexture, instances: flowers, count: flowerCount)
        }
    }

    // MARK: - Shapes and images

    /// The pad: a disc with the characteristic V notch cut toward the centre, its rim curling up.
    static func padGeometry() -> MeshData {
        let notch: Float = 0.42, segs = 48
        var outline = [V2(0.05, 0)]
        for i in 0...segs {
            let a = notch / 2 + (TAU - notch) * Float(i) / Float(segs)
            let r = 1 + 0.03 * sin(a * 7)
            outline.append(V2(cos(a) * r, sin(a) * r))
        }
        var m = Geometry.fan(outline)
        m.uvs = m.positions.map { V2($0.x * 0.5 + 0.5, $0.y * 0.5 + 0.5) }
        m = m.transformed(simd_float4x4(rotationX: -.pi / 2))
        for i in m.positions.indices {
            let p = m.positions[i]
            m.positions[i].y = pow(hypot(p.x, p.z), 6) * 0.06
        }
        m.computeVertexNormals()
        return m
    }

    /// A flower: three whorls of cupped petals around a yellow heart, opening upward.
    static func flowerGeometry() -> MeshData {
        func petal(_ len: Float, _ wid: Float, _ tilt: Float, _ az: Float, _ lift: Float) -> MeshData {
            var g = Geometry.plane(wid, len, 1, 3)
            for i in g.positions.indices {
                let t = g.positions[i].y / len + 0.5
                // Cupped: narrow at the base, rounded at the tip.
                g.positions[i].x *= sin(t * .pi * 0.9 + 0.1)
                g.positions[i].z = -t * t * len * 0.35
            }
            return g.transformed(simd_float4x4(translation: V3(0, lift, 0)) * simd_float4x4(rotationY: az) * simd_float4x4(rotationX: -tilt)
                                 * simd_float4x4(translation: V3(0, len / 2, 0)))
        }
        var parts: [MeshData] = []
        for k in 0..<8 { parts.append(petal(0.055, 0.02, 1.15, Float(k) / 8 * TAU, 0.005)) }
        for k in 0..<8 { parts.append(petal(0.045, 0.018, 0.8, (Float(k) + 0.5) / 8 * TAU, 0.008)) }
        for k in 0..<6 { parts.append(petal(0.03, 0.014, 0.45, Float(k) / 6 * TAU + 0.2, 0.012)) }
        var heart = Geometry.sphere(radius: 0.009, widthSegments: 10, heightSegments: 8)
            .transformed(simd_float4x4(translation: V3(0, 0.016, 0)) * simd_float4x4(scale: V3(1, 0.7, 1)))
        // Petals carry v along their length; the heart's uvs are pushed into the yellow corner.
        heart.uvs = heart.uvs.map { _ in V2(0.5, 1.0) }
        parts.append(heart)
        return MeshData.merged(parts)
    }

    /// A lily pad from above: green with radiating veins and a paler, slightly reddened rim.
    static func padImage() -> Canvas {
        let w = 512.0, h = 512.0
        let c = Canvas(Int(w), Int(h))
        let cx = w / 2, cy = h / 2, R = w * 0.48
        c.radialGradient(CGPoint(x: cx, y: cy), R * 0.1, CGPoint(x: cx, y: cy), R,
                         [(0, RGBA(hex: "#3f7a2e")), (0.7, RGBA(hex: "#3a6f2a")), (0.93, RGBA(hex: "#4a7a30")), (1, RGBA(hex: "#6a5a2c"))])
        // Mottling.
        let d = c.data, W = Int(w)
        DispatchQueue.concurrentPerform(iterations: Int(h)) { y in
            for x in 0..<W {
                let n = fbm2(Double(x) / 40, Double(y) / 40, 3) - 0.5
                let i = (y * W + x) * 4
                d[i] = UInt8(clamp(Double(d[i]) + n * 30, 0, 255))
                d[i + 1] = UInt8(clamp(Double(d[i + 1]) + n * 36, 0, 255))
                d[i + 2] = UInt8(clamp(Double(d[i + 2]) + n * 20, 0, 255))
            }
        }
        // Veins radiating from the stem point, forking toward the rim.
        let ctx = c.ctx
        c.stroke(.bytes(200, 215, 150, 0.55))
        ctx.setLineCap(.round)
        for k in 0..<18 {
            let a = Double(k) / 18 * .pi * 2 + rndD(-0.08, 0.08)
            ctx.setLineWidth(3)
            ctx.beginPath()
            ctx.move(to: CGPoint(x: cx, y: cy))
            ctx.addQuadCurve(to: CGPoint(x: cx + cos(a) * R, y: cy + sin(a) * R), control: CGPoint(x: cx + cos(a + 0.1) * R * 0.5, y: cy + sin(a + 0.1) * R * 0.5))
            ctx.strokePath()
            for s in [-1.0, 1.0] {
                let b = a + s * 0.1
                c.line(cx + cos(a) * R * 0.45, cy + sin(a) * R * 0.45, cx + cos(b) * R, cy + sin(b) * R, width: 1.6)
            }
        }
        return c
    }

    /// v along the petal: pink at the base, white toward the tip; the very top row is the yellow heart.
    static func flowerImage() -> Canvas {
        let c = Canvas(64, 256)
        c.linearGradient(from: CGPoint(x: 0, y: 256), to: CGPoint(x: 0, y: 0),
                         [(0, RGBA(hex: "#e8b4c8")), (0.35, RGBA(hex: "#f7eef2")), (0.9, RGBA(hex: "#ffffff")),
                          (0.96, RGBA(hex: "#f2c23a")), (1, RGBA(hex: "#f2c23a"))])
        return c
    }
}
