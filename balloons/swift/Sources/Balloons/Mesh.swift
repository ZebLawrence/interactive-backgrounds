import Metal
import simd

/// A mesh built on the CPU: positions, normals, texture coordinates (WebGL's convention, v up) and
/// triangles. The generators lay vertices out exactly as three.js's geometries do, so winding,
/// normals and texture coordinates match the web version.
struct MeshData {
    var positions: [V3] = []
    var normals: [V3] = []
    var uvs: [V2] = []
    var indices: [UInt32] = []

    mutating func append(_ o: MeshData) {
        let base = UInt32(positions.count)
        positions += o.positions
        normals += o.normals
        uvs += o.uvs
        indices += o.indices.map { $0 + base }
    }

    static func merged(_ parts: [MeshData]) -> MeshData {
        var m = MeshData()
        parts.forEach { m.append($0) }
        return m
    }

    /// Transformed by a rotation, uniform scale and translation.
    func transformed(_ m: simd_float4x4) -> MeshData {
        var o = self
        o.positions = positions.map { let p = m * V4($0, 1); return V3(p.x, p.y, p.z) }
        o.normals = normals.map { let n = m * V4($0, 0); return V3(n.x, n.y, n.z).normalized }
        return o
    }

    func translated(_ t: V3) -> MeshData { transformed(simd_float4x4(translation: t)) }

    /// Interleaved for the shaders: (position, u), (normal, v) per vertex.
    func upload() -> GPUMesh {
        var verts: [V4] = []
        verts.reserveCapacity(positions.count * 2)
        for i in positions.indices {
            let uv = i < uvs.count ? uvs[i] : .zero
            verts.append(V4(positions[i], uv.x))
            verts.append(V4(normals[i], uv.y))
        }
        return GPUMesh(vertices: GPU.shared.buffer(verts), indices: GPU.shared.buffer(indices), count: indices.count)
    }
}

/// A mesh on the GPU, drawn with its vertices in buffer 0.
struct GPUMesh {
    let vertices: MTLBuffer
    let indices: MTLBuffer
    let count: Int

    func draw(_ e: MTLRenderCommandEncoder) {
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: count, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
    }
}

/// three.js's geometry generators.
enum Geometry {
    /// `LatheGeometry`: a profile of (radius, height) points swept around the y axis.
    static func lathe(_ points: [V2], segments: Int) -> MeshData {
        // Profile normals, as three.js computes them: the perpendicular of each segment, averaged at joints.
        var initNormals: [V2] = []
        var prev = V2.zero
        for j in points.indices {
            if j == 0 {
                let d = points[1] - points[0]
                prev = V2(d.y, -d.x)
                initNormals.append(simd_normalize(prev))
            } else if j == points.count - 1 {
                initNormals.append(prev)
            } else {
                let d = points[j + 1] - points[j]
                let cur = V2(d.y, -d.x)
                initNormals.append(simd_normalize(cur + prev))
                prev = cur
            }
        }
        var m = MeshData()
        for i in 0...segments {
            let phi = Float(i) / Float(segments) * TAU
            let s = sin(phi), c = cos(phi)
            for (j, p) in points.enumerated() {
                m.positions.append(V3(p.x * s, p.y, p.x * c))
                m.uvs.append(V2(Float(i) / Float(segments), Float(j) / Float(points.count - 1)))
                let n = initNormals[j]
                m.normals.append(V3(n.x * s, n.y, n.x * c))
            }
        }
        let n = UInt32(points.count)
        for i in 0..<UInt32(segments) {
            for j in 0..<(n - 1) {
                let base = j + i * n
                let a = base, b = base + n, c = base + n + 1, d = base + 1
                m.indices += [a, b, d, c, d, b]
            }
        }
        return m
    }

