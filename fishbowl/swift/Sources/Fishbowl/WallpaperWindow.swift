import AppKit

/// A borderless window that lives at the desktop level: above the system wallpaper,
/// below the desktop icons and every normal window. It never takes mouse clicks.
final class WallpaperWindow: NSWindow {
    let tank: Tank

    init(screen: NSScreen, preview: Bool = false) {
        let frame = preview
            ? NSRect(x: screen.frame.midX - 640, y: screen.frame.midY - 400, width: 1280, height: 800)
            : screen.frame
        let view = RenderView(frame: NSRect(origin: .zero, size: frame.size))
        tank = Tank(view: view, screenFrame: frame)

        super.init(contentRect: frame,
                   styleMask: preview ? [.titled, .closable, .miniaturizable] : [.borderless],
                   backing: .buffered, defer: false)

        isReleasedWhenClosed = false
        backgroundColor = .black
        hasShadow = preview
        isOpaque = true

        if preview {
            title = "Fishbowl Preview"
        } else {
            level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) + 1)
            collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
            ignoresMouseEvents = true
            setFrame(frame, display: false)
        }

        view.autoresizingMask = [.width, .height]
        contentView = view
        tank.start()
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
