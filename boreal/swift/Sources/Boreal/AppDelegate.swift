import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var windows: [WallpaperWindow] = []
    private var statusItem: NSStatusItem!
    private var clickMonitor: Any?
    private var screenSignature = ""
    private let settings = Settings.shared
    private let args = CommandLine.arguments
    private var isPreview: Bool { args.contains("--preview") || args.contains("--snapshot") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if args.contains("--snow") { settings.snowOverride = true }
        if args.contains("--clear") { settings.snowOverride = false }
        if args.contains("--moon") { settings.moonOverride = true }
        if args.contains("--dark") { settings.moonOverride = false }
        if args.contains("--low-power") { settings.lowPowerOverride = true }
        if let i = args.firstIndex(of: "--render"), i + 1 < args.count {
            renderHeadless(to: args[i + 1])
            exit(0)
        }
        buildWindows()
        setupStatusItem()
        updateClickMonitor()

        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(self, selector: #selector(pause), name: NSWorkspace.screensDidSleepNotification, object: nil)
        ws.addObserver(self, selector: #selector(pause), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        ws.addObserver(self, selector: #selector(resume), name: NSWorkspace.screensDidWakeNotification, object: nil)
        ws.addObserver(self, selector: #selector(resume), name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)

        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            runSnapshot(to: args[i + 1])
        }
    }

    // MARK: - Windows

    private func buildWindows() {
        windows.forEach { $0.stop(); $0.orderOut(nil) }
        windows.removeAll()
        let screens = isPreview ? Array(NSScreen.screens.prefix(1)) : NSScreen.screens
        screenSignature = NSScreen.screens.map { NSStringFromRect($0.frame) }.joined(separator: "|")
        for screen in screens {
            let w = WallpaperWindow(screen: screen, preview: isPreview)
            w.orderFrontRegardless()
            windows.append(w)
        }
    }

    @objc private func screensChanged() {
        // This fires for many reasons (Dock resize, etc.); only rebuild when the screen layout changed.
        let sig = NSScreen.screens.map { NSStringFromRect($0.frame) }.joined(separator: "|")
        if sig != screenSignature { buildWindows() }
    }

    @objc private func pause() { windows.forEach { $0.setPaused(true) } }
    @objc private func resume() { windows.forEach { $0.setPaused(false) } }

    // MARK: - Clicks on the desktop: a vole rustles in the snow, or the aurora flares in the sky

    private func updateClickMonitor() {
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        guard settings.clickToHunt else { return }
        // Global mouse monitors don't need Accessibility permission. Our windows ignore clicks,
        // so they pass straight through to Finder as usual; we only watch.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in
            let p = NSEvent.mouseLocation
            guard let self, DesktopHitTest.isDesktop(at: p) else { return }
            for w in self.windows where w.screenFrame.contains(p) {
                let f = w.screenFrame
                w.scene.click(atScreen: CGPoint(x: p.x - f.minX, y: p.y - f.minY))
            }
        }
    }

    // MARK: - Menu bar

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = NSImage(systemSymbolName: "moon.stars", accessibilityDescription: "Boreal Night") {
            img.isTemplate = true
            statusItem.button?.image = img
        } else {
            statusItem.button?.title = "☾"
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let owls = windows.first?.scene.owls.count ?? 0
        let header = NSMenuItem(title: "Boreal Night — \(owls) \(owls == 1 ? "owl" : "owls")", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        menu.addItem(item("Rustle a Vole", #selector(hunt), "h"))
        menu.addItem(item("Aurora Substorm", #selector(substorm), "a"))
        let owlsItem = NSMenuItem(title: "Owls", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for o in OwlCount.allCases {
            let i = item(o.title, #selector(setOwls(_:)))
            i.representedObject = o.rawValue
            i.state = settings.owls == o ? .on : .off
            sub.addItem(i)
        }
        owlsItem.submenu = sub
        menu.addItem(owlsItem)
        menu.addItem(item("New Night", #selector(newNight)))
        menu.addItem(.separator())

        let snow = item("Snowfall", #selector(toggleSnow), "s")
        snow.state = settings.snowfall ? .on : .off
        menu.addItem(snow)
        let moon = item("Moonlight", #selector(toggleMoon), "m")
        moon.state = settings.moonlight ? .on : .off
        menu.addItem(moon)
        let click = item("Click Desktop to Rustle", #selector(toggleClick))
        click.state = settings.clickToHunt ? .on : .off
        menu.addItem(click)
        let low = item("Low Power (30 fps)", #selector(toggleLowPower))
        low.state = settings.lowPower ? .on : .off
        menu.addItem(low)
        let login = item("Launch at Login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(item("Quit Boreal Night", #selector(quit), "q"))
    }

    private func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc private func hunt() { windows.forEach { $0.scene.huntSomewhere() } }
    @objc private func substorm() { windows.forEach { $0.scene.substorm() } }

    @objc private func setOwls(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let o = OwlCount(rawValue: raw) else { return }
        settings.owls = o
        windows.forEach { $0.scene.setOwls(o.count) }
    }

    @objc private func newNight() { windows.forEach { $0.reseed() } }
    @objc private func toggleSnow() { settings.snowfall.toggle() }
    @objc private func toggleMoon() { settings.moonlight.toggle() }

    @objc private func toggleClick() {
        settings.clickToHunt.toggle()
        updateClickMonitor()
    }

    @objc private func toggleLowPower() {
        settings.lowPower.toggle()
        windows.forEach { $0.applySettings() }
    }

    @objc private func toggleLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change the login item"
            alert.informativeText = "\(error.localizedDescription)\n\nMake sure Boreal.app is in your Applications folder."
            alert.runModal()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - Debug snapshot

    /// `Boreal --render out.png [--px width height] [--bench frames]` plus the `--snapshot` options
    /// below (`--at`, `--cursor`, `--sweep`, `--click-at`, `--hunt-at`, `--look`, `--log`): the same,
    /// without a window and in simulated time (sixty steps a second, as fast as it can), so it works
    /// with the display asleep and comes out the same every time. `--bench` then renders that many
    /// more frames, still stepping, and prints the average GPU time per frame.
    private func renderHeadless(to path: String) {
        func number(after flag: String, _ k: Int = 1) -> Double? {
            args.firstIndex(of: flag).flatMap { $0 + k < args.count ? Double(args[$0 + k]) : nil }
        }
        let pw = Int(number(after: "--px") ?? 2560), ph = Int(number(after: "--px", 2) ?? 1600)
        let frame = CGRect(x: 0, y: 0, width: CGFloat(pw) / 2, height: CGFloat(ph) / 2)
        let scene = Boreal(screenFrame: frame, settings: settings, fov: WallpaperWindow.fov)
        let view = RenderView(frame: NSRect(origin: .zero, size: frame.size))
        view.sampleCount = settings.lowPower ? 1 : 4
        configureTest(scene, frame)
        var events: [(Double, () -> Void)] = []
        if let at = number(after: "--click-at") {
            let p = CGPoint(x: frame.width * (number(after: "--click-at", 2) ?? 0.5), y: frame.height * (number(after: "--click-at", 3) ?? 0.3))
            events.append((at, { scene.click(atScreen: p) }))
        }
        if let at = number(after: "--hunt-at") { events.append((at, { scene.huntSomewhere() })) }
        if let at = number(after: "--substorm-at") { events.append((at, { scene.substorm() })) }
        if args.contains("--substorm") { scene.substorm() }
        let end = number(after: "--at") ?? 6
        let dt: Float = 1.0 / Float(settings.framesPerSecond)
        var t = 0.0
        while t < end {
            scene.step(dt: dt, settings: settings)
            t += Double(dt)
            for (at, fire) in events where at <= t && at > t - Double(dt) { fire() }
            // The last few frames are drawn, so the shadow maps (redrawn every other frame) are current.
            if end - t < 4.0 / 60 { _ = view.renderOffscreen(scene: scene, width: pw, height: ph, capture: false) }
        }
        if args.contains("--log") { scene.log() }
        let (image, _) = view.renderOffscreen(scene: scene, width: pw, height: ph, capture: true)
        if let image {
            try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            print("wrote \(path)")
        }
        if let n = number(after: "--bench").map(Int.init), n > 0 {
            var total = 0.0
            for _ in 0..<n {
                scene.step(dt: dt, settings: settings)
                total += view.renderOffscreen(scene: scene, width: pw, height: ph, capture: false).1
            }
            print(String(format: "GPU %.2f ms/frame at %dx%d", total / Double(n) * 1000, pw, ph))
        }
    }

    /// The simulated cursor and camera for test renders.
    private func configureTest(_ scene: Boreal, _ f: CGRect) {
        func number(after flag: String, _ k: Int = 1) -> Double? {
            args.firstIndex(of: flag).flatMap { $0 + k < args.count ? Double(args[$0 + k]) : nil }
        }
        if args.contains("--no-cursor") {
            scene.fakeMouse = { _ in CGPoint(x: -100_000, y: -100_000) }
        } else if args.contains("--sweep") {
            // Sweep across the clearing and back every four seconds: a fast hand through the trees.
            let y = f.height * (number(after: "--cursor", 2) ?? 0.45)
            scene.fakeMouse = { t in
                let k = Double(t).truncatingRemainder(dividingBy: 4) / 4
                return CGPoint(x: f.minX + f.width * (0.1 + 0.8 * (0.5 - 0.5 * cos(k * 2 * .pi))), y: f.minY + y)
            }
        } else {
            let cursor = CGPoint(x: f.width * (number(after: "--cursor") ?? 0.45), y: f.height * (number(after: "--cursor", 2) ?? 0.3))
            scene.fakeMouse = { _ in CGPoint(x: f.minX + cursor.x, y: f.minY + cursor.y) }
        }
        if let x = number(after: "--look"), let y = number(after: "--look", 2), let z = number(after: "--look", 3) {
            scene.look = (V3(Float(x), Float(y), Float(z)), Float(number(after: "--look", 4) ?? 12))
        }
    }

    /// `Boreal --snapshot out.png [--at seconds] [--cursor fx fy] [--sweep] [--click-at seconds fx fy]
    /// [--hunt-at seconds] [--substorm] [--look x y z fov] [--log]` renders the forest in a preview window with a
    /// simulated cursor resting at (fx, fy) of the window (y up; default: on the near snow, a little
    /// left of centre), or sweeping fast across it, saves a frame and exits. `--click-at` clicks at a
    /// point of the window; `--hunt-at` rustles a vole somewhere; `--look` aims the camera at a
    /// world point with a narrow field of view to inspect detail; `--log` prints what the creatures
    /// are doing. Useful for checking visuals without touching the real desktop.
    private func runSnapshot(to path: String) {
        guard let w = windows.first else { return }
        let f = w.screenFrame
        func number(after flag: String, _ k: Int = 1) -> Double? {
            args.firstIndex(of: flag).flatMap { $0 + k < args.count ? Double(args[$0 + k]) : nil }
        }
        configureTest(w.scene, f)
        if let at = number(after: "--click-at") {
            let p = CGPoint(x: f.width * (number(after: "--click-at", 2) ?? 0.5), y: f.height * (number(after: "--click-at", 3) ?? 0.3))
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { w.scene.click(atScreen: p) }
        }
        if let at = number(after: "--hunt-at") {
            DispatchQueue.main.asyncAfter(deadline: .now() + at) { w.scene.huntSomewhere() }
        }
        if args.contains("--substorm") { w.scene.substorm() }
        DispatchQueue.main.asyncAfter(deadline: .now() + (number(after: "--at") ?? 6)) {
            if self.args.contains("--log") { w.scene.log() }
            w.view.captureNextFrame { image in
                guard let image else { exit(1) }
                let rep = NSBitmapImageRep(cgImage: image)
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
                print("wrote \(path)")
                exit(0)
            }
        }
    }
}

/// Decides whether a click landed on the bare desktop rather than on a window, the Dock or the menu bar.
enum DesktopHitTest {
    static func isDesktop(at p: NSPoint) -> Bool {
        guard let primary = NSScreen.screens.first else { return false }
        // Window bounds use top-left-origin coordinates relative to the primary screen.
        let q = CGPoint(x: p.x, y: primary.frame.height - p.y)
        let screenRects = NSScreen.screens.map {
            CGRect(x: $0.frame.minX, y: primary.frame.height - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height)
        }
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return false }
        for info in list {
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
            guard layer >= 0, alpha > 0.01,
                  let dict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict as CFDictionary),
                  bounds.contains(q) else { continue }
            // Skip invisible full-screen overlays some system services keep above the desktop.
            if layer > 0 && screenRects.contains(where: { $0.equalTo(bounds) }) { continue }
            return false
        }
        return true
    }
}
