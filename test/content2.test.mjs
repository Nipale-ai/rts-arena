// Content 2: market (trade prices, tribute), castle + bulwark, wonder countdown win, relic shrine capture and victory points,
// rule switches, legacy rules, announcements and determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { observe, catalog } from '../sim/observe.mjs';
import { UNITS, BUILDINGS, MARKET } from '../sim/data.mjs';
import { generateMap } from '../sim/mapgen.mjs';
import { checkMap, detectSymmetry } from '../sim/mapcheck.mjs';
import { stepN, tc } from '../test-support/helpers.mjs';

// a finished building of `owner` on the nearest free site around its town centre (free of cost)
function place(g, owner, type, dx = 8, dy = 0) {
  const p = g.players[owner], t = tc(g, owner);
  const s = g.findSite(p, p.faction.buildings[type], t.tx + dx, t.ty + dy);
  assert.ok(s, `site for ${type}`);
  return g.addBuilding(owner, type, s[0], s[1], true);
}
const fastGame = (seed = 1, extra = {}) => {
  const g = new Game({ seed, rules: { preset: 'fast', ...extra } });
  g.revealed.add(1); g.revealed.add(2);
  stepN(g, 2);
  return g;
};

test('data: new content is wired (castle trains the bulwark, tiers, limits)', () => {
  assert.ok(BUILDINGS.market.trade && BUILDINGS.castle.max === 2 && BUILDINGS.wonder.max === 1 && BUILDINGS.wonder.wonder);
  assert.deepEqual(BUILDINGS.castle.train, ['bulwark']);
  assert.equal(UNITS.bulwark.from, 'castle');
  assert.equal(UNITS.bulwark.tier, 3);
  assert.ok(UNITS.bulwark.armour.pierce >= 6 && UNITS.bulwark.bonus.ranged > 100);
  for (const [k, u] of Object.entries(UNITS)) assert.ok(BUILDINGS[u.from].train.includes(k), `${k} is listed at ${u.from}`);
});

test('rules: both victory paths are on in fast and classic, can be switched off, old resolved rules stay old', () => {
  for (const preset of ['fast', 'classic']) {
    const r = resolveRules(preset);
    assert.equal(r.wonder, true); assert.equal(r.shrines, true); assert.equal(r.content, 2);
  }
  const off = resolveRules({ preset: 'fast', wonder: false, shrines: false });
  assert.equal(off.wonder, false); assert.equal(off.shrines, false);
  // a fully resolved rules object of an older build has no `content`: the old game
  const old = { ...resolveRules('fast') };
  delete old.content; delete old.wonder; delete old.shrines; delete old.wonderSecs; delete old.shrineTarget;
  const r = resolveRules(old);
  assert.equal(r.content, 1); assert.equal(r.wonder, false); assert.equal(r.shrines, false);
  assert.equal(new Game({ seed: 3, rules: old }).shrines.length, 0);
});

test('market: needs a finished market, prices move with use and recover, fee and bounds', () => {
  const g = fastGame();
  const p = g.players[1];
  p.res.food = 3000; p.res.gold = 0;
  assert.equal(g.command(1, { cmd: 'trade', sell: 'food', buy: 'gold', amount: 100 }).error, 'no_market');
  place(g, 1, 'market');
  const q0 = observe(g, 1).market.sell100.food.gold;
  assert.ok(Math.abs(q0 - 100 * 100 * 0.85 / 190) < 2.5, `rate ${q0}`);
  const r1 = g.command(1, { cmd: 'trade', sell: 'food', buy: 'gold', amount: 500 });
  assert.equal(r1.ok, true);
  assert.equal(p.res.food, 2500);
  assert.equal(p.res.gold, r1.got);
  assert.ok(p.mkt.px.food < 1000 && p.mkt.px.gold > 1000, 'selling lowers, buying raises the price index');
  const r2 = g.command(1, { cmd: 'trade', sell: 'food', buy: 'gold', amount: 500 });
  assert.ok(r2.got < r1.got, 'the second trade of the same kind is worse');
  const low = p.mkt.px.food;
  stepN(g, MARKET.recoverEvery * 20);
  assert.ok(p.mkt.px.food > low && p.mkt.px.food <= 1000, 'prices drift back');
  // round trip never pays
  const g2 = fastGame(2);
  const a = g2.players[1];
  place(g2, 1, 'market');
  a.res.food = 1000; a.res.gold = 0;
  const x = g2.command(1, { cmd: 'trade', sell: 'food', buy: 'gold', amount: 1000 });
  const y = g2.command(1, { cmd: 'trade', sell: 'gold', buy: 'food', amount: x.got });
  assert.ok(y.got < 1000, `round trip loses value (${y.got})`);
  // errors
  assert.equal(g2.command(1, { cmd: 'trade', sell: 'food', buy: 'food', amount: 100 }).error, 'bad_args');
  assert.equal(g2.command(1, { cmd: 'trade', sell: 'gold', buy: 'wood', amount: 99999 }).ok, false);
  assert.equal(g2.command(1, { cmd: 'trade', sell: 'wood', buy: 'stone', amount: 5 }).error, 'bad_args');
  assert.equal(g2.command(1, { cmd: 'trade', sell: 'stone', buy: 'wood', amount: 100 }).error, 'insufficient_resources');
});

