import CoreGraphics
import Metal

/// The Metal device, the compiled shaders and everything shared by every window: pipeline
/// states (cached by configuration), depth states, samplers, and texture uploads.
final class GPU {
    static let shared = GPU()

    let device: MTLDevice
    let queue: MTLCommandQueue
    let library: MTLLibrary

    /// Colour and depth formats of the scene pass (HDR, before bloom and tone mapping).
    static let sceneFormat: MTLPixelFormat = .rgba16Float
    static let depthFormat: MTLPixelFormat = .depth32Float
    /// The window's drawable; the output pass writes sRGB-encoded values into it.
    static let drawableFormat: MTLPixelFormat = .bgra8Unorm

    enum Blend: String { case opaque, alpha, additive }

    let depthWrite: MTLDepthStencilState
    let depthTest: MTLDepthStencilState
    let depthNone: MTLDepthStencilState

    let repeatSampler: MTLSamplerState
    let clampSampler: MTLSamplerState
    /// Bilinear, no mipmaps, for the post-processing passes.
    let postSampler: MTLSamplerState
    /// Compares a depth against the sun's shadow map, filtered (lit where the depth is nearer).
    let shadowSampler: MTLSamplerState

    private var pipelines: [String: MTLRenderPipelineState] = [:]

    private init() {
        let dev = MTLCreateSystemDefaultDevice()!
        device = dev
        queue = dev.makeCommandQueue()!
        do {
            library = try device.makeLibrary(source: Shaders.source, options: nil)
        } catch {
            fatalError("Balloons: shader compile failed: \(error)")
        }

        func depth(write: Bool, compare: MTLCompareFunction) -> MTLDepthStencilState {
            let d = MTLDepthStencilDescriptor()
            d.isDepthWriteEnabled = write
            d.depthCompareFunction = compare
            return dev.makeDepthStencilState(descriptor: d)!
        }
        depthWrite = depth(write: true, compare: .less)
        depthTest = depth(write: false, compare: .less)
        depthNone = depth(write: false, compare: .always)

        func sampler(_ s: MTLSamplerAddressMode, _ t: MTLSamplerAddressMode, mips: Bool, aniso: Int) -> MTLSamplerState {
            let d = MTLSamplerDescriptor()
            d.minFilter = .linear
            d.magFilter = .linear
            d.mipFilter = mips ? .linear : .notMipmapped
            d.sAddressMode = s
            d.tAddressMode = t
            d.maxAnisotropy = aniso
            return dev.makeSamplerState(descriptor: d)!
        }
        repeatSampler = sampler(.repeat, .repeat, mips: true, aniso: 4)
        clampSampler = sampler(.clampToEdge, .clampToEdge, mips: true, aniso: 8)
        postSampler = sampler(.clampToEdge, .clampToEdge, mips: false, aniso: 1)
        let sd = MTLSamplerDescriptor()
        sd.minFilter = .linear
        sd.magFilter = .linear
        sd.sAddressMode = .clampToEdge
        sd.tAddressMode = .clampToEdge
        sd.compareFunction = .lessEqual
        shadowSampler = dev.makeSamplerState(descriptor: sd)!
    }

    // MARK: - Pipelines

    /// A render pipeline for the named shader functions. Scene pipelines (`depth: true`) draw into
    /// the multisampled HDR target; post pipelines into `color` with no depth.
    func pipeline(_ vertex: String, _ fragment: String, blend: Blend = .opaque, samples: Int = 1,
                  color: MTLPixelFormat = GPU.sceneFormat, depth: Bool = true) -> MTLRenderPipelineState {
        let key = "\(vertex)|\(fragment)|\(blend)|\(samples)|\(color.rawValue)|\(depth)"
        if let p = pipelines[key] { return p }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = library.makeFunction(name: vertex)
        d.fragmentFunction = library.makeFunction(name: fragment)
        d.rasterSampleCount = samples
        let c = d.colorAttachments[0]!
        c.pixelFormat = color
        switch blend {
        case .opaque:
            c.isBlendingEnabled = false
        case .alpha:
            c.isBlendingEnabled = true
            c.sourceRGBBlendFactor = .sourceAlpha
            c.destinationRGBBlendFactor = .oneMinusSourceAlpha
            c.sourceAlphaBlendFactor = .one
            c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        case .additive:
            c.isBlendingEnabled = true
            c.sourceRGBBlendFactor = .sourceAlpha
            c.destinationRGBBlendFactor = .one
            c.sourceAlphaBlendFactor = .sourceAlpha
            c.destinationAlphaBlendFactor = .one
        }
        if depth { d.depthAttachmentPixelFormat = GPU.depthFormat }
        do {
            let p = try device.makeRenderPipelineState(descriptor: d)
            pipelines[key] = p
            return p
        } catch {
            fatalError("Balloons: pipeline \(key) failed: \(error)")
        }
    }

