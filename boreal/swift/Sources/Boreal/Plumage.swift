import Foundation
import Metal
import simd

// The great grey owl's plumage: its sculpted body, the thousands of overlapping contour feathers
// that give it a soft, ragged outline, the 12-feather tail, the plumage patterns and the moonlit
// rim.
//
// A great grey is mostly feathers (a bird of about a kilogram inside a coat that makes it look
// three times that), so its outline is never a clean curve: the contour feathers lie in
// overlapping rows like shingles, flowing down the body and back over the head from the face,
// each a vane with a dark shaft, fine barring and a slightly frayed edge, downy at its base.
// With the moon behind the owl that fringe catches the light and glows silver, the way backlit
// owls do in photographs.

/// A mesh whose vertices are `stride` float4s each (the vertex function knows the layout).
struct OwlMesh {
    let vertices: MTLBuffer
    let indices: MTLBuffer
    let count: Int

    init(_ verts: [V4], _ idx: [UInt32]) {
        vertices = GPU.shared.buffer(verts)
        indices = GPU.shared.buffer(idx)
        count = idx.count
    }

    func draw(_ e: MTLRenderCommandEncoder) {
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: count, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
    }
}

/// (position, u), (normal, v) per vertex: the layout of `MeshData.upload()`.
func owlStdMesh(_ m: MeshData) -> OwlMesh {
    var v: [V4] = []
    v.reserveCapacity(m.positions.count * 2)
    for i in m.positions.indices {
        let uv = i < m.uvs.count ? m.uvs[i] : .zero
        v += [V4(m.positions[i], uv.x), V4(m.normals[i], uv.y)]
    }
    return OwlMesh(v, m.indices)
}

// MARK: - The body, lofted from cross-sections

// The body, lofted from cross-sections measured off side and front views: a broad, rounded breast,
// a flatter back that slopes back toward the tail, the flanks narrower (the folded wings make
// them), and the big head sitting right down on the shoulders with no neck to see.

/// y (m above the feet): half-width, breast depth, back depth, and the spine's lean back.
private let sections: [[Float]] = [
    [0.0, 0.02, 0.02, 0.02, -0.02],
    [0.02, 0.07, 0.065, 0.055, -0.022],
    [0.06, 0.115, 0.11, 0.095, -0.022],
    [0.11, 0.14, 0.14, 0.105, -0.02],
    // The back is shallower than the breast: the folded wings lie over it and make its outline.
    [0.18, 0.152, 0.158, 0.092, -0.014],
    [0.25, 0.156, 0.166, 0.088, -0.008],
    [0.31, 0.15, 0.163, 0.088, -0.003],
    [0.36, 0.137, 0.148, 0.09, 0.0],
    [0.4, 0.118, 0.124, 0.09, 0.004],
    [0.435, 0.088, 0.09, 0.07, 0.006],
    [0.46, 0.045, 0.045, 0.04, 0.006],
    [0.47, 0.0, 0.0, 0.0, 0.006],
]
private let bodyTop: Float = 0.47

