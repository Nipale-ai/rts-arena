import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Game } from '../sim/game.mjs';
import { PRESETS, resolveRules } from '../sim/rules.mjs';
import { generateMap } from '../sim/mapgen.mjs';
import { checkMap } from '../sim/mapcheck.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import {
  loadScenario, validateScenario, resolveScenarioRules, listScenarioIds, verifyBoardSeeds, parseSeedsHashFile, boardSeedsHash, hashRules, scenarioIdentity, seedsHash,
  RULE_KEYS, ScenarioError, SCENARIO_DIR, SEEDS_HASH_FILE, ROOT,
} from '../tools/solo/scenario.mjs';
import { deriveAll, mapIsGood, SEED_PLAN } from '../tools/solo/seeds.mjs';

const duel = loadScenario('duel-ladder');
const eco = loadScenario('eco-sprint');
const clone = (o) => JSON.parse(JSON.stringify(o));
const base = () => { const o = clone(duel); delete o.fileHash; delete o.filePath; return o; };
const errsOf = (o) => validateScenario(o).errors.join('\n');
const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();

// ---------- the two shipped scenarios ----------
test('duel-ladder: fast preset, sudden death, wonder and shrines off, cutoff below the sim time limit (plan A4 nr 1)', () => {
  assert.equal(duel.id, 'duel-ladder');
  assert.equal(duel.goal, 'destroy');
  assert.equal(duel.preset, 'fast');
  assert.deepEqual(duel.levels, [0, 3]);
  assert.deepEqual(duel.judge, { kind: 'destroy' });
  assert.deepEqual(duel.modelSeats, [1, 2]);
  const r = resolveScenarioRules(duel);
  assert.equal(r.suddenDeath, 0);
  assert.equal(r.wonder, false);
  assert.equal(r.shrines, false);
  assert.equal(r.timeLimitS, 1800);
  assert.equal(duel.maxGameSeconds, 1500);
  assert.ok(duel.maxGameSeconds < r.timeLimitS, 'the cutoff comes before the sim time limit: no score or seed winner');
  // nothing else differs from the plain fast preset
  assert.deepEqual(diffKeys(r, resolveRules('fast')), ['shrines', 'suddenDeath', 'wonder']);
});

test('eco-sprint: tier 3 in 10 minutes against level 0, cutoff 600 s (plan A4 nr 2)', () => {
  assert.equal(eco.id, 'eco-sprint');
  assert.equal(eco.goal, 'eco');
  assert.equal(eco.preset, 'fast');
  assert.deepEqual(eco.levels, [0, 0]);
  assert.deepEqual(eco.judge, { kind: 'eco', tierTarget: 3 });
  assert.equal(eco.maxGameSeconds, 600);
  const r = resolveScenarioRules(eco);
  assert.equal(r.wonder, false);
  assert.equal(r.shrines, false);
  assert.ok(eco.maxGameSeconds < r.timeLimitS);
  assert.ok(r.suddenDeath === 0 || r.suddenDeath >= eco.maxGameSeconds, 'no decay inside the measured time');
  assert.deepEqual(diffKeys(r, resolveRules('fast')), ['shrines', 'wonder']);
});

test('both scenarios validate cleanly, carry the file hash, and every id in the folder loads', () => {
  for (const sc of [duel, eco]) {
    const v = validateScenario(sc);
    assert.deepEqual(v.errors, []);
    assert.equal(sc.fileHash, crypto.createHash('sha256').update(fs.readFileSync(sc.filePath)).digest('hex'));
    assert.equal(sc.filePath, path.join(SCENARIO_DIR, `${sc.id}.json`));
  }
  assert.deepEqual(listScenarioIds(), ['duel-ladder', 'eco-sprint']);
  assert.notEqual(duel.fileHash, eco.fileHash);
  assert.notEqual(hashRules(resolveScenarioRules(duel)), hashRules(resolveScenarioRules(eco)));
});

