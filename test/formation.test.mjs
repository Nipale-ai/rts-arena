import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { stepN } from '../test-support/helpers.mjs';
import { symmetryDiff } from '../tools/seat-bias.mjs';

// An open grass map with the two town centres in opposite corners; `walls` are blocked tiles (cliffs), mirrored for the other seat.
function openMap(walls = [], size = 64) {
  const grid = Array.from({ length: size }, () => Array(size).fill('.'));
  for (const [x, y] of walls) { grid[y][x] = '#'; grid[size - 1 - y][size - 1 - x] = '#'; }
  return { format: 'rts-map-1', name: 'open', size, terrain: grid.map((r) => r.join('')), nodes: [], players: [{ start: { tx: 4, ty: 4 } }, { start: { tx: size - 8, ty: size - 8 } }] };
}
const game = (walls) => new Game({ seed: 3, rules: 'fast', map: openMap(walls) });
const mk = (g, owner, type, tx, ty) => g.addUnit(owner, type, Math.round(tx * 1000), Math.round(ty * 1000));
// a blob of units around (cx, cy)
function blob(g, owner, comp, cx, cy) {
  const us = [];
  let n = 0;
  for (const [type, c] of Object.entries(comp)) for (let i = 0; i < c; i++, n++) us.push(mk(g, owner, type, cx + (n % 5) * 0.7 - 1.4, cy + Math.floor(n / 5) * 0.7 - 1));
  return us;
}
const ARMY = { spearman: 8, archer: 6, light_cavalry: 2, ram: 1, healer: 1 };
const ids = (us) => us.map((u) => u.id);
const slot = (u) => [u.ord.x, u.ord.y];

test('formation: a group order gives every unit a slot in ranks, wider than deep, facing the target', () => {
  const g = game();
  const us = blob(g, 1, ARMY, 14, 30);
  const r = g.command(1, { cmd: 'move', units: ids(us), to: [48, 30] });
  assert.equal(r.ok, true);
  assert.equal(g.forms.size, 1);
  assert.ok(us.every((u) => u.ord.t === 'move' && u.ord.fm === 1));
  // the target is due east: forward is +x, the slots are laid around (48.5, 30.5)
  const by = (type) => us.filter((u) => u.type === type);
  const mean = (a, k) => a.reduce((s, u) => s + slot(u)[k], 0) / a.length;
  assert.ok(mean(by('spearman'), 0) > mean(by('archer'), 0), 'infantry stand in front of the archers');
  assert.ok(mean(by('archer'), 0) > mean(by('ram'), 0), 'archers stand in front of the ram');
  assert.ok(mean(by('archer'), 0) > mean(by('healer'), 0), 'healers stay behind the archers');
  const line = us.filter((u) => u.type !== 'light_cavalry');
  const span = (a, k) => Math.max(...a.map((u) => slot(u)[k])) - Math.min(...a.map((u) => slot(u)[k]));
  assert.ok(span(line, 1) > span(line, 0), `wider than deep: ${span(line, 1)} vs ${span(line, 0)}`);
  const ys = line.map((u) => slot(u)[1]);
  const cav = by('light_cavalry');
  assert.ok(cav.some((u) => slot(u)[1] < Math.min(...ys)) && cav.some((u) => slot(u)[1] > Math.max(...ys)), 'cavalry guard both flanks');
  // the whole body is centred on the target
  assert.ok(Math.abs(mean(us, 0) - 48500) < 1200 && Math.abs(mean(us, 1) - 30500) < 600);
  // nobody shares a slot
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) assert.ok(Math.hypot(slot(us[i])[0] - slot(us[j])[0], slot(us[i])[1] - slot(us[j])[1]) >= 800, `${us[i].type} and ${us[j].type} overlap`);
});

test('formation: the same order to two or more units forms, one unit does not', () => {
  const g = game();
  const [a, b, c] = blob(g, 1, { spearman: 3 }, 14, 30);
  g.command(1, { cmd: 'move', units: [a.id], to: [30, 30] });
  assert.ok(!a.ord.fm);
  g.command(1, { cmd: 'attack_move', units: [b.id, c.id], target: [30, 30] });
  assert.ok(b.ord.fm && b.ord.fm === c.ord.fm && b.ord.t === 'amove');
});

