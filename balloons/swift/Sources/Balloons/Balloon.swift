import CoreGraphics
import Foundation
import Metal
import simd

let gores = 24
private let envelopeHeight: Float = 18

// MARK: - Palettes and patterns

/// Every envelope is painted on a 2048x1024 image, u around the balloon and v up it, then dressed
/// with gore seams, load tapes, a dark scoop and a fabric weave.
let palettes: [[String]] = [
    ["#d8232a", "#f2c230", "#1f4e9c", "#f5f1e6"],
    ["#0b7a75", "#f7b538", "#e4572e", "#17223b"],
    ["#6a0dad", "#ff7f11", "#f8f4e3"],
    ["#1b998b", "#ed217c", "#2d3047", "#fffd98"],
    ["#c1121f", "#003049", "#fdf0d5", "#669bbc"],
    ["#2a9d8f", "#e9c46a", "#f4a261", "#e76f51", "#264653"],
    ["#ff006e", "#8338ec", "#3a86ff", "#ffbe0b", "#fb5607"],
    ["#4a7c59", "#f2e8cf", "#bc4749"],
    ["#1d3557", "#f1faee", "#e63946"],
    ["#ffd166", "#06d6a0", "#118ab2", "#073b4c", "#ef476f"],
]

enum Pattern: CaseIterable { case gores, checker, chevron, diamonds, rainbow, sunburst, spiral, bands }

