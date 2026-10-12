import Foundation

final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    /// Render at 30 fps without multisampling, to save battery.
    var lowPower: Bool {
        get { defaults.bool(forKey: "lowPower") }
        set { defaults.set(newValue, forKey: "lowPower") }
    }

    /// Clicking on an empty part of the desktop fires a burner: the balloon under the click, or the nearest.
    var clickToBurn: Bool {
        get { defaults.object(forKey: "clickToBurn") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "clickToBurn") }
    }

    /// The flock of swallows over the hillside.
    var birds: Bool {
        get { defaults.object(forKey: "birds") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "birds") }
    }

    /// The fiesta's night show: a starry sky, and every burn lights an envelope like a lantern.
    var nightGlow: Bool {
        get { nightOverride ?? defaults.bool(forKey: "nightGlow") }
        set { defaults.set(newValue, forKey: "nightGlow") }
    }

    /// Set from the command line (`--night` / `--dawn`) for testing without changing the saved setting.
    var nightOverride: Bool?

    var density: Density {
        get { Density(rawValue: defaults.string(forKey: "density") ?? "") ?? .normal }
        set { defaults.set(newValue.rawValue, forKey: "density") }
    }

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}
