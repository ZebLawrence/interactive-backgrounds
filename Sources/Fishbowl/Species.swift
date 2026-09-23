import CoreGraphics

enum TailStyle { case forked, fan, flowing }

enum Pattern { case neon, metallic, angel, clown }

/// A fin along the top (dorsal) or bottom (anal) of the body.
/// `start`/`end` are fractions of body length measured from the tail (0) to the nose (1).
struct FinSpec {
    var start: CGFloat
    var end: CGFloat
    var height: CGFloat
    /// How far the fin tip trails backwards, as a fraction of body length.
    var sweep: CGFloat
}

struct Species {
    let id: String
    let name: String
    /// Body length without the tail, in points at the front glass.
    let length: CGFloat
    let height: CGFloat
    /// Body thickness relative to its height (angelfish are very flat, goldfish chunky).
    let thickness: CGFloat
    let tailLength: CGFloat
    let tailSpread: CGFloat
    let tailStyle: TailStyle
    let dorsal: FinSpec
    let anal: FinSpec
    let top: RGBA
    let mid: RGBA
    let belly: RGBA
    let fin: RGBA
    let finEdge: RGBA?
    let eye: RGBA
    let pattern: Pattern
    /// Relaxed swimming speed and panicked burst speed, in points per second.
    let cruise: CGFloat
    let burst: CGFloat
    let schooling: Bool
    /// Preferred vertical band of the tank (0 = sand, 1 = surface).
    let band: ClosedRange<CGFloat>
    /// How many to spawn on a ~1500x1000 pt screen.
    let population: Int
}

extension Species {
    static let neonTetra = Species(
        id: "tetra", name: "Neon Tetra",
        length: 34, height: 11, thickness: 0.5, tailLength: 13, tailSpread: 6.5, tailStyle: .forked,
        dorsal: FinSpec(start: 0.36, end: 0.52, height: 5, sweep: 0.06),
        anal: FinSpec(start: 0.22, end: 0.45, height: 4.5, sweep: 0.05),
        top: RGBA(0.26, 0.30, 0.29), mid: RGBA(0.60, 0.64, 0.64), belly: RGBA(0.90, 0.92, 0.92),
        fin: RGBA(0.85, 0.92, 0.97, 0.45), finEdge: nil, eye: RGBA(0.70, 0.85, 0.95),
        pattern: .neon, cruise: 75, burst: 440, schooling: true, band: 0.25...0.75, population: 11)

    static let goldfish = Species(
        id: "goldfish", name: "Goldfish",
        length: 58, height: 35, thickness: 0.72, tailLength: 46, tailSpread: 30, tailStyle: .flowing,
        dorsal: FinSpec(start: 0.34, end: 0.72, height: 16, sweep: 0.14),
        anal: FinSpec(start: 0.16, end: 0.32, height: 10, sweep: 0.08),
        top: RGBA(0.93, 0.36, 0.02), mid: RGBA(1.0, 0.54, 0.08), belly: RGBA(1.0, 0.84, 0.48),
        fin: RGBA(1.0, 0.56, 0.16, 0.78), finEdge: nil, eye: RGBA(0.95, 0.78, 0.40),
        pattern: .metallic, cruise: 42, burst: 300, schooling: false, band: 0.2...0.8, population: 3)

    static let angelfish = Species(
        id: "angelfish", name: "Angelfish",
        length: 44, height: 44, thickness: 0.26, tailLength: 30, tailSpread: 21, tailStyle: .forked,
        dorsal: FinSpec(start: 0.25, end: 0.70, height: 30, sweep: 0.22),
        anal: FinSpec(start: 0.25, end: 0.66, height: 32, sweep: 0.2),
        top: RGBA(0.62, 0.64, 0.60), mid: RGBA(0.86, 0.87, 0.83), belly: RGBA(0.96, 0.95, 0.90),
        fin: RGBA(0.86, 0.90, 0.88, 0.5), finEdge: nil, eye: RGBA(0.85, 0.25, 0.15),
        pattern: .angel, cruise: 32, burst: 260, schooling: false, band: 0.35...0.85, population: 2)

    static let clownfish = Species(
        id: "clownfish", name: "Clownfish",
        length: 46, height: 24, thickness: 0.55, tailLength: 18, tailSpread: 12, tailStyle: .fan,
        dorsal: FinSpec(start: 0.30, end: 0.80, height: 10, sweep: 0.05),
        anal: FinSpec(start: 0.20, end: 0.42, height: 9, sweep: 0.05),
        top: RGBA(0.95, 0.36, 0.0), mid: RGBA(1.0, 0.50, 0.05), belly: RGBA(1.0, 0.62, 0.22),
        fin: RGBA(1.0, 0.48, 0.05, 0.92), finEdge: RGBA(0.05, 0.04, 0.04, 0.9), eye: RGBA(0.95, 0.55, 0.10),
        pattern: .clown, cruise: 48, burst: 330, schooling: false, band: 0.05...0.4, population: 2)

    static let betta = Species(
        id: "betta", name: "Betta",
        length: 40, height: 16, thickness: 0.5, tailLength: 52, tailSpread: 36, tailStyle: .flowing,
        dorsal: FinSpec(start: 0.18, end: 0.50, height: 22, sweep: 0.38),
        anal: FinSpec(start: 0.06, end: 0.62, height: 26, sweep: 0.32),
        top: RGBA(0.10, 0.13, 0.52), mid: RGBA(0.18, 0.30, 0.82), belly: RGBA(0.34, 0.40, 0.86),
        fin: RGBA(0.56, 0.16, 0.74, 0.78), finEdge: nil, eye: RGBA(0.30, 0.35, 0.60),
        pattern: .metallic, cruise: 28, burst: 240, schooling: false, band: 0.5...0.9, population: 1)

    static let all: [Species] = [.neonTetra, .goldfish, .angelfish, .clownfish, .betta]

    static func named(_ id: String) -> Species? { all.first { $0.id == id } }
}
