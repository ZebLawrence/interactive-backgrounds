import Metal
import SceneKit

/// Renders the tank as seen in the water surface: a second camera mirrored about the surface plane,
/// drawn at reduced resolution into a texture that the surface shader samples.
///
/// Mirroring the scene about y = s is equivalent to viewing it from a camera mirrored to y = 2s with
/// the image flipped vertically, so a surface fragment at NDC (x, y) finds its reflection at (x, -y).
final class Reflection {
    /// Nodes with this category bit (the surface itself) are hidden from the mirror camera.
    static let surfaceCategory = 2

    let property = SCNMaterialProperty()
    private let renderer: SCNRenderer
    private let cameraNode = SCNNode()
    private let device: MTLDevice
    private var color: MTLTexture?
    private var depth: MTLTexture?
    private let scale: CGFloat = 0.5

    init(device: MTLDevice, scene: SCNScene, mainCamera: SCNCamera, mirrorY: Float, eyeDistance: Float, pixelSize: CGSize) {
        self.device = device
        renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene
        let cam = SCNCamera()
        cam.fieldOfView = mainCamera.fieldOfView
        cam.projectionDirection = mainCamera.projectionDirection
        cam.zNear = mainCamera.zNear
        cam.zFar = mainCamera.zFar
        cam.categoryBitMask = ~Reflection.surfaceCategory
        cameraNode.camera = cam
        cameraNode.simdPosition = V3(0, 2 * mirrorY, eyeDistance)
        scene.rootNode.addChildNode(cameraNode)
        renderer.pointOfView = cameraNode
        renderer.isPlaying = true
        // Create the texture now so the material has something to bind from the first frame.
        makeTargets(width: max(1, Int(pixelSize.width * scale)), height: max(1, Int(pixelSize.height * scale)))
    }

    /// Encode the mirror pass into `commandBuffer`; `size` is the main drawable size in pixels.
    func render(atTime time: CFTimeInterval, commandBuffer: MTLCommandBuffer, size: CGSize) {
        let w = max(1, Int(size.width * scale)), h = max(1, Int(size.height * scale))
        if color?.width != w || color?.height != h { makeTargets(width: w, height: h) }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = color
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.depthAttachment.texture = depth
        pass.depthAttachment.loadAction = .clear
        pass.depthAttachment.storeAction = .dontCare
        pass.stencilAttachment.texture = depth
        pass.stencilAttachment.loadAction = .clear
        pass.stencilAttachment.storeAction = .dontCare
        renderer.render(atTime: time, viewport: CGRect(x: 0, y: 0, width: w, height: h),
                        commandBuffer: commandBuffer, passDescriptor: pass)
    }

    private func makeTargets(width: Int, height: Int) {
        let c = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: width, height: height, mipmapped: false)
        c.usage = [.renderTarget, .shaderRead]
        c.storageMode = .private
        color = device.makeTexture(descriptor: c)
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .depth32Float_stencil8, width: width, height: height, mipmapped: false)
        d.usage = .renderTarget
        d.storageMode = .private
        depth = device.makeTexture(descriptor: d)
        property.contents = color
    }
}
