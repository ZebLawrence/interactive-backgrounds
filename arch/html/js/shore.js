// Sandstone Arch — What stands on the shore: dark bushes and shrubs along the beach and the bank
// (tamarisk and rabbitbrush, silhouettes at night), blocks and cobbles, and the dust in the air.

import * as THREE from 'three';
import { TAU, rnd, clamp, lerp, smoothstep, fbm2, v3, quatAxis, Art } from './util.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { G, Q, FOG_HEAD, SHADOW_GLSL, LAYER, setLayers, patchMaterial, patchDepth } from './shaders.js';
import { groundHeight, shoreX } from './terrain.js';

// ---------------------------------------------------------------------------------------------
// Shrubs: feathery sprays on alpha cards round a few stems; by night they are shapes against
// the water, but they still catch the moon and sway in the breeze.
// ---------------------------------------------------------------------------------------------

function sprayCanvas() {
  return Art.image(512, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    const spray = (x0, y0, ang, len, depth) => {
      const x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
      ctx.strokeStyle = depth === 0 ? 'rgba(90,60,45,0.95)' : 'rgba(95,110,80,0.9)';
      ctx.lineWidth = depth === 0 ? 4 : 1.6;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      const n = depth === 0 ? 22 : 9;
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const px = lerp(x0, x1, t), py = lerp(y0, y1, t);
        if (depth < 1) {
          for (const s of [-1, 1]) spray(px, py, ang + s * rnd(0.5, 0.9), len * rnd(0.18, 0.32) * (1 - t * 0.5), depth + 1);
        } else {
          for (const s of [-1, 1]) {
            ctx.strokeStyle = `rgba(${100 + Math.floor(rnd(0, 40))},${125 + Math.floor(rnd(0, 40))},${85 + Math.floor(rnd(0, 30))},0.95)`;
            ctx.lineWidth = 2.2;
            ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(ang + s * 1.2) * 4, py + Math.sin(ang + s * 1.2) * 4); ctx.stroke();
          }
        }
      }
    };
    spray(w * 0.5, h * 0.98, -Math.PI / 2, h * 0.9, 0);
  });
}

