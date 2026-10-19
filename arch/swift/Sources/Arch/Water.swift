import Metal
import simd

// The water: a GPU wave simulation over the near lake (as in Loon Lake), the surface that reflects
// the walls, the arch and the sky and refracts the canyon floor beneath, and the floor itself.
//
// Lake Powell's water in a side canyon is still and clear by day; by night it is opaque within a
// metre or two, a black mirror for the canyon, the stars and the aurora.

/// The simulated patch of water: 48 m square in front of the viewer. Beyond it, ripples are drawn
/// analytically (they are only a few pixels tall out there anyway).
let simOrigin = V2(-24, -50)
let simExtent: Float = 48
let maxSplats = 48
let maxRings = 24

/// Is a world point inside the simulated patch (with a margin inside the edge)?
func inSim(_ x: Float, _ z: Float, margin: Float = 0.5) -> Bool {
    x > simOrigin.x + margin && x < simOrigin.x + simExtent - margin && z > simOrigin.y + margin && z < simOrigin.y + simExtent - margin
}

/// The canyon floor under the water: the land's own surface, never above the water (the bar
/// handles the shore).
func floorHeight(_ x: Float, _ z: Float) -> Float { min(groundHeight(x, z), -0.02) }

// MARK: - The wave simulation

/// The 2D wave equation on a float texture, ping-ponged each frame (as in Loon Lake). Disturbances
/// are "splats": soft dents the equation spreads into rings. Wave speed about 0.6 m/s, close to the
/// group speed of centimetre ripples; damped so a ring fades in ten seconds or so.
final class WaveSim {
    let size: Int
    private let dx: Float
    private let c: Float = 0.6
    private let dtFixed: Float = 1 / 60
    private var heights: [MTLTexture]
    private var cur = 0
    /// (slope x, slope z, height), filtered and mipmapped so far water averages many cells.
    let slopes: MTLTexture
    private var splats: [V4] = []
    private var steps = 0

    init(size: Int) {
        self.size = size
        dx = simExtent / Float(size)
        let dev = GPU.shared.device
        func texture(_ format: MTLPixelFormat, mips: Bool) -> MTLTexture {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: size, height: size, mipmapped: mips)
            d.usage = [.shaderRead, .shaderWrite]
            d.storageMode = .private
            return dev.makeTexture(descriptor: d)!
        }
        heights = [texture(.rg32Float, mips: false), texture(.rg32Float, mips: false)]
        slopes = texture(.rgba16Float, mips: true)
        // Start flat.
        if let cb = GPU.shared.queue.makeCommandBuffer(), let blit = cb.makeBlitCommandEncoder() {
            let zero = dev.makeBuffer(length: size * size * 16, options: .storageModePrivate)!
            blit.fill(buffer: zero, range: 0..<zero.length, value: 0)
            for t in heights + [slopes] {
                blit.copy(from: zero, sourceOffset: 0, sourceBytesPerRow: size * 8,
                          sourceBytesPerImage: size * size * 8, sourceSize: MTLSize(width: size, height: size, depth: 1),
                          to: t, destinationSlice: 0, destinationLevel: 0, destinationOrigin: MTLOrigin())
            }
            blit.endEncoding()
            cb.commit()
            cb.waitUntilCompleted()
        }
    }

    /// Press a dent into the water at world (x, z): `radius` in metres, `amount` in metres (negative
    /// is down). False if the point is outside the simulated patch.
    func splat(_ x: Float, _ z: Float, radius: Float, amount: Float) -> Bool {
        guard inSim(x, z, margin: 0.2) else { return false }
        if splats.count < maxSplats {
            splats.append(V4((x - simOrigin.x) / simExtent, (z - simOrigin.y) / simExtent, radius / simExtent, amount))
        }
        return true
    }

    /// Queue the water's advance by `dt`, in fixed sub-steps so the scheme stays stable.
    func advance(dt: Float) {
        steps += clamp(Int((dt / dtFixed).rounded()), 1, 4)
    }

    /// Encode the queued sub-steps (splats land on the first), then the slope map and its mipmaps.
    func encode(_ cb: MTLCommandBuffer) {
        let n = min(max(steps, 0), 4)
        steps = 0
        guard n > 0, let enc = cb.makeComputeCommandEncoder() else { splats.removeAll(); return }
        let gpu = GPU.shared
        let threads = MTLSize(width: 16, height: 16, depth: 1)
        let groups = MTLSize(width: (size + 15) / 16, height: (size + 15) / 16, depth: 1)
        let k = pow(c * dtFixed / dx, 2)
        var params = V4(k, 0.006, 0.06, 0)
        enc.setComputePipelineState(gpu.computePipeline("waveStep"))
        for s in 0..<n {
            params.w = Float(s == 0 ? splats.count : 0)
            var list = splats + [V4](repeating: .zero, count: maxSplats - splats.count)
            enc.setTexture(heights[cur], index: 0)
            enc.setTexture(heights[1 - cur], index: 1)
            enc.setBytes(&params, length: 16, index: 0)
            enc.setBytes(&list, length: maxSplats * 16, index: 1)
            enc.dispatchThreadgroups(groups, threadsPerThreadgroup: threads)
            cur = 1 - cur
        }
        splats.removeAll()
        var inv = V4(1 / (2 * dx), 0, 0, 0)
        enc.setComputePipelineState(gpu.computePipeline("waveSlopes"))
        enc.setTexture(heights[cur], index: 0)
        enc.setTexture(slopes, index: 1)
        enc.setBytes(&inv, length: 16, index: 0)
        enc.dispatchThreadgroups(groups, threadsPerThreadgroup: threads)
        enc.endEncoding()
        if let blit = cb.makeBlitCommandEncoder() {
            blit.generateMipmaps(for: slopes)
            blit.endEncoding()
        }
    }
}

