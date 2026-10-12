import Foundation
import simd

typealias V2 = SIMD2<Float>
typealias V3 = SIMD3<Float>
typealias V4 = SIMD4<Float>

let TAU = Float.pi * 2

extension SIMD3 where Scalar == Float {
    var length: Float { simd_length(self) }
    var lengthSquared: Float { simd_length_squared(self) }

    /// Normalised copy, or zero for (near) zero vectors.
    var normalized: V3 {
        let l = length
        return l > 1e-5 ? self / l : .zero
    }

    func distance(to o: V3) -> Float { simd_distance(self, o) }
    func dot(_ o: V3) -> Float { simd_dot(self, o) }
    func cross(_ o: V3) -> V3 { simd_cross(self, o) }
}

@inline(__always) func clamp<T: Comparable>(_ x: T, _ lo: T, _ hi: T) -> T { min(max(x, lo), hi) }
@inline(__always) func lerp(_ a: Float, _ b: Float, _ t: Float) -> Float { a + (b - a) * t }
@inline(__always) func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
@inline(__always) func lerp(_ a: V3, _ b: V3, _ t: Float) -> V3 { a + (b - a) * t }

/// Uniform random in lo..<hi (the web version's `rnd`).
@inline(__always) func rnd(_ lo: Float, _ hi: Float) -> Float { lo + Float.random(in: 0..<1) * (hi - lo) }
@inline(__always) func rnd(_ r: ClosedRange<Float>) -> Float { rnd(r.lowerBound, r.upperBound) }
@inline(__always) func rndD(_ lo: Double, _ hi: Double) -> Double { lo + Double.random(in: 0..<1) * (hi - lo) }
/// Random integer in lo...hi (inclusive).
@inline(__always) func randInt(_ lo: Int, _ hi: Int) -> Int { Int.random(in: lo...hi) }
@inline(__always) func coin() -> Bool { Bool.random() }
@inline(__always) func chance(_ p: Double) -> Bool { Double.random(in: 0..<1) < p }

@inline(__always) func smoothstep(_ e0: Float, _ e1: Float, _ x: Float) -> Float {
    let t = clamp((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)
}

@inline(__always) func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
    let t = clamp((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)
}

// MARK: - Noise (the same functions as the web version, in doubles so the patterns match)

/// Deterministic hash noise in [0, 1) for a 2D point.
@inline(__always) func hash2(_ x: Double, _ y: Double) -> Double {
    let s = sin(x * 127.1 + y * 311.7) * 43758.5453
    return s - floor(s)
}

/// Smooth value noise in [0, 1].
@inline(__always) func noise2(_ x: Double, _ y: Double) -> Double {
    let xi = floor(x), yi = floor(y)
    let fx = x - xi, fy = y - yi
    let ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    let a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1)
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy)
}

/// Fractal noise, `octaves` layers of noise2.
func fbm2(_ x: Double, _ y: Double, _ octaves: Int = 4) -> Double {
    var v = 0.0, amp = 0.5, f = 1.0, sum = 0.0
    for i in 0..<octaves {
        v += noise2(x * f + Double(i) * 17.3, y * f + Double(i) * 9.1) * amp
        sum += amp
        amp *= 0.5
        f *= 2.03
    }
    return v / sum
}

// MARK: - Shader clock

/// The shader clock wraps hourly so float precision holds however long the app runs; every
/// animation frequency is quantised to a whole number of cycles per wrap so the wrap is invisible.
let timeWrap: Double = 3600

// MARK: - Transforms

func quat(_ angle: Float, _ axis: V3) -> simd_quatf { simd_quatf(angle: angle, axis: simd_normalize(axis)) }

/// The rotation taking unit vector `a` to unit vector `b`.
func quatFromTo(_ a: V3, _ b: V3) -> simd_quatf { simd_quatf(from: a.normalized, to: b.normalized) }

extension simd_float4x4 {
    init(translation t: V3) {
        self = matrix_identity_float4x4
        columns.3 = V4(t, 1)
    }

    init(scale s: V3) {
        self = simd_float4x4(diagonal: V4(s, 1))
    }

    /// A perspective projection for Metal's 0...1 clip depth. `fovY` in radians.
    init(perspectiveFovY fovY: Float, aspect: Float, near: Float, far: Float) {
        let ys = 1 / tan(fovY / 2), xs = ys / aspect, zs = far / (near - far)
        self.init(columns: (V4(xs, 0, 0, 0), V4(0, ys, 0, 0), V4(0, 0, zs, -1), V4(0, 0, zs * near, 0)))
    }

    /// A transform whose x, y, z axes are the given vectors, at `position`.
    init(basisX x: V3, y: V3, z: V3, position p: V3) {
        self.init(columns: (V4(x, 0), V4(y, 0), V4(z, 0), V4(p, 1)))
    }
}

extension CGSize {
    static func * (s: CGSize, k: CGFloat) -> CGSize { CGSize(width: s.width * k, height: s.height * k) }
}
