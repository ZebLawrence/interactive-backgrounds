import AppKit
import Metal
import QuartzCore
import SceneKit

/// A Metal-backed view that draws a SceneKit scene only when asked.
///
/// `SCNView` runs its own render loop at the display's full refresh rate (120 Hz on ProMotion
/// screens) regardless of `preferredFramesPerSecond`. For an always-on wallpaper we instead render
/// exactly one frame per simulation step, so the frame rate (and battery use) is under our control.
final class RenderView: NSView {
    let device: MTLDevice
    let renderer: SCNRenderer
    private let queue: MTLCommandQueue
    private var msaaTexture: MTLTexture?
    private var depthTexture: MTLTexture?
    private let pixelFormat: MTLPixelFormat = .bgra8Unorm_srgb
    private let depthFormat: MTLPixelFormat = .depth32Float_stencil8

    /// 4 = 4x MSAA, 1 = no antialiasing.
    var sampleCount = 4 {
        didSet { if sampleCount != oldValue { msaaTexture = nil; depthTexture = nil } }
    }

    private var metalLayer: CAMetalLayer { layer as! CAMetalLayer }
    private var pendingCapture: ((CGImage?) -> Void)?

    /// Read back the next presented frame (used by the `--snapshot` debug flag).
    func captureNextFrame(_ completion: @escaping (CGImage?) -> Void) {
        metalLayer.framebufferOnly = false
        pendingCapture = completion
    }

    override init(frame: NSRect) {
        device = MTLCreateSystemDefaultDevice()!
        queue = device.makeCommandQueue()!
        renderer = SCNRenderer(device: device, options: nil)
        super.init(frame: frame)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func makeBackingLayer() -> CALayer {
        let l = CAMetalLayer()
        l.device = device
        l.pixelFormat = pixelFormat
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

    func draw(atTime time: CFTimeInterval) {
        let size = metalLayer.drawableSize
        guard size.width > 0, size.height > 0,
              let drawable = metalLayer.nextDrawable(),
              let commandBuffer = queue.makeCommandBuffer() else { return }
        let w = drawable.texture.width, h = drawable.texture.height
        if depthTexture?.width != w || depthTexture?.height != h { makeTargets(width: w, height: h) }

        let pass = MTLRenderPassDescriptor()
        let color = pass.colorAttachments[0]!
        if sampleCount > 1 {
            color.texture = msaaTexture
            color.resolveTexture = drawable.texture
            color.storeAction = .multisampleResolve
        } else {
            color.texture = drawable.texture
            color.storeAction = .store
        }
        color.loadAction = .clear
        color.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        pass.depthAttachment.texture = depthTexture
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.storeAction = .dontCare
        pass.depthAttachment.clearDepth = 1
        pass.stencilAttachment.texture = depthTexture
        pass.stencilAttachment.loadAction = .clear
        pass.stencilAttachment.storeAction = .dontCare

        renderer.render(atTime: time, viewport: CGRect(x: 0, y: 0, width: w, height: h),
                        commandBuffer: commandBuffer, passDescriptor: pass)
        if let capture = pendingCapture {
            pendingCapture = nil
            let tex = drawable.texture
            let bytesPerRow = w * 4
            let buffer = device.makeBuffer(length: bytesPerRow * h, options: .storageModeShared)!
            let blit = commandBuffer.makeBlitCommandEncoder()!
            blit.copy(from: tex, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(),
                      sourceSize: MTLSize(width: w, height: h, depth: 1), to: buffer,
                      destinationOffset: 0, destinationBytesPerRow: bytesPerRow, destinationBytesPerImage: bytesPerRow * h)
            blit.endEncoding()
            commandBuffer.addCompletedHandler { _ in
                let data = Data(bytes: buffer.contents(), count: bytesPerRow * h)
                let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
                let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info,
                                    provider: CGDataProvider(data: data as CFData)!, decode: nil,
                                    shouldInterpolate: false, intent: .defaultIntent)
                DispatchQueue.main.async { capture(image) }
            }
        }
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func makeTargets(width: Int, height: Int) {
        func texture(_ format: MTLPixelFormat) -> MTLTexture? {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: width, height: height, mipmapped: false)
            d.usage = .renderTarget
            d.storageMode = .private
            if sampleCount > 1 {
                d.textureType = .type2DMultisample
                d.sampleCount = sampleCount
            }
            return device.makeTexture(descriptor: d)
        }
        msaaTexture = sampleCount > 1 ? texture(pixelFormat) : nil
        depthTexture = texture(depthFormat)
    }
}