// MARK: - Rings beyond the simulated patch

/// Analytic wave packets spreading from a point (a stone landing far out).
final class Rings {
    private(set) var list: [(x: Float, z: Float, amp: Float, t0: Double)] = []
    private var now: Double = 0

    func add(_ x: Float, _ z: Float, amp: Float, time: Double) {
        list.append((x, z, amp, time))
        if list.count > maxRings { list.removeFirst() }
    }

    func update(time: Double) {
        now = time
        list.removeAll { time - $0.t0 >= 30 }
    }

    /// (x, z, age, amplitude) per ring, for the shader.
    var uniforms: [V4] {
        (0..<maxRings).map { i in i < list.count ? V4(list[i].x, list[i].z, Float(now - list[i].t0), list[i].amp) : V4(0, 0, -1000, 0) }
    }
}

// MARK: - The surface

/// The water: a long strip filling the canyon (wider than it ever gets), that samples the reflection
/// (from the mirrored camera) and the refraction of the floor (with its depth), and the slope map
/// plus the breeze's cat's-paws, analytic rings and rain, then mixes them by Fresnel.
final class Water {
    private let mesh = Geometry.plane(900, 1400, 24, 96)
        .transformed(simd_float4x4(translation: V3(60, 0, -560)) * simd_float4x4(rotationX: -.pi / 2)).upload()

    /// `WaterParams` in the shaders: the mirror matrix, the sim patch and ring count, the rings.
    static let length = (16 + 4 + 4 * maxRings) * 4
    /// 0..1 (the shader reads it from the Frame; kept for the scene's bookkeeping).
    var rain: Float = 0

    func write(into buffer: MTLBuffer, mirror: simd_float4x4, rings: Rings, sim: WaveSim) {
        var floats: [Float] = []
        floats.reserveCapacity(Water.length / 4)
        for c in [mirror.columns.0, mirror.columns.1, mirror.columns.2, mirror.columns.3] { floats += [c.x, c.y, c.z, c.w] }
        floats += [simOrigin.x, simOrigin.y, simExtent, Float(rings.list.count)]
        for r in rings.uniforms { floats += [r.x, r.y, r.z, r.w] }
        floats.withUnsafeBytes { buffer.contents().copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
    }

    /// In the main pass only, where the reflection and refraction have been drawn.
    func draw(_ ctx: DrawContext, params: MTLBuffer, sim: WaveSim) {
        guard ctx.pass == .main, let reflection = ctx.reflection, let refraction = ctx.refraction, let depth = ctx.refractionDepth else { return }
        let e = ctx.encoder
        ctx.use("waterVertex", "waterFragment")
        e.setVertexBuffer(params, offset: 0, index: 2)
        e.setFragmentBuffer(params, offset: 0, index: 1)
        e.setFragmentTexture(reflection, index: 3)
        e.setFragmentTexture(refraction, index: 4)
        e.setFragmentTexture(depth, index: 5)
        e.setFragmentTexture(sim.slopes, index: 6)
        e.setFragmentSamplerState(GPU.shared.postSampler, index: 3)
        mesh.draw(e)
    }
}

// MARK: - The canyon floor

/// Sand sloping away from the bar into the deep, between the walls: the land's own surface below
/// the water, with ripple marks, algae in the warm shallows, pebbles, and the ripples' caustics
/// playing over it. Seen only through the water (the refraction pass).
final class Floor {
    private let mesh: GPUMesh

