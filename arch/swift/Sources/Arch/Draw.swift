import Metal
import simd

/// The passes a frame is drawn in: the moon's shadow map; what the water reflects (from a camera
/// mirrored in the surface) and what lies under it (the floor, the bridge's legs, sinking stones);
/// then the scene.
enum Pass { case main, shadow, reflection, refraction }

/// Which passes a part of the scene appears in, as the web version's render layers: MAIN only in
/// the main pass, ABOVE also in the reflection, BELOW only in the refraction.
struct Layers: OptionSet {
    let rawValue: Int
    static let main = Layers(rawValue: 1)
    static let above = Layers(rawValue: 2)
    static let below = Layers(rawValue: 4)
    /// Something above the water: seen directly and in the reflection.
    static let surface: Layers = [.main, .above]

    func visible(in pass: Pass) -> Bool {
        switch pass {
        case .main: return !isDisjoint(with: [.main, .above])
        case .reflection: return contains(.above)
        case .refraction: return contains(.below)
        case .shadow: return true
        }
    }
}

/// What every part of the scene needs to draw itself into a pass.
struct DrawContext {
    let encoder: MTLRenderCommandEncoder
    /// The pass's shared uniforms (`Frame` in the shaders). In a shadow pass its `viewProj` is the
    /// light's matrix, so the same vertex functions serve both.
    let frame: MTLBuffer
    /// Multisample count of the pass (pipelines must match it).
    let samples: Int
    /// Which of the frames in flight this is, for per-frame buffers.
    let slot: Int
    let pass: Pass
    /// The key lights' shadow maps, drawn earlier in the frame (blank in the shadow passes).
    let sunShadow: MTLTexture
    let moonShadow: MTLTexture
    /// In the main pass: the water's reflection and refraction (with its depth), drawn just before.
    var reflection: MTLTexture? = nil
    var refraction: MTLTexture? = nil
    var refractionDepth: MTLTexture? = nil

    var isShadow: Bool { pass == .shadow }

    /// Is something on these layers drawn in this pass?
    func shows(_ layers: Layers) -> Bool { layers.visible(in: pass) }

    /// Bind the frame and the shadow maps for a custom pipeline (frame at vertex buffer 1 and
    /// fragment buffer 0, the shadow maps at fragment textures 1 and 2, samplers 0 repeat, 1 clamp,
    /// 2 shadow compare).
    func bindCommon() {
        let gpu = GPU.shared, e = encoder
        e.setVertexBuffer(frame, offset: 0, index: 1)
        e.setFragmentBuffer(frame, offset: 0, index: 0)
        e.setFragmentTexture(sunShadow, index: 1)
        e.setFragmentTexture(moonShadow, index: 2)
        e.setFragmentSamplerState(gpu.repeatSampler, index: 0)
        e.setFragmentSamplerState(gpu.clampSampler, index: 1)
        e.setFragmentSamplerState(gpu.shadowSampler, index: 2)
    }

    /// Set a pipeline for this pass: in the main pass `vertex` + `fragment`; in a shadow pass the
    /// depth-only version of `vertex` with `shadowFragment` (nil: no fragment, nothing discarded).
    func use(_ vertex: String, _ fragment: String, shadowFragment: String? = nil, blend: GPU.Blend = .opaque,
             alphaToCoverage: Bool = false, depthWrite: Bool? = nil) {
        let gpu = GPU.shared, e = encoder
        if isShadow {
            e.setRenderPipelineState(gpu.shadowPipeline(vertex, fragment: shadowFragment))
            e.setDepthStencilState(gpu.depthWrite)
        } else {
            e.setRenderPipelineState(gpu.pipeline(vertex, fragment, blend: blend, samples: samples, alphaToCoverage: alphaToCoverage))
            e.setDepthStencilState((depthWrite ?? (blend == .opaque)) ? gpu.depthWrite : gpu.depthTest)
        }
        bindCommon()
    }
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

