import CoreGraphics
import simd

/// A sphere standing in for a piece of scenery when baking ambient occlusion.
struct Occluder {
    var center: V3
    var radius: Float
    /// Which piece it belongs to, so a piece doesn't darken itself.
    var piece: Int
}

/// Baked ambient occlusion ("contact shadows"). The scenery never moves, so this is computed once
/// when the tank is built and costs nothing per frame.
enum Occlusion {
    /// How much light reaches point `p` (surface normal `n`): 1 = fully open, lower = tucked in
    /// under or against nearby occluders.
    static func visibility(at p: V3, normal n: V3, occluders: [Occluder], ignoring piece: Int = -1,
                           strength: Float) -> Float {
        var vis: Float = 1
        for o in occluders where o.piece != piece {
            let d = o.center - p
            let d2 = simd_length_squared(d)
            let r2 = o.radius * o.radius
            if d2 > r2 * 16 { continue }
            let dist = d2.squareRoot()
            // Solid angle of the sphere, weighted toward occluders the surface faces
            // (softened so shadows still reach past the edge of a footprint).
            let facing = 0.35 + 0.65 * max(0, simd_dot(n, d / max(dist, 1e-4)))
            let occ = min(1, r2 / max(d2, r2 * 0.25)) * facing
            vis *= 1 - min(0.85, occ * strength)
        }
        return vis
    }

    /// A linear-grey image covering the floor rectangle x ∈ [minX, maxX], z ∈ [nearZ, farZ]
    /// (image top = near), darkened around every occluder's footprint.
    static func floorMap(minX: Float, maxX: Float, nearZ: Float, farZ: Float, width: Int,
                         floor: (Float, Float) -> Float, occluders: [Occluder]) -> CGImage {
        let height = max(1, Int(Float(width) * abs(farZ - nearZ) / (maxX - minX)))
        var vis = [Float](repeating: 1, count: width * height)
        let du = (maxX - minX) / Float(width), dv = (farZ - nearZ) / Float(height)
        for o in occluders {
            let reach = o.radius * 4
            let i0 = max(0, Int((o.center.x - reach - minX) / du)), i1 = min(width - 1, Int((o.center.x + reach - minX) / du))
            let jA = Int((o.center.z - reach - nearZ) / dv), jB = Int((o.center.z + reach - nearZ) / dv)
            let j0 = max(0, min(jA, jB)), j1 = min(height - 1, max(jA, jB))
            guard i0 <= i1, j0 <= j1 else { continue }
            let single = [o]
            for j in j0...j1 {
                let z = nearZ + (Float(j) + 0.5) * dv
                for i in i0...i1 {
                    let x = minX + (Float(i) + 0.5) * du
                    let p = V3(x, floor(x, z), z)
                    vis[j * width + i] *= visibility(at: p, normal: V3(0, 1, 0), occluders: single, strength: 1.3)
                }
            }
        }
        let bytes = vis.map { UInt8(clamp($0, 0, 1) * 255) }
        let space = CGColorSpace(name: CGColorSpace.linearGray)!
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                            space: space, bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        bytes.withUnsafeBytes { src in
            ctx.data!.copyMemory(from: src.baseAddress!, byteCount: bytes.count)
        }
        return ctx.makeImage()!
    }
}

@inline(__always) func smoothstep(_ e0: Float, _ e1: Float, _ x: Float) -> Float {
    let t = clamp((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)
}
