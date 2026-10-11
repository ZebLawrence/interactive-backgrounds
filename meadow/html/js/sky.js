// Firefly Meadow — The night sky (stars, Milky Way, moon, shooting stars), the tree line and
// hills on the horizon, and the mist drifting over the grass.

import * as THREE from 'three';
import { TAU, rnd, randInt, pick, coin, clamp, lerp, smoothstep, fbm2, v3, unit, Art, quantize } from './util.js';
import { G, Q } from './shaders.js';

export const SKY_RADIUS = 480;

const NOISE_GLSL = `
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
`;

// ---------------------------------------------------------------------------------------------
// Sky dome. The Milky Way is painted once onto an equirectangular canvas (its glowing core, the
// cooler outer arms, layered dark dust lanes and a few tinted nebulae); the stars are hashed in
// the shader so they stay crisp at any resolution, each with its own colour and size.
// ---------------------------------------------------------------------------------------------

/** The plane of the galaxy, tilted so the band crosses the sky in front of the viewer. */
const MILKY_WAY_NORMAL = v3(0.6, 0.76, 0.24).normalize();

function milkyWayCanvas(w = 1536, h = 768) {
  const N = MILKY_WAY_NORMAL;
  // A basis in the plane of the band, to measure position along it.
  const T1 = unit(v3(0, 0, -1).sub(N.clone().multiplyScalar(N.z * -1)));
  const T2 = N.clone().cross(T1);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const sat = (x) => clamp(x, 0, 1);
  for (let y = 0; y < h; y++) {
    const lat = (0.5 - (y + 0.5) / h) * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let x = 0; x < w; x++) {
      const lon = ((x + 0.5) / w - 0.5) * TAU;
      const dx = cl * Math.cos(lon), dy = sl, dz = cl * Math.sin(lon);
      const b = dx * N.x + dy * N.y + dz * N.z;
      const along = Math.atan2(dx * T2.x + dy * T2.y + dz * T2.z, dx * T1.x + dy * T1.y + dz * T1.z);
      const core = Math.exp(-(b * b) / 0.012);
      const wide = Math.exp(-(b * b) / 0.09);
      // Mottled brightness along the band, big patches and finer knots.
      const patches = fbm2(along * 1.3 + 2, b * 5 + 9, 3);
      const knots = fbm2(along * 3.5, b * 14 + 3, 4);
      let haze = wide * 0.28 * (0.3 + patches) + core * (0.35 + 1.0 * knots * knots);
      // Dust: dark lanes threaded through the core, and the great rift down its middle.
      const lanes = fbm2(along * 6 + 7, b * 26 + 1, 4);
      haze *= 1 - 0.85 * smoothstep(0.52, 0.7, lanes) * core;
      const riftCentre = 0.04 * Math.sin(along * 2.2 + 1) + 0.02 * Math.sin(along * 5.1);
      const rift = Math.exp(-Math.pow((b - riftCentre) / 0.03, 2)) * (0.35 + 0.65 * fbm2(along * 4 + 5, 1.5, 3));
      haze *= 1 - 0.7 * rift;
      // Colour: a warm bulge, cooler blue-white arms, with pink and teal nebulae here and there.
      const warmth = core * (0.35 + 0.65 * patches);
      let r = lerp(0.62, 1.0, warmth), g = lerp(0.72, 0.9, warmth), bl = lerp(1.0, 0.72, warmth);
      const pink = smoothstep(0.62, 0.8, fbm2(along * 3 + 11, b * 12 + 5, 3)) * core;
      const teal = smoothstep(0.64, 0.82, fbm2(along * 2.6 + 23, b * 10 + 17, 3)) * wide;
      r += pink * 0.5; g -= pink * 0.15; bl += pink * 0.1;
      g += teal * 0.35; bl += teal * 0.3; r -= teal * 0.15;
      const i = (y * w + x) * 4;
      d[i] = sat(r * haze * 0.9) * 255;
      d[i + 1] = sat(g * haze * 0.9) * 255;
      d[i + 2] = sat(bl * haze * 0.9) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export class Sky {
  constructor() {
    this.hazeTexture = Art.texture(milkyWayCanvas(), { srgb: false });
    this.hazeTexture.wrapS = THREE.RepeatWrapping;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: G.uTime, uMoon: G.uMoon, uMoonDir: G.uMoonDir, uStorm: G.uStorm, uFlash: G.uFlash, uFogColor: G.uFogColor,
        uHaze: { value: this.hazeTexture },
      },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `
        varying vec3 vDir;
        void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime, uMoon, uStorm, uFlash; uniform vec3 uMoonDir, uFogColor; uniform sampler2D uHaze;
        varying vec3 vDir;
        ${NOISE_GLSL}${Q}
        // One layer of stars on a grid of cells: most faint and white, a few bright, each with its
        // own colour from blue-white through yellow to orange, and a soft halo on the brightest.
        vec3 starLayer(vec2 uv, float cells, float threshold, float gain, float seed) {
          vec2 g = uv * vec2(cells * 2.0, cells);
          vec2 cell = floor(g), f = fract(g);
          float r1 = hash21(cell + seed), r2 = hash21(cell + seed + 7.1), r3 = hash21(cell + seed + 3.3), r4 = hash21(cell + seed + 9.7);
          if (r1 < threshold) return vec3(0.0);
          vec2 off = vec2(r2, r3) * 0.7 + 0.15;
          float dist = length(f - off);
          float bright = pow((r1 - threshold) / (1.0 - threshold), 6.0) * gain + 0.03;
          float tw = 0.75 + 0.25 * sin(uTime * q(0.8 + r3 * 2.5) + r2 * 6.2831);
          vec3 tint = r4 < 0.22 ? vec3(0.72, 0.82, 1.0) : r4 < 0.6 ? vec3(0.95, 0.96, 1.0) : r4 < 0.86 ? vec3(1.0, 0.9, 0.72) : vec3(1.0, 0.72, 0.5);
          float size = 0.07 + 0.12 * pow(bright / (gain + 0.03), 0.5);
          float star = smoothstep(size, 0.0, dist) * bright * tw;
          star += exp(-dist * dist / 0.03) * bright * 0.12 * step(0.985, r1);
          return tint * star;
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 zenith = vec3(0.003, 0.005, 0.016);
          vec3 horizon = vec3(0.035, 0.045, 0.09);
          vec3 col = mix(horizon, zenith, pow(clamp(h * 1.3, 0.0, 1.0), 0.55));
          // Faint airglow low on the horizon.
          col += vec3(0.02, 0.045, 0.035) * exp(-max(h, 0.0) * 14.0);

          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(h, -1.0, 1.0)) / 3.14159265 + 0.5);
          vec3 haze = texture2D(uHaze, uv).rgb;
          float hazeAmt = dot(haze, vec3(0.33));
          vec3 stars = starLayer(uv, 380.0, 0.75, 1.5, 0.0)
                     + starLayer(uv, 760.0, 0.84, 0.8, 5.0) * (0.7 + 1.5 * hazeAmt)
                     + starLayer(uv, 1400.0, 0.9, 0.35, 11.0) * (0.5 + 2.0 * hazeAmt);
          col += haze * 0.3;
          col += stars * (1.0 - uMoon * 0.3);

          // The moon's halo.
          float cosm = dot(d, uMoonDir);
          float halo = exp((cosm - 1.0) * 70.0) * 0.22 + exp((cosm - 1.0) * 500.0) * 0.5;
          col += vec3(0.5, 0.6, 0.85) * halo * uMoon;

          // Storm: a low ceiling of cloud lit from within by lightning.
          vec2 cp = d.xz / max(h, 0.08) * 0.9 + vec2(uTime * q(0.01), 0.0);
          float cloud = fbm(cp);
          vec3 stormCol = vec3(0.025, 0.03, 0.045) * (0.5 + 1.1 * cloud);
          stormCol += vec3(0.6, 0.66, 0.9) * uFlash * (0.15 + 0.6 * cloud);
          col = mix(col, stormCol, uStorm);
          col += vec3(0.5, 0.55, 0.75) * uFlash * (1.0 - uStorm) * 0.3;

          // Fade into the fog just above the horizon, so the land meets the sky seamlessly.
          col = mix(col, uFogColor, smoothstep(0.09, 0.0, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.hazeTexture.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The moon: a waxing gibbous with maria, drawn once onto a canvas
// ---------------------------------------------------------------------------------------------

export class Moon {
  constructor() {
    const canvas = Art.image(256, 256, (ctx, w, h) => {
      const cx = w / 2, cy = h / 2, r = 100;
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x - cx) / r, dy = (y - cy) / r;
          const rr = Math.hypot(dx, dy);
          const i = (y * w + x) * 4;
          if (rr > 1) continue;
          // Surface: bright highlands with a few broad, soft-edged maria and a scatter of craters.
          const m = fbm2(dx * 1.5 + 5, dy * 1.5 + 9, 3);
          const maria = clamp((m - 0.47) * 6, 0, 1) * (0.7 + 0.3 * fbm2(dx * 4 + 1, dy * 4 + 2, 2));
          let v = 0.92 - maria * 0.5 - fbm2(dx * 6, dy * 6, 2) * 0.08;
          for (const [cx2, cy2, cr] of [[0.35, -0.4, 0.07], [-0.2, 0.55, 0.09], [0.6, 0.3, 0.05], [-0.55, -0.1, 0.06], [0.1, 0.05, 0.04]]) {
            const dd = Math.hypot(dx - cx2, dy - cy2) / cr;
            if (dd < 1.3) v += dd < 0.75 ? -0.14 : (dd < 1 ? 0.12 : 0.04 * (1.3 - dd) / 0.3);
          }
          // Phase: lit from the right, the terminator an ellipse.
          const nz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
          const lit = dx * 0.92 + nz * 0.4;
          v *= clamp(lit * 1.6 + 0.3, 0.06, 1);
          const edge = clamp((1 - rr) * 12, 0, 1);
          d[i] = (v * 235 + 20) | 0;
          d[i + 1] = (v * 238 + 17) | 0;
          d[i + 2] = (v * 245 + 10) | 0;
          d[i + 3] = (edge * 255) | 0;
        }
      }
      ctx.putImageData(img, 0, 0);
    });
    this.texture = Art.texture(canvas);
    this.material = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, fog: false, toneMapped: true });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.position.copy(G.uMoonDir.value).multiplyScalar(SKY_RADIUS * 0.98);
    const size = SKY_RADIUS * 0.055;
    this.sprite.scale.set(size, size, 1);
  }

  /** Fade with the moonlight setting and hide behind storm clouds. */
  update(moon, storm) {
    this.material.opacity = clamp(moon * (1 - storm), 0, 1);
    this.material.color.setScalar(lerp(0.7, 1.0, moon));
    this.sprite.visible = this.material.opacity > 0.01;
  }

  dispose() { this.texture.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// Shooting stars: a streak that crosses a few degrees of sky in half a second, now and then
// ---------------------------------------------------------------------------------------------

export class Meteors {
  constructor() {
    const tex = Art.image(256, 16, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.75, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,1)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      const s = ctx.createLinearGradient(0, 0, 0, h);
      s.addColorStop(0, 'rgba(0,0,0,1)');
      s.addColorStop(0.5, 'rgba(0,0,0,0)');
      s.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, w, h);
    });
    this.texture = Art.texture(tex);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      color: new THREE.Color(1.6, 1.7, 2.0),
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.timer = rnd(4, 10);
    this.active = null;
  }

  update(dt, storm) {
    if (this.active) {
      const a = this.active;
      a.t += dt;
      const k = a.t / a.duration;
      if (k >= 1) { this.active = null; this.mesh.visible = false; return; }
      const head = unit(a.start.clone().addScaledVector(a.dir, a.travel * k)).multiplyScalar(SKY_RADIUS * 0.97);
      const tangent = unit(a.dir.clone().sub(head.clone().multiplyScalar(a.dir.dot(head) / head.lengthSq())));
      const normal = unit(head.clone().negate());
      const side = unit(tangent.clone().cross(normal));
      this.mesh.matrix.makeBasis(tangent, side, normal);
      this.mesh.matrix.setPosition(head.clone().addScaledVector(tangent, -a.length / 2));
      this.mesh.matrixAutoUpdate = false;
      this.mesh.scale.set(1, 1, 1);
      this.mesh.matrix.scale(v3(a.length, a.width, 1));
      this.material.opacity = Math.sin(k * Math.PI) * 0.9;
      return;
    }
    this.timer -= dt;
    if (this.timer > 0 || storm > 0.3) return;
    this.timer = rnd(7, 22);
    // Start high in the sky in front of the viewer, heading down at a shallow angle.
    const az = rnd(-1.1, 1.1), el = rnd(0.35, 0.9);
    const start = v3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const dir = v3(rnd(-1, 1), rnd(-0.9, -0.3), rnd(-0.4, 0.4)).normalize();
    this.active = { start, dir, t: 0, duration: rnd(0.35, 0.6), travel: rnd(0.06, 0.12), length: rnd(14, 30), width: rnd(0.5, 0.9) };
    this.mesh.visible = true;
  }

  dispose() { this.texture.dispose(); this.material.dispose(); this.mesh.geometry.dispose(); }
}

// ---------------------------------------------------------------------------------------------
// The horizon: a dark tree line standing in the fog, and hills beyond it
// ---------------------------------------------------------------------------------------------

function treeLineCanvas() {
  const w = 4096, h = 1024;
  return Art.image(w, h, (ctx) => {
    const ink = () => pick(['#040806', '#050a07', '#060b08', '#040705']);
    const groundAt = (x) => h - 14 - fbm2(x / 500, 3.3, 3) * 16;
    // The ground the trees stand on, undulating a little.
    ctx.fillStyle = '#040806';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 16) ctx.lineTo(x, groundAt(x));
    ctx.lineTo(w, h);
    ctx.fill();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    /** A spruce or fir: a trunk with serrated tiers of drooping branches, ragged at the edges. */
    const conifer = (x, base, size) => {
      const fir = Math.random() < 0.4;
      const widest = fir ? 0.3 : 0.22;
      const tilt = rnd(-0.03, 0.03);
      ctx.fillStyle = ink();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = Math.max(1.5, size * 0.03);
      ctx.beginPath();
      ctx.moveTo(x, base - size);
      ctx.lineTo(x + tilt * size, base);
      ctx.stroke();
      const right = [], left = [];
      const step = Math.max(1.5, size * 0.022);
      let i = 0;
      for (let y = base - size * 0.97; y <= base - size * 0.08; y += step, i++) {
        const f = (y - (base - size)) / size;
        // Branches lengthen down the tree; needles serrate the edge, and a few branches jut out
        // or are missing, so no two trees share an outline.
        const tier = Math.pow(f, fir ? 0.85 : 1.15) * widest * size;
        const needle = i % 2 ? 1 : 0.78;
        const whorl = 0.9 + 0.1 * Math.cos(f * 23.0 + x);
        const gap = Math.random() < 0.06 ? rnd(0.5, 0.8) : 1;
        const jut = Math.random() < 0.05 ? rnd(1.1, 1.3) : 1;
        const cx = x + tilt * size * f;
        right.push([cx + tier * needle * whorl * gap * jut * rnd(0.92, 1.06), y + rnd(0, step * 0.5)]);
        left.push([cx - tier * (i % 2 ? 0.8 : 1) * whorl * rnd(0.9, 1.08) * (Math.random() < 0.06 ? 0.65 : 1), y + rnd(0, step * 0.5)]);
      }
      ctx.beginPath();
      ctx.moveTo(x, base - size - rnd(0, size * 0.05));
      for (const [px, py] of right) ctx.lineTo(px, py);
      ctx.lineTo(x + tilt * size, base);
      for (let i = left.length - 1; i >= 0; i--) ctx.lineTo(left[i][0], left[i][1]);
      ctx.closePath();
      ctx.fill();
    };

    /** A broadleaf tree: a trunk and a few limbs, with a crown of many small leaf clumps. */
    const deciduous = (x, base, size) => {
      ctx.fillStyle = ink();
      ctx.strokeStyle = ctx.fillStyle;
      const trunkH = size * rnd(0.3, 0.45);
      ctx.lineWidth = Math.max(2, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.lineTo(x + rnd(-0.03, 0.03) * size, base - trunkH);
      ctx.stroke();
      const crownY = base - trunkH - size * 0.25;
      const limbs = randInt(3, 5);
      for (let i = 0; i < limbs; i++) {
        const a = -Math.PI / 2 + (i / (limbs - 1) - 0.5) * 1.6 + rnd(-0.15, 0.15);
        const len = size * rnd(0.25, 0.4);
        ctx.lineWidth = Math.max(1.2, size * 0.03);
        ctx.beginPath();
        ctx.moveTo(x, base - trunkH);
        ctx.quadraticCurveTo(x + Math.cos(a) * len * 0.5, base - trunkH + Math.sin(a) * len * 0.5 - size * 0.05,
          x + Math.cos(a) * len, base - trunkH + Math.sin(a) * len);
        ctx.stroke();
      }
      // The crown: clumps of small overlapping blobs, denser toward the middle, uneven at the edge.
      const rx = size * rnd(0.32, 0.42), ry = size * rnd(0.26, 0.34);
      for (let k = Math.round(size * 1.2); k > 0; k--) {
        const a = rnd(0, TAU), r = Math.pow(Math.random(), 0.6);
        const cx = x + Math.cos(a) * r * rx, cy = crownY + Math.sin(a) * r * ry;
        const rr = size * rnd(0.025, 0.06) * (1.2 - 0.5 * r);
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, TAU);
        ctx.fill();
      }
    };

    /** A dead or winter tree: bare branches, forking as they go. */
    const bare = (x, base, size) => {
      ctx.strokeStyle = ink();
      const branch = (bx, by, a, len, depth) => {
        const ex = bx + Math.cos(a) * len, ey = by + Math.sin(a) * len;
        ctx.lineWidth = Math.max(0.8, len * 0.1);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        if (depth === 0) return;
        const n = randInt(2, 3);
        for (let i = 0; i < n; i++) branch(ex, ey, a + rnd(-0.75, 0.75), len * rnd(0.55, 0.75), depth - 1);
      };
      branch(x, base, -Math.PI / 2 + rnd(-0.1, 0.1), size * 0.35, 4);
    };

    /** Low bushes and brambles along the foot of the trees. */
    const bush = (x, base, size) => {
      ctx.fillStyle = ink();
      for (let k = randInt(5, 9); k > 0; k--) {
        ctx.beginPath();
        ctx.arc(x + rnd(-0.5, 0.5) * size, base - rnd(0, 0.3) * size, size * rnd(0.12, 0.25), 0, TAU);
        ctx.fill();
      }
    };

    // Mixed woodland, a little denser and taller in the middle; bushes fill the gaps at its feet.
    for (let x = -100; x < w + 100; x += rnd(12, 34)) {
      const base = groundAt(x) + rnd(0, 12);
      const size = rnd(60, 115) * (0.8 + 0.4 * Math.sin(x / w * Math.PI));
      const roll = Math.random();
      if (roll < 0.36) conifer(x, base, size * 1.25);
      else if (roll < 0.46) bare(x, base, size * 1.1);
      else deciduous(x, base, size);
    }
    for (let x = -50; x < w + 50; x += rnd(25, 70)) bush(x, groundAt(x) + 6, rnd(20, 45));
  });
}

function hillsCanvas() {
  const w = 4096, h = 256;
  return Art.image(w, h, (ctx) => {
    ctx.fillStyle = '#fff';
    for (const [seed, lift, amp] of [[1.3, 40, 50], [7.7, 70, 40]]) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) ctx.lineTo(x, h - lift - fbm2(x / 380 + seed, seed, 4) * amp);
      ctx.lineTo(w, h);
      ctx.fill();
    }
  });
}

export class Horizon {
  constructor() {
    this.group = new THREE.Group();
    this.textures = [];
    this.materials = [];
    const silhouette = (canvas, tint, fogged) => {
      const tex = Art.texture(canvas);
      this.textures.push(tex);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uMap: { value: tex }, uTint: { value: tint }, uFogColor: G.uFogColor, uFogNear: G.uFogNear, uFogFar: G.uFogFar, uFogged: { value: fogged } },
        vertexShader: `
          varying vec2 vUv; varying float vDist;
          void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = length(mv.xyz); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `
          uniform sampler2D uMap; uniform vec3 uTint, uFogColor; uniform float uFogNear, uFogFar, uFogged;
          varying vec2 vUv; varying float vDist;
          void main() {
            if (texture2D(uMap, vUv).a < 0.5) discard;
            float f = pow(clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0), 1.3);
            vec3 c = mix(uTint, uFogColor * 0.85, max(f, 1.0 - uFogged));
            gl_FragColor = vec4(c, 1.0);
          }`,
      });
      this.materials.push(mat);
      return mat;
    };
    const trees = new THREE.Mesh(new THREE.PlaneGeometry(400, 100), silhouette(treeLineCanvas(), v3(0.004, 0.009, 0.006), 1));
    trees.position.set(0, 50 - 1, -90);
    const hills = new THREE.Mesh(new THREE.PlaneGeometry(640, 40), silhouette(hillsCanvas(), v3(0, 0, 0), 0));
    hills.position.set(0, 20 - 3, -150);
    this.group.add(trees, hills);
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.group.children.forEach((c) => c.geometry.dispose());
  }
}