/// Paint an envelope. `h` runs 0 at the throat to 1 at the crown (row 0 of the image is the crown).
func paintEnvelope(_ pattern: Pattern, _ palette: [String], weave: CGImage) -> Canvas {
    let W = 2048.0, H = 1024.0
    let c = Canvas(Int(W), Int(H))
    let ctx = c.ctx
    let pal = palette.map { RGBA(hex: $0) }
    func Y(_ h: Double) -> Double { H * (1 - h) }
    func rect(_ u0: Double, _ u1: Double, _ h0: Double, _ h1: Double, _ color: RGBA) {
        c.fill(color)
        c.fillRect(u0 * W, Y(h1), (u1 - u0) * W + 1, (h1 - h0) * H + 1)
    }
    func polygon(_ pts: [CGPoint], _ color: RGBA) {
        c.fill(color)
        ctx.beginPath()
        ctx.addLines(between: pts)
        ctx.closePath()
        ctx.fillPath()
    }
    let gw = 1 / Double(gores)
    c.fill(pal[0])
    c.fillRect(0, 0, W, H)
    switch pattern {
    case .gores:
        for g in 0..<gores { rect(Double(g) * gw, Double(g + 1) * gw, 0, 1, cyc(pal, g)) }
    case .checker:
        let rows = 7
        for g in 0..<gores {
            for r in 0..<rows { rect(Double(g) * gw, Double(g + 1) * gw, Double(r) / Double(rows), Double(r + 1) / Double(rows), cyc(pal, g + r)) }
        }
    case .chevron:
        let bands = 9.0
        for b in -1...Int(bands) {
            var pts: [CGPoint] = []
            for g in 0...gores { pts.append(CGPoint(x: Double(g) * gw * W, y: Y((Double(b) + Double(g % 2) * 0.5) / bands))) }
            for g in stride(from: gores, through: 0, by: -1) { pts.append(CGPoint(x: Double(g) * gw * W, y: Y((Double(b) + 1 + Double(g % 2) * 0.5) / bands))) }
            polygon(pts, cyc(pal, b))
        }
    case .diamonds:
        let rows = 6.0
        for g in 0..<gores {
            for r in -1...Int(rows) {
                let color = cyc(pal, 1 + ((g + r) % 2 + 2) % 2 + (r % 3 == 0 ? 1 : 0))
                let cx = (Double(g) + 0.5) * gw * W, cy = Y((Double(r) + 0.5 + Double(g % 2) * 0.5) / rows)
                polygon([CGPoint(x: cx, y: cy - H / rows / 2), CGPoint(x: cx + gw * W / 2, y: cy),
                         CGPoint(x: cx, y: cy + H / rows / 2), CGPoint(x: cx - gw * W / 2, y: cy)], color)
            }
        }
    case .rainbow:
        let bands = pal.count * 2
        for b in 0..<bands { rect(0, 1, Double(b) / Double(bands), Double(b + 1) / Double(bands), cyc(pal, b)) }
    case .sunburst:
        rect(0, 1, 0.55, 1, pal[1])
        for g in 0..<gores {
            polygon([CGPoint(x: (Double(g) + 0.5) * gw * W, y: Y(0)), CGPoint(x: Double(g) * gw * W, y: Y(0.62)),
                     CGPoint(x: Double(g + 1) * gw * W, y: Y(0.62))], cyc(pal, g % 2 == 1 ? 2 : 0))
        }
        rect(0, 1, 0.9, 1, pal[2 % pal.count])
    case .spiral:
        let rows = 10
        for g in 0..<gores {
            for r in 0..<rows {
                rect(Double(g) * gw, Double(g + 1) * gw, Double(r) / Double(rows), Double(r + 1) / Double(rows),
                     cyc(pal, Int(floor((Double(g) + Double(r) * 1.5) / 2))))
            }
        }
    case .bands:
        rect(0, 1, 0.3, 0.42, pal[1])
        rect(0, 1, 0.48, 0.52, pal[2 % pal.count])
        rect(0, 1, 0.74, 0.8, pal[1])
        // A badge on two opposite sides.
        for u in [0.25, 0.75] {
            c.fill(pal[2 % pal.count])
            c.fillEllipse(u * W, Y(0.6), W * 0.06, H * 0.1)
            c.fill(pal[0])
            c.fillEllipse(u * W, Y(0.6), W * 0.04, H * 0.065)
        }
    }
    // The parachute vent at the crown and the dark scoop at the throat.
    rect(0, 1, 0.965, 1, RGBA(hex: "#2b2b2b"))
    rect(0, 1, 0, 0.06, RGBA(hex: "#1c1a19"))
    // Load tapes: dark seams down every gore and three horizontal tapes.
    c.fill(RGBA(0, 0, 0, 0.38))
    for g in 0...gores { c.fillRect(Double(g) * gw * W - 1.5, 0, 3, H) }
    for h in [0.06, 0.5, 0.965] { c.fillRect(0, Y(h) - 2, W, 4) }
    // A hint of light stitching beside each seam.
    c.fill(RGBA(1, 1, 1, 0.12))
    for g in 0...gores {
        c.fillRect(Double(g) * gw * W + 2, 0, 1, H)
        c.fillRect(Double(g) * gw * W - 3, 0, 1, H)
    }
    // Fabric weave, tiled over everything.
    ctx.saveGState()
    ctx.setBlendMode(.multiply)
    ctx.draw(weave, in: CGRect(x: 0, y: 0, width: weave.width, height: weave.height), byTiling: true)
    ctx.restoreGState()
    return c
}

/// A tangent-space normal map for the quilted gores: each gore bulges, with a groove at the seam.
func envelopeNormalImage() -> Canvas {
    let W = 1024, H = 256
    let c = Canvas(W, H)
    c.setPixels { x, y in
        let u = Double(x) / Double(W)
        var nx = sin(u * 2 * .pi * Double(gores)) * 0.55
        // The seam: a sharp groove.
        let seam = (u * Double(gores)).truncatingRemainder(dividingBy: 1)
        let sd = min(seam, 1 - seam)
        if sd < 0.03 { nx += (seam < 0.5 ? -1 : 1) * (0.03 - sd) / 0.03 * 0.6 }
        let weave = (hash2(Double(x), Double(y)) - 0.5) * 0.08
        let nz = max(0, 1 - nx * nx).squareRoot()
        return ((nx * 0.5 + 0.5) * 255, (weave * 0.5 + 0.5) * 255, nz * 255)
    }
    return c
}

// MARK: - Shared geometry

/// The parts every balloon shares, in balloon space (the throat ring at the origin, the envelope
/// above it, the basket below), built and uploaded once.
final class Parts {
    static let shared = Parts()

