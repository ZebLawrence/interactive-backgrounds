import Foundation

final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    /// Render at 30 fps without multisampling, to save battery.
    var lowPower: Bool {
        get { lowPowerOverride ?? defaults.bool(forKey: "lowPower") }
        set { defaults.set(newValue, forKey: "lowPower") }
    }

    /// Clicking on an empty part of the desktop flushes the grouse there (or shakes a trunk).
    var clickToFlush: Bool {
        get { defaults.object(forKey: "clickToFlush") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "clickToFlush") }
    }

    /// Snow falling: the sky goes flat and light, the haze closes in, the prints fill in faster.
    var snowfall: Bool {
        get { snowOverride ?? (defaults.object(forKey: "snowfall") as? Bool ?? true) }
        set { snowOverride = nil; defaults.set(newValue, forKey: "snowfall") }
    }

    /// The cloud breaks for a low winter sun (at night: a clear sky, stars and the moon).
    var sunlight: Bool {
        get { sunOverride ?? defaults.bool(forKey: "sunlight") }
        set { sunOverride = nil; defaults.set(newValue, forKey: "sunlight") }
    }

    /// A snowy night, dark blue under the cloud.
    var night: Bool {
        get { nightOverride ?? defaults.bool(forKey: "night") }
        set { nightOverride = nil; defaults.set(newValue, forKey: "night") }
    }

    /// Set from the command line (`--snow`/`--clear`, `--sun`/`--overcast`, `--night`/`--day`) for
    /// testing without changing the saved settings.
    var snowOverride: Bool?
    var sunOverride: Bool?
    var nightOverride: Bool?
    /// `--low-power` forces Low Power for testing.
    var lowPowerOverride: Bool?

    var hares: HareCount {
        get { HareCount(rawValue: defaults.string(forKey: "hares") ?? "") ?? .two }
        set { defaults.set(newValue.rawValue, forKey: "hares") }
    }

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}

/// How many snowshoe hares live in the grove.
enum HareCount: String, CaseIterable {
    case one, two, three

    var count: Int {
        switch self {
        case .one: return 1
        case .two: return 2
        case .three: return 3
        }
    }

    var title: String {
        switch self {
        case .one: return "A Lone Hare"
        case .two: return "A Pair"
        case .three: return "Three"
        }
    }
}
