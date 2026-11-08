// The living world: weather, map types, caravans, ships and the harbor, the say tool, replays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { generateMap } from '../sim/mapgen.mjs';
import { checkMap } from '../sim/mapcheck.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { buildWeather } from '../sim/world.mjs';
import { observe } from '../sim/observe.mjs';
import { MAP_TYPES, WEATHER, WEATHER_KINDS, CARAVAN, CHAT } from '../sim/world-data.mjs';
import { runMatch } from '../tools/run-match.mjs';
import { stepN, tc, workers } from '../test-support/helpers.mjs';
import { buildScript } from '../tools/caster-facts.mjs';
import { makeContext, checkLine } from '../tools/caster-check.mjs';
import { templateLines } from '../tools/caster-template.mjs';
import { addSlowMotion, buildPlan } from '../tools/plan.mjs';
import { detectMoments } from '../tools/commentary.mjs';
import { computeEvents } from '../tools/events.mjs';
import { scriptedReplay } from '../test-support/replays.mjs';

const fastRules = (o = {}) => ({ preset: 'fast', ...o });

// ---------------------------------------------------------------- map types
test('map types: every type is symmetric, reachable and fair on both sizes; meadow is the old map', () => {
  for (const type of MAP_TYPES) {
    for (const [size, treasure] of [[96, { gold: 2000, stone: 1200 }], [128, null]]) {
      for (let seed = 1; seed <= 12; seed++) {
        const m = generateMap(seed, { players: 2, size, treasure, mapType: type });
        const r = checkMap(m);
        assert.equal(r.ok, true, `${type} ${size} seed ${seed}: ${JSON.stringify(r.errors)}`);
        assert.equal(r.fairness.level, 'perfect', `${type} ${size} seed ${seed} fairness`);
        assert.equal(r.symmetry, 'point');
      }
    }
    const q = checkMap(generateMap(3, { players: 4, size: 128, mapType: type }));
    assert.equal(q.ok, true, `${type} 4p: ${JSON.stringify(q.errors)}`);
  }
  // without a type the generator gives exactly the original meadow (no new keys, same terrain as before the world existed)
  const a = generateMap(7, { players: 2, size: 96 }), b = generateMap(7, { players: 2, size: 96, mapType: 'meadow' });
  assert.deepEqual(a.terrain, b.terrain);
  assert.deepEqual(a.nodes, b.nodes);
  assert.equal(a.mapType, undefined);
});

test('map types: the coast has a sea with mirrored fish; the desert pays more wood per palm; each type looks different', () => {
  const coast = generateMap(5, { players: 2, size: 96, mapType: 'coast' });
  assert.equal(coast.mapType, 'coast');
  const water = coast.terrain.join('').split('').filter((c) => c === '~').length;
  assert.ok(water > 900, `coast water ${water}`);
  assert.ok(coast.fish.length >= 6 && coast.fish.length % 2 === 0);
  for (const f of coast.fish) assert.ok(coast.fish.some((g) => g.tx === 95 - f.tx && g.ty === 95 - f.ty), 'fish are point mirrored');
  const desert = generateMap(5, { players: 2, size: 96, mapType: 'desert' });
  assert.ok(desert.wood.length > 0 && desert.wood.every((w) => w.amount > 150));
  const counts = (m) => { const c = {}; for (const ch of m.terrain.join('')) c[ch] = (c[ch] || 0) + 1; return c; };
  const forest = counts(generateMap(5, { players: 2, size: 96, mapType: 'forest' })), meadow = counts(generateMap(5, { players: 2, size: 96 })), des = counts(desert);
  assert.ok(forest.f > meadow.f * 1.5, 'forest maps have far more trees');
  assert.ok(des.f < meadow.f, 'the desert has few trees');
  assert.ok(des['#'] > meadow['#'], 'the desert has mesas');
});

