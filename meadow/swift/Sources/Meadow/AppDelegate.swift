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
        if args.contains("--storm") { settings.stormOverride = true }
        if args.contains("--calm") { settings.stormOverride = false }
        if args.contains("--dark") { settings.moonOverride = false }
        if args.contains("--moon") { settings.moonOverride = true }
        if args.contains("--lightning-now") { settings.stormOverride = true; Lightning.strikeSoon = true }
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

    // MARK: - Click to clap

    private func updateClickMonitor() {
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        guard settings.clickToClap else { return }
        // Global mouse monitors don't need Accessibility permission. Our windows ignore clicks,
        // so they pass straight through to Finder as usual; we only watch.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in
            let p = NSEvent.mouseLocation
            guard let self, DesktopHitTest.isDesktop(at: p) else { return }
            for w in self.windows where w.screenFrame.contains(p) {
                let f = w.screenFrame
                w.meadow.clap(atScreen: CGPoint(x: p.x - f.minX, y: p.y - f.minY))
            }
        }
    }

    // MARK: - Menu bar

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Firefly Meadow") {
            img.isTemplate = true
            statusItem.button?.image = img
        } else {
            statusItem.button?.title = "✨"
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let count = windows.map { $0.meadow.swarm.flies.count }.reduce(0, +)
        let header = NSMenuItem(title: "Firefly Meadow — \(count) fireflies", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        menu.addItem(item("Clap", #selector(clap), "c"))
        let density = NSMenuItem(title: "Fireflies", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for d in Density.allCases {
            let i = item(d.title, #selector(setDensity(_:)))
            i.representedObject = d.rawValue
            i.state = settings.density == d ? .on : .off
            sub.addItem(i)
        }
        density.submenu = sub
        menu.addItem(density)
        menu.addItem(item("New Meadow", #selector(newMeadow)))
        menu.addItem(.separator())

        let moon = item("Moonlight", #selector(toggleMoonlight), "m")
        moon.state = settings.moonlight ? .on : .off
        menu.addItem(moon)
        let storm = item("Storm", #selector(toggleStorm), "s")
        storm.state = settings.storm ? .on : .off
        menu.addItem(storm)
        let click = item("Click Desktop to Clap", #selector(toggleClickToClap))
        click.state = settings.clickToClap ? .on : .off
        menu.addItem(click)
        let low = item("Low Power (30 fps)", #selector(toggleLowPower))
        low.state = settings.lowPower ? .on : .off
        menu.addItem(low)
        let login = item("Launch at Login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(item("Quit Firefly Meadow", #selector(quit), "q"))
    }

    private func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    /// A clap in the middle of the meadow, a little below the horizon.
    @objc private func clap() {
        for w in windows {
            let f = w.screenFrame
            w.meadow.clap(atScreen: CGPoint(x: f.width / 2, y: f.height * 0.45))
        }
    }

    @objc private func setDensity(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let d = Density(rawValue: raw) else { return }
        settings.density = d
        windows.forEach { $0.meadow.setDensity(d) }
    }

    @objc private func newMeadow() { windows.forEach { $0.reseed() } }

    @objc private func toggleMoonlight() {
        settings.moonOverride = nil
        settings.moonlight.toggle()
    }

    @objc private func toggleStorm() {
        settings.stormOverride = nil
        settings.storm.toggle()
    }

    @objc private func toggleClickToClap() {
        settings.clickToClap.toggle()
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
            alert.informativeText = "\(error.localizedDescription)\n\nMake sure Meadow.app is in your Applications folder."
            alert.runModal()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - Debug snapshot

    /// `Meadow --snapshot out.png [--at seconds] [--clap-at seconds]` renders the meadow in a preview
    /// window with a simulated cursor (resting a little below the horizon, so curious fireflies
    /// gather round it), saves a frame and exits. Useful for checking visuals without touching the
    /// real desktop.
    private func runSnapshot(to path: String) {
        guard let w = windows.first else { return }
        let f = w.screenFrame
        func number(after flag: String) -> Double? { args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? Double(args[$0 + 1]) : nil } }
        w.meadow.fakeMouse = { _ in CGPoint(x: f.midX, y: f.minY + f.height * 0.42) }
        if let clapAt = number(after: "--clap-at") {
            DispatchQueue.main.asyncAfter(deadline: .now() + clapAt) { w.meadow.clap(atScreen: CGPoint(x: f.width / 2, y: f.height * 0.42)) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (number(after: "--at") ?? 6)) {
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
