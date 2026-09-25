import CoreGraphics

enum TailStyle { case forked, fan, flowing, shark }

enum Pattern { case neon, metallic, angel, clown, shark }

enum BodyShape { case fish, shark }

/// A fin along the top (dorsal) or bottom (anal) of the body.
/// `start`/`end` are fractions of body length measured from the tail (0) to the nose (1).
struct FinSpec {
    var start: CGFloat
    var end: CGFloat
    var height: CGFloat
    /// How far the fin tip trails backwards, as a fraction of body length.
    var sweep: CGFloat
}

/// One half of the body's side-view outline (the back above the centre line, or the belly below
/// it), and the shape of that half of every cross-section. Heights are fractions of half the
/// species' height; positions are fractions of body length from the tail joint (0) to the nose (1).
struct BodyProfile {
    /// Height at the deepest point.
    var depth: CGFloat
    /// Where the deepest point is.
    var peak: CGFloat
    /// Height at the tail joint (the caudal peduncle).
    var peduncle: CGFloat
    /// How long the outline stays full ahead of the peak: 1 slopes straight down to the snout,
    /// 2 is rounded, 3 and up is a bulbous head.
    var head: CGFloat = 2
    /// How blunt the snout is: 0.5 meets the nose square-on, 1 comes to a point.
    var snout: CGFloat = 0.6
    /// How full the body stays behind the peak: 2 tapers evenly, higher stays deep further back
    /// (an egg or a disc).
    var rear: CGFloat = 2
    /// How sharply the body narrows into the peduncle (0 = gradual, 1 = pinched just ahead of the tail).
    var pinch: CGFloat = 0.4
    /// Cross-section shape of this half (a superellipse exponent): 2 is elliptical, lower narrows
    /// to a ridge (a dorsal keel), higher is full and flat (a belly).
    var roundness: CGFloat = 2

    static let back = BodyProfile(depth: 1, peak: 0.5, peduncle: 0.36, roundness: 1.7)
    static let belly = BodyProfile(depth: 1, peak: 0.45, peduncle: 0.34, roundness: 2.4)
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
    var shape: BodyShape = .fish
    var pectoralScale: CGFloat = 1
    var eyeScale: CGFloat = 1
    /// How much the body curls into turns.
    var flex: CGFloat = 1
    /// Skin roughness (higher = more matte); nil uses the default for the pattern.
    var roughness: CGFloat? = nil
    /// Outline and cross-section of the back and of the belly.
    var backProfile: BodyProfile = .back
    var bellyProfile: BodyProfile = .belly
}

extension Species {
    static let neonTetra = Species(
        id: "tetra", name: "Neon Tetra",
        length: 34, height: 11, thickness: 0.5, tailLength: 13, tailSpread: 6.5, tailStyle: .forked,
        dorsal: FinSpec(start: 0.36, end: 0.52, height: 5, sweep: 0.06),
        anal: FinSpec(start: 0.22, end: 0.45, height: 4.5, sweep: 0.05),
        top: RGBA(0.26, 0.30, 0.29), mid: RGBA(0.60, 0.64, 0.64), belly: RGBA(0.90, 0.92, 0.92),
        fin: RGBA(0.85, 0.92, 0.97, 0.45), finEdge: nil, eye: RGBA(0.70, 0.85, 0.95),
        pattern: .neon, cruise: 75, burst: 440, schooling: true, band: 0.25...0.75, population: 11,
        // Slender torpedo: a fairly straight back over a slightly deeper belly.
        backProfile: BodyProfile(depth: 0.88, peak: 0.55, peduncle: 0.34, head: 1.5, snout: 0.75, pinch: 0.5, roundness: 1.6),
        bellyProfile: BodyProfile(depth: 1.05, peak: 0.45, peduncle: 0.32, head: 1.8, pinch: 0.6, roundness: 2.3))

    static let goldfish = Species(
        id: "goldfish", name: "Goldfish",
        length: 58, height: 35, thickness: 0.72, tailLength: 46, tailSpread: 30, tailStyle: .flowing,
        dorsal: FinSpec(start: 0.34, end: 0.72, height: 16, sweep: 0.14),
        anal: FinSpec(start: 0.16, end: 0.32, height: 10, sweep: 0.08),
        top: RGBA(0.93, 0.36, 0.02), mid: RGBA(1.0, 0.54, 0.08), belly: RGBA(1.0, 0.84, 0.48),
        fin: RGBA(1.0, 0.56, 0.16, 0.78), finEdge: nil, eye: RGBA(0.95, 0.78, 0.40),
        pattern: .metallic, cruise: 42, burst: 300, schooling: false, band: 0.2...0.8, population: 3,
        // Short and deep, with a bulbous head and a round belly.
        backProfile: BodyProfile(depth: 0.95, peak: 0.52, peduncle: 0.3, head: 2.4, snout: 0.55, rear: 2.6, pinch: 0.5, roundness: 1.8),
        bellyProfile: BodyProfile(depth: 1.1, peak: 0.45, peduncle: 0.28, head: 2.2, rear: 2.8, pinch: 0.5, roundness: 2.7))

