// Sandstone Arch — The craft: a silent lens-shaped hull, clad in panels of many sizes with inset
// gutters between them, a deep channel round its waist set with small round running lights, and
// a red eye forward sunk in a dish behind a raised bezel. It explores on its own: a slow circuit
// of the lake and the canyon beyond, out in front of the bridge, under the span and far up the
// canyon to the wall at its end, pausing at each station to turn and look at something, its eye
// throwing a red beam on whatever it studies. It looks at a resting cursor instead, flinches
// from a stone, and when clicked wakes its lights in a sweep and dips.

import * as THREE from 'three';
import { TAU, clamp, lerp, rnd, smoothstep, v3, unit, quatAxis, approach, Art } from './util.js';
import { G, Q, NOISE_GLSL, patchMaterial, LAYER, setLayers } from './shaders.js';

const CRAFT = { length: 36, height: 21, width: 29, home: v3(46, 16, -156) };
// The eye's place on the hull, as a direction from the centre (forward-left, a little low).
const EYE_DIR = v3(-0.9, -0.1, 0.45).normalize();
// The hull's relief, in fractions of the radius: the channel round the waist (in unit-sphere
// y), the eye's dish and bezel (in radians from the eye's direction).
const RELIEF = { channelHalf: 0.075, channelDepth: 0.04, eyeR: 0.17, dishDepth: 0.035, bezelH: 0.012, bezelW: 0.025 };
const LAMPS = 16;
// The circuit: stations in open water the craft moves between, each with something to look at
// from there. Walked forward and back, so the far end takes it a couple of minutes to reach and
// it comes back small out of the distance.
const ROUTE = [
  { at: v3(46, 16, -156), look: v3(95, 22, -172) },    // its post under the right of the span: the abutment face
  { at: v3(12, 13, -152), look: v3(8, 36, -150) },     // under the crown, looking up at the underside
  { at: v3(8, 18, -124), look: v3(-45, 26, -140) },    // out front, the lit buttress
  { at: v3(-22, 22, -118), look: v3(-48, 3, -105) },   // over the near lake, the beach
  { at: v3(15, 22, -220), look: v3(-75, 45, -300) },   // behind the span, the canyon's left wall
  { at: v3(-10, 30, -300), look: v3(62, 48, -330) },   // mid-canyon, the right wall
  { at: v3(20, 45, -400), look: v3(0, 72, -450) },     // the far wall
  { at: v3(-20, 60, -420), look: v3(10, 88, -450) },   // high under the far wall's rim
];
const CRUISE = 5.0;
// The eye's azimuth round the waist, in the hull's unit-sphere terms, for keeping lamps off it.
const EYE_AZ = Math.atan2(EYE_DIR.z / (CRAFT.width / 2), EYE_DIR.x / (CRAFT.length / 2)).toFixed(4);

