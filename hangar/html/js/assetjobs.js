// Hangar — Asset job list (pure: no three, tested under node). Turns the manifest into the files to fetch,
// grouped by item (a material's four maps, a model, an image) and ordered so priority items come first.

export const MAP_KEYS = ['color', 'normal', 'orm', 'height'];

/**
 * The manifest's items in fetch order: `priority` names first, in the order given, then everything else in
 * manifest order. A priority name matches a material tag (`mat:steel`), a model name or an image name;
 * unknown names are ignored. Each item: { kind: 'material'|'model'|'image', name, files: [job] } where a job
 * is { kind: 'texture'|'model', key, path, map?, scale? }.
 */
export function manifestItems(manifest, priority = []) {
  const items = [];
  for (const [tag, m] of Object.entries(manifest?.materials ?? {})) {
    const files = MAP_KEYS.filter((k) => m.maps?.[k]).map((map) => ({ kind: 'texture', key: `${tag}.${map}`, path: m.maps[map], map }));
    items.push({ kind: 'material', name: tag, files });
  }
  for (const [name, m] of Object.entries(manifest?.models ?? {})) {
    items.push({ kind: 'model', name, files: [{ kind: 'model', key: name, path: m.file, scale: m.scale ?? 1 }] });
  }
  for (const [name, m] of Object.entries(manifest?.images ?? {})) {
    items.push({ kind: 'image', name, files: [{ kind: 'texture', key: `image.${name}`, path: m.file, map: 'image' }] });
  }
  const rank = new Map();
  priority.forEach((name, i) => { if (!rank.has(name)) rank.set(name, i); });
  const r = (it) => (rank.has(it.name) ? rank.get(it.name) : Infinity);
  // Array.prototype.sort is stable, so non-priority items keep manifest order.
  return items.sort((a, b) => r(a) - r(b));
}

/** Every file in fetch order (priority items' files first), each tagged with its item index. */
export function manifestJobs(manifest, priority = []) {
  return manifestItems(manifest, priority).flatMap((item, i) => item.files.map((f) => ({ ...f, item: i })));
}

/**
 * Byte-weighted load fraction. `files` is [{ loaded, total, done }] per file; `total` is 0 until the server
 * reports a length. A file of unknown size weighs the mean of the known sizes (or `guess` bytes before any
 * size is known), so the bar doesn't jump when big files report late. Finished files count as complete.
 */
export function progressFraction(files, guess = 4 * 1024 * 1024) {
  if (!files.length) return 1;
  let known = 0, nKnown = 0;
  for (const f of files) if (f.total > 0) { known += f.total; nKnown++; }
  const unit = nKnown ? known / nKnown : guess;
  let got = 0, all = 0;
  for (const f of files) {
    const w = f.total > 0 ? f.total : unit;
    all += w;
    got += f.done ? w : Math.min(f.total > 0 ? f.loaded : 0, w * 0.99);
  }
  return all > 0 ? got / all : 1;
}
