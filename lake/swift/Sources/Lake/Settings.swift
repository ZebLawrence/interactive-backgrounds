import Foundation

final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    /// Render at 30 fps without multisampling, with a smaller wave simulation, to save battery.
    var lowPower: Bool {
        get { defaults.bool(forKey: "lowPower") }
        set { defaults.set(newValue, forKey: "lowPower") }
    }

    /// Clicking on an empty part of the desktop skips a stone toward the click.
    var clickToSkip: Bool {
        get { defaults.object(forKey: "clickToSkip") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "clickToSkip") }
    }

    /// The afterglow gone, the moon up over the right-hand shore, the Milky Way on the water.
    var night: Bool {
        get { nightOverride ?? defaults.bool(forKey: "night") }
        set { defaults.set(newValue, forKey: "night") }
    }

    /// Set from the command line (`--night` / `--dusk`) for testing without changing the saved setting.
    var nightOverride: Bool?

    /// A low grey ceiling, rain falling, every drop dimpling the water; the dragonflies shelter.
    var rain: Bool {
        get { rainOverride ?? defaults.bool(forKey: "rain") }
        set { defaults.set(newValue, forKey: "rain") }
    }

    /// Set from the command line (`--rain` / `--dry`) for testing without changing the saved setting.
    var rainOverride: Bool?

    var density: Density {
        get { Density(rawValue: defaults.string(forKey: "density") ?? "") ?? .normal }
        set { defaults.set(newValue.rawValue, forKey: "density") }
    }

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}
