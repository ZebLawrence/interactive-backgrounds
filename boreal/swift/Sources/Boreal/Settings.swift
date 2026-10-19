import Foundation

final class Settings {
    static let shared = Settings()
    private let defaults = UserDefaults.standard

    /// Render at 30 fps without multisampling, to save battery.
    var lowPower: Bool {
        get { lowPowerOverride ?? defaults.bool(forKey: "lowPower") }
        set { defaults.set(newValue, forKey: "lowPower") }
    }

    /// Clicking on an empty part of the desktop rustles a vole there (or, in the sky, flares the aurora).
    var clickToHunt: Bool {
        get { defaults.object(forKey: "clickToHunt") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "clickToHunt") }
    }

    /// Snow falling; it loads the trees again and fills the owls' prints in.
    var snowfall: Bool {
        get { snowOverride ?? (defaults.object(forKey: "snowfall") as? Bool ?? true) }
        set { snowOverride = nil; defaults.set(newValue, forKey: "snowfall") }
    }

    /// The moon up: without it the clearing is darker and the aurora and stars stand out.
    var moonlight: Bool {
        get { moonOverride ?? (defaults.object(forKey: "moonlight") as? Bool ?? true) }
        set { moonOverride = nil; defaults.set(newValue, forKey: "moonlight") }
    }

    /// Set from the command line (`--snow`/`--clear`, `--moon`/`--dark`, `--low-power`) for testing
    /// without changing the saved settings.
    var snowOverride: Bool?
    var moonOverride: Bool?
    var lowPowerOverride: Bool?

    var owls: OwlCount {
        get { OwlCount(rawValue: defaults.string(forKey: "owls") ?? "") ?? .one }
        set { defaults.set(newValue.rawValue, forKey: "owls") }
    }

    var framesPerSecond: Int { lowPower ? 30 : 60 }
}

/// How many great grey owls hunt the clearing.
enum OwlCount: String, CaseIterable {
    case one, pair, three

    var count: Int {
        switch self {
        case .one: return 1
        case .pair: return 2
        case .three: return 3
        }
    }

    var title: String {
        switch self {
        case .one: return "A Lone Owl"
        case .pair: return "A Pair"
        case .three: return "Three"
        }
    }
}