    let envelope: GPUMesh
    /// The crown ring, throat ring, burner frame and burners: all dark metal.
    let metal: GPUMesh
    let cables: GPUMesh
    let basket: GPUMesh
    let basketRim: GPUMesh
    let body: GPUMesh
    let head: GPUMesh
    let arm: GPUMesh

    let weave: CGImage
    let normalMap: MTLTexture
    let wicker: MTLTexture
    let wickerBump: MTLTexture

    private init() {
        // The envelope profile, from the throat up to the crown, resampled evenly so v is height.
        let ctrl: [V2] = [V2(1.7, 0), V2(4.4, 2.2), V2(6.9, 4.8), V2(8.0, 7.8), V2(7.7, 11.2), V2(6.1, 14.5),
                          V2(3.4, 16.9), V2(0.9, 17.9), V2(0, envelopeHeight)]
        let pts = CatmullRom(points: ctrl, tension: 0.5).spacedPoints(56).map { V2(max($0.x, 0), $0.y) }
        envelope = Geometry.lathe(pts, segments: 120).upload()

        // Eight cables from the throat ring down to the corners of the burner frame.
        var cables: [MeshData] = []
        for i in 0..<8 {
            let a = (Float(i) + 0.5) / 8 * TAU
            let top = V3(cos(a) * 1.7, 0, sin(a) * 1.7)
            let ca = Float((Double(i) / 2).rounded()) / 4 * TAU + TAU / 8
            cables.append(Geometry.rod(top, V3(cos(ca) * 0.75, -3.3, sin(ca) * 0.75), 0.018))
        }
        self.cables = MeshData.merged(cables).upload()

        // The burner frame: four uprights from the basket to a square load frame, and the frame itself.
        var metal: [MeshData] = []
        for i in 0..<4 {
            let a = Float(i) / 4 * TAU + TAU / 8
            let x = cos(a) * 0.75, z = sin(a) * 0.75
            metal.append(Geometry.rod(V3(x, -3.3, z), V3(x * 0.85, -4.7, z * 0.85), 0.04))
            let b = Float(i + 1) / 4 * TAU + TAU / 8
            metal.append(Geometry.rod(V3(x, -3.3, z), V3(cos(b) * 0.75, -3.3, sin(b) * 0.75), 0.04))
        }
        metal.append(Geometry.torus(radius: 0.9, tube: 0.08, radialSegments: 8, tubularSegments: 32)
            .transformed(simd_float4x4(translation: V3(0, envelopeHeight - 0.1, 0)) * simd_float4x4(rotationX: .pi / 2)))
        metal.append(Geometry.torus(radius: 1.7, tube: 0.05, radialSegments: 6, tubularSegments: 48)
            .transformed(simd_float4x4(rotationX: .pi / 2)))
        for x: Float in [-0.25, 0.25] {
            metal.append(Geometry.cylinder(top: 0.16, bottom: 0.2, height: 0.3, radialSegments: 12).translated(V3(x, -3.1, 0)))
        }
        self.metal = MeshData.merged(metal).upload()

        // The basket, with a leather rim round its top.
        basket = Geometry.box(1.5, 1.15, 1.25).translated(V3(0, -5.3, 0)).upload()
        basketRim = Geometry.torus(radius: 0.9, tube: 0.06, radialSegments: 6, tubularSegments: 4)
            .transformed(simd_float4x4(translation: V3(0, -4.72, 0)) * simd_float4x4(rotationY: .pi / 4) * simd_float4x4(rotationX: .pi / 2))
            .upload()
        body = Geometry.capsule(radius: 0.17, length: 0.5, capSegments: 4, radialSegments: 8).upload()
        head = Geometry.sphere(radius: 0.13, widthSegments: 10, heightSegments: 8).upload()
        arm = Geometry.capsule(radius: 0.05, length: 0.4, capSegments: 3, radialSegments: 6).translated(V3(0, 0.2, 0)).upload()

        let gpu = GPU.shared
        weave = Art.weave(256, scale: 5).ctx.makeImage()!
        normalMap = gpu.texture(envelopeNormalImage(), srgb: false)
        // Wicker: strands woven over and under, as colour and as a height map for bump shading.
        func weaveAt(_ x: Int, _ y: Int) -> Double {
            let row = y / 12, col = x / 20
            let across = sin(Double(x % 20) / 20 * .pi), along = sin(Double(y % 12) / 12 * .pi)
            return (row + col) % 2 == 1 ? across : along
        }
        let wickerImage = Canvas(256, 256)
        wickerImage.setPixels { x, y in
            let v = 0.4 + 0.55 * (weaveAt(x, y) * 0.9 + 0.1) + (hash2(Double(x), Double(y)) - 0.5) * 0.1
            return ((v * 190 + 20).rounded(.towardZero), (v * 140 + 15).rounded(.towardZero), (v * 80 + 8).rounded(.towardZero))
        }
        wicker = gpu.texture(wickerImage, srgb: true)
        let bumpImage = Canvas(256, 256)
        bumpImage.setPixels { x, y in let v = weaveAt(x, y) * 255; return (v, v, v) }
        wickerBump = gpu.texture(bumpImage, srgb: false)
    }
}

