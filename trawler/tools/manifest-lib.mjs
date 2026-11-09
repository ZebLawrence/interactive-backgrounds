// Shared helpers for the Trawler asset tools: paths, the manifest file, and downloads.
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

export const TOOLS = path.dirname(fileURLToPath(import.meta.url));
export const RAW = path.join(TOOLS, 'raw');
export const HTML = path.join(TOOLS, '..', 'html');
export const MANIFEST = path.join(HTML, 'assets', 'manifest.json');

/** `mat:panel-brown` -> `panel-brown` (used as a folder name). */
export const slugOf = (tag) => tag.replace(/^mat:/, '').replace(/[^a-z0-9-]/gi, '-');

/** Paths (relative to trawler/html/) of a material's three processed maps. */
export function materialMaps(tag) {
  const dir = `assets/materials/${slugOf(tag)}`;
  return { color: `${dir}/color.webp`, normal: `${dir}/normal.webp`, orm: `${dir}/orm.webp` };
}

export function readManifest() {
  if (!existsSync(MANIFEST)) return { materials: {}, models: {}, images: {} };
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const s of ['materials', 'models', 'images']) m[s] ??= {};
  return m;
}

/** Writes the manifest with each section's keys sorted, so diffs stay small. */
export function writeManifest(m) {
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const out = { materials: sorted(m.materials), models: sorted(m.models), images: sorted(m.images) };
  mkdirSync(path.dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + '\n');
}

export async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'trawler-asset-tools' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Downloads `url` to `file` (skipped if it already exists, so reruns are cheap). */
export async function download(url, file) {
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const r = await fetch(url, { headers: { 'User-Agent': 'trawler-asset-tools' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(file + '.part'));
  renameSync(file + '.part', file);
  console.log(`  got ${path.relative(TOOLS, file)}`);
  return file;
}
