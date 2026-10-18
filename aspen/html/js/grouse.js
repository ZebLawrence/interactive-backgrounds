// Aspen Snow — Ruffed grouse: a procedural bird that roosts under the snow, bursts out when
// flushed, flies low and fast through the trunks, picks aspen buds in a crown, and dives back
// into the snow to roost.
//
// Bonasa umbellus: 40-50 cm, chicken-shaped, mottled grey-brown (the grey morph in the north),
// with a small crest, a black ruff at the sides of the neck, barred flanks and a fan tail with a
// broad black band near its pale tip. In winter it lives largely on the buds of aspens, picked
// at dusk and dawn from the crowns, and when the snow is deep it roosts under it: it dives in
// from flight, tunnels a short way, and sits in a snug chamber. Disturbed, it explodes out in
// a thunder of wingbeats, flies off low at up to 40 km/h on short wings, bursts of flapping
// alternating with glides, and settles again within a hundred metres.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, v3, unit, approach, angleDiff } from './util.js';
import { G, NOISE_GLSL, patchMaterial } from './shaders.js';

function lofted(rows, sides, at) {
  const pos = [], uv = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= sides; c++) {
      const t = r / rows, a = c / sides * TAU;
      const p = at(t, a);
      pos.push(p.x, p.y, p.z);
      uv.push(c / sides, t);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < sides; c++) {
      const a = r * (sides + 1) + c, b = a + 1, d = a + sides + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
const bulb = (k) => (t) => Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), k);

/** The plumage: grey-brown mottle, dark barring on the flanks, a paler barred breast. */
function plumageMaterial(part) {
  return patchMaterial(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: part === 'card' ? THREE.DoubleSide : THREE.FrontSide, alphaToCoverage: part === 'card' }), {
    key: 'grouse-' + part,
    uniforms: { uSkyLight: G.uSkyLight },
    vHead: `varying vec2 vGUv; varying vec3 vGN; varying vec3 vGPos;`,
    vMain: `vGUv = uv; vGN = normalize(normalMatrix * gNormal); vGPos = gPos;`,
    fHead: `varying vec2 vGUv; varying vec3 vGN; varying vec3 vGPos; uniform vec3 uSkyLight;\n${NOISE_GLSL}
      // Feather by feather: overlapping scalloped rows, each feather grey-brown with a pale shaft
      // streak and a darker tip, finely vermiculated, a few with a pale spot.
      vec3 mottle(vec2 p, float scale) {
        vec2 q = p * scale;
        // Stagger alternate rows so the feathers overlap like tiles.
        float row = floor(q.y);
        q.x += 0.5 * mod(row, 2.0);
        vec2 cell = floor(q);
        vec2 f = fract(q);
        float h = hash21(cell), h2 = hash21(cell + 3.7);
        // The feather's rounded tip: the row above overlaps this one.
        float tipDist = length((f - vec2(0.5, 0.0)) * vec2(1.0, 0.7));
        float verm = vnoise(p * 900.0) * 0.5 + vnoise(p * 300.0) * 0.5;
        vec3 dark = vec3(0.07, 0.055, 0.045), mid = vec3(0.2, 0.165, 0.13), pale = vec3(0.38, 0.33, 0.27);
        vec3 c = mix(dark, mid, h * 0.7 + verm * 0.3);
        // Pale shaft streak down the middle, and a dark band near the tip.
        float shaft = 1.0 - smoothstep(0.03, 0.08, abs(f.x - 0.5));
        c = mix(c, pale, shaft * 0.7 * smoothstep(0.2, 0.6, f.y));
        c = mix(c, dark, smoothstep(0.75, 0.95, f.y) * 0.5);
        c = mix(c, pale, step(0.85, h2) * (1.0 - smoothstep(0.1, 0.25, length(f - vec2(0.5, 0.45)))) * 0.6);
        // The scalloped edge where the next row overlaps.
        float edge = smoothstep(0.55, 0.62, tipDist) * (1.0 - smoothstep(0.0, 0.12, f.y));
        c = mix(c, dark, edge * 0.5);
        c *= 0.85 + 0.3 * verm;
        return c;
      }`,
    fColor: `
      {
        vec3 c;
        ${part === 'body' ? `
        // Round the body: uv.x is the angle (0.25 = top, 0.75 = belly), uv.y runs tail to breast.
        float side = cos(vGUv.x * 6.2831);        // 1 at the top of the back, -1 on the belly
        c = mottle(vec2(vGUv.x * 2.0, vGUv.y * 3.0), 26.0);
        // Pale barred breast and belly.
        // Pale feathers each with a dark crescent at the tip: barred underparts.
        vec3 breast = mix(mottle(vec2(vGUv.x * 2.0 + 0.3, vGUv.y * 3.0), 26.0), vec3(0.6, 0.55, 0.47), 0.6);
        c = mix(c, breast, smoothstep(0.2, 0.8, -side));
        // The black ruff at the sides of the neck.
        float ruff = smoothstep(0.78, 0.86, vGUv.y) * (1.0 - smoothstep(0.86, 0.92, vGUv.y)) * (1.0 - smoothstep(0.5, 0.9, abs(side)));
        c = mix(c, vec3(0.02, 0.018, 0.015), ruff * 0.9);` : ''}
        ${part === 'head' ? `
        c = mottle(vec2(vGUv.x * 2.0, vGUv.y), 30.0);
        // The pale throat and the thin pale line behind the eye.
        float side = cos(vGUv.x * 6.2831);
        c = mix(c, vec3(0.5, 0.45, 0.38), smoothstep(0.2, 0.8, -side) * 0.6);` : ''}
        ${part === 'card' ? `
        // Wings and tail cards: the silhouette is in vGUv (x across 0..1, y along 0..1).
        c = mottle(vec2(vGUv.x * 3.0, vGUv.y * 2.0), 16.0);` : ''}
        diffuseColor.rgb = c;
      }`,
  });
}