export class Shrubs {
  constructor(rng) {
    this.group = new THREE.Group();
    this.texture = Art.texture(sprayCanvas());
    this.uniforms = { uTime: G.uTime, uWind: G.uWind };
    const vHead = `uniform float uTime; uniform vec3 uWind; ${Q}`;
    const vMain = `
      vec4 wpos = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float ph = wpos.x * 1.3 + wpos.z * 0.9;
      float sway = sin(uTime * q(0.5) + ph) * 0.5 + sin(uTime * q(1.3) + ph * 2.0) * 0.3;
      float tip = clamp(gPos.y, 0.0, 1.0);
      gPos.x += sway * 0.08 * tip * tip * (0.3 + uWind.z);
      gPos.z += sway * 0.05 * tip * tip * (0.3 + uWind.z);`;
    this.material = patchMaterial(new THREE.MeshStandardMaterial({ map: this.texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 }), {
      key: 'shrub', uniforms: this.uniforms, vHead, vMain,
    });
    this.depth = patchDepth({ key: 'shrub', uniforms: this.uniforms, vHead, vMain, fHead: 'uniform sampler2D map;', fDiscard: 'if (texture2D(map, vDUv).a < 0.5) discard;' });
    this.depth.onBeforeCompile = ((prev) => (sh) => { prev(sh); sh.uniforms.map = { value: this.texture }; })(this.depth.onBeforeCompile);
    this.stemMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3028, roughness: 0.9 });
    const card = new THREE.PlaneGeometry(1, 1.2, 1, 3);
    card.translate(0, 0.6, 0);
    // Along the left beach, from the bay to the cliff foot, thicker near the water; the near
    // bank is bare rock, as the picture has it.
    const shrubs = [];
    const R = (lo, hi) => lo + rng() * (hi - lo);
    for (let z = -56; z > -190; z -= R(3, 9)) {
      const sx = shoreX(z);
      const x = sx - R(1.5, 12);
      if (groundHeight(x, z) < 0.3) continue;
      shrubs.push({ x, z, h: R(1.2, 3.2), n: Math.round(R(26, 60)) });
    }
    const total = shrubs.reduce((s, t) => s + t.n, 0);
    this.mesh = new THREE.InstancedMesh(card, this.material, total);
    this.mesh.customDepthMaterial = this.depth;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    const dummy = new THREE.Object3D();
    let i = 0;
    for (const s of shrubs) {
      const base = groundHeight(s.x, s.z);
      for (let k = 0; k < 4; k++) {
        const a = rng() * TAU, lean = 0.25 + rng() * 0.35, L = s.h * (0.6 + rng() * 0.5);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.035, L, 6), this.stemMaterial);
        stem.position.set(s.x, base, s.z);
        stem.quaternion.copy(quatAxis(a, 0, 1, 0)).multiply(quatAxis(lean, 1, 0, 0));
        stem.translateY(L / 2);
        stem.frustumCulled = false;
        this.group.add(stem);
      }
      for (let k = 0; k < s.n; k++) {
        const a = rng() * TAU, r = Math.pow(rng(), 0.6) * s.h * 0.55, y = base + 0.3 + rng() * s.h * 0.9 * (1 - r / (s.h * 0.7));
        const size = 0.45 + rng() * 0.5;
        dummy.position.set(s.x + Math.cos(a) * r, y, s.z + Math.sin(a) * r);
        dummy.quaternion.copy(quatAxis(a + Math.PI / 2 + (rng() - 0.5) * 1.2, 0, 1, 0)).multiply(quatAxis((rng() - 0.5) * 1.4 + (r / s.h) * 0.8, 1, 0, 0));
        dummy.scale.set(size, size, size);
        dummy.updateMatrix();
        this.mesh.setMatrixAt(i++, dummy.matrix);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.mesh);
    setLayers(this.group, LAYER.ABOVE);
    this.shrubs = shrubs;
  }

  dispose() { this.texture.dispose(); this.material.dispose(); this.depth.dispose(); this.stemMaterial.dispose(); this.group.traverse((o) => o.geometry?.dispose()); }
}

// ---------------------------------------------------------------------------------------------
// Blocks and cobbles along the shore and the bank, in the rock material.
// ---------------------------------------------------------------------------------------------

function blockGeometry(seed, ratio, detail = 4) {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail));
  const p = g.attributes.position;
  const n = v3();
  for (let i = 0; i < p.count; i++) {
    n.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    const r = 1 / Math.pow(Math.abs(n.x) ** 5 + Math.abs(n.y / ratio) ** 5 + Math.abs(n.z / 0.85) ** 5, 1 / 5);
    const rough = 1 + (fbm2(n.x * 2.5 + seed, n.y * 2.5 + n.z * 1.7 + seed * 3, 3) - 0.5) * 0.3;
    p.setXYZ(i, n.x * r * rough, n.y * r * rough, n.z * r * rough);
  }
  g.computeVertexNormals();
  return g;
}

export class Blocks {
  constructor(rng, material) {
    this.group = new THREE.Group();
    this.geometries = [blockGeometry(1.1, 0.6), blockGeometry(3.7, 0.8), blockGeometry(6.2, 0.5)];
    this.list = [];
    const R = (lo, hi) => lo + rng() * (hi - lo);
    const place = (x, z, size, yScale) => {
      const geo = this.geometries[Math.floor(rng() * this.geometries.length)];
      const mesh = new THREE.Mesh(geo, material);
      const y = groundHeight(x, z);
      mesh.position.set(x, y + size * yScale * 0.3, z);
      mesh.rotation.set(R(-0.25, 0.25), R(0, TAU), R(-0.25, 0.25));
      mesh.scale.set(size, size * yScale, size * R(0.8, 1.2));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      setLayers(mesh, LAYER.ABOVE, LAYER.BELOW);
      this.group.add(mesh);
      this.list.push({ x, z, size, y });
    };
    // The near bank: blocks and cobbles at the viewer's feet and at the frame edges.
    for (let k = 0; k < 40; k++) {
      const z = R(-20, 2), x = R(-16, 6 + z * 0.3);
      if (Math.hypot(x, z) < 1.5 || groundHeight(x, z) < 0.2) continue;
      place(x, z, R(0.15, 0.9), R(0.5, 0.8));
    }
    // Along the beach and at the cliff's foot: fallen blocks, bigger toward the cliff.
    for (let k = 0; k < 70; k++) {
      const z = R(-10, -190);
      const x = shoreX(z) - R(-1, 14);
      if (groundHeight(x, z) < 0.1) continue;
      place(x, z, R(0.3, 1.5 + 2 * smoothstep(-60, -160, z)), R(0.5, 0.8));
    }
  }

