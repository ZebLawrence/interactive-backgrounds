// Trawler — Asset loader: the scanned material maps and the glTF props listed in
// assets/manifest.json.
//
// loadAssets(renderer, manifest, onProgress(fraction), opts) resolves to { textures, models, failures }:
//   textures  Map, key `<tag>.<map>` (e.g. `mat:teak.color`)
//   models    Map, key = model name, value = the loaded glTF scene (a THREE.Group)
//   failures  the manifest paths that could not be loaded
//
// opts.priority names the tags and models to fetch first (the pilot house, which is what the
// viewer is sitting in); opts.onItem(kind, name, asset) is called as each one arrives, so the
// scene can swap a plain stand-in for the real thing while it is already running.
//
// A file that fails becomes a neutral 1x1 stand-in and is named in `failures`; the load as a whole
// never rejects, because a missing texture should not take the sea down with it.
//
// Every map's UVs are in metres (see materials.js), so a texture's `repeat` is simply one over the
// tile size the manifest records. That is also what makes the pixels-per-metre rule checkable: a
// 1024 px map on a 1 m tile is 1024 px/m.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FALLBACK = {
  color: [150, 150, 150, 255],
  normal: [128, 128, 255, 255],
  orm: [255, 179, 0, 255], // ambient occlusion 1, roughness 0.7, metalness 0
};

/** A 1x1 texture of the neutral value for this map kind. */
export function fallbackTexture(kind) {
  const t = new THREE.DataTexture(new Uint8Array(FALLBACK[kind] ?? FALLBACK.color), 1, 1, THREE.RGBAFormat);
  t.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.userData.fallback = true;
  t.needsUpdate = true;
  return t;
}

/** The flat list of jobs a manifest implies, priority names first. */
export function manifestJobs(manifest, priority = []) {
  const items = [];
  for (const [tag, m] of Object.entries(manifest.materials ?? {})) {
    items.push({
      kind: 'material',
      name: tag,
      tile: m.tile ?? 1,
      files: Object.entries(m.maps ?? {}).map(([map, path]) => ({ key: `${tag}.${map}`, map, path, kind: 'texture' })),
    });
  }
  for (const [name, m] of Object.entries(manifest.models ?? {})) {
    items.push({ kind: 'model', name, scale: m.scale ?? 1, files: [{ key: name, path: m.file, kind: 'model', scale: m.scale ?? 1 }] });
  }
  const rank = (item) => {
    const i = priority.indexOf(item.name);
    return i < 0 ? priority.length : i;
  };
  items.sort((a, b) => rank(a) - rank(b));
  return items;
}

/** Progress as the share of files finished, which for a few dozen small files is close enough. */
export function progressFraction(done, total) {
  return total > 0 ? Math.min(done / total, 1) : 1;
}

/** Fetches assets/manifest.json; a missing or broken one yields an empty manifest and a failure. */
export async function loadManifest(url = './assets/manifest.json') {
  try {
    const v = new URL(import.meta.url).searchParams.get('v');
    const r = await fetch(v ? `${url}?v=${v}` : url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = await r.json();
    for (const s of ['materials', 'models']) m[s] ??= {};
    return { manifest: m, failures: [] };
  } catch (err) {
    console.warn('Trawler: could not load the asset manifest', err);
    return { manifest: { materials: {}, models: {} }, failures: [url.replace(/^\.\//, '')] };
  }
}

export async function loadAssets(renderer, manifest, onProgress = () => {}, opts = {}) {
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  const items = manifestJobs(manifest, opts.priority ?? []);
  const jobs = items.flatMap((item, it) => item.files.map((f) => ({ ...f, item: it })));
  const textures = new Map(), models = new Map(), failures = [];
  const texLoader = new THREE.TextureLoader();
  const gltf = new GLTFLoader();

  let done = 0;
  const report = () => onProgress(progressFraction(done, jobs.length));
  report();

  const left = items.map((item) => item.files.length);
  const settle = (job) => {
    if (--left[job.item] > 0 || !opts.onItem) return;
    const item = items[job.item];
    let asset;
    if (item.kind === 'material') {
      asset = { tile: item.tile };
      for (const f of item.files) asset[f.map] = textures.get(f.key);
    } else {
      asset = models.get(item.name);
    }
    try { opts.onItem(item.kind, item.name, asset); } catch (err) { console.error('Trawler: onItem failed for', item.name, err); }
  };

  const finishTexture = (tex, job, tile) => {
    tex.colorSpace = job.map === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = anisotropy;
    tex.minFilter = tex.userData.fallback ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = !tex.userData.fallback;
    // UVs are in metres, so one repeat covers `tile` metres of surface.
    tex.repeat.set(1 / tile, 1 / tile);
    tex.name = job.key;
    tex.needsUpdate = true;
    return tex;
  };

  const run = (job) => new Promise((resolve) => {
    const fail = (err) => {
      console.warn(`Trawler: could not load ${job.path}`, err);
      failures.push(job.path);
      if (job.kind === 'texture') textures.set(job.key, finishTexture(fallbackTexture(job.map), job, items[job.item].tile));
      else {
        const g = new THREE.Group();
        g.name = job.key;
        g.userData = { fallback: true, scale: job.scale };
        models.set(job.key, g);
      }
      resolve();
    };
    if (job.kind === 'texture') {
      texLoader.load(job.path, (tex) => { textures.set(job.key, finishTexture(tex, job, items[job.item].tile)); resolve(); }, undefined, fail);
    } else {
      gltf.load(job.path, (g) => {
        const scene = g.scene;
        scene.name = job.key;
        scene.userData.scale = job.scale;
        scene.traverse((o) => {
          const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          for (const m of mats) {
            for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
              if (m[k]) m[k].anisotropy = anisotropy;
            }
          }
        });
        models.set(job.key, scene);
        resolve();
      }, undefined, fail);
    }
  }).then(() => { done++; report(); settle(job); });

  // A few at a time, in priority order, so the pilot house is dressed before the islands are.
  const LIMIT = 6;
  let next = 0;
  const worker = async () => { while (next < jobs.length) await run(jobs[next++]); };
  await Promise.all(Array.from({ length: Math.min(LIMIT, jobs.length) }, worker));
  return { textures, models, failures };
}