/** The hull's skin: panels, gutters, hatches, the channel, the lamps and the eye, from the surface position. */
function hullMaterial(uniforms) {
  const half = `vec3(${(CRAFT.length / 2).toFixed(2)}, ${(CRAFT.height / 2).toFixed(2)}, ${(CRAFT.width / 2).toFixed(2)})`;
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.35 }), {
    key: 'craft-hull',
    uniforms,
    vHead: `varying vec3 vLocal; varying vec3 vLN;`,
    vMain: `vLocal = gPos; vLN = gNormal;`,
    fHead: `
      uniform float uTime, uWake, uEye; uniform vec3 uEyeDir; uniform mat3 uRot;
      varying vec3 vLocal; varying vec3 vLN;
      ${NOISE_GLSL}${Q}
      const vec3 HALF = ${half};
      // The hull in unit-sphere terms: longitude round it, and y up it (-1 at the keel, 1 on top).
      vec3 sphereOf(vec3 p) { return normalize(p / HALF); }
      // Where the waist channel is (1 inside) and the eye (angle from its centre, radians).
      float channelAt(float qy) { return 1.0 - smoothstep(${RELIEF.channelHalf.toFixed(3)} - 0.02, ${RELIEF.channelHalf.toFixed(3)}, abs(qy)); }
      float eyeAngle(vec3 q) { return acos(clamp(dot(q, normalize(uEyeDir / HALF)), -1.0, 1.0)); }
      // Outside the eye and its bezel (1), so the channel and the cladding stop short of them.
      float eyeZone(vec3 q) { return smoothstep(${(RELIEF.eyeR + RELIEF.bezelW * 3).toFixed(3)}, ${(RELIEF.eyeR + RELIEF.bezelW * 3 + 0.08).toFixed(3)}, eyeAngle(q)); }
      // The cladding: rows of panels up the hull, each row's cells split at random into one to
      // three panels across and one or two up, so no two neighbours match; a gutter between
      // every panel, and a hatch outlined inside some. Returns the height of the skin (0 in a
      // gutter, 1 on a panel) and the panel's id.
      float panels(vec3 q, float lon, out float id, out float hatch, out float below) {
        float v = abs(q.y), side = step(0.0, q.y);
        // Row edges up the dome, and how many cells round each row.
        float e0 = ${RELIEF.channelHalf.toFixed(3)}, e1 = 0.38, e2 = 0.72, e3 = 0.93;
        float r, t0, t1, cols;
        if (v < e1) { r = 0.0; t0 = e0; t1 = e1; cols = 14.0; }
        else if (v < e2) { r = 1.0; t0 = e1; t1 = e2; cols = 10.0; }
        else if (v < e3) { r = 2.0; t0 = e2; t1 = e3; cols = 6.0; }
        else { r = 3.0; t0 = e3; t1 = 1.02; cols = 1.0; }
        float stagger = hash11(r * 7.0 + side * 3.0) * 0.5;
        float cu = lon * cols + stagger;
        float c = floor(cu);
        vec2 cell = vec2(c, r * 2.0 + side);
        float h1 = hash21(cell), h2 = hash21(cell + 17.0);
        float ns = 1.0 + floor(h1 * 2.999), nr = 1.0 + floor(h2 * 1.999);
        if (r == 3.0) { ns = 1.0; nr = 1.0; }
        float su = fract(cu) * ns, sv = (v - t0) / (t1 - t0) * nr;
        vec2 sub = vec2(floor(su), floor(sv));
        id = hash21(cell * 3.0 + sub + 5.0);
        // How far down its panel a point is, 0 at the gutter above it, 1 at the one below.
        below = q.y >= 0.0 ? 1.0 - fract(sv) : fract(sv);
        // Distances to the nearest gutter, in metres: round the hull the cell's width shrinks
        // toward the poles; up it the row's height is a share of the half height.
        float ring = 2.0 * PI * (HALF.x + HALF.z) * 0.5 * sqrt(max(1.0 - q.y * q.y, 0.0));
        float wU = ring / cols / ns, wV = (t1 - t0) / nr * HALF.y * 1.3;
        float dU = min(fract(su), 1.0 - fract(su)) * wU, dV = min(fract(sv), 1.0 - fract(sv)) * wV;
        float d = min(dU, dV);
        if (r == 3.0) d = (1.0 - v) * HALF.y * 2.0;
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
      // The skin's height in metres at a local point, for the bump.
      float skinHeight(vec3 p) {
        vec3 q = sphereOf(p);
        float lon = atan(q.z, q.x) / (2.0 * PI) + 0.5;
        float id, hatch, below;
        float h = panels(q, lon, id, hatch, below) * 0.06;
        h *= 1.0 - channelAt(q.y) * eyeZone(q);
        return h;
      }`,
    fNormal: `
      {
        // The gutters as relief: the skin's height differenced along the hull's two directions.
        vec3 p = vLocal, nl = normalize(vLN);
        vec3 tLon = normalize(vec3(-p.z, 0.0, p.x));
        vec3 tLat = normalize(cross(nl, tLon));
        float e = max(0.04, length(fwidth(vWPos)) * 1.5);
        float h0 = skinHeight(p);
        float gu = (skinHeight(p + tLon * e) - h0) / e, gv = (skinHeight(p + tLat * e) - h0) / e;
        vec3 nb = normalize(nl - tLon * gu - tLat * gv);
        normal = normalize((viewMatrix * vec4(uRot * nb, 0.0)).xyz);
        if (!gl_FrontFacing) normal = -normal;
      }`,
    fColor: `
      {
        vec3 p = vLocal;
        vec3 q = sphereOf(p);
        float lon = atan(q.z, q.x) / (2.0 * PI) + 0.5;
        float px = length(fwidth(vWPos));
        float id, hatch, below;
        float skin = panels(q, lon, id, hatch, below);
        // Dull titanium-white cladding, streaked and stained, a shade warmer below, each
        // panel its own shade.
        vec2 uv = vec2(lon * 40.0, q.y * 8.0);
        vec3 col = mix(vec3(0.8, 0.8, 0.78), vec3(0.62, 0.6, 0.58), fbm(uv * 1.5 + 3.0) * 0.8);
        col *= 0.9 + 0.2 * fbm(uv * 7.0);
        // Not every panel came from the same batch: most a shade apart, some replaced with a
        // darker, a browner or a bluer one.
        col *= 0.84 + 0.22 * id;
        if (id < 0.09) col *= vec3(0.55, 0.55, 0.57);
        else if (id < 0.16) col *= vec3(0.78, 0.66, 0.52);
        else if (id < 0.22) col *= vec3(0.8, 0.86, 0.95);
        // Worn through in patches to the dull metal under the paint, worst near the gutters.
        float worn = smoothstep(0.5, 0.75, fbm(uv * 2.5 + 11.0)) * (1.0 - skin * 0.5);
        col = mix(col, vec3(0.48, 0.45, 0.43), worn * 0.8);
        // Rust: streaks run down from the gutter above each panel, from the hatches and from
        // the channel's lower lip, narrow and uneven.
        float streak = pow(fbm(vec2(lon * 110.0 + 7.0, q.y * 2.5)), 2.6) * 2.2;
        float rust = streak * smoothstep(0.85, 0.0, below) * 0.9;
        rust += streak * smoothstep(0.3, 0.0, -q.y - ${RELIEF.channelHalf.toFixed(3)}) * step(q.y, 0.0) * 0.8;
        rust += hatch * 0.25 * fbm(uv * 9.0);
        rust *= 0.4 + 0.6 * fbm(uv * 4.0 + 23.0);
        col = mix(col, vec3(0.42, 0.2, 0.09), clamp(rust, 0.0, 0.85));
        // Grime gathering on the underside.
        col *= 1.0 - 0.3 * smoothstep(0.1, -0.8, q.y) * fbm(uv * 2.0 + 31.0);
        // Gutters dark, with grime creeping out of them.
        col *= mix(0.3, 1.0, skin);
        col *= 1.0 - hatch * 0.3;
        // The channel round the waist: dark inside, a grimy lip.
        float ch = channelAt(q.y) * eyeZone(q);
        col *= 1.0 - ch * 0.7;
        col *= 1.0 - smoothstep(0.03, 0.0, abs(abs(q.y) - ${RELIEF.channelHalf.toFixed(3)})) * 0.25 * eyeZone(q);
        // The eye: the dish is dark inside; the bezel round it a brighter ring with a groove.
        float a = eyeAngle(q);
        float R = ${RELIEF.eyeR.toFixed(3)};
        float dish = 1.0 - smoothstep(R * 0.9, R, a);
        col *= 1.0 - dish * 0.92;
        float bezel = smoothstep(R, R + 0.012, a) * (1.0 - smoothstep(R + ${(RELIEF.bezelW * 2).toFixed(3)}, R + ${(RELIEF.bezelW * 2 + 0.015).toFixed(3)}, a));
        col = mix(col, vec3(0.55, 0.55, 0.56), bezel);
        col *= 1.0 - smoothstep(0.008, 0.0, abs(a - R - ${(RELIEF.bezelW * 2 + 0.02).toFixed(3)})) * 0.5;
        diffuseColor.rgb = col;
      }`,
    fEmissive: `
      {
        // Small round running lights set in the channel, evenly round the hull, each with a
        // warm halo on the channel wall; a wake sweeps round them when the craft is roused.
        vec3 p = vLocal;
        vec3 sq = sphereOf(p);
        float lamps = 0.0, halo = 0.0;
        float rx = HALF.x * (1.0 - ${RELIEF.channelDepth.toFixed(3)}), rz = HALF.z * (1.0 - ${RELIEF.channelDepth.toFixed(3)});
        for (int i = 0; i < ${LAMPS}; i++) {
          float a = (float(i) + 0.5) / ${LAMPS}.0 * 2.0 * PI;
          // No lamp where the eye is.
          if (abs(atan(sin(a - ${EYE_AZ}), cos(a - ${EYE_AZ}))) < 0.3) continue;
          vec3 lp = vec3(cos(a) * rx, 0.0, sin(a) * rz);
          float d = length(p - lp);
          float on = 0.8 + 0.2 * sin(uTime * q(0.9) + float(i) * 1.7);
          float sweep = exp(-pow(mod(a - uTime * 2.5 + 2.0 * PI * 4.0, 2.0 * PI) - PI, 2.0) * 2.0) * uWake;
          lamps += smoothstep(0.32, 0.18, d) * (on + sweep * 2.0);
          halo += smoothstep(1.6, 0.3, d) * (on + sweep * 2.0) * 0.25;
        }
        totalEmissiveRadiance += vec3(1.0, 0.62, 0.18) * lamps * 5.0 + vec3(1.0, 0.5, 0.15) * halo * channelAt(sq.y) * eyeZone(sq);
        // The eye: a red lens sunk in its dish, brightest at the centre, with a glint off the
        // bezel, that glows harder when it looks.
        float a = eyeAngle(sq);
        float R = ${RELIEF.eyeR.toFixed(3)};
        float lens = 1.0 - smoothstep(R * 0.55, R * 0.63, a);
        float core = 1.0 - smoothstep(0.0, R * 0.4, a);
        float pulse = 0.75 + 0.25 * sin(uTime * q(0.5));
        totalEmissiveRadiance += vec3(1.0, 0.06, 0.04) * lens * (1.3 + 3.0 * uEye) * pulse;
        totalEmissiveRadiance += vec3(1.0, 0.25, 0.15) * core * (1.0 + 2.0 * uEye) * pulse;
        // The dish wall catches the lens's glow.
        float wall = smoothstep(R * 0.63, R * 0.75, a) * (1.0 - smoothstep(R * 0.9, R, a));
        totalEmissiveRadiance += vec3(0.4, 0.03, 0.02) * wall * (0.12 + 0.4 * uEye);
      }`,
  });
}