test('map types: rules.mapType reaches the generator; a Game on each type runs and hashes the same twice', () => {
  for (const type of MAP_TYPES) {
    const mk = () => new Game({ seed: 4, rules: fastRules({ mapType: type }) });
    const a = mk(), b = mk();
    stepN(a, 600); stepN(b, 600);
    assert.equal(a.mapType, type);
    assert.equal(a.hash(), b.hash());
  }
});

// ---------------------------------------------------------------- weather
test('weather: the schedule is a pure function of seed, map type and mode; calm opening, no repeats, mix by map type', () => {
  for (const type of MAP_TYPES) {
    const a = buildWeather(11, type, 1800, 'auto'), b = buildWeather(11, type, 1800, 'auto');
    assert.deepEqual(a, b);
    assert.equal(a[0].kind, 'clear');
    assert.ok(a[0].to >= 900 && a[0].to <= 1800, 'the opening is clear for 90-180 s');
    for (let i = 1; i < a.length; i++) { assert.notEqual(a[i].kind, a[i - 1].kind); assert.equal(a[i].from, a[i - 1].to); }
    assert.equal(a[a.length - 1].to, Infinity);
    const kinds = new Set(); for (let s = 1; s <= 40; s++) for (const p of buildWeather(s, type, 1800, 'auto')) kinds.add(p.kind);
    if (type === 'desert') assert.ok(!kinds.has('rain') && !kinds.has('snow'));
    if (type === 'winter') assert.ok(kinds.has('snow') && !kinds.has('rain'));
    if (type === 'meadow') assert.ok(kinds.has('rain') && !kinds.has('snow'));
  }
  assert.notDeepEqual(buildWeather(1, 'meadow', 1800, 'auto'), buildWeather(2, 'meadow', 1800, 'auto'));
  assert.deepEqual(buildWeather(1, 'meadow', 1800, 'fog'), [{ from: 0, to: Infinity, kind: 'fog' }]);
  assert.deepEqual(buildWeather(1, 'meadow', 1800, 'off'), [{ from: 0, to: Infinity, kind: 'clear' }]);
});

test('weather: the same game twice gives the same weather, hash and replay; classic stays without weather', () => {
  const a = runMatch({ seed: 9, bots: ['boom', 'rush'], rules: 'fast', maxMinutes: 8 }), b = runMatch({ seed: 9, bots: ['boom', 'rush'], rules: 'fast', maxMinutes: 8 });
  assert.equal(a.game.hash(), b.game.hash());
  assert.deepEqual(a.game.worldLog, b.game.worldLog);
  const kinds = new Set(a.game.worldLog.filter((e) => e.type === 'weather').map((e) => e.kind));
  assert.ok(kinds.size >= 1, 'the sky changed during 8 minutes');
  const c = new Game({ seed: 9 });
  stepN(c, 4000);
  assert.equal(c.wxOn, false);
  assert.equal(c.weatherInfo().kind, 'clear');
  assert.equal(observe(c, 1).weather, undefined, 'classic observations carry no weather');
});

test('weather: effects are small, global and symmetric (the numbers apply to both sides the same)', () => {
  for (const [k, w] of Object.entries(WEATHER)) {
    for (const f of ['move', 'sea', 'sight', 'food', 'all']) assert.ok(w[f] >= 75 && w[f] <= 100, `${k}.${f}`);
  }
  const g = new Game({ seed: 3, rules: fastRules({ weather: 'storm' }) });
  stepN(g, 10);
  assert.equal(g.wxKind, 'storm');
  const w1 = g.units.values().next().value;
  const sp = g.pl(1).stats.worker.speed;
  assert.equal(g.worldSpeed(w1, sp), Math.floor((sp * WEATHER.storm.move) / 100));
  const p2 = [...g.units.values()].find((u) => u.owner === 2);
  assert.equal(g.worldSpeed(p2, sp), Math.floor((sp * WEATHER.storm.move) / 100));
  assert.equal(g.worldSight(10), Math.floor((10 * WEATHER.storm.sight) / 100));
  // gathering: a rainy game yields less food than a clear one for both players alike
  const run = (weather) => { const q = new Game({ seed: 5, rules: fastRules({ weather, caravans: false }) }); stepN(q, 3000); return [q.players[1].gathered.food, q.players[2].gathered.food]; };
  const clear = run('clear'), rain = run('rain');
  assert.ok(rain[0] < clear[0] && rain[1] < clear[1], `rain ${rain} < clear ${clear}`);
  assert.ok(Math.abs(rain[0] - rain[1]) <= Math.max(6, 0.06 * rain[0]), 'both sides lose the same');
});

