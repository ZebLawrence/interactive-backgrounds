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

    /// Dark tank lit only by a spotlight that follows the cursor.
    var nightMode: Bool {
        get { nightOverride ?? defaults.bool(forKey: "nightMode") }
        set { defaults.set(newValue, forKey: "nightMode") }
    }

    /// Set from the command line (`--night` / `--day`) for testing without changing the saved setting.
    var nightOverride: Bool?

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}