  dispose() { for (const g of this.geometries) g.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Dust puffs and water drops: a small pool of sprites.
// ---------------------------------------------------------------------------------------------

export class Puffs {
  constructor(max = 500, tint = [0.7, 0.45, 0.3]) {
    this.max = max;
    this.tint = new THREE.Vector3(...tint);
    this.pos = new Float32Array(max * 3);
    this.attr = new Float32Array(max * 2);
    this.p = [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAttr', new THREE.BufferAttribute(this.attr, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.texture = Art.texture(Art.blob(128, 0.2));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture }, uTint: { value: this.tint }, uSkyLight: G.uSkyLight, uKeyColor: G.uKeyColor, uKeyI: G.uKeyI, uPixelRatio: { value: 1 }, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar },
      transparent: true, depthWrite: false,
      vertexShader: `
        attribute vec2 aAttr; uniform float uPixelRatio, uKeyI; uniform vec3 uSkyLight, uKeyColor, uTint;
        varying float vAlpha; varying vec3 vCol; varying float vDist;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = length(mv.xyz);
          vDist = dist;
          gl_PointSize = clamp(aAttr.x * 900.0 / dist * uPixelRatio, 1.0, 400.0);
          vAlpha = aAttr.y;
          vCol = uTint * (uSkyLight * 2.0 + uKeyColor * uKeyI * 0.3);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; varying float vAlpha; varying vec3 vCol; varying float vDist;
        ${FOG_HEAD}
        void main() {
          float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
          gl_FragColor = vec4(applyFog(vCol, vDist), a);
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 15;
    this.points.layers.enable(LAYER.ABOVE);
  }

  burst(at, n, size, vel = null) {
    const drop = this.tint.x > 1.0;
    for (let i = 0; i < n && this.p.length < this.max; i++) {
      const dir = v3(rnd(-1, 1), rnd(-0.3, 1), rnd(-1, 1)).normalize();
      this.p.push({ pos: at.clone().add(dir.clone().multiplyScalar(rnd(0, size * 0.3))), vel: dir.multiplyScalar(rnd(0.3, 1.6) * size).add(vel || v3()), age: 0, life: drop ? rnd(0.8, 1.6) : rnd(2.5, 6) * (0.6 + size), size: (drop ? rnd(0.06, 0.14) : rnd(0.2, 0.5)) * size });
    }
  }

  update(dt) {
    const drop = this.tint.x > 1.0;
    const alive = [];
    for (const q of this.p) {
      q.age += dt;
      if (q.age > q.life) continue;
      q.vel.multiplyScalar(Math.exp(-dt * (drop ? 0.4 : 1.6)));
      q.vel.y += (drop ? -9.81 : (0.05 - q.vel.y * 0.3)) * dt;
      if (drop && q.pos.y < 0.02 && q.vel.y < 0) continue;
      q.pos.addScaledVector(q.vel, dt);
      alive.push(q);
    }
    this.p = alive;
    alive.forEach((q, i) => {
      const f = q.age / q.life;
      this.pos.set([q.pos.x, q.pos.y, q.pos.z], i * 3);
      this.attr.set([drop ? q.size : q.size * (1 + f * 2.5), (drop ? 0.9 : 0.45) * (1 - f) * smoothstep(0, 0.1, f)], i * 2);
    });
    const geo = this.points.geometry;
    geo.setDrawRange(0, alive.length);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAttr.needsUpdate = true;
  }

  setPixelRatio(r) { this.material.uniforms.uPixelRatio.value = r; }
  dispose() { this.points.geometry.dispose(); this.material.dispose(); this.texture.dispose(); }
}
