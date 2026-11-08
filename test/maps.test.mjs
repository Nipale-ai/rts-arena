import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Game } from '../sim/game.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { generateMap } from '../sim/mapgen.mjs';
import { checkMap, detectSymmetry } from '../sim/mapcheck.mjs';
import { MAP_FORMAT } from '../sim/mapio.mjs';
import { createMapStore } from '../server/maps.mjs';
import { LiveMatch } from '../server/live-match.mjs';
import { verifyReplay } from '../server/replay-verify.mjs';
import { startMock } from '../agents/llm/mock-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function blank(size = 64) {
  const rows = Array.from({ length: size }, () => '.'.repeat(size));
  return {
    format: MAP_FORMAT, name: 'Blank', size, terrain: rows,
    nodes: [
      { res: 'gold', tx: 12, ty: 6, amount: 1500 }, { res: 'berries', tx: 14, ty: 12, amount: 200 },
      { res: 'gold', tx: size - 14, ty: size - 8, amount: 1500 }, { res: 'berries', tx: size - 15, ty: size - 13, amount: 200 },
    ],
    players: [{ start: { tx: 8, ty: 8 } }, { start: { tx: size - 12, ty: size - 12 } }],
  };
}
const setRow = (m, y, f) => { m.terrain[y] = f(m.terrain[y]); };

test('checkMap: generated maps are fair, symmetric and reachable', () => {
  for (const [seed, o] of [[1, {}], [5, { players: 4 }], [3, { size: 96, treasure: { gold: 2000, stone: 1200 } }]]) {
    const r = checkMap(generateMap(seed, o));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.fairness.level, 'perfect');
    assert.ok(['point', 'quad'].includes(r.symmetry));
    assert.ok(r.starts.every((s) => s.reachable));
    assert.equal(r.fairness.metrics.find((m) => m.key === 'gold').ratio, 1);
  }
});

test('checkMap: a wall of water between the starts is an error, a missing gold mine is unfair', () => {
  const m = blank();
  assert.equal(checkMap(m).ok, true);
  assert.equal(checkMap(m).symmetry, 'point');
  const walled = blank();
  for (let y = 0; y < 64; y++) setRow(walled, y, (r) => r.slice(0, 30) + '~~' + r.slice(32));
  const r = checkMap(walled);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /cannot walk/);
  const poor = blank();
  poor.nodes = poor.nodes.filter((n) => !(n.res === 'gold' && n.tx > 30));
  const p = checkMap(poor);
  assert.equal(p.ok, true);
  assert.equal(p.fairness.level, 'unfair');
  assert.equal(p.symmetry, null);
  assert.ok(p.warnings.some((w) => /Unfair/.test(w)));
});

test('checkMap: nodes on water, overlapping nodes and a start on cliffs are errors; bad format is reported', () => {
  const m = blank();
  setRow(m, 6, (r) => r.slice(0, 12) + '~~' + r.slice(14));
  m.nodes.push({ res: 'gold', tx: 13, ty: 12, amount: 100 }); // overlaps the berries at 14,12? gold is 2x2: tiles 13..14 x 12..13
  const r = checkMap(m);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /water or cliffs/);
  assert.match(r.errors.join(' '), /overlap/);
  const c = blank();
  setRow(c, 9, (x) => x.slice(0, 9) + '#' + x.slice(10));
  assert.match(checkMap(c).errors.join(' '), /town centre are not grass/);
  assert.equal(checkMap({ format: 'nope' }).ok, false);
  assert.equal(checkMap(null).ok, false);
});

test('detectSymmetry names the mirror', () => {
  const m = blank();
  assert.equal(detectSymmetry(m), 'point');
  assert.equal(detectSymmetry(generateMap(2, { players: 4 })), 'quad');
});

test('map store: save, list, load, overwrite, delete moves to _alt-maps, path tricks are refused', () => {
  const dir = tmp('rts-maps-');
  const st = createMapStore(dir);
  assert.deepEqual(st.list(), []);
  const a = st.save(blank());
  assert.equal(a.id, 'blank');
  assert.equal(a.check.ok, true);
  assert.equal(st.save(blank()).id, 'blank-2');
  assert.equal(st.save({ ...blank(), name: 'Renamed' }, 'blank').id, 'blank'); // overwrite keeps the id
  assert.equal(st.get('blank').name, 'Renamed');
  assert.equal(st.list().length, 2);
  assert.deepEqual(st.list().map((x) => x.players), [2, 2]);
  assert.throws(() => st.save({ format: 'rts-map-1', size: 5 }), /invalid map/);
  assert.equal(st.get('../etc/passwd'), null);
  assert.equal(st.get('generate'), null);
  assert.equal(st.remove('blank'), true);
  assert.equal(st.get('blank'), null);
  assert.ok(fs.readdirSync(path.join(dir, '_alt-maps')).length === 1);
  assert.equal(st.remove('../x'), false);
});