export class Craft {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.uniforms = { uTime: G.uTime, uWake: { value: 0 }, uEye: { value: 0 }, uEyeDir: { value: EYE_DIR.clone() }, uRot: { value: new THREE.Matrix3() } };
    this.material = hullMaterial(this.uniforms);
    // The hull: an ellipsoid, blunter below than above, with the channel cut round its waist
    // and the eye's dish sunk forward behind a raised bezel.
    const geo = new THREE.SphereGeometry(1, 256, 128);
    const p = geo.attributes.position;
    const eyeQ = EYE_DIR.clone().divide(v3(CRAFT.length / 2, CRAFT.height / 2, CRAFT.width / 2)).normalize();
    const R = RELIEF.eyeR;
    for (let i = 0; i < p.count; i++) {
      const q = v3(p.getX(i), p.getY(i), p.getZ(i));
      const flat = q.y < 0 ? 0.9 : 1.0;
      const ang = Math.acos(clamp(q.dot(eyeQ), -1, 1));
      // The channel stops short of the eye and its bezel.
      const eyeZone = smoothstep(R + RELIEF.bezelW * 3, R + RELIEF.bezelW * 3 + 0.08, ang);
      const channel = -RELIEF.channelDepth * (1 - smoothstep(RELIEF.channelHalf - 0.02, RELIEF.channelHalf, Math.abs(q.y))) * eyeZone;
      const dish = -RELIEF.dishDepth * clamp(1 - (ang / R) * (ang / R), 0, 1);
      const bezel = RELIEF.bezelH * Math.exp(-Math.pow((ang - R - RELIEF.bezelW) / RELIEF.bezelW, 2));
      const f = 1 + channel + dish + bezel;
      p.setXYZ(i, q.x * CRAFT.length / 2 * f, q.y * CRAFT.height / 2 * flat * f, q.z * CRAFT.width / 2 * f);
    }
    geo.computeVertexNormals();
    this.hull = new THREE.Mesh(geo, this.material);
    this.hull.castShadow = true;
    this.group.add(this.hull);
    // The lamps as real light sources: two point lights at the waist for the glow on the hull and
    // the water, and the eye's red one.
    this.lampLight = new THREE.PointLight(0xffa040, 50, 80, 1.6);
    this.lampLight.position.set(0, -0.4, 0);
    this.eyeLight = new THREE.PointLight(0xff2010, 25, 50, 1.6);
    this.eyeLight.position.copy(EYE_DIR).multiply(v3(CRAFT.length / 2, CRAFT.height / 2, CRAFT.width / 2)).multiplyScalar(1.1);
    this.group.add(this.lampLight, this.eyeLight);
    setLayers(this.group, LAYER.ABOVE);
    this.pos = CRAFT.home.clone();
    this.vel = v3();
    this.yaw = -0.3;
    this.yawVel = 0;
    this.roll = 0;
    this.pitch = 0;
    this.wake = 0;
    this.eye = 0;
    this.drift = v3();
    this.driftTimer = rnd(10, 30);
    this.flinch = 0;
    // Exploring: the station it is at or heading for, which way along the circuit it is going,
    // and how long it will dwell where it is.
    this.station = 0;
    this.direction = 1;
    this.dwell = rnd(6, 12);
    this.lookAt = ROUTE[0].look.clone();
    this.update(0);
  }

  /** Something hit the water near it, or a stone came its way: a flinch and a flare of the lights. */
  startle(from, strength) {
    const away = unit(this.pos.clone().sub(from).setY(0));
    this.vel.addScaledVector(away, 1.5 * strength);
    this.vel.y += 1.0 * strength;
    this.wake = Math.min(1, this.wake + 0.8 * strength);
  }

  /** Clicked: the lights sweep, it dips and rises, and the eye brightens.*/
  rouse() {
    this.wake = 1;
    this.vel.y -= 2.5;
    this.yawVel += rnd(-0.3, 0.3);
    this.eye = 1;
  }

  update(dt, scene) {
    const t = G.uTime.value;
    const stop = ROUTE[this.station];
    // Exploring: cruise to the next station, slowing on approach; dwell there a while, turned
    // to its point of interest; then move on, mostly the way it was going, reversing at the ends.
    const toGoal = stop.at.clone().sub(this.pos);
    const dist = toGoal.length();
    let desired = v3();
    if (this.dwell > 0) {
      this.dwell -= dt;
      if (this.dwell <= 0) {
        if (this.station + this.direction < 0 || this.station + this.direction >= ROUTE.length || Math.random() < 0.12) this.direction = -this.direction;
        this.station = clamp(this.station + this.direction, 0, ROUTE.length - 1);
      }
    } else if (dist < 5) {
      this.dwell = rnd(7, 16);
    } else {
      desired = toGoal.multiplyScalar(Math.min(CRUISE, dist * 0.35) / dist);
    }
    // A slow drift that changes its mind every half minute, on top.
    this.driftTimer -= dt;
    if (this.driftTimer <= 0) { this.driftTimer = rnd(15, 40); this.drift.set(rnd(-1, 1), rnd(-0.3, 0.3), rnd(-0.6, 0.6)).multiplyScalar(0.4); }
    const acc = desired.add(this.drift).sub(this.vel).multiplyScalar(0.45);
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    // The bob: a breath, four seconds, a metre.
    const bob = Math.sin(t * 2 * Math.PI / 4.2) * 0.5 + Math.sin(t * 2 * Math.PI / 11) * 0.3;
    // Looking: at a resting cursor above all; else, dwelling, at the station's point of
    // interest; else ahead along its way. The eye glows and its beam shines while it studies.
    let look = null, studying = false;
    if (scene) {
      const c = scene.cursor;
      if (c.present && c.stillTime > 1.0) {
        const { origin, dir } = scene.ray(c.screen);
        const hit = scene.rockHit ? scene.rockHit(c.screen, 700) : null;
        look = hit ? hit.point.clone() : origin.clone().addScaledVector(dir, 200);
        studying = true;
      }
    }
    if (!look && this.dwell > 0) { look = stop.look; studying = true; }
    if (!look) look = this.vel.lengthSq() > 0.5 ? this.pos.clone().addScaledVector(unit(this.vel.clone()), 80) : stop.look;
    this.eye = approach(this.eye, studying ? 1 : 0.15, studying ? 1.2 : 2.5, dt);
    this.lookAt.lerp(look, Math.min(1, dt * 1.5));
    const wantYaw = Math.atan2(-(this.lookAt.z - this.pos.z), this.lookAt.x - this.pos.x) + Math.PI;
    let d = wantYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yawVel += (d * 0.4 - this.yawVel * 0.8) * dt;
    this.yaw += this.yawVel * dt;
    this.roll = lerp(this.roll, clamp(-this.yawVel * 0.4, -0.15, 0.15) + Math.sin(t * 0.37) * 0.02, Math.min(1, dt * 2));
    this.pitch = lerp(this.pitch, clamp(this.vel.y * 0.05, -0.1, 0.1) + Math.sin(t * 0.23) * 0.015, Math.min(1, dt * 2));
    this.wake = Math.max(0, this.wake - dt * 0.35);
    this.uniforms.uWake.value = this.wake;
    this.uniforms.uEye.value = this.eye;
    this.group.position.copy(this.pos).add(v3(0, bob, 0));
    this.group.quaternion.copy(quatAxis(this.yaw, 0, 1, 0)).multiply(quatAxis(this.pitch, 0, 0, 1)).multiply(quatAxis(this.roll, 1, 0, 0));
    this.group.updateMatrixWorld();
    this.uniforms.uRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.group.quaternion));
    // The beam follows the look, brightening as the eye does: the rock draws it from the eye's
    // place and direction.
    if (scene) {
      const eyePos = this.group.localToWorld(this.eyeLight.position.clone());
      const dir = unit(this.lookAt.clone().sub(eyePos));
      const on = Math.max(0, this.eye - 0.15) / 0.85;
      for (const m of [scene.rockMaterial, scene.blockMaterial]) {
        const u = m.userData.uniforms;
        u.uBeam.value.set(eyePos.x, eyePos.y, eyePos.z, on);
        u.uBeamDir.value.copy(dir);
      }
    }
    this.lampLight.intensity = 50 + 80 * this.wake;
    this.eyeLight.intensity = 25 + 45 * this.eye;
  }

  dispose() { this.material.dispose(); this.hull.geometry.dispose(); }
}