test('formation: the group marches at the speed of the slowest unit and arrives together', () => {
  const g = game();
  const us = blob(g, 1, ARMY, 14, 30);
  g.command(1, { cmd: 'move', units: ids(us), to: [50, 30] });
  const home = new Map(us.map((u) => [u.id, slot(u)]));
  const ram = g.players[1].stats.ram.speed;
  const arrive = new Map();
  let maxStep = 0;
  const last = new Map(us.map((u) => [u.id, [u.x, u.y]]));
  for (let t = 1; t <= 800 && arrive.size < us.length; t++) {
    g.step();
    for (const u of us) {
      const l = last.get(u.id);
      if (t > 60 && !arrive.has(u.id)) maxStep = Math.max(maxStep, Math.hypot(u.x - l[0], u.y - l[1]));
      last.set(u.id, [u.x, u.y]);
      if (u.ord.t === 'idle' && !arrive.has(u.id)) arrive.set(u.id, t);
    }
    if (t === 150) { // under way: everybody is close to its place in the body
      const f = g.forms.get(1);
      assert.equal(f.st, 'march');
      for (const u of us) assert.ok(Math.hypot(u.ord.sx - u.x, u.ord.sy - u.y) < 1500, `${u.type} lags on the march`);
    }
  }
  assert.equal(arrive.size, us.length, 'everybody arrived');
  const ticks = [...arrive.values()];
  assert.ok(Math.max(...ticks) - Math.min(...ticks) <= 25, `arrival spread ${Math.min(...ticks)}..${Math.max(...ticks)}`);
  assert.ok(Math.min(...ticks) >= (34000 * 0.9) / ram, 'the cavalry did not run ahead of the ram');
  assert.ok(maxStep <= ram + 2, `no unit outpaces the slowest (${maxStep} > ${ram})`);
  for (const u of us) assert.ok(Math.hypot(u.x - home.get(u.id)[0], u.y - home.get(u.id)[1]) <= 400, `${u.type} stands at its slot`);
  stepN(g, 2);
  assert.equal(g.forms.size, 0);
});

test('formation: a slot on a blocked tile or off the map falls back to the nearest free tile', () => {
  const cliff = [];
  for (let y = 22; y < 42; y++) cliff.push([40, y], [41, y]);
  const g = game(cliff);
  const us = blob(g, 1, { spearman: 8, archer: 6 }, 20, 32);
  g.command(1, { cmd: 'move', units: ids(us), to: [39, 32] }); // the front rank would stand inside the cliff
  const free = (x, y) => g.slotFree(1, x, y);
  for (const u of us) assert.ok(free(...slot(u)), `${u.type} slot ${slot(u)} is free`);
  const tiles = new Set(us.map((u) => `${Math.floor(slot(u)[0] / 1000)},${Math.floor(slot(u)[1] / 1000)}`));
  assert.ok(us.some((u) => slot(u)[0] % 1000 === 500 && slot(u)[1] % 1000 === 500), 'some slots were moved to a tile centre');
  assert.ok(tiles.size >= us.length - 2, 'the fallback spreads the units over different tiles');
  stepN(g, 700);
  assert.ok(us.every((u) => u.ord.t === 'idle'), 'all arrived');
  assert.ok(us.every((u) => !g.blk[g.tileMilli(1, u.y) * g.W + g.tileMilli(1, u.x)]), 'nobody stands in the cliff');
  // map edge
  const g2 = game();
  const vs = blob(g2, 1, { spearman: 10 }, 40, 30);
  g2.command(1, { cmd: 'move', units: ids(vs), to: [63, 30] });
  for (const u of vs) assert.ok(u.ord.x >= 0 && u.ord.x < 64000, `slot ${u.ord.x} is on the map`);
  stepN(g2, 400);
  assert.ok(vs.every((u) => u.ord.t === 'idle' && u.x < 64000));
});

test('formation: the group goes round an obstacle and still arrives together', () => {
  const wall = [];
  for (let y = 16; y < 40; y++) wall.push([30, y]);
  const g = game(wall);
  const us = blob(g, 1, { spearman: 8, archer: 6, ram: 1 }, 14, 30);
  g.command(1, { cmd: 'move', units: ids(us), to: [46, 30] });
  const arrive = new Map();
  for (let t = 1; t <= 1200 && arrive.size < us.length; t++) {
    g.step();
    for (const u of us) if (u.ord.t === 'idle' && !arrive.has(u.id)) arrive.set(u.id, t);
  }
  assert.equal(arrive.size, us.length);
  const ticks = [...arrive.values()];
  assert.ok(Math.max(...ticks) - Math.min(...ticks) <= 60, `arrival spread ${Math.min(...ticks)}..${Math.max(...ticks)}`);
  assert.ok(us.every((u) => !g.blk[g.tileMilli(1, u.y) * g.W + g.tileMilli(1, u.x)]));
});

