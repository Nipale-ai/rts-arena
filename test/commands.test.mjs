import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { TOOLS } from '../sim/commands.mjs';
import { richGame, stepN, tc, workers } from '../test-support/helpers.mjs';

const err = (r, code) => {
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error, code, JSON.stringify(r));
  assert.ok(r.message && r.message.length > 5, 'clear message');
};

// finish construction instantly to test follow-up commands
function finish(g, b) {
  b.built = true;
  b.hp = b.maxhp;
  g.recalcPop(g.players[b.owner]);
}

test('every tool has a schema and a command implementation', () => {
  const g = richGame();
  for (const t of TOOLS) {
    assert.equal(typeof g['cmd_' + t.name], 'function', t.name);
    assert.equal(t.parameters.type, 'object');
  }
});

test('unknown command, bad args, other player, game over', () => {
  const g = richGame();
  err(g.command(1, { cmd: 'dance' }), 'unknown_command');
  err(g.command(1, null), 'bad_args');
  err(g.command(1, { cmd: 'train' }), 'not_found');
  err(g.command(9, { cmd: 'note', text: 'x' }), 'bad_player');
});

test('train: validation and success', () => {
  const g = richGame();
  const t = tc(g, 1);
  err(g.command(1, { cmd: 'train', building_id: 99999, unit_type: 'worker' }), 'not_found');
  err(g.command(2, { cmd: 'train', building_id: t.id, unit_type: 'worker' }), 'not_owner');
  err(g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'dragon' }), 'unknown_unit');
  err(g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'archer' }), 'cannot_train_here');
  err(g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'worker', count: 0 }), 'bad_args');
  const ok = g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'worker', count: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.queued, 3);
  assert.equal(g.players[1].res.food, 5000 - 150);
  // population cap 15, 5 workers + 3 queued: 7 more fit then pop_cap
  const more = g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'worker', count: 10 });
  assert.equal(more.ok, true);
  assert.ok(more.queued <= 7 && more.note);
  err(g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'worker' }), g.players[1].pop >= 15 ? 'pop_cap' : 'queue_full');
  const poor = new Game({ seed: 1 });
  poor.players[1].res.food = 10;
  err(poor.command(1, { cmd: 'train', building_id: tc(poor, 1).id, unit_type: 'worker' }), 'insufficient_resources');
});

test('train: tier and unfinished buildings', () => {
  const g = richGame();
  const w = workers(g, 1);
  const b = g.command(1, { cmd: 'build', building_type: 'barracks', near: [24, 24], worker_ids: 'auto' });
  assert.equal(b.ok, true, JSON.stringify(b));
  err(g.command(1, { cmd: 'train', building_id: b.building_id, unit_type: 'spearman' }), 'not_built');
  finish(g, g.buildings.get(b.building_id));
  assert.equal(g.command(1, { cmd: 'train', building_id: b.building_id, unit_type: 'spearman' }).ok, true);
  g.players[1].cap = 100;
  err(g.command(1, { cmd: 'train', building_id: b.building_id, unit_type: 'swordsman' }), 'tier_too_low');
  void w;
});

test('build: validation, auto workers, sites and costs', () => {
  const g = richGame();
  err(g.command(1, { cmd: 'build', building_type: 'dragon_lair', near: [24, 24] }), 'unknown_building');
  err(g.command(1, { cmd: 'build', building_type: 'stables', near: [24, 24] }), 'tier_too_low');
  err(g.command(1, { cmd: 'build', building_type: 'house', near: 'here' }), 'bad_args');
  err(g.command(1, { cmd: 'build', building_type: 'house', near: [24, 24], worker_ids: [99999] }), 'no_workers');
  err(g.command(1, { cmd: 'build', building_type: 'house', near: [120, 5] }), 'no_site');
  const before = g.players[1].res.wood;
  const r = g.command(1, { cmd: 'build', building_type: 'house', near: [24, 24] });
  assert.equal(r.ok, true);
  assert.equal(g.players[1].res.wood, before - 40);
  assert.ok(g.buildings.get(r.building_id));
  const poor = new Game({ seed: 1 });
  poor.players[1].res.wood = 5;
  stepN(poor, 3);
  err(poor.command(1, { cmd: 'build', building_type: 'house', near: [24, 24] }), 'insufficient_resources');
  // explicit worker ids and a finished building by the workers
  const ws = workers(g, 1).map((u) => u.id);
  const r2 = g.command(1, { cmd: 'build', building_type: 'house', near: [14, 24], worker_ids: ws.slice(0, 2) });
  assert.equal(r2.ok, true);
  for (let i = 0; i < 400; i++) g.step();
  assert.equal(g.buildings.get(r2.building_id).built, true);
});