/// Per-draw parameters of a balloon part (`PartParams` in the shaders).
struct PartParams {
    var model: simd_float4x4
    /// Linear albedo.
    var color: V4
    /// x = roughness, y = metalness, z = burn (the envelope's glow).
    var params: V4
}

private let darkMetal = (color: RGBA(hex: "#2a2a2e").linear, roughness: Float(0.5), metalness: Float(0.7))
private let leather = (color: RGBA(hex: "#3b2416").linear, roughness: Float(0.8), metalness: Float(0))
private let cable = (color: RGBA(hex: "#8c8c88").linear, roughness: Float(0.6), metalness: Float(0.5))
private let jackets = ["#d14b2f", "#2f6fd1", "#e8d86a", "#2b2b2b", "#f3f0e8", "#2a8a5e"]
private let skins = ["#e6b89c", "#8d5524", "#c68642", "#f1c27d"]

// MARK: - One balloon

final class Balloon {
    private struct Person {
        let place: simd_float4x4
        let jacket: V3
        let skin: V3
    }

    let index: Int
    let scale: Float
    let pattern: Pattern
    let palette: [String]
    var pos = V3.zero
    var vel = V3.zero
    var targetAlt: Float = 0
    /// Heat in the envelope: 0.5 is neutral buoyancy; burning adds heat, which slowly leaks away.
    var heat: Float
    private var pilotTimer: Float
    private var tilt = V2.zero
    private var tiltVel = V2.zero
    private(set) var burn: Float = 0
    private var burnTimer: Float = 0
    private var waveTimer: Float = 0
    private var armAngle: Float = -0.3
    private var flameStretch: Float = 1
    /// Where it starts when the app opens at night: low over the field.
    var tether = V3.zero

    private let skin: MTLTexture
    private let crew: [Person]
    private(set) var model = matrix_identity_float4x4

    init(index: Int) {
        let parts = Parts.shared
        self.index = index
        scale = rnd(0.85, 1.15)
        pattern = Pattern.allCases[index % Pattern.allCases.count]
        var pal = palettes.randomElement()!
        if coin() { pal.append(pal.removeFirst()) }
        palette = pal
        heat = 0.5 + rnd(-0.06, 0.06)
        pilotTimer = rnd(5, 60)
        skin = GPU.shared.texture(paintEnvelope(pattern, pal, weave: parts.weave), srgb: true)

        // The crew: two or three figures, one of whom waves when you rest the cursor on them.
        let n = randInt(2, 3)
        crew = (0..<n).map { i in
            let place = simd_float4x4(translation: V3((Float(i) - Float(n - 1) / 2) * 0.45, 0, i % 2 == 1 ? 0.25 : -0.25))
                * simd_float4x4(rotationY: rnd(0, TAU))
            return Person(place: place, jacket: RGBA(hex: jackets.randomElement()!).linear, skin: RGBA(hex: skins.randomElement()!).linear)
        }
    }