test('formation: a unit with a new order leaves it, the rest carry on', () => {
  const g = game();
  const us = blob(g, 1, { spearman: 6, archer: 4 }, 14, 30);
  g.command(1, { cmd: 'move', units: ids(us), to: [46, 30] });
  stepN(g, 40);
  g.command(1, { cmd: 'move', units: [us[0].id], to: [14, 50] });
  assert.ok(!us[0].ord.fm);
  stepN(g, 2);
  assert.equal(g.forms.get(1).ids.length, 9);
  stepN(g, 600);
  assert.ok(us.every((u) => u.ord.t === 'idle'));
  assert.ok(Math.abs(us[0].y - 50500) < 1300, 'the single unit went its own way');
});

test('formation: a fight breaks the formation on attack_move, not on a plain move', () => {
  const run = (cmd) => {
    const g = game();
    const us = blob(g, 1, { spearman: 6, archer: 4 }, 14, 30);
    mk(g, 2, 'spearman', 36, 30); // an enemy on the way
    g.command(1, { cmd, units: ids(us), ...(cmd === 'move' ? { to: [46, 30] } : { target: [46, 30] }) });
    let fought = 0;
    for (let t = 0; t < 300; t++) {
      g.step();
      for (const u of us) if (u.tgt) { fought++; if (u.ord.t === 'amove') assert.ok(!u.ord.fm, 'a unit in a fight is out of the formation'); }
    }
    return { fought, us };
  };
  assert.ok(run('attack_move').fought > 0, 'the units saw the enemy and fought');
  assert.equal(run('move').fought, 0);
});

test('formation: units that leave go to the common target tile and share one path field, not one per slot', () => {
  // a wall of cliffs between the group and the target, so that the members need the flow field
  const walls = [];
  for (let y = 10; y < 54; y++) walls.push([30, y]);
  const g = game(walls);
  const us = blob(g, 1, { spearman: 12, archer: 8 }, 14, 30);
  g.command(1, { cmd: 'attack_move', units: ids(us), target: [48, 30] });
  stepN(g, 10);
  for (const u of us) g.leaveForm(u);
  assert.ok(us.every((u) => !u.ord.fm && u.ord.x === 48500 && u.ord.y === 30500 && u.ord.r > 0), 'the plain order: common tile, group radius');
  const before = g.paths.computed;
  stepN(g, 200);
  assert.ok(g.paths.computed - before <= 4, `one field for the whole group, got ${g.paths.computed - before}`);
});

test('formation: workers form a loose block', () => {
  const g = game();
  const ws = blob(g, 1, { worker: 6 }, 14, 30);
  g.command(1, { cmd: 'move', units: ids(ws), to: [30, 30] });
  assert.ok(ws.every((u) => u.ord.fm));
  const xs = ws.map((u) => slot(u)[0]), ys = ws.map((u) => slot(u)[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs));
  stepN(g, 300);
  assert.ok(ws.every((u) => u.ord.t === 'idle'));
});

test('formation: same seed and same orders give the same game', () => {
  const run = () => {
    const wall = [[26, 28], [26, 29], [26, 30], [26, 31]];
    const g = game(wall);
    const us = blob(g, 1, ARMY, 14, 30);
    g.command(1, { cmd: 'attack_move', units: ids(us), target: [48, 31] });
    stepN(g, 200);
    const vs = blob(g, 1, { spearman: 5 }, 30, 20);
    g.command(1, { cmd: 'move', units: ids(vs), to: [20, 44] });
    stepN(g, 400);
    return [g.hash(), us.map((u) => [u.x, u.y].join()).join(';')];
  };
  assert.deepEqual(run(), run());
});

test('formation: the second seat marches in the exact mirror image', () => {
  const wall = [[13, 42], [14, 42], [15, 42], [16, 42], [26, 27], [26, 28]];
  const g = game(wall);
  const W = g.W;
  const a = blob(g, 1, ARMY, 14, 30);
  // point mirror of the blob: the same units, mirrored places
  const b = [];
  for (const u of a) b.push(g.addUnit(2, u.type, W * 1000 - u.x, W * 1000 - u.y));
  assert.equal(symmetryDiff(g), null);
  g.command(1, { cmd: 'attack_move', units: ids(a), target: [14, 56] });
  g.command(2, { cmd: 'attack_move', units: ids(b), target: [W - 1 - 14, W - 1 - 56] });
  assert.ok(a.every((u) => u.ord.fm) && b.every((u) => u.ord.fm));
  for (let i = 0; i < 40; i++) {
    stepN(g, 25);
    assert.equal(symmetryDiff(g), null, `tick ${g.t}`);
  }
  assert.ok(a.every((u) => u.ord.t === 'idle') && b.every((u) => u.ord.t === 'idle'), 'both seats arrived');
});