test('a match on a custom map records the map, replays bit-exact and the pre-placed units are used', () => {
  const m = blank();
  m.players[0].buildings = [{ type: 'town_center', tx: 8, ty: 8 }, { type: 'house', tx: 5, ty: 5 }];
  m.players[0].units = [{ type: 'worker', tx: 12, ty: 10 }, { type: 'worker', tx: 12, ty: 11 }, { type: 'spearman', tx: 13, ty: 13 }];
  const root = tmp('rts-cm-');
  const lm = new LiveMatch({ seed: 3, specs: ['scripted:boom', 'scripted:rush'], map: m, rules: 'classic', outRoot: root, maxGameSeconds: 120 });
  assert.equal([...lm.game.units.values()].filter((u) => u.owner === 1).length, 3);
  while (!lm.finished) lm.tick();
  const start = JSON.parse(fs.readFileSync(path.join(lm.dir, 'log.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(start.map_data.name, 'Blank');
  const v = verifyReplay(lm.dir);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.hash, lm.result.hash);
});

// ---- the arena over HTTP ----
async function startArena() {
  const data = tmp('rts-arena-');
  const child = spawn(process.execPath, [path.join(ROOT, 'server/arena.mjs'), '--port', '0', '--data', data], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('arena did not start')), 15000);
    child.stdout.on('data', (d) => { const m = /Arena: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
    child.on('exit', () => reject(new Error('arena exited')));
  });
  const call = async (p, body, method, headers = {}) => {
    const r = await fetch(base + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { base, data, call, stop: () => child.kill('SIGTERM') };
}

test('arena: map endpoints (generate, validate, save, list, load, delete) are same-origin only', async () => {
  const a = await startArena();
  try {
    const gen = await a.call('/api/maps/generate', { seed: 4, players: 4, size: 96 });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.map.players.length, 4);
    assert.equal(gen.body.check.fairness.level, 'perfect');
    const val = await a.call('/api/maps/validate', { map: blank() });
    assert.equal(val.body.ok, true);
    assert.equal((await a.call('/api/maps/validate', { map: { format: 'x' } })).body.ok, false);
    const saved = await a.call('/api/maps', { map: gen.body.map });
    assert.equal(saved.status, 200);
    const id = saved.body.id;
    assert.equal((await a.call('/api/maps')).body.maps.length, 1);
    assert.equal((await a.call('/api/maps/' + id)).body.map.size, 96);
    assert.equal((await a.call('/api/state')).body.maps[0].id, id);
    assert.equal((await a.call('/api/maps', { map: { format: 'bad' } })).status, 400);
    assert.equal((await a.call('/api/maps/..%2Fx')).status, 404);
    assert.equal((await a.call('/api/maps/catalog')).body.nodes.gold.size, 2);
    // foreign origin / cross-site writes are refused
    assert.equal((await a.call('/api/maps', { map: blank() }, 'POST', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await a.call('/api/maps', { map: blank() }, 'POST', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await a.call('/api/maps/' + id, undefined, 'DELETE', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await a.call('/api/maps/' + id, undefined, 'DELETE')).status, 200);
    assert.equal((await a.call('/api/maps')).body.maps.length, 0);
    // the editor page is served
    const html = await (await fetch(a.base + '/editor/')).text();
    assert.match(html, /World editor/);
  } finally { a.stop(); }
});

test('arena: relic shrines of a custom map survive saving, the mirror check sees them, and the match has them', async () => {
  const a = await startArena();
  try {
    assert.deepEqual((await a.call('/api/maps/catalog')).body.shrine, { size: 2, max: 8 });
    const gen = (await a.call('/api/maps/generate', { seed: 7, players: 2, size: 96, shrines: true })).body.map;
    assert.ok(gen.shrines.length >= 3, 'the editor can start from a generated map with shrines');
    assert.equal((await a.call('/api/maps/generate', { seed: 7, players: 2, size: 96 })).body.map.shrines, undefined);
    const m = blank(48);
    m.players = [{ start: { tx: 6, ty: 6 } }, { start: { tx: 38, ty: 38 } }];
    m.shrines = [{ tx: 23, ty: 23 }, { tx: 30, ty: 14 }, { tx: 16, ty: 32 }];
    const saved = (await a.call('/api/maps', { map: m })).body;
    assert.equal(saved.check.ok, true, JSON.stringify(saved.check.errors));
    assert.equal(saved.check.symmetry, 'point');
    const got = (await a.call('/api/maps/' + saved.id)).body.map;
    assert.deepEqual(got.shrines, m.shrines);
    const lop = (await a.call('/api/maps/validate', { map: { ...m, shrines: m.shrines.slice(0, 2) } })).body;
    assert.equal(lop.symmetry, null, 'a shrine without its mirror copy breaks the symmetry');
    const g = new Game({ seed: 1, map: got, rules: resolveRules({ preset: 'fast' }) });
    assert.deepEqual(g.shrines.map((q) => [q.tx, q.ty]), m.shrines.map((q) => [q.tx, q.ty]));
  } finally { a.stop(); }
});

test('arena: match from a custom map runs, finishes, replay page opens; wrong player count and unknown map are refused', async () => {
  const a = await startArena();
  try {
    const m = blank(48);
    m.nodes = [{ res: 'gold', tx: 12, ty: 6, amount: 800 }, { res: 'gold', tx: 34, ty: 40, amount: 800 }, { res: 'berries', tx: 14, ty: 12, amount: 200 }, { res: 'berries', tx: 33, ty: 35, amount: 200 }];
    m.players = [{ start: { tx: 6, ty: 6 } }, { start: { tx: 38, ty: 38 } }];
    const id = (await a.call('/api/maps', { map: m })).body.id;
    const four = { map: { type: 'custom', id }, players: [{ type: 'bot' }, { type: 'bot' }, { type: 'bot' }, { type: 'bot' }] };
    const bad = await a.call('/api/matches', four);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /2 start positions/);
    assert.equal((await a.call('/api/matches', { map: { type: 'custom', id: 'nope' }, players: [{ type: 'bot' }, { type: 'bot' }] })).status, 400);
    const r = await a.call('/api/matches', { map: { type: 'custom', id }, seed: 1, rules: { time_limit_min: 1, speed: 64 }, players: [{ type: 'bot', bot: 'rush', creator: 'blue-circle' }, { type: 'bot', bot: 'boom' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.map.type, 'custom');
    assert.equal(r.body.map.name, 'Blank');
    assert.equal(r.body.players[0].creator, 'blue-circle');
    const mid = r.body.id;
    let rec;
    for (let i = 0; i < 100; i++) {
      rec = (await a.call('/api/matches/' + mid)).body;
      if (rec.status !== 'running') break;
      await new Promise((x) => setTimeout(x, 200));
    }
    assert.notEqual(rec.status, 'running');
    const page = await fetch(a.base + '/watch/r-' + mid + '/');
    assert.equal(page.status, 200);
    const v = verifyReplay(path.join(ROOT, 'replays', mid));
    assert.equal(v.ok, true, JSON.stringify(v));
  } finally { a.stop(); }
});

test('arena: connection test with and without a model id', async () => {
  const mock = await startMock({ strategy: 'boom', delayMs: 10, jitterMs: 0, tokS: 80, seed: 1 });
  const a = await startArena();
  try {
    const base = mock.url;
    const withModel = await a.call('/api/test', { base_url: base, model: 'mock-boom' });
    assert.equal(withModel.body.ok, true, JSON.stringify(withModel.body));
    const noModel = await a.call('/api/test', { base_url: base, model: '' });
    assert.equal(noModel.body.ok, true);
    assert.ok(Array.isArray(noModel.body.models));
    assert.equal(noModel.body.completion_ms, null);
    const dead = await a.call('/api/test', { base_url: 'http://127.0.0.1:9/v1', model: 'x' });
    assert.equal(dead.body.ok, false);
    assert.ok(dead.body.error);
    assert.equal((await a.call('/api/test', { base_url: 'ftp://x', model: 'x' })).status, 400);
  } finally { a.stop(); await mock.close(); }
});

test('arena: the connection test waits for the model as long as the player timeout says', async () => {
  const mock = await startMock({ strategy: 'boom', delayMs: 6500, jitterMs: 0, tokS: 80, seed: 1 });
  const a = await startArena();
  try {
    const short = await a.call('/api/test', { base_url: mock.url, model: 'mock-boom', timeout_s: 5 });
    assert.equal(short.body.ok, false);
    assert.match(short.body.error, /timeout/);
    const long = await a.call('/api/test', { base_url: mock.url, model: 'mock-boom', timeout_s: 30 });
    assert.equal(long.body.ok, true, JSON.stringify(long.body));
    assert.ok(long.body.completion_ms >= 6000);
  } finally { a.stop(); await mock.close(); }
});
