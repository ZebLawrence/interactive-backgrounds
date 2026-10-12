// Loon Lake — Water lilies in the sheltered shallows at the sides: floating pads with their
// notch and radiating veins, a few white flowers open among them, and stems running down to
// the bed. The pads are perches for the dragonflies.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAU, rnd, clamp, fbm2, v3, Art } from './util.js';
import { LAYER } from './shaders.js';
import { bedDepth } from './water.js';

/** A lily pad from above: green with radiating veins and a paler, slightly reddened rim. */
function padCanvas() {
  return Art.image(512, 512, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2, R = w * 0.48;
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#3f7a2e');
    g.addColorStop(0.7, '#3a6f2a');
    g.addColorStop(0.93, '#4a7a30');
    g.addColorStop(1, '#6a5a2c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Mottling.
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const n = fbm2(x / 40, y / 40, 3) - 0.5;
      const i = (y * w + x) * 4;
      d[i] = clamp(d[i] + n * 30, 0, 255); d[i + 1] = clamp(d[i + 1] + n * 36, 0, 255); d[i + 2] = clamp(d[i + 2] + n * 20, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
    // Veins radiating from the stem point, forking toward the rim.
    ctx.strokeStyle = 'rgba(200,215,150,0.55)';
    ctx.lineCap = 'round';
    for (let k = 0; k < 18; k++) {
      const a = k / 18 * TAU + rnd(-0.08, 0.08);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx + Math.cos(a + 0.1) * R * 0.5, cy + Math.sin(a + 0.1) * R * 0.5, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
      ctx.lineWidth = 1.6;
      for (const s of [-1, 1]) {
        const b = a + s * 0.1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * R * 0.45, cy + Math.sin(a) * R * 0.45);
        ctx.lineTo(cx + Math.cos(b) * R, cy + Math.sin(b) * R);
        ctx.stroke();
      }
    }
  });
}

/** The pad: a disc with the characteristic V notch cut toward the centre. */
function padGeometry() {
  const shape = new THREE.Shape();
  const notch = 0.42, segs = 48;
  shape.moveTo(0.05, 0);
  for (let i = 0; i <= segs; i++) {
    const a = notch / 2 + (TAU - notch) * i / segs;
    const r = 1 + 0.03 * Math.sin(a * 7);
    shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.lineTo(0.05, 0);
  const g = new THREE.ShapeGeometry(shape, 1);
  // UVs over the unit disc; lie flat.
  const uv = g.attributes.uv;
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) * 0.5 + 0.5, p.getY(i) * 0.5 + 0.5);
  g.rotateX(-Math.PI / 2);
  // A slight upturn at the rim, as the pads curl.
  for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getZ(i)); p.setY(i, Math.pow(r, 6) * 0.06); }
  g.computeVertexNormals();
  return g;
}

/** A flower: two whorls of petals around a yellow heart, opening upward. */
function flowerGeometry() {
  const parts = [];
  const petal = (len, wid, tilt, az, lift) => {
    const g = new THREE.PlaneGeometry(wid, len, 1, 3);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = p.getY(i) / len + 0.5;
      // Cupped: narrow at the base, rounded at the tip.
      p.setX(i, p.getX(i) * Math.sin(t * Math.PI * 0.9 + 0.1));
      p.setZ(i, -Math.pow(t, 2) * len * 0.35);
    }
    g.translate(0, len / 2, 0);
    g.rotateX(-tilt);
    g.rotateY(az);
    g.translate(0, lift, 0);
    return g;
  };
  for (let k = 0; k < 8; k++) parts.push(petal(0.055, 0.02, 1.15, k / 8 * TAU, 0.005));
  for (let k = 0; k < 8; k++) parts.push(petal(0.045, 0.018, 0.8, (k + 0.5) / 8 * TAU, 0.008));
  for (let k = 0; k < 6; k++) parts.push(petal(0.03, 0.014, 0.45, k / 6 * TAU + 0.2, 0.012));
  const heart = new THREE.SphereGeometry(0.009, 10, 8);
  heart.scale(1, 0.7, 1);
  heart.translate(0, 0.016, 0);
  // Petals carry uv.y along their length; the heart's uvs are pushed into the yellow corner.
  const hu = heart.attributes.uv;
  for (let i = 0; i < hu.count; i++) hu.setXY(i, 0.5, 1.0);
  parts.push(heart);
  return mergeGeometries(parts, false);
}