    init(model: simd_float4x4, color: V3, opacity: Float = 1, roughness: Float, metalness: Float = 0,
         flags: StdFlags = [.receiveShadow], emissive: V3 = .zero, uv: V4 = V4(1, 1, 0, 0)) {
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
    /// Takes the key lights' shadows.
    static let receiveShadow = StdFlags(rawValue: 2)
    /// Lit on both faces (the normal flips on the back).
    static let doubleSided = StdFlags(rawValue: 4)
    /// Sample the map clamped rather than repeating.
    static let clampMap = StdFlags(rawValue: 8)
    /// MeshBasicMaterial: the colour as is.
    static let unlit = StdFlags(rawValue: 16)
    /// Not fogged (`fog: false`).
    static let noFog = StdFlags(rawValue: 32)
}

/// One instance of an instanced standard mesh: its transform and a colour multiplier.
struct StdInstance {
    var model: simd_float4x4
    var color: V4 = V4(1, 1, 1, 1)
}

/// Draws standard-material parts: lit by the hemisphere light and the two key lights with GGX
/// highlights, as three.js's MeshStandardMaterial lights them, fogged, optionally textured and
/// shadowed. In a shadow pass the same calls draw depth only.
enum Std {
    /// Bind what every standard draw in a pass shares.
    static func begin(_ ctx: DrawContext, vertex: String = "stdVertex", blend: GPU.Blend = .opaque) {
        ctx.use(vertex, "stdFragment", blend: blend)
        ctx.encoder.setFragmentTexture(GPU.shared.blank, index: 0)
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
}

/// A model matrix from a position, rotation and scale, as an Object3D composes them.
func compose(_ p: V3, _ q: simd_quatf, _ s: V3 = V3(1, 1, 1)) -> simd_float4x4 {
    simd_float4x4(translation: p) * simd_float4x4(q) * simd_float4x4(scale: s)
}

/// `quatAxis(angle, x, y, z)`.
func quatAxis(_ angle: Float, _ x: Float, _ y: Float, _ z: Float) -> simd_quatf {
    simd_quatf(angle: angle, axis: simd_normalize(V3(x, y, z)))
}

/// `a - b` wrapped into -pi...pi.
func angleDiff(_ a: Float, _ b: Float) -> Float {
    let d = (a - b + .pi).truncatingRemainder(dividingBy: TAU)
    return (d < 0 ? d + TAU : d) - .pi
}

func lerpAngle(_ a: Float, _ b: Float, _ t: Float) -> Float { a + angleDiff(b, a) * t }

extension simd_quatf {
    static let identity = simd_quatf(ix: 0, iy: 0, iz: 0, r: 1)

    /// three.js's `Quaternion.setFromEuler` with the given order ("XYZ" by default, "YXZ" for cameras).
    init(euler e: V3, order: String = "XYZ") {
        let qx = simd_quatf(angle: e.x, axis: V3(1, 0, 0))
        let qy = simd_quatf(angle: e.y, axis: V3(0, 1, 0))
        let qz = simd_quatf(angle: e.z, axis: V3(0, 0, 1))
        switch order {
        case "YXZ": self = qy * qx * qz
        case "ZXY": self = qz * qx * qy
        case "ZYX": self = qz * qy * qx
        case "YZX": self = qy * qz * qx
        case "XZY": self = qx * qz * qy
        default: self = qx * qy * qz
        }
    }
}

/// A minimal three.js `Object3D`: a transform (position, rotation, scale) relative to its parent,
/// children, and whatever it draws. The creatures are built as trees of these so their rigs
/// (body, head, ears, legs) port line for line from the web version.
final class Node {
    var position = V3.zero
    var quaternion = simd_quatf.identity
    var scale = V3(1, 1, 1)
    var visible = true
    private(set) var children: [Node] = []
    private(set) weak var parent: Node?
    /// What this node draws, called with its world matrix (nil for a pure joint).
    var draw: ((DrawContext, simd_float4x4) -> Void)?
    /// Whether `draw` should be called in the shadow passes too (`castShadow`).
    var castShadow = true
    var name = ""

    init(_ name: String = "") { self.name = name }

    /// Euler rotation (three.js's `rotation.set(x, y, z)`, XYZ order).
    var rotation: V3 {
        get { .zero }
        set { quaternion = simd_quatf(euler: newValue) }
    }

    func setRotation(_ x: Float, _ y: Float, _ z: Float, order: String = "XYZ") {
        quaternion = simd_quatf(euler: V3(x, y, z), order: order)
    }

    @discardableResult func add(_ n: Node) -> Node {
        n.parent?.remove(n)
        n.parent = self
        children.append(n)
        return n
    }

    func remove(_ n: Node) {
        children.removeAll { $0 === n }
        n.parent = nil
    }

    var localMatrix: simd_float4x4 { compose(position, quaternion, scale) }

    /// This node's transform in the world, through all its parents.
    var worldMatrix: simd_float4x4 {
        var m = localMatrix
        var p = parent
        while let n = p {
            m = n.localMatrix * m
            p = n.parent
        }
        return m
    }

    /// A point in this node's frame, in the world (`localToWorld`).
    func localToWorld(_ p: V3) -> V3 {
        let w = worldMatrix * V4(p, 1)
        return V3(w.x, w.y, w.z)
    }

    func worldPosition() -> V3 { localToWorld(.zero) }

    /// Visit every visible node with its world matrix, parents first.
    func traverse(_ parentMatrix: simd_float4x4 = matrix_identity_float4x4, _ body: (Node, simd_float4x4) -> Void) {
        guard visible else { return }
        let m = parentMatrix * localMatrix
        body(self, m)
        for c in children { c.traverse(m, body) }
    }

    /// Draw this node and everything under it into a pass (only shadow casters in a shadow pass).
    func render(_ ctx: DrawContext, _ parentMatrix: simd_float4x4 = matrix_identity_float4x4) {
        traverse(parentMatrix) { n, m in
            guard let d = n.draw, !ctx.isShadow || n.castShadow else { return }
            d(ctx, m)
        }
    }
}