test('gather: resources, counts, errors', () => {
  const g = richGame();
  err(g.command(1, { cmd: 'gather', resource: 'mana', count: 1 }), 'bad_args');
  err(g.command(1, { cmd: 'gather', resource: 'wood' }), 'bad_args');
  err(g.command(1, { cmd: 'gather', resource: 'wood', worker_ids: [99999] }), 'no_workers');
  const r = g.command(1, { cmd: 'gather', resource: 'gold', count: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.assigned, 2);
  const onGold = workers(g, 1).filter((u) => u.ord.t === 'gather' && u.ord.res === 'gold');
  assert.equal(onGold.length, 2);
  const r2 = g.command(1, { cmd: 'gather', resource: 'stone', count: 1, from: 'gold' });
  assert.equal(r2.ok, true);
  assert.equal(workers(g, 1).filter((u) => u.ord.res === 'gold').length, 1);
  // gold deposits after some time
  const g0 = g.players[1].gathered.gold;
  stepN(g, 1500);
  assert.ok(g.players[1].gathered.gold > g0);
});

test('move, attack_move, scout and group with selectors', () => {
  const g = richGame();
  const t = tc(g, 1);
  const ids = workers(g, 1).map((u) => u.id);
  err(g.command(1, { cmd: 'move', units: [99999], to: [30, 30] }), 'no_units');
  err(g.command(1, { cmd: 'move', units: ids, to: 'x' }), 'bad_args');
  err(g.command(1, { cmd: 'move', units: 'type:ghost', to: [30, 30] }), 'no_units');
  assert.equal(g.command(1, { cmd: 'move', units: ids.slice(0, 2), to: [30, 30] }).ok, true);
  assert.equal(g.command(1, { cmd: 'move', units: `${ids[0]}-${ids[1]}`, to: [31, 30] }).ok, true);
  const gr = g.command(1, { cmd: 'group', name: 'scouts', units: ids.slice(0, 2) });
  assert.equal(gr.ok, true);
  err(g.command(1, { cmd: 'group', name: 'bad name!', units: ids }), 'bad_args');
  err(g.command(1, { cmd: 'group', name: 'army', units: ids }), 'bad_args');
  assert.equal(g.command(1, { cmd: 'attack_move', units: 'scouts', target: [40, 40] }).ok, true);
  // enemy entities are only valid targets when seen
  const enemyTc = tc(g, 2);
  err(g.command(1, { cmd: 'attack_move', units: ids, target: enemyTc.id }), 'target_not_visible');
  err(g.command(1, { cmd: 'attack_move', units: ids, target: 424242 }), 'bad_target');
  const exploredBefore = g.players[1].expl.reduce((a, b) => a + b, 0);
  const s = g.command(1, { cmd: 'scout', unit_id: ids[2] });
  assert.equal(s.ok, true);
  err(g.command(1, { cmd: 'scout', unit_id: 99999 }), 'not_found');
  err(g.command(1, { cmd: 'scout', unit_id: ids[2], xy: 'north' }), 'bad_args');
  stepN(g, 400);
  assert.ok(g.players[1].expl.reduce((a, b) => a + b, 0) > exploredBefore);
  void t;
});

test('research and advance_tier', () => {
  const g = richGame();
  err(g.command(1, { cmd: 'research', tech: 'magic' }), 'unknown_tech');
  err(g.command(1, { cmd: 'research', tech: 'melee_attack_1' }), 'tier_too_low');
  err(g.command(1, { cmd: 'research', tech: 'wood_axe_2' }), 'tier_too_low');
  err(g.command(1, { cmd: 'research', tech: 'wood_axe' }), 'no_building');
  const lc = g.command(1, { cmd: 'build', building_type: 'lumber_camp', near: [24, 24] });
  finish(g, g.buildings.get(lc.building_id));
  const r = g.command(1, { cmd: 'research', tech: 'wood_axe' });
  assert.equal(r.ok, true, JSON.stringify(r));
  err(g.command(1, { cmd: 'research', tech: 'wood_axe' }), 'busy');
  stepN(g, 260);
  assert.ok(g.players[1].techs.has('wood_axe'));
  err(g.command(1, { cmd: 'research', tech: 'wood_axe' }), 'already_done');
  const a = g.command(1, { cmd: 'advance_tier' });
  assert.equal(a.ok, true);
  err(g.command(1, { cmd: 'advance_tier' }), 'busy');
  stepN(g, 460);
  assert.equal(g.players[1].tier, 2);
  assert.equal(g.command(1, { cmd: 'advance_tier' }).ok, true);
  stepN(g, 710);
  assert.equal(g.players[1].tier, 3);
  err(g.command(1, { cmd: 'advance_tier' }), 'already_done');
  assert.equal(g.command(1, { cmd: 'research', tech: 'wood_axe_2' }).ok, true);
  err(g.command(1, { cmd: 'research', tech: 'melee_attack_2' }), 'requires');
  const poor = new Game({ seed: 1 });
  err(poor.command(1, { cmd: 'advance_tier' }), 'insufficient_resources');
});

test('set_rally: on a resource makes new workers gather; xy null clears', () => {
  const g = richGame();
  const t = tc(g, 1);
  err(g.command(1, { cmd: 'set_rally', building_id: 99999, xy: [1, 1] }), 'not_found');
  err(g.command(1, { cmd: 'set_rally', building_id: t.id, xy: 'x' }), 'bad_args');
  const gold = [...g.nodes.values()].find((n) => n.res === 'gold');
  const r = g.command(1, { cmd: 'set_rally', building_id: t.id, xy: [gold.tx, gold.ty] });
  assert.equal(r.ok, true);
  assert.equal(r.gather, 'gold');
  g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'worker', count: 1 });
  stepN(g, 140);
  const nw = workers(g, 1).sort((a, b) => b.id - a.id)[0];
  assert.equal(nw.ord.t, 'gather');
  assert.equal(nw.ord.res, 'gold');
  assert.equal(g.command(1, { cmd: 'set_rally', building_id: t.id, xy: null }).ok, true);
});

