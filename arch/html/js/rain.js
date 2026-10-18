// Sandstone Arch — The storm: rain streaking through the air in front of the viewer, in a box
// that follows the camera, slanted by the breeze and fading with distance; and the lightning,
// a forked bolt (drawn the way Firefly Meadow draws its own) standing for a moment somewhere
// in the sky behind the canyon, whose flash the clouds, the rock and the streaks all answer.
// The drops' other marks (the patter on the lake, the film on the craft, the drips off its rim)
// live with the water and the craft.

import * as THREE from 'three';
import { rnd, randInt, clamp, v3, Art } from './util.js';
import { G, LAYER } from './shaders.js';

const COUNT = 3200;
const BOX = { halfX: 55, height: 38, near: 1.5, far: 95 };

export class Rain {
  constructor() {
    const pos = new Float32Array(COUNT * 2 * 3);
    const end = new Float32Array(COUNT * 2);
    const seed = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      const x = (Math.random() * 2 - 1) * BOX.halfX, y = Math.random() * BOX.height;
      // Denser near the viewer, thinning with distance, so the screen is evenly peppered.
      const z = -(BOX.near + Math.pow(Math.random(), 1.6) * (BOX.far - BOX.near));
      const s = Math.random();
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z;
        end[j] = k;
        seed[j] = s;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.uniforms = { uTime: G.uTime, uWind: G.uWind, uRain: { value: 0 }, uCam: { value: new THREE.Vector3() }, uSkyLight: G.uSkyLight, uFlash: G.uFlash };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      vertexShader: `
        attribute float aEnd, aSeed;
        uniform float uTime, uRain; uniform vec3 uWind, uCam;
        varying float vA;
        void main() {
          float speed = 8.5 + aSeed * 3.5;
          vec3 p = position;
          // Each streak falls at its own speed and wraps to the top of the box.
          p.y = mod(position.y - uTime * speed - aSeed * 97.0, ${BOX.height.toFixed(1)});
          // Slanted by the breeze; the tail trails the head along the fall.
          vec2 drift = uWind.xy * uWind.z * 2.5;
          vec3 dir = normalize(vec3(drift.x, -speed, drift.y));
          p.xz += drift * (${BOX.height.toFixed(1)} - p.y) / speed;
          p += dir * aEnd * (0.45 + aSeed * 0.35);
          vec3 world = p + vec3(uCam.x, 0.0, uCam.z);
          vec4 mv = viewMatrix * vec4(world, 1.0);
          float dist = length(mv.xyz);
          vA = (0.08 + 0.18 * (1.0 - aEnd)) * uRain * smoothstep(0.0, 8.0, dist) * (1.0 - smoothstep(45.0, 95.0, dist));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uSkyLight; uniform vec4 uFlash; varying float vA;
        void main() { gl_FragColor = vec4(vec3(0.72, 0.8, 0.9) * (uSkyLight * 2.5 + 0.12) * (1.0 + 3.0 * uFlash.w), vA); }`,
    });
    this.mesh = new THREE.LineSegments(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.layers.set(LAYER.MAIN);
    this.mesh.visible = false;
  }

  update(camera, rain) {
    this.uniforms.uRain.value = rain;
    this.uniforms.uCam.value.copy(camera.position);
    this.mesh.visible = rain > 0.01;
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

/** Draws a forked bolt down a tall canvas (Firefly Meadow's). */
function boltCanvas() {
  const w = 512, h = 1024;
  return Art.image(w, h, (ctx) => {
    const paths = [];
    const walk = (x, y, len, spread, depth) => {
      const pts = [[x, y]];
      let a = Math.PI / 2 + rnd(-0.3, 0.3);
      while (y < h * (0.78 + depth * 0.05) && len-- > 0) {
        a += rnd(-spread, spread);
        a = clamp(a, Math.PI / 2 - 1.1, Math.PI / 2 + 1.1);
        const step = rnd(14, 34);
        x = clamp(x + Math.cos(a) * step, w * 0.12, w * 0.88);
        y += Math.sin(a) * step;
        pts.push([x, y]);
        if (depth < 2 && Math.random() < 0.1) walk(x, y, randInt(6, 18), spread * 1.3, depth + 1);
      }
      paths.push({ pts, depth });
    };
    walk(rnd(w * 0.3, w * 0.7), 0, 80, 0.5, 0);
    for (const pass of [[18, 'rgba(150,170,255,0.35)', 28], [6, 'rgba(200,215,255,0.8)', 10], [2.2, '#ffffff', 0]]) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = pass[2];
      ctx.shadowColor = 'rgba(160,180,255,1)';
      for (const { pts, depth } of paths) {
        ctx.lineWidth = pass[0] / (1 + depth * 0.8);
        ctx.strokeStyle = pass[1];
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
    }
    // Fade the canvas out at its sides and foot so the plane's edges never show.
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'destination-in';
    const gx = ctx.createLinearGradient(0, 0, w, 0);
    gx.addColorStop(0, 'rgba(0,0,0,0)'); gx.addColorStop(0.1, 'rgba(0,0,0,1)'); gx.addColorStop(0.9, 'rgba(0,0,0,1)'); gx.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gx; ctx.fillRect(0, 0, w, h);
    const gy = ctx.createLinearGradient(0, 0, 0, h);
    gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(0.06, 'rgba(0,0,0,1)'); gy.addColorStop(0.9, 'rgba(0,0,0,1)'); gy.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gy; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  });
}

/**
 * The lightning: every few seconds under the rain a bolt forks down the sky somewhere ahead,
 * a kilometre off, facing the viewer, in two or three strokes that die within a second. Its
 * flash (0..1) and its direction go to the shared uniform the sky, the rock and the streaks read.
 */
export class Lightning {
  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      map: null, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      color: new THREE.Color(2.2, 2.3, 2.8), opacity: 0,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(320, 640), this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -8;
    this.mesh.layers.set(LAYER.ABOVE);
    this.dir = v3(0, 1, 0);
    this.timer = rnd(3, 6);
    this.strike = null;
    this.flash = 0;
  }

  update(dt, storm, camera) {
    if (this.strike) {
      const s = this.strike;
      s.t += dt;
      let f = 0;
      for (const [t0, peak] of s.bursts) if (s.t >= t0) f += peak * Math.exp(-(s.t - t0) / 0.07);
      this.flash = Math.min(1, f) * storm;
      this.material.opacity = s.t < 0.4 ? Math.min(1, f * 1.6) : 0;
      this.mesh.visible = this.material.opacity > 0.01;
      if (s.t > 1.2) { this.strike = null; this.flash = 0; this.mesh.visible = false; }
    }
    G.uFlash.value.set(this.dir.x, this.dir.y, this.dir.z, this.flash);
    if (storm < 0.4) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = rnd(4, 15);
    this.material.map?.dispose();
    this.material.map = Art.texture(boltCanvas());
    this.material.needsUpdate = true;
    // Somewhere ahead, over the canyon or its walls, a kilometre off; the plane faces the viewer
    // and stands with its foot near the skyline.
    const az = rnd(-1.1, 1.1);
    this.dir.set(Math.sin(az) * 0.93, 0.36, -Math.cos(az) * 0.93).normalize();
    const foot = this.dir.clone().setY(0).normalize().multiplyScalar(1100);
    this.mesh.position.copy(camera.position).add(foot).setY(250);
    this.mesh.lookAt(camera.position.x, this.mesh.position.y, camera.position.z);
    this.strike = { t: 0, bursts: [[0, 1], [0.1 + rnd(0, 0.08), rnd(0.5, 0.9)], [0.25 + rnd(0, 0.15), rnd(0.2, 0.6)]] };
  }

  dispose() { this.material.map?.dispose(); this.material.dispose(); this.mesh.geometry.dispose(); }
}