test('resolved rules are what LiveMatch needs: stable through resolveRules and playable', () => {
  for (const sc of [duel, eco]) {
    const r = resolveScenarioRules(sc);
    assert.deepEqual(resolveRules(r), r, 'LiveMatch resolves opts.rules once more; the second pass must change nothing');
    assert.equal(hashRules(r), hashRules(resolveRules(r)));
    const g = new Game({ seed: sc.seeds.board[0], rules: r });
    assert.equal(g.W, sc.mapSize);
    assert.equal(g.shrines.length, 0, 'no shrines on the map');
  }
});

test('resolveRules() has two legacy modes a scenario must not fall into (ruleInput guards them)', () => {
  // mapSize without content = "an older build's resolved rules": content 1, so wonder and shrines silently go off unless restated
  assert.equal(resolveRules({ preset: 'fast', mapSize: 96 }).content, 1);
  assert.equal(resolveRules({ preset: 'fast', mapSize: 96 }).wonder, false);
  assert.equal(resolveRules({ preset: 'fast', mapSize: 96, content: 2 }).wonder, true);
  // startUnits + separation without worldRev = "a replay from before the living world": no weather, no caravans
  const legacy = resolveRules({ preset: 'fast', startUnits: [], separation: true });
  assert.equal(legacy.weather, 'off');
  assert.equal(legacy.caravans, false);
  // the scenario path restates both, so a scenario may carry startUnits and separation and keeps weather and caravans of the preset
  const sc = { ...base(), rules: { ...base().rules, startUnits: [{ type: 'light_cavalry', n: 1 }], separation: true } };
  assert.equal(validateScenario(sc).ok, true, errsOf(sc));
  const r = resolveScenarioRules(sc);
  assert.equal(r.weather, 'auto');
  assert.equal(r.caravans, true);
  assert.equal(r.content, 2);
});

// ---------- the override keys really act in the sim ----------
test('rule override keys: each accepted key is read by the sim, the refused ones are not', () => {
  const src = fs.readdirSync(path.join(ROOT, 'sim')).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(ROOT, 'sim', f), 'utf8')).join('\n');
  for (const k of Object.keys(RULE_KEYS)) assert.match(src, new RegExp(`\\.${k}\\b`), `rules.${k} is read somewhere in sim/`);
  // every key of every preset is either accepted or refused on purpose
  for (const p of Object.values(PRESETS)) for (const k of Object.keys(p)) assert.ok(k in RULE_KEYS || ['preset', 'mapSize', 'worldRev'].includes(k), `preset key ${k} is neither accepted nor refused`);
  // and every value the presets use passes the checker (so a scenario may restate a preset value)
  for (const p of Object.values(PRESETS)) for (const [k, v] of Object.entries(p)) if (k in RULE_KEYS) assert.ok(RULE_KEYS[k].ok(v), `${k}=${JSON.stringify(v)} of preset ${p.preset}`);
  // worldRev is forced to 1 by resolveRules: an override would do nothing
  assert.equal(resolveRules({ preset: 'fast', worldRev: 7 }).worldRev, 1);
});

test('rule override keys: effects measured on a real Game (start values and victory paths)', () => {
  const R = (o) => resolveRules({ preset: 'fast', ...o });
  const workers = (g, pid) => [...g.units.values()].filter((u) => u.owner === pid && u.type === 'worker').length;
  assert.equal(workers(new Game({ seed: 3, rules: R({ startWorkers: 9 }) }), 1), 9);
  assert.equal(workers(new Game({ seed: 3, rules: R({ startWorkers: 4 }) }), 2), 4);
  assert.equal(new Game({ seed: 3, rules: R({ startResources: { food: 500 } }) }).players[1].res.food, 200 + 500, 'base start 200 + the override 500 (the override replaces the 50 food of the fast preset)');
  assert.equal(new Game({ seed: 3, rules: R({ popMax: 200 }) }).rules.popMax, 200);
  assert.ok(new Game({ seed: 3, rules: R({ shrines: true }) }).shrines.length > 0, 'shrines: true puts shrines on the map');
  assert.equal(new Game({ seed: 3, rules: R({ shrines: false }) }).shrines.length, 0);
  // wonder off: the build command is refused with "disabled" (sim/commands.mjs:362), wonder on: it is not
  for (const [wonder, disabled] of [[false, true], [true, false]]) {
    const g = new Game({ seed: 3, rules: R({ wonder }) });
    g.players[1].tier = 3;
    const r = g.command(1, { cmd: 'build', building_type: 'wonder', near: [20, 20], worker_ids: 'auto' });
    assert.equal(r.error === 'disabled', disabled, `wonder=${wonder}: ${r.error}`);
  }
});

