import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { observe } from '../sim/observe.mjs';
import { runMatch } from '../tools/run-match.mjs';
import { replay } from '../sim/replay.mjs';
import { stepN, tc, workers } from '../test-support/helpers.mjs';

const dir = (g, o) => g.command(0, { cmd: 'director', ...o });
const fresh = (seed = 5, rules) => { const g = new Game({ seed, rules }); stepN(g, 5); return g; };

test('director: give resources, logged as a player-0 command, marks the match god mode', () => {
  const g = fresh();
  assert.equal(g.godMode, false);
  assert.equal(g.result().godMode, false);
  const before = g.players[1].res.food;
  const r = dir(g, { action: 'give', player: 1, res: 'food', amount: 100 });
  assert.equal(r.ok, true);
  assert.equal(g.players[1].res.food, before + 100);
  assert.equal(g.godMode, true);
  assert.equal(g.result().godMode, true);
  assert.deepEqual(g.commandLog.at(-1), { t: g.t, p: 0, cmd: { cmd: 'director', action: 'give', player: 1, res: 'food', amount: 100 } });
  assert.equal(g.godFeed.at(-1).text, '+100 food to blue');
});

test('director: bad input is rejected, changes nothing and does not mark the match', () => {
  const g = fresh();
  const h = g.hash();
  for (const o of [{ action: 'give', player: 9, res: 'food' }, { action: 'give', player: 1, res: 'mana' }, { action: 'nope' }, { action: 'spawn', player: 1, unit: 'dragon' }, { action: 'remove', id: 99999 }]) {
    assert.equal(dir(g, o).ok, false, JSON.stringify(o));
  }
  assert.equal(g.command(0, { cmd: 'give' }).ok, false);
  assert.equal(g.godMode, false);
  assert.equal(g.hash(), h);
});

