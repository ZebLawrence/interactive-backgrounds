// Trawler — Fetches the scanned materials and the props the page loads, from the two libraries that
// need no account: Poly Haven and ambientCG, both CC0.
//
//   node trawler/tools/fetch.mjs material polyhaven <assetId> <tag> <tileMetres> [res]
//   node trawler/tools/fetch.mjs material ambientcg <assetId> <tag> <tileMetres>
//   node trawler/tools/fetch.mjs model <assetId> <name> <scaleToMetres> [res]
//
// Raw downloads land in trawler/tools/raw/ (git-ignored). `pack.py` turns a raw material folder
// into the three WebP maps the page loads, and `prepare-models.mjs` does the same for a model's
// textures. Only the processed files and assets/manifest.json are committed.
//
// Why WebP and not KTX2: Hangar encoded its maps as KTX2 with Binomial's `basisu`, which is a
// Homebrew package and a macOS build. There is no equivalent to hand here and the only portable
// encoder is a WebAssembly build that would have to be downloaded and executed, which this
// environment does not permit. WebP costs more GPU memory than a block-compressed format but it is
// *sharper* (no 4x4 block artefacts), it needs no toolchain at all, and at 1024 px over a 1 m tile
// it still meets the project's 1024 px per metre rule for everything within arm's reach.

import path from 'node:path';
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { RAW, slugOf, materialMaps, readManifest, writeManifest, getJson, download } from './manifest-lib.mjs';

const POLYHAVEN = 'https://api.polyhaven.com';

async function polyhavenCredits(id) {
  const info = await getJson(`${POLYHAVEN}/info/${id}`);
  return {
    name: info.name,
    author: Object.keys(info.authors ?? {}).join(', ') || 'Poly Haven',
    source: `https://polyhaven.com/a/${id}`,
    license: 'CC0',
  };
}

async function fetchPolyhavenMaterial(id, tag, tile, res = '2k') {
  const files = await getJson(`${POLYHAVEN}/files/${id}`);
  const dir = path.join(RAW, 'materials', slugOf(tag));
  const pick = (key, optional = false) => {
    const f = files[key]?.[res]?.png;
    if (!f && !optional) throw new Error(`${id} has no ${res} PNG "${key}" map`);
    return f?.url ?? null;
  };
  await download(pick('Diffuse'), path.join(dir, 'color.png'));
  await download(pick('nor_gl'), path.join(dir, 'normal.png'));
  // Poly Haven's `arm` is already ambient occlusion, roughness and metalness in R, G and B.
  await download(pick('arm'), path.join(dir, 'orm.png'));
  const c = await polyhavenCredits(id);
  const m = readManifest();
  m.materials[tag] = { tile, maps: materialMaps(tag), name: c.name, source: c.source, author: c.author, license: c.license };
  writeManifest(m);
  console.log(`${tag} <- ${c.name} by ${c.author} (${c.source}), tile ${tile} m`);
}

const AMBIENTCG_ROLES = {
  Color: 'color', NormalGL: 'normal', AmbientOcclusion: 'ao', Roughness: 'rough', Metalness: 'metal', Opacity: 'opacity',
};

async function fetchAmbientcgMaterial(id, tag, tile) {
  const dir = path.join(RAW, 'materials', slugOf(tag));
  const zip = path.join(RAW, 'zips', `${id}_2K-PNG.zip`);
  await download(`https://ambientcg.com/get?file=${id}_2K-PNG.zip`, zip);
  const src = path.join(dir, 'src');
  mkdirSync(src, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', src]);
  for (const f of readdirSync(src)) {
    const m = f.match(/_([A-Za-z]+)\.png$/);
    if (m && AMBIENTCG_ROLES[m[1]]) copyFileSync(path.join(src, f), path.join(dir, `${AMBIENTCG_ROLES[m[1]]}.png`));
  }
  for (const need of ['color', 'normal', 'rough']) {
    if (!existsSync(path.join(dir, `${need}.png`))) throw new Error(`${id}: the zip has no ${need} map`);
  }
  const m = readManifest();
  // The ambientCG API has no per-asset author field. ambientCG is Lennart Demes's library and he
  // makes its assets, so that is the credit given; CC0 needs none, so it is a courtesy.
  m.materials[tag] = {
    tile, maps: materialMaps(tag), name: id,
    source: `https://ambientcg.com/a/${id}`, author: 'ambientCG (Lennart Demes)', license: 'CC0',
  };
  writeManifest(m);
  console.log(`${tag} <- ${id} (https://ambientcg.com/a/${id}), tile ${tile} m`);
}

async function fetchModel(id, name, scale, res = '1k') {
  const files = await getJson(`${POLYHAVEN}/files/${id}`);
  const g = files.gltf?.[res]?.gltf;
  if (!g) throw new Error(`${id} has no ${res} glTF`);
  const dir = path.join(RAW, 'models', name);
  await download(g.url, path.join(dir, path.basename(new URL(g.url).pathname)));
  for (const [rel, f] of Object.entries(g.include ?? {})) {
    if (rel.includes('..') || path.isAbsolute(rel)) throw new Error(`refusing include path ${rel}`);
    await download(f.url, path.join(dir, rel));
  }
  const c = await polyhavenCredits(id);
  const m = readManifest();
  m.models[name] = {
    file: `assets/models/${name}/${name}.gltf`, scale,
    name: c.name, source: c.source, author: c.author, license: c.license,
  };
  writeManifest(m);
  console.log(`model ${name} <- ${c.name} by ${c.author} (${c.source})`);
}

const args = process.argv.slice(2);
const kind = args.shift();
try {
  if (kind === 'material') {
    const [library, id, tag, num, res] = args;
    const tile = Number(num);
    if (!library || !id || !tag || !(tile > 0)) throw new Error('usage: fetch.mjs material <polyhaven|ambientcg> <assetId> <tag> <tileMetres> [res]');
    if (library === 'polyhaven') await fetchPolyhavenMaterial(id, tag, tile, res);
    else if (library === 'ambientcg') await fetchAmbientcgMaterial(id, tag, tile);
    else throw new Error(`unknown library ${library}`);
  } else if (kind === 'model') {
    const [id, name, num, res] = args;
    const scale = Number(num);
    if (!id || !name || !(scale > 0)) throw new Error('usage: fetch.mjs model <assetId> <name> <scaleToMetres> [res]');
    await fetchModel(id, name, scale, res);
  } else {
    throw new Error('usage: fetch.mjs <material|model> ...');
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(2);
}
