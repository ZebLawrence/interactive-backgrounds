import CoreGraphics
import simd

typealias V3 = SIMD3<Float>
typealias V2 = SIMD2<Float>

extension SIMD3 where Scalar == Float {
    var length: Float { simd_length(self) }

    var normalized: V3 {
        let l = length
        return l > 1e-5 ? self / l : .zero
    }

    func limited(to maxLength: Float) -> V3 {
        let l = length
        return l > maxLength ? self * (maxLength / l) : self
    }
}

@inline(__always) func clamp<T: Comparable>(_ x: T, _ lo: T, _ hi: T) -> T { min(max(x, lo), hi) }

@inline(__always) func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }

@inline(__always) func rand(_ r: ClosedRange<CGFloat>) -> CGFloat { CGFloat.random(in: r) }

@inline(__always) func rnd(_ r: ClosedRange<Float>) -> Float { Float.random(in: r) }

/// Shortest signed difference between two angles.
@inline(__always) func angleDelta(_ a: Float, _ b: Float) -> Float {
    var d = a - b
    while d > .pi { d -= 2 * .pi }
    while d < -.pi { d += 2 * .pi }
    return d
}

extension CGSize {
    static func * (s: CGSize, k: CGFloat) -> CGSize { CGSize(width: s.width * k, height: s.height * k) }
}
