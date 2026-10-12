import Foundation

final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    /// Render at 30 fps without multisampling, to save battery.
    var lowPower: Bool {
        get { defaults.bool(forKey: "lowPower") }
        set { defaults.set(newValue, forKey: "lowPower") }
    }

    /// Clicking on an empty part of the desktop claps: fireflies nearby flash and bolt.
    var clickToClap: Bool {
        get { defaults.object(forKey: "clickToClap") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "clickToClap") }
    }

    /// The moon in the sky and its light on the meadow (off: darker, with brighter stars).
    var moonlight: Bool {
        get { moonOverride ?? (defaults.object(forKey: "moonlight") as? Bool ?? true) }
        set { defaults.set(newValue, forKey: "moonlight") }
    }

    /// Set from the command line (`--dark` / `--moon`) for testing without changing the saved setting.
    var moonOverride: Bool?

    /// Rain, gusting wind, low cloud and lightning; the fireflies shelter in the grass.
    var storm: Bool {
        get { stormOverride ?? defaults.bool(forKey: "storm") }
        set { defaults.set(newValue, forKey: "storm") }
    }

    /// Set from the command line (`--storm` / `--calm`) for testing without changing the saved setting.
    var stormOverride: Bool?

    var density: Density {
        get { Density(rawValue: defaults.string(forKey: "density") ?? "") ?? .normal }
        set { defaults.set(newValue.rawValue, forKey: "density") }
    }

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}