function flowerCanvas() {
  return Art.image(64, 256, (ctx, w, h) => {
    // v along the petal: pink at the base, white toward the tip; the very top row is the yellow heart.
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, '#e8b4c8');
    g.addColorStop(0.35, '#f7eef2');
    g.addColorStop(0.9, '#ffffff');
    g.addColorStop(0.96, '#f2c23a');
    g.addColorStop(1, '#f2c23a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

export class Lilies {
  /** @param {{ halfWidth(d: number): number }} layout */
  constructor(layout) {
    this.group = new THREE.Group();
    this.perches = [];
    this.disposables = [];
    const pads = [], flowers = [], stems = [];
    // Patches in the lee of the reeds at each side, where the water is still and under a metre
    // and a half deep.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const z = -rnd(4.5, 14);
        const hw = layout.halfWidth(-z);
        const cx = side * hw * rnd(0.6, 0.98), cz = z, r = rnd(1.0, 2.2);
        const n = Math.round(r * r * rnd(5, 8));
        for (let i = 0; i < n; i++) {
          const a = rnd(0, TAU), d = Math.sqrt(Math.random()) * r;
          const x = cx + Math.cos(a) * d, pz = cz + Math.sin(a) * d * 0.75;
          if (bedDepth(Math.min(pz, -0.01)) > 1.6) continue;
          const size = rnd(0.09, 0.17);
          if (pads.some((p) => Math.hypot(p.x - x, p.z - pz) < (p.size + size) * 0.8)) continue;
          pads.push({ x, z: pz, size, yaw: rnd(0, TAU) });
          stems.push({ x, z: pz });
          if (Math.random() < 0.45) this.perches.push({ base: v3(x, 0.004, pz), h: 0, phase: 0, stiff: 0, top: 0.012 });
        }
        for (let f = Math.floor(rnd(1, 3.5)); f > 0; f--) {
          const a = rnd(0, TAU), d = Math.sqrt(Math.random()) * r * 0.8;
          const x = cx + Math.cos(a) * d, pz = cz + Math.sin(a) * d * 0.75;
          flowers.push({ x, z: pz, yaw: rnd(0, TAU), scale: rnd(0.8, 1.2) });
          stems.push({ x, z: pz });
        }
      }
    }

    this.padTex = Art.texture(padCanvas());
    this.padTex.anisotropy = 8;
    // Waxy but matte enough not to flare in the low sun.
    const padMat = new THREE.MeshStandardMaterial({ map: this.padTex, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
    const padGeo = padGeometry();
    this.padMesh = new THREE.InstancedMesh(padGeo, padMat, Math.max(1, pads.length));
    const dummy = new THREE.Object3D();
    pads.forEach((p, i) => {
      dummy.position.set(p.x, 0.004, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.setScalar(p.size);
      dummy.updateMatrix();
      this.padMesh.setMatrixAt(i, dummy.matrix);
    });
    this.padMesh.count = pads.length;
    this.padMesh.instanceMatrix.needsUpdate = true;
    this.padMesh.castShadow = true;
    this.padMesh.frustumCulled = false;
    this.padMesh.layers.enable(LAYER.ABOVE);
    this.padMesh.renderOrder = 6;

    this.flowerTex = Art.texture(flowerCanvas());
    const flowerMat = new THREE.MeshStandardMaterial({ map: this.flowerTex, roughness: 0.7, metalness: 0, side: THREE.DoubleSide, emissive: 0x2a2220, emissiveIntensity: 0.25 });
    const flowerGeo = flowerGeometry();
    this.flowerMesh = new THREE.InstancedMesh(flowerGeo, flowerMat, Math.max(1, flowers.length));
    flowers.forEach((f, i) => {
      dummy.position.set(f.x, 0.01, f.z);
      dummy.rotation.set(0, f.yaw, 0);
      dummy.scale.setScalar(f.scale);
      dummy.updateMatrix();
      this.flowerMesh.setMatrixAt(i, dummy.matrix);
    });
    this.flowerMesh.count = flowers.length;
    this.flowerMesh.instanceMatrix.needsUpdate = true;
    this.flowerMesh.castShadow = true;
    this.flowerMesh.frustumCulled = false;
    this.flowerMesh.layers.enable(LAYER.ABOVE);

    // Stems: thin stalks from each pad and flower straight down to the bed, seen through the water.
    const stemParts = stems.map((s) => {
      const depth = bedDepth(Math.min(s.z, -0.01));
      const g = new THREE.CylinderGeometry(0.004, 0.006, depth, 6);
      g.translate(s.x + rnd(-0.01, 0.01), -depth / 2, s.z + rnd(-0.01, 0.01));
      return g;
    });
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x4a5a2a, roughness: 0.8 });
    this.stemMesh = new THREE.Mesh(stemParts.length ? mergeGeometries(stemParts, false) : new THREE.BufferGeometry(), stemMat);
    this.stemMesh.layers.set(LAYER.BELOW);
    this.stemMesh.frustumCulled = false;

    this.group.add(this.padMesh, this.flowerMesh, this.stemMesh);
    this.disposables.push(this.padTex, padMat, padGeo, this.flowerTex, flowerMat, flowerGeo, stemMat, this.stemMesh.geometry);
  }

  dispose() { for (const d of this.disposables) d.dispose(); }
}
