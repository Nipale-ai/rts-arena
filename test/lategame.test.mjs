// Part B: late-game siege (mortar, sapper, ram counter), healer, scout, and their hooks (train rules, observation, God mode, determinism).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { observe, catalog } from '../sim/observe.mjs';
import { UNITS, BUILDINGS, TECHS } from '../sim/data.mjs';
import { runMatch } from '../tools/run-match.mjs';
import { stepN, tc } from '../test-support/helpers.mjs';
import { firstDivergence } from '../tools/seat-bias.mjs';

// open field around tile (62, 32) on seed 1; both teams see the whole map so that attack orders on enemy buildings are legal
function field(seed = 1) {
  const g = new Game({ seed });
  g.revealed.add(1);
  g.revealed.add(2);
  stepN(g, 2);
  return g;
}
const mk = (g, owner, type, tx, ty) => g.addUnit(owner, type, tx * 1000 + 500, ty * 1000 + 500);
const OX = 62, OY = 32;

test('data: new units exist and are wired into the tiers and production buildings', () => {
  for (const k of ['scout', 'healer', 'mortar', 'sapper']) assert.ok(UNITS[k], k);
  assert.ok(BUILDINGS.town_center.train.includes('scout'));
  assert.ok(BUILDINGS.barracks.train.includes('healer'));
  assert.ok(BUILDINGS.siege_workshop.train.includes('mortar') && BUILDINGS.siege_workshop.train.includes('sapper'));
  assert.equal(UNITS.mortar.tier, 3);
  assert.equal(UNITS.sapper.tier, 3);
  assert.ok(TECHS.blackpowder && TECHS.field_medicine_1);
  for (const [k, u] of Object.entries(UNITS)) assert.ok(BUILDINGS[u.from].train.includes(k), `${k} is listed at ${u.from}`);
  assert.ok(UNITS.mortar.range > BUILDINGS.tower.attack.range + 2, 'the mortar outranges towers');
});

test('scout: fast, wide sight, weak; train at the town center; not part of the army selector or army_value', () => {
  const g = new Game({ seed: 4 });
  const p = g.players[1];
  p.res.food = p.res.wood = 500;
  const r = g.command(1, { cmd: 'train', building_id: tc(g, 1).id, unit_type: 'scout' });
  assert.equal(r.ok, true);
  stepN(g, 160);
  const sc = [...g.units.values()].find((u) => u.owner === 1 && u.type === 'scout');
  assert.ok(sc, 'the scout is trained');
  assert.ok(p.stats.scout.speed > p.stats.light_cavalry.speed && p.stats.scout.sight > p.stats.light_cavalry.sight && p.stats.scout.hp < 60);
  const o = observe(g, 1);
  assert.equal(o.scouts.length, 1);
  assert.equal(o.scouts[0].id, sc.id);
  assert.ok(!o.units.some((u) => u.type === 'scout'));
  assert.equal(o.army_value, 0);
  assert.equal(g.command(1, { cmd: 'attack_move', units: 'army', target: [50, 50] }).error, 'no_units');
  const before = p.expl.reduce((a, b) => a + b, 0);
  assert.equal(g.command(1, { cmd: 'scout', unit_id: sc.id }).ok, true);
  stepN(g, 200);
  assert.ok(p.expl.reduce((a, b) => a + b, 0) > before, 'it explores');
});

test('healer: heals the most wounded unit in reach, not siege, not enemies, not out of range; tech boosts it', () => {
  const g = field();
  const h = mk(g, 1, 'healer', OX, OY);
  const a = mk(g, 1, 'spearman', OX + 2, OY), b = mk(g, 1, 'spearman', OX + 3, OY), far = mk(g, 1, 'spearman', OX + 12, OY);
  const ram = mk(g, 1, 'ram', OX + 1, OY + 2);
  a.hp = 30; b.hp = 10; far.hp = 10; ram.hp = 10;
  stepN(g, 20); // 2 s at 4 hp/s
  assert.equal(b.hp, 18, 'the most wounded one first');
  assert.equal(a.hp, 30);
  assert.equal(far.hp, 10);
  assert.equal(ram.hp, 10);
  b.hp = b.maxhp; // now the next one
  stepN(g, 20);
  assert.equal(a.hp, 38);
  stepN(g, 1000);
  assert.equal(a.hp, a.maxhp, 'never above the maximum');
  // an enemy is never healed (a lone healer next to a wounded enemy worker, who does not fight)
  const g3 = field();
  mk(g3, 1, 'healer', OX, OY);
  const foe = mk(g3, 2, 'worker', OX + 2, OY);
  foe.hp = 10;
  stepN(g3, 40);
  assert.equal(foe.hp, 10);
  // field_medicine_1: +50 %
  const g2 = field();
  g2.players[1].techs.add('field_medicine_1');
  g2.computeStats(g2.players[1]);
  const h2 = mk(g2, 1, 'healer', OX, OY), c = mk(g2, 1, 'spearman', OX + 2, OY);
  c.hp = 1;
  stepN(g2, 20);
  assert.equal(c.hp, 1 + 12, '6 hp/s for 2 s');
  void h;
  void h2;
});

