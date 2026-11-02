// Downloads an ambientCG material (2K PNG zip) into hangar/tools/raw/ (git-ignored) and records it in the manifest.
//
//   node hangar/tools/fetch-ambientcg.mjs <assetId> <tag> <tileMetres>
//
// Poly Haven has no brushed steel, diamond plate, walkway grating or hazard paint, so those come from
// ambientCG (CC0, no account needed). The zip's maps are renamed to the layout prepare-textures.sh expects:
// color.png, normal.png (NormalGL), height.png, plus ao.png / rough.png / metal.png / opacity.png, which
// pack-maps.py folds into orm.png (and the colour map's alpha).
import path from 'node:path';
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// The API has no author field; ambientCG is Lennart Demes's library (see README, "ambientCG author").
import { RAW, slugOf, materialMaps, readManifest, writeManifest, download } from './manifest-lib.mjs';

const [id, tag, num] = process.argv.slice(2);
const tile = Number(num);
if (!id || !tag || !(tile > 0)) {
  console.error('usage: fetch-ambientcg.mjs <assetId> <tag> <tileMetres>');
  process.exit(2);
}

const dir = path.join(RAW, 'materials', slugOf(tag));
const zip = path.join(RAW, 'zips', `${id}_2K-PNG.zip`);
await download(`https://ambientcg.com/get?file=${id}_2K-PNG.zip`, zip);
const src = path.join(dir, 'src');
mkdirSync(src, { recursive: true });
execFileSync('unzip', ['-o', '-q', zip, '-d', src]);

const ROLES = { Color: 'color', NormalGL: 'normal', Displacement: 'height', AmbientOcclusion: 'ao', Roughness: 'rough', Metalness: 'metal', Opacity: 'opacity' };
for (const f of readdirSync(src)) {
  const m = f.match(/_([A-Za-z]+)\.png$/);
  if (m && ROLES[m[1]]) copyFileSync(path.join(src, f), path.join(dir, `${ROLES[m[1]]}.png`));
}
for (const need of ['color', 'normal', 'height', 'rough']) {
  if (!existsSync(path.join(dir, `${need}.png`))) throw new Error(`${id}: zip has no ${need} map`);
}

const m = readManifest();
m.materials[tag] = { tile, maps: materialMaps(tag), name: id, source: `https://ambientcg.com/a/${id}`, author: 'ambientCG (Lennart Demes)', license: 'CC0' };
if (existsSync(path.join(dir, 'opacity.png'))) m.materials[tag].alpha = true;
writeManifest(m);
console.log(`${tag} <- ${id} (https://ambientcg.com/a/${id}), tile ${tile} m`);
