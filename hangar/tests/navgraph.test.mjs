import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLevel, sectorAt } from '../html/js/level.js';
import { buildNavGraph, findPath, nearestNode, clearanceAt } from '../html/js/navgraph.js';

const json = JSON.parse(readFileSync(new URL('../html/data/e1m1.json', import.meta.url), 'utf8'));
const level = loadLevel(json);
const graph = buildNavGraph(level);
const kindsOf = (path) => path.slice(1).map((id, i) => graph.edges.get(path[i]).find((e) => e.to === id));
const exitSector = level.sectors.find((s) => s.tags.has('exit'));
const startId = nearestNode(graph, level.start.x, level.start.z);
const exitId = nearestNode(graph, ...(() => {
  const xs = exitSector.poly.map((p) => p[0]), zs = exitSector.poly.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
})());

test('graph has nodes and symmetric edges', () => {
  assert.ok(graph.nodes.length > 500);
  graph.nodes.forEach((n, i) => assert.equal(n.id, i));
  for (const [a, list] of graph.edges) for (const e of list) {
    assert.ok(graph.edges.get(e.to).some((r) => r.to === a), `edge ${a}->${e.to} has no reverse`);
    assert.ok(e.cost > 0 && Number.isFinite(e.cost));
  }
});

// `yard-platform` is a 1.2 m raised slab in the courtyard with no steps or lift (level data, T2);
// a walker cannot step onto it, so its poi cannot be reached on foot. Pinned here so that a
// level change that fixes it (or breaks another poi) is noticed.
const UNREACHABLE_POIS = new Set(['yard-platform']);

test('a path exists from the start to the exit sector and to every poi', () => {
  assert.equal(sectorAt(level, graph.nodes[exitId].x, graph.nodes[exitId].z).id, exitSector.id);
  assert.ok(findPath(graph, startId, exitId), 'start -> exit');
  for (const p of level.pois) {
    const id = nearestNode(graph, p.x, p.z);
    assert.ok(Math.hypot(graph.nodes[id].x - p.x, graph.nodes[id].z - p.z) < 3, `${p.id}: no node nearby`);
    const path = findPath(graph, startId, id);
    if (UNREACHABLE_POIS.has(p.id)) assert.equal(path, null, `${p.id} became reachable: update UNREACHABLE_POIS`);
    else assert.ok(path, `start -> poi ${p.id}`);
  }
});

test('no node lies in a slime or window sector; every node has clearance >= 0.4', () => {
  for (const n of graph.nodes) {
    const s = sectorAt(level, n.x, n.z);
    assert.ok(s, `node ${n.id} outside the level`);
    assert.ok(!s.tags.has('slime') && !s.tags.has('window'), `node ${n.id} in ${s.id}`);
    assert.ok(clearanceAt(level, n.x, n.z) >= 0.4 - 1e-6, `node ${n.id} (${n.x}, ${n.z}) clearance`);
  }
});

test('floor never changes by more than 0.72 m along an edge except on lifts', () => {
  for (const [a, list] of graph.edges) for (const e of list) {
    const d = Math.abs(graph.nodes[a].floor - graph.nodes[e.to].floor);
    if (e.kind !== 'lift') assert.ok(d <= 0.72 + 1e-9, `${a}->${e.to} (${e.kind}) differs by ${d}`);
    else assert.ok(d > 0.72, 'lift edge should span a big height');
  }
});

test('edge kinds: doors, stairs and exactly one lift exist', () => {
  const all = [...graph.edges.values()].flat();
  assert.ok(all.some((e) => e.kind === 'door'));
  assert.ok(all.some((e) => e.kind === 'stairs'));
  assert.equal(all.filter((e) => e.kind === 'lift').length, 2); // one lift, stored both ways
});

test('the path to the exit takes a lift or stairs and passes through a door', () => {
  const path = findPath(graph, startId, exitId);
  const es = kindsOf(path);
  assert.ok(es.some((e) => e.kind === 'lift' || e.kind === 'stairs'));
  assert.ok(es.some((e) => e.kind === 'lift'), 'exit is only reachable by the lift');
  assert.ok(es.some((e) => e.kind === 'door'));
});

test('paths never touch a slime or window sector', () => {
  const path = findPath(graph, startId, exitId);
  for (const id of path) {
    const s = sectorAt(level, graph.nodes[id].x, graph.nodes[id].z);
    assert.ok(!s.tags.has('slime') && !s.tags.has('window'));
  }
});

test('findPath returns null between disconnected rooms', () => {
  const sector = (id, poly) => ({ id, poly, floor: 0, ceil: 3, tags: new Set(['mat:steel']), light: 160 });
  const level2 = (sectors) => ({ sectors, byId: new Map(sectors.map((s) => [s.id, s])), walls: [], doors: [], lifts: [] });
  // Two separate 6 m rooms.
  const a = sector('a', [[0, 0], [6, 0], [6, 6], [0, 6]]);
  const b = sector('b', [[10, 0], [16, 0], [16, 6], [10, 6]]);
  const g = buildNavGraph(level2([a, b]));
  const na = nearestNode(g, 3, 3), nb = nearestNode(g, 13, 3);
  assert.notEqual(na, nb);
  assert.equal(findPath(g, na, nb), null);
  assert.deepEqual(findPath(g, na, na), [na]);
  // Join them with a doorway sector (shared edges need identical, reversed vertices).
  const a2 = sector('a', [[0, 0], [6, 0], [6, 2], [6, 4], [6, 6], [0, 6]]);
  const b2 = sector('b', [[10, 0], [16, 0], [16, 6], [10, 6], [10, 4], [10, 2]]);
  const hall = sector('h', [[6, 4], [6, 2], [10, 2], [10, 4]]);
  const g2 = buildNavGraph(level2([a2, hall, b2]));
  const path = findPath(g2, nearestNode(g2, 3, 3), nearestNode(g2, 13, 3));
  assert.ok(path, 'rooms joined by a hall should connect');
});

test('nearestNode honours floorY and returns null on an empty graph', () => {
  assert.equal(nearestNode({ nodes: [], edges: new Map() }, 0, 0), null);
  const lift = graph.nodes.find((n) => n.sector === 'exit-lift');
  const top = graph.nodes.find((n) => Math.abs(n.floor - 3.12) < 1e-6);
  assert.equal(nearestNode(graph, top.x, top.z, 3.12), top.id);
  assert.ok(lift);
});

test('build time is modest', () => {
  const t0 = performance.now();
  buildNavGraph(level);
  assert.ok(performance.now() - t0 < 500);
});
