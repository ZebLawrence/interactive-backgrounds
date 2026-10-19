import Foundation
import Metal
import simd

// The craft: a silent lens-shaped hull, clad in panels of many sizes with inset gutters between
// them, a deep channel round its waist set with small round running lights, and a red eye forward
// sunk in a dish behind a raised bezel. It explores on its own: a slow circuit of the lake and the
// canyon beyond, out in front of the bridge, under the span and far up the canyon to the wall at
// its end, pausing at each station to turn and look at something, its eye throwing a red beam on
// whatever it studies. It looks at a resting cursor instead, flinches from a stone, and when
// clicked wakes its lights in a sweep and dips.

private enum CraftSize {
    static let length: Float = 27, height: Float = 16, width: Float = 22
    static var half: V3 { V3(length / 2, height / 2, width / 2) }
}

/// The eye's place on the hull, as a direction from the centre (forward-left, a little low).
private let eyeDir = V3(-0.9, -0.1, 0.45).normalized
/// The eye's bearing round the hull from the local +x axis: the yaw that aims the eye at a point.
private let eyeYaw = atan2(eyeDir.z, eyeDir.x)
/// The hull's relief, in fractions of the radius: the channel round the waist (in unit-sphere y),
/// the eye's dish and bezel (in radians from the eye's direction).
private enum Relief {
    static let channelHalf: Float = 0.075, channelDepth: Float = 0.04, eyeR: Float = 0.17
    static let dishDepth: Float = 0.035, bezelH: Float = 0.012, bezelW: Float = 0.025
}
private let lampCount = 16
/// The eye's azimuth round the waist, in the hull's unit-sphere terms, for keeping lamps off it.
private let eyeAz = atan2(eyeDir.z / (CraftSize.width / 2), eyeDir.x / (CraftSize.length / 2))

/// The circuit: stations in open water the craft moves between, each with something to look at
/// from there. Walked forward and back, so the far end takes it a couple of minutes to reach and
/// it comes back small out of the distance.
private let route: [(at: V3, look: V3)] = [
    (V3(46, 16, -156), V3(95, 22, -172)),     // its post under the right of the span: the abutment face
    (V3(12, 13, -152), V3(-30, 33, -151)),    // under the crown, looking up at the underside
    (V3(8, 18, -124), V3(-45, 26, -140)),     // out front, the lit buttress
    (V3(-22, 22, -118), V3(-48, 3, -105)),    // over the near lake, the beach
    (V3(15, 22, -220), V3(-75, 45, -300)),    // behind the span, the canyon's left wall
    (V3(-10, 30, -300), V3(62, 48, -330)),    // mid-canyon, the right wall
    (V3(20, 45, -400), V3(0, 72, -450)),      // the far wall
    (V3(-20, 60, -420), V3(10, 88, -450)),    // high under the far wall's rim
]
private let cruise: Float = 5.0

/// `CraftParams` in the shader.
private struct CraftParams {
    var model: simd_float4x4
    var rot: simd_float4x4        // the hull's rotation (uRot)
    var state: V4                 // x = wake, y = eye, z = rain
    var eyeDir: V4
}

/// The hull, built once: a 256 x 128 sphere stretched to the craft's size, the channel cut round
/// its waist, the eye's dish sunk forward behind a raised bezel.
private let hullMesh: GPUMesh = {
    var g = Geometry.sphere(radius: 1, widthSegments: 256, heightSegments: 128)
    let eyeQ = (eyeDir / CraftSize.half).normalized
    let R = Relief.eyeR
    for i in g.positions.indices {
        let q = g.positions[i]
        let flat: Float = q.y < 0 ? 0.9 : 1.0
        let ang = acos(clamp(q.dot(eyeQ), -1, 1))
        // The channel stops short of the eye and its bezel.
        let eyeZone = smoothstep(R + Relief.bezelW * 3, R + Relief.bezelW * 3 + 0.08, ang)
        let channel = -Relief.channelDepth * (1 - smoothstep(Relief.channelHalf - 0.02, Relief.channelHalf, abs(q.y))) * eyeZone
        let dish = -Relief.dishDepth * clamp(1 - (ang / R) * (ang / R), 0, 1)
        let bezel = Relief.bezelH * exp(-pow((ang - R - Relief.bezelW) / Relief.bezelW, 2))
        let f = 1 + channel + dish + bezel
        g.positions[i] = V3(q.x * CraftSize.length / 2 * f, q.y * CraftSize.height / 2 * flat * f, q.z * CraftSize.width / 2 * f)
    }
    g.computeVertexNormals()
    return g.upload()
}()

