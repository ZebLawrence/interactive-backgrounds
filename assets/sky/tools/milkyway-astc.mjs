// Makes the macOS apps' copy of the Milky Way map: Hangar's milkyway.ktx2 (UASTC, Zstandard) transcoded to
// ASTC 4x4, which Apple GPUs sample directly, so an app holds the 8192 x 4096 map in 43 MB of GPU memory
// rather than the 180 MB it would take as plain pixels. UASTC is built to transcode to ASTC with next to no
// loss, so this is the same picture the web pages show.
//
//   node assets/sky/tools/milkyway-astc.mjs <basis_transcoder dir> <out file>
//
// The transcoder is three.js's copy of the Basis Universal one (examples/jsm/libs/basis, the same version the
// web pages load). Each app's build.sh runs this once and keeps the result in assets/sky/build/ (git-ignored).
//
// The output: "MWASTC01", then uint32 width, height, level count, and for each level a uint32 byte count and
// that many bytes of ASTC 4x4 blocks, rows as in the KTX2 (bottom row first, so v = 1 is north, as on a
// three.js SphereGeometry).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [basisDir, out] = process.argv.slice(2);
if (!basisDir || !out) { console.error('usage: milkyway-astc.mjs <basis_transcoder dir> <out file>'); process.exit(2); }

const src = resolve(here, '../../../hangar/html/assets/images/milkyway.ktx2');
const require = createRequire(import.meta.url);
const BASIS = require(resolve(basisDir, 'basis_transcoder.js'));
const basis = await BASIS({ wasmBinary: readFileSync(join(basisDir, 'basis_transcoder.wasm')) });
basis.initializeBasis();

const ASTC_4x4 = 10; // the transcoder's cTFASTC_4x4_RGBA
const file = new basis.KTX2File(new Uint8Array(readFileSync(src)));
if (!file.isValid() || !file.startTranscoding()) throw new Error(`${src}: not a transcodable KTX2`);
const w = file.getWidth(), h = file.getHeight(), levels = file.getLevels();
const parts = [];
const head = Buffer.alloc(20);
head.write('MWASTC01', 0, 'ascii');
head.writeUInt32LE(w, 8); head.writeUInt32LE(h, 12); head.writeUInt32LE(levels, 16);
parts.push(head);
for (let level = 0; level < levels; level++) {
  const size = file.getImageTranscodedSizeInBytes(level, 0, 0, ASTC_4x4);
  const dst = new Uint8Array(size);
  if (!file.transcodeImage(dst, level, 0, 0, ASTC_4x4, 0, -1, -1)) throw new Error(`level ${level} failed to transcode`);
  const n = Buffer.alloc(4); n.writeUInt32LE(size);
  parts.push(n, Buffer.from(dst.buffer));
}
file.close(); file.delete();
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, Buffer.concat(parts));
console.log(`${out}: ${w} x ${h}, ${levels} levels, ASTC 4x4`);