    /// A depth-only pipeline for the sun's shadow pass.
    func shadowPipeline(_ vertex: String) -> MTLRenderPipelineState {
        let key = "shadow|\(vertex)"
        if let p = pipelines[key] { return p }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = library.makeFunction(name: vertex)
        d.depthAttachmentPixelFormat = GPU.depthFormat
        do {
            let p = try device.makeRenderPipelineState(descriptor: d)
            pipelines[key] = p
            return p
        } catch {
            fatalError("Balloons: pipeline \(key) failed: \(error)")
        }
    }

    // MARK: - Buffers

    func buffer<T>(_ array: [T]) -> MTLBuffer {
        array.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: max($0.count, 16), options: .storageModeShared)! }
    }

    func buffer(length: Int) -> MTLBuffer {
        device.makeBuffer(length: max(length, 16), options: .storageModeShared)!
    }

    // MARK: - Textures

    /// Upload a colour canvas. Core Graphics stores premultiplied alpha; textures with
    /// transparency are un-premultiplied first, as browsers upload canvases to WebGL.
    func texture(_ canvas: Canvas, srgb: Bool, mipmaps: Bool = true) -> MTLTexture {
        let w = canvas.width, h = canvas.height
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: srgb ? .rgba8Unorm_srgb : .rgba8Unorm,
                                                         width: w, height: h, mipmapped: mipmaps)
        d.usage = .shaderRead
        let src = canvas.data
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        for i in stride(from: 0, to: bytes.count, by: 4) {
            let a = src[i + 3]
            if a == 255 || a == 0 {
                bytes[i] = src[i]; bytes[i + 1] = src[i + 1]; bytes[i + 2] = src[i + 2]
            } else {
                let k = 255.0 / Double(a)
                bytes[i] = UInt8(min(255, Double(src[i]) * k))
                bytes[i + 1] = UInt8(min(255, Double(src[i + 1]) * k))
                bytes[i + 2] = UInt8(min(255, Double(src[i + 2]) * k))
            }
            bytes[i + 3] = a
        }
        return upload(d, bytes, bytesPerRow: w * 4, mipmaps: mipmaps)
    }

    /// Upload a grey canvas as a single-channel mask (coverage), mipmapped.
    func mask(_ canvas: Canvas) -> MTLTexture {
        let w = canvas.width, h = canvas.height
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: w, height: h, mipmapped: true)
        d.usage = .shaderRead
        return upload(d, canvas.data, bytesPerRow: w, mipmaps: true)
    }

    /// Copy pixels into a GPU-private texture (laid out for fast sampling, unlike a shared one,
    /// which matters for the big valley and envelope images), then build its mipmaps.
    private func upload(_ d: MTLTextureDescriptor, _ bytes: UnsafeRawPointer, bytesPerRow: Int, mipmaps: Bool) -> MTLTexture {
        d.storageMode = .private
        let t = device.makeTexture(descriptor: d)!
        let staging = device.makeBuffer(bytes: bytes, length: bytesPerRow * d.height, options: .storageModeShared)!
        let cb = queue.makeCommandBuffer()!
        let blit = cb.makeBlitCommandEncoder()!
        blit.copy(from: staging, sourceOffset: 0, sourceBytesPerRow: bytesPerRow, sourceBytesPerImage: bytesPerRow * d.height,
                  sourceSize: MTLSize(width: d.width, height: d.height, depth: 1), to: t, destinationSlice: 0,
                  destinationLevel: 0, destinationOrigin: MTLOrigin())
        if mipmaps { blit.generateMipmaps(for: t) }
        blit.endEncoding()
        cb.commit()
        cb.waitUntilCompleted()
        return t
    }

    func generateMipmaps(_ t: MTLTexture) {
        guard let cb = queue.makeCommandBuffer(), let blit = cb.makeBlitCommandEncoder() else { return }
        blit.generateMipmaps(for: t)
        blit.endEncoding()
        cb.commit()
        cb.waitUntilCompleted()
    }

    /// A 1x1 texture, for parts whose real texture isn't ready.
    lazy var blank: MTLTexture = {
        let c = Canvas(1, 1)
        c.fill(RGBA(0, 0, 0, 0))
        return texture(c, srgb: false, mipmaps: false)
    }()
}

/// A ring of per-frame buffers, so the CPU can write the next frame while the GPU still reads
/// the previous ones (frames in flight).
final class FrameRing {
    static let count = 3
    private let buffers: [MTLBuffer]

    init(length: Int) {
        buffers = (0..<FrameRing.count).map { _ in GPU.shared.buffer(length: length) }
    }

    subscript(slot: Int) -> MTLBuffer { buffers[slot] }
}
