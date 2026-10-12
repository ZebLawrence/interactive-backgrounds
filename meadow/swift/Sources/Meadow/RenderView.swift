import AppKit
import Metal
import QuartzCore

/// A Metal-backed view that renders the meadow only when asked (once per simulation step), so the
/// frame rate is under our control. Each frame: the scene into a multisampled HDR target, then
/// three.js's UnrealBloomPass (a bright pass and five levels of separable blur), then the grade,
/// ACES tone mapping and sRGB encoding into the window.
final class RenderView: NSView {
    private let gpu = GPU.shared
    private var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    /// 4 = 4x MSAA, 1 = none (Low Power).
    var sampleCount = 4 {
        didSet { if sampleCount != oldValue { targets = nil } }
    }

    private struct Targets {
        let width: Int, height: Int
        let msaa: MTLTexture?
        let scene: MTLTexture
        let depth: MTLTexture
        let bright: MTLTexture
        let horizontal: [MTLTexture]
        let vertical: [MTLTexture]
        let bloom: MTLTexture
    }

    private var targets: Targets?
    private let inFlight = DispatchSemaphore(value: FrameRing.count)
    private var slot = 0
    private let frameUniforms = FrameRing(length: FrameUniforms.length)
    private var pendingCapture: ((CGImage?) -> Void)?
    /// `--stats`: log the average GPU time per frame every few seconds.
    static let logStats = CommandLine.arguments.contains("--stats")
    private var statTime: Double = 0
    private var statFrames = 0

    // UnrealBloomPass(resolution, strength 0.7, radius 0.45, threshold 0.8), as the web version sets it.
    private let bloomStrength: Float = 0.7
    private let bloomRadius: Float = 0.45
    private let bloomThreshold: Float = 0.8
    private static let kernelSizes = [3, 5, 7, 9, 11]
    private static let weights: [[Float]] = kernelSizes.map { k in
        (0..<k).map { i in 0.39894 * exp(-0.5 * Float(i * i) / Float(k * k)) / Float(k) }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func makeBackingLayer() -> CALayer {
        let l = CAMetalLayer()
        l.device = gpu.device
        l.pixelFormat = GPU.drawableFormat
        l.framebufferOnly = true
        l.isOpaque = true
        l.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        return l
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateDrawableSize()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateDrawableSize()
    }

    private func updateDrawableSize() {
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        metalLayer.contentsScale = scale
        metalLayer.drawableSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    }

    /// Read back the next presented frame (used by the `--snapshot` debug flag).
    func captureNextFrame(_ completion: @escaping (CGImage?) -> Void) {
        metalLayer.framebufferOnly = false
        pendingCapture = completion
    }

    // MARK: - Targets

    private func makeTargets(width w: Int, height h: Int) -> Targets {
        func texture(_ format: MTLPixelFormat, _ w: Int, _ h: Int, samples: Int = 1, memoryless: Bool = false) -> MTLTexture {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: max(1, w), height: max(1, h), mipmapped: false)
            // Memoryless (tile memory only) on Apple GPUs; Intel and AMD GPUs need real storage.
            let tileOnly = memoryless && gpu.device.supportsFamily(.apple4)
            d.usage = samples > 1 || tileOnly ? .renderTarget : [.renderTarget, .shaderRead]
            d.storageMode = tileOnly ? .memoryless : .private
            if samples > 1 {
                d.textureType = .type2DMultisample
                d.sampleCount = samples
            }
            return gpu.device.makeTexture(descriptor: d)!
        }
        // Bloom levels: half the resolution, then halving again for each of the five blurs.
        var sizes: [(Int, Int)] = []
        var rx = Int((Double(w) / 2).rounded()), ry = Int((Double(h) / 2).rounded())
        for _ in 0..<5 {
            sizes.append((rx, ry))
            rx = Int((Double(rx) / 2).rounded())
            ry = Int((Double(ry) / 2).rounded())
        }
        let msaa = sampleCount > 1
        return Targets(
            width: w, height: h,
            msaa: msaa ? texture(GPU.sceneFormat, w, h, samples: sampleCount, memoryless: true) : nil,
            scene: texture(GPU.sceneFormat, w, h),
            depth: texture(GPU.depthFormat, w, h, samples: sampleCount, memoryless: true),
            bright: texture(GPU.sceneFormat, sizes[0].0, sizes[0].1),
            horizontal: sizes.map { texture(GPU.sceneFormat, $0.0, $0.1) },
            vertical: sizes.map { texture(GPU.sceneFormat, $0.0, $0.1) },
            bloom: texture(GPU.sceneFormat, sizes[0].0, sizes[0].1)
        )
    }

    // MARK: - Frame

