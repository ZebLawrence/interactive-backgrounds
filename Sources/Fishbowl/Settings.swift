import Foundation

final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    /// Render at 30 fps instead of 60 to save battery.
    var lowPower: Bool {
        get { defaults.bool(forKey: "lowPower") }
        set { defaults.set(newValue, forKey: "lowPower") }
    }

    /// Clicking on an empty part of the desktop drops food into the tank.
    var clickToFeed: Bool {
        get { defaults.object(forKey: "clickToFeed") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "clickToFeed") }
    }

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}
