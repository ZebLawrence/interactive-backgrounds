import Metal
import simd

/// The passes a frame is drawn in. The water needs two before the main one: what it reflects
/// (from a camera mirrored in the surface) and what lies under it (the bed and the fish).
enum Pass { case main, reflection, refraction }

/// Which passes a part of the scene appears in, as the web version's render layers: MAIN only in
/// the main pass, ABOVE also in the reflection, BELOW only in the refraction.
struct Layers: OptionSet {
    let rawValue: Int
    static let main = Layers(rawValue: 1)
    static let above = Layers(rawValue: 2)
    static let below = Layers(rawValue: 4)
    /// The usual layer set for something above the water: seen directly and in the reflection.
    static let surface: Layers = [.main, .above]

    func visible(in pass: Pass) -> Bool {
        switch pass {
        case .main: return !isDisjoint(with: [.main, .above])
        case .reflection: return contains(.above)
        case .refraction: return contains(.below)
        }
    }
}

/// What every part of the scene needs to draw itself into a pass.
struct DrawContext {
    let encoder: MTLRenderCommandEncoder
    /// The pass's shared uniforms (`Frame` in the shaders): the main camera or the mirrored one.
    let frame: MTLBuffer
    /// Multisample count of the pass (pipelines must match it).
    let samples: Int
    /// Which of the frames in flight this is, for per-frame buffers.
    let slot: Int
    let pass: Pass
    /// The key light's shadow map, drawn earlier in the frame.
    let shadowMap: MTLTexture
}

/// Per-draw parameters of a MeshStandardMaterial-style part (`StdParams` in the shaders).
struct StdParams {
    var model: simd_float4x4
    /// Linear albedo; a = opacity.
    var color: V4
    /// Linear emissive colour x intensity.
    var emissive: V4 = .zero
    /// x = roughness, y = metalness, z = flags (see `StdFlags`).
    var material: V4
    /// The map's transform: xy = repeat, zw = offset.
    var uv: V4 = V4(1, 1, 0, 0)
    /// A trout's swim: phase, amplitude, turn, sway.
    var swim: V4 = .zero

    init(model: simd_float4x4, color: V3, opacity: Float = 1, roughness: Float, metalness: Float,
         flags: StdFlags = [], emissive: V3 = .zero, uv: V4 = V4(1, 1, 0, 0)) {
        self.model = model
        self.color = V4(color, opacity)
        self.emissive = V4(emissive, 0)
        self.material = V4(roughness, metalness, Float(flags.rawValue), 0)
        self.uv = uv
    }
}

struct StdFlags: OptionSet {
    let rawValue: Int
    /// Multiply the albedo by the bound map.
    static let map = StdFlags(rawValue: 1)
    /// Takes the key light's shadow.
    static let receiveShadow = StdFlags(rawValue: 2)
    /// Lit on both faces (the normal flips on the back).
    static let doubleSided = StdFlags(rawValue: 4)
    /// Sample the map clamped rather than repeating.
    static let clampMap = StdFlags(rawValue: 8)
}

/// One instance of an instanced standard mesh: its transform and a colour multiplier.
struct StdInstance {
    var model: simd_float4x4
    var color: V4 = V4(1, 1, 1, 1)
}

/// Draws standard-material parts: lit by the hemisphere and key lights with GGX highlights, as
/// three.js's MeshStandardMaterial lights them, fogged, optionally textured and shadowed.
enum Std {
    /// Bind what every standard draw in a pass shares.
    static func begin(_ ctx: DrawContext, vertex: String = "stdVertex", blend: GPU.Blend = .opaque) {
        let gpu = GPU.shared, e = ctx.encoder
        e.setRenderPipelineState(gpu.pipeline(vertex, "stdFragment", blend: blend, samples: ctx.samples))
        e.setDepthStencilState(blend == .opaque ? gpu.depthWrite : gpu.depthTest)
        e.setVertexBuffer(ctx.frame, offset: 0, index: 1)
        e.setFragmentBuffer(ctx.frame, offset: 0, index: 0)
        e.setFragmentTexture(gpu.blank, index: 0)
        e.setFragmentTexture(ctx.shadowMap, index: 1)
        e.setFragmentSamplerState(gpu.repeatSampler, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 1)
        e.setFragmentSamplerState(gpu.shadowSampler, index: 2)
    }

    static func draw(_ ctx: DrawContext, _ mesh: GPUMesh, _ params: StdParams, map: MTLTexture? = nil,
                     instances: MTLBuffer? = nil, count: Int = 1) {
        var p = params
        let e = ctx.encoder
        e.setVertexBytes(&p, length: MemoryLayout<StdParams>.stride, index: 2)
        e.setFragmentBytes(&p, length: MemoryLayout<StdParams>.stride, index: 1)
        e.setFragmentTexture(map ?? GPU.shared.blank, index: 0)
        if let instances { e.setVertexBuffer(instances, offset: 0, index: 3) }
        e.setVertexBuffer(mesh.vertices, offset: 0, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: mesh.count, indexType: .uint32, indexBuffer: mesh.indices,
                                indexBufferOffset: 0, instanceCount: count)
    }

    /// The same mesh into the key light's shadow map.
    static func drawShadow(_ e: MTLRenderCommandEncoder, _ mesh: GPUMesh, _ params: StdParams, vertex: String = "stdShadowVertex",
                           instances: MTLBuffer? = nil, count: Int = 1) {
        var p = params
        e.setRenderPipelineState(GPU.shared.shadowPipeline(vertex))
        e.setVertexBytes(&p, length: MemoryLayout<StdParams>.stride, index: 2)
        if let instances { e.setVertexBuffer(instances, offset: 0, index: 3) }
        e.setVertexBuffer(mesh.vertices, offset: 0, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: mesh.count, indexType: .uint32, indexBuffer: mesh.indices,
                                indexBufferOffset: 0, instanceCount: count)
    }
}

/// A model matrix from a position, rotation and scale, as an Object3D composes them.
func compose(_ p: V3, _ q: simd_quatf, _ s: V3 = V3(1, 1, 1)) -> simd_float4x4 {
    simd_float4x4(translation: p) * simd_float4x4(q) * simd_float4x4(scale: s)
}

/// `quatAxis(angle, x, y, z)`.
func quatAxis(_ angle: Float, _ x: Float, _ y: Float, _ z: Float) -> simd_quatf {
    simd_quatf(angle: angle, axis: simd_normalize(V3(x, y, z)))
}

func angleDiff(_ a: Float, _ b: Float) -> Float {
    let d = (a - b + .pi).truncatingRemainder(dividingBy: TAU)
    return (d < 0 ? d + TAU : d) - .pi
}

func lerpAngle(_ a: Float, _ b: Float, _ t: Float) -> Float { a + angleDiff(b, a) * t }