    func draw(meadow: Meadow) {
        let size = metalLayer.drawableSize
        guard size.width > 0, size.height > 0 else { return }
        // Don't run more than `FrameRing.count` frames ahead of the GPU.
        guard inFlight.wait(timeout: .now() + 0.1) == .success else { return }
        guard let drawable = metalLayer.nextDrawable(), let cb = gpu.queue.makeCommandBuffer() else {
            inFlight.signal()
            return
        }
        let w = drawable.texture.width, h = drawable.texture.height
        if targets?.width != w || targets?.height != h { targets = makeTargets(width: w, height: h) }
        let t = targets!
        slot = (slot + 1) % FrameRing.count
        let frame = frameUniforms[slot]
        meadow.writeFrame(into: frame, drawableHeight: Float(h))

        // The scene, multisampled and resolved into an HDR texture.
        let pass = MTLRenderPassDescriptor()
        let color = pass.colorAttachments[0]!
        if let msaa = t.msaa {
            color.texture = msaa
            color.resolveTexture = t.scene
            color.storeAction = .multisampleResolve
        } else {
            color.texture = t.scene
            color.storeAction = .store
        }
        color.loadAction = .clear
        color.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        pass.depthAttachment.texture = t.depth
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.storeAction = .dontCare
        pass.depthAttachment.clearDepth = 1
        if let enc = cb.makeRenderCommandEncoder(descriptor: pass) {
            meadow.draw(DrawContext(encoder: enc, frame: frame, samples: sampleCount, slot: slot))
            enc.endEncoding()
        }

        // Bloom: keep what's bright, blur it at five scales, and weight the levels together.
        var threshold = V4(bloomThreshold, 0, 0, 0)
        post(cb, into: t.bright, "highPassFragment") { e in
            e.setFragmentTexture(t.scene, index: 0)
            e.setFragmentBytes(&threshold, length: 16, index: 0)
        }
        var input = t.bright
        for i in 0..<5 {
            let target = t.horizontal[i]
            let inv = V2(1 / Float(target.width), 1 / Float(target.height))
            let radius = Float(RenderView.kernelSizes[i])
            var weights = RenderView.weights[i]
            for (dir, src, dst) in [(V2(1, 0), input, t.horizontal[i]), (V2(0, 1), t.horizontal[i], t.vertical[i])] {
                var params = V4(dir.x * inv.x, dir.y * inv.y, radius, 0)
                post(cb, into: dst, "blurFragment") { e in
                    e.setFragmentTexture(src, index: 0)
                    e.setFragmentBytes(&params, length: 16, index: 0)
                    e.setFragmentBytes(&weights, length: weights.count * 4, index: 1)
                }
            }
            input = t.vertical[i]
        }
        let factors: [Float] = [1.0, 0.8, 0.6, 0.4, 0.2].map { f in lerp(f, 1.2 - f, bloomRadius) }
        var f0 = V4(factors[0], factors[1], factors[2], factors[3]), f1 = V4(factors[4], bloomStrength, 0, 0)
        post(cb, into: t.bloom, "bloomCompositeFragment") { e in
            for i in 0..<5 { e.setFragmentTexture(t.vertical[i], index: i) }
            e.setFragmentBytes(&f0, length: 16, index: 0)
            e.setFragmentBytes(&f1, length: 16, index: 1)
        }

        // Scene + bloom, graded and tone mapped into the window.
        post(cb, into: drawable.texture, "outputFragment", format: GPU.drawableFormat) { e in
            e.setFragmentTexture(t.scene, index: 0)
            e.setFragmentTexture(t.bloom, index: 1)
        }

        if let capture = pendingCapture {
            pendingCapture = nil
            encodeCapture(cb, drawable.texture, capture)
        }
        cb.addCompletedHandler { [inFlight, weak self] cb in
            inFlight.signal()
            guard RenderView.logStats else { return }
            let gpuTime = cb.gpuEndTime - cb.gpuStartTime
            DispatchQueue.main.async {
                guard let self else { return }
                self.statTime += gpuTime
                self.statFrames += 1
                if self.statFrames == 180 {
                    print(String(format: "GPU %.2f ms/frame at %dx%d", self.statTime / 180 * 1000, w, h))
                    fflush(stdout)
                    self.statTime = 0
                    self.statFrames = 0
                }
            }
        }
        cb.present(drawable)
        cb.commit()
    }

    /// A full-screen pass drawing `fragment` into `target`.
    private func post(_ cb: MTLCommandBuffer, into target: MTLTexture, _ fragment: String,
                      format: MTLPixelFormat = GPU.sceneFormat, _ bind: (MTLRenderCommandEncoder) -> Void) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let e = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
        e.setRenderPipelineState(gpu.pipeline("postVertex", fragment, color: format, depth: false))
        e.setFragmentSamplerState(gpu.postSampler, index: 0)
        bind(e)
        e.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        e.endEncoding()
    }

    private func encodeCapture(_ cb: MTLCommandBuffer, _ tex: MTLTexture, _ capture: @escaping (CGImage?) -> Void) {
        let w = tex.width, h = tex.height, bytesPerRow = w * 4
        guard let buffer = gpu.device.makeBuffer(length: bytesPerRow * h, options: .storageModeShared),
              let blit = cb.makeBlitCommandEncoder() else { capture(nil); return }
        blit.copy(from: tex, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(),
                  sourceSize: MTLSize(width: w, height: h, depth: 1), to: buffer,
                  destinationOffset: 0, destinationBytesPerRow: bytesPerRow, destinationBytesPerImage: bytesPerRow * h)
        blit.endEncoding()
        cb.addCompletedHandler { _ in
            let data = Data(bytes: buffer.contents(), count: bytesPerRow * h)
            let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info,
                                provider: CGDataProvider(data: data as CFData)!, decode: nil,
                                shouldInterpolate: false, intent: .defaultIntent)
            DispatchQueue.main.async { capture(image) }
        }
    }
}
