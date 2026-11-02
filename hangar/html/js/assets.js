// Hangar — Asset loader: KTX2 material maps, images and meshopt glTF models listed in assets/manifest.json.
//
// loadAssets(renderer, manifest, onProgress(fraction)) resolves to { textures, models, failures }:
//   textures  Map, key `<tag>.<map>` for material maps (e.g. `mat:steel.normal`) and `image.<name>` for images
//   models    Map, key = model name, value = the loaded glTF scene (a THREE.Group) with `userData.scale` set
//   failures  the manifest paths that could not be loaded
// A file that fails resolves to a neutral stand-in (mid-grey colour, flat normal, AO 1 / roughness 0.7 /
// metalness 0, mid height, or an empty group for a model) and is listed in `failures`; the load as a whole
// never rejects. Every texture gets mipmaps and the renderer's maximum anisotropy.

import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const TRANSCODER = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/';
const MAP_KEYS = ['color', 'normal', 'orm', 'height'];

// Stand-in texel per map kind (RGBA8). orm = AO 1, roughness 0.7, metalness 0.
const FALLBACK = {
  color: [128, 128, 128, 255],
  normal: [128, 128, 255, 255],
  orm: [255, 179, 0, 255],
  height: [128, 128, 128, 255],
  image: [128, 128, 128, 255],
};

/** A 1x1 texture of the neutral value for this map kind. */
export function fallbackTexture(kind) {
  const t = new THREE.DataTexture(new Uint8Array(FALLBACK[kind] ?? FALLBACK.color), 1, 1, THREE.RGBAFormat);
  t.colorSpace = kind === 'color' || kind === 'image' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.userData.fallback = true;
  t.needsUpdate = true;
  return t;
}

/** Every file the manifest lists, as jobs { kind, key, path, map }. */
export function manifestJobs(manifest) {
  const jobs = [];
  for (const [tag, m] of Object.entries(manifest.materials ?? {})) {
    for (const map of MAP_KEYS) if (m.maps?.[map]) jobs.push({ kind: 'texture', key: `${tag}.${map}`, path: m.maps[map], map });
  }
  for (const [name, m] of Object.entries(manifest.images ?? {})) jobs.push({ kind: 'texture', key: `image.${name}`, path: m.file, map: 'image' });
  for (const [name, m] of Object.entries(manifest.models ?? {})) jobs.push({ kind: 'model', key: name, path: m.file, scale: m.scale ?? 1 });
  return jobs;
}

/**
 * Loads every asset in the manifest. Paths are relative to the page (hangar/html/). Progress is the fraction of
 * bytes received across all files (files whose size is not known yet count by file until they report it).
 */
export async function loadAssets(renderer, manifest, onProgress = () => {}) {
  const ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER).detectSupport(renderer);
  const gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const jobs = manifestJobs(manifest);
  const textures = new Map(), models = new Map(), failures = [];

  // Per-file progress: [loaded, total]; a file with no total yet weighs 1 unknown unit.
  const prog = jobs.map(() => [0, 0]);
  const done = jobs.map(() => false);
  const report = () => {
    let frac = 0;
    for (let i = 0; i < jobs.length; i++) {
      const [l, t] = prog[i];
      frac += done[i] ? 1 : (t > 0 ? Math.min(l / t, 0.99) : 0);
    }
    onProgress(jobs.length ? frac / jobs.length : 1);
  };
  report();

  const finishTexture = (tex, job) => {
    tex.colorSpace = job.map === 'color' || job.map === 'image' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    // Material maps tile; an equirectangular image wraps round in longitude and clamps at the poles.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = job.map === 'image' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.anisotropy = anisotropy;
    // The KTX2 files carry a full mip chain; a 1x1 stand-in has none and must not ask for one.
    tex.minFilter = tex.userData.fallback ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.name = job.key;
    tex.needsUpdate = true;
    return tex;
  };

  const run = (job, i) => new Promise((resolve) => {
    const onProg = (e) => { if (e?.lengthComputable || e?.total) { prog[i] = [e.loaded, e.total]; report(); } };
    const fail = (err) => {
      console.warn(`Hangar: could not load ${job.path}`, err);
      failures.push(job.path);
      if (job.kind === 'texture') textures.set(job.key, finishTexture(fallbackTexture(job.map), job));
      else {
        const g = new THREE.Group();
        g.name = job.key;
        g.userData = { fallback: true, scale: job.scale };
        models.set(job.key, g);
      }
      resolve();
    };
    const ok = () => { resolve(); };
    if (job.kind === 'texture') {
      ktx2.load(job.path, (tex) => { textures.set(job.key, finishTexture(tex, job)); ok(); }, onProg, fail);
    } else {
      gltf.load(job.path, (g) => {
        const scene = g.scene;
        scene.name = job.key;
        scene.userData.scale = job.scale;
        scene.traverse((o) => {
          const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          for (const m of mats) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k]) m[k].anisotropy = anisotropy;
        });
        models.set(job.key, scene);
        ok();
      }, onProg, fail);
    }
  }).then(() => { done[i] = true; report(); });

  // A few at a time: the basis transcoder runs in a small worker pool, and this keeps memory flat.
  const LIMIT = 6;
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; await run(jobs[i], i); } };
  await Promise.all(Array.from({ length: Math.min(LIMIT, jobs.length) }, worker));
  ktx2.dispose();
  return { textures, models, failures };
}

/** Fetches assets/manifest.json; a missing or broken manifest yields an empty one and a failure entry. */
export async function loadManifest(url = './assets/manifest.json') {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { manifest: await r.json(), failures: [] };
  } catch (err) {
    console.warn('Hangar: could not load the asset manifest', err);
    return { manifest: { materials: {}, models: {}, images: {} }, failures: [url.replace(/^\.\//, '')] };
  }
}