test('suddenDeath off: no decay after minute 22 on the scenario rules, decay on the plain fast preset', () => {
  const tc = (g) => [...g.buildings.values()].find((b) => b.owner === 1 && b.type === 'town_center');
  const run = (rules) => {
    const g = new Game({ seed: duel.seeds.tune[0], rules });
    const hp0 = tc(g).hp;
    while (g.t < 1400 * TICK_HZ) g.step(); // nobody plays: the village just stands there; past the old start of sudden death at 1320 s
    return { hp0, hp: tc(g).hp, announced: g.announcements.some((a) => a.type === 'sudden_death') };
  };
  const scen = run(resolveScenarioRules(duel));
  const plain = run(resolveRules('fast'));
  assert.equal(scen.hp, scen.hp0, 'the town center keeps its hit points');
  assert.equal(scen.announced, false);
  assert.ok(plain.hp < plain.hp0, 'plain fast: the town center crumbles from 1320 s');
  assert.equal(plain.announced, true);
});

// ---------- strict validation ----------
test('validate: a typo in a rule key is refused with a suggestion', () => {
  const o = base(); o.rules = { suddendeath: 0, wonder: false, shrines: false };
  const e = errsOf(o);
  assert.match(e, /rules\.suddendeath: unknown rule key \(did you mean "suddenDeath"\?\)/);
  assert.equal(validateScenario(o).ok, false);
});

test('validate: unknown keys, keys that are not overrides, keys that do nothing', () => {
  let o = base(); o.rules = { ...o.rules, bogus: 1 };
  assert.match(errsOf(o), /rules\.bogus: unknown rule key/);
  o = base(); o.rules = { ...o.rules, preset: 'war' };
  assert.match(errsOf(o), /rules\.preset: set the top level key "preset" instead/);
  o = base(); o.rules = { ...o.rules, mapSize: 128 };
  assert.match(errsOf(o), /rules\.mapSize: set the top level key "mapSize"/);
  o = base(); o.rules = { ...o.rules, worldRev: 2 };
  assert.match(errsOf(o), /rules\.worldRev: has no effect/);
  o = base(); o.extra = 1;
  assert.match(errsOf(o), /extra: unknown key/);
  o = base(); o.mapsize = 96;
  assert.match(errsOf(o), /mapsize: unknown key \(did you mean "mapSize"\?\)/);
  o = base(); delete o.seeds; delete o.judge;
  assert.match(errsOf(o), /seeds: missing/);
  assert.match(errsOf(o), /judge: missing/);
  assert.equal(validateScenario(null).ok, false);
  assert.equal(validateScenario([]).ok, false);
});