final class Craft {
    private(set) var pos = route[0].at
    /// The hull's transform (the web version's group).
    let root = Node("craft")
    /// The waist lamps and the red eye as point lights (world position, linear colour x intensity,
    /// range), as the web version's PointLights (0xffa040 and 0xff2010, decay 1.6).
    private(set) var lamp = (pos: V3.zero, color: V3.zero, range: Float(80))
    private(set) var eye = (pos: V3.zero, color: V3.zero, range: Float(50))

    private var vel = V3.zero
    private var yaw: Float = -0.3
    private var yawVel: Float = 0
    private var roll: Float = 0
    private var pitch: Float = 0
    private var wake: Float = 0
    private var eyeGlow: Float = 0
    private var drift = V3.zero
    private var driftTimer = rnd(10, 30)
    private var rain: Float = 0
    // Exploring: the station it is at or heading for, which way along the circuit it is going, and
    // how long it will dwell where it is.
    private var station = 0
    private var direction = 1
    private var dwell = rnd(6, 12)
    private var lookAt = route[0].look
    private var studying = false
    // Rain: when the next drip leaves the rim, and the drips in the air with when they land.
    private var dripTimer: Float = 0
    private var drips: [(t: Double, x: Float, z: Float)] = []
    private static let lampColor = RGBA(hex: "#ffa040").linear
    private static let eyeColor = RGBA(hex: "#ff2010").linear
    /// The eye light sits a little proud of the eye.
    private static let eyeLocal = eyeDir * CraftSize.half * 1.1

    init(scene: Arch) {
        _ = hullMesh
        place(time: 0)
    }

    /// Something hit the water near it, or a stone came its way: a flinch and a flare of the lights.
    func startle(_ from: V3, _ strength: Float) {
        var away = pos - from
        away.y = 0
        vel += away.normalized * (1.5 * strength)
        vel.y += 1.0 * strength
        wake = min(1, wake + 0.8 * strength)
    }

    /// Clicked: the lights sweep, it dips and rises, and the eye brightens.
    func rouse() {
        wake = 1
        vel.y -= 2.5
        yawVel += rnd(-0.3, 0.3)
        eyeGlow = 1
    }