    /// Fire the burner for `seconds`; the balloon lights up and lifts, slowly, while it burns.
    func fire(_ seconds: Float = 2.5) { burnTimer = max(burnTimer, seconds) }

    func wave() { waveTimer = 2.5 }

    /// Radius of the envelope on screen, in points, for a balloon `depth` metres away.
    func screenRadius(depth: Float, focal: Float) -> Float { 8.5 * scale * focal / depth }

    /// The middle of the envelope, for hit tests and spacing.
    var centre: V3 { pos + V3(0, 9 * scale, 0) }

    func update(dt: Float, valley: Valley) {
        // Burner and glow.
        burnTimer = max(0, burnTimer - dt)
        let wantBurn: Float = burnTimer > 0 ? 1 : 0
        burn += clamp(wantBurn - burn, -dt * 1.2, dt * 6)
        flameStretch = 0.85 + 0.15 * sin(Float(valley.clock) * 27 + Float(index))

        // Flying, by day or by night.
        let wind = valley.windAt(pos)
        let floor = groundHeight(pos.x, pos.z)
        // Stay above the ground and above the line of sight over the brow of the knoll (so the hill
        // never hides a balloon's lower half), and no higher than keeps it in frame.
        let depth = -pos.z
        let eye = valley.cameraPosition.y
        let minAlt = max(floor + 25, eye - depth * 0.02)
        // The crown stays under the top of the view, which is about 0.42 x depth above the eye.
        let maxAlt = max(minAlt + 10, eye + depth * 0.36 - 20 * scale)
        // The burner heats the envelope; the heat leaks away slowly, so a burn keeps lifting for a
        // while after the flame, and a balloon left alone gradually cools and sinks. A burn's lift
        // fades over about fifteen seconds; then the balloon cools on and sinks.
        heat += burn * dt * 0.1 - dt * 0.02
        if pos.y > maxAlt { heat -= dt * 0.12 } // the pilot vents
        heat = clamp(heat, 0, 1)
        // The pilot: burns when sinking low or cool, and now and then when there's room above.
        pilotTimer -= dt
        let roomAbove = pos.y < minAlt + (maxAlt - minAlt) * 0.6
        let belowCeiling = pos.y < maxAlt - 4
        if burnTimer <= 0 && ((heat < 0.4 && belowCeiling) || pos.y < minAlt + 3 || (pilotTimer <= 0 && roomAbove)) {
            fire(rnd(2, 4))
            pilotTimer = rnd(20, 60)
        }
        if pilotTimer <= 0 { pilotTimer = rnd(10, 30) }
        let vy = clamp((heat - 0.5) * 3.0, -0.6, 1.2)
        vel.y += (vy - vel.y) * min(1, dt * 0.5)
        vel.x += (wind.x - vel.x) * min(1, dt * 0.25)
        vel.z += (wind.z - vel.z) * min(1, dt * 0.25)

        // The cursor's gust pushes it along and sets it swinging; so does any change in the wind.
        var gust = valley.gustAt(self)
        gust += V3(wind.x - vel.x, 0, wind.z - vel.z) * 0.25
        vel += gust * dt
        pos += vel * dt
        valley.keepInView(self)

        // Pendulum sway: the envelope leans into any horizontal acceleration, then settles.
        let target = V2(-gust.z * 0.05 - vel.z * 0.01, gust.x * 0.05 + vel.x * 0.01).clampedLength(0.3)
        let k: Float = 5.0, damp: Float = 1.6
        tiltVel = (tiltVel + (target - tilt) * (k * dt)) * max(0, 1 - damp * dt)
        tilt += tiltVel * dt
        model = simd_float4x4(translation: pos) * simd_float4x4(eulerXYZ: V3(tilt.x, Float(index) * 0.7, tilt.y))
            * simd_float4x4(scale: V3(repeating: scale))

        // A wave from the crew.
        waveTimer = max(0, waveTimer - dt)
        let goal: Float = waveTimer > 0 ? .pi * 0.85 + sin(Float(valley.clock) * 9) * 0.4 : -0.3
        armAngle += (goal - armAngle) * min(1, dt * 8)
    }

    // MARK: - Drawing

