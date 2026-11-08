import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestItems, manifestJobs, progressFraction } from '../html/js/assetjobs.js';

const maps = (s) => ({ color: `${s}/c`, normal: `${s}/n`, orm: `${s}/o`, height: `${s}/h` });
const manifest = {
  materials: { 'mat:a': { maps: maps('a') }, 'mat:b': { maps: maps('b') }, 'mat:c': { maps: maps('c') } },
  models: { barrel: { file: 'm/barrel.glb', scale: 2 } },
  images: { mars: { file: 'i/mars.ktx2' } },
};

test('without priority, items keep manifest order: materials, models, images', () => {
  assert.deepEqual(manifestItems(manifest).map((i) => i.name), ['mat:a', 'mat:b', 'mat:c', 'barrel', 'mars']);
});

test('priority items come first in the order given, the rest keep manifest order', () => {
  const order = manifestItems(manifest, ['mars', 'mat:c', 'nonexistent']).map((i) => `${i.kind}:${i.name}`);
  assert.deepEqual(order, ['image:mars', 'material:mat:c', 'material:mat:a', 'material:mat:b', 'model:barrel']);
});

test('jobs list every file once, priority files first, tagged with their item', () => {
  const jobs = manifestJobs(manifest, ['mat:b']);
  assert.equal(jobs.length, 3 * 4 + 1 + 1);
  assert.deepEqual(jobs.slice(0, 4).map((j) => j.key), ['mat:b.color', 'mat:b.normal', 'mat:b.orm', 'mat:b.height']);
  assert.ok(jobs.slice(0, 4).every((j) => j.item === 0));
  const model = jobs.find((j) => j.kind === 'model');
  assert.deepEqual([model.key, model.path, model.scale], ['barrel', 'm/barrel.glb', 2]);
  assert.equal(jobs.find((j) => j.key === 'image.mars').map, 'image');
});

test('an empty or missing manifest gives no jobs', () => {
  assert.deepEqual(manifestJobs({}), []);
  assert.deepEqual(manifestJobs(null), []);
});

test('progress is weighted by bytes, not by file count', () => {
  const files = [{ loaded: 100, total: 100, done: true }, { loaded: 0, total: 900, done: false }];
  assert.equal(progressFraction(files), 0.1);
  files[1].loaded = 450;
  assert.equal(progressFraction(files), 0.55);
});

test('unsized files weigh the mean known size; finished files are complete; never reaches 1 early', () => {
  assert.equal(progressFraction([{ loaded: 0, total: 0, done: true }, { loaded: 0, total: 0, done: false }]), 0.5);
  const f = progressFraction([{ loaded: 200, total: 200, done: false }]);
  assert.ok(f < 1 && f >= 0.98);
  assert.equal(progressFraction([]), 1);
});