test('validate: only ids from the database', () => {
  let o = base(); o.rules = { ...o.rules, startUnits: [{ type: 'dragon', n: 1 }] };
  assert.match(errsOf(o), /rules\.startUnits: invalid value/);
  o = base(); o.rules = { ...o.rules, startUnits: [{ type: 'archer', n: 2 }] };
  assert.equal(validateScenario(o).ok, true, errsOf(o));
  o = base(); o.rules = { ...o.rules, buildingMods: { castel: { hp: 1 } } };
  assert.match(errsOf(o), /rules\.buildingMods: invalid value/);
  o = base(); o.rules = { ...o.rules, buildingMods: { tower: { hp: 500, colour: 'red' } } };
  assert.match(errsOf(o), /rules\.buildingMods: invalid value/);
  o = base(); o.rules = { ...o.rules, unitMods: { ram: { atk: 10 } } };
  assert.equal(validateScenario(o).ok, true, errsOf(o));
  o = base(); o.rules = { ...o.rules, unitMods: { tank: { atk: 10 } } };
  assert.match(errsOf(o), /rules\.unitMods: invalid value/);
  o = base(); o.rules = { ...o.rules, startResources: { silver: 100 } };
  assert.match(errsOf(o), /rules\.startResources: invalid value/);
  o = base(); o.rules = { ...o.rules, gatherPct: { fishing: 10 } };
  assert.match(errsOf(o), /rules\.gatherPct: invalid value/);
  o = base(); o.rules = { ...o.rules, weather: 'meteors' };
  assert.match(errsOf(o), /rules\.weather: invalid value/);
});

test('validate: names that only exist on Object.prototype are no ids of the database', () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    let o = base(); o.rules = { ...o.rules, startUnits: [{ type: name, n: 2 }] };
    assert.match(errsOf(o), /rules\.startUnits: invalid value/, name);
    o = base(); o.rules = { ...o.rules, gatherPct: JSON.parse(`{"${name}": 10}`) };
    assert.match(errsOf(o), /rules\.gatherPct: invalid value/, name);
    o = base(); o.rules = { ...o.rules, unitMods: JSON.parse(`{"${name}": {}}`) };
    assert.match(errsOf(o), /rules\.unitMods: invalid value/, name);
    o = base(); o.rules = { ...o.rules, buildingMods: { tower: JSON.parse(`{"${name}": 1}`) } };
    assert.match(errsOf(o), /rules\.buildingMods: invalid value/, name);
    // as a rule key: a plain message that names the key, not the text of a function
    o = base(); o.rules = { ...o.rules, ...JSON.parse(`{"${name}": 1}`) };
    const e = errsOf(o);
    assert.match(e, new RegExp(`rules\\.${name}: unknown rule key`), name);
    assert.doesNotMatch(e, /native code|\[object Object\]/, name);
  }
});

test('validate: values the sim would silently change are refused', () => {
  let o = base(); o.rules = { ...o.rules, timeLimitS: 30 };
  assert.match(errsOf(o), /rules\.timeLimitS: invalid value 30/);
  o = base(); o.mapSize = 100;
  assert.match(errsOf(o), /mapSize: must be 96 or 128/);
  // wonder true with content 1: resolveRules() would switch it off again
  o = base(); o.goal = 'eco'; o.judge = { kind: 'eco', tierTarget: 3 }; o.rules = { content: 1, wonder: true, shrines: false };
  assert.match(errsOf(o), /rules\.wonder: the sim does not keep true: it resolves to false/);
  o = base(); o.rules = { ...o.rules, popMax: 120 };
  assert.match(errsOf(o), /rules\.popMax: invalid value 120/);
});

test('validate: the cutoff must come before the sim time limit', () => {
  let o = base(); o.maxGameSeconds = 1800;
  assert.match(errsOf(o), /maxGameSeconds: 1800 s is not below the sim time limit of 1800 s/);
  o = base(); o.maxGameSeconds = 1799;
  assert.equal(validateScenario(o).ok, true);
  o = base(); o.rules = { ...o.rules, timeLimitS: 1200 };
  assert.match(errsOf(o), /maxGameSeconds: 1500 s is not below the sim time limit of 1200 s/);
  o = base(); o.preset = 'war'; o.maxGameSeconds = 3600;
  assert.match(errsOf(o), /maxGameSeconds: 3600 s is not below the sim time limit of 3600 s/);
  o = base(); o.preset = 'war'; o.maxGameSeconds = 1500;
  const v = validateScenario(o);
  assert.equal(v.ok, true, errsOf(o));
  assert.match(v.warnings.join('\n'), /warAtS/);
});

