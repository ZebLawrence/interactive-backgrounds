// Downloads a Poly Haven asset into hangar/tools/raw/ (git-ignored) and records it in the manifest with its credits.
//
//   node hangar/tools/fetch-polyhaven.mjs <assetId> <tag> <tileMetres>        a texture set (2K PNG maps)
//   node hangar/tools/fetch-polyhaven.mjs --model <assetId> <name> <scale> [res]  a model (glTF, 2K textures, or
//                                                                             res 1k for small props)
//
// Textures land in raw/materials/<slug>/ as color.png, normal.png (OpenGL convention), orm.png (Poly Haven's
// `arm` map: AO in R, roughness in G, metalness in B) and height.png. Run prepare-textures.sh afterwards.
// Models land in raw/models/<name>/; run prepare-models.sh afterwards. Every Poly Haven asset is CC0.
import path from 'node:path';
import { RAW, slugOf, materialMaps, readManifest, writeManifest, getJson, download } from './manifest-lib.mjs';

const API = 'https://api.polyhaven.com';
const RES = '2k';

async function credits(id) {
  const info = await getJson(`${API}/info/${id}`);
  return { name: info.name, author: Object.keys(info.authors ?? {}).join(', ') || 'Poly Haven', source: `https://polyhaven.com/a/${id}`, license: 'CC0' };
}

async function fetchTexture(id, tag, tile) {
  const files = await getJson(`${API}/files/${id}`);
  const dir = path.join(RAW, 'materials', slugOf(tag));
  const pick = (key) => {
    const f = files[key]?.[RES]?.png;
    if (!f) throw new Error(`${id} has no ${RES} PNG "${key}" map`);
    return f.url;
  };
  await download(pick('Diffuse'), path.join(dir, 'color.png'));
  await download(pick('nor_gl'), path.join(dir, 'normal.png'));
  await download(pick('arm'), path.join(dir, 'orm.png'));
  await download(pick('Displacement'), path.join(dir, 'height.png'));
  const c = await credits(id);
  const m = readManifest();
  m.materials[tag] = { tile, maps: materialMaps(tag), name: c.name, source: c.source, author: c.author, license: c.license };
  writeManifest(m);
  console.log(`${tag} <- ${c.name} by ${c.author} (${c.source}), tile ${tile} m`);
}

async function fetchModel(id, name, scale, res = RES) {
  const files = await getJson(`${API}/files/${id}`);
  const g = files.gltf?.[res]?.gltf;
  if (!g) throw new Error(`${id} has no ${res} glTF`);
  const dir = path.join(RAW, 'models', name);
  await download(g.url, path.join(dir, path.basename(new URL(g.url).pathname)));
  for (const [rel, f] of Object.entries(g.include ?? {})) {
    if (rel.includes('..') || path.isAbsolute(rel)) throw new Error(`refusing include path ${rel}`);
    await download(f.url, path.join(dir, rel));
  }
  const c = await credits(id);
  const m = readManifest();
  m.models[name] = { file: `assets/models/${name}.glb`, scale, name: c.name, source: c.source, author: c.author, license: c.license };
  writeManifest(m);
  console.log(`model ${name} <- ${c.name} by ${c.author} (${c.source})`);
}

const args = process.argv.slice(2);
const model = args[0] === '--model';
if (model) args.shift();
const [id, key, num, res] = args;
const n = Number(num);
if (!id || !key || !(n > 0)) {
  console.error('usage: fetch-polyhaven.mjs <assetId> <tag> <tileMetres>\n       fetch-polyhaven.mjs --model <assetId> <name> <scale> [res]');
  process.exit(2);
}
if (res && !/^[1248]k$/.test(res)) { console.error(`bad resolution ${res} (1k, 2k, 4k or 8k)`); process.exit(2); }
await (model ? fetchModel(id, key, n, res) : fetchTexture(id, key, n));
