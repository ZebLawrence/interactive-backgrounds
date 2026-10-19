import Metal
import simd

// The aurora borealis: curtains of light with rays, folds and a substorm cycle.
//
// The real thing: electrons stream down the Earth's magnetic field lines and make the upper
// atmosphere glow in a thin, tall sheet. Atomic oxygen gives the green line (557.7 nm) from about
// 100 to 200 km up, and the faint red line (630 nm) above that; in bright displays molecular
// nitrogen adds a pink-purple fringe along the sharp lower edge, near 100 km. The sheet is only a
// kilometre or so thick but hundreds of kilometres long, so it looks brightest where we see it
// edge on, in its folds. Rays are the field lines lit up, near vertical at high latitude.
//
// A substorm runs through phases (Akasofu): a quiet arc that slowly brightens and drifts toward
// the equator (growth), a sudden brightening and break-up into rapidly moving, folded, rayed
// curtains with a westward travelling surge (expansion), then a fading into diffuse pulsating
// patches (recovery). Real growth phases last half an hour; here the cycle is compressed to a
// few minutes, and the motion is kept slow enough to be peaceful.
//
// The geometry is built at a tenth of real size (100 km up becomes 10 km) with the Earth's
// curvature, so the arcs bow down toward the horizon at their ends just as real ones do.

/// Scene metres per real kilometre.
let auroraKM: Float = 100
private let KM = auroraKM
private let earthR: Float = 6371 * KM
/// The 1D noise repeats after this many cells, so the phase accumulators can wrap.
private let noisePeriod: Float = 1024

private struct Phase {
    let i: Float, act: Float, pulse: Float, zScale: Float, rise: Float, dur: (Float, Float)
}

private enum PhaseName: String { case quiet, growth, expansion, recovery }

private let phases: [PhaseName: Phase] = [
    .quiet: Phase(i: 0.55, act: 0.12, pulse: 0, zScale: 1.0, rise: 20, dur: (150, 280)),
    .growth: Phase(i: 0.9, act: 0.28, pulse: 0, zScale: 0.92, rise: 25, dur: (60, 90)),
    .expansion: Phase(i: 1.45, act: 1.0, pulse: 0, zScale: 0.85, rise: 4, dur: (80, 120)),
    .recovery: Phase(i: 0.75, act: 0.35, pulse: 1, zScale: 0.95, rise: 10, dur: (100, 160)),
]
private let nextPhase: [PhaseName: PhaseName] = [.quiet: .growth, .growth: .expansion, .expansion: .recovery, .recovery: .quiet]

/// The curtain's per-draw parameters (`CurtainParams` in the shader).
private struct CurtainParams {
    var shape: V4      // z0, len, base, height
    var look: V4       // seed, gaps, i, act
    var pulse: V4      // x = pulse
    var fold: V4       // phases of the three fold scales
    var flow: V4       // ray noise phases (two scales), patch phase, pulsation phase
    var surge: V4      // x of the surge head (m), amplitude, width (m)
}

/// One curtain: a long vertical sheet whose path folds with time.
private final class Curtain {
    let z0: Float, len: Float, base: Float, height: Float, seed: Float, gain: Float, dir: Float, gaps: Float
    // Phase accumulators (radians or noise cells).
    var fold = [rnd(0, TAU), rnd(0, 100), rnd(0, 100)]
    var flow: [Float] = [rnd(0, 100), rnd(0, 100), rnd(0, 100), 0]
    var i: Float = 0.4
    var act: Float = 0.2
    var pulse: Float = 0
    var z: Float
    var surge = (x: Float(0), amp: Float(0), speed: Float(0))

    init(z0: Float, len: Float, base: Float, height: Float, seed: Float, gain: Float, dir: Float, gaps: Float = 0.15) {
        self.z0 = z0; self.len = len; self.base = base; self.height = height
        self.seed = seed; self.gain = gain; self.dir = dir; self.gaps = gaps
        z = z0
    }

