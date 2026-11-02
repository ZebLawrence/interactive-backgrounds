// Node-only: checks hangar/html/assets/manifest.json against the files on disk and the level's material tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlDir = path.join(here, '..', 'html');
const assetsDir = path.join(htmlDir, 'assets');
const manifestPath = path.join(assetsDir, 'manifest.json');
const MB = 1024 * 1024;
const LICENSES = new Set(['CC0', 'CC-BY-4.0', 'PD']);
const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]); // «KTX 20»\r\n\x1a\n
const MIN_BYTES = 16 * 1024; // smaller than any real 2K map or model: catches empty or truncated outputs

/** The first `n` bytes of a file. */
function head(p, n) {
  const fd = openSync(p, 'r');
  try { const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); return b; } finally { closeSync(fd); }
}

/** KTX2 header fields we rely on: magic, then pixelWidth/pixelHeight (uint32 LE at bytes 20/24), levelCount (40). */
function ktx2Header(p) {
  const b = head(p, 48);
  return { magic: b.subarray(0, 12).equals(KTX2_MAGIC), width: b.readUInt32LE(20), height: b.readUInt32LE(24), levels: b.readUInt32LE(40) };
}

const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const level = JSON.parse(readFileSync(path.join(htmlDir, 'data', 'e1m1.json'), 'utf8'));

/** Every entry in all three sections, as [label, entry]. */
function entries() {
  const out = [];
  for (const section of ['materials', 'models', 'images']) {
    for (const [name, e] of Object.entries(manifest[section] ?? {})) out.push([`${section}.${name}`, e]);
  }
  return out;
}

/** Every file the manifest references, as [label, path relative to html/]. */
function files() {
  const out = [];
  for (const [name, m] of Object.entries(manifest.materials ?? {})) {
    for (const [k, f] of Object.entries(m.maps ?? {})) out.push([`materials.${name}.${k}`, f]);
  }
  for (const [name, m] of Object.entries(manifest.models ?? {})) out.push([`models.${name}`, m.file]);
  for (const [name, m] of Object.entries(manifest.images ?? {})) out.push([`images.${name}`, m.file]);
  return out;
}

function levelTags() {
  const tags = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (v.startsWith('mat:')) tags.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(level);
  return tags;
}

function dirSize(dir) {
  let total = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    total += d.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

test('manifest exists with materials, models and images sections', () => {
  assert.ok(manifest, `missing ${manifestPath}`);
  for (const s of ['materials', 'models', 'images']) assert.equal(typeof manifest[s], 'object', `no "${s}" section`);
});

test('every entry has a source, an author and an allowed licence', () => {
  for (const [name, e] of entries()) {
    assert.ok(typeof e.source === 'string' && /^https?:\/\//.test(e.source), `${name}: source must be a URL`);
    assert.ok(typeof e.author === 'string' && e.author.trim(), `${name}: no author`);
    assert.ok(LICENSES.has(e.license), `${name}: licence "${e.license}" not in CC0 / CC-BY-4.0 / PD`);
  }
});

test('every material has colour, normal, orm and height maps', () => {
  for (const [name, m] of Object.entries(manifest.materials)) {
    for (const k of ['color', 'normal', 'orm', 'height']) assert.ok(m.maps?.[k], `${name}: no ${k} map`);
  }
});

test('every referenced file exists and is under 100 MB', () => {
  const list = files();
  assert.ok(list.length > 0, 'manifest references no files');
  for (const [name, f] of list) {
    assert.ok(typeof f === 'string' && !path.isAbsolute(f) && !f.includes('..'), `${name}: bad path ${f}`);
    const p = path.join(htmlDir, f);
    assert.ok(existsSync(p), `${name}: ${f} does not exist`);
    assert.ok(statSync(p).size < 100 * MB, `${name}: ${f} is ${(statSync(p).size / MB).toFixed(1)} MB`);
  }
});

test('hangar/html/assets/ totals under 600 MB', () => {
  const total = dirSize(assetsDir);
  assert.ok(total < 600 * MB, `assets total ${(total / MB).toFixed(1)} MB`);
});

test('every material tag used in e1m1.json has a manifest entry', () => {
  const tags = levelTags();
  assert.ok(tags.size > 0, 'no mat: tags found in the level');
  for (const t of tags) assert.ok(manifest.materials[t], `no manifest entry for ${t}`);
});

test('every texture is a real KTX2 file with a mip chain, every model a binary glTF', () => {
  for (const [name, f] of files()) {
    const p = path.join(htmlDir, f);
    if (!existsSync(p)) continue; // reported by the existence test
    assert.ok(statSync(p).size >= MIN_BYTES, `${name}: ${f} is only ${statSync(p).size} bytes`);
    if (f.endsWith('.ktx2')) {
      const h = ktx2Header(p);
      assert.ok(h.magic, `${name}: ${f} lacks the KTX2 identifier`);
      assert.ok(h.width > 0 && h.height > 0, `${name}: ${f} has no size`);
      assert.equal(h.levels, Math.floor(Math.log2(Math.max(h.width, h.height))) + 1, `${name}: ${f} has ${h.levels} mip levels`);
    } else if (f.endsWith('.glb')) {
      const b = head(p, 12);
      assert.equal(b.toString('latin1', 0, 4), 'glTF', `${name}: ${f} lacks the glTF magic`);
      assert.equal(b.readUInt32LE(4), 2, `${name}: ${f} is not glTF 2`);
      assert.equal(b.readUInt32LE(8), statSync(p).size, `${name}: ${f} header length does not match the file`);
    } else {
      assert.fail(`${name}: ${f} is neither .ktx2 nor .glb`);
    }
  }
});

test("tile gives at least 1024 px per metre, from each map's real pixel width", () => {
  for (const [name, m] of Object.entries(manifest.materials)) {
    assert.ok(Number.isFinite(m.tile) && m.tile > 0, `${name}: bad tile ${m.tile}`);
    for (const [k, f] of Object.entries(m.maps)) {
      const p = path.join(htmlDir, f);
      if (!existsSync(p)) continue;
      const { width } = ktx2Header(p);
      assert.ok(width / m.tile >= 1024, `${name}.${k}: ${width} px over ${m.tile} m gives ${(width / m.tile).toFixed(0)} px/m`);
    }
  }
});

test('models have a positive scale', () => {
  for (const [name, m] of Object.entries(manifest.models)) assert.ok(Number.isFinite(m.scale) && m.scale > 0, `${name}: bad scale`);
});
