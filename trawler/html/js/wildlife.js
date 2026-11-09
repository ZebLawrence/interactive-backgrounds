// Trawler — What else is out there. A background that only has weather in it is a screensaver;
// what makes a sea feel like a sea is that things are living in it and getting on with their own
// business while you watch (guidelines section 1: "they just sit there" is a bug).
//
// **Porpoises** ride the pressure wave in front of a moving hull. They come up in twos and threes,
// blow, and go down again on a cycle of twenty seconds or so, and they will stay with a boat for
// half an hour. They come over when the cursor comes to rest — the owner's second cursor verb.
//
// **Rain** is the third thing here because it is the same kind of object: a few thousand streaks
// kept in a box round the camera, recycled as they fall out of it.
//
// **Channel marks** are not alive, but they belong with the rest: they are the things out there
// that are not the boat, the sea or the land, and they have to be put somewhere
// and kept there while she moves.

import * as THREE from 'three';
import { G, LAYER, ATMOS_READ } from './shaders.js';
import { paint } from './materials.js';
import { patchPropShader } from './pilot.js';
import { v3, clamp, clamp01, lerp, smoothstep, approach, angleDiff, TAU, DEG, Art } from './util.js';

// =============================================================================================
// Porpoises
// =============================================================================================

/** A harbour porpoise: a blunt spindle with a small triangular fin and a tail. */
function porpoiseGeometry() {
  const skin = paint(0x2f3a40, 0.46, 0);
  const pale = paint(0xb9c0c2, 0.5, 0);
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 12), skin);
  body.scale.set(1, 1.0, 3.6);
  g.add(body);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.195, 16, 12), pale);
  belly.scale.set(0.96, 0.6, 3.3);
  belly.position.y = -0.085;
  g.add(belly);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.17, 3), skin);
  fin.rotation.x = -0.25;
  fin.position.set(0, 0.2, 0.02);
  fin.scale.set(1, 1, 0.42);
  g.add(fin);
  const tail = new THREE.Group();
  tail.position.set(0, 0, 0.66);
  const fluke = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.022, 0.16), skin);
  fluke.position.set(0, 0, 0.1);
  tail.add(fluke);
  g.add(tail);
  return { group: g, tail, materials: [skin, pale] };
}

export class Porpoises {
  constructor(scene, rng, count = 5) {
    this.scene = scene;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    scene.add(this.group);
    this.pods = [];
    this.interest = 0;
    this.materials = null;
    for (let i = 0; i < count; i++) {
      const built = porpoiseGeometry();
      this.materials ??= built.materials;
      built.group.visible = false;
      built.group.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.WORLD); });
      this.group.add(built.group);
      this.pods.push({
        obj: built.group, tail: built.tail,
        lane: rng.range(-1, 1), along: rng.range(-4, 3),
        cycle: rng.range(0, 1), period: rng.range(11, 22),
        phase: rng.range(0, TAU),
      });
    }
  }

  /** The resting cursor brings them over; they lose interest again when it moves. */
  setInterest(x) { this.want = clamp01(x); }

  step(dt, boat, weather) {
    // They ride the bow wave of a boat that is actually moving, and they go off when she stops.
    const moving = clamp01((boat.speedKnots - 2.2) / 3);
    this.interest = approach(this.interest, Math.min(this.want ?? 0, moving), 6, dt);
    const show = this.interest > 0.03;
    for (const p of this.pods) {
      p.obj.visible = show;
      if (!show) continue;
      p.cycle += dt / p.period;
      const c = p.cycle % 1;
      // The dive: up, blow, over and down, and a long while under.
      const surface = Math.max(0, Math.sin(Math.PI * clamp01(c / 0.28)));
      const side = p.lane * (2.4 + 1.1 * Math.sin(p.phase + boat.ocean.time * 0.3));
      const along = -9.5 + p.along + Math.sin(p.phase * 1.7 + boat.ocean.time * 0.21) * 1.4;
      const world = boat.toWorld(side, 0, along);
      const sea = boat.ocean.sample(world.x, world.z);
      // The arc out of the water: at the top of it she is nearly clear.
      const rise = surface * 0.62 * this.interest;
      p.obj.position.set(world.x, sea.h - 0.30 + rise, world.z);
      const heading = boat.heading;
      const pitch = Math.cos(Math.PI * clamp01(c / 0.28)) * surface * 0.55;
      p.obj.rotation.set(pitch, -heading, side * -0.05, 'YXZ');
      p.obj.scale.setScalar(lerp(0.75, 1.05, clamp01(this.interest)));
      // The fluke drives her: up and down, faster when she is going up.
      p.tail.rotation.x = Math.sin(boat.ocean.time * 6.5 + p.phase) * (0.25 + 0.35 * surface);
    }
  }

  dispose() {
    this.group.traverse((o) => o.geometry?.dispose?.());
    for (const m of this.materials ?? []) m.dispose();
    this.scene.remove(this.group);
  }
}