    func update(dt: Float, target: Phase) {
        // Brightness rises fast at onset and fades slowly; everything else eases gently.
        let ti = target.i * gain
        i = approach(i, ti, ti > i ? target.rise : 14, dt)
        act = approach(act, target.act, 12, dt)
        pulse = approach(pulse, target.pulse, 20, dt)
        z = approach(z, z0 * target.zScale, 60, dt)
        // Motion: fold drift and ray flow speed up with activity (km/s real becomes slow arcs on screen).
        let a = act
        func wrap(_ x: Float, _ p: Float) -> Float { let m = x.truncatingRemainder(dividingBy: p); return m < 0 ? m + p : m }
        fold[0] = wrap(fold[0] + dt * (0.004 + 0.01 * a) * dir, TAU)
        fold[1] = wrap(fold[1] + dt * (0.006 + 0.03 * a) * dir, noisePeriod)
        fold[2] = wrap(fold[2] + dt * (0.01 + 0.08 * a * a), noisePeriod)
        flow[0] = wrap(flow[0] + dt * (0.03 + 0.25 * a) * dir, noisePeriod)
        flow[1] = wrap(flow[1] + dt * (0.05 + 0.4 * a * a), noisePeriod)
        flow[2] = wrap(flow[2] + dt * (0.004 + 0.012 * a), noisePeriod)
        flow[3] = wrap(flow[3] + dt * 0.7, TAU * 1000)
        // The surge head travels west (toward -x) and fades.
        if surge.amp > 0.001 {
            surge.x -= surge.speed * dt
            surge.amp *= exp(-dt / 50)
            if surge.x < -len / 2 { surge.amp = 0 }
        }
    }

    func startSurge(_ x: Float, _ amp: Float) {
        surge.x = x
        surge.amp = max(surge.amp, amp)
        // A westward travelling surge moves at a km or two per second; at a tenth scale that is
        // 100-200 m/s here, a slow glide across the sky from 200 km away.
        surge.speed = rnd(140, 220)
    }

    var params: CurtainParams {
        CurtainParams(shape: V4(z, len, base, height), look: V4(seed, gaps, i, act), pulse: V4(pulse, 0, 0, 0),
                      fold: V4(fold[0], fold[1], fold[2], 0), flow: V4(flow[0], flow[1], flow[2], flow[3]),
                      surge: V4(surge.x, surge.amp, 6 * KM * 10, 0))
    }
}

final class Aurora {
    private let curtains: [Curtain]
    private var phase: PhaseName
    private var timer: Float
    /// The light the aurora throws on the snow (linear RGB), and its overall level.
    private(set) var light = V3.zero
    /// A plane of 900 x 14 segments (three's PlaneGeometry), as (u, v) per vertex; the vertex shader
    /// lays it out along each curtain's path.
    private let vertices: MTLBuffer
    private let indices: MTLBuffer
    private let indexCount: Int

    init() {
        // Three arcs at 180, 330 and 520 km to the north, the nearest the brightest.
        curtains = [
            Curtain(z0: 180 * KM, len: 1600 * KM, base: 100 * KM, height: 170 * KM, seed: rnd(0, 50), gain: 1.0, dir: 1),
            Curtain(z0: 330 * KM, len: 2000 * KM, base: 102 * KM, height: 150 * KM, seed: rnd(0, 50), gain: 0.5, dir: -1, gaps: 0.45),
            Curtain(z0: 520 * KM, len: 2400 * KM, base: 98 * KM, height: 140 * KM, seed: rnd(0, 50), gain: 0.35, dir: 1, gaps: 0.55),
        ]
        phase = pick([.quiet, .quiet, .growth, .recovery])
        let d = phases[phase]!.dur
        timer = rnd(d.0, d.1) * rnd(0.3, 0.7)
        let sx = 900, sy = 14
        var uv: [V2] = []
        for iy in 0...sy {
            for ix in 0...sx { uv.append(V2(Float(ix) / Float(sx), 1 - Float(iy) / Float(sy))) }
        }
        var idx: [UInt32] = []
        let row = UInt32(sx + 1)
        for iy in 0..<UInt32(sy) {
            for ix in 0..<UInt32(sx) {
                let a = ix + row * iy, b = ix + row * (iy + 1), c = ix + 1 + row * (iy + 1), dd = ix + 1 + row * iy
                idx += [a, b, dd, b, c, dd]
            }
        }
        vertices = GPU.shared.buffer(uv)
        indices = GPU.shared.buffer(idx)
        indexCount = idx.count
    }

    var level: Float { curtains.reduce(0) { $0 + $1.i * $1.gain } }

    /// Jump to the break-up of a substorm.
    func substorm() {
        if phase == .expansion {
            timer += 40
            return
        }
        enter(.expansion)
    }