private func section(_ y: Float) -> (w: Float, f: Float, b: Float, zc: Float) {
    let S = sections
    var i = 0
    while i < S.count - 2 && S[i + 1][0] < y { i += 1 }
    let a = S[max(0, i - 1)], b = S[i], c = S[i + 1], d = S[min(S.count - 1, i + 2)]
    let t = clamp((y - b[0]) / (c[0] - b[0]), 0, 1)
    // Catmull-Rom through the table, column by column.
    func cr(_ k: Int) -> Float {
        let p0 = a[k], p1 = b[k], p2 = c[k], p3 = d[k]
        let t2 = t * t, t3 = t2 * t
        let q1 = 2 * p1 + (-p0 + p2) * t
        let q2 = (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        let q3 = (-p0 + 3 * p1 - 3 * p2 + p3) * t3
        return 0.5 * (q1 + q2 + q3)
    }
    return (max(0, cr(1)), max(0, cr(2)), max(0, cr(3)), cr(4))
}

/// A point on the body at height y and angle a (0 straight ahead).
func bodyPoint(_ y: Float, _ a: Float) -> V3 {
    let s = section(y)
    let n: Float = 2.3
    let sa = sin(a), ca = cos(a)
    func e(_ v: Float) -> Float { (v < 0 ? -1 : v > 0 ? 1 : 0) * pow(abs(v), 2 / n) }
    return V3(s.w * e(sa), y, s.zc + (ca > 0 ? s.f : s.b) * e(ca))
}

func bodyNormal(_ y: Float, _ a: Float) -> V3 {
    let h: Float = 0.002
    let dy = bodyPoint(min(bodyTop, y + h), a) - bodyPoint(max(0, y - h), a)
    let da = bodyPoint(y, a + 0.01) - bodyPoint(y, a - 0.01)
    var n = da.cross(dy).normalized
    // Make sure it points out.
    let p = bodyPoint(y, a)
    if n.dot(V3(p.x, 0, p.z - section(y).zc)) < 0 { n = -n }
    return n
}

func bodyGeometry() -> MeshData {
    let rows = 46, segs = 64
    var m = MeshData()
    for r in 0...rows {
        // Denser at the bottom and top, where the shape turns fastest.
        let u = Float(r) / Float(rows)
        let y = bodyTop * (0.5 - 0.5 * cos(u * .pi))
        for s in 0...segs { m.positions.append(bodyPoint(y, Float(s) / Float(segs) * TAU)) }
    }
    for r in 0..<rows {
        for s in 0..<segs {
            let a = UInt32(r * (segs + 1) + s), b = a + 1, c = a + UInt32(segs + 1), d = c + 1
            m.indices += [a, b, c, b, d, c]
        }
    }
    m.computeVertexNormals()
    return m
}

// MARK: - The head's shape

// The head's shape (shared by its mesh and its feathers): a big round head, a little wider than
// tall, the front flattened into the facial disc, dished in the middle, its rim standing proud.

let headR: Float = 0.135

func headShape(_ d: V3) -> V3 {
    let x = d.x * headR, y = d.y * headR, z = d.z * headR
    var nz = z * (z > 0 ? 0.5 : 0.85)
    if d.z > 0.4 {
        let rr = hypot(x, y) / 0.122
        nz -= 0.008 * max(0, 1 - rr * rr)
    }
    let k = (d.z - 0.43) / 0.06
    nz += 0.012 * exp(-(k * k))
    return V3(x, y * 0.9, nz)
}

private func headNormal(_ d: V3) -> V3 {
    var t1 = V3(0, 1, 0).cross(d)
    if t1.lengthSquared < 1e-6 { t1 = V3(1, 0, 0) }
    t1 = t1.normalized
    let t2 = d.cross(t1).normalized
    let h: Float = 0.01
    let pa = headShape((d + t1 * h).normalized) - headShape((d - t1 * h).normalized)
    let pb = headShape((d + t2 * h).normalized) - headShape((d - t2 * h).normalized)
    var n = pa.cross(pb).normalized
    if n.dot(headShape(d)) < 0 { n = -n }
    return n
}

// MARK: - Contour feathers

// Each a small card rooted just under the surface, flowing along it and lifted a little off it,
// curling back toward it at the tip. Per vertex, four float4s: (position, across -1..1),
// (normal, along 0..1), (where it grows, for its colour; random), (the surface normal there, for
// ruffling; part: 0 body, 1 crown, 2 disc rim).

private final class Cards {
    var verts: [V4] = []
    var idx: [UInt32] = []

    /// root, surface normal n, flow direction t (tangent), length, width, lift (rad), part, colour root.
    func add(_ root: V3, _ n: V3, _ t: V3, _ len: Float, _ wid: Float, _ lift: Float, _ part: Float, _ colourAt: V3, _ rnd: Float) {
        let b = n.cross(t).normalized
        let base = UInt32(verts.count / 4)
        func dir(_ k: Float) -> V3 { (t * cos(lift * (1 - 0.55 * k)) + n * sin(lift * (1 - 0.55 * k))).normalized }
        let start = root + n * -0.003
        let mid = start + dir(0.25) * (len * 0.5)
        let tip = mid + dir(0.75) * (len * 0.5)
        for (p, along) in [(start, Float(0)), (mid, 0.5), (tip, 1)] {
            let d = dir(along)
            var cn = b.cross(d).normalized
            if cn.dot(n) < 0 { cn = -cn }
            // Shade it half as the card and half as the surface, so the coat reads as one soft mass.
            let sn = lerp(cn, n, 0.5).normalized
            for across: Float in [-1, 1] {
                let q = p + b * (across * wid * 0.5 * (along == 0 ? 0.6 : 1))
                verts += [V4(q, across), V4(sn, along), V4(colourAt, rnd), V4(n, part)]
            }
        }
        for r in 0..<UInt32(2) {
            let a = base + r * 2, c = a + 2
            // Wound so the outer side is the front face.
            idx += [a, c, a + 1, a + 1, c, c + 1]
        }
    }

    func mesh() -> OwlMesh { OwlMesh(verts, idx) }
}

private func project(_ v: V3, _ n: V3) -> V3 { v - n * v.dot(n) }

/// The body's coat, about 1,800 feathers in overlapping rows.
func bodyCardsGeometry(seed: Int = 7) -> OwlMesh {
    let rng = Seeded(seed)
    let C = Cards()
    let dy: Float = 0.0125
    var row = 0
    var y: Float = 0.012
    while y < 0.425 {
        defer { y += dy; row += 1 }
        // How many fit round this row.
        var per: Float = 0
        var prev = bodyPoint(y, 0)
        for k in 1...48 {
            let p = bodyPoint(y, Float(k) / 48 * TAU)
            per += p.distance(to: prev)
            prev = p
        }
        let count = max(6, Int((per / 0.0165).rounded()))
        for k in 0..<count {
            let a = (Float(k) + Float(row % 2) * 0.5 + (rng() - 0.5) * 0.4) / Float(count) * TAU
            let yy = y + (rng() - 0.5) * dy * 0.5
            let p = bodyPoint(yy, a)
            let n = bodyNormal(yy, a)
            // Feathers flow down the body; near the top, back toward the tail.
            var t = project(V3(0, -1, -0.25), n)
            if t.lengthSquared < 1e-4 { t = project(V3(0, 0, -1), n) }
            t = t.normalized
            let side = abs(sin(a))
            let underWing = side > 0.72 && yy > 0.12 && yy < 0.38
            // The folded wing covers the flank there; feathers under it would only poke through.
            if side > 0.8 && yy > 0.15 && yy < 0.35 { continue }
            // The belly and vent are the fluffiest: long, loose feathers that hide the feet.
            let belly = smoothstep(0.15, 0.02, yy)
            // Up under the chin they lie flat and long, flowing down over the breast.
            let chin = smoothstep(0.34, 0.41, yy)
            let lift = underWing ? 0.08 : lerp(0.26 + 0.35 * belly + rng() * 0.1, 0.06, chin)
            let len = (0.036 + 0.022 * belly + 0.012 * chin) * (0.85 + rng() * 0.3)
            C.add(p, n, t, len, len * 0.72, lift, 0, p, rng())
        }
    }
    return C.mesh()
}

/// The crown and nape (flowing back from the face) and the ruff that frames the facial disc.
func headCardsGeometry(seed: Int = 11) -> OwlMesh {
    let rng = Seeded(seed)
    let C = Cards()
    let N = 1200
    let from = V3(0, -0.03, 0.25)
    for i in 0..<N {
        // Fibonacci points spread evenly over the sphere.
        let yv = 1 - (Float(i) + 0.5) / Float(N) * 2
        let r = (1 - yv * yv).squareRoot()
        let phi = Float(i) * 2.399963 + rng() * 0.2
        let d = V3(cos(phi) * r, yv, sin(phi) * r)
        if d.z > 0.4 || d.y < -0.9 { continue }
        let p = headShape(d)
        let n = headNormal(d)
        var t = project(p - from, n)
        if t.lengthSquared < 1e-6 { continue }
        t = t.normalized
        let len = (0.026 + 0.006 * smoothstep(0.0, -0.6, d.z)) * (0.85 + rng() * 0.3)
        C.add(p, n, t, len, len * 0.78, 0.2 + rng() * 0.12, 1, p, rng())
    }
    // The ruff: a ring of stiff, dark-tipped feathers standing up round the disc.
    let ring = 200
    for k in 0..<ring {
        let a = (Float(k) + rng() * 0.5) / Float(ring) * TAU
        let dz = 0.43 + (rng() - 0.5) * 0.03
        let rr = (1 - dz * dz).squareRoot()
        let d = V3(cos(a) * rr, sin(a) * rr, dz)
        let p = headShape(d)
        let n = headNormal(d)
        // Pointing outward round the face and forward.
        let out = V3(cos(a), sin(a) * 0.9, 0)
        let t = project(out * 0.8 + V3(0, 0, 0.35), n).normalized
        let len = 0.016 * (0.8 + rng() * 0.4)
        C.add(p, n, t, len, len * 0.7, 0.6, 2, p, rng())
    }
    return C.mesh()
}

// MARK: - The tail

/// 12 long feathers, the central pair on top, fanned by the owl to brake and steer. Per vertex:
/// (position, 0), (normal, 0), (across -1..1, along 0..1 root to tip, feather index 0..11, 0).
func tailFeathersGeometry() -> OwlMesh {
    var m = MeshData()
    var tail: [V3] = []
    let rows = 8
    for i in 0..<12 {
        let off = abs(Float(i) - 5.5) / 5.5
        let len = 0.28 - 0.03 * off * off
        let w: Float = 0.046
        let x0 = (Float(i) - 5.5) * 0.0055
        // The central feathers lie on top (the tail's upper side faces back).
        let z0 = -0.0022 * (5.5 - abs(Float(i) - 5.5)) - 0.01
        let base = UInt32(m.positions.count)
        for r in 0...rows {
            let t = Float(r) / Float(rows)
            for u: Float in [-1, 0, 1] {
                // A slight arch across the feather, the shaft standing up.
                m.positions.append(V3(x0 + u * w * 0.5, -t * len, z0 - (1 - u * u) * 0.002 + t * t * 0.02))
                tail.append(V3(u, t, Float(i)))
            }
        }
        for r in 0..<UInt32(rows) {
            for c in 0..<UInt32(2) {
                let a = base + r * 3 + c, b = a + 1, d = a + 3, e = d + 1
                m.indices += [a, d, b, b, d, e]
            }
        }
    }
    m.computeVertexNormals()
    var v: [V4] = []
    for i in m.positions.indices { v += [V4(m.positions[i], 0), V4(m.normals[i], 0), V4(tail[i], 0)] }
    return OwlMesh(v, m.indices)
}

// MARK: - Patterns shared by every part of the owl

extension Shaders {
    static let plumage = """

    // MARK: - The owl's plumage (plumage.js)

    /// Each owl's own look: tint.xyz an overall tint (cool ash grey to warm brownish), tint.w how
    /// strongly its markings stand out; misc.x how heavily its breast is streaked.
    struct OwlParams {
        float4x4 model;
        float4 tint;        // xyz tint, w contrast
        float4 misc;        // x breast streaks, y ruffle, z tail spread, w eyelid
        float4 iris;        // xyz the eye's colour
        float4 rim;         // x the moonlit rim at grazing angles, y light through thin vanes, z roughness
    };

    /// Rows of overlapping feathers: in each cell a rounded tip, shaded darker at its edge.
    float owlFeathers(float2 p, thread float& edge) {
        float2 g = p;
        g.x += step(1.0, fmodGL(floor(g.y), 2.0)) * 0.5;
        float2 c = floor(g), f = fract(g) - float2(0.5, 0.25);
        float d = length(f * float2(1.0, 1.4));
        edge = sstep(0.32, 0.55, d);
        return hash21(c);
    }

    /// The great grey's all-over vermiculation: fine, wavy, broken grey-brown bars.
    float owlVermic(float2 p) {
        float w = vnoise(p * float2(9.0, 3.0)) * 5.0;
        float bars = sin(p.y * 260.0 + w + vnoise(p * 60.0) * 2.0);
        return sstep(0.2, 0.9, bars) * (0.6 + 0.4 * vnoise(p * 80.0));
    }

    inline float3 owlLook(float3 c, float4 tint) { return max(mix(float3(0.45), c, tint.w) * tint.xyz, 0.0); }

    /// The body's colour at a point of the body (local metres).
    float3 owlBodyBase(float3 p, float streakK) {
        float ang = atan2(p.x, p.z);
        float front = cos(ang);
        // Pale ash grey below, a browner grey on the mantle.
        float3 c = mix(float3(0.44, 0.43, 0.41), float3(0.34, 0.32, 0.3), sstep(0.3, -0.7, front));
        c = mix(c, float3(0.5, 0.49, 0.47), sstep(0.2, 0.0, p.y) * 0.5);
        c *= 1.0 - 0.2 * owlVermic(float2(ang * 0.18 + vnoise(p.xy * 40.0) * 0.02, p.y + vnoise(float2(ang * 30.0, p.y * 20.0)) * 0.006));
        // Bold, blurred dark streaks down the breast.
        float streak = sstep(0.6, 0.82, vnoise(float2(ang * 16.0, p.y * 5.0 + 3.0))) * sstep(0.0, 0.6, front) * sstep(0.42, 0.22, p.y) * sstep(0.05, 0.15, p.y);
        c = mix(c, float3(0.16, 0.14, 0.13), clamp(streak * 0.7 * streakK, 0.0, 1.0));
        // A pale band across the shoulders (the scapulars' white edges).
        c = mix(c, float3(0.7, 0.69, 0.66), sstep(0.7, 0.85, vnoise(float2(ang * 14.0, p.y * 30.0))) * sstep(-0.2, -0.6, front) * sstep(0.3, 0.38, p.y) * 0.5);
        return c;
    }

    float3 owlCrownBase(float3 d, float y) {
        float ang = atan2(d.x, d.z);
        return float3(0.4, 0.39, 0.37) * (1.0 - 0.3 * owlVermic(float2(ang * 0.15, y)));
    }

    /// The owl's parts lit as three's MeshStandardMaterial lights them (the moon with its shadow,
    /// the hemisphere light), plus the aurora's fill and moonlight seen through and round the edge
    /// of feathers: with the moon behind the owl (as it is from where the viewer stands), its
    /// outline glows. Fogged.
    float3 owlShade(constant Frame& F, constant OwlParams& P, float3 albedo, float3 n, float3 world,
                    depth2d<float> sunMap, depth2d<float> moonMap, sampler cmp) {
        float2 sh = keyShadows(F, sunMap, moonMap, cmp, world, n);
        float3 c = standardLight(F, albedo, n, world, P.rim.z, 0.0, sh, geometryRoughness(n));
        c += albedo * F.aurora.xyz * 0.15;
        float3 V = normalize(F.camera.xyz - world);
        float back = max(dot(-V, F.moonDir.xyz), 0.0);
        float edge = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 2.5);
        c += albedo * float3(0.72, 0.8, 1.0) * F.misc.y * back * (edge * P.rim.x + P.rim.y);
        return applyFog(F, c, length(world - F.camera.xyz));
    }

    struct OwlOut { float4 position [[position]]; float3 world; float3 normal; float3 local; float4 a; float4 b; };

    OwlOut owlOut(constant Frame& F, constant OwlParams& P, float3 p, float3 n, float3 local, float4 a, float4 b) {
        float4 w = P.model * float4(p, 1.0);
        OwlOut o;
        o.world = w.xyz;
        o.normal = transformNormal(P.model, n);
        o.local = local;
        o.a = a;
        o.b = b;
        o.position = F.viewProj * w;
        return o;
    }

    inline float3 owlNormal(float3 n, bool front, bool doubleSided) {
        float3 m = length_squared(n) > 1e-12 ? normalize(n) : float3(0.0, 1.0, 0.0);
        return (doubleSided && !front) ? -m : m;
    }

    // MARK: Contour feather cards

    vertex OwlOut owlCardVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], constant OwlParams& P [[buffer(2)]]) {
        float4 v0 = verts[vid * 4], v1 = verts[vid * 4 + 1], v2 = verts[vid * 4 + 2], v3 = verts[vid * 4 + 3];
        float4 card = float4(v0.w, v1.w, v2.w, v3.w);
        // Ruffled or fluffed out, the feathers lift off the body; the cold breeze stirs them.
        float lift = card.y * card.y * (P.misc.y * 0.012 + 0.0016 * (0.5 + 0.5 * sin(F.misc.x * q(1.3) + card.z * 40.0)));
        float3 p = v0.xyz + v3.xyz * lift;
        return owlOut(F, P, p, v1.xyz, p, card, float4(v2.xyz, 0.0));
    }

    /// The feather's coverage (the vane: widest past the middle, a rounded tip, its edge a little
    /// frayed, the barbs parting near the tip, the base a wisp of down).
    float owlCardAlpha(float4 card) {
        float u = card.x, t = card.y, rndv = card.z;
        float k = (t - 0.52) / 0.54;
        float hw = sqrt(max(0.0, 1.0 - k * k));
        hw *= 0.8 + 0.2 * vnoise(float2(t * 26.0 + rndv * 50.0, u > 0.0 ? 1.0 : 7.0));
        float split = step(0.7, t) * step(fract((t + abs(u) * 0.7) * 16.0 + rndv * 9.0), 0.25 * sstep(0.7, 1.0, t));
        float fw = fwidthf(u) * 1.5 + 0.02;
        float a = (1.0 - sstep(hw - fw, hw + fw, abs(u))) * (1.0 - split);
        a *= mix(0.5 + 0.5 * vnoise(float2(u * 9.0, t * 30.0)), 1.0, sstep(0.1, 0.35, t));
        return a;
    }

    fragment float4 owlCardFragment(OwlOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                    constant OwlParams& P [[buffer(3)]], depth2d<float> sunMap [[texture(1)]],
                                    depth2d<float> moonMap [[texture(2)]], sampler cmp [[sampler(2)]]) {
        float u = in.a.x, t = in.a.y, rndv = in.a.z, part = in.a.w;
        float a = owlCardAlpha(in.a);
        if (a < 0.1) discard_fragment();
        // Without multisampling there is no alpha to coverage: cut at one half instead (Low Power).
        if (F.screen.w < 0.5) { if (a < 0.5) discard_fragment(); a = 1.0; }
        float3 root = in.b.xyz;
        float3 c = part < 0.5 ? owlBodyBase(root, P.misc.x) : part < 1.5 ? owlCrownBase(normalize(root), root.y) : float3(0.2, 0.18, 0.17);
        // The ruff is dark-tipped, except where the white bow tie crosses it under the chin.
        float tie = part > 1.5 ? sstep(0.05, 0.02, abs(root.x)) * step(root.y, -0.06) : 0.0;
        if (part > 1.5) c = mix(mix(c, float3(0.16, 0.14, 0.13), sstep(0.3, 0.9, t) * 0.7), float3(0.8, 0.79, 0.76), tie);
        c *= 0.88 + 0.24 * rndv;
        // Each feather's own fine bars, its dark shaft, a pale fringe at the tip, grey down below.
        float bars = sstep(0.3, 0.8, sin(t * 21.0 + abs(u) * 4.0 + rndv * 6.0) * 0.5 + 0.5);
        c *= 1.0 - 0.16 * bars;
        c = mix(c, c * 0.8, sstep(0.05, 0.0, abs(u)) * sstep(0.2, 0.5, t));
        c = mix(c, c * 1.2 + 0.03, sstep(0.8, 1.0, t) * 0.5);
        c = mix(c * 1.12, c, sstep(0.1, 0.4, t));
        float3 n = owlNormal(in.normal, front, true);
        return float4(owlShade(F, P, owlLook(c, P.tint), n, in.world, sunMap, moonMap, cmp), a);
    }

    // MARK: The tail

    vertex OwlOut owlTailVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], constant OwlParams& P [[buffer(2)]]) {
        float4 v0 = verts[vid * 3], v1 = verts[vid * 3 + 1], v2 = verts[vid * 3 + 2];
        // Fan out about the root.
        float th = (v2.z - 5.5) / 5.5 * P.misc.z;
        float cs = cos(th), sn = sin(th);
        float3 p = v0.xyz, n = v1.xyz;
        p.xy = float2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
        n.xy = float2(n.x * cs - n.y * sn, n.x * sn + n.y * cs);
        return owlOut(F, P, p, n, p, float4(v2.xyz, 0.0), float4(0.0));
    }

    float owlTailAlpha(float3 tl) {
        float u = tl.x, t = tl.y, id = tl.z;
        float k = (t - 0.86) / 0.14;
        float hw = t < 0.86 ? 1.0 : sqrt(max(0.0, 1.0 - k * k));
        hw *= 0.92 + 0.08 * vnoise(float2(t * 30.0, id * 7.0 + (u > 0.0 ? 3.0 : 0.0)));
        float fw = fwidthf(u) * 1.5 + 0.02;
        return 1.0 - sstep(hw - fw, hw + fw, abs(u));
    }

    fragment float4 owlTailFragment(OwlOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                    constant OwlParams& P [[buffer(3)]], depth2d<float> sunMap [[texture(1)]],
                                    depth2d<float> moonMap [[texture(2)]], sampler cmp [[sampler(2)]]) {
        float u = in.a.x, t = in.a.y, id = in.a.z;
        float a = owlTailAlpha(in.a.xyz);
        if (a < 0.1) discard_fragment();
        if (F.screen.w < 0.5) { if (a < 0.5) discard_fragment(); a = 1.0; }
        // Broad dark bands across the tail, mottled grey between, a dark shaft.
        float bands = sstep(0.35, 0.75, sin(t * 34.0 + vnoise(float2(u * 3.0, t * 12.0 + id)) * 1.5) * 0.5 + 0.5);
        float3 c = mix(float3(0.47, 0.45, 0.42), float3(0.24, 0.23, 0.21), bands * 0.7);
        c *= 1.0 - 0.22 * owlVermic(float2(u * 0.02 + id * 0.1, t * 0.3));
        c = mix(c, c * 0.6, sstep(0.08, 0.0, abs(u)));
        c *= 1.0 - sstep(0.75, 1.0, abs(u)) * 0.15;
        float3 n = owlNormal(in.normal, front, true);
        return float4(owlShade(F, P, owlLook(c, P.tint), n, in.world, sunMap, moonMap, cmp), a);
    }

    fragment void owlTailShadowFragment(OwlOut in [[stage_in]]) {
        if (owlTailAlpha(in.a.xyz) < 0.5) discard_fragment();
    }

    """
}