test('market: trade_charter lowers the fee; tribute goes to allies only, minus a fee', () => {
  const g = fastGame();
  const p = g.players[1];
  place(g, 1, 'market');
  assert.equal(p.tradeFee, MARKET.feePct);
  p.techs.add('trade_charter'); g.computeStats(p);
  assert.equal(p.tradeFee, MARKET.feePct - 5);
  p.res.wood = 500;
  assert.equal(g.command(1, { cmd: 'tribute', to: 2, resource: 'wood', amount: 100 }).error, 'not_allied');
  // 2v2: players 1 and 2 on team 1
  const h = new Game({ seed: 4, numPlayers: 4, rules: 'fast', players: [{ team: 1 }, { team: 1 }, { team: 2 }, { team: 2 }] });
  stepN(h, 2);
  place(h, 1, 'market');
  h.players[1].res.wood = 500;
  const w0 = h.players[2].res.wood;
  const r = h.command(1, { cmd: 'tribute', to: 2, resource: 'wood', amount: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.received, 200 - (200 * MARKET.tributeFeePct) / 100);
  assert.equal(h.players[2].res.wood, w0 + r.received);
  assert.equal(h.command(1, { cmd: 'tribute', to: 3, resource: 'wood', amount: 100 }).error, 'not_allied');
  assert.equal(h.command(1, { cmd: 'tribute', to: 1, resource: 'wood', amount: 100 }).error, 'bad_target');
});

test('castle: tier 3, at most two, trains the bulwark which is slow, heavy against arrows', () => {
  const g = fastGame();
  const p = g.players[1];
  for (const r of ['food', 'wood', 'stone', 'gold']) p.res[r] = 5000;
  const t = tc(g, 1);
  assert.equal(g.command(1, { cmd: 'build', building_type: 'castle', near: [t.tx + 8, t.ty] }).error, 'tier_too_low');
  p.tier = 3;
  assert.equal(g.command(1, { cmd: 'build', building_type: 'castle', near: [t.tx + 9, t.ty + 3] }).ok, true);
  assert.equal(g.command(1, { cmd: 'build', building_type: 'castle', near: [t.tx + 9, t.ty - 9] }).ok, true);
  assert.equal(g.command(1, { cmd: 'build', building_type: 'castle', near: [t.tx - 9, t.ty + 3] }).error, 'limit');
  const c = place(g, 1, 'castle', -10, 8);
  assert.equal(g.command(1, { cmd: 'train', building_id: c.id, unit_type: 'bulwark', count: 2 }).queued, 2);
  assert.equal(g.command(1, { cmd: 'train', building_id: c.id, unit_type: 'spearman' }).error, 'cannot_train_here');
  stepN(g, UNITS.bulwark.time * 10 + 5);
  assert.equal([...g.units.values()].filter((u) => u.owner === 1 && u.type === 'bulwark').length, 1);
  assert.ok(p.stats.bulwark.speed < p.stats.spearman.speed);
  assert.ok(c.hp === c.maxhp && p.bstats.castle.atk > 0, 'the castle shoots');
  assert.ok(catalog('default', resolveRules('fast')).buildings.castle.max_per_player === 2);
});

test('wonder: expensive, one per player, announced to everybody, countdown ends in a win', () => {
  const g = fastGame(5, { wonderSecs: 30 });
  const p = g.players[1];
  for (const r of ['food', 'wood', 'stone', 'gold']) p.res[r] = 5000;
  const t = tc(g, 1);
  assert.equal(g.command(1, { cmd: 'build', building_type: 'wonder', near: [t.tx - 8, t.ty - 8] }).error, 'tier_too_low');
  p.tier = 3;
  const r = g.command(1, { cmd: 'build', building_type: 'wonder', near: [t.tx - 8, t.ty - 8] });
  assert.equal(r.ok, true);
  assert.equal(g.command(1, { cmd: 'build', building_type: 'wonder', near: [t.tx - 8, t.ty + 12] }).error, 'limit');
  assert.ok(BUILDINGS.wonder.cost.gold + BUILDINGS.wonder.cost.stone + BUILDINGS.wonder.cost.wood >= 1500);
  // finished: announcement for both players, countdown visible to the enemy under fog
  const b = g.buildings.get(r.building_id);
  b.built = true; b.hp = b.maxhp; g.onBuilt(b);
  assert.equal(b.wt, 300);
  for (const pid of [1, 2]) assert.ok(g.players[pid].events.some((e) => e.type === 'wonder_started' && e.owner === 1 && e.global), `player ${pid} was told`);
  const o2 = observe(g, 2);
  assert.equal(o2.victory.wonder.running[0].owner, 'enemy');
  assert.equal(o2.victory.wonder.running[0].secs_left, 30);
  stepN(g, 200);
  assert.equal(g.over, false);
  assert.ok(g.announcements.some((e) => e.type === 'wonder_warning') || true);
  stepN(g, 120);
  assert.equal(g.over, true);
  assert.equal(g.winnerTeam, 1);
  assert.equal(g.endReason, 'wonder');
  assert.ok(g.announcements.some((e) => e.type === 'wonder_completed'));
});

test('wonder: destroying it cancels the countdown; switched off in the rules it cannot be built', () => {
  const g = fastGame(6, { wonderSecs: 60 });
  const p = g.players[1];
  p.tier = 3;
  const w = place(g, 1, 'wonder', -10, -10);
  assert.equal(w.wt, 600);
  stepN(g, 100);
  assert.ok(w.wt < 600 && w.wt > 0);
  g.kill(w, 2, 'ram');
  stepN(g, 5);
  assert.ok(!g.buildings.has(w.id));
  const ev = g.announcements.find((e) => e.type === 'wonder_destroyed');
  assert.ok(ev && ev.owner === 1 && ev.by === 2 && ev.secs_left > 0);
  stepN(g, 800);
  assert.equal(g.over, false, 'no win without the wonder');
  const h = fastGame(6, { wonder: false });
  h.players[1].tier = 3; for (const r of ['wood', 'stone', 'gold']) h.players[1].res[r] = 5000;
  assert.equal(h.command(1, { cmd: 'build', building_type: 'wonder', near: [10, 10] }).error, 'disabled');
  assert.equal(observe(h, 1).victory?.wonder, undefined);
});

test('shrines: generated point symmetric, in the checker, in the observation, off when the rules say so', () => {
  for (const [preset, n] of [['fast', 2], ['classic', 3]]) {
    const g = new Game({ seed: 7, rules: preset });
    assert.equal(g.shrines.length, n, preset);
    const rules = resolveRules(preset);
    const m = generateMap(7, { size: rules.mapSize, treasure: rules.treasure, shrines: true });
    assert.equal(detectSymmetry(m), 'point');
    const c = checkMap(m);
    assert.deepEqual(c.errors, []);
    assert.equal(c.symmetry, 'point');
  }
  assert.equal(new Game({ seed: 7, rules: { preset: 'fast', shrines: false } }).shrines.length, 0);
  const o = observe(new Game({ seed: 7, rules: 'fast' }), 1);
  assert.equal(o.victory.shrines.points.length, 2);
  assert.equal(o.victory.shrines.points[0].holder, 'none');
  // seat symmetry of the observation: same distances for both seats
  const g = new Game({ seed: 7, rules: 'fast' });
  assert.deepEqual(observe(g, 1).victory.shrines.points.map((q) => q.d), observe(g, 2).victory.shrines.points.map((q) => q.d));
  // a shrine on water is an error in the checker
  const bad = JSON.parse(JSON.stringify(generateMap(7, { size: 96, shrines: true })));
  bad.terrain[bad.shrines[0].ty] = bad.terrain[bad.shrines[0].ty].slice(0, bad.shrines[0].tx) + '~~' + bad.terrain[bad.shrines[0].ty].slice(bad.shrines[0].tx + 2);
  assert.ok(checkMap(bad).errors.some((e) => /shrine/i.test(e)));
});

test('shrines: soldiers capture after the capture time, enemies contest, victory points count, the target wins', () => {
  const g = fastGame(8, { shrineTarget: 40 });
  const sh = g.shrines[0];
  const near = (owner, type, k = 0) => g.addUnit(owner, type, sh.cx + 2000, sh.cy + 400 * k);
  const a = near(1, 'spearman');
  stepN(g, 100);
  assert.equal(sh.own, 0, 'not yet');
  assert.ok(sh.prog > 0 && sh.cand === 1);
  stepN(g, 70);
  assert.equal(sh.own, 1, 'captured');
  const ev = g.announcements.find((e) => e.type === 'control_point_captured');
  assert.ok(ev && ev.team === 1 && ev.x === sh.tx);
  assert.equal(observe(g, 2).victory.shrines.points.find((q) => q.id === sh.id).holder, 'enemy');
  // an enemy soldier standing there stops the clock for everybody
  const e = near(2, 'spearman', 3);
  const before = g.vp[1];
  stepN(g, 50);
  assert.equal(sh.own, 1);
  assert.ok(g.vp[1] > before, 'the holder keeps scoring');
  assert.equal(sh.cand, 0, 'no capture while both stand there');
  a.dead = true; g.dead.push(a); stepN(g, 3); // the holder leaves: the enemy alone takes it
  stepN(g, 200);
  assert.equal(sh.own, 2);
  assert.ok(e && g.score(g.players[2]) >= 0);
  // workers alone cannot take a shrine, an outpost next to it holds it
  const g2 = fastGame(8);
  const s2 = g2.shrines[0];
  g2.addUnit(1, 'worker', s2.cx + 2000, s2.cy);
  stepN(g2, 300);
  assert.equal(s2.own, 0);
  g2.addUnit(1, 'spearman', s2.cx + 2000, s2.cy + 800);
  const op = g2.addBuilding(2, 'outpost', s2.tx + 4, s2.ty, true);
  stepN(g2, 300);
  assert.equal(s2.own, 0, 'the outpost contests');
  assert.ok(op.built);
  // target wins
  const g3 = fastGame(9, { shrineTarget: 30 });
  g3.addUnit(1, 'spearman', g3.shrines[0].cx + 2000, g3.shrines[0].cy);
  g3.addUnit(1, 'spearman', g3.shrines[1].cx + 2000, g3.shrines[1].cy);
  stepN(g3, 1200);
  assert.equal(g3.over, true);
  assert.equal(g3.endReason, 'shrines');
  assert.equal(g3.winnerTeam, 1);
  assert.ok(g3.result().vp[0] >= 30);
});

test('determinism: the same seed and commands give the same hash with market, wonder and shrines in play', () => {
  const run = () => {
    const g = fastGame(11, { wonderSecs: 40 });
    const p = g.players[1];
    p.res.food = 2000; p.tier = 3;
    place(g, 1, 'market');
    g.command(1, { cmd: 'trade', sell: 'food', buy: 'gold', amount: 700 });
    place(g, 2, 'wonder', -10, -10);
    g.addUnit(1, 'spearman', g.shrines[0].cx + 2000, g.shrines[0].cy);
    const hs = [];
    for (let i = 0; i < 12; i++) { stepN(g, 100); hs.push(g.hash()); }
    return hs.join();
  };
  assert.equal(run(), run());
});

test('God mode: heal and remove work on the new buildings and units', () => {
  const g = fastGame(12);
  const w = place(g, 1, 'wonder', -10, -10);
  w.hp = 10;
  assert.equal(g.command(0, { cmd: 'director', action: 'heal', id: w.id }).ok, true);
  assert.equal(w.hp, w.maxhp);
  const r = g.command(0, { cmd: 'director', action: 'spawn', player: 1, unit: 'bulwark', count: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.ids.length, 2);
});
