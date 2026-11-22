// Diorama — fetches the scanned materials the computer and office skins wear and writes html/assets/manifest.json.
//
//   node diorama/tools/fetch.mjs
//
// Source: ambientCG (CC0, no account needed). Each asset's 1K JPG set is downloaded into diorama/tools/raw/
// (git-ignored), and the maps the page uses are copied to diorama/html/assets/materials/<key>/. Needs `unzip`.
// 1K is enough here because the tiles are small: this is a scene the size of a desktop computer seen from
// 60 cm, so a scan is laid 12 to 30 cm to the repeat, which is 3,400 to 8,500 pixels a metre.

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, 'raw');
const OUT = join(here, '..', 'html', 'assets');

// key: what the page calls it; id: the ambientCG asset; tile: metres one repeat covers in the scene.
const MATERIALS = [
  { key: 'aluminium', id: 'Metal011', tile: 0.16, use: 'heatsinks, heat spreaders, the graphics card backplate' },
  { key: 'paint', id: 'Metal027', tile: 0.3, use: 'the case: powder-coated steel' },
  { key: 'plastic', id: 'Plastic006', tile: 0.14, use: 'fan frames and blades, shrouds, connectors' },
  { key: 'mesh', id: 'SheetMetal001', tile: 0.06, use: 'perforated panels and dust filters' },
  { key: 'weave', id: 'Fabric004', tile: 0.02, use: 'cable sleeving' },
  { key: 'rubber', id: 'Rubber004', tile: 0.1, use: 'grommets and fan mounts' },
  // The office skin. Its tiles are in the room's own metres (the room is a 1:10 miniature of itself).
  { key: 'floor', id: 'WoodFloor051', tile: 1.6, use: 'the office floor' },
  { key: 'wood', id: 'Wood049', tile: 0.9, use: 'the desk, the door, the chairs, the mouldings' },
  { key: 'woodLight', id: 'Wood051', tile: 0.9, use: 'the bookcase, the pinboard frame, picture frames' },
  { key: 'plaster', id: 'PaintedPlaster017', tile: 1.8, use: 'the office walls and ceiling' },
  { key: 'leather', id: 'Leather037', tile: 0.5, use: 'the swivel chair, the desk blotter' },
  { key: 'cloth', id: 'Fabric026', tile: 0.35, use: 'the coat, the hat' },
  { key: 'carpet', id: 'Carpet016', tile: 1.2, use: 'the rug' },
  { key: 'paper', id: 'Paper001', tile: 0.4, use: 'files, loose sheets, the lampshade' },
];
const MAPS = { color: '_Color.jpg', normal: '_NormalGL.jpg', roughness: '_Roughness.jpg', opacity: '_Opacity.jpg', metalness: '_Metalness.jpg' };

mkdirSync(RAW, { recursive: true });
const manifest = { materials: {} };
for (const m of MATERIALS) {
  const zip = join(RAW, `${m.id}_1K-JPG.zip`), dir = join(RAW, m.id);
  if (!existsSync(zip)) {
    const r = await fetch(`https://ambientcg.com/get?file=${m.id}_1K-JPG.zip`);
    if (!r.ok) throw new Error(`${m.id}: HTTP ${r.status}`);
    writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  }
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  const out = join(OUT, 'materials', m.key);
  mkdirSync(out, { recursive: true });
  const files = readdirSync(dir), maps = {};
  for (const [name, suffix] of Object.entries(MAPS)) {
    const f = files.find((x) => x.endsWith(suffix));
    if (!f) continue;
    copyFileSync(join(dir, f), join(out, `${name}.jpg`));
    maps[name] = `assets/materials/${m.key}/${name}.jpg`;
  }
  manifest.materials[m.key] = {
    tile: m.tile, maps, use: m.use, name: m.id.replace(/(\D)(\d)/, '$1 $2'),
    source: `https://ambientcg.com/a/${m.id}`, author: 'ambientCG (Lennart Demes)', license: 'CC0',
  };
  const kb = Object.values(maps).reduce((s, p) => s + statSync(join(OUT, '..', p)).size, 0) / 1024;
  console.log(`${m.key.padEnd(10)} ${m.id.padEnd(14)} ${Object.keys(maps).join(', ')}  ${kb.toFixed(0)} KB`);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