    private func params(_ local: simd_float4x4, _ color: V3, _ roughness: Float, _ metalness: Float) -> PartParams {
        PartParams(model: model * local, color: V4(color, 1), params: V4(roughness, metalness, burn, 0))
    }

    private func draw(_ e: MTLRenderCommandEncoder, _ mesh: GPUMesh, _ p: PartParams) {
        var p = p
        e.setVertexBytes(&p, length: MemoryLayout<PartParams>.stride, index: 2)
        e.setFragmentBytes(&p, length: MemoryLayout<PartParams>.stride, index: 1)
        mesh.draw(e)
    }

    /// The envelope and the basket cast the sun's shadows.
    func drawShadow(_ e: MTLRenderCommandEncoder) {
        let parts = Parts.shared
        e.setRenderPipelineState(GPU.shared.shadowPipeline("envelopeShadowVertex"))
        draw(e, parts.envelope, params(matrix_identity_float4x4, .zero, 1, 0))
        e.setRenderPipelineState(GPU.shared.shadowPipeline("partShadowVertex"))
        draw(e, parts.basket, params(matrix_identity_float4x4, .zero, 1, 0))
    }

    func draw(_ ctx: DrawContext) {
        let gpu = GPU.shared, e = ctx.encoder, parts = Parts.shared
        let identity = matrix_identity_float4x4
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)

        e.setRenderPipelineState(gpu.pipeline("envelopeVertex", "envelopeFragment", samples: ctx.samples))
        e.setFragmentTexture(skin, index: 0)
        e.setFragmentTexture(parts.normalMap, index: 1)
        e.setFragmentSamplerState(gpu.clampSampler, index: 0)
        e.setFragmentSamplerState(gpu.repeatSampler, index: 1)
        draw(e, parts.envelope, params(identity, V3(1, 1, 1), 0.78, 0))

        e.setRenderPipelineState(gpu.pipeline("partVertex", "wickerFragment", samples: ctx.samples))
        e.setFragmentTexture(parts.wicker, index: 0)
        e.setFragmentTexture(parts.wickerBump, index: 1)
        draw(e, parts.basket, params(identity, V3(1, 1, 1), 0.85, 0))

        e.setRenderPipelineState(gpu.pipeline("partVertex", "partFragment", samples: ctx.samples))
        draw(e, parts.metal, params(identity, darkMetal.color, darkMetal.roughness, darkMetal.metalness))
        draw(e, parts.cables, params(identity, cable.color, cable.roughness, cable.metalness))
        draw(e, parts.basketRim, params(identity, leather.color, leather.roughness, leather.metalness))
        for (i, person) in crew.enumerated() {
            draw(e, parts.body, params(person.place * simd_float4x4(translation: V3(0, -4.95, 0)), person.jacket, 0.9, 0))
            draw(e, parts.head, params(person.place * simd_float4x4(translation: V3(0, -4.45, 0)), person.skin, 0.8, 0))
            let angle = i == 0 ? armAngle : -0.3
            draw(e, parts.arm, params(person.place * simd_float4x4(translation: V3(0.22, -4.75, 0)) * simd_float4x4(rotationZ: angle),
                                      person.jacket, 0.9, 0))
        }
    }

    /// The burner flame: a billboard inside the throat, turned to the camera, drawn while burning.
    var flameVisible: Bool { burn > 0.01 }

    func drawFlame(_ ctx: DrawContext, cameraTurn: simd_quatf) {
        var p = QuadParams(model: model * simd_float4x4(translation: V3(0, -1.6, 0)) * simd_float4x4(cameraTurn)
                            * simd_float4x4(scale: V3(1.4, 2.8 * flameStretch, 1)),
                           color: .zero, extra: V4(burn, 0, 0, 0))
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline("quadVertex", "flameFragment", blend: .additive, samples: ctx.samples))
        e.setDepthStencilState(gpu.depthTest)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 0)
        e.setVertexBytes(&p, length: MemoryLayout<QuadParams>.stride, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentBytes(&p, length: MemoryLayout<QuadParams>.stride, index: 1)
        e.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }
}