    private func enter(_ p: PhaseName) {
        phase = p
        let d = phases[p]!.dur
        timer = rnd(d.0, d.1)
        if p == .expansion {
            // The break-up starts near local midnight, roughly overhead in front of us, and surges west.
            curtains[0].startSurge(rnd(0, 300) * KM, 1.2)
            curtains[1].startSurge(rnd(100, 400) * KM, 0.8)
        }
    }

    /// A click in the sky: a bright surge starts on the nearest arc where `dir` (world direction)
    /// points, and runs off west along it.
    func flare(_ dir: V3) {
        if dir.y < 0.02 { return }
        var best: (c: Curtain, x: Float)?, bestD = Float.infinity
        for c in curtains {
            // Where the view ray reaches the curtain's mid height.
            let t = (c.base + c.height * 0.25) / dir.y
            let p = dir * t
            let d = abs(-p.z - c.z)
            if d < bestD { bestD = d; best = (c, p.x) }
        }
        guard let best else { return }
        best.c.startSurge(best.x, 1.0)
        best.c.i = max(best.c.i, 0.9)
        if phase == .quiet { timer = min(timer, 30) }
    }

    func update(dt: Float, camera: V3) {
        timer -= dt
        if timer <= 0 { enter(nextPhase[phase]!) }
        let target = phases[phase]!
        for c in curtains { c.update(dt: dt, target: target) }
        // The light the aurora throws on the snow: mostly green, a hint of purple when it's active.
        let act = curtains[0].act
        light = V3(0.08 + 0.12 * act, 1.0, 0.42 + 0.1 * act) * (min(level, 2.5) * 0.024)
    }

    /// Additive, depth-tested but not written, both faces, unfogged (as the web version's material).
    func draw(_ ctx: DrawContext) {
        guard !ctx.isShadow else { return }
        let e = ctx.encoder
        ctx.use("auroraVertex", "auroraFragment", blend: .additive)
        e.setVertexBuffer(vertices, offset: 0, index: 0)
        for c in curtains {
            var p = c.params
            e.setVertexBytes(&p, length: MemoryLayout<CurtainParams>.stride, index: 2)
            e.setFragmentBytes(&p, length: MemoryLayout<CurtainParams>.stride, index: 3)
            e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint32, indexBuffer: indices, indexBufferOffset: 0)
        }
    }

    var debugDescription: String { "\(phase.rawValue) (\(Int(timer)) s left)" }
}