/** Wing and tail cards: alpha from a feathered silhouette, a dark band and pale tip on the tail. */
function cardMaterial(kind) {
  const mat = plumageMaterial('card');
  mat.customProgramCacheKey = () => 'grouse-card-' + kind;
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh) => {
    base(sh);
    sh.fragmentShader = sh.fragmentShader.replace('diffuseColor.rgb = c;', `
      diffuseColor.rgb = c;
      ${kind === 'tail' ? `
      // A fan: feathers radiate from the base (uv.y = 0); scalloped tip; black band; pale edge.
      float r = vGUv.y;
      float feather = abs(fract(vGUv.x * 9.0) - 0.5);
      float tipR = 0.96 - 0.06 * feather * feather * 4.0;
      float a = 1.0 - smoothstep(tipR, tipR + 0.03, r);
      float band = smoothstep(0.72, 0.76, r) * (1.0 - smoothstep(0.86, 0.9, r));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.018, 0.015), band * 0.95);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.52, 0.45), smoothstep(0.9, 0.94, r));
      // Fine cross-barring on the tail feathers.
      diffuseColor.rgb *= 0.85 + 0.15 * smoothstep(0.4, 0.6, abs(sin(r * 70.0)));
      diffuseColor.a = a;` : `
      // A wing: short, broad and rounded, the leading edge nearly straight, the trailing edge
      // curving in to a rounded tip of fingered primaries.
      float y = vGUv.y, x = vGUv.x;
      // A rounded planform: full chord near the body, rounding off toward the tip.
      float e = pow(abs((x - 0.42) / 0.58), 2.4) + pow(y, 3.2) + 0.25 * y * y * x;
      float a = 1.0 - smoothstep(0.9, 1.0, e);
      // Scallops along the trailing edge, feather by feather, and the fingered primaries.
      a *= 1.0 - 0.5 * smoothstep(0.78, 1.0, e + 0.08 * abs(fract(y * 8.0) - 0.5)) * step(0.5, x);
      a *= 1.0 - 0.5 * smoothstep(0.65, 1.0, y) * smoothstep(0.25, 0.5, abs(fract(x * 6.0) - 0.5)) * step(0.4, x);
      // Barred coverts and darker primaries.
      diffuseColor.rgb *= 0.8 + 0.2 * smoothstep(0.4, 0.6, abs(sin(x * 40.0 + y * 8.0)));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.1, 0.08), smoothstep(0.55, 0.95, x) * 0.5);
      diffuseColor.a = a;`}
      if (diffuseColor.a < 0.05) discard;`);
  };
  return mat;
}