    init(sim: WaveSim) {
        let w: Float = 260, d: Float = 300
        var m = Geometry.plane(w, d, 130, 150).transformed(simd_float4x4(rotationX: -.pi / 2))
        for i in m.positions.indices {
            let x = m.positions[i].x + 40, z = m.positions[i].z - 130
            m.positions[i] = V3(x, min(floorHeight(x, z), -0.05), z)
        }
        m.computeVertexNormals()
        mesh = m.upload()
    }

    func draw(_ ctx: DrawContext, sim: WaveSim) {
        guard ctx.pass == .refraction else { return }
        let e = ctx.encoder
        ctx.use("floorVertex", "floorFragment")
        var p = V4(simOrigin.x, simOrigin.y, simExtent, 1 / Float(sim.size))
        e.setFragmentBytes(&p, length: 16, index: 1)
        e.setFragmentTexture(sim.slopes, index: 3)
        mesh.draw(e)
    }
}

extension Shaders {
    static let water = """

    // MARK: - The wave simulation

    /// One step of the 2D wave equation on the height field (r = now, g = before), with a little
    /// velocity damping and a touch of diffusion: the finest ripples die within a second, the broad
    /// rings of a stone last. P: x = (c dt / dx)^2, y = damping, z = smoothing, w = splat count.
    kernel void waveStep(texture2d<float, access::read> prev [[texture(0)]], texture2d<float, access::write> next [[texture(1)]],
                         constant float4& P [[buffer(0)]], constant float4* splats [[buffer(1)]],
                         uint2 gid [[thread_position_in_grid]]) {
        int n = int(prev.get_width());
        if (int(gid.x) >= n || int(gid.y) >= n) return;
        int2 g = int2(gid);
        float2 c = prev.read(gid).rg;
        float l = prev.read(uint2(max(g.x - 1, 0), g.y)).r, r = prev.read(uint2(min(g.x + 1, n - 1), g.y)).r;
        float d = prev.read(uint2(g.x, max(g.y - 1, 0))).r, u = prev.read(uint2(g.x, min(g.y + 1, n - 1))).r;
        float lap = l + r + d + u - 4.0 * c.r;
        float h = c.r + (c.r - c.g) * (1.0 - P.y) + P.x * lap + P.z * lap * 0.25;
        float2 vUv = (float2(gid) + 0.5) / float(n);
        // Dents pressed in this frame.
        int count = int(P.w);
        for (int i = 0; i < count; i++) {
            float4 s = splats[i];
            float2 dv = vUv - s.xy;
            float q2 = dot(dv, dv) / (s.z * s.z);
            if (q2 < 4.0) h += s.w * exp(-q2 * 2.0) * (1.0 - q2 * 0.25);
        }
        // Soak up waves near the edge of the patch so they do not reflect back from it.
        float2 e = min(vUv, 1.0 - vUv);
        float edge = smoothstep(0.0, 0.05, min(e.x, e.y));
        h *= mix(0.9, 1.0, edge);
        next.write(float4(h, c.r * mix(0.9, 1.0, edge), 0.0, 1.0), gid);
    }

    /// The heights into (slope x, slope z, height), which the surface reads filtered and mipmapped.
    kernel void waveSlopes(texture2d<float, access::read> hgt [[texture(0)]], texture2d<float, access::write> out [[texture(1)]],
                           constant float4& P [[buffer(0)]], uint2 gid [[thread_position_in_grid]]) {
        int n = int(hgt.get_width());
        if (int(gid.x) >= n || int(gid.y) >= n) return;
        int2 g = int2(gid);
        float l = hgt.read(uint2(max(g.x - 1, 0), g.y)).r, r = hgt.read(uint2(min(g.x + 1, n - 1), g.y)).r;
        float d = hgt.read(uint2(g.x, max(g.y - 1, 0))).r, u = hgt.read(uint2(g.x, min(g.y + 1, n - 1))).r;
        out.write(float4((r - l) * P.x, (u - d) * P.x, hgt.read(gid).r, 1.0), gid);
    }

    // MARK: - The surface

    #define RING_N \(maxRings)

    struct WaterParams {
        float4x4 mirror;        // world to the mirror camera's clip space (unclipped)
        float4 sim;             // xy = origin of the simulated patch, z = its extent, w = ring count
        float4 rings[RING_N];   // x, z, age, amplitude
    };

    struct WaterOut { float4 position [[position]]; float3 world; float4 mirror; float viewZ; };

    vertex WaterOut waterVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], constant WaterParams& W [[buffer(2)]]) {
        float4 wp = float4(verts[vid * 2].xyz, 1.0);
        WaterOut o;
        o.world = wp.xyz;
        o.mirror = W.mirror * wp;
        float4 mv = F.view * wp;
        o.viewZ = -mv.z;
        o.position = F.proj * mv;
        return o;
    }

    /// View-space z (negative in front) from a depth-buffer value, through the camera's own
    /// projection (Metal's 0...1 depth: d = (P22 z + P32) / -z).
    inline float viewZ(constant Frame& F, float d) {
        return -F.proj[3][2] / (d + F.proj[2][2]);
    }

    /// One analytic ring: a packet whose leading edge moves out at the group speed, widening and
    /// fading as it goes. Returns the slope along the radius.
    float ringSlope(float r, float age, float amp) {
        if (age < 0.0 || age > 30.0) return 0.0;
        float R = 0.55 * age;
        float w = 0.3 + 0.1 * R;
        float lam = 0.22 + 0.05 * R;
        float x = (r - R) / w;
        if (abs(x) > 3.0) return 0.0;
        float env = amp * exp(-x * x) / (1.0 + R * 0.6) * exp(-age * 0.08);
        float ph = (r - R) * 6.2831853 / lam;
        float dEnv = env * (-2.0 * x / w);
        return dEnv * cos(ph) - env * sin(ph) * 6.2831853 / lam;
    }

    /// Rain on the lake: in every cell of a 70 cm grid a drop lands at its own moment, and its ring
    /// spreads and dies within a second; the slope of the rings round a point.
    float2 rainSlope(float2 p, float t) {
        float2 s = float2(0.0);
        float cs = 0.7;
        float2 cell = floor(p / cs);
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
            float2 c = cell + float2(float(i), float(j));
            float h1 = hash21(c), h2 = hash21(c + 31.0);
            float period = 1.2 + h1 * 1.6;
            float age = fmodGL(t + h2 * period, period);
            if (age > 1.0) continue;
            float2 centre = (c + 0.5 + (hash22(c + 7.0) - 0.5) * 0.8) * cs;
            float2 dd = p - centre;
            float r = length(dd);
            float R = age * 0.9;
            float x = (r - R) / 0.06;
            if (abs(x) > 3.0) continue;
            float env = 0.004 * exp(-x * x) * (1.0 - age);
            float ph = (r - R) * 6.2831853 / 0.08;
            float sl = env * (-2.0 * x / 0.06) * cos(ph) - env * sin(ph) * 6.2831853 / 0.08;
            s += sl * dd / max(r, 1e-3);
        }
        return s;
    }

    fragment float4 waterFragment(WaterOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant WaterParams& W [[buffer(1)]],
                                  texture2d<float> reflection [[texture(3)]], texture2d<float> refraction [[texture(4)]],
                                  depth2d<float> refrDepth [[texture(5)]], texture2d<float> waves [[texture(6)]],
                                  sampler ws [[sampler(1)]], sampler ps [[sampler(3)]]) {
        float time = F.misc.x, rain = F.misc.w;
        float3 toEye = F.camera.xyz - in.world;
        float dist = length(toEye);
        float3 V = toEye / dist;
        float2 p = in.world.xz;

        // Slope of the surface, from every source.
        float2 slope = float2(0.0);
        float2 suv = (p - W.sim.xy) / W.sim.z;
        if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
            float2 e = min(suv, 1.0 - suv);
            float inside = smoothstep(0.0, 0.03, min(e.x, e.y));
            slope += waves.sample(ws, suv).xy * inside;
        }
        int ringCount = int(W.sim.w);
        for (int i = 0; i < ringCount; i++) {
            float4 rg = W.rings[i];
            float2 d = p - rg.xy;
            float r = length(d);
            float s = ringSlope(r, rg.z, rg.w);
            if (s != 0.0) slope += s * d / max(r, 1e-3);
        }
        // The breeze: a canyon's air moves in slow puffs, so the water is glassy with cat's-paws
        // drifting over it; the fine ripples fade out with distance where they would alias.
        float2 wdir = normalize(F.wind.xy + float2(1e-4, 0.0));
        float along = dot(p, wdir), across = dot(p, float2(-wdir.y, wdir.x));
        float paw = pow(fbm(float2(along * 0.04 - time * q(0.06), across * 0.06) + 3.1), 2.5) * 2.2;
        float detail = 1.0 / (1.0 + dist * 0.05);
        float fineAmp = F.wind.z * paw * detail * 0.04;
        if (fineAmp > 1e-5) {
            float t1 = time * q(1.3), t2 = time * q(0.8);
            float n1 = vnoise(float2(along * 9.0 - t1 * 2.6, across * 5.0) + 7.0);
            float2 r1 = float2(n1 - vnoise(float2(along * 9.0 - t1 * 2.6 + 0.07, across * 5.0) + 7.0),
                               n1 - vnoise(float2(along * 9.0 - t1 * 2.6, across * 5.0 + 0.07) + 7.0)) / 0.07;
            float n2 = vnoise(float2(along * 3.5 - t2 * 1.4, across * 2.4) + 19.0);
            float2 r2 = float2(n2 - vnoise(float2(along * 3.5 - t2 * 1.4 + 0.1, across * 2.4) + 19.0),
                               n2 - vnoise(float2(along * 3.5 - t2 * 1.4, across * 2.4 + 0.1) + 19.0)) / 0.1;
            float2 wind = (r1 * 0.6 + r2) * fineAmp;
            slope += float2(wind.x * wdir.x - wind.y * wdir.y, wind.x * wdir.y + wind.y * wdir.x);
        }
        if (rain > 0.001) slope += rainSlope(p, time) * rain / (1.0 + dist * 0.04);
        // A broad, very slow unevenness so the far water is never a perfect plane.
        slope += float2(vnoise(p * 0.1 + time * q(0.03)) - 0.5, vnoise(p.yx * 0.1 - time * q(0.025) + 5.0) - 0.5) * 0.008 * (0.3 + F.wind.z);
        float3 N = normalize(float3(-slope.x, 1.0, -slope.y));

        // Reflection of the canyon and the sky, bent by the ripples; the offset shrinks with distance.
        float2 mndc = in.mirror.xy / in.mirror.w;
        float2 muv = float2(mndc.x * 0.5 + 0.5, 0.5 - mndc.y * 0.5);
        float bend = clamp(1.0 / (1.0 + dist * 0.015), 0.05, 1.0);
        float2 ruv = clamp(muv + float2(N.x * 0.35, -N.z * 0.8) * bend, float2(0.001), float2(0.999));
        float3 refl = reflection.sample(ps, ruv).rgb;

        // What is under the surface, refracted, and how much water it is seen through.
        float2 suvScreen = in.position.xy / F.screen.xy;
        float2 fuv = clamp(suvScreen - float2(N.x * 0.25, -N.z * 0.5) * bend, float2(0.001), float2(0.999));
        float dRefr = -viewZ(F, refrDepth.sample(ps, fuv));
        if (dRefr < in.viewZ) {
            fuv = suvScreen;
            dRefr = -viewZ(F, refrDepth.sample(ps, fuv));
        }
        // Along the view ray: view-space depth scaled by the ray's length per unit depth.
        float column = max(dRefr - in.viewZ, 0.0) * (dist / in.viewZ);
        float3 under = refraction.sample(ps, fuv).rgb;
        // By night the lake is opaque within a metre or two. The light reaching the floor came down
        // through the water too (the floor is drawn as if in air), so the path counted is the way
        // down at the key light's slant plus the way back up to the eye.
        float3 absorb = float3(1.8, 1.4, 1.1);
        float depthV = column * max(V.y, 0.05);
        float3 trans = exp(-absorb * (column + depthV / max(F.keyDir.y, 0.3)));
        // What the water itself gives back at night: next to nothing.
        float3 deep = float3(0.006, 0.012, 0.016);
        float3 refr = under * trans + deep * (1.0 - trans);

        // Fresnel: glassy at a grazing angle, see-through looking down.
        float cosT = clamp(dot(V, N), 0.0, 1.0);
        float Fr = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        float3 col = mix(refr, refl, Fr);

        // Glitter: the moon's image broken up by the ripples, laying a path.
        float3 R = reflect(-V, N);
        float moonSpec = pow(max(dot(R, F.moonDir.xyz), 0.0), 1400.0);
        col += float3(0.9, 0.92, 1.0) * moonSpec * 14.0 * Fr;

        return float4(applyFog(F, col, dist), 1.0);
    }

    // MARK: - The canyon floor

    struct FloorOut { float4 position [[position]]; float3 world; float3 normal; };

    vertex FloorOut floorVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]], constant Frame& F [[buffer(1)]]) {
        FloorOut o;
        o.world = verts[vid * 2].xyz;
        o.normal = verts[vid * 2 + 1].xyz;
        o.position = F.viewProj * float4(o.world, 1.0);
        return o;
    }

    /// Pale sand with ripple marks, darker and finer where it is deeper.
    float3 floorColor(float2 p, float depth) {
        float n = fbm(p * 0.9) * 0.6 + fbm(p * 5.0) * 0.4;
        float ripple = sin(p.x * 6.0 + fbm(p * 0.4) * 6.0) * 0.5 + 0.5;
        float grain = hash21(floor(p * 300.0)) * 0.25 + 0.875;
        float3 sand = mix(float3(0.42, 0.36, 0.27), float3(0.32, 0.27, 0.2), n) * (0.92 + 0.12 * ripple) * grain;
        // Sand sliding off the walls' feet carries red grit; silt greys the deep floor.
        sand = mix(sand, float3(0.46, 0.4, 0.33), smoothstep(3.0, 12.0, depth));
        // Mats of filamentous algae in the warm shallows, bright green, in drifting clumps.
        float alg = smoothstep(0.52, 0.66, fbm(p * 0.35 + 7.0)) * smoothstep(0.4, 0.62, fbm(p * 2.2 + 3.0));
        alg *= sstep(9.0, 2.0, depth) * smoothstep(0.2, 1.0, depth);
        sand = mix(sand, float3(0.22, 0.4, 0.14) * (0.8 + 0.4 * fbm(p * 9.0)), alg * 0.85);
        // Scattered pebbles of darker rock.
        float2 g = p * 4.0; float2 cell = floor(g); float2 f = fract(g) - 0.5;
        float2 o = hash22(cell) - 0.5;
        float pb = sstep(0.22, 0.16, length(f - o * 0.6)) * step(0.6, hash21(cell + 3.0));
        sand = mix(sand, float3(0.38, 0.3, 0.24) * (0.7 + 0.6 * hash21(cell + 9.0)), pb * 0.8);
        return sand;
    }

    /// The floor as a standard material (roughness 0.95) taking the moon's shadow, with the sand and
    /// the caustics painted into its albedo.
    fragment float4 floorFragment(FloorOut in [[stage_in]], constant Frame& F [[buffer(0)]], constant float4& P [[buffer(1)]],
                                  depth2d<float> sunMap [[texture(1)]], depth2d<float> moonMap [[texture(2)]],
                                  texture2d<float> waves [[texture(3)]], sampler cs [[sampler(1)]], sampler cmp [[sampler(2)]]) {
        float2 p = in.world.xz;
        float3 col = floorColor(p, -in.world.y);
        // Caustics: the ripples focus the light where the surface is concave.
        float2 suv = (p - P.xy) / P.z;
        float caustic = 1.0;
        if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
            float tx = P.w * 2.0;
            float hc = waves.sample(cs, suv).z;
            float hl = waves.sample(cs, suv - float2(tx, 0.0)).z, hr = waves.sample(cs, suv + float2(tx, 0.0)).z;
            float hd = waves.sample(cs, suv - float2(0.0, tx)).z, hu = waves.sample(cs, suv + float2(0.0, tx)).z;
            caustic = clamp(1.0 - (hl + hr + hd + hu - 4.0 * hc) * 220.0, 0.75, 1.5);
        }
        float3 n = length_squared(in.normal) > 1e-12 ? normalize(in.normal) : float3(0.0, 1.0, 0.0);
        float2 shadow = keyShadows(F, sunMap, moonMap, cmp, in.world, n);
        float3 c = standardLight(F, col * caustic, n, in.world, 0.95, 0.0, shadow, geometryRoughness(n));
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    """
}