extension Shaders {
    static let aurora = """

    // MARK: - The aurora

    struct CurtainParams { float4 shape; float4 look; float4 pulse; float4 fold; float4 flow; float4 surge; };
    struct AuroraOut { float4 position [[position]]; float x; float a; float graze; float elev; float ends; };

    inline float ah1(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
    /// Value noise that repeats every \(noisePeriod) cells, so its phase accumulators can wrap invisibly.
    inline float apn(float x) {
        float i = floor(x), f = fract(x); float u = f * f * (3.0 - 2.0 * f);
        return mix(ah1(fmodGL(i, \(noisePeriod))), ah1(fmodGL(i + 1.0, \(noisePeriod))), u);
    }

    /// The curtain's path in plan, z as a function of x: a broad meander, smaller folds, and tight
    /// folds and curls that grow with activity.
    inline float auroraPath(constant CurtainParams& P, float x) {
        float k = x / \(KM * 10);   // in units of 10 real km
        float seed = P.look.x, act = P.look.w;
        float z = \(KM * 16) * sin(k * 0.21 + P.fold.x + seed);
        z += (apn(k * 0.55 + P.fold.y + seed * 7.0) - 0.5) * \(KM * 12);
        z += (apn(k * 1.9 - P.fold.z + seed * 3.0) - 0.5) * \(KM * 16) * (0.25 + act);
        return P.shape.x + z;
    }

    vertex AuroraOut auroraVertex(uint vid [[vertex_id]], device const float2* uvs [[buffer(0)]],
                                  constant Frame& F [[buffer(1)]], constant CurtainParams& P [[buffer(2)]]) {
        float2 uv = uvs[vid];
        float u = uv.x, v = uv.y;
        float len = P.shape.y, height = P.shape.w, seed = P.look.x;
        float x = (u - 0.5) * len;
        float z = auroraPath(P, x);
        float dz = (auroraPath(P, x + 40.0) - auroraPath(P, x - 40.0)) / 80.0;
        // The lower edge wavers a little in height along the curtain.
        float base = P.shape.z + (apn(x / \(KM * 30) + seed * 5.0) - 0.5) * \(KM * 5);
        float a = (v - 0.04) * height;
        float3 p = float3(x, base + a, -z);
        // The Earth curves away: far parts of the arc sit lower.
        p.y -= (x * x + z * z) / \(2 * earthR);
        float3 n = normalize(float3(dz, 0.0, 1.0));
        float3 view = p - F.camera.xyz;
        float dist = length(view);
        // Seen edge on, the line of sight runs a long way through the thin sheet.
        float c = abs(dot(n, view / dist));
        AuroraOut o;
        o.graze = 1.0 / max(c, 0.09);
        o.x = x; o.a = a; o.ends = u;
        o.elev = view.y / dist;
        o.position = F.viewProj * float4(p, 1.0);
        return o;
    }

    fragment float4 auroraFragment(AuroraOut in [[stage_in]], constant CurtainParams& P [[buffer(3)]]) {
        float height = P.shape.w, seed = P.look.x, gaps = P.look.y, I0 = P.look.z, actBase = P.look.w, pulseK = P.pulse.x;
        float s = in.x / \(KM * 10);      // along the curtain, in tens of real km
        // Rays: fine vertical striations a few km wide that drift along the curtain.
        float r1 = apn(s * 3.1 + P.flow.x);
        float r2 = apn(s * 9.7 - P.flow.y + 31.0);
        float r3 = apn(s * 23.0 + P.flow.x * 1.7 + 77.0);
        float rays = r1 * r1 * 0.55 + r2 * r2 * r2 * 0.75 + r3 * r3 * 0.35 * actBase;
        // Each ray reaches its own height; active curtains reach higher.
        float reach = height * (0.25 + 0.5 * apn(s * 2.3 + P.flow.x * 0.5 + 13.0) + 0.2 * r2) * (0.6 + 0.55 * actBase);
        float a = in.a;
        float edge = smoothstep(-\(KM * 1.5), \(KM * 2.5), a);
        float fall = exp(-max(a, 0.0) / max(reach * 0.42, 1.0));
        float I = edge * fall * (0.35 + 1.4 * rays);
        // The lower border is the brightest part of a curtain: a band a few km deep.
        I += edge * exp(-max(a, 0.0) / \(KM * 9)) * (0.45 + 0.55 * r1);
        // Brighter and dimmer stretches along the arc; the far arcs break into pieces.
        float patchy = (0.35 - gaps * 0.35) + 0.9 * smoothstep(0.15 + gaps * 0.4, 0.75 + gaps * 0.2, apn(s * 0.18 + P.flow.z + seed * 11.0));
        // Recovery: diffuse patches that pulse on and off every several seconds.
        float cell = floor(s * 0.6 + seed);
        float pulse = 0.5 + 0.5 * sin(P.flow.w * (0.6 + ah1(cell) * 0.8) + ah1(cell + 5.0) * 6.2831);
        patchy *= mix(1.0, 0.25 + 1.1 * smoothstep(0.35, 0.8, pulse), pulseK);
        // The westward travelling surge: a bright, active head moving along the arc.
        float sd = (in.x - P.surge.x) / P.surge.z;
        float surge = P.surge.y * exp(-sd * sd);
        float act = clamp(actBase + surge * 0.6, 0.0, 1.0);
        I *= patchy * (1.0 + surge * 1.1);

        float frac = a / height;
        float3 green = float3(0.10, 1.0, 0.36);
        float3 red = float3(0.9, 0.08, 0.12);
        float3 purple = float3(0.95, 0.22, 0.78);
        float3 col = green * (1.0 - smoothstep(0.28, 0.75, frac));
        col += red * smoothstep(0.3, 0.85, frac) * 0.22;
        // The nitrogen fringe hugs the lower edge when the aurora is active.
        float fd = (a - \(KM * 2)) / \(KM * 3.5);
        col += purple * exp(-fd * fd) * act * act * 1.4;
        col *= I * I0;
        // Thin it near the very top of the sheet and at the ends of the arc.
        col *= 1.0 - smoothstep(0.8, 1.0, frac);
        col *= smoothstep(0.0, 0.12, in.ends) * sstep(1.0, 0.88, in.ends);
        // Low in the sky the light crosses more air: dimmer and a little warmer.
        float ext = smoothstep(-0.01, 0.16, in.elev);
        col *= ext * mix(float3(1.0, 0.8, 0.7), float3(1.0), ext);
        col *= min(in.graze, 12.0) * 0.14;
        return float4(col, 1.0);
    }

    """
}
