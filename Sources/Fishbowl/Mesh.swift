import CoreGraphics
import SceneKit
import simd

/// Minimal indexed triangle mesh that can be turned into an `SCNGeometry`.
struct Mesh {
    var positions: [V3] = []
    var normals: [V3] = []
    var uvs: [V2] = []
    /// Optional per-vertex colour (or packed per-vertex data for shaders).
    var colors: [SIMD4<Float>] = []
    var indices: [UInt32] = []

    /// Merge another mesh into this one, transforming its positions and normals.
    mutating func append(_ other: Mesh, transform t: simd_float4x4 = matrix_identity_float4x4) {
        let base = UInt32(positions.count)
        func xyz(_ v: SIMD4<Float>) -> V3 { V3(v.x, v.y, v.z) }
        positions += other.positions.map { xyz(t * SIMD4($0, 1)) }
        normals += other.normals.map { xyz(t * SIMD4($0, 0)).normalized }
        uvs += other.uvs
        colors += other.colors
        indices += other.indices.map { $0 + base }
    }

    mutating func triangle(_ a: Int, _ b: Int, _ c: Int) {
        indices += [UInt32(a), UInt32(b), UInt32(c)]
    }

    /// Smooth normals from the area-weighted face normals (counter-clockwise = front).
    mutating func computeNormals() {
        var n = [V3](repeating: .zero, count: positions.count)
        for i in stride(from: 0, to: indices.count, by: 3) {
            let a = Int(indices[i]), b = Int(indices[i + 1]), c = Int(indices[i + 2])
            let fn = simd_cross(positions[b] - positions[a], positions[c] - positions[a])
            n[a] += fn; n[b] += fn; n[c] += fn
        }
        normals = n.map { $0.length > 1e-8 ? $0.normalized : V3(0, 1, 0) }
    }

    func geometry() -> SCNGeometry {
        var sources = [
            SCNGeometrySource(vertices: positions.map { SCNVector3($0) }),
            SCNGeometrySource(normals: normals.map { SCNVector3($0) }),
        ]
        if !uvs.isEmpty {
            sources.append(SCNGeometrySource(textureCoordinates: uvs.map { CGPoint(x: CGFloat($0.x), y: CGFloat($0.y)) }))
        }
        if !colors.isEmpty {
            let data = colors.withUnsafeBufferPointer { Data(buffer: $0) }
            sources.append(SCNGeometrySource(data: data, semantic: .color, vectorCount: colors.count,
                                             usesFloatComponents: true, componentsPerVector: 4,
                                             bytesPerComponent: 4, dataOffset: 0, dataStride: 16))
        }
        return SCNGeometry(sources: sources, elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
    }

    // MARK: - Builders

    /// A flat rectangle in the XY plane (normal +Z), subdivided along X so it can bend.
    /// UVs map the rectangle onto `uv` (default: the whole image; image top = max Y).
    static func quad(_ r: CGRect, scale: Float, segments: Int = 1,
                     uv: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1)) -> Mesh {
        var m = Mesh()
        for i in 0...segments {
            let u = Float(i) / Float(segments)
            let x = Float(r.minX) + Float(r.width) * u
            for (v, y) in [(Float(0), Float(r.minY)), (Float(1), Float(r.maxY))] {
                m.positions.append(V3(x, y, 0) * scale)
                m.uvs.append(V2(Float(uv.minX) + u * Float(uv.width), Float(uv.minY) + (1 - v) * Float(uv.height)))
            }
        }
        for i in 0..<segments {
            let a = i * 2, b = a + 2, c = a + 1, d = a + 3
            m.triangle(a, b, c)
            m.triangle(b, d, c)
        }
        m.computeNormals()
        return m
    }

    /// Unit icosphere (radius 1) with the given number of subdivisions.
    static func icosphere(subdivisions: Int) -> Mesh {
        let t = Float((1 + 5.0.squareRoot()) / 2)
        var p: [V3] = [
            V3(-1, t, 0), V3(1, t, 0), V3(-1, -t, 0), V3(1, -t, 0),
            V3(0, -1, t), V3(0, 1, t), V3(0, -1, -t), V3(0, 1, -t),
            V3(t, 0, -1), V3(t, 0, 1), V3(-t, 0, -1), V3(-t, 0, 1),
        ].map(\.normalized)
        var faces: [(Int, Int, Int)] = [
            (0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
            (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
            (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
            (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1),
        ]
        for _ in 0..<subdivisions {
            var cache: [Int: Int] = [:]
            func mid(_ a: Int, _ b: Int) -> Int {
                let key = min(a, b) * 100_000 + max(a, b)
                if let i = cache[key] { return i }
                p.append(((p[a] + p[b]) * 0.5).normalized)
                cache[key] = p.count - 1
                return p.count - 1
            }
            var next: [(Int, Int, Int)] = []
            for (a, b, c) in faces {
                let ab = mid(a, b), bc = mid(b, c), ca = mid(c, a)
                next += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
            }
            faces = next
        }
        var m = Mesh()
        m.positions = p
        for (a, b, c) in faces { m.triangle(a, b, c) }
        m.computeNormals()
        return m
    }
}

extension simd_float4x4 {
    init(translation t: V3) {
        self = matrix_identity_float4x4
        columns.3 = SIMD4(t, 1)
    }
}

extension SCNVector3 {
    init(_ v: V3) { self.init(CGFloat(v.x), CGFloat(v.y), CGFloat(v.z)) }
}