    /// `TorusGeometry` in the xy plane.
    static func torus(radius: Float, tube: Float, radialSegments: Int, tubularSegments: Int) -> MeshData {
        var m = MeshData()
        for j in 0...radialSegments {
            for i in 0...tubularSegments {
                let u = Float(i) / Float(tubularSegments) * TAU
                let v = Float(j) / Float(radialSegments) * TAU
                let p = V3((radius + tube * cos(v)) * cos(u), (radius + tube * cos(v)) * sin(u), tube * sin(v))
                m.positions.append(p)
                m.normals.append((p - V3(radius * cos(u), radius * sin(u), 0)).normalized)
                m.uvs.append(V2(Float(i) / Float(tubularSegments), Float(j) / Float(radialSegments)))
            }
        }
        let row = UInt32(tubularSegments + 1)
        for j in 1...UInt32(radialSegments) {
            for i in 1...UInt32(tubularSegments) {
                let a = row * j + i - 1, b = row * (j - 1) + i - 1, c = row * (j - 1) + i, d = row * j + i
                m.indices += [a, b, d, b, c, d]
            }
        }
        return m
    }

    /// `CylinderGeometry`, centred on the origin along y, with caps.
    static func cylinder(top rt: Float, bottom rb: Float, height h: Float, radialSegments n: Int) -> MeshData {
        var m = MeshData()
        let half = h / 2, slope = (rb - rt) / h
        var grid: [[UInt32]] = []
        for y in 0...1 {
            let v = Float(y)
            let r = v * (rb - rt) + rt
            var row: [UInt32] = []
            for x in 0...n {
                let u = Float(x) / Float(n), theta = u * TAU
                m.positions.append(V3(r * sin(theta), -v * h + half, r * cos(theta)))
                m.normals.append(V3(sin(theta), slope, cos(theta)).normalized)
                m.uvs.append(V2(u, 1 - v))
                row.append(UInt32(m.positions.count - 1))
            }
            grid.append(row)
        }
        for x in 0..<n {
            let a = grid[0][x], b = grid[1][x], c = grid[1][x + 1], d = grid[0][x + 1]
            m.indices += [a, b, d, b, c, d]
        }
        for top in [true, false] {
            let sign: Float = top ? 1 : -1, r = top ? rt : rb
            let centreStart = UInt32(m.positions.count)
            for _ in 1...n {
                m.positions.append(V3(0, half * sign, 0))
                m.normals.append(V3(0, sign, 0))
                m.uvs.append(V2(0.5, 0.5))
            }
            let centreEnd = UInt32(m.positions.count)
            for x in 0...n {
                let theta = Float(x) / Float(n) * TAU
                m.positions.append(V3(r * sin(theta), half * sign, r * cos(theta)))
                m.normals.append(V3(0, sign, 0))
                m.uvs.append(V2(cos(theta) * 0.5 + 0.5, sin(theta) * 0.5 * sign + 0.5))
            }
            for x in 0..<UInt32(n) {
                let c = centreStart + x, i = centreEnd + x
                m.indices += top ? [i, i + 1, c] : [i + 1, i, c]
            }
        }
        return m
    }

    /// `BoxGeometry` with one segment per side; each face's uv runs 0...1.
    static func box(_ width: Float, _ height: Float, _ depth: Float) -> MeshData {
        var m = MeshData()
        // (u axis, v axis, w axis, udir, vdir, width, height, depth) per face, in three.js's order.
        let faces: [(Int, Int, Int, Float, Float, Float, Float, Float)] = [
            (2, 1, 0, -1, -1, depth, height, width),
            (2, 1, 0, 1, -1, depth, height, -width),
            (0, 2, 1, 1, 1, width, depth, height),
            (0, 2, 1, 1, -1, width, depth, -height),
            (0, 1, 2, 1, -1, width, height, depth),
            (0, 1, 2, -1, -1, width, height, -depth),
        ]
        for (u, v, w, udir, vdir, fw, fh, fd) in faces {
            let base = UInt32(m.positions.count)
            for iy in 0...1 {
                let y = Float(iy) * fh - fh / 2
                for ix in 0...1 {
                    let x = Float(ix) * fw - fw / 2
                    var p = V3.zero, n = V3.zero
                    p[u] = x * udir
                    p[v] = y * vdir
                    p[w] = fd / 2
                    n[w] = fd > 0 ? 1 : -1
                    m.positions.append(p)
                    m.normals.append(n)
                    m.uvs.append(V2(Float(ix), 1 - Float(iy)))
                }
            }
            let a = base, b = base + 2, c = base + 3, d = base + 1
            m.indices += [a, b, d, b, c, d]
        }
        return m
    }