// ---------------------------------------------------------------------------------------------
// Ground mist: a few huge soft sprites drifting downwind
// ---------------------------------------------------------------------------------------------

export class Mist {
  constructor(halfWidth) {
    this.group = new THREE.Group();
    this.texture = Art.texture(Art.blob(256));
    this.sprites = [];
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, fog: true, color: new THREE.Color(0.35, 0.42, 0.6), opacity: rnd(0.03, 0.07) });
      const s = new THREE.Sprite(mat);
      const z = -rnd(10, 48);
      s.position.set(rnd(-1, 1) * (halfWidth(-z) + 10), rnd(0.6, 3.5), z);
      const size = rnd(10, 30);
      s.scale.set(size, size * rnd(0.3, 0.5), 1);
      s.userData.base = mat.opacity;
      s.userData.rate = rnd(0.6, 1.2);
      this.group.add(s);
      this.sprites.push(s);
    }
  }

  update(dt, halfWidth, wind, storm) {
    const dir = G.uWindDir.value;
    for (const s of this.sprites) {
      s.position.x += dir.x * wind * s.userData.rate * 0.2 * dt;
      s.position.z += dir.y * wind * s.userData.rate * 0.05 * dt;
      const limit = halfWidth(-s.position.z) + 14;
      if (s.position.x > limit) s.position.x = -limit;
      if (s.position.x < -limit) s.position.x = limit;
      if (s.position.z > -8) s.position.z = -48;
      if (s.position.z < -50) s.position.z = -9;
      s.material.opacity = s.userData.base * (1 - storm * 0.6);
    }
  }

  dispose() {
    this.texture.dispose();
    for (const s of this.sprites) s.material.dispose();
  }
}