// =============================================================================================
// Rain
// =============================================================================================

const RAIN_VERT = /* glsl */ `
attribute vec3 streak;      // fall speed, length, brightness
uniform vec3 uCamPos;
uniform vec3 uBox;
uniform float uTime;
uniform vec3 uWind;
uniform mat4 uHouseInv;   // world -> boat, so the house's own box can be tested
uniform vec3 uHouseMid;
uniform vec3 uHouseHalf;
varying float vBright;
void main() {
  // Each drop lives in a box that follows the camera, and simply wraps when it falls out of it.
  vec3 p = position;
  p.y -= uTime * streak.x;
  p += uWind * uTime;
  p = mod( p - uCamPos + uBox * 0.5, uBox ) + uCamPos - uBox * 0.5;
  // The streak is drawn as a line segment: two vertices a drop-length apart along the fall.
  vec3 fall = normalize( vec3( uWind.x, -streak.x, uWind.z ) );
  p += fall * streak.y * uv.y;
  vBright = streak.z;
  // The camera stands inside the house, and nothing in there writes depth in front of a drop:
  // without this the rain falls through the deckhead, across the console and past the helmsman's
  // own hands. So the drop is carried back into the boat's frame and any part of it that is inside
  // the wheelhouse is faded out over the last ten centimetres, which is about a pane's thickness.
  vec3 q = abs( ( uHouseInv * vec4( p, 1.0 ) ).xyz - uHouseMid ) - uHouseHalf;
  vBright *= smoothstep( -0.10, 0.02, max( max( q.x, q.y ), q.z ) );
  gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
}
`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vBright;
void main() {
  gl_FragColor = vec4( uColor, vBright * uOpacity );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Rain {
  constructor(scene, rng, count = 4200) {
    this.scene = scene;
    this.box = v3(70, 36, 70);
    const pos = new Float32Array(count * 2 * 3);
    const uv = new Float32Array(count * 2 * 2);
    const streak = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) {
      const x = rng.range(0, this.box.x), y = rng.range(0, this.box.y), z = rng.range(0, this.box.z);
      const fall = rng.range(7, 11);
      const len = rng.range(0.6, 1.9);
      const bright = rng.range(0.25, 0.8);
      for (let v = 0; v < 2; v++) {
        const k = (i * 2 + v) * 3;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        streak[k] = fall; streak[k + 1] = len; streak[k + 2] = bright;
        uv[(i * 2 + v) * 2] = 0;
        uv[(i * 2 + v) * 2 + 1] = v;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('streak', new THREE.BufferAttribute(streak, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCamPos: { value: v3() },
        uBox: { value: this.box },
        uTime: { value: 0 },
        uWind: { value: v3() },
        uColor: { value: v3(0.62, 0.70, 0.78) },
        uOpacity: { value: 0 },
        uHouseInv: { value: new THREE.Matrix4() },
        uHouseMid: { value: v3(0, 5.07, 0.18) },
        uHouseHalf: { value: v3(1.70, 1.07, 1.58) },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 830;
    this.lines.layers.set(LAYER.DEFAULT);
    this.lines.layers.enable(LAYER.WORLD);
    scene.add(this.lines);
  }

  /**
   * The wheelhouse, so the rain can be kept out of it. The group is the boat's own frame; mid and
   * half are the inside of the house measured in that frame, out to the glass but not past it.
   */
  useHouse(group, mid, half) {
    this.house = group;
    this.material.uniforms.uHouseMid.value.copy(mid);
    this.material.uniforms.uHouseHalf.value.copy(half);
  }

  step(dt, camera, rain, wind, u10) {
    const u = this.material.uniforms;
    u.uTime.value = (u.uTime.value + dt) % 600;
    u.uCamPos.value.copy(camera.position);
    if (this.house) {
      this.house.updateWorldMatrix(true, false);
      u.uHouseInv.value.copy(this.house.matrixWorld).invert();
    }
    // Rain goes nearly sideways in a gale, which is most of what makes a gale look like one.
    u.uWind.value.set(wind.x * u10 * 0.45, 0, wind.y * u10 * 0.45);
    u.uOpacity.value = clamp01(rain) * 0.5;
    this.lines.visible = u.uOpacity.value > 0.004;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.lines);
  }
}

// =============================================================================================
// Channel marks
// =============================================================================================

/**
 * The moored navigation marks on the edges of the shoals. These are the one thing in a fjord that
 * says somebody works these waters: without them the islands are scenery, and with them the water
 * between the islands is a channel that a boat is picking her way along.
 *
 * Four of them follow her about. A mark that has fallen more than three kilometres astern is
 * re-sited on a shoal ahead of her, so there is nearly always one in sight without the scene
 * having to carry a chart of the whole archipelago. A site is a point where the chart says there
 * are between five and twenty-two metres — a shoal a boat would want warning of — with water over
 * thirty metres within a hundred and fifty metres of it, which is the deep side a mark is laid on.
 *
 * A mark floats: its height comes from the same long-wave sea the hull rides, and it leans with
 * the local slope, damped, because a mark on a chain leans less than the water under it. At night
 * its light flashes — three seconds for the green starboard-hand marks, four for the red port-hand
 * ones, which is close enough to the real rhythm of a Norwegian lead to feel right.
 */
const _lampPos = new THREE.Vector3();

export class SeaMarks {
  constructor(scene, rng, count = 4) {
    this.scene = scene;
    this.rng = rng;
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    scene.add(this.group);
    this.models = new Map();
    this.marks = [];
    for (let i = 0; i < count; i++) {
      this.marks.push({
        obj: null, kind: i % 2 ? 'buoy' : 'seamark', side: i % 2 ? 1 : -1,
        x: 0, z: 0, sited: false, lamp: null, lean: v3(),
        period: i % 2 ? 3.0 : 4.0, phase: rng.range(0, 1),
      });
    }
  }

  /** A loaded mark model; both of them are used, half the marks each. */
  setModel(name, model) {
    if (name !== 'buoy' && name !== 'seamark') return;
    this.models.set(name, model);
    for (const m of this.marks) if (!m.obj && m.kind === name) this.build(m, model);
  }

  build(mark, model) {
    const obj = model.clone(true);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      // Nothing out here is close enough for its own shadow to be worth a shadow map pass.
      o.castShadow = false;
      o.receiveShadow = false;
      if (o.material) {
        o.material = o.material.clone();
        o.material.fog = true;
        o.material.onBeforeCompile = (shader) => { patchPropShader(shader); };
        o.material.needsUpdate = true;
      }
    });
    const bounds = new THREE.Box3().setFromObject(obj);
    // The light on top: a lens drawn at a brightness on the screen, like the boat's own nav lights,
    // so it is divided by whatever exposure the camera has adapted to.
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), new THREE.MeshStandardMaterial({
      color: 0x101010, roughness: 0.3,
      emissive: mark.side > 0 ? 0x14ff5a : 0xff2a18, emissiveIntensity: 0,
    }));
    lamp.position.set(0, bounds.max.y + 0.12, 0);
    obj.add(lamp);
    mark.lamp = lamp;
    mark.obj = obj;
    obj.visible = false;
    obj.traverse((o) => { o.layers.set(LAYER.DEFAULT); o.layers.enable(LAYER.WORLD); });
    this.group.add(obj);
  }

  /** The render origin moved: the marks are the only things out here that remember where they are. */
  shift(dx, dz) {
    for (const m of this.marks) { m.x -= dx; m.z -= dz; }
  }

  /**
   * Looks for somewhere to lay a mark: a shoal ahead of her with deep water beside it. Returns
   * false if nothing within two kilometres will do, which happens out in open water and simply
   * means no mark that side.
   *
   * The arc is walked outward rather than sampled at random, so the first site that will do is the
   * nearest one — a mark two kilometres off is four pixels across, and the whole point of them is
   * that she passes close by. Only about one point in forty along this coast is shoal, so it takes
   * a couple of hundred tries; each one is a lookup in the chart that is already in memory.
   */
  site(mark, boat, depthAt) {
    const heading = boat.heading;
    const tries = 240;
    for (let i = 0; i < tries; i++) {
      const bearing = heading + this.rng.range(-1.4, 1.4);
      const range = 280 + (i / tries) * 1900 + this.rng.range(-50, 50);
      const x = boat.position.x + Math.sin(bearing) * range;
      const z = boat.position.z - Math.cos(bearing) * range;
      const d = depthAt(x, z);
      if (!(d > 4 && d < 30)) continue;
      // The deep side: a mark is laid where a boat can pass it, not on top of the shoal. Four
      // bearings round it, and one of them has to have water a boat could pass in.
      let deep = false;
      for (let k = 0; k < 4 && !deep; k++) {
        const a = k * (TAU / 4) + 0.4;
        deep = depthAt(x + Math.cos(a) * 170, z + Math.sin(a) * 170) > 35;
      }
      if (!deep) continue;
      mark.x = x;
      mark.z = z;
      mark.sited = true;
      return true;
    }
    return false;
  }

  step(dt, boat, depthAt, night, emissiveScale = 1, time = 0) {
    for (const m of this.marks) {
      if (!m.obj) continue;
      const dx = m.x - boat.position.x, dz = m.z - boat.position.z;
      if (!m.sited || dx * dx + dz * dz > 3000 * 3000) {
        m.sited = false;
        this.site(m, boat, depthAt);
      }
      m.obj.visible = m.sited;
      if (!m.sited) continue;
      const sea = boat.ocean.sample(m.x, m.z);
      m.obj.position.set(m.x, sea.h, m.z);
      // A mark on a chain leans, but less than the water does and a beat behind it.
      m.lean.x = lerp(m.lean.x, Math.atan(sea.sz) * 0.55, 1 - Math.exp(-dt / 0.9));
      m.lean.z = lerp(m.lean.z, -Math.atan(sea.sx) * 0.55, 1 - Math.exp(-dt / 0.9));
      m.obj.rotation.set(m.lean.x, 0, m.lean.z);
      // The flash: a short light and a long dark, the rhythm a lead is marked with. The lit value
      // is a brightness on the screen and it stays under white: a mark two kilometres off covers
      // about a pixel, and a pixel over white is what the bloom turns into a square.
      const t = ((time / m.period) + m.phase) % 1;
      const on = t < 0.16 ? 1 : 0;
      m.lamp.material.emissiveIntensity = night * on * 0.8 * emissiveScale;
    }
    // Hand the lights to the sea, which glitters under them (ocean.js). The strength is a screen
    // brightness scaled by distance squared in the shader; 800 puts a mark's streak at a few
    // hundred metres where the eye expects it, well short of white.
    this.marks.forEach((m, i) => {
      if (i >= 4) return;
      const u = G.uMarkLamps.value[i];
      if (!m.obj || !m.sited || !m.obj.visible) { u.w = 0; return; }
      m.lamp.getWorldPosition(_lampPos);
      u.set(_lampPos.x, _lampPos.y, _lampPos.z, m.lamp.material.emissiveIntensity * 800 / 0.8);
      G.uMarkLampColor.value[i].set(m.lamp.material.emissive.r, m.lamp.material.emissive.g, m.lamp.material.emissive.b);
    });
  }

  dispose() {
    for (const m of this.marks) {
      m.obj?.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      if (m.obj) this.group.remove(m.obj);
    }
    this.scene.remove(this.group);
  }
}
