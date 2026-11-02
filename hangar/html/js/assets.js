// Hangar — Asset loader: KTX2 material maps, images and meshopt glTF models listed in assets/manifest.json.
//
// loadAssets(renderer, manifest, onProgress(fraction), opts) resolves to { textures, models, failures }:
//   textures  Map, key `<tag>.<map>` for material maps (e.g. `mat:steel.normal`) and `image.<name>` for images
//   models    Map, key = model name, value = the loaded glTF scene (a THREE.Group) with `userData.scale` set
//   failures  the manifest paths that could not be loaded
// opts.priority: material tags / model names / image names to fetch first (e.g. the start room's materials).
// opts.onItem(kind, name, asset): called as each item completes ('material' -> { color, normal, orm, height },
//   'model' -> Group, 'image' -> Texture), so the scene can swap greybox for real materials while it runs.
// A file that fails resolves to a neutral stand-in (mid-grey colour, flat normal, AO 1 / roughness 0.7 /
// metalness 0, mid height, or an empty group for a model) and is listed in `failures`; the load as a whole
// never rejects. Every texture gets mipmaps and the renderer's maximum anisotropy.

import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { manifestItems, progressFraction } from './assetjobs.js';

export { manifestItems, manifestJobs } from './assetjobs.js';

const TRANSCODER = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/';

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

/**
 * Loads every asset in the manifest. Paths are relative to the page (hangar/html/). Progress is the fraction of
 * bytes received across all files (files whose size is not known yet count by file until they report it).
 */
export async function loadAssets(renderer, manifest, onProgress = () => {}, opts = {}) {
  const ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER).detectSupport(renderer);
  const gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const items = manifestItems(manifest, opts.priority ?? []);
  const jobs = items.flatMap((item, it) => item.files.map((f) => ({ ...f, item: it })));
  const textures = new Map(), models = new Map(), failures = [];

  // Byte-weighted progress (see progressFraction).
  const prog = jobs.map(() => ({ loaded: 0, total: 0, done: false }));
  // Never step backwards when a large file reports its size late.
  let shown = 0;
  const report = () => { shown = Math.max(shown, progressFraction(prog)); onProgress(shown); };
  report();

  // An item is handed to onItem once all of its files have settled (loaded or stood in).
  const left = items.map((item) => item.files.length);
  const settle = (job) => {
    if (--left[job.item] > 0 || !opts.onItem) return;
    const item = items[job.item];
    let asset;
    if (item.kind === 'material') asset = Object.fromEntries(item.files.map((f) => [f.map, textures.get(f.key)]));
    else if (item.kind === 'model') asset = models.get(item.name);
    else asset = textures.get(item.files[0].key);
    try { opts.onItem(item.kind, item.name, asset); } catch (err) { console.error('Hangar: onItem failed for', item.name, err); }
  };

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
    const onProg = (e) => { if (e?.total > 0) { prog[i].loaded = e.loaded; prog[i].total = e.total; report(); } };
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
  }).then(() => { prog[i].done = true; report(); settle(job); });

  // A few at a time, in priority order: the basis transcoder runs in a small worker pool, the first area's
  // materials arrive before the rest are requested, and memory stays flat.
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
    // The manifest carries this module's own ?v= (from the import map), so it is never older than the code.
    const v = new URL(import.meta.url).searchParams.get('v');
    const r = await fetch(v ? `${url}?v=${v}` : url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { manifest: await r.json(), failures: [] };
  } catch (err) {
    console.warn('Hangar: could not load the asset manifest', err);
    return { manifest: { materials: {}, models: {}, images: {} }, failures: [url.replace(/^\.\//, '')] };
  }
}
