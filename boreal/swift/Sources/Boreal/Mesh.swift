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

    /// Transformed by an affine matrix; normals by its inverse transpose, as three.js does.
    func transformed(_ m: simd_float4x4) -> MeshData {
        var o = self
        o.positions = positions.map { let p = m * V4($0, 1); return V3(p.x, p.y, p.z) }
        let upper = simd_float3x3(V3(m.columns.0.x, m.columns.0.y, m.columns.0.z), V3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
                                  V3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
        let normalMatrix = upper.inverse.transpose
        o.normals = normals.map { (normalMatrix * $0).normalized }
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


extension MeshData {
    /// Smooth normals from the triangles around each vertex, area-weighted (three.js's
    /// `computeVertexNormals`). A triangle soup, where no vertex is shared, comes out faceted.
    mutating func computeVertexNormals() {
        var n = [V3](repeating: .zero, count: positions.count)
        for t in stride(from: 0, to: indices.count, by: 3) {
            let a = Int(indices[t]), b = Int(indices[t + 1]), c = Int(indices[t + 2])
            let f = (positions[c] - positions[b]).cross(positions[a] - positions[b])
            n[a] += f; n[b] += f; n[c] += f
        }
        normals = n.map { $0.normalized }
    }
}

extension Geometry {
    /// `PlaneGeometry` in the xy plane, facing +z, `sx` x `sy` segments.
    static func plane(_ width: Float, _ height: Float, _ sx: Int = 1, _ sy: Int = 1) -> MeshData {
        var m = MeshData()
        for iy in 0...sy {
            let y = Float(iy) * height / Float(sy) - height / 2
            for ix in 0...sx {
                let x = Float(ix) * width / Float(sx) - width / 2
                m.positions.append(V3(x, -y, 0))
                m.normals.append(V3(0, 0, 1))
                m.uvs.append(V2(Float(ix) / Float(sx), 1 - Float(iy) / Float(sy)))
            }
        }
        let row = UInt32(sx + 1)
        for iy in 0..<UInt32(sy) {
            for ix in 0..<UInt32(sx) {
                let a = ix + row * iy, b = ix + row * (iy + 1), c = ix + 1 + row * (iy + 1), d = ix + 1 + row * iy
                m.indices += [a, b, d, b, c, d]
            }
        }
        return m
    }

    /// `ConeGeometry`: a cylinder closing to a point at the top.
    static func cone(radius: Float, height: Float, radialSegments: Int) -> MeshData {
        cylinder(top: 0, bottom: radius, height: height, radialSegments: radialSegments)
    }

    /// `IcosahedronGeometry(radius, detail)`: each face subdivided, pushed out to the sphere, as a
    /// triangle soup with texture coordinates from the vertex's direction.
    static func icosahedron(radius: Float, detail: Int) -> MeshData {
        let t = (1 + Float(5).squareRoot()) / 2
        let v: [V3] = [V3(-1, t, 0), V3(1, t, 0), V3(-1, -t, 0), V3(1, -t, 0), V3(0, -1, t), V3(0, 1, t),
                       V3(0, -1, -t), V3(0, 1, -t), V3(t, 0, -1), V3(t, 0, 1), V3(-t, 0, -1), V3(-t, 0, 1)]
        let faces: [Int] = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
                            3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1]
        var m = MeshData()
        func push(_ p: V3) {
            let n = p.normalized
            m.positions.append(n * radius)
            m.normals.append(n)
            let u = atan2(n.z, -n.x) / TAU + 0.5
            let vv = atan2(-n.y, (n.x * n.x + n.z * n.z).squareRoot()) / .pi + 0.5
            m.uvs.append(V2(u, vv))
            m.indices.append(UInt32(m.positions.count - 1))
        }
        let cols = detail + 1
        for f in stride(from: 0, to: faces.count, by: 3) {
            let a = v[faces[f]], b = v[faces[f + 1]], c = v[faces[f + 2]]
            var g: [[V3]] = []
            for i in 0...cols {
                let aj = lerp(a, c, Float(i) / Float(cols)), bj = lerp(b, c, Float(i) / Float(cols))
                let rows = cols - i
                g.append((0...rows).map { j in (j == 0 && i == cols) ? aj : lerp(aj, bj, Float(j) / Float(max(rows, 1))) })
            }
            for i in 0..<cols {
                for j in 0..<(2 * (cols - i) - 1) {
                    let k = j / 2
                    if j % 2 == 0 { push(g[i][k + 1]); push(g[i + 1][k]); push(g[i][k]) }
                    else { push(g[i][k + 1]); push(g[i + 1][k + 1]); push(g[i + 1][k]) }
                }
            }
        }
        return m
    }

    /// `TubeGeometry` along a curve, with parallel-transported frames.
    static func tube(_ curve: Curve3, tubularSegments: Int, radius: Float, radialSegments: Int) -> MeshData {
        let frames = curve.frames(tubularSegments)
        var m = MeshData()
        for i in 0...tubularSegments {
            let p = curve.pointAt(Float(i) / Float(tubularSegments))
            let (n, b) = (frames.normals[i], frames.binormals[i])
            for j in 0...radialSegments {
                let a = Float(j) / Float(radialSegments) * TAU
                let dir = (n * -cos(a) + b * sin(a)).normalized
                m.positions.append(p + dir * radius)
                m.normals.append(dir)
                m.uvs.append(V2(Float(i) / Float(tubularSegments), Float(j) / Float(radialSegments)))
            }
        }
        let r = UInt32(radialSegments + 1)
        for j in 1...UInt32(tubularSegments) {
            for i in 1...UInt32(radialSegments) {
                let a = r * (j - 1) + (i - 1), b = r * j + (i - 1), c = r * j + i, d = r * (j - 1) + i
                m.indices += [a, b, d, b, c, d]
            }
        }
        return m
    }

    /// A flat polygon in the xy plane, fanned from its first point (it must be star-shaped from there).
    static func fan(_ outline: [V2]) -> MeshData {
        var m = MeshData()
        for p in outline {
            m.positions.append(V3(p.x, p.y, 0))
            m.normals.append(V3(0, 0, 1))
            m.uvs.append(p)
        }
        for i in 1..<(outline.count - 1) { m.indices += [0, UInt32(i), UInt32(i + 1)] }
        return m
    }
}

/// three.js's `CatmullRomCurve3`, open: "catmullrom" with a tension, or "centripetal" (three's
/// default), with arc-length parameterisation as `getPointAt` and `getSpacedPoints` do it.
struct Curve3 {
    enum Kind { case catmullrom(tension: Float), centripetal }
    let points: [V3]
    let kind: Kind
    private var lengths: [Float] = []

    init(_ points: [V3], kind: Kind = .centripetal) {
        self.points = points
        self.kind = kind
        let samples = 200
        var ls: [Float] = [0]
        var last = point(0)
        for i in 1...samples {
            let p = point(Float(i) / Float(samples))
            ls.append(ls[i - 1] + p.distance(to: last))
            last = p
        }
        lengths = ls
    }

    var length: Float { lengths.last ?? 0 }

    /// The point at parameter t (not arc length).
    func point(_ t: Float) -> V3 {
        let l = points.count
        let p = Float(l - 1) * t
        var i = Int(floor(p))
        var w = p - Float(i)
        if i >= l - 1 { i = l - 2; w = 1 }
        let p0 = i > 0 ? points[i - 1] : points[0] + (points[0] - points[1])
        let p1 = points[i], p2 = points[i + 1]
        let p3 = i + 2 < l ? points[i + 2] : points[l - 1] + (points[l - 1] - points[l - 2])
        var t0: V3, t1: V3
        switch kind {
        case .catmullrom(let tension):
            t0 = (p2 - p0) * tension
            t1 = (p3 - p1) * tension
        case .centripetal:
            var d0 = pow(p0.distance(to: p1), 0.5), d1 = pow(p1.distance(to: p2), 0.5), d2 = pow(p2.distance(to: p3), 0.5)
            if d1 < 1e-4 { d1 = 1 }
            if d0 < 1e-4 { d0 = d1 }
            if d2 < 1e-4 { d2 = d1 }
            let a0: V3 = (p1 - p0) / d0, b0: V3 = (p2 - p0) / (d0 + d1), c0: V3 = (p2 - p1) / d1
            let a1: V3 = (p2 - p1) / d1, b1: V3 = (p3 - p1) / (d1 + d2), c1: V3 = (p3 - p2) / d2
            t0 = (a0 - b0 + c0) * d1
            t1 = (a1 - b1 + c1) * d1
        }
        let c2 = -3 * p1 + 3 * p2 - 2 * t0 - t1, c3 = 2 * p1 - 2 * p2 + t0 + t1
        return p1 + t0 * w + c2 * (w * w) + c3 * (w * w * w)
    }

    /// Arc-length fraction u to the curve parameter t.
    func parameter(_ u: Float) -> Float {
        let n = lengths.count - 1
        let target = u * length
        var lo = 0, hi = n
        while lo <= hi {
            let mid = (lo + hi) / 2
            let cmp = lengths[mid] - target
            if cmp < 0 { lo = mid + 1 } else if cmp > 0 { hi = mid - 1 } else { hi = mid; break }
        }
        let i = max(0, hi)
        if i >= n || lengths[i] == target { return Float(i) / Float(n) }
        let f = (target - lengths[i]) / (lengths[i + 1] - lengths[i])
        return (Float(i) + f) / Float(n)
    }

    func pointAt(_ u: Float) -> V3 { point(parameter(u)) }

    func spacedPoints(_ divisions: Int) -> [V3] { (0...divisions).map { pointAt(Float($0) / Float(divisions)) } }

    func tangentAt(_ u: Float) -> V3 {
        let t = parameter(u), d: Float = 0.0001
        return (point(min(1, t + d)) - point(max(0, t - d))).normalized
    }

    /// Normals and binormals along the curve, transported without twisting (three.js's computeFrenetFrames).
    func frames(_ segments: Int) -> (normals: [V3], binormals: [V3]) {
        let tangents = (0...segments).map { tangentAt(Float($0) / Float(segments)) }
        let t0 = tangents[0]
        let ax = abs(t0.x), ay = abs(t0.y), az = abs(t0.z)
        let axis = ax <= ay && ax <= az ? V3(1, 0, 0) : (ay <= az ? V3(0, 1, 0) : V3(0, 0, 1))
        let v = t0.cross(axis).normalized
        var normals = [t0.cross(v)], binormals = [t0.cross(t0.cross(v))]
        for i in 1...segments {
            var n = normals[i - 1]
            let c = tangents[i - 1].cross(tangents[i])
            if c.length > 1e-6 {
                let theta = acos(clamp(tangents[i - 1].dot(tangents[i]), -1, 1))
                n = simd_quatf(angle: theta, axis: c.normalized).act(n)
            }
            normals.append(n)
            binormals.append(tangents[i].cross(n))
        }
        return (normals, binormals)
    }
}