test('validate: goal destroy needs decay, wonder and shrines off; goal eco needs wonder, shrines off and a tier target', () => {
  let o = base(); o.rules = { suddenDeath: 1320, wonder: false, shrines: false };
  assert.match(errsOf(o), /rules\.suddenDeath: goal "destroy" needs sudden death off/);
  o = base(); o.rules = { suddenDeath: 0, wonder: true, shrines: true };
  assert.match(errsOf(o), /rules\.wonder: goal "destroy" needs the wonder off/);
  assert.match(errsOf(o), /rules\.shrines: goal "destroy" needs the shrines off/);
  o = clone(eco); o.rules = { wonder: false, shrines: false, suddenDeath: 300 };
  assert.match(errsOf(o), /rules\.suddenDeath: sudden death from 300 s would break buildings inside the measured 600 s/);
  o = clone(eco); o.judge = { kind: 'eco' };
  assert.match(errsOf(o), /judge\.tierTarget: eco needs tierTarget 2 or 3/);
  o = clone(eco); o.judge = { kind: 'destroy' };
  assert.match(errsOf(o), /judge\.kind: "destroy" does not fit goal "eco"/);
  o = base(); o.judge = { kind: 'destroy', tierTarget: 3 };
  assert.match(errsOf(o), /judge\.tierTarget: only for kind "eco"/);
  o = base(); o.goal = 'win-everything';
  assert.match(errsOf(o), /goal: must be one of destroy, eco/);
});

test('validate: seeds, seats, levels, speed', () => {
  let o = base(); o.seeds.board = [1, 1, 2];
  assert.match(errsOf(o), /seeds\.board: duplicate seeds/);
  o = base(); o.seeds.board = [o.seeds.tune[0], 5];
  assert.match(errsOf(o), new RegExp(`tune and board must not share a seed \\(shared: ${o.seeds.tune[0]}\\)`));
  o = base(); o.seeds.tune = [];
  assert.match(errsOf(o), /seeds\.tune: non-empty list/);
  o = base(); o.seeds.board = [1.5];
  assert.match(errsOf(o), /seeds\.board: non-empty list of integers/);
  o = base(); o.seeds.dev = [1];
  assert.match(errsOf(o), /seeds\.dev: unknown list/);
  o = base(); o.modelSeats = [1, 3];
  assert.match(errsOf(o), /modelSeats:/);
  o = base(); o.modelSeats = [1, 1];
  assert.match(errsOf(o), /modelSeats:/);
  o = base(); o.levels = [3, 0];
  assert.match(errsOf(o), /levels:/);
  o = base(); o.levels = [0, 9];
  assert.match(errsOf(o), /levels:/);
  o = base(); o.speed = 0;
  assert.match(errsOf(o), /speed:/);
  o = base(); o.id = 'Duel Ladder';
  assert.match(errsOf(o), /id:/);
  o = base(); o.version = 0;
  assert.match(errsOf(o), /version:/);
});

test('validate: all problems are reported at once', () => {
  const o = base(); o.rules = { suddendeath: 0, bogus: 1 }; o.maxGameSeconds = 5; o.levels = 'all';
  const v = validateScenario(o);
  assert.ok(v.errors.length >= 4, v.errors.join('\n'));
});

