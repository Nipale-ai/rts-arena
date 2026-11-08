// Building hit points: a finished building stands at 100 % and has the absolute hit points it had before the change
// (when 100 % was the maxhp and a finished building stood at 90 % of it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { observe, catalog } from '../sim/observe.mjs';
import { mergedFaction, BUILDINGS, TECHS } from '../sim/data.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { stepN, workers } from '../test-support/helpers.mjs';

// The base hit points of every building before the change (the old maxhp), and what the fast preset set instead.
const OLD_CLASSIC = {
  town_center: 1800, house: 400, lumber_camp: 450, mining_camp: 450, mill: 450, farm: 150, barracks: 1100, archery_range: 1000,
  stables: 1100, siege_workshop: 1100, blacksmith: 900, tower: 1000, wall: 700, gate: 450, market: 700, castle: 3000, wonder: 4000,
  outpost: 350, harbor: 900,
};
const OLD_FAST = {
  ...OLD_CLASSIC, tower: 618, barracks: 600, archery_range: 560, stables: 600, siege_workshop: 600, blacksmith: 550, house: 250,
  town_center: 1400, market: 450, castle: 1600, wonder: 3000, outpost: 250,
};
// fast tower: 650 until 31.10.; the tower nerf of 31.10. (hp 585 -> 556) is 618 on the former scale (floor(618 * 0.9) = 556, site 61)
const PRESETS = [['classic', OLD_CLASSIC, undefined], ['fast', OLD_FAST, 'fast']];
const finished = (old) => Math.floor(old * 0.9); // what a finished building had before: 90 % of the old maxhp
const site = (old) => Math.floor(old / 10); // what a placed site had before

test('every building type is covered by the table of former hit points', () => {
  assert.deepEqual(Object.keys(mergedFaction('default').buildings).sort(), Object.keys(OLD_CLASSIC).sort());
  assert.ok(Object.keys(BUILDINGS).every((k) => k in OLD_CLASSIC));
});

test('data: the hit points of a building are the hit points a finished building had before (classic and fast)', () => {
  for (const [name, old, spec] of PRESETS) {
    const fac = mergedFaction('default', resolveRules(spec));
    for (const [type, hp] of Object.entries(old)) assert.equal(fac.buildings[type].hp, finished(hp), `${name} ${type}`);
  }
});

test('a placed site starts at the hit points it had before and its maxhp is the finished value', () => {
  for (const [name, old, spec] of PRESETS) {
    const g = new Game({ seed: 3, rules: spec });
    let i = 0;
    for (const [type, hp] of Object.entries(old)) {
      const b = g.addBuilding(1, type, 4 + (i % 8) * 11, 4 + Math.floor(i / 8) * 11, false);
      i++;
      assert.equal(b.hp, site(hp), `${name} ${type} site hp`);
      assert.equal(b.maxhp, finished(hp), `${name} ${type} maxhp`);
      assert.equal(b.built, false);
    }
  }
});

test('a building finished by workers stands at exactly 100 % = 90 % of the former maxhp', () => {
  for (const [name, old, spec] of PRESETS) {
    const g = new Game({ seed: 1, rules: spec });
    for (const r of ['food', 'wood', 'stone', 'gold']) g.players[1].res[r] = 5000;
    stepN(g, 5);
    const ws = workers(g, 1).map((u) => u.id);
    const ids = {};
    // one or two workers per site, so every site is finished by the workers given to it
    for (const [k, [type, near]] of [['house', [24, 24]], ['mill', [30, 24]], ['barracks', [24, 32]], ['farm', [34, 32]]].entries()) {
      const r = g.command(1, { cmd: 'build', building_type: type, near, worker_ids: ws.slice(k, k + 1) });
      assert.equal(r.ok, true, `${name} ${type}: ${JSON.stringify(r)}`);
      ids[type] = r.building_id;
    }
    for (let i = 0; i < 4000 && Object.values(ids).some((id) => !g.buildings.get(id).built); i++) g.step();
    for (const [type, id] of Object.entries(ids)) {
      const b = g.buildings.get(id);
      assert.equal(b.built, true, `${name} ${type} finished`);
      assert.equal(b.maxhp, finished(old[type]), `${name} ${type} maxhp`);
      assert.equal(b.hp, b.maxhp, `${name} ${type} stands at 100 %`);
      assert.equal(b.hp, finished(old[type]), `${name} ${type} absolute hit points`);
    }
    // the observation of the player shows 100 for the finished barracks (and no build field)
    const e = observe(g, 1).buildings.find((x) => x.id === ids.barracks);
    assert.equal(e.hp, 100);
  }
});

