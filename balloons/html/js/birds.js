// Balloon Dawn — A flock of swallows over the hillside: boids that scatter from a fast cursor and
// wheel around a resting one, drawn as one instanced mesh with wings that flap in the shader.

import * as THREE from 'three';
import { TAU, clamp, rnd, v3, unit } from './util.js';
import { G, Q, FOG_HEAD } from './shaders.js';

export class Flock {
  constructor(valley, count) {
    this.valley = valley;
    this.birds = [];
    const base = v3(rnd(-60, 60), 0, rnd(-140, -90));
    base.y = valley.groundHeight(base.x, base.z) + 60;
    for (let i = 0; i < count; i++) {
      const pos = base.clone().add(v3(rnd(-25, 25), rnd(-10, 10), rnd(-25, 25)));
      this.birds.push({ pos, vel: v3(rnd(-1, 1), rnd(-0.2, 0.2), rnd(-1, 1)).normalize().multiplyScalar(9), phase: rnd(0, TAU), flapRate: rnd(9, 13) });
    }
    this.buildMesh();
  }

  buildMesh() {
    // A bird: a body and two wings, built from triangles. aWing is 0 on the body and ±1 at a wing tip.
    const pos = [], wing = [];
    const tri = (a, b, c, w) => { pos.push(...a, ...b, ...c); wing.push(w[0], w[1], w[2]); };
    tri([0, 0, 0.55], [-0.1, 0, -0.35], [0.1, 0, -0.35], [0, 0, 0]);
    tri([-0.08, 0, 0.25], [-0.08, 0, -0.12], [-0.8, 0.02, -0.02], [0, 0, -1]);
    tri([0.08, 0, 0.25], [0.8, 0.02, -0.02], [0.08, 0, -0.12], [0, 1, 0]);
    tri([-0.1, 0, -0.35], [-0.22, 0, -0.62], [0.0, 0, -0.5], [0, 0, 0]);
    tri([0.1, 0, -0.35], [0.0, 0, -0.5], [0.22, 0, -0.62], [0, 0, 0]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
    const n = this.birds.length;
    this.aPos = new Float32Array(n * 3);
    this.aDir = new Float32Array(n * 3);
    const phase = new Float32Array(n * 2);
    this.birds.forEach((b, i) => phase.set([b.phase, b.flapRate], i * 2));
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(this.aDir, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFlap', new THREE.InstancedBufferAttribute(phase, 2));
    geo.instanceCount = n;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uNight: G.uNight, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar },
      side: THREE.DoubleSide,
      vertexShader: `
        attribute float aWing; attribute vec3 aPos; attribute vec3 aDir; attribute vec2 aFlap;
        uniform float uTime;
        varying float vDist; varying float vLight;
        ${Q}
        void main() {
          vec3 f = length(aDir) > 1e-4 ? normalize(aDir) : vec3(0.0, 0.0, -1.0);
          vec3 r = cross(f, vec3(0.0, 1.0, 0.0));
          r = length(r) > 1e-3 ? normalize(r) : vec3(1.0, 0.0, 0.0);
          vec3 u = cross(r, f);
          float flap = sin(uTime * q(aFlap.y) + aFlap.x);
          vec3 local = position * 1.5;
          // Wings beat: the tips rise and fall, folding a little inward on the upstroke.
          local.y += abs(aWing) * flap * 0.9;
          local.x *= 1.0 - abs(aWing) * max(flap, 0.0) * 0.25;
          vec3 p = aPos + r * local.x + u * local.y + f * local.z;
          vLight = 0.5 + 0.5 * flap;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uNight; varying float vDist; varying float vLight;
        ${FOG_HEAD}
        void main() {
          vec3 c = mix(vec3(0.05, 0.045, 0.06), vec3(0.012, 0.012, 0.02), uNight) * (0.8 + 0.4 * vLight);
          gl_FragColor = vec4(applyFog(c, vDist), 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  update(dt, valley) {
    const birds = this.birds;
    const cursor = valley.cursor;
    const centre = v3();
    for (const b of birds) centre.add(b.pos);
    centre.divideScalar(birds.length);
    const ground = valley.groundHeight(centre.x, centre.z);
    // A resting cursor draws the flock to wheel around the point 120 m out along its line of sight.
    let attractor = null;
    if (cursor.present && cursor.stillTime > 1.2) {
      const { origin, dir } = valley.ray(cursor.screen);
      attractor = origin.clone().addScaledVector(dir, 130);
      attractor.y = Math.max(attractor.y, valley.groundHeight(attractor.x, attractor.z) + 20);
    }
    const fast = cursor.present && cursor.speed > 400;
    for (const b of birds) {
      const acc = v3();
      let near = 0;
      const coh = v3(), ali = v3(), sep = v3();
      for (const o of birds) {
        if (o === b) continue;
        const d = b.pos.distanceTo(o.pos);
        if (d > 18) continue;
        near++;
        coh.add(o.pos);
        ali.add(o.vel);
        if (d < 5) sep.add(b.pos.clone().sub(o.pos).multiplyScalar((5 - d) / Math.max(d, 0.1)));
      }
      if (near) {
        acc.add(coh.divideScalar(near).sub(b.pos).multiplyScalar(0.12));
        acc.add(ali.divideScalar(near).sub(b.vel).multiplyScalar(0.6));
        acc.add(sep.multiplyScalar(4));
      }
      // Keep to the air over the hillside.
      const lo = ground + 25, hi = ground + 130;
      if (b.pos.y < lo) acc.y += (lo - b.pos.y) * 0.6;
      if (b.pos.y > hi) acc.y -= (b.pos.y - hi) * 0.6;
      const lim = 220;
      if (Math.abs(b.pos.x) > lim) acc.x -= Math.sign(b.pos.x) * (Math.abs(b.pos.x) - lim) * 0.15;
      if (b.pos.z > -50) acc.z -= (b.pos.z + 50) * 0.15;
      if (b.pos.z < -360) acc.z += (-360 - b.pos.z) * 0.15;
      // The cursor: wheel around a resting one, scatter from a fast one.
      if (attractor) {
        const to = attractor.clone().sub(b.pos);
        const dist = to.length();
        const tangent = v3(0, 1, 0).cross(to).normalize();
        acc.addScaledVector(to.normalize(), clamp((dist - 25) * 0.12, -4, 4));
        acc.addScaledVector(tangent, 3);
      }
      if (fast) {
        const scr = valley.project(b.pos);
        const dpx = Math.hypot(scr.x - cursor.screen.x, scr.y - cursor.screen.y);
        const radius = (160 + Math.min(cursor.speed, 2500) * 0.1) / (1 + scr.depth / 200);
        if (dpx < radius) acc.addScaledVector(unit(b.pos.clone().sub(valley.closestPointOnCursorRay(b.pos))), 40);
      }
      // A little wander so the flock never settles into a lattice.
      acc.add(v3(rnd(-1, 1), rnd(-0.4, 0.4), rnd(-1, 1)).multiplyScalar(2.5));
      b.vel.addScaledVector(acc, dt);
      // Never dive or climb vertically: the wings need a horizontal heading.
      const horiz = Math.hypot(b.vel.x, b.vel.z);
      if (horiz < 2) { b.vel.x += (b.vel.x >= 0 ? 2 : -2) - b.vel.x * 0.5; }
      b.vel.y = clamp(b.vel.y, -0.6 * Math.max(horiz, 2), 0.6 * Math.max(horiz, 2));
      const speed = b.vel.length();
      if (speed > 16) b.vel.multiplyScalar(16 / speed);
      if (speed < 7) b.vel.multiplyScalar(7 / Math.max(speed, 0.01));
      b.pos.addScaledVector(b.vel, dt);
    }
    birds.forEach((b, i) => {
      this.aPos.set([b.pos.x, b.pos.y, b.pos.z], i * 3);
      this.aDir.set([b.vel.x, b.vel.y, b.vel.z], i * 3);
    });
    this.mesh.geometry.attributes.aPos.needsUpdate = true;
    this.mesh.geometry.attributes.aDir.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}