    func update(dt: Float, scene: Arch) {
        let t = scene.renderTime
        let stop = route[station]
        // Exploring: cruise to the next station, slowing on approach; dwell there a while, turned to
        // its point of interest; then move on, mostly the way it was going, reversing at the ends.
        let toGoal = stop.at - pos
        let dist = toGoal.length
        var desired = V3.zero
        if dwell > 0 {
            dwell -= dt
            if dwell <= 0 {
                if station + direction < 0 || station + direction >= route.count || chance(0.12) { direction = -direction }
                station = clamp(station + direction, 0, route.count - 1)
            }
        } else if dist < 5 {
            dwell = rnd(7, 16)
        } else {
            desired = toGoal * (min(cruise, dist * 0.35) / dist)
        }
        // A slow drift that changes its mind every half minute, on top.
        driftTimer -= dt
        if driftTimer <= 0 {
            driftTimer = rnd(15, 40)
            drift = V3(rnd(-1, 1), rnd(-0.3, 0.3), rnd(-0.6, 0.6)) * 0.4
        }
        vel += (desired + drift - vel) * (0.45 * dt)
        pos += vel * dt
        // Looking: at a resting cursor above all; else, dwelling, at the station's point of
        // interest; else ahead along its way. The eye glows and its beam shines while it studies.
        var look: V3?
        studying = false
        let c = scene.cursor
        if c.present && c.stillTime > 1.0 {
            let (origin, dir) = scene.ray(c.screen)
            look = scene.rockHit(c.screen, maxDist: 700)?.point ?? origin + dir * 200
            studying = true
        }
        if look == nil && dwell > 0 {
            look = stop.look
            studying = true
        }
        let target = look ?? (vel.lengthSquared > 0.5 ? pos + vel.normalized * 80 : stop.look)
        eyeGlow = approach(eyeGlow, studying ? 1 : 0.15, studying ? 1.2 : 2.5, dt)
        lookAt = lerp(lookAt, target, min(1, dt * 1.5))
        // Turn so the eye itself, not the nose, bears on the look; tilt so its gaze rises or falls to it.
        let toLook = lookAt - pos
        let wantYaw = eyeYaw - atan2(toLook.z, toLook.x)
        let gaze: Float = studying ? clamp(-(atan2(toLook.y, hypot(toLook.x, toLook.z)) + 0.1), -0.5, 0.5) : 0
        var d = wantYaw - yaw
        d = atan2(sin(d), cos(d))
        yawVel += (d * 0.4 - yawVel * 0.8) * dt
        yaw += yawVel * dt
        roll = lerp(roll, clamp(-yawVel * 0.4, -0.15, 0.15) + sin(t * 0.37) * 0.02, min(1, dt * 2))
        pitch = lerp(pitch, clamp(vel.y * 0.05, -0.1, 0.1) + sin(t * 0.23) * 0.015 + gaze, min(1, dt * 2))
        wake = max(0, wake - dt * 0.35)
        place(time: t)

        // The beam shines straight out of the eye, wherever the hull has it pointing just now, so it
        // sweeps with the hull as it turns and lands only where the eye looks. The rock draws it from
        // the eye's place and direction (the photograph fixes the rock's brightness, so no scene
        // light can brighten it).
        let m = root.localMatrix
        let eyePos = transformPoint(m, Craft.eyeLocal)
        let beamDir = root.quaternion.act(eyeDir).normalized
        let on = max(0, eyeGlow - 0.15) / 0.85
        // Where the beam first strikes rock, so it lights nothing beyond.
        let hit = on > 0.01 ? scene.rockRay(eyePos, beamDir, maxDist: 700) : nil
        var L = scene.rockLights
        L.beam = V4(eyePos, on)
        L.beamDir = beamDir
        L.beamReach = hit?.dist ?? 700
        L.lamp = V4(pos, 1 + wake * 1.5)
        L.craftMatrix = m
        L.lampRing = V2(CraftSize.length / 2 * (1 - Relief.channelDepth), CraftSize.width / 2 * (1 - Relief.channelDepth))
        L.lampEye = eyeAz
        scene.rockLights = L
        lamp = (transformPoint(m, V3(0, -0.4, 0)), Craft.lampColor * (50 + 80 * wake), 80)
        eye = (eyePos, Craft.eyeColor * (25 + 45 * eyeGlow), 50)

        // Rain: the film running off the dome gathers at the channel's lip and drips from it, each
        // drop falling to the lake and ringing the water where it lands.
        rain = scene.rain
        if rain > 0.15 {
            dripTimer -= dt
            if dripTimer <= 0 {
                dripTimer = rnd(0.04, 0.16) / rain
                let a = rnd(0, TAU)
                let local = V3(cos(a) * CraftSize.length / 2, -Relief.channelHalf * CraftSize.height / 2, sin(a) * CraftSize.width / 2)
                let p = transformPoint(m, local)
                let out = root.quaternion.act(V3(local.x / CraftSize.length, 0, local.z / CraftSize.width).normalized)
                scene.drops.p.append(Puffs.Particle(pos: p, vel: out * rnd(0.3, 1.0) + vel * 0.5, age: 0, life: 4, size: rnd(0.07, 0.12)))
                drips.append((scene.clock + Double((2 * max(p.y, 0.1) / 9.81).squareRoot()), p.x + out.x, p.z + out.z))
            }
        }
        while let first = drips.first, first.t <= scene.clock {
            drips.removeFirst()
            scene.disturb(first.x, first.z, radius: 0.14, amount: -0.005, ring: 0)
        }
    }

    /// The hull's place: the bob (a breath, four seconds, a metre) on top of where it is, turned by
    /// its yaw, then pitch (about the local z), then roll (about the local x).
    private func place(time t: Float) {
        let bob = sin(t * 2 * .pi / 4.2) * 0.5 + sin(t * 2 * .pi / 11) * 0.3
        root.position = pos + V3(0, bob, 0)
        root.quaternion = quatAxis(yaw, 0, 1, 0) * quatAxis(pitch, 0, 0, 1) * quatAxis(roll, 1, 0, 0)
    }

