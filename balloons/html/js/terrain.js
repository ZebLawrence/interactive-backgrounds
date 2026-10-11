// Balloon Dawn — The land: the hill the viewer stands on, the valley floor with its patchwork of
// fields, woods and a winding river, rising to foothills under the mountains.

import * as THREE from 'three';
import { TAU, rnd, randInt, pick, clamp, lerp, fbm2, hash2, Art } from './util.js';
import { patchMaterial } from './shaders.js';

/** Where the river runs: x as a function of z. */
export function riverX(z) { return 140 * Math.sin(z / 520) + 60 * Math.sin(z / 170 + 1.3) - 80; }

/** Height of the land at (x, z), in metres. */
export function groundHeight(x, z) {
  const d = Math.hypot(x, z);
  const hill = 34 * Math.exp(-((d / 115) ** 2)) + 12 * Math.exp(-((d / 380) ** 2));
  const roll = (fbm2(x / 400 + 3, z / 400, 3) - 0.5) * 12;
  const river = -5 * Math.exp(-(((x - riverX(z)) / 40) ** 2)) * clamp((-z - 150) / 100, 0, 1);
  const foothills = Math.max(0, -z - 2000) * 0.18 + (fbm2(x / 300, z / 300 + 9, 3) - 0.5) * Math.max(0, -z - 2000) * 0.12;
  return hill + roll + river + foothills;
}

/** The valley from above: fields, hedges, woods, a road, farms, and the river catching the sky. */
function valleyCanvas() {
  const S = 4096;
  return Art.image(S, S, (ctx) => {
    // The canvas covers x in [-3000, 3000], z in [200, -5800]; row 0 is the far edge.
    const px = (x) => (x + 3000) / 6000 * S;
    const pz = (z) => (200 - z) / 6000 * S;
    const greens = ['#3f6128', '#4a6c2e', '#557536', '#607f3e', '#73823e', '#8c7d3c', '#968646', '#807640', '#536f36', '#6b7d4a'];
    ctx.fillStyle = '#4c6a32';
    ctx.fillRect(0, 0, S, S);
    // Fields: a jittered grid of quads with hedgerows along their edges.
    const cell = 110;
    const nodes = [];
    for (let j = 0; j <= 6000 / cell; j++) {
      nodes.push([]);
      for (let i = 0; i <= 6000 / cell; i++) nodes[j].push([px(-3000 + i * cell + (hash2(i, j) - 0.5) * cell * 0.6), pz(200 - j * cell - (hash2(j, i + 9) - 0.5) * cell * 0.6)]);
    }
    for (let j = 0; j < nodes.length - 1; j++) for (let i = 0; i < nodes[j].length - 1; i++) {
      const q = [nodes[j][i], nodes[j][i + 1], nodes[j + 1][i + 1], nodes[j + 1][i]];
      ctx.fillStyle = pick(greens);
      ctx.beginPath();
      q.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      // Ploughed fields show furrows.
      if (Math.random() < 0.15) {
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = 'rgba(80,60,30,0.35)';
        ctx.lineWidth = 1.2;
        const a = rnd(0, Math.PI);
        for (let k = -80; k < 80; k += 4) {
          ctx.beginPath();
          ctx.moveTo(q[0][0] + Math.cos(a) * k * 2 - Math.sin(a) * 200, q[0][1] + Math.sin(a) * k * 2 + Math.cos(a) * 200);
          ctx.lineTo(q[0][0] + Math.cos(a) * k * 2 + Math.sin(a) * 200, q[0][1] + Math.sin(a) * k * 2 - Math.cos(a) * 200);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.strokeStyle = '#2f4a22';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
    // Woods: dark, lumpy copses.
    for (let k = 0; k < 160; k++) {
      const x = rnd(-3000, 3000), z = rnd(-5600, -250), r = rnd(30, 140);
      for (let n = 0; n < 24; n++) {
        ctx.fillStyle = pick(['#2d4d26', '#35572c', '#294620', '#3a5f31']);
        ctx.beginPath();
        ctx.arc(px(x + rnd(-r, r)), pz(z + rnd(-r, r) * 0.7), rnd(8, 22), 0, TAU);
        ctx.fill();
      }
    }
    // The hill under the viewer is open meadow.
    const g = ctx.createRadialGradient(px(0), pz(0), 0, px(0), pz(0), 420 / 6000 * S);
    g.addColorStop(0, 'rgba(78,112,50,1)');
    g.addColorStop(0.7, 'rgba(78,112,50,0.9)');
    g.addColorStop(1, 'rgba(78,112,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    // A lane winding up the valley, with farms along it.
    ctx.strokeStyle = '#b9ad94';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let z = -200; z > -5800; z -= 40) ctx.lineTo(px(riverX(z) + 160 + 50 * Math.sin(z / 300)), pz(z));
    ctx.stroke();
    for (let k = 0; k < 30; k++) {
      const z = rnd(-5500, -300), x = riverX(z) + 160 + 50 * Math.sin(z / 300) + rnd(-40, 40);
      ctx.fillStyle = pick(['#8a6a4e', '#a08264', '#6e5240']);
      ctx.fillRect(px(x) - 3, pz(z) - 2, rnd(4, 8), rnd(3, 5));
    }
    // The river, bright with reflected sky, with a darker bank each side.
    for (const [w, c] of [[22, '#4d5a3f'], [14, '#cfc1b6'], [9, '#efe0d8']]) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w / 6000 * S;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let z = -120; z > -5800; z -= 20) ctx.lineTo(px(riverX(z)), pz(z));
      ctx.stroke();
    }
  });
}

/** A tileable grass detail map, multiplied into the ground close up. */
function grassDetail() {
  return Art.image(512, 512, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = x / w * TAU, b = y / h * TAU;
      const n = fbm2(Math.cos(a) * 2 + Math.cos(b) * 2, Math.sin(a) * 2 + Math.sin(b) * 2, 4);
      const v = 0.75 + 0.5 * n + (hash2(x, y) - 0.5) * 0.15;
      const i = (y * w + x) * 4;
      d[i] = v * 235; d[i + 1] = v * 255; d[i + 2] = v * 215; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}

export class Ground {
  constructor() {
    const geo = new THREE.PlaneGeometry(6000, 6000, 300, 300);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -2800);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, groundHeight(pos.getX(i), pos.getZ(i)));
    geo.computeVertexNormals();
    this.map = Art.texture(valleyCanvas());
    this.map.anisotropy = 8;
    this.detail = Art.texture(grassDetail(), { repeat: true, srgb: false });
    this.material = new THREE.MeshStandardMaterial({ map: this.map, roughness: 0.95, metalness: 0 });
    patchMaterial(this.material, {
      key: 'ground',
      uniforms: { uDetail: { value: this.detail } },
      fHead: 'uniform sampler2D uDetail;',
      fEmissive: `
        // Grass detail close to the viewer, so the hill isn't a blur of one texel.
        vec3 det = texture2D(uDetail, vWPos.xz / 9.0).rgb * texture2D(uDetail, vWPos.xz / 61.0 + 0.3).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), det, 0.8);`,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.map.dispose(); this.detail.dispose(); }
}