test('director: agents cannot send director commands (no tool, and player ids start at 1)', () => {
  const g = fresh();
  const r = g.command(1, { cmd: 'director', action: 'give', player: 1, res: 'gold', amount: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_command');
  assert.equal(g.godMode, false);
});

test('director: spawn units at a clicked spot, heal, remove', () => {
  const g = fresh();
  const w = workers(g, 1)[0];
  const tx = Math.floor(w.x / 1000), ty = Math.floor(w.y / 1000);
  const n0 = [...g.units.values()].filter((u) => u.owner === 2).length;
  const r = dir(g, { action: 'spawn', player: 2, unit: 'archer', x: tx, y: ty, count: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.ids.length, 3);
  assert.equal([...g.units.values()].filter((u) => u.owner === 2).length, n0 + 3);
  for (const id of r.ids) {
    const u = g.units.get(id);
    assert.equal(u.type, 'archer');
    assert.ok(Math.abs(u.x / 1000 - tx) < 9 && Math.abs(u.y / 1000 - ty) < 9);
  }
  assert.equal(new Set(r.ids.map((id) => g.units.get(id).x + ',' + g.units.get(id).y)).size, 3, 'spread over different tiles');
  const u = g.units.get(r.ids[0]);
  u.hp = 3;
  assert.equal(dir(g, { action: 'heal', id: u.id }).ok, true);
  assert.equal(u.hp, u.maxhp);
  for (const v of g.units.values()) if (v.owner === 1) v.hp = 1;
  assert.equal(dir(g, { action: 'heal', player: 1 }).ok, true);
  for (const v of g.units.values()) if (v.owner === 1) assert.equal(v.hp, v.maxhp);
  const pop = g.players[2].pop;
  assert.equal(dir(g, { action: 'remove', id: r.ids[1] }).ok, true);
  g.step();
  assert.equal(g.units.has(r.ids[1]), false);
  assert.equal(g.players[2].pop, pop - 1);
  assert.equal(g.players[1].kills, 0, 'a removal is no kill');
});

test('director: reveal opens the map for the agent of that player only', () => {
  const g = fresh(7);
  const explored = (pid) => observe(g, pid).map.explored_pct;
  assert.ok(explored(1) < 60 && explored(2) < 60);
  dir(g, { action: 'reveal', player: 1 });
  g.step();
  assert.equal(explored(1), 100);
  assert.ok(explored(2) < 60, 'the other player is not affected');
  assert.ok(observe(g, 1).enemy_buildings.some((b) => b.type === 'town_center'), 'player 1 now knows the enemy town centre');
  dir(g, { action: 'reveal', player: 1, on: false });
  assert.equal(g.revealed.size, 0);
});

test('director: wolves come from the map edge (mirrored pack on 2 player maps), chase the nearest unit and hurt it', () => {
  const g = fresh(5, 'fast');
  const r = dir(g, { action: 'wolves', count: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.ids.length, 6, 'two mirrored packs');
  const [a, b] = [g.units.get(r.ids[0]), g.units.get(r.ids[3])];
  assert.equal(a.owner, 0);
  assert.ok(a.x < 4000 || a.y < 4000 || a.x > (g.W - 4) * 1000 || a.y > (g.W - 4) * 1000, 'at the edge');
  assert.ok(Math.abs(a.x + b.x - g.W * 1000) < 6000 && Math.abs(a.y + b.y - g.W * 1000) < 6000, 'mirrored pack');
  stepN(g, 1200);
  assert.ok(g.wild.unitStats.wolf && g.wild.unitStats.wolf.dmg > 0, 'wolves bit somebody');
  assert.equal(g.result().players.length, 2, 'wolves are not a player');
});

test('director: soldiers fight wolves and win; wolves leave after a while', () => {
  const g = fresh(5, 'fast');
  const tcb = tc(g, 1);
  const sp = dir(g, { action: 'spawn', player: 1, unit: 'spearman', x: tcb.tx + 2, y: tcb.ty + 2, count: 6 });
  assert.equal(sp.ok, true);
  const w = dir(g, { action: 'wolves', x: tcb.tx, y: tcb.ty, count: 2, mirror: false });
  assert.equal(w.ids.length, 2);
  stepN(g, 1500);
  assert.ok(w.ids.filter((id) => g.units.has(id)).length < 2, 'at least one wolf was killed by the army');
  stepN(g, 400);
  assert.equal(w.ids.filter((id) => g.units.has(id)).length, 0, 'the rest left (time to live)');
});

test('director: the first worker that reaches the treasure keeps it', () => {
  const g = fresh(5, 'fast');
  const w1 = workers(g, 1)[0];
  const tx = Math.floor(w1.x / 1000) + 6, ty = Math.floor(w1.y / 1000);
  const r = dir(g, { action: 'treasure', x: tx, y: ty, res: 'gold', amount: 300 });
  assert.equal(r.ok, true);
  assert.equal(g.chests.length, 1);
  const gold0 = g.players[1].res.gold + g.players[2].res.gold;
  g.command(1, { cmd: 'move', units: [w1.id], to: [r.tile[0], r.tile[1]] });
  stepN(g, 150);
  assert.equal(g.chests.length, 0, 'chest taken');
  assert.equal(g.players[1].res.gold + g.players[2].res.gold, gold0 + 300);
  assert.match(g.godFeed.at(-1).text, /^(blue|orange) found the treasure: \+300 gold$/);
});

test('director: a chest nobody reaches is gone after its time', () => {
  const g = fresh(5, 'fast');
  dir(g, { action: 'treasure', x: 0, y: 0 });
  assert.equal(g.chests.length, 1);
  stepN(g, 6100);
  assert.equal(g.chests.length, 0);
});

test('director: a storm slows movement and gathering inside the circle while it lasts', () => {
  const dist = (storm) => {
    const g = fresh(5, 'fast');
    const id = dir(g, { action: 'spawn', player: 1, unit: 'archer', x: 20, y: 20 }).ids[0];
    const a = g.units.get(id);
    g.command(1, { cmd: 'move', units: [id], to: [40, 20] });
    if (storm) dir(g, { action: 'storm', x: 30, y: 20, r: 20, secs: 30 });
    const x0 = a.x;
    stepN(g, 60);
    return a.x - x0;
  };
  const free = dist(false), stormy = dist(true);
  assert.ok(stormy > 0 && stormy < free * 0.75, `storm ${stormy} vs free ${free}`);
  const g = fresh(5, 'fast');
  dir(g, { action: 'storm', x: 10, y: 10, r: 3, secs: 5 });
  assert.equal(g.storms.length, 1);
  stepN(g, 60);
  assert.equal(g.storms.length, 0, 'storm passed');
  const gathered = (storm) => {
    const h = fresh(5, 'fast');
    if (storm) { const t = tc(h, 1); dir(h, { action: 'storm', x: t.tx, y: t.ty, r: 24, secs: 120 }); }
    stepN(h, 400);
    return h.players[1].gathered.food + h.players[1].gathered.wood;
  };
  assert.ok(gathered(true) < gathered(false), 'gathering is slower in the storm');
});

test('director: a live run with interventions and its replay end identically (determinism)', () => {
  const plan = [
    [150, { action: 'give', player: 1, res: 'wood', amount: 100 }],
    [300, { action: 'spawn', player: 2, unit: 'swordsman', x: 60, y: 60, count: 4 }],
    [450, { action: 'wolves', count: 3 }],
    [600, { action: 'storm', x: 48, y: 48, r: 12, secs: 30 }],
    [700, { action: 'treasure', res: 'mixed', amount: 120 }],
    [900, { action: 'reveal', player: 2 }],
    [1000, { action: 'heal', player: 1 }],
    [1200, { action: 'wolves', x: 3, y: 40, count: 2 }],
  ];
  const run = () => runMatch({ seed: 17, bots: ['rush', 'boom'], rules: 'fast', maxMinutes: 5, onTick: (g) => { for (const [t, o] of plan) if (g.t === t) dir(g, o); } });
  const a = run(), b = run();
  assert.equal(a.game.godMode, true);
  assert.equal(a.game.commandLog.filter((c) => c.p === 0).length, plan.length);
  assert.equal(a.game.hash(), b.game.hash());
  const g = replay({ seed: 17, players: [{ team: 1 }, { team: 2 }], rules: 'fast' }, a.game.commandLog, a.ticks);
  assert.equal(g.t, a.game.t);
  assert.equal(g.hash(), a.game.hash());
  assert.equal(g.godMode, true);
  assert.deepEqual(g.godFeed, a.game.godFeed);
  assert.deepEqual(g.result(), a.game.result());
});

test('director: a match without interventions is not marked and logs no player-0 command', () => {
  const a = runMatch({ seed: 17, bots: ['rush', 'boom'], rules: 'fast', maxMinutes: 3 });
  assert.equal(a.game.godMode, false);
  assert.equal(a.game.commandLog.filter((c) => c.p === 0).length, 0);
  assert.equal(a.game.result().godMode, false);
});

test('director: agents see wolves as normal visible enemy units and nothing else about God mode', () => {
  const g = fresh(5, 'fast');
  const tcb = tc(g, 1);
  const w = dir(g, { action: 'wolves', x: tcb.tx, y: tcb.ty, count: 2, mirror: false });
  assert.equal(JSON.stringify(observe(g, 1)).includes('god'), false);
  assert.equal(observe(g, 1).enemy_units.some((e) => e.type === 'wolf'), false, 'far away at the edge: not visible yet');
  for (const id of w.ids) { const u = g.units.get(id); u.x = (tcb.tx + 6) * 1000; u.y = (tcb.ty + 6) * 1000; }
  g.updateVision();
  const seen = observe(g, 1).enemy_units.find((e) => e.type === 'wolf');
  assert.ok(seen && seen.owner === 0, 'visible wolves are normal enemy units');
});

test('director: a treasure chest shows up in an observation only while its tile is visible', () => {
  const g = fresh(5, 'fast');
  const w1 = workers(g, 1)[0];
  const r = dir(g, { action: 'treasure', x: Math.floor(w1.x / 1000) + 3, y: Math.floor(w1.y / 1000), res: 'wood', amount: 50 });
  g.updateVision();
  const o1 = observe(g, 1).treasure_chests, o2 = observe(g, 2).treasure_chests;
  assert.equal(o1.length, 1);
  assert.deepEqual(o1[0].reward, { wood: 50 });
  assert.equal(o2, undefined);
  assert.equal(r.ok, true);
});