    private func transformPoint(_ m: simd_float4x4, _ p: V3) -> V3 {
        let w = m * V4(p, 1)
        return V3(w.x, w.y, w.z)
    }

    /// In the main pass, the reflection, and the moon's shadow pass (it casts; it takes no shadow).
    func draw(_ ctx: DrawContext) {
        guard ctx.shows(.surface) else { return }
        let m = root.localMatrix
        let r = simd_float4x4(root.quaternion)
        var p = CraftParams(model: m, rot: r, state: V4(wake, eyeGlow, rain, 0), eyeDir: V4(eyeDir, 0))
        let e = ctx.encoder
        ctx.use("craftVertex", "craftFragment")
        e.setVertexBytes(&p, length: MemoryLayout<CraftParams>.stride, index: 2)
        e.setFragmentBytes(&p, length: MemoryLayout<CraftParams>.stride, index: 3)
        hullMesh.draw(e)
    }

    var debugDescription: String {
        String(format: "at (%.1f, %.1f, %.1f) station %d %@ %.1f s, yaw %.2f, eye %.2f, wake %.2f", pos.x, pos.y, pos.z, station,
               dwell > 0 ? "dwelling" : "cruising", max(dwell, 0), yaw, eyeGlow, wake)
    }
}

private func f(_ x: Float) -> String { String(format: "%.4f", x) }