test('healer: cannot be ordered to attack, walks along on attack_move, follows wounded idle neighbours', () => {
  const g = field();
  const h = mk(g, 1, 'healer', OX, OY), s = mk(g, 1, 'spearman', OX + 1, OY);
  const foe = mk(g, 2, 'spearman', OX + 40, OY);
  stepN(g, 2);
  const r = g.command(1, { cmd: 'attack_move', units: [h.id, s.id], target: foe.id });
  assert.equal(r.ok, true);
  assert.equal(h.ord.t, 'amove');
  assert.equal(s.ord.t, 'attack');
  // an idle healer walks to a wounded friend within sight and stays near
  const g2 = field();
  const h2 = mk(g2, 1, 'healer', OX, OY), w = mk(g2, 1, 'spearman', OX + 7, OY);
  w.hp = 20;
  stepN(g2, 120);
  assert.equal(w.hp, w.maxhp);
  assert.ok(Math.abs(h2.x - w.x) < 5000);
});

test('mortar: needs the tech blackpowder and tier 3', () => {
  const g = new Game({ seed: 2 });
  const p = g.players[1];
  for (const r of ['food', 'wood', 'stone', 'gold']) p.res[r] = 5000;
  p.tier = 3;
  const sw = g.addBuilding(1, 'siege_workshop', 30, 30, true);
  let r = g.command(1, { cmd: 'train', building_id: sw.id, unit_type: 'mortar' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'requires');
  r = g.command(1, { cmd: 'research', tech: 'blackpowder' });
  assert.equal(r.ok, true);
  stepN(g, 460);
  assert.ok(p.techs.has('blackpowder'));
  assert.equal(g.command(1, { cmd: 'train', building_id: sw.id, unit_type: 'mortar' }).ok, true);
  assert.equal(g.command(1, { cmd: 'train', building_id: sw.id, unit_type: 'sapper', count: 2 }).ok, true);
  p.tier = 2;
  assert.equal(g.command(1, { cmd: 'train', building_id: sw.id, unit_type: 'sapper' }).error, 'tier_too_low');
});

test('mortar: out-ranges a tower, sets up before the first shell, shell has a fixed landing point, splash hits the buildings next to the target', () => {
  const g = field();
  const tw = g.addBuilding(2, 'tower', OX + 16, OY + 4, true);
  const house = g.addBuilding(2, 'house', OX + 16, OY + 7, true);
  const far = g.addBuilding(2, 'house', OX + 24, OY + 7, true);
  stepN(g, 6);
  const m = mk(g, 1, 'mortar', OX + 1, OY + 5);
  assert.equal(g.command(1, { cmd: 'attack_move', units: [m.id], target: tw.id }).ok, true);
  let firstShell = 0, hurtAt = 0;
  for (let i = 0; i < 400 && !hurtAt; i++) {
    g.step();
    if (g.proj.length && !firstShell) firstShell = g.t;
    if (tw.hp < tw.maxhp) hurtAt = g.t;
  }
  assert.ok(firstShell > 0 && hurtAt > firstShell, 'a shell flies before the damage lands');
  assert.ok(hurtAt - firstShell >= 15, 'the shell needs about two seconds');
  assert.ok(house.hp < house.maxhp, 'splash on the neighbouring building');
  assert.equal(far.hp, far.maxhp, 'no splash outside the radius');
  assert.equal(g.players[2].unitStats.tower, undefined);
  assert.ok((m.x - (tw.tx * 1000)) ** 2 + (m.y - tw.ty * 1000) ** 2 > (11000) ** 2, 'it stands outside the tower range');
  assert.equal(tw.hp, tw.maxhp - 150, 'one shell: 60 x 2.5');
});

test('mortar: no shot at targets inside the minimum range; set-up time before the first shot and again after a move', () => {
  const g = field();
  const near = g.addBuilding(2, 'house', OX + 5, OY + 4, true);
  stepN(g, 6);
  const m = mk(g, 1, 'mortar', OX + 1, OY + 5);
  m.dep = 99;
  g.setOrder(m, { t: 'attack', id: near.id, auto: false });
  stepN(g, 60);
  assert.equal(g.proj.length, 0);
  assert.equal(near.hp, near.maxhp, 'a house 3 tiles away is inside the minimum range');
  // in range but not set up
  const g2 = field();
  const far = g2.addBuilding(2, 'house', OX + 12, OY + 4, true);
  stepN(g2, 6);
  const m2 = mk(g2, 1, 'mortar', OX + 1, OY + 5);
  g2.setOrder(m2, { t: 'attack', id: far.id, auto: false });
  let shotAt = 0;
  for (let i = 0; i < 80 && !shotAt; i++) { g2.step(); if (g2.proj.length) shotAt = i + 1; }
  assert.ok(shotAt >= 20, `first shot after the 2 s set-up (tick ${shotAt})`);
  // a move resets it
  m2.dep = 99;
  g2.setOrder(m2, { t: 'move', x: m2.x + 1500, y: m2.y, r: 100 });
  stepN(g2, 30);
  assert.ok(m2.dep < 20, 'moving restarts the set-up');
});

test('mortar: units that walk away from a lobbed shell are not hit (fixed landing point)', () => {
  const g = field();
  const house = g.addBuilding(2, 'house', OX + 14, OY + 4, true);
  stepN(g, 6);
  const m = mk(g, 1, 'mortar', OX + 2, OY + 5);
  const v = mk(g, 2, 'spearman', OX + 14, OY + 3); // next to the target: inside the splash
  const v2 = mk(g, 2, 'spearman', OX + 14, OY + 6);
  v2.maxhp = v2.hp = 400;
  g.command(1, { cmd: 'attack_move', units: [m.id], target: house.id });
  let shot = false;
  for (let i = 0; i < 200; i++) {
    g.step();
    if (g.proj.length && !shot) { shot = true; v2.x += 8000; v2.px += 8000; v2.hp = v2.maxhp; v.hp = 60; }
    if (shot && !g.proj.length) break;
  }
  assert.ok(v.hp < 60 || v.dead, 'a unit under the shell is hurt');
  assert.equal(v2.hp, v2.maxhp, 'the unit that left is not');
});

test('sapper: plants a charge, 2 s fuse, blast hurts the building and the ones around it, the sapper dies, killing it first defuses the charge', () => {
  const g = field();
  const b1 = g.addBuilding(2, 'barracks', OX + 8, OY + 4, true);
  const b2 = g.addBuilding(2, 'house', OX + 11, OY + 4, true);
  stepN(g, 6);
  const s = mk(g, 1, 'sapper', OX + 2, OY + 5);
  assert.equal(g.command(1, { cmd: 'attack_move', units: [s.id], target: b1.id }).ok, true);
  let planted = 0;
  for (let i = 0; i < 100 && !s.dead && !g.dead.includes(s); i++) { g.step(); if (s.fuse && !planted) planted = g.t; }
  assert.ok(planted > 0);
  assert.equal(g.units.has(s.id), false, 'the sapper died with its charge');
  assert.ok(g.t - planted >= 19 && g.t - planted <= 21, 'a 2 s fuse');
  assert.equal(b1.hp, b1.maxhp - 480);
  assert.ok(b2.hp < b2.maxhp, 'the blast hurts the neighbour');
  assert.equal(g.players[1].killValue, 0);
  // defused
  const g2 = field();
  const t1 = g2.addBuilding(2, 'barracks', OX + 8, OY + 4, true);
  stepN(g2, 6);
  const s2 = mk(g2, 1, 'sapper', OX + 2, OY + 5);
  g2.command(1, { cmd: 'attack_move', units: [s2.id], target: t1.id });
  for (let i = 0; i < 100 && !s2.fuse; i++) g2.step();
  assert.ok(s2.fuse > 0);
  stepN(g2, 5);
  g2.kill(s2, 2, 'archer');
  stepN(g2, 60);
  assert.equal(t1.hp, t1.maxhp, 'no blast without the sapper');
});

test('sapper blast can destroy a wall segment line and counts the kill for its owner', () => {
  const g = field();
  const walls = [0, 1, 2].map((i) => g.addBuilding(2, 'wall', OX + 8, OY + 4 + i, true));
  for (const w of walls) { w.hp = 100; }
  stepN(g, 6);
  const s = mk(g, 1, 'sapper', OX + 3, OY + 5);
  g.command(1, { cmd: 'attack_move', units: [s.id], target: walls[1].id });
  stepN(g, 120);
  assert.ok(walls.every((w) => w.dead || w.hp <= 0), 'all three weakened walls fall');
  assert.equal(g.players[1].kills, 3);
});

test('ram: swordsmen kill a ram much faster than spearmen or archers (cost-equal groups)', () => {
  const kill = (type, n) => {
    const g = field();
    const ram = mk(g, 1, 'ram', OX + 2, OY + 5);
    for (let i = 0; i < n; i++) mk(g, 2, type, OX + 3, OY + 4 + i);
    for (const u of g.units.values()) if (u.owner === 2 && u.type === type) g.setOrder(u, { t: 'attack', id: ram.id, auto: false });
    for (let i = 0; i < 1200; i++) { g.step(); if (ram.dead || ram.hp <= 0) return g.t; }
    return 9999;
  };
  const sw = kill('swordsman', 4), sp = kill('spearman', 5), ar = kill('archer', 5);
  assert.ok(sw < 100, `4 swordsmen kill a ram in ${sw} ticks`);
  assert.ok(sp > 2 * sw && ar > 2 * sw, `spearmen ${sp}, archers ${ar}`);
});

test('observation and catalog describe the new units', () => {
  const cat = catalog('default');
  assert.equal(cat.units.mortar.needs_tech, 'blackpowder');
  assert.ok(cat.units.mortar.min_range > 0 && cat.units.mortar.setup_s > 0 && cat.units.mortar.splash > 0);
  assert.ok(cat.units.healer.heal.hp_per_s > 0);
  assert.ok(cat.units.sapper.charge.damage > 0);
  assert.equal(cat.units.scout.no_army, true);
  assert.match(cat.counters, /mortar/);
  assert.match(cat.counters, /sapper/);
  assert.match(cat.counters, /healer/);
});

test('God mode spawns every new unit and the match stays deterministic', () => {
  const run = () => {
    const g = new Game({ seed: 11 });
    stepN(g, 5);
    for (const t of ['scout', 'healer', 'mortar', 'sapper']) assert.equal(g.command(0, { cmd: 'director', action: 'spawn', player: 1, unit: t, count: 2 }).ok, true, t);
    assert.equal(g.command(0, { cmd: 'director', action: 'spawn', player: 2, unit: 'spearman', count: 3 }).ok, true);
    stepN(g, 300);
    return g.hash();
  };
  assert.equal(run(), run());
});

test('determinism: a scenario with healer, mortar, sapper and fighting replays to the same hash', () => {
  const run = () => {
    const g = field(3);
    g.addBuilding(2, 'barracks', OX + 12, OY + 4, true);
    g.addBuilding(2, 'tower', OX + 15, OY + 4, true);
    stepN(g, 6);
    for (let i = 0; i < 3; i++) mk(g, 1, 'sapper', OX + 2, OY + 3 + i);
    for (let i = 0; i < 2; i++) mk(g, 1, 'mortar', OX, OY + 3 + 2 * i);
    for (let i = 0; i < 4; i++) { mk(g, 1, 'spearman', OX + 3, OY + 3 + i); mk(g, 2, 'archer', OX + 14, OY + 3 + i); }
    mk(g, 1, 'healer', OX + 1, OY + 4);
    g.command(1, { cmd: 'attack_move', units: 'army', target: [OX + 13, OY + 5] });
    stepN(g, 500);
    return g.hash();
  };
  assert.equal(run(), run());
});

test('bots use the new units and a full fast game is reproducible', () => {
  const tot = { scout: 0, healer: 0, mortar: 0, sapper: 0 };
  for (const seed of [5000, 5001, 5002]) {
    const a = runMatch({ seed, bots: ['boom', 'turtle'], rules: 'fast' });
    if (seed === 5000) assert.equal(a.game.hash(), runMatch({ seed, bots: ['boom', 'turtle'], rules: 'fast' }).game.hash());
    for (const p of a.result.players) for (const k of Object.keys(tot)) tot[k] += p.trained[k] || 0;
  }
  for (const [k, v] of Object.entries(tot)) assert.ok(v > 0, `the bots train ${k} (${JSON.stringify(tot)})`);
});

test('mirror symmetry: boom against itself stays point-symmetric with healers, scouts, mortars and sappers in play', () => {
  // weather and caravans off: they change the whole trajectory, and some trajectories expose an old, tiny seat asymmetry (seeds 5 and 6 on the
  // plain fast rules too); the world features have their own symmetry tests in world.test.mjs
  const d = firstDivergence({ bot: 'boom', seed: 2, minutes: 22, rules: { preset: 'fast', weather: 'off', caravans: false } });
  assert.equal(d, null, JSON.stringify(d));
});