// ---------- loading ----------
test('loadScenario: by id and by path, with clear errors', () => {
  assert.equal(loadScenario(path.join(SCENARIO_DIR, 'eco-sprint.json')).id, 'eco-sprint');
  assert.throws(() => loadScenario('nope'), (e) => e instanceof ScenarioError && /scenario not found: "nope" \(have: duel-ladder, eco-sprint\)/.test(e.message));
  assert.throws(() => loadScenario('../server/arena'), (e) => e instanceof ScenarioError && /not found/.test(e.message));
  assert.throws(() => loadScenario('Duel_Ladder'), (e) => e instanceof ScenarioError && /is not a scenario id/.test(e.message));
  assert.throws(() => loadScenario(''), ScenarioError);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-scen-'));
  const w = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };
  assert.throws(() => loadScenario(w('broken.json', '{ "id": ')), (e) => e instanceof ScenarioError && /invalid JSON/.test(e.message));
  const bad = base(); bad.rules.suddendeath = 0;
  assert.throws(() => loadScenario(w('duel-ladder.json', JSON.stringify(bad))), (e) => e instanceof ScenarioError && /rules\.suddendeath/.test(e.message) && e.errors.length >= 1);
  const wrongId = base(); wrongId.id = 'other';
  assert.throws(() => loadScenario(w('duel-ladder.json', JSON.stringify(wrongId))), /id "other" must equal the file name/);
  const ok = loadScenario(w('duel-ladder.json', JSON.stringify(base())));
  assert.equal(ok.id, 'duel-ladder', 'a scenario outside scenarios/ loads without the frozen-seed check');
  assert.throws(() => resolveScenarioRules(bad), (e) => e instanceof ScenarioError);
});

// ---------- seeds ----------
test('seeds: tune and board are separate, board is frozen in SEEDS-HASH.txt', () => {
  const frozen = parseSeedsHashFile(fs.readFileSync(SEEDS_HASH_FILE, 'utf8'));
  for (const sc of [duel, eco]) {
    const f = frozen.get(`${sc.id}@${sc.version}`);
    assert.ok(f, `${sc.id} v${sc.version} is frozen`);
    assert.equal(f.sha256, boardSeedsHash(sc.seeds.board));
    assert.deepEqual(f.list, sc.seeds.board);
    assert.deepEqual(verifyBoardSeeds(sc), { ok: true });
    assert.equal(sc.seeds.tune.filter((s) => sc.seeds.board.includes(s)).length, 0);
  }
  // across scenarios nothing is shared either
  const all = [duel, eco].flatMap((s) => [...s.seeds.tune, ...s.seeds.board]);
  assert.equal(new Set(all).size, all.length);
  assert.equal(duel.seeds.board.length, 8, '4 bot styles x 2 seats, one map per game');
  assert.equal(duel.seeds.tune.length, 50, 'calibration: 50 maps');
});

test('seeds: a changed board list is caught', () => {
  const changed = clone(duel); changed.seeds.board[0] += 1;
  const v = verifyBoardSeeds(changed);
  assert.equal(v.ok, false);
  assert.match(v.error, /changed: sha256 .* in the scenario, .* frozen/);
  const fresh = clone(duel); fresh.version = 2;
  assert.match(verifyBoardSeeds(fresh).error, /v2 are not frozen/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-seed-'));
  assert.match(verifyBoardSeeds(duel, { file: path.join(tmp, 'none.txt') }).error, /is missing/);
  assert.throws(() => parseSeedsHashFile('duel-ladder v1 nothex [1]'), /cannot read line/);
  // the loader refuses an official scenario whose board differs: simulate by pointing the check at a hash file for another list
  const other = path.join(tmp, 'SEEDS-HASH.txt');
  fs.writeFileSync(other, `duel-ladder v1 ${boardSeedsHash([1, 2, 3])} [1,2,3]\n`);
  assert.match(verifyBoardSeeds(duel, { file: other }).error, /changed/);
});

test('seeds: a second line for the same scenario version is refused (the freeze cannot be replaced by appending)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-seed-'));
  const orig = fs.readFileSync(SEEDS_HASH_FILE, 'utf8');
  const evil = [1, 2, 3, 4, 5, 6, 7, 8];
  const file = path.join(tmp, 'SEEDS-HASH.txt');
  fs.writeFileSync(file, `${orig}duel-ladder v1 ${boardSeedsHash(evil)} [${evil.join(',')}]\n`);
  assert.throws(() => parseSeedsHashFile(fs.readFileSync(file, 'utf8')), /"duel-ladder" v1 is listed twice/);
  // neither the real list nor the appended one passes: the check stops, it does not let the last line win
  for (const board of [duel.seeds.board, evil]) {
    const v = verifyBoardSeeds({ ...duel, seeds: { ...duel.seeds, board } }, { file });
    assert.equal(v.ok, false);
    assert.match(v.error, /listed twice/);
  }
  // a new version is a new line and is fine
  fs.writeFileSync(file, `${orig}duel-ladder v2 ${boardSeedsHash(evil)} [${evil.join(',')}]\n`);
  assert.equal(verifyBoardSeeds({ ...duel, version: 2, seeds: { ...duel.seeds, board: evil } }, { file }).ok, true);
  assert.equal(verifyBoardSeeds(duel, { file }).ok, true, 'v1 is untouched');
});