extension Shaders {
    static let craft = """

    // MARK: - The craft

    struct CraftParams { float4x4 model; float4x4 rot; float4 state; float4 eyeDir; };
    struct CraftOut { float4 position [[position]]; float3 world; float3 local; float3 lnormal; };

    vertex CraftOut craftVertex(uint vid [[vertex_id]], device const float4* verts [[buffer(0)]],
                                constant Frame& F [[buffer(1)]], constant CraftParams& P [[buffer(2)]]) {
        float4 a = verts[vid * 2], b = verts[vid * 2 + 1];
        float4 w = P.model * float4(a.xyz, 1.0);
        CraftOut o;
        o.world = w.xyz;
        o.local = a.xyz;
        o.lnormal = b.xyz;
        o.position = F.viewProj * w;
        return o;
    }

    constant float3 CRAFT_HALF = float3(\(f(CraftSize.length / 2)), \(f(CraftSize.height / 2)), \(f(CraftSize.width / 2)));
    constant float CRAFT_PI = 3.141592653589793;

    /// The hull in unit-sphere terms: longitude round it, and y up it (-1 at the keel, 1 on top).
    inline float3 craftSphere(float3 p) { return normalize(p / CRAFT_HALF); }
    /// Where the waist channel is (1 inside).
    inline float craftChannel(float qy) { return 1.0 - smoothstep(\(f(Relief.channelHalf - 0.02)), \(f(Relief.channelHalf)), abs(qy)); }
    /// The angle from the eye's centre (radians).
    inline float craftEyeAngle(float3 q, float3 eyeDir) { return acos(clamp(dot(q, normalize(eyeDir / CRAFT_HALF)), -1.0, 1.0)); }
    /// Outside the eye and its bezel (1), so the channel and the cladding stop short of them.
    inline float craftEyeZone(float3 q, float3 eyeDir) {
        return smoothstep(\(f(Relief.eyeR + Relief.bezelW * 3)), \(f(Relief.eyeR + Relief.bezelW * 3 + 0.08)), craftEyeAngle(q, eyeDir));
    }

    /// The cladding: rows of panels up the hull, each row's cells split at random into one to three
    /// panels across and one or two up, so no two neighbours match; a gutter between every panel,
    /// and a hatch outlined inside some. Returns the height of the skin (0 in a gutter, 1 on a
    /// panel) and the panel's id.
    float craftPanels(float3 q, float lon, thread float& id, thread float& hatch, thread float& below) {
        float v = abs(q.y), side = step(0.0, q.y);
        // Row edges up the dome, and how many cells round each row.
        float e0 = \(f(Relief.channelHalf)), e1 = 0.38, e2 = 0.72, e3 = 0.93;
        float r, t0, t1, cols;
        if (v < e1) { r = 0.0; t0 = e0; t1 = e1; cols = 14.0; }
        else if (v < e2) { r = 1.0; t0 = e1; t1 = e2; cols = 10.0; }
        else if (v < e3) { r = 2.0; t0 = e2; t1 = e3; cols = 6.0; }
        else { r = 3.0; t0 = e3; t1 = 1.02; cols = 1.0; }
        float stagger = hash11(r * 7.0 + side * 3.0) * 0.5;
        float cu = lon * cols + stagger;
        float c = floor(cu);
        float2 cell = float2(c, r * 2.0 + side);
        float h1 = hash21(cell), h2 = hash21(cell + 17.0);
        float ns = 1.0 + floor(h1 * 2.999), nr = 1.0 + floor(h2 * 1.999);
        if (r == 3.0) { ns = 1.0; nr = 1.0; }
        float su = fract(cu) * ns, sv = (v - t0) / (t1 - t0) * nr;
        float2 sub = float2(floor(su), floor(sv));
        id = hash21(cell * 3.0 + sub + 5.0);
        // How far down its panel a point is, 0 at the gutter above it, 1 at the one below.
        below = q.y >= 0.0 ? 1.0 - fract(sv) : fract(sv);
        // Distances to the nearest gutter, in metres: round the hull the cell's width shrinks
        // toward the poles; up it the row's height is a share of the half height.
        float ring = 2.0 * CRAFT_PI * (CRAFT_HALF.x + CRAFT_HALF.z) * 0.5 * sqrt(max(1.0 - q.y * q.y, 0.0));
        float wU = ring / cols / ns, wV = (t1 - t0) / nr * CRAFT_HALF.y * 1.3;
        float dU = min(fract(su), 1.0 - fract(su)) * wU, dV = min(fract(sv), 1.0 - fract(sv)) * wV;
        float d = min(dU, dV);
        if (r == 3.0) d = (1.0 - v) * CRAFT_HALF.y * 2.0;
        // A hatch: a smaller rectangle outlined inside some panels.
        hatch = 0.0;
        if (hash21(cell * 5.0 + sub + 9.0) > 0.84 && wU > 1.6 && wV > 1.6) {
            float iu = abs(fract(su) - 0.5) * wU, iv = abs(fract(sv) - 0.5) * wV;
            float hw = wU * 0.3, hh = wV * 0.28;
            float dh = max(iu - hw, iv - hh);
            hatch = 1.0 - smoothstep(0.0, 0.1, abs(dh));
            d = min(d, abs(dh) + 0.05);
        }
        // The gutter: 14 cm wide, the panel edge rounding over 30 cm beyond it.
        return smoothstep(0.07, 0.35, d);
    }

    /// Rain on the dome: the film running down the meridians in rivulets.
    inline float craftRainFilm(float3 q, float lon, float time) { return pow(fbm(float2(lon * 70.0, q.y * 9.0 + time * 0.7)), 3.0); }

    /// A ring where each drop strikes, spreading and dying in half a second, and the film.
    float craftRainHeight(float3 q, float lon, float time) {
        float upper = smoothstep(0.05, 0.3, q.y);
        if (upper <= 0.0) return 0.0;
        float2 uv = float2(lon * 48.0, q.y * 14.0);
        float2 cell = floor(uv);
        float h1 = hash21(cell + 3.0), h2 = hash21(cell + 29.0);
        float period = 0.8 + h1 * 1.4;
        float age = fmodGL(time + h2 * period, period) / 0.6;
        float ring = 0.0;
        if (age < 1.0) {
            float2 c = cell + 0.5 + (hash22(cell + 11.0) - 0.5) * 0.6;
            float2 dd = (uv - c) * float2(1.8, 0.75);
            float r = length(dd), R = age * 0.45;
            float x = (r - R) / 0.07;
            ring = exp(-x * x) * (1.0 - age) * 0.01;
        }
        return (ring + craftRainFilm(q, lon, time) * 0.012) * upper;
    }

    /// The skin's height in metres at a local point, for the bump.
    float craftSkinHeight(float3 p, float3 eyeDir, float rain, float time) {
        float3 q = craftSphere(p);
        float lon = atan2(q.z, q.x) / (2.0 * CRAFT_PI) + 0.5;
        float id, hatch, below;
        float h = craftPanels(q, lon, id, hatch, below) * 0.06;
        if (rain > 0.001) h += craftRainHeight(q, lon, time) * rain;
        h *= 1.0 - craftChannel(q.y) * craftEyeZone(q, eyeDir);
        return h;
    }

    fragment float4 craftFragment(CraftOut in [[stage_in]], bool front [[front_facing]], constant Frame& F [[buffer(0)]],
                                  constant CraftParams& P [[buffer(3)]]) {
        float time = F.misc.x;
        float wake = P.state.x, eyeOn = P.state.y, rain = P.state.z;
        float3 eyeDir = P.eyeDir.xyz;
        float3 p = in.local;
        float3 sq = craftSphere(p);
        float lon = atan2(sq.z, sq.x) / (2.0 * CRAFT_PI) + 0.5;
        float3 fw = abs(dfdx(in.world)) + abs(dfdy(in.world));
        float px = length(fw);

        // --- The normal: the gutters as relief, the skin's height differenced along the hull's
        // two directions (round it and up it), in the hull's own frame, then turned into the world.
        float3 nl = length_squared(in.lnormal) > 1e-12 ? normalize(in.lnormal) : float3(0.0, 1.0, 0.0);
        float3 lonDir = float3(-p.z, 0.0, p.x);
        // At the poles there is no "round": any direction across will do.
        float3 tLon = length_squared(lonDir) > 1e-8 ? normalize(lonDir) : float3(1.0, 0.0, 0.0);
        float3 tLatRaw = cross(nl, tLon);
        float3 tLat = length_squared(tLatRaw) > 1e-8 ? normalize(tLatRaw) : float3(0.0, 0.0, 1.0);
        float e = max(0.04, px * 1.5);
        float h0 = craftSkinHeight(p, eyeDir, rain, time);
        float gu = (craftSkinHeight(p + tLon * e, eyeDir, rain, time) - h0) / e;
        float gv = (craftSkinHeight(p + tLat * e, eyeDir, rain, time) - h0) / e;
        float3 nb = normalize(nl - tLon * gu - tLat * gv);
        float3 n = normalize(float3x3(P.rot[0].xyz, P.rot[1].xyz, P.rot[2].xyz) * nb);
        if (!front) n = -n;

        // --- The colour.
        float id, hatch, below;
        float skin = craftPanels(sq, lon, id, hatch, below);
        // Dull titanium-white cladding, streaked and stained, a shade warmer below, each panel its own shade.
        float2 uv = float2(lon * 40.0, sq.y * 8.0);
        float3 col = mix(float3(0.8, 0.8, 0.78), float3(0.62, 0.6, 0.58), fbm(uv * 1.5 + 3.0) * 0.8);
        col *= 0.9 + 0.2 * fbm(uv * 7.0);
        // Not every panel came from the same batch: most a shade apart, some replaced with a
        // darker, a browner or a bluer one.
        col *= 0.84 + 0.22 * id;
        if (id < 0.09) col *= float3(0.55, 0.55, 0.57);
        else if (id < 0.16) col *= float3(0.78, 0.66, 0.52);
        else if (id < 0.22) col *= float3(0.8, 0.86, 0.95);
        // Worn through in patches to the dull metal under the paint, worst near the gutters.
        float worn = smoothstep(0.5, 0.75, fbm(uv * 2.5 + 11.0)) * (1.0 - skin * 0.5);
        col = mix(col, float3(0.48, 0.45, 0.43), worn * 0.8);
        // Rust: streaks run down from the gutter above each panel, from the hatches and from the
        // channel's lower lip, narrow and uneven.
        float streak = pow(fbm(float2(lon * 110.0 + 7.0, sq.y * 2.5)), 2.6) * 2.2;
        float rust = streak * sstep(0.85, 0.0, below) * 0.9;
        rust += streak * sstep(0.3, 0.0, -sq.y - \(f(Relief.channelHalf))) * step(sq.y, 0.0) * 0.8;
        rust += hatch * 0.25 * fbm(uv * 9.0);
        rust *= 0.4 + 0.6 * fbm(uv * 4.0 + 23.0);
        col = mix(col, float3(0.42, 0.2, 0.09), clamp(rust, 0.0, 0.85));
        // Grime gathering on the underside.
        col *= 1.0 - 0.3 * sstep(0.1, -0.8, sq.y) * fbm(uv * 2.0 + 31.0);
        // Gutters dark, with grime creeping out of them.
        col *= mix(0.3, 1.0, skin);
        col *= 1.0 - hatch * 0.3;
        // The channel round the waist: dark inside, a grimy lip.
        float zone = craftEyeZone(sq, eyeDir);
        float ch = craftChannel(sq.y) * zone;
        col *= 1.0 - ch * 0.7;
        col *= 1.0 - sstep(0.03, 0.0, abs(abs(sq.y) - \(f(Relief.channelHalf)))) * 0.25 * zone;
        // The eye: the dish is dark inside; the bezel round it a brighter ring with a groove.
        float a = craftEyeAngle(sq, eyeDir);
        float R = \(f(Relief.eyeR));
        float dish = 1.0 - smoothstep(R * 0.9, R, a);
        col *= 1.0 - dish * 0.92;
        float bezel = smoothstep(R, R + 0.012, a) * (1.0 - smoothstep(R + \(f(Relief.bezelW * 2)), R + \(f(Relief.bezelW * 2 + 0.015)), a));
        col = mix(col, float3(0.55, 0.55, 0.56), bezel);
        col *= 1.0 - sstep(0.008, 0.0, abs(a - R - \(f(Relief.bezelW * 2 + 0.02)))) * 0.5;
        // Rain: the top goes dark and glossy under its film, darker still along the rivulets.
        float wet = 0.0;
        if (rain > 0.001) {
            wet = rain * smoothstep(0.02, 0.3, sq.y) * (0.6 + 0.4 * smoothstep(0.02, 0.1, craftRainFilm(sq, lon, time)));
            col *= 1.0 - 0.22 * wet;
        }
        float rough = mix(0.5, 0.1, wet);
        float3 c = standardLight(F, col, n, in.world, rough, 0.35, float2(1.0), geometryRoughness(n));

        // --- What it gives off. Small round running lights set in the channel, evenly round the
        // hull, each with a warm halo on the channel wall; a wake sweeps round them when roused.
        float lamps = 0.0, halo = 0.0;
        float rx = CRAFT_HALF.x * \(f(1 - Relief.channelDepth)), rz = CRAFT_HALF.z * \(f(1 - Relief.channelDepth));
        for (int i = 0; i < \(lampCount); i++) {
            float la = (float(i) + 0.5) / \(lampCount).0 * 2.0 * CRAFT_PI;
            // No lamp where the eye is.
            if (abs(atan2(sin(la - \(f(eyeAz))), cos(la - \(f(eyeAz))))) < 0.3) continue;
            float3 lp = float3(cos(la) * rx, 0.0, sin(la) * rz);
            float d = length(p - lp);
            float on = 0.8 + 0.2 * sin(time * q(0.9) + float(i) * 1.7);
            float sw = fmodGL(la - time * 2.5 + 2.0 * CRAFT_PI * 4.0, 2.0 * CRAFT_PI) - CRAFT_PI;
            float sweep = exp(-sw * sw * 2.0) * wake;
            lamps += sstep(0.32, 0.18, d) * (on + sweep * 2.0);
            halo += sstep(1.6, 0.3, d) * (on + sweep * 2.0) * 0.25;
        }
        c += float3(1.0, 0.62, 0.18) * lamps * 5.0 + float3(1.0, 0.5, 0.15) * halo * craftChannel(sq.y) * zone;
        // The eye: a red lens sunk in its dish, brightest at the centre, that glows harder when it looks.
        float lens = 1.0 - smoothstep(R * 0.55, R * 0.63, a);
        float core = 1.0 - smoothstep(0.0, R * 0.4, a);
        float pulse = 0.75 + 0.25 * sin(time * q(0.5));
        c += float3(1.0, 0.06, 0.04) * lens * (1.3 + 3.0 * eyeOn) * pulse;
        c += float3(1.0, 0.25, 0.15) * core * (1.0 + 2.0 * eyeOn) * pulse;
        // The dish wall catches the lens's glow.
        float wall = smoothstep(R * 0.63, R * 0.75, a) * (1.0 - smoothstep(R * 0.9, R, a));
        c += float3(0.4, 0.03, 0.02) * wall * (0.12 + 0.4 * eyeOn);
        return float4(applyFog(F, c, length(in.world - F.camera.xyz)), 1.0);
    }

    """
}
