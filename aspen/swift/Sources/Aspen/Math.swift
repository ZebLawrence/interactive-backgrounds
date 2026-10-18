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

extension SIMD2 where Scalar == Float {
    var length: Float { simd_length(self) }

    /// This vector, shortened if need be to at most `maxLength` (three.js's `clampLength(0, max)`).
    func clampedLength(_ maxLength: Float) -> V2 {
        let l = length
        return l > maxLength ? self * (maxLength / l) : self
    }
}

/// Roughly bell-shaped random in [-1, 1].
@inline(__always) func gauss() -> Float { (Float.random(in: 0..<1) + Float.random(in: 0..<1) + Float.random(in: 0..<1) - 1.5) / 1.5 }

/// The element of `a` at index `i`, wrapping either way (the web version's `cyc`).
@inline(__always) func cyc<T>(_ a: [T], _ i: Int) -> T { a[((i % a.count) + a.count) % a.count] }

extension simd_float4x4 {
    init(rotationX a: Float) {
        let c = cos(a), s = sin(a)
        self.init(columns: (V4(1, 0, 0, 0), V4(0, c, s, 0), V4(0, -s, c, 0), V4(0, 0, 0, 1)))
    }

    init(rotationY a: Float) {
        let c = cos(a), s = sin(a)
        self.init(columns: (V4(c, 0, -s, 0), V4(0, 1, 0, 0), V4(s, 0, c, 0), V4(0, 0, 0, 1)))
    }

    init(rotationZ a: Float) {
        let c = cos(a), s = sin(a)
        self.init(columns: (V4(c, s, 0, 0), V4(-s, c, 0, 0), V4(0, 0, 1, 0), V4(0, 0, 0, 1)))
    }

    /// three.js's `rotation.set(x, y, z)` with the default XYZ order.
    init(eulerXYZ e: V3) {
        self = simd_float4x4(rotationX: e.x) * simd_float4x4(rotationY: e.y) * simd_float4x4(rotationZ: e.z)
    }

    /// The view matrix of a camera at `eye` looking at `target` (as `Object3D.lookAt` turns a camera).
    init(lookAt eye: V3, target: V3, up: V3 = V3(0, 1, 0)) {
        let z = (eye - target).normalized
        let x = up.cross(z).normalized
        let y = z.cross(x)
        self = simd_float4x4(basisX: x, y: y, z: z, position: eye).inverse
    }

    /// An orthographic projection for Metal's 0...1 clip depth.
    init(orthoLeft l: Float, right r: Float, bottom b: Float, top t: Float, near n: Float, far f: Float) {
        self.init(columns: (V4(2 / (r - l), 0, 0, 0), V4(0, 2 / (t - b), 0, 0), V4(0, 0, -1 / (f - n), 0),
                            V4(-(r + l) / (r - l), -(t + b) / (t - b), -n / (f - n), 1)))
    }
}

// MARK: - Aspen Snow additions

/// A small seeded random generator (mulberry32, as the web version's `seeded`), for things that must
/// come out the same twice. `next()` is in [0, 1).
final class Seeded {
    private var a: UInt32

    init(_ seed: Int) { a = UInt32(truncatingIfNeeded: seed) }

    func next() -> Double {
        a = a &+ 0x6D2B_79F5
        var t = a
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double(t ^ (t >> 14)) / 4_294_967_296
    }

    /// Uniform in lo..<hi, as a Float.
    func r(_ lo: Float, _ hi: Float) -> Float { lo + Float(next()) * (hi - lo) }
    func callAsFunction() -> Float { Float(next()) }
}

/// Critically damped approach of `x` toward `target` with time constant `tau` seconds (the web version's `approach`).
@inline(__always) func approach(_ x: Float, _ target: Float, _ tau: Float, _ dt: Float) -> Float {
    target + (x - target) * exp(-dt / max(tau, 1e-4))
}

/// The shortest signed turn from angle `a` to angle `b` (the web version's `angleDiff(a, b)`; note the
/// argument order is the opposite of `angleDiff` above).
func angleTo(_ a: Float, _ b: Float) -> Float {
    var d = (b - a).truncatingRemainder(dividingBy: TAU)
    if d > .pi { d -= TAU }
    if d < -.pi { d += TAU }
    return d
}

@inline(__always) func pick<T>(_ a: [T]) -> T { a[Int.random(in: 0..<a.count)] }