test('identity: a loaded scenario keeps its file hash; a changed copy does not pass for the file', () => {
  const a = scenarioIdentity(duel);
  assert.deepEqual(a, { hash: duel.fileHash.slice(0, 16), fromFile: true, official: true });
  // the same object after a JSON round trip of the content only (loader fields kept): still the file
  assert.equal(scenarioIdentity({ ...duel }).fromFile, true);
  // spread with another cutoff keeps the old fileHash and filePath, but is not the file
  const shorter = scenarioIdentity({ ...duel, maxGameSeconds: 60 });
  assert.equal(shorter.fromFile, false);
  assert.notEqual(shorter.hash, a.hash);
  // another board list under the same id and version
  const other = scenarioIdentity({ ...duel, seeds: { ...duel.seeds, board: [1, 2, 3, 4, 5, 6, 7, 8] } });
  assert.equal(other.fromFile, false);
  assert.notEqual(other.hash, shorter.hash);
  // the same file somewhere else is the file, but not the official one
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-ident-')), elsewhere = path.join(dir, 'duel-ladder.json');
  fs.copyFileSync(duel.filePath, elsewhere);
  const there = scenarioIdentity(loadScenario(elsewhere));
  assert.deepEqual([there.fromFile, there.official, there.hash], [true, false, a.hash]);
  // a plain object without a file: a content hash, never "from file"
  const plain = scenarioIdentity(base());
  assert.equal(plain.fromFile, false);
  assert.match(plain.hash, /^[0-9a-f]{16}$/);
  assert.equal(plain.hash, scenarioIdentity(base()).hash, 'stable');
  assert.equal(seedsHash(duel.seeds.board), boardSeedsHash(duel.seeds.board));
});

test('seeds: derived by a public rule, not picked; every map is valid and mirrored under the scenario rules', () => {
  const want = deriveAll();
  for (const sc of [duel, eco]) {
    assert.deepEqual(sc.seeds.board, want[sc.id].board, `${sc.id} board = derivation`);
    assert.deepEqual(sc.seeds.tune, want[sc.id].tune, `${sc.id} tune = derivation`);
    const r = resolveScenarioRules(sc);
    for (const seed of [...sc.seeds.tune, ...sc.seeds.board]) {
      const m = generateMap(seed, { players: 2, size: r.mapSize, treasure: r.treasure, mapType: r.mapType, shrines: r.shrines });
      const c = checkMap(m);
      assert.ok(c.ok && c.fairness.level === 'perfect', `${sc.id} seed ${seed}: ${c.errors.join('; ')} ${c.fairness.level}`);
      assert.ok(mapIsGood(seed, r));
    }
  }
  assert.deepEqual(SEED_PLAN.map((p) => `${p.scenario}/${p.list}/${p.n}`), ['duel-ladder/board/8', 'eco-sprint/board/4', 'duel-ladder/tune/50', 'eco-sprint/tune/8']);
});
