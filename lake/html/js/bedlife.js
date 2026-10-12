// Loon Lake — What lies on the lake bed under the near water: rocks and boulders, beds of
// pondweed swaying in the slow current, and sunken branches. All of it is seen through the
// surface, so it is drawn in the refraction pass.

import * as THREE from 'three';
import { TAU, rnd, pick, clamp, fbm2, hash2, v3, Art } from './util.js';
import { G, Q, LAYER } from './shaders.js';
import { bedDepth, AO_REGION } from './water.js';

/** A rock texture: granite speckle with a few darker veins, tileable enough for small stones. */
function rockCanvas() {
  return Art.image(512, 512, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = x / w * TAU, b = y / h * TAU;
      const nx = Math.cos(a) * 2, ny = Math.sin(a) * 2, nz = Math.cos(b) * 2, nw = Math.sin(b) * 2;
      const n = fbm2(nx + nz * 0.7 + 3, ny + nw * 0.7, 4);
      const vein = Math.abs(fbm2(nx * 1.5 + nw, ny * 1.5 + nz + 9, 3) - 0.5);
      const grain = hash2(x, y);
      let v = 0.55 + 0.3 * n - 0.25 * Math.max(0, 0.06 - vein) / 0.06 + (grain - 0.5) * 0.25;
      // Feldspar flecks.
      if (grain > 0.985) v += 0.3;
      const i = (y * w + x) * 4;
      d[i] = clamp(v * 255, 0, 255); d[i + 1] = clamp((v - 0.02) * 255, 0, 255); d[i + 2] = clamp((v - 0.05) * 255, 0, 255); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Bark: vertical ridges and furrows. */
function barkCanvas() {
  return Art.image(256, 512, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = x / w * TAU;
      const ridge = fbm2(Math.cos(a) * 3 + 7, y / h * 6 + Math.sin(a) * 3, 3);
      const fine = fbm2(Math.cos(a) * 12, y / h * 40, 2);
      const v = 0.18 + 0.3 * ridge + 0.12 * fine;
      const i = (y * w + x) * 4;
      d[i] = v * 255 * 1.1; d[i + 1] = v * 255 * 0.85; d[i + 2] = v * 255 * 0.6; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** A lumpy rock: an icosphere pushed about by noise, with a flattish underside. */
function rockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 4);
  const p = g.attributes.position;
  const n = v3();
  for (let i = 0; i < p.count; i++) {
    n.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    const big = fbm2(n.x * 1.6 + seed, n.y * 1.6 + n.z * 1.1 + seed * 2, 3) - 0.5;
    const fine = fbm2(n.x * 5 + n.z * 3 + seed * 3, n.y * 5 + seed, 3) - 0.5;
    let r = 1 + big * 0.6 + fine * 0.12;
    // Sits on the bed: flatten the bottom.
    if (n.y < -0.3) r *= 1 - (-0.3 - n.y) * 0.5;
    p.setXYZ(i, n.x * r, n.y * r, n.z * r);
  }
  g.computeVertexNormals();
  return g;
}

const ROCK_TINTS = [[0.55, 0.53, 0.5], [0.6, 0.56, 0.5], [0.42, 0.43, 0.45], [0.5, 0.46, 0.4], [0.36, 0.37, 0.39], [0.66, 0.63, 0.58], [0.47, 0.5, 0.47], [0.58, 0.58, 0.6]];

export class BedLife {
  /**
   * @param {{ halfWidth(d: number): number }} layout
   * @param {{x: number, z: number, r: number}[]} stems  where reed stems meet the bed, for the contact map
   */
  constructor(layout, stems = []) {
    this.group = new THREE.Group();
    this.disposables = [];
    // The contact-occlusion map: a dark soft ring around everything that sits on the bed. Row 0
    // of the canvas is the far edge; the texture flips on upload, so v runs from z0 at the bottom.
    this.aoCanvas = Art.image(2048, Math.round(2048 * AO_REGION.d / AO_REGION.w), (ctx, w, h) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); });
    const aoCtx = this.aoCanvas.getContext('2d');
    const px = 2048 / AO_REGION.w;
    const contact = (x, z, r, strength) => {
      const cx = (x - AO_REGION.x0) * px, cy = (AO_REGION.z0 + AO_REGION.d - z) * px;
      const g = aoCtx.createRadialGradient(cx, cy, r * px * 0.6, cx, cy, r * px * 1.7);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(0.45, `rgba(0,0,0,${strength * 0.45})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      aoCtx.fillStyle = g;
      aoCtx.fillRect(cx - r * px * 1.7, cy - r * px * 1.7, r * px * 3.4, r * px * 3.4);
    };
    for (const s of stems) contact(s.x, s.z, s.r, 0.35);
    const hw = (z) => layout.halfWidth(-z) * 1.05 + 1;
    const onBed = (x, z) => -bedDepth(Math.min(z, -0.01));

    // Rocks: a scatter of cobbles, a few boulders, denser in the shallows.
    this.rockTex = Art.texture(rockCanvas(), { repeat: true });
    const rockMat = new THREE.MeshStandardMaterial({ map: this.rockTex, roughness: 0.92, metalness: 0.02 });
    this.disposables.push(this.rockTex, rockMat);
    const placements = [];
    for (let k = 0; k < 220; k++) {
      const z = -1.2 - Math.pow(Math.random(), 1.3) * 24;
      const x = rnd(-1, 1) * hw(z);
      // Boulders only farther out, where they do not fill the bottom of the frame.
      const boulder = z < -6 && Math.random() < 0.07;
      const s = boulder ? rnd(0.28, 0.5) : rnd(0.04, 0.2);
      placements.push({ x, z, s, boulder });
      contact(x, z, s * 1.05, boulder ? 0.75 : 0.6);
    }
    const groups = [[], [], []];
    placements.forEach((r, i) => groups[i % 3].push(r));
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    groups.forEach((list, gi) => {
      const geo = rockGeometry(gi * 7.3 + 1);
      this.disposables.push(geo);
      const mesh = new THREE.InstancedMesh(geo, rockMat, list.length);
      list.forEach((r, i) => {
        const sy = r.s * rnd(0.5, 0.8), sx = r.s * rnd(0.8, 1.3), sz = r.s * rnd(0.8, 1.3);
        dummy.position.set(r.x, onBed(r.x, r.z) + sy * 0.3, r.z);
        dummy.rotation.set(rnd(-0.15, 0.15), rnd(0, TAU), rnd(-0.15, 0.15));
        dummy.scale.set(sx, sy, sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const t = pick(ROCK_TINTS);
        const shade = rnd(0.8, 1.1);
        col.setRGB(t[0] * shade, t[1] * shade, t[2] * shade, THREE.SRGBColorSpace);
        mesh.setColorAt(i, col);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER.BELOW);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    });

    // Pondweed: ribbons of eelgrass in beds, never taller than the water over them, swaying in
    // the slow drift along the shore.
    const blades = [];
    for (let b = 0; b < 26; b++) {
      const z = -rnd(2, 20), x = rnd(-0.9, 0.9) * hw(z), r = rnd(0.5, 1.6);
      const count = Math.round(rnd(18, 50));
      const tone = Math.random();
      contact(x, z, r * 0.8, 0.18);
      for (let i = 0; i < count; i++) {
        const a = rnd(0, TAU), d = Math.sqrt(Math.random()) * r;
        const bx = x + Math.cos(a) * d, bz = z + Math.sin(a) * d;
        const depth = bedDepth(Math.min(bz, -0.01));
        const h = Math.min(rnd(0.3, 1.1), depth * rnd(0.55, 0.9));
        blades.push({ x: bx, z: bz, y: onBed(bx, bz), h, w: rnd(0.008, 0.016), yaw: rnd(0, TAU), phase: rnd(0, TAU), tone: clamp(tone + rnd(-0.2, 0.2), 0, 1) });
      }
    }
    const rows = 10;
    const pos = [], uv = [], idx = [];
    for (let r = 0; r <= rows; r++) { const t = r / rows; pos.push(-0.5, t, 0, 0.5, t, 0); uv.push(0, t, 1, t); }
    for (let r = 0; r < rows; r++) { const a = r * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const wg = new THREE.InstancedBufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    wg.setIndex(idx);
    const n = blades.length;
    const inst = new Float32Array(n * 4), inst2 = new Float32Array(n * 4);
    blades.forEach((s, i) => { inst.set([s.x, s.y, s.z, s.h], i * 4); inst2.set([s.w, s.yaw, s.phase, s.tone], i * 4); });
    wg.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 4));
    wg.setAttribute('aInst2', new THREE.InstancedBufferAttribute(inst2, 4));
    wg.instanceCount = n;
    this.weedMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime, uNight: G.uNight },
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec4 aInst, aInst2;
        uniform float uTime;
        varying vec2 vUv; varying float vTone, vDepth; varying vec3 vN;
        ${Q}
        void main() {
          vec3 base = aInst.xyz; float h = aInst.w;
          float w = aInst2.x, yaw = aInst2.y, phase = aInst2.z; vTone = aInst2.w;
          float t = position.y;
          // The drift: a slow wave passing along the shore, each ribbon waving a beat apart.
          float s1 = sin(uTime * q(0.22) + base.x * 0.5 + phase) * 0.22 + sin(uTime * q(0.5) + phase * 2.1) * 0.08;
          float s2 = cos(uTime * q(0.17) + base.z * 0.4 + phase * 0.7) * 0.12;
          vec2 lean = vec2(s1, s2) * t * t;
          vec3 p = base + vec3(lean.x * h, h * t * (1.0 - 0.3 * dot(lean, lean)), lean.y * h);
          vec3 across = vec3(cos(yaw), 0.0, sin(yaw));
          // Ribbons taper to a rounded tip and curl a little across their width.
          float taper = 1.0 - smoothstep(0.75, 1.0, t) * 0.9;
          p += across * position.x * w * taper;
          vec3 up = vec3(2.0 * lean.x * h / max(t, 0.05), h, 2.0 * lean.y * h / max(t, 0.05));
          vec3 raw = cross(across, normalize(up));
          vN = length(raw) > 1e-6 ? normalize(raw) : vec3(0.0, 0.0, 1.0);
          if (dot(vN, cameraPosition - p) < 0.0) vN = -vN;
          vUv = vec2(position.x + 0.5, t);
          vDepth = -p.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform float uNight;
        varying vec2 vUv; varying float vTone, vDepth; varying vec3 vN;
        void main() {
          // Olive to bright green, a paler midrib, browning at the tips; darker the deeper it grows.
          vec3 c = mix(vec3(0.16, 0.3, 0.1), vec3(0.3, 0.48, 0.14), vTone);
          c = mix(c, vec3(0.45, 0.38, 0.16), smoothstep(0.8, 1.0, vUv.y) * 0.6);
          c *= 0.8 + 0.3 * smoothstep(0.1, 0.0, abs(vUv.x - 0.5)) + 0.1 * sin(vUv.x * 30.0);
          vec3 sky = mix(vec3(0.6, 0.5, 0.58), vec3(0.06, 0.07, 0.12), uNight);
          c *= sky * (0.55 + 0.45 * abs(vN.y) + 0.25 * abs(vN.z)) * exp(-vDepth * 0.35);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.weeds = new THREE.Mesh(wg, this.weedMaterial);
    this.weeds.castShadow = true;
    this.weeds.customDepthMaterial = depthVariant(this.weedMaterial);
    this.disposables.push(this.weeds.customDepthMaterial);
    this.weeds.layers.set(LAYER.BELOW);
    this.weeds.frustumCulled = false;
    this.group.add(this.weeds);
    this.disposables.push(wg, this.weedMaterial);

    // Sunken branches: a few waterlogged limbs lying on the bed with stubs of side branches.
    this.barkTex = Art.texture(barkCanvas(), { repeat: true });
    this.barkTex.repeat.set(1, 4);
    const barkMat = new THREE.MeshStandardMaterial({ map: this.barkTex, roughness: 0.95, metalness: 0, color: 0x9a8a78 });
    this.disposables.push(this.barkTex, barkMat);
    for (let k = 0; k < 4; k++) {
      const z = -rnd(3, 18), x = rnd(-0.8, 0.8) * hw(z);
      const len = rnd(1.2, 3.2), yaw = rnd(0, TAU), r = rnd(0.05, 0.11);
      const dir = v3(Math.cos(yaw), 0, Math.sin(yaw));
      const pts = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4 - 0.5;
        const p = v3(x, 0, z).addScaledVector(dir, t * len);
        p.y = onBed(p.x, p.z) + r * 0.6 + Math.sin(t * 3 + k) * r * 0.3;
        p.x += Math.sin(t * 5 + k * 2) * len * 0.04;
        pts.push(p);
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const geo = new THREE.TubeGeometry(curve, 24, r, 10, false);
      const log = new THREE.Mesh(geo, barkMat);
      log.castShadow = true;
      log.receiveShadow = true;
      for (let i = 0; i <= 8; i++) { const q = curve.getPointAt(i / 8); contact(q.x, q.z, r * 1.2, 0.55); }
      log.layers.set(LAYER.BELOW);
      log.frustumCulled = false;
      this.group.add(log);
      this.disposables.push(geo);
      // Stubs.
      for (let s = Math.floor(rnd(2, 5)); s > 0; s--) {
        const t = rnd(0.15, 0.85);
        const at = curve.getPointAt(t);
        const a = rnd(0, TAU), up = rnd(0.2, 1.0);
        const sdir = v3(Math.cos(a) * (1 - up), up, Math.sin(a) * (1 - up)).normalize();
        const slen = rnd(0.15, 0.5);
        const sgeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([at, at.clone().addScaledVector(sdir, slen * 0.5), at.clone().addScaledVector(sdir, slen).add(v3(0, slen * 0.1, 0))]), 6, r * 0.35, 7, false);
        const stub = new THREE.Mesh(sgeo, barkMat);
        stub.castShadow = true;
        stub.layers.set(LAYER.BELOW);
        stub.frustumCulled = false;
        this.group.add(stub);
        this.disposables.push(sgeo);
      }
    }
    this.aoTexture = Art.texture(this.aoCanvas, { srgb: false });
    this.aoTexture.minFilter = THREE.LinearFilter;
    this.aoTexture.generateMipmaps = false;
  }

  dispose() { for (const d of this.disposables) d.dispose(); this.aoTexture.dispose(); }
}

/**
 * A shadow-casting twin of a custom ShaderMaterial: the same vertex shader (so instanced,
 * swaying geometry casts the shadow it shows) writing packed depth.
 */
export function depthVariant(material) {
  return new THREE.ShaderMaterial({
    uniforms: material.uniforms,
    vertexShader: material.vertexShader,
    fragmentShader: `#include <packing>\nvoid main() { gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }`,
    side: THREE.DoubleSide,
  });
}
