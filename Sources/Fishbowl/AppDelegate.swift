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
        if args.contains("--night") { settings.nightOverride = true }
        if args.contains("--day") { settings.nightOverride = false }
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
        windows.forEach { $0.tank.stop(); $0.orderOut(nil) }
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

    @objc private func pause() { windows.forEach { $0.tank.setPaused(true) } }
    @objc private func resume() { windows.forEach { $0.tank.setPaused(false) } }

    // MARK: - Click to feed

    private func updateClickMonitor() {
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        guard settings.clickToFeed else { return }
        // Global mouse monitors don't need Accessibility permission. Our windows ignore clicks,
        // so they pass straight through to Finder as usual; we only watch.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in
            let p = NSEvent.mouseLocation
            guard let self, DesktopHitTest.isDesktop(at: p) else { return }
            for w in self.windows where w.tank.screenFrame.contains(p) {
                let f = w.tank.screenFrame
                w.tank.dropFood(atScreen: CGPoint(x: p.x - f.minX, y: p.y - f.minY))
            }
        }
    }

    // MARK: - Menu bar

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = NSImage(systemSymbolName: "fish.fill", accessibilityDescription: "Fishbowl") {
            img.isTemplate = true
            statusItem.button?.image = img
        } else {
            statusItem.button?.title = "🐠"
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let count = windows.map { $0.tank.fish.count }.reduce(0, +)
        let header = NSMenuItem(title: "Fishbowl — \(count) fish", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        menu.addItem(item("Feed the Fish", #selector(feed), "f"))
        let add = NSMenuItem(title: "Add Fish", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for sp in Species.all {
            let i = item(sp.name, #selector(addFish(_:)))
            i.representedObject = sp.id
            sub.addItem(i)
        }
        add.submenu = sub
        menu.addItem(add)
        menu.addItem(item("Remove a Fish", #selector(removeFish)))
        menu.addItem(item("Refill Tank", #selector(resetTank)))
        menu.addItem(.separator())

        let night = item("Night Mode", #selector(toggleNight), "n")
        night.state = settings.nightMode ? .on : .off
        menu.addItem(night)
        let click = item("Click Desktop to Feed", #selector(toggleClickToFeed))
        click.state = settings.clickToFeed ? .on : .off
        menu.addItem(click)
        let low = item("Low Power (30 fps)", #selector(toggleLowPower))
        low.state = settings.lowPower ? .on : .off
        menu.addItem(low)
        let login = item("Launch at Login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(item("Quit Fishbowl", #selector(quit), "q"))
    }

    private func item(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc private func feed() { windows.forEach { $0.tank.dropFoodRandomly() } }

    @objc private func addFish(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let sp = Species.named(id) else { return }
        windows.forEach { $0.tank.addFish(sp) }
    }

    @objc private func removeFish() { windows.forEach { $0.tank.removeFish() } }

    @objc private func resetTank() { buildWindows() }

    @objc private func toggleNight() {
        settings.nightOverride = nil
        settings.nightMode.toggle()
    }

    @objc private func toggleClickToFeed() {
        settings.clickToFeed.toggle()
        updateClickMonitor()
    }

    @objc private func toggleLowPower() {
        settings.lowPower.toggle()
        windows.forEach { $0.tank.applySettings() }
    }

    @objc private func toggleLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change the login item"
            alert.informativeText = "\(error.localizedDescription)\n\nMake sure Fishbowl.app is in your Applications folder."
            alert.runModal()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - Debug snapshot

    /// `Fishbowl --snapshot out.png` renders the tank off-screen with a simulated cursor sweep,
    /// saves a frame and exits. Useful for checking visuals without touching the real desktop.
    private func runSnapshot(to path: String) {
        guard let w = windows.first else { return }
        let f = w.tank.screenFrame
        w.tank.fakeMouse = { t in
            // Rest for a while (curious fish approach), then sweep quickly across the tank.
            if t < 5 { return CGPoint(x: f.midX, y: f.midY) }
            let u = CGFloat(t - 5) * 1.6
            return CGPoint(x: f.midX + cos(u) * f.width * 0.3, y: f.midY + sin(u * 1.3) * f.height * 0.25)
        }
        let delay = Double(args.firstIndex(of: "--at").flatMap { Double(args[$0 + 1]) } ?? 6)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            w.tank.view.captureNextFrame { image in
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