test('buildings that stand at the start keep the hit points they had, still 100 %', () => {
  for (const [name, old, spec] of PRESETS) {
    const g = new Game({ seed: 5, rules: spec });
    const tcs = [...g.buildings.values()].filter((b) => b.type === 'town_center');
    assert.ok(tcs.length >= 2);
    for (const b of tcs) {
      assert.equal(b.hp, old.town_center, `${name} start town center`);
      assert.equal(b.maxhp, old.town_center);
    }
    for (const b of g.buildings.values()) assert.equal(b.hp, b.maxhp);
    if (spec === 'fast') {
      const h = [...g.buildings.values()].find((b) => b.type === 'house');
      assert.equal(h.hp, 250);
    }
    // a start building that is demolished and rebuilt later is a normal one: the second town center has the finished value
    const t = g.addBuilding(1, 'town_center', 40, 40, false);
    assert.equal(t.maxhp, finished(old.town_center));
  }
});

test('masonry (+20 %): the same absolute hit points as before for a building finished afterwards, start buildings keep theirs', () => {
  const g = new Game({ seed: 2, rules: 'fast' });
  const p = g.players[1];
  const startTc = [...g.buildings.values()].find((b) => b.owner === 1 && b.type === 'town_center');
  const mid = g.addBuilding(1, 'barracks', 40, 40, false);
  p.techs.add('masonry');
  g.computeStats(p);
  g.applyTechToEntities(p);
  assert.equal(TECHS.masonry.buildingHpPct, 20);
  assert.equal(startTc.maxhp, Math.floor(1400 * 1.2), 'start town center: 1400 x 1.2 as before');
  assert.equal(startTc.hp, startTc.maxhp);
  assert.equal(mid.maxhp, finished(Math.floor(600 * 1.2)), 'new barracks: 90 % of the former masonry maxhp');
  const after = g.addBuilding(1, 'barracks', 50, 40, false);
  assert.equal(after.hp, site(Math.floor(600 * 1.2)));
});

test('sudden death: the absolute decay per second is the same as before', () => {
  const rules = { preset: 'fast', suddenDeath: 30, timeLimitS: 600 };
  const g = new Game({ seed: 4, rules });
  const mill = g.addBuilding(1, 'mill', 40, 40, false);
  mill.built = true; mill.hp = mill.maxhp;
  const tc = [...g.buildings.values()].find((b) => b.owner === 1 && b.type === 'town_center');
  const t0 = 30 * TICK_HZ;
  while (g.t < t0) g.step();
  const span = (600 - 30) * TICK_HZ;
  let wantMill = 450, wantTc = 1400; // the former maxhp (mill 450, fast town center 1400): the decay was this x 0.008 x ramp
  for (let k = 1; k <= 300; k++) {
    g.step();
    wantMill -= 450 * 0.008 * (k / span) / TICK_HZ;
    wantTc -= 1400 * 0.008 * (k / span) / TICK_HZ;
  }
  assert.equal(mill.maxhp, 405);
  // the mill stands at 405 (not 450): compare the loss, not the level
  assert.ok(Math.abs((405 - mill.hp) - (450 - wantMill)) < 1e-6, `mill loss ${405 - mill.hp} want ${450 - wantMill}`);
  assert.ok(Math.abs((1400 - tc.hp) - (1400 - wantTc)) < 1e-6, `town center loss ${1400 - tc.hp} want ${1400 - wantTc}`);
});

test('sapper: the set of buildings it ignores (hit points below the old 300) is unchanged', () => {
  for (const mult of [100, 120]) { // without and with masonry
    for (const [name, old] of PRESETS) {
      const fac = mergedFaction('default', resolveRules(name === 'fast' ? 'fast' : undefined));
      for (const [type, hp] of Object.entries(old)) {
        const was = Math.floor((hp * mult) / 100) < 300;
        const now = Math.floor((fac.buildings[type].hp * mult) / 100) < 270;
        assert.equal(now, was, `${name} ${type} masonry ${mult === 120}`);
      }
    }
  }
});

test('the catalogue (prompt) prints the hit points a finished building has', () => {
  const cat = catalog('default', resolveRules('fast'));
  assert.equal(cat.buildings.barracks.hp, 540);
  assert.equal(cat.buildings.town_center.hp, 1260);
  assert.equal(catalog('default', resolveRules()).buildings.mill.hp, 405);
});