    static let angelfish = Species(
        id: "angelfish", name: "Angelfish",
        length: 44, height: 44, thickness: 0.26, tailLength: 30, tailSpread: 21, tailStyle: .forked,
        dorsal: FinSpec(start: 0.25, end: 0.70, height: 30, sweep: 0.22),
        anal: FinSpec(start: 0.25, end: 0.66, height: 32, sweep: 0.2),
        top: RGBA(0.62, 0.64, 0.60), mid: RGBA(0.86, 0.87, 0.83), belly: RGBA(0.96, 0.95, 0.90),
        fin: RGBA(0.86, 0.90, 0.88, 0.5), finEdge: nil, eye: RGBA(0.85, 0.25, 0.15),
        pattern: .angel, cruise: 32, burst: 260, schooling: false, band: 0.35...0.85, population: 2,
        // A tall, flat disc with a small pointed snout.
        backProfile: BodyProfile(depth: 1, peak: 0.45, peduncle: 0.22, head: 1.7, snout: 0.8, rear: 3, pinch: 0.35, roundness: 1.5),
        bellyProfile: BodyProfile(depth: 1, peak: 0.45, peduncle: 0.22, head: 1.8, snout: 0.75, rear: 3, pinch: 0.35, roundness: 1.8))

    static let clownfish = Species(
        id: "clownfish", name: "Clownfish",
        length: 46, height: 24, thickness: 0.55, tailLength: 18, tailSpread: 12, tailStyle: .fan,
        dorsal: FinSpec(start: 0.30, end: 0.80, height: 10, sweep: 0.05),
        anal: FinSpec(start: 0.20, end: 0.42, height: 9, sweep: 0.05),
        top: RGBA(0.95, 0.36, 0.0), mid: RGBA(1.0, 0.50, 0.05), belly: RGBA(1.0, 0.62, 0.22),
        fin: RGBA(1.0, 0.48, 0.05, 0.92), finEdge: RGBA(0.05, 0.04, 0.04, 0.9), eye: RGBA(0.95, 0.55, 0.10),
        pattern: .clown, cruise: 48, burst: 330, schooling: false, band: 0.05...0.4, population: 2,
        // A chunky oval with a thick tail stock.
        backProfile: BodyProfile(depth: 0.97, peak: 0.52, peduncle: 0.36, head: 2.1, pinch: 0.45, roundness: 1.9),
        bellyProfile: BodyProfile(depth: 0.98, peak: 0.5, peduncle: 0.34, pinch: 0.45, roundness: 2.5))

    static let betta = Species(
        id: "betta", name: "Betta",
        length: 40, height: 16, thickness: 0.5, tailLength: 52, tailSpread: 36, tailStyle: .flowing,
        dorsal: FinSpec(start: 0.18, end: 0.50, height: 22, sweep: 0.38),
        anal: FinSpec(start: 0.06, end: 0.62, height: 26, sweep: 0.32),
        top: RGBA(0.10, 0.13, 0.52), mid: RGBA(0.18, 0.30, 0.82), belly: RGBA(0.34, 0.40, 0.86),
        fin: RGBA(0.56, 0.16, 0.74, 0.78), finEdge: nil, eye: RGBA(0.30, 0.35, 0.60),
        pattern: .metallic, cruise: 28, burst: 240, schooling: false, band: 0.5...0.9, population: 1,
        // Slim and elongated, with a deep tail stock to carry its long fins.
        backProfile: BodyProfile(depth: 0.88, peak: 0.5, peduncle: 0.42, head: 1.6, snout: 0.65, pinch: 0.3, roundness: 1.8),
        bellyProfile: BodyProfile(depth: 1.05, peak: 0.45, peduncle: 0.4, head: 1.8, pinch: 0.3, roundness: 2.3))

    /// The optional predator: not part of the regular population (see `Shark`).
    static let shark = Species(
        id: "shark", name: "Shark",
        length: 440, height: 84, thickness: 0.85, tailLength: 160, tailSpread: 96, tailStyle: .shark,
        dorsal: FinSpec(start: 0.42, end: 0.62, height: 92, sweep: 0.12),
        anal: FinSpec(start: 0.1, end: 0.18, height: 20, sweep: 0.05),
        top: RGBA(0.20, 0.24, 0.29), mid: RGBA(0.40, 0.45, 0.50), belly: RGBA(0.50, 0.54, 0.58),
        fin: RGBA(0.34, 0.38, 0.43, 0.97), finEdge: nil, eye: RGBA(0.04, 0.04, 0.05),
        pattern: .shark, cruise: 30, burst: 540, schooling: false, band: 0.3...0.7, population: 0,
        shape: .shark, pectoralScale: 1.1, eyeScale: 0.4, flex: 2.5, roughness: 0.85,
        // Torpedo, thickest a third of the way back, tapering to a long pointed snout; the belly
        // is flatter than the back. It must stay elliptical (roundness 2) for `SharkJaw` to fit.
        backProfile: BodyProfile(depth: 1.05, peak: 0.6, peduncle: 0.3, head: 1.5, snout: 0.7, pinch: 0.3, roundness: 1.9),
        bellyProfile: BodyProfile(depth: 0.88, peak: 0.58, peduncle: 0.24, head: 1.7, snout: 0.65, pinch: 0.3, roundness: 2))

    static let all: [Species] = [.neonTetra, .goldfish, .angelfish, .clownfish, .betta]

    static func named(_ id: String) -> Species? { all.first { $0.id == id } }
}