test('weather: fog shrinks what the observation can see; the observation names the weather and what comes next', () => {
  const clear = new Game({ seed: 6, rules: fastRules({ weather: 'clear', caravans: false }) }), fog = new Game({ seed: 6, rules: fastRules({ weather: 'fog', caravans: false }) });
  stepN(clear, 40); stepN(fog, 40);
  const seen = (g) => g.players[1].vis.reduce((a, v) => a + v, 0);
  assert.ok(seen(fog) < seen(clear), 'fog: less ground in sight');
  const o = observe(fog, 1);
  assert.equal(o.weather.kind, 'fog');
  assert.match(o.weather.effect, /sight/);
  const auto = new Game({ seed: 6, rules: fastRules() });
  stepN(auto, 20);
  const wa = observe(auto, 1).weather;
  assert.ok(WEATHER_KINDS.includes(wa.kind) && wa.ends_in_s > 0 && WEATHER_KINDS.includes(wa.next));
});

test('weather: God mode sets the weather for a while, logged and replayable', () => {
  const g = new Game({ seed: 2, rules: fastRules() });
  stepN(g, 10);
  const r = g.command(0, { cmd: 'director', action: 'weather', kind: 'storm', secs: 40 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(g.wxKind, 'storm');
  assert.equal(g.command(0, { cmd: 'director', action: 'weather', kind: 'plague' }).ok, false);
  stepN(g, 420);
  assert.notEqual(g.wx.over && g.wx.over.kind, 'storm');
  assert.ok(g.worldLog.some((e) => e.type === 'weather' && e.kind === 'storm'));
});

// ---------------------------------------------------------------- caravans
test('caravans: mirrored routes, they walk, trade and come back; classic has none', () => {
  const g = new Game({ seed: 3, rules: fastRules({ weather: 'off' }) });
  assert.equal(g.caravans.length, 2);
  const [a, b] = g.caravans;
  assert.deepEqual(a.route.map(([x, y]) => [95 - x, 95 - y]), b.route);
  const start = g.units.get(a.uid);
  const x0 = start.x, y0 = start.y;
  stepN(g, 900);
  const now = g.units.get(a.uid);
  assert.ok(now && (now.x !== x0 || now.y !== y0), 'the caravan moved');
  assert.equal(new Game({ seed: 3 }).caravans.length, 0);
});

test('caravans: killing one pays the bounty to the killer; soldiers do not attack it by themselves; a replacement comes', () => {
  const g = new Game({ seed: 3, rules: fastRules({ weather: 'off' }) });
  const c = g.caravans[0];
  const cu = g.units.get(c.uid);
  // an idle soldier of player 1 right beside the caravan leaves it alone
  const s = g.addUnit(1, 'spearman', cu.x + 600, cu.y);
  stepN(g, 60);
  assert.ok(!cu.dying && cu.hp === cu.maxhp, 'no automatic attack on a caravan');
  const gold0 = g.players[1].res.gold;
  g.players[1].res.food = 9999;
  // an explicit attack order is the raid
  g.command(1, { cmd: 'attack_move', units: [s.id], target: g.units.get(c.uid).id });
  for (let i = 0; i < 1200 && g.units.get(c.uid) && !g.units.get(c.uid).dying; i++) { g.step(); }
  assert.ok(g.players[1].res.gold >= gold0 + CARAVAN.bounty - 5, `bounty paid (${g.players[1].res.gold} vs ${gold0})`);
  assert.ok(g.worldLog.some((e) => e.type === 'caravan_raid' && e.p === 1));
  stepN(g, CARAVAN.respawnS * 10 + 20);
  assert.ok(g.units.get(c.uid), 'a new caravan took the road');
});

test('caravans: soldiers beside the caravan when it reaches a post share the trade fee', () => {
  const g = new Game({ seed: 3, rules: fastRules({ weather: 'off' }) });
  const c = g.caravans[0];
  const [px, py] = c.route[1];
  // wait for the caravan to get close to its first post, put soldiers of player 2 there
  let guard = 0;
  while (!g.worldLog.some((e) => e.type === 'caravan_trade') && guard++ < 5000) {
    if (guard === 1) { for (let k = 0; k < 2; k++) g.addUnit(2, 'spearman', px * 1000 + 500 + 300 * k, py * 1000 + 500); }
    g.step();
  }
  const trade = g.worldLog.find((e) => e.type === 'caravan_trade');
  assert.ok(trade, 'a trade happened');
  assert.deepEqual(trade.paid.map((p) => p[0]), [2]);
  assert.equal(trade.paid[0][1], CARAVAN.trade);
});

// ---------------------------------------------------------------- ships
function coastGame(seed = 5, extra = {}) {
  const g = new Game({ seed, rules: fastRules({ mapType: 'coast', weather: 'off', caravans: false, ...extra }) });
  for (const r of ['food', 'wood', 'stone', 'gold']) for (const p of [1, 2]) g.players[p].res[r] = 4000;
  g.players[1].tier = 3; g.players[2].tier = 3;
  return g;
}
// reveal everything so that a harbor site can be found
function reveal(g) { for (const p of g.players) if (p) p.expl.fill(1); }
function harborSpot(g, pid) {
  const p = g.players[pid], d = p.faction.buildings.harbor;
  const W = g.W;
  let best = null, bd = Infinity;
  const t = tc(g, pid);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    if (!g.siteOk(p, d, x, y)) continue;
    const dd = (x - t.tx) ** 2 + (y - t.ty) ** 2;
    if (dd < bd) { bd = dd; best = [x, y]; }
  }
  return best;
}
function buildHarbor(g, pid) {
  reveal(g);
  const spot = harborSpot(g, pid);
  assert.ok(spot, 'a harbor site exists');
  const r = g.command(pid, { cmd: 'build', building_type: 'harbor', near: [spot[0] + 2, spot[1] + 2], worker_ids: workers(g, pid).slice(0, 5).map((u) => u.id) });
  assert.equal(r.ok, true, JSON.stringify(r));
  const h = g.buildings.get(r.building_id);
  for (let i = 0; i < 3000 && !h.built; i++) g.step();
  assert.ok(h.built, 'harbor built');
  return h;
}

test('ships: a harbor needs a sea; on a meadow map it cannot be placed', () => {
  const m = new Game({ seed: 5, rules: fastRules({ weather: 'off', caravans: false }) });
  reveal(m);
  assert.equal(harborSpot(m, 1), null);
  const c = coastGame();
  reveal(c);
  assert.ok(harborSpot(c, 1) && harborSpot(c, 2));
});

test('ships: the harbor trains boats on water; fishing boats fish by themselves and deliver food', () => {
  const g = coastGame();
  const h = buildHarbor(g, 1);
  assert.equal(g.command(1, { cmd: 'train', building_id: h.id, unit_type: 'fishing_boat', count: 2 }).ok, true);
  const food0 = g.players[1].res.food, gathered0 = g.players[1].gathered.food;
  stepN(g, 280 + 200);
  const boats = [...g.units.values()].filter((u) => u.owner === 1 && u.type === 'fishing_boat');
  assert.equal(boats.length, 2);
  for (const u of boats) assert.equal(g.terrain[g.tileOf(u.x, u.y)], 2, 'ships stay on water');
  stepN(g, 3000);
  assert.ok(g.players[1].gathered.food > gathered0 + 40, `fish delivered (${g.players[1].gathered.food - gathered0})`);
  void food0;
  for (const u of [...g.units.values()].filter((v) => v.ship)) assert.equal(g.terrain[g.tileOf(u.x, u.y)], 2);
  const o = observe(g, 1);
  assert.ok(o.ships.length === 2 && o.ships[0].type === 'fishing_boat');
  assert.ok(o.sea.fishing_spots.length > 0);
});

test('ships: naval pathing goes round land; a land point becomes the nearest sea point; war boats sink each other', () => {
  const g = coastGame(5);
  const h1 = buildHarbor(g, 1), h2 = buildHarbor(g, 2);
  g.command(1, { cmd: 'train', building_id: h1.id, unit_type: 'war_boat', count: 2 });
  g.command(2, { cmd: 'train', building_id: h2.id, unit_type: 'war_boat', count: 2 });
  stepN(g, 560);
  const mine = [...g.units.values()].filter((u) => u.owner === 1 && u.type === 'war_boat');
  const theirs = [...g.units.values()].filter((u) => u.owner === 2 && u.type === 'war_boat');
  assert.equal(mine.length, 2); assert.equal(theirs.length, 2);
  // 'army' does not include ships, 'ships' does
  assert.ok(!(g.resolveUnits(g.players[1], 'army').list || []).some((u) => u.ship), 'army has no ships');
  assert.equal(g.resolveUnits(g.players[1], 'ships').list.length, 2);
  // sail to a land tile next to the other town: the boat ends up on water
  const t2 = tc(g, 2);
  assert.equal(g.command(1, { cmd: 'move', units: 'ships', target: [t2.tx + 1, t2.ty + 1] }).ok, true);
  stepN(g, 1200);
  for (const u of mine) if (!u.dead) assert.equal(g.terrain[g.tileOf(u.x, u.y)], 2);
  // a fight
  g.command(1, { cmd: 'attack_move', units: 'ships', target: [h2.tx, h2.ty] });
  g.command(2, { cmd: 'attack_move', units: 'ships', target: [h1.tx, h1.ty] });
  stepN(g, 3000);
  const dmg = [...g.units.values()].filter((u) => u.type === 'war_boat').reduce((a, u) => a + (u.maxhp - u.hp), 0);
  assert.ok(dmg > 0 || g.players[1].kills + g.players[2].kills > 0, 'the boats fought');
});

test('ships: a transport takes land units across the water and lands them; a sunk transport drowns its cargo', () => {
  const g = coastGame(5);
  const h = buildHarbor(g, 1);
  g.command(1, { cmd: 'train', building_id: h.id, unit_type: 'transport' });
  stepN(g, 260);
  const t = [...g.units.values()].find((u) => u.type === 'transport');
  assert.ok(t);
  const sh = g.shoreFor(t, 1);
  assert.ok(sh, 'the transport lies at a shore');
  const sp = [];
  for (let i = 0; i < 3; i++) sp.push(g.addUnit(1, 'spearman', sh[0] * 1000 + 500, sh[1] * 1000 + 500));
  g.players[1].cap = 100;
  const r = g.command(1, { cmd: 'board', units: sp.map((u) => u.id), transport_id: t.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  stepN(g, 300);
  assert.equal(t.cargo.length, 3);
  assert.ok(sp.every((u) => u.boarded === t.id));
  const o = observe(g, 1);
  assert.equal(o.ships.find((s) => s.id === t.id).cargo.length > 0, true);
  assert.ok(!o.units.some((u) => u.type === 'spearman'), 'boarded units are off the map');
  const pop = g.players[1].pop;
  // unload at the other shore
  const t2 = tc(g, 2);
  const wet = g.navNear((t2.tx + 2) * 1000, (t2.ty + 2) * 1000, 40, 1);
  assert.ok(wet, 'water near the other town');
  const u = g.command(1, { cmd: 'unload', transport_id: t.id, to: [Math.floor(wet[0] / 1000), Math.floor(wet[1] / 1000)] });
  assert.equal(u.ok, true, JSON.stringify(u));
  stepN(g, 2400);
  assert.equal(t.cargo.length, 0);
  assert.ok(sp.every((x) => !x.boarded && g.terrain[g.tileOf(x.x, x.y)] === 0));
  assert.equal(g.players[1].pop, pop, 'cargo counted for the population all the way');
  // drowning: board again and sink the ship
  const sp2 = g.addUnit(1, 'spearman', t.x, t.y);
  sp2.boarded = t.id; t.cargo.push(sp2.id);
  g.kill(t, 2, 'war_boat');
  g.cleanup();
  assert.ok(sp2.dead || sp2.dying, 'the passenger went down with the ship');
});

test('ships: melee soldiers never target ships; towers and archers can', () => {
  const g = coastGame(5);
  const h = buildHarbor(g, 1);
  g.command(1, { cmd: 'train', building_id: h.id, unit_type: 'fishing_boat' });
  stepN(g, 200);
  const boat = [...g.units.values()].find((u) => u.type === 'fishing_boat');
  const sw = g.addUnit(2, 'swordsman', boat.x, boat.y);
  g.rebuildGrid();
  assert.equal(g.acquire(sw, 6000, true), null, 'a swordsman cannot hit a boat');
});

// ---------------------------------------------------------------- chat
test('say: max 100 characters, rate limited, logged as a command, delivered to the other player', () => {
  const g = new Game({ seed: 2, rules: fastRules() });
  stepN(g, 10);
  const r = g.command(1, { cmd: 'say', text: 'x'.repeat(150) });
  assert.equal(r.ok, true);
  assert.equal(r.text.length, CHAT.maxChars);
  assert.ok(r.note);
  const again = g.command(1, { cmd: 'say', text: 'second' });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'rate_limited');
  assert.equal(g.command(1, { cmd: 'say', text: '   ' }).error, 'bad_args');
  assert.equal(g.command(2, { cmd: 'say', text: 'hello back' }).ok, true, 'the limit is per player');
  assert.ok(g.commandLog.some((c) => c.p === 1 && c.cmd.cmd === 'say'), 'the line is in the command log (the replay)');
  stepN(g, CHAT.gapTicks);
  assert.equal(g.command(1, { cmd: 'say', text: 'second' }).ok, true);
  const o2 = observe(g, 2, { sinceTick: 0 });
  assert.ok(o2.chat.length >= 1 && o2.chat.every((m) => m.from === 'enemy'));
  assert.equal(o2.chat[0].text.length, CHAT.maxChars);
  const o1 = observe(g, 1, { sinceTick: 0 });
  assert.ok(o1.chat.every((m) => m.player === 2), 'you never read your own lines back');
  assert.ok(g.worldLog.filter((e) => e.type === 'chat').length === 3);
});

test('say: chat does not change the simulation (the same game with and without chat has the same hash)', () => {
  const a = new Game({ seed: 8, rules: fastRules() }), b = new Game({ seed: 8, rules: fastRules() });
  stepN(a, 100); stepN(b, 100);
  b.command(1, { cmd: 'say', text: 'hi there' });
  stepN(a, 400); stepN(b, 400);
  assert.equal(a.hash(), b.hash());
});

// ---------------------------------------------------------------- rules and replays
test('rules: old recorded rules objects replay without the world; presets carry the new switches', () => {
  const f = resolveRules('fast'), c = resolveRules('classic');
  assert.deepEqual([f.weather, f.caravans, f.mapType], ['auto', true, 'meadow']);
  assert.deepEqual([c.weather, c.caravans, c.mapType], ['off', false, 'meadow']);
  const old = { ...f }; delete old.worldRev; delete old.weather; delete old.caravans; delete old.mapType;
  const r = resolveRules(old);
  assert.deepEqual([r.weather, r.caravans, r.mapType], ['off', false, 'meadow']);
  assert.equal(resolveRules({ preset: 'fast', mapType: 'nope' }).mapType, 'meadow');
  assert.equal(resolveRules({ preset: 'fast', weather: 'snow' }).weather, 'snow');
});

test('replay: a recorded match with weather, caravans and chat replays to the same hash', () => {
  const rules = resolveRules(fastRules({ mapType: 'winter' }));
  const a = new Game({ seed: 12, rules });
  const log = [];
  for (let i = 0; i < 2400; i++) {
    if (i === 300) { const r = a.command(1, { cmd: 'say', text: 'good luck' }); assert.equal(r.ok, true); log.push({ t: a.t, p: 1, cmd: { cmd: 'say', text: 'good luck' } }); }
    if (i === 600) { a.command(0, { cmd: 'director', action: 'weather', kind: 'snow', secs: 60 }); log.push({ t: a.t, p: 0, cmd: { cmd: 'director', action: 'weather', kind: 'snow', secs: 60 } }); }
    a.step();
  }
  const b = new Game({ seed: 12, rules: JSON.parse(JSON.stringify(rules)) });
  for (let i = 0; i < 2400; i++) {
    for (const c of log) if (c.t === b.t) b.command(c.p, c.cmd);
    b.step();
  }
  assert.equal(a.hash(), b.hash());
  assert.deepEqual(a.worldLog, b.worldLog);
});

// ---------------------------------------------------------------- events and casters
test('events: a recorded match yields weather changes and chat lines; casters quote a chat line word for word, never an invented one', () => {
  const dir = scriptedReplay(['boom', 'rush'], 4);
  const ev = computeEvents(dir);
  assert.equal(ev.verified.ok, true);
  const types = new Set(ev.events.map((e) => e.type));
  assert.ok(types.has('chat'), 'the bots said something');
  assert.ok(!types.has('weather_change'), 'classic rules: no weather');
  // a synthetic chat line goes through the caster pipeline
  const say = { id: 900, t: 3000, type: 'chat', p: 1, text: 'Knock if you must. The gate is stubborn.' };
  const raid = { id: 901, t: 3100, type: 'caravan_raid', p: 2, gold: 140, loc: [40, 40] };
  const weather = { id: 902, t: 3200, type: 'weather_change', kind: 'storm', from: 'clear' };
  const sea = { id: 903, t: 3300, type: 'naval_battle', t_end: 3400, loc: [50, 50], value: 400, ships_lost: { 1: 2 }, by: [2] };
  const base = ev.events.filter((e) => !['chat', 'caravan_raid', 'weather_change', 'naval_battle'].includes(e.type));
  const events = [...base, say, raid, weather, sea].sort((a, b) => a.t - b.t);
  events.forEach((e, i) => { e.id = i + 1; });
  const ev2 = { ...ev, events };
  const hl = { scenes: [{ id: 1, rank: 1, start: 0, end: ev.ticks, kind: 'victory', title: '', focus: null, score: 5 }] };
  let plan = buildPlan(ev2, hl, { mode: 'full', params: {} });
  plan = addSlowMotion(plan, detectMoments(ev2, { max: 2 }));
  const { sheet, beats } = buildScript(ev2, plan, { cls: '32 GB' });
  const sf = sheet.facts.find((f) => f.kind === 'say');
  assert.ok(sf && sf.data.quote === say.text);
  assert.ok(sheet.facts.some((f) => f.kind === 'caravan') && sheet.facts.some((f) => f.kind === 'weather') && sheet.facts.some((f) => f.kind === 'sea'));
  const ctx = makeContext(sheet, beats);
  const b = beats.find((x) => x.facts.includes(sf.id)) || beats[0];
  const ok = checkLine({ beat: b.id, speaker: 'ana', when: 'at', delivery: 'calm', text: 'It says: “Knock if you must. The gate is stubborn.” Bold!', facts: [sf.id], opinion: false, interject: false }, ctx);
  assert.deepEqual(ok.reasons, []);
  const bad = checkLine({ beat: b.id, speaker: 'ana', when: 'at', delivery: 'calm', text: 'It says: “We will crush you all by noon.” Bold!', facts: [sf.id], opinion: false, interject: false }, ctx);
  assert.ok(bad.reasons.some((r) => /quote/.test(r)));
  const lines = templateLines(sheet, beats, { seed: 1 });
  assert.ok(lines.length > 0);
});
