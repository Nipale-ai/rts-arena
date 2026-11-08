import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../sim/mapgen.mjs';
import { loadMap, saveMap, validateMap, MAP_FORMAT } from '../sim/mapio.mjs';
import { Game } from '../sim/game.mjs';
import { NODES } from '../sim/data.mjs';
import { runMatch } from '../tools/run-match.mjs';

const N = 128;

test('2 player map is point symmetric (terrain, nodes, starts, resource totals)', () => {
  for (const seed of [1, 2, 3, 42, 99]) {
    const m = generateMap(seed);
    assert.equal(m.players.length, 2);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) assert.equal(m.terrain[y][x], m.terrain[N - 1 - y][N - 1 - x], `terrain ${x},${y} seed ${seed}`);
    const s = m.players.map((p) => p.start);
    assert.equal(s[1].tx, N - s[0].tx - 4);
    assert.equal(s[1].ty, N - s[0].ty - 4);
    const half = m.nodes.length / 2;
    assert.equal(half, Math.floor(half));
    for (let i = 0; i < half; i++) {
      const a = m.nodes[i], b = m.nodes[i + half], size = NODES[a.res].size;
      assert.equal(b.res, a.res);
      assert.equal(b.tx, N - a.tx - size);
      assert.equal(b.ty, N - a.ty - size);
      assert.equal(b.amount, a.amount);
    }
    // each player starts with identical resources in reach
    const g = new Game({ seed });
    const near = (st) => {
      const tot = {};
      for (const n of g.nodes.values()) if ((n.tx + 1 - st.tx - 2) ** 2 + (n.ty + 1 - st.ty - 2) ** 2 < 30 * 30) tot[n.res] = (tot[n.res] || 0) + n.amt;
      return tot;
    };
    assert.deepEqual(near(m.players[0].start), near(m.players[1].start));
  }
});

test('4 player map is mirror symmetric', () => {
  const m = generateMap(7, { players: 4 });
  assert.equal(m.players.length, 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      assert.equal(m.terrain[y][x], m.terrain[y][N - 1 - x]);
      assert.equal(m.terrain[y][x], m.terrain[N - 1 - y][x]);
    }
  const tot = [0, 0, 0, 0];
  const g = new Game({ seed: 7, numPlayers: 4 });
  for (const n of g.nodes.values()) {
    const q = (n.tx < 64 ? 0 : 1) + (n.ty < 64 ? 0 : 2);
    tot[q] += n.amt;
  }
  assert.ok(tot.every((t) => t === tot[0]), `quadrant resources equal: ${tot}`);
});

test('map save/load round trip gives the identical game', () => {
  const m = generateMap(5, { size: 128, shrines: true });
  const json = saveMap(m);
  const m2 = loadMap(json);
  assert.deepEqual(m2, m);
  const a = new Game({ seed: 5, map: m });
  const b = new Game({ seed: 5, map: m2 });
  const c = new Game({ seed: 5 });
  for (let i = 0; i < 300; i++) {
    a.step();
    b.step();
    c.step();
  }
  assert.equal(a.hash(), b.hash());
  assert.equal(a.hash(), c.hash());
});

test('hand made map with pre-placed units and buildings loads and runs a bot game', () => {
  const size = 64;
  const rows = Array.from({ length: size }, () => '.'.repeat(size));
  rows[30] = '.'.repeat(20) + '#'.repeat(24) + '.'.repeat(20);
  const m = {
    format: MAP_FORMAT, name: 'tiny', size, terrain: rows,
    nodes: [
      { res: 'gold', tx: 12, ty: 6, amount: 1500 }, { res: 'berries', tx: 14, ty: 12, amount: 200 }, { res: 'berries', tx: 15, ty: 12, amount: 200 },
      { res: 'gold', tx: 50, ty: 56, amount: 1500 }, { res: 'berries', tx: 49, ty: 50, amount: 200 }, { res: 'berries', tx: 48, ty: 50, amount: 200 },
    ],
    players: [
      { start: { tx: 8, ty: 8 }, buildings: [{ type: 'town_center', tx: 8, ty: 8 }, { type: 'house', tx: 5, ty: 5 }], units: [{ type: 'worker', tx: 12, ty: 10 }, { type: 'worker', tx: 12, ty: 11 }, { type: 'spearman', tx: 13, ty: 13 }] },
      { start: { tx: 52, ty: 52 } },
    ],
  };
  validateMap(m);
  const g = new Game({ seed: 1, map: m });
  assert.equal(g.W, 64);
  assert.equal([...g.units.values()].filter((u) => u.owner === 1).length, 3);
  assert.equal([...g.units.values()].filter((u) => u.owner === 2).length, 5);
  assert.equal([...g.buildings.values()].filter((b) => b.owner === 1).length, 2);
  const r = runMatch({ seed: 1, bots: ['boom', 'rush'], map: m, maxMinutes: 12 });
  assert.ok(r.ticks > 1000);
  assert.ok(r.result.players.every((p) => Object.keys(p.gathered).length));
});

test('invalid maps are rejected with a clear message', () => {
  const good = generateMap(1);
  assert.throws(() => loadMap({ ...good, format: 'x' }), /format/);
  assert.throws(() => loadMap({ ...good, size: 100 }), /rows/);
  assert.throws(() => loadMap({ ...good, players: [good.players[0]] }), /2 to 4/);
  assert.throws(() => loadMap({ ...good, nodes: [{ res: 'diamond', tx: 1, ty: 1, amount: 5 }] }), /unknown node/);
  assert.throws(() => loadMap('{not json'));
});