export class Grouse {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.build();
    this.pos = v3();
    this.vel = v3();
    this.yaw = 0;
    this.pitch = 0;
    this.state = 'roost';
    this.timer = rnd(240, 480);
    this.flap = 0;              // wing phase
    this.flapRate = 0;          // beats per second, eased
    this.wingK = 0;             // 0 folded .. 1 spread
    this.tailK = 0.3;           // fan
    this.headBob = 0;
    this.perch = null;
    this.roost = null;
    this.roostSomewhere();
    this.root.visible = false;
  }

  build() {
    const mats = this.materials = {
      body: plumageMaterial('body'), head: plumageMaterial('head'), wing: cardMaterial('wing'), tail: cardMaterial('tail'),
      eye: new THREE.MeshStandardMaterial({ color: 0x100c08, roughness: 0.15 }),
      beak: new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.6 }),
      leg: new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.9 }),
    };
    const geos = this.geometries = [];
    const mesh = (g, m) => { geos.push(g); const me = new THREE.Mesh(g, m); me.castShadow = true; return me; };
    this.body = new THREE.Group();
    this.root.add(this.body);
    // The body: plump, the breast deep, rising into a short neck at the front.
    const bodyS = (t, a) => {
      const ry = 0.07 * bulb(0.42)(t) * (1 - 0.25 * t * t), rz = 0.062 * bulb(0.42)(t) * (1 - 0.2 * t * t);
      const neck = smoothstep(0.75, 1, t);
      return v3(-0.15 + 0.27 * t, 0.01 * Math.sin(Math.PI * t) + neck * 0.05 + Math.sin(a) * (ry * (1 - neck * 0.55)), Math.cos(a) * rz * (1 - neck * 0.5));
    };
    this.body.add(mesh(lofted(24, 22, bodyS), mats.body));
    // Head on the neck, with a crest.
    this.neck = new THREE.Group();
    this.neck.position.set(0.11, 0.065, 0);
    this.body.add(this.neck);
    this.head = new THREE.Group();
    this.neck.add(this.head);
    const headS = (t, a) => v3(-0.02 + 0.055 * t, 0.012 - 0.01 * t * t + Math.sin(a) * 0.021 * bulb(0.35)(t), Math.cos(a) * 0.019 * bulb(0.35)(t));
    this.head.add(mesh(lofted(12, 14, headS), mats.head));
    const crestS = (t, a) => v3(0.004 - 0.028 * t, 0.018 + 0.022 * t + Math.sin(a) * 0.005 * bulb(0.4)(t), Math.cos(a) * 0.01 * bulb(0.4)(t));
    const crest = mesh(lofted(8, 8, crestS), mats.head);
    this.head.add(crest);
    for (const side of [-1, 1]) {
      const eye = mesh(new THREE.SphereGeometry(0.0045, 10, 8), mats.eye);
      eye.position.set(0.012, 0.016, side * 0.016);
      this.head.add(eye);
    }
    const beak = mesh(new THREE.ConeGeometry(0.006, 0.016, 8), mats.beak);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.04, 0.004, 0);
    this.head.add(beak);
    // Wings: a card each, hinged at the shoulder, lying along the flank when folded.
    this.wings = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(0.02, 0.03, side * 0.04);
      this.body.add(pivot);
      // The card: 0.11 chord (x) by 0.19 span (along the hinge, z); uv.y along the span.
      const g = new THREE.PlaneGeometry(0.11, 0.19, 4, 8);
      g.rotateX(-Math.PI / 2);                       // lie flat: x chord, z span
      g.translate(-0.03, 0, side * 0.095);
      // Flip the uv's span direction for the left wing so the tips match.
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setY(i, side > 0 ? uv.getY(i) : 1 - uv.getY(i));
      const wing = mesh(g, mats.wing);
      pivot.add(wing);
      // A second, ghost copy for the blur of a fast beat.
      const ghost = new THREE.Mesh(g, mats.wing);
      ghost.visible = false;
      pivot.add(ghost);
      this.wings.push({ pivot, wing, ghost, side });
    }
    // The tail: a fan card hinged at the rump, folded narrow or spread wide.
    this.tailG = new THREE.Group();
    this.tailG.position.set(-0.13, 0.02, 0);
    this.body.add(this.tailG);
    const tg = new THREE.PlaneGeometry(0.17, 0.15, 8, 6);
    tg.rotateX(-Math.PI / 2);
    tg.rotateY(Math.PI / 2);
    tg.translate(-0.075, 0, 0);
    // uv: x across the fan, y along it (base at the rump).
    const tuv = tg.attributes.uv, tp = tg.attributes.position;
    for (let i = 0; i < tuv.count; i++) {
      // Fan the vertices: spread sideways with distance from the base.
      const x = tp.getX(i), z = tp.getZ(i);
      const along = -x / 0.15;
      tp.setZ(i, z * along * 1.0);
      tuv.setX(i, z / 0.17 + 0.5);
      tuv.setY(i, along);
    }
    tg.computeVertexNormals();
    this.tail = mesh(tg, mats.tail);
    this.tailG.add(this.tail);
    // Short feathered legs.
    this.legs = new THREE.Group();
    for (const side of [-1, 1]) {
      // Feathered to the toes: a fluffy stub, with the three grey toes gripping below.
      const legS = (t, a) => v3(0.0, -0.045 - 0.04 * t, side * 0.025 + 0) .add(v3(Math.cos(a) * 0.016 * bulb(0.4)(t), 0, Math.sin(a) * 0.016 * bulb(0.4)(t)));
      this.legs.add(mesh(lofted(6, 10, legS), mats.body));
      for (let k = 0; k < 3; k++) {
        const toe = mesh(new THREE.CylinderGeometry(0.0025, 0.0015, 0.03, 5), mats.leg);
        toe.rotation.z = -Math.PI / 2;
        toe.rotation.y = (k - 1) * 0.55;
        toe.position.set(0.012, -0.088, side * 0.025);
        this.legs.add(toe);
      }
    }
    this.body.add(this.legs);
  }

  // MARK: - Behaviour

  /** The home ground where it roosts: the open snow in front of the viewer. */
  roostSomewhere() {
    for (let tries = 0; tries < 40; tries++) {
      const z = rnd(-8, -24), half = Math.min(11, -z * 0.5);
      const x = rnd(-half, half);
      if (!this.scene.openSnow(x, z, 1)) continue;
      this.roost = v3(x, this.scene.height(x, z), z);
      return;
    }
    this.roost = v3(0, this.scene.height(0, -12), -12);
  }

  /** A click on the snow at `p`: if it is roosting, it bursts out there. */
  flush(p) {
    if (this.state !== 'roost') return false;
    if (!this.scene.openSnow(p.x, p.z, 0.6)) return false;
    this.roost = p.clone();
    this.burst();
    return true;
  }

  burst() {
    const s = this.scene;
    this.pos.copy(this.roost);
    this.pos.y += 0.05;
    this.state = 'burst';
    this.timer = 0;
    this.yaw = rnd(0, TAU);
    this.pitch = 0.9;
    this.vel.set(0, 0, 0);
    this.flapRate = 13;
    this.wingK = 1;
    this.tailK = 1;
    this.root.visible = true;
    s.snowpack.stampBurst(this.roost.x, this.roost.z, -this.yaw);
    s.puffs.burst(this.roost.x, this.roost.y, this.roost.z, 1.6, 0.4);
    this.choosePerch();
  }

  /** A crown to fly to: a branch high in a tree 15-45 m off, in view. */
  choosePerch() {
    const s = this.scene;
    const options = s.grove.trees.filter((t) => {
      const d = Math.hypot(t.x - this.pos.x, t.z - this.pos.z), dist = Math.hypot(t.x, t.z);
      return d > 12 && d < 40 && dist > 12 && dist < 48 && t.height > 10 && Math.abs(Math.atan2(t.x, -t.z)) < 0.6;
    });
    if (!options.length) { this.perch = null; return; }
    const t = options[Math.floor(Math.random() * options.length)];
    const a = rnd(0, TAU);
    this.perch = { tree: t, f: rnd(0.68, 0.8), off: v3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(t.maxR * rnd(0.3, 0.6)) };
  }

  perchPoint() {
    const p = this.perch;
    return this.scene.grove.pointUp(p.tree, p.f).add(p.off);
  }

  /** Somewhere in the open to dive into the snow. */
  chooseDive() {
    this.roostSomewhere();
    this.dive = this.roost.clone();
  }

  /** The nearest trunk ahead within `reach`, for steering, or null. */
  trunkAhead(dir, reach) {
    let best = null, bestD = reach;
    for (const t of this.scene.grove.trees) {
      if (this.perch && t === this.perch.tree) continue;
      const dx = t.x - this.pos.x, dz = t.z - this.pos.z;
      const along = dx * dir.x + dz * dir.z;
      if (along < 0 || along > reach) continue;
      const across = Math.abs(dx * dir.z - dz * dir.x);
      if (across > t.baseR + 0.5) continue;
      if (along < bestD) { bestD = along; best = { t, side: Math.sign(dx * dir.z - dz * dir.x) || 1 }; }
    }
    return best;
  }

  startle(p, strength) {
    if (this.state === 'perch' && strength > 0.8 && Math.random() < 0.5) { this.choosePerch(); this.state = 'fly'; this.timer = 0; this.flapRate = 11; }
  }

  update(dt, scene, info) {
    this.timer += dt;
    const s = scene;
    switch (this.state) {
      case 'roost': {
        // Now and then it comes out on its own to feed.
        if (this.timer > this.nextSelf) { this.burst(); }
        break;
      }
      case 'burst': {
        // Straight up out of the snow, then levelling off into flight.
        const k = this.timer;
        this.vel.y = lerp(5, 1.5, smoothstep(0, 0.6, k));
        const fwd = v3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const speed = lerp(1, 8, smoothstep(0.1, 0.9, k));
        this.vel.x = fwd.x * speed; this.vel.z = fwd.z * speed;
        this.pos.addScaledVector(this.vel, dt);
        this.pitch = lerp(0.9, 0.15, smoothstep(0.1, 0.9, k));
        if (k > 0.9) { this.state = 'fly'; this.timer = 0; this.glide = 0; }
        break;
      }
      case 'fly': {
        // Toward the perch, low between the trunks; bursts of flapping and glides.
        const target = this.perch ? this.perchPoint() : v3(this.pos.x, this.pos.y, this.pos.z - 30);
        const to = target.clone().sub(this.pos);
        const dist = to.length();
        const flat = Math.hypot(to.x, to.z);
        // Cruise 2.5-4 m up until the last stretch, then rise to the perch.
        const cruiseY = s.height(this.pos.x, this.pos.z) + 3 + Math.sin(this.timer * 0.7) * 0.6;
        const wantY = flat < 25 ? lerp(target.y + 0.3, Math.min(cruiseY, target.y), smoothstep(8, 25, flat)) : Math.min(cruiseY, target.y);
        const dir = unit(v3(to.x, 0, to.z));
        // Steer round the trunk ahead.
        const ahead = this.trunkAhead(dir, 5);
        let steer = 0;
        if (ahead && flat > 3) steer = -ahead.side * 1.4;
        const wantYaw = Math.atan2(-dir.z, dir.x) + steer;
        const turn = flat < 6 ? 5 : 2.2;
        this.yaw += clamp(angleDiff(this.yaw, wantYaw), -turn * dt, turn * dt);
        const speed = flat < 6 ? lerp(2, 8, smoothstep(0, 6, flat)) : 8;
        const fwd = v3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        this.vel.x = approach(this.vel.x, fwd.x * speed, 0.3, dt);
        this.vel.z = approach(this.vel.z, fwd.z * speed, 0.3, dt);
        this.vel.y = approach(this.vel.y, clamp((wantY - this.pos.y) * 2, -4, 4), 0.3, dt);
        this.pos.addScaledVector(this.vel, dt);
        this.pitch = approach(this.pitch, clamp(this.vel.y * 0.12, -0.4, 0.5) + (flat < 4 ? 0.6 : 0), 0.3, dt);
        // Flap then glide, flapping harder when climbing.
        this.glide += dt;
        const climbing = this.vel.y > 0.5;
        const period = climbing ? 1.6 : 1.3;
        const phase = this.glide % period;
        const flapping = climbing || phase < 0.75 || flat < 6;
        this.flapRate = approach(this.flapRate, flapping ? 11 : 0, 0.15, dt);
        this.wingK = 1;
        this.tailK = approach(this.tailK, flat < 5 ? 1 : 0.35, 0.3, dt);
        if (dist < 1.2 && this.perch) {
          // Close enough: flare and settle onto the branch.
          this.state = 'alight';
          this.timer = 0;
          this.alightFrom = this.pos.clone();
          this.flapRate = 9;
        }
        if (!this.perch && this.timer > 12) { this.choosePerch(); if (!this.perch) { this.chooseDive(); this.state = 'descend'; this.timer = 0; } }
        break;
      }
      case 'alight': {
        // Braking with the wings forward and the tail fanned, feet reaching for the branch.
        const k = smoothstep(0, 1, Math.min(1, this.timer / 0.55));
        const pp = this.perchPoint();
        this.pos.lerpVectors(this.alightFrom, pp, k);
        this.pos.y += Math.sin(k * Math.PI) * 0.15;
        this.pitch = approach(this.pitch, 0.7, 0.15, dt);
        this.tailK = approach(this.tailK, 1, 0.15, dt);
        this.wingK = 1;
        this.flapRate = approach(this.flapRate, 6, 0.3, dt);
        if (k >= 1) {
          this.state = 'perch';
          this.timer = 0;
          this.perchTime = rnd(40, 90);
          this.vel.set(0, 0, 0);
        }
        break;
      }
      case 'perch': {
        // Sitting in the crown, picking buds: the head reaches and bobs; it settles its feathers.
        const pp = this.perchPoint();
        this.pos.copy(pp);
        this.pitch = approach(this.pitch, 0.1, 0.5, dt);
        this.wingK = approach(this.wingK, 0, 0.6, dt);
        this.tailK = approach(this.tailK, 0.25, 1, dt);
        this.flapRate = approach(this.flapRate, 0, 0.3, dt);
        this.headBob = Math.max(0, Math.sin(this.timer * 2.3) * 0.5 + Math.sin(this.timer * 0.7)) * 0.4;
        if (this.timer > this.perchTime) { this.chooseDive(); this.state = 'descend'; this.timer = 0; this.flapRate = 10; }
        break;
      }
      case 'descend': {
        // Down toward the chosen spot, then a folded-wing plunge into the snow.
        const to = this.dive.clone().sub(this.pos);
        const flat = Math.hypot(to.x, to.z);
        const dir = unit(v3(to.x, 0, to.z));
        const ahead = this.trunkAhead(dir, 5);
        const wantYaw = Math.atan2(-dir.z, dir.x) + (ahead && flat > 3 ? -ahead.side * 1.4 : 0);
        this.yaw += clamp(angleDiff(this.yaw, wantYaw), -2.2 * dt, 2.2 * dt);
        const fwd = v3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const plunge = flat < 2.5;
        const speed = plunge ? 6 : flat < 10 ? lerp(4, 9, smoothstep(2.5, 10, flat)) : 9;
        if (flat < 6) {
          // The last stretch is flown straight at the spot, the body turning to follow.
          this.vel.x = approach(this.vel.x, dir.x * speed, 0.15, dt);
          this.vel.z = approach(this.vel.z, dir.z * speed, 0.15, dt);
          this.yaw = Math.atan2(-this.vel.z, this.vel.x);
        } else {
          this.vel.x = approach(this.vel.x, fwd.x * speed, 0.3, dt);
          this.vel.z = approach(this.vel.z, fwd.z * speed, 0.3, dt);
        }
        const wantY = plunge ? this.dive.y - 0.3 : Math.max(this.dive.y + 1.5, this.pos.y - 3 * dt * 10);
        this.vel.y = approach(this.vel.y, plunge ? -5 : clamp((wantY - this.pos.y) * 1.5, -4, 2), 0.25, dt);
        this.pos.addScaledVector(this.vel, dt);
        this.pitch = approach(this.pitch, plunge ? -0.7 : -0.2, 0.25, dt);
        this.wingK = approach(this.wingK, plunge ? 0.15 : 1, 0.2, dt);
        this.flapRate = approach(this.flapRate, plunge ? 0 : 9, 0.2, dt);
        this.tailK = approach(this.tailK, 0.3, 0.3, dt);
        if (this.pos.y < s.height(this.pos.x, this.pos.z) - 0.05) {
          // In: a hole in the snow, a puff, and it is gone.
          this.roost.copy(this.dive);
          this.roost.y = s.height(this.roost.x, this.roost.z);
          s.snowpack.stampRoost(this.pos.x, this.pos.z, -this.yaw);
          s.puffs.burst(this.pos.x, this.roost.y, this.pos.z, 0.6, 0.25);
          this.state = 'roost';
          this.timer = 0;
          this.nextSelf = rnd(240, 480);
          this.root.visible = false;
        }
        break;
      }
    }
    if (this.state === 'roost') { this.nextSelf = this.nextSelf ?? rnd(240, 480); return; }
    this.applyBody(dt);
  }

  /** Pose the body from the flight state: wings, tail, neck. */
  applyBody(dt) {
    this.flap += this.flapRate * dt * TAU;
    const beat = Math.sin(this.flap);
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.yaw, 0);
    this.body.rotation.z = this.pitch;
    for (const w of this.wings) {
      // Folded: along the flank, swept back. Spread: out to the side, beating up and down.
      const fold = 1 - this.wingK;
      const flapAngle = this.flapRate > 0.5 ? beat * 1.1 * Math.min(1, this.flapRate / 8) : 0.15;
      w.pivot.rotation.set(w.side * (-flapAngle * this.wingK), fold * w.side * 0.0, fold * 0.9, 'YZX');
      w.pivot.rotation.y = fold * w.side * -1.3;
      w.pivot.scale.set(1, 1, 1 - fold * 0.45);
      // The ghost trails the beat a quarter cycle behind to blur a fast wing.
      const fast = this.flapRate > 7;
      w.ghost.visible = fast;
      if (fast) {
        w.ghost.rotation.set(0, 0, 0);
        w.ghost.position.set(0, 0, 0);
        w.ghost.rotation.x = w.side * (-(Math.sin(this.flap - 1.2) - beat) * 1.1 * this.wingK);
      }
    }
    this.tailG.scale.set(1, 1, 0.3 + 0.7 * this.tailK);
    this.tailG.rotation.z = this.state === 'perch' ? -0.3 : this.tailK * 0.2;
    this.neck.rotation.z = this.state === 'perch' ? -0.3 - this.headBob : 0.2 - this.pitch * 0.6;
    this.head.rotation.z = this.state === 'perch' ? -this.headBob * 0.5 : 0;
    this.legs.visible = this.state === 'perch';
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