test('note and resign', () => {
  const g = richGame();
  assert.equal(g.command(1, { cmd: 'note', text: 'x'.repeat(300) }).ok, true);
  assert.equal(g.players[1].note.length, 120);
  assert.equal(g.command(1, { cmd: 'resign' }).ok, true);
  assert.equal(g.over, true);
  assert.equal(g.winnerTeam, 2);
  err(g.command(1, { cmd: 'note', text: 'late' }), 'game_over');
});

test('combat: spearmen beat cavalry, armour and projectiles work', () => {
  const g = richGame();
  const mk = (owner, type, x, y) => g.addUnit(owner, type, x * 1000 + 500, y * 1000 + 500);
  const fight = (typeA, nA, typeB, nB) => {
    const gg = new Game({ seed: 2 });
    for (const u of [...gg.units.values()]) {
      u.dead = true;
      gg.units.delete(u.id);
    }
    const A = [], B = [];
    for (let i = 0; i < nA; i++) A.push(gg.addUnit(1, typeA, 60500 + i * 300, 60500));
    for (let i = 0; i < nB; i++) B.push(gg.addUnit(2, typeB, 66500 + i * 300, 60500));
    for (const u of A) gg.setOrder(u, { t: 'amove', x: 66500, y: 60500, r: 800 });
    for (const u of B) gg.setOrder(u, { t: 'amove', x: 60500, y: 60500, r: 800 });
    for (let i = 0; i < 900; i++) gg.step();
    return [A.filter((u) => !u.dead).length, B.filter((u) => !u.dead).length];
  };
  void mk;
  const [s, c] = fight('spearman', 6, 'light_cavalry', 6);
  assert.ok(s > c, `spearmen ${s} vs cavalry ${c}`);
  const [sk, ar] = fight('skirmisher', 8, 'archer', 8);
  assert.ok(sk > ar, `skirmishers ${sk} vs archers ${ar}`);
});