    /// `CapsuleGeometry`: two hemispheres joined by a cylinder, as a lathe.
    static func capsule(radius r: Float, length: Float, capSegments: Int, radialSegments: Int) -> MeshData {
        var pts: [V2] = []
        let k = capSegments * 2
        for i in 0...k {
            let a = 1.5 * Float.pi + Float(i) / Float(k) * 0.5 * Float.pi
            pts.append(V2(max(r * cos(a), 0), -length / 2 + r * sin(a)))
        }
        for i in 0...k {
            let a = Float(i) / Float(k) * 0.5 * Float.pi
            pts.append(V2(max(r * cos(a), 0), length / 2 + r * sin(a)))
        }
        return lathe(pts, segments: radialSegments)
    }

    /// `SphereGeometry`.
    static func sphere(radius r: Float, widthSegments ws: Int, heightSegments hs: Int) -> MeshData {
        var m = MeshData()
        var grid: [[UInt32]] = []
        for iy in 0...hs {
            let v = Float(iy) / Float(hs)
            var row: [UInt32] = []
            for ix in 0...ws {
                let u = Float(ix) / Float(ws)
                let p = V3(-r * cos(u * TAU) * sin(v * .pi), r * cos(v * .pi), r * sin(u * TAU) * sin(v * .pi))
                m.positions.append(p)
                m.normals.append(p.normalized)
                m.uvs.append(V2(u, 1 - v))
                row.append(UInt32(m.positions.count - 1))
            }
            grid.append(row)
        }
        for iy in 0..<hs {
            for ix in 0..<ws {
                let a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1]
                if iy != 0 { m.indices += [a, b, d] }
                if iy != hs - 1 { m.indices += [b, c, d] }
            }
        }
        return m
    }

    /// A thin five-sided rod from `a` to `b`.
    static func rod(_ a: V3, _ b: V3, _ r: Float) -> MeshData {
        let len = a.distance(to: b)
        let g = cylinder(top: r, bottom: r, height: len, radialSegments: 5).translated(V3(0, len / 2, 0))
        return g.transformed(simd_float4x4(translation: a) * simd_float4x4(quatFromTo(V3(0, 1, 0), b - a)))
    }
}

/// three.js's `CatmullRomCurve3` (type "catmullrom"), open, in the plane: enough to resample the
/// envelope's profile evenly along its length as `getSpacedPoints` does.
struct CatmullRom {
    let points: [V2]
    let tension: Float

    func point(_ t: Float) -> V2 {
        let l = points.count
        let p = Float(l - 1) * t
        var i = Int(floor(p))
        var w = p - Float(i)
        if w == 0 && i == l - 1 {
            i = l - 2
            w = 1
        }
        let p0 = i > 0 ? points[i - 1] : points[0] + (points[0] - points[1])
        let p1 = points[i], p2 = points[i + 1]
        let p3 = i + 2 < l ? points[i + 2] : points[l - 1] + (points[l - 1] - points[l - 2])
        // Cubic with tangents tension x (next - previous) at each end.
        let t0 = (p2 - p0) * tension, t1 = (p3 - p1) * tension
        let c2 = -3 * p1 + 3 * p2 - 2 * t0 - t1, c3 = 2 * p1 - 2 * p2 + t0 + t1
        return p1 + t0 * w + c2 * (w * w) + c3 * (w * w * w)
    }

    /// `divisions + 1` points spaced evenly by arc length.
    func spacedPoints(_ divisions: Int) -> [V2] {
        let samples = 200
        var lengths: [Float] = [0]
        var last = point(0)
        for i in 1...samples {
            let p = point(Float(i) / Float(samples))
            lengths.append(lengths[i - 1] + simd_distance(p, last))
            last = p
        }
        let total = lengths[samples]
        return (0...divisions).map { d in
            let target = Float(d) / Float(divisions) * total
            var lo = 0, hi = samples
            while lo <= hi {
                let mid = (lo + hi) / 2
                let cmp = lengths[mid] - target
                if cmp < 0 { lo = mid + 1 } else if cmp > 0 { hi = mid - 1 } else { hi = mid; break }
            }
            let i = max(0, hi)
            if lengths[i] == target || i >= samples { return point(Float(i) / Float(samples)) }
            let f = (target - lengths[i]) / (lengths[i + 1] - lengths[i])
            return point((Float(i) + f) / Float(samples))
        }
    }
}
