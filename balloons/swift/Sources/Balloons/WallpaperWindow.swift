import AppKit

/// A borderless window that lives at the desktop level: above the system wallpaper,
/// below the desktop icons and every normal window. It never takes mouse clicks.
final class WallpaperWindow: NSWindow {
    let view: RenderView
    let screenFrame: CGRect
    private(set) var valley: Valley
    private var displayLink: CADisplayLink?
    private var lastTimestamp: CFTimeInterval?

    init(screen: NSScreen, preview: Bool = false) {
        let frame = preview
            ? NSRect(x: screen.frame.midX - 640, y: screen.frame.midY - 400, width: 1280, height: 800)
            : screen.frame
        screenFrame = frame
        view = RenderView(frame: NSRect(origin: .zero, size: frame.size))
        valley = Valley(screenFrame: frame, settings: Settings.shared, fov: WallpaperWindow.fov)

        super.init(contentRect: frame,
                   styleMask: preview ? [.titled, .closable, .miniaturizable] : [.borderless],
                   backing: .buffered, defer: false)

        isReleasedWhenClosed = false
        backgroundColor = .black
        hasShadow = preview
        isOpaque = true

        if preview {
            title = "Balloon Dawn Preview"
        } else {
            level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
            collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
            ignoresMouseEvents = true
            setFrame(frame, display: false)
        }

        view.autoresizingMask = [.width, .height]
        contentView = view
        start()
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    // MARK: - Frame loop

    func start() {
        let link = view.displayLink(target: self, selector: #selector(step(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
        applySettings()
    }

    func stop() {
        displayLink?.invalidate()
        displayLink = nil
    }

    func setPaused(_ paused: Bool) {
        displayLink?.isPaused = paused
        lastTimestamp = nil
    }

    func applySettings() {
        let s = Settings.shared
        let fps = Float(s.framesPerSecond)
        displayLink?.preferredFrameRateRange = CAFrameRateRange(minimum: fps / 2, maximum: fps, preferred: fps)
        view.sampleCount = s.lowPower ? 1 : 4
    }

    /// `--fov degrees` narrows the camera to inspect detail as a 4K display would show it.
    static let fov: Float = {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--fov"), i + 1 < args.count, let v = Float(args[i + 1]) else { return 50 }
        return v
    }()

    /// A new morning: re-seed the balloons, the valley, the grass and the swallows.
    func reseed() {
        let fake = valley.fakeMouse
        valley = Valley(screenFrame: screenFrame, settings: Settings.shared, fov: WallpaperWindow.fov)
        valley.fakeMouse = fake
    }

    /// Render exactly one frame per simulation step.
    @objc private func step(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = Float(min(now - (lastTimestamp ?? now), 1.0 / 15))
        lastTimestamp = now
        valley.step(dt: dt, settings: Settings.shared)
        view.draw(valley: valley)
    }
}
