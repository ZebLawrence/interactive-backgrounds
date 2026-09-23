import CoreGraphics
import simd

/// Procedural normal maps (surface detail the lighting picks up without extra geometry).
/// Each is generated once from a tileable height field.
enum Detail {
    /// Sand: gentle ripple bars across the floor plus fine grain. Tiles every 2.5 world units.
    static let sand: CGImage = normalMap(size: 512, strength: 5) { u, v in
        let warp = fbm(u, v, period: 4, octaves: 3, seed: 3)
        // Ripples run across the view (crests parallel to the glass), bent by a slow warp.
        let phase = (v * 14 + warp * 1.6) * 2 * .pi
        let ripple = pow(0.5 + 0.5 * sin(phase), 1.6) * 0.6
        let grain = fbm(u, v, period: 64, octaves: 2, seed: 11) * 0.35
        return ripple + grain
    }

    /// Rock and coral: pitted, porous bumps. Projected onto the reef from three directions.
    static let rock: CGImage = normalMap(size: 256, strength: 7) { u, v in
        let bumps = fbm(u, v, period: 6, octaves: 4, seed: 5)
        // Pores of varying size: two scales of noise, so they don't line up in a grid.
        let pores = 0.6 * fbm(u, v, period: 24, octaves: 2, seed: 9) + 0.4 * fbm(u, v, period: 40, octaves: 1, seed: 13)
        return bumps - 0.5 * smoothstep(0.6, 0.78, pores)
    }

    /// Fish scales: overlapping domes in offset columns, anterior scales lying over the ones behind
    /// (u runs toward the head). 8 columns x 10 rows per tile.
    static let scales: CGImage = normalMap(size: 256, strength: 3) { u, v in
        let cols: Float = 8, rows: Float = 10
        let x = u * cols, y = v * rows
        var best: Float = -1, height: Float = 0
        let ci = floor(x)
        for dc in -1...1 {
            let c = ci + Float(dc)
            // Alternate columns are offset half a row, so scales nest.
            let offset: Float = Int(c).isMultiple(of: 2) ? 0 : 0.5
            let ri = floor(y - offset)
            for dr in -1...1 {
                let center = V2(c + 0.5, ri + Float(dr) + offset + 0.5)
                let d = simd_length((V2(x, y) - center) * V2(1, 0.8))
                // The scale nearest the head that covers this point is the one on top.
                if d < 0.85 && center.x > best {
                    best = center.x
                    height = 1 - (d / 0.85) * (d / 0.85)
                }
            }
        }
        return height
    }

    // MARK: - Building blocks

    /// Encode the slopes of a tileable height field `h(u, v)` (u, v in 0...1) as a tangent-space normal map.
    private static func normalMap(size n: Int, strength: Float, _ h: (Float, Float) -> Float) -> CGImage {
        var heights = [Float](repeating: 0, count: n * n)
        for j in 0..<n {
            for i in 0..<n { heights[j * n + i] = h(Float(i) / Float(n), Float(j) / Float(n)) }
        }
        var bytes = [UInt8](repeating: 255, count: n * n * 4)
        for j in 0..<n {
            for i in 0..<n {
                let l = heights[j * n + (i + n - 1) % n], r = heights[j * n + (i + 1) % n]
                let d = heights[((j + 1) % n) * n + i], u = heights[((j + n - 1) % n) * n + i]
                let nrm = simd_normalize(V3((l - r) * strength, (d - u) * strength, 1))
                let k = (j * n + i) * 4
                bytes[k] = UInt8(clamp((nrm.x * 0.5 + 0.5) * 255, 0, 255))
                bytes[k + 1] = UInt8(clamp((nrm.y * 0.5 + 0.5) * 255, 0, 255))
                bytes[k + 2] = UInt8(clamp((nrm.z * 0.5 + 0.5) * 255, 0, 255))
            }
        }
        // Normal data, not colour: stored without any gamma curve.
        let space = CGColorSpace(name: CGColorSpace.linearSRGB)!
        let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4, space: space,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        bytes.withUnsafeBytes { ctx.data!.copyMemory(from: $0.baseAddress!, byteCount: bytes.count) }
        return ctx.makeImage()!
    }

    /// Tileable value noise: lattice values repeat every `period` cells across the 0...1 square.
    private static func noise(_ u: Float, _ v: Float, period: Int, seed: UInt32) -> Float {
        let x = u * Float(period), y = v * Float(period)
        let xi = Int(floor(x)), yi = Int(floor(y))
        let fx = x - Float(xi), fy = y - Float(yi)
        func lattice(_ i: Int, _ j: Int) -> Float {
            var h = UInt32(truncatingIfNeeded: ((i % period) + period) % period) &* 374_761_393
            h = h &+ UInt32(truncatingIfNeeded: ((j % period) + period) % period) &* 668_265_263 &+ seed &* 2_147_483_647
            h = (h ^ (h >> 13)) &* 1_274_126_177
            return Float(h ^ (h >> 16)) / Float(UInt32.max)
        }
        let sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
        let a = lattice(xi, yi), b = lattice(xi + 1, yi), c = lattice(xi, yi + 1), d = lattice(xi + 1, yi + 1)
        return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
    }

    /// Fractal (multi-octave) tileable noise in roughly 0...1.
    private static func fbm(_ u: Float, _ v: Float, period: Int, octaves: Int, seed: UInt32) -> Float {
        var sum: Float = 0, amp: Float = 0.5, total: Float = 0, p = period
        for o in 0..<octaves {
            sum += noise(u, v, period: p, seed: seed &+ UInt32(o)) * amp
            total += amp
            amp *= 0.5
            p *= 2
        }
        return sum / total
    }
}
