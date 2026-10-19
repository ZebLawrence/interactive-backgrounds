import Foundation

final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    /// Render at 30 fps without multisampling, with a smaller wave simulation, to save battery.
    var lowPower: Bool {
        get { lowPowerOverride ?? defaults.bool(forKey: "lowPower") }
        set { defaults.set(newValue, forKey: "lowPower") }
    }

    /// Clicking on an empty part of the desktop tosses a stone (or rouses the craft, or flares the aurora).
    var clickToSplash: Bool {
        get { defaults.object(forKey: "clickToSplash") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "clickToSplash") }
    }

    /// The aurora over the canyon.
    var aurora: Bool {
        get { auroraOverride ?? (defaults.object(forKey: "aurora") as? Bool ?? true) }
        set { auroraOverride = nil; defaults.set(newValue, forKey: "aurora") }
    }

    /// The moon behind the viewer, raking the bridge and the walls.
    var moonlight: Bool {
        get { moonOverride ?? (defaults.object(forKey: "moonlight") as? Bool ?? true) }
        set { moonOverride = nil; defaults.set(newValue, forKey: "moonlight") }
    }

    /// The craft exploring the canyon.
    var craft: Bool {
        get { craftOverride ?? (defaults.object(forKey: "craft") as? Bool ?? true) }
        set { craftOverride = nil; defaults.set(newValue, forKey: "craft") }
    }

    /// The storm: rain, cloud, lightning.
    var rain: Bool {
        get { rainOverride ?? defaults.bool(forKey: "rain") }
        set { rainOverride = nil; defaults.set(newValue, forKey: "rain") }
    }

    /// Set from the command line (`--aurora`/`--noaurora`, `--moon`/`--nomoon`, `--craft`/`--nocraft`,
    /// `--rain`/`--norain`, `--low-power`) for testing without changing the saved settings.
    var auroraOverride: Bool?
    var moonOverride: Bool?
    var craftOverride: Bool?
    var rainOverride: Bool?
    var lowPowerOverride: Bool?

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}
