// Solo-mode scenarios: a JSON file in scenarios/ says which rules a model plays under, how the run ends and how it is judged.
//
//   loadScenario(idOrPath)        read + validate (throws ScenarioError with every problem); checks the frozen board seeds
//   validateScenario(obj)         -> { ok, errors[], warnings[] } (never throws; same shape as sim/mapcheck.mjs checkMap)
//   resolveScenarioRules(sc)      -> the complete rules object for LiveMatch opts.rules (server/live-match.mjs:44); throws if invalid
//
// Scenario file (all keys required except notes):
//   id, name, version (int; a changed rule or seed list is a new version), goal "destroy" | "eco", preset "fast" | "war" | "classic",
//   rules {overrides of the preset, only keys the sim really reads, see RULE_KEYS}, mapSize 96 | 128,
//   maxGameSeconds (the cutoff: LiveMatch stops here with reason "cutoff" and no winner; it must be below the sim time limit, so the
//   sim never crowns a score or seed winner), speed (game seconds per wall second), levels [min, max] (bot levels, inclusive),
//   seeds {tune: [...], board: [...]} (disjoint; board frozen in scenarios/SEEDS-HASH.txt), modelSeats [1, 2],
//   judge {kind: "destroy" | "eco", tierTarget?: 2 | 3 (eco)}, notes.
// The loader adds fileHash / filePath (see LOADER_FIELDS); validateScenario accepts and ignores them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRules, PRESETS } from '../../sim/rules.mjs';
import { UNITS, BUILDINGS, RESOURCES, GATHER, TIME_LIMIT_S, POP_MAX } from '../../sim/data.mjs';
import { MAP_TYPES, WEATHER_KINDS } from '../../sim/world-data.mjs';
import { stableStringify, sha256, shortHash } from './meta.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCENARIO_DIR = path.join(ROOT, 'scenarios');
export const SEEDS_HASH_FILE = path.join(SCENARIO_DIR, 'SEEDS-HASH.txt');

export class ScenarioError extends Error {
  constructor(message, errors = []) { super(message); this.name = 'ScenarioError'; this.errors = errors; }
}

export const TOP_KEYS = ['id', 'name', 'version', 'goal', 'preset', 'rules', 'mapSize', 'maxGameSeconds', 'speed', 'levels', 'seeds', 'modelSeats', 'judge', 'notes'];
const REQUIRED = TOP_KEYS.filter((k) => k !== 'notes');
export const LOADER_FIELDS = ['fileHash', 'filePath'];
export const GOALS = ['destroy', 'eco'];
export const SCENARIO_PRESETS = ['fast', 'war', 'classic']; // fast-v0 only exists to measure the tower rework
const MAX_LEVEL = 4;
const SEED_MAX = 2 ** 31 - 1; // server/arena.mjs createMatch: num(body.seed, 0, 2 ** 31 - 1)

// ---------- rule override keys ----------
// Every key here is read by the sim (evidence = where) and survives resolveRules() unchanged for a valid value. Keys the arena API
// can pass today: only preset, mapSize, timeLimitS, mapType, weather, caravans (server/arena.mjs:190-196). Everything else reaches the
// sim only through LiveMatch opts.rules, which is what a scenario does.
const isBool = (v) => typeof v === 'boolean';
const isInt = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const oneOf = (list) => (v) => list.includes(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const objOf = (okKey, okVal) => (v) => isObj(v) && Object.entries(v).every(([k, x]) => okKey(k) && okVal(x));
// own keys only: "toString" or "constructor" are no ids of the database (a plain lookup would find them on Object.prototype)
const has = (table, key) => Object.hasOwn(table, key);
const modOf = (table) => (v) => isObj(v) && Object.entries(v).every(([id, m]) => has(table, id) && isObj(m) && Object.keys(m).every((k) => has(table[id], k) || k === 'cost' || k === 'armour'));
const listOf = (okItem, max) => (v) => Array.isArray(v) && v.length <= max && v.every(okItem);

export const RULE_KEYS = {
  timeLimitS:     { ok: isInt(60, TIME_LIMIT_S), hint: 'int 60..3600', where: 'sim/game.mjs:838 (time limit), sim/rules.mjs resolveRules clamps' },
  suddenDeath:    { ok: isInt(0, TIME_LIMIT_S), hint: 'int seconds, 0 = off', where: 'sim/game.mjs:670 suddenDeathStep, sim/commands.mjs:363' },
  tieBreak:       { ok: oneOf(['seed', 'none']), hint: '"seed" | "none"', where: 'sim/game.mjs:830, :849 (only "seed" acts: it crowns a winner)' },
  noScoreWin:     { ok: isBool, hint: 'boolean', where: 'sim/game.mjs:848 (time limit ends without a winner)' },
  wonder:         { ok: isBool, hint: 'boolean (needs content 2)', where: 'sim/victory.mjs, sim/game.mjs:713, sim/commands.mjs:362' },
  wonderSecs:     { ok: isInt(30, 1800), hint: 'int 30..1800', where: 'sim/victory.mjs:52' },
  shrines:        { ok: isBool, hint: 'boolean (needs content 2)', where: 'sim/game.mjs:39 (map), sim/victory.mjs:27' },
  shrineTarget:   { ok: isInt(30, 20000), hint: 'int 30..20000', where: 'sim/victory.mjs' },
  content:        { ok: oneOf([1, 2]), hint: '1 | 2 (1 switches wonder and shrines off)', where: 'sim/rules.mjs resolveRules (gates wonder, shrines)' },
  startWorkers:   { ok: isInt(1, 12), hint: 'int 1..12', where: 'sim/game.mjs:164, :169' },
  startResources: { ok: objOf((k) => RESOURCES.includes(k), isInt(0, 100000)), hint: `{${RESOURCES.join('|')}: int}`, where: 'sim/game.mjs:115 (added to the base start)' },
  startUnits:     { ok: listOf((u) => isObj(u) && Object.keys(u).every((k) => k === 'type' || k === 'n') && has(UNITS, u.type) && isInt(1, 20)(u.n), 12), hint: '[{type: unit id, n: 1..20}]', where: 'sim/game.mjs:170' },
  startHouse:     { ok: isBool, hint: 'boolean', where: 'sim/game.mjs:134' },
  treasure:       { ok: (v) => v === null || (isObj(v) && Object.keys(v).every((k) => k === 'gold' || k === 'stone') && isInt(0, 20000)(v.gold) && isInt(0, 20000)(v.stone)), hint: 'null | {gold, stone}', where: 'sim/game.mjs:480, sim/mapgen.mjs:119' },
  gatherPct:      { ok: objOf((k) => has(GATHER.rate, k), isInt(-90, 1000)), hint: `{${Object.keys(GATHER.rate).join('|')}: percent}`, where: 'sim/data.mjs:280 mergedFaction' },
  buildingMods:   { ok: modOf(BUILDINGS), hint: '{building id: partial building entry}', where: 'sim/data.mjs:276-278 mergedFaction' },
  unitMods:       { ok: modOf(UNITS), hint: '{unit id: partial unit entry}', where: 'sim/data.mjs:272-274 mergedFaction' },
  towerCaps:      { ok: (v) => v === null || (listOf(isInt(0, 30), 3)(v) && v.length > 0), hint: 'null | [tier1, tier2, tier3]', where: 'sim/commands.mjs:410' },
  towerSpacing:   { ok: isInt(0, 30), hint: 'int tiles', where: 'sim/commands.mjs:416' },
  separation:     { ok: isBool, hint: 'boolean', where: 'sim/logic.mjs:192' },
  popMax:         { ok: isInt(POP_MAX, 400), hint: `int ${POP_MAX}..400`, where: 'sim/game.mjs:548, sim/standing.mjs:171' },
  warAtS:         { ok: isInt(0, TIME_LIMIT_S), hint: 'int seconds, 0 = off', where: 'sim/game.mjs:686' },
  warTopUp:       { ok: isInt(0, 100000), hint: 'int per resource', where: 'sim/game.mjs:692' },
  mapType:        { ok: oneOf(MAP_TYPES), hint: MAP_TYPES.join(' | '), where: 'sim/world.mjs:66, sim/mapgen.mjs' },
  weather:        { ok: oneOf(['off', 'auto', ...WEATHER_KINDS]), hint: ['off', 'auto', ...WEATHER_KINDS].join(' | '), where: 'sim/world.mjs:69' },
  caravans:       { ok: isBool, hint: 'boolean', where: 'sim/world.mjs:81' },
};
// keys that exist in the presets but are not an override of a scenario
const RULE_KEY_REFUSED = {
  preset: 'set the top level key "preset" instead',
  mapSize: 'set the top level key "mapSize" instead',
  worldRev: 'has no effect: resolveRules() forces it to 1 (sim/rules.mjs)',
};

// ---------- helpers ----------
// one stable JSON text for hashes and comparisons: tools/solo/meta.mjs (sorted keys, undefined dropped)
export const canonical = stableStringify;
export const hashRules = (rules) => shortHash(rules); // "Hash der aufgeloesten rules" in the key of a solo cell
export const seedsHash = (list) => sha256(JSON.stringify(list)); // hash of a seed list: part of the cell key
export const boardSeedsHash = seedsHash;
const same = (a, b) => canonical(a) === canonical(b);

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function didYouMean(key, known) {
  const best = known.map((k) => [k, lev(key.toLowerCase(), k.toLowerCase())]).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? ` (did you mean "${best[0]}"?)` : '';
}

// The spec handed to resolveRules(). content and worldRev are passed on purpose: resolveRules() reads a spec that has mapSize but no
// content as the "fully resolved rules of an older build" (content 1, wonder and shrines only as given), and a spec that has startUnits
// and separation but no worldRev as a pre-world replay (meadow, no weather, no caravans). A scenario is neither of them.
export function ruleInput(scenario) {
  return { preset: scenario.preset, content: PRESETS[scenario.preset]?.content, worldRev: 1, mapSize: scenario.mapSize, ...scenario.rules };
}

// ---------- validation ----------
export function validateScenario(obj) {
  const errors = [], warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  if (!isObj(obj)) return { ok: false, errors: ['scenario: must be a JSON object'], warnings };

  for (const k of Object.keys(obj)) if (!TOP_KEYS.includes(k) && !LOADER_FIELDS.includes(k)) err(k, `unknown key${didYouMean(k, TOP_KEYS)}; allowed: ${TOP_KEYS.join(', ')}`);
  for (const k of REQUIRED) if (obj[k] === undefined) err(k, 'missing');

  if (obj.id !== undefined && !(typeof obj.id === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(obj.id))) err('id', 'lowercase letters, digits and "-" only (2..41 characters)');
  if (obj.name !== undefined && !(typeof obj.name === 'string' && obj.name.trim() && obj.name.length <= 60)) err('name', 'non-empty text, at most 60 characters');
  if (obj.version !== undefined && !isInt(1, 1000)(obj.version)) err('version', 'positive integer');
  if (obj.goal !== undefined && !GOALS.includes(obj.goal)) err('goal', `must be one of ${GOALS.join(', ')}`);
  if (obj.preset !== undefined && !SCENARIO_PRESETS.includes(obj.preset)) err('preset', `must be one of ${SCENARIO_PRESETS.join(', ')}`);
  if (obj.mapSize !== undefined && ![96, 128].includes(obj.mapSize)) err('mapSize', 'must be 96 or 128 (sim/rules.mjs would silently use the preset size otherwise)');
  if (obj.maxGameSeconds !== undefined && !isInt(60, TIME_LIMIT_S)(obj.maxGameSeconds)) err('maxGameSeconds', 'integer 60..3600');
  if (obj.speed !== undefined && !(typeof obj.speed === 'number' && obj.speed >= 0.25 && obj.speed <= 64)) err('speed', 'number 0.25..64 (server/arena.mjs range)');
  if (obj.notes !== undefined && typeof obj.notes !== 'string') err('notes', 'must be text');

  // levels [min, max]
  if (obj.levels !== undefined) {
    const l = obj.levels;
    if (!(Array.isArray(l) && l.length === 2 && l.every(isInt(0, MAX_LEVEL)) && l[0] <= l[1])) err('levels', `[min, max], integers 0..${MAX_LEVEL}, min <= max`);
  }
  // seats (2 player scenarios only until the 4 player seat bias is measured)
  if (obj.modelSeats !== undefined) {
    const s = obj.modelSeats;
    if (!(Array.isArray(s) && s.length >= 1 && s.every((x) => x === 1 || x === 2) && new Set(s).size === s.length)) err('modelSeats', 'non-empty list of distinct seats from [1, 2]');
  }
  // seeds
  if (obj.seeds !== undefined) {
    const sd = obj.seeds;
    if (!isObj(sd)) err('seeds', 'must be {tune: [...], board: [...]}');
    else {
      for (const k of Object.keys(sd)) if (k !== 'tune' && k !== 'board') err(`seeds.${k}`, 'unknown list (tune and board only)');
      for (const k of ['tune', 'board']) {
        const a = sd[k];
        if (!(Array.isArray(a) && a.length > 0 && a.every(isInt(0, SEED_MAX)))) err(`seeds.${k}`, `non-empty list of integers 0..${SEED_MAX}`);
        else if (new Set(a).size !== a.length) err(`seeds.${k}`, 'duplicate seeds');
      }
      if (Array.isArray(sd.tune) && Array.isArray(sd.board)) {
        const both = sd.board.filter((s) => sd.tune.includes(s));
        if (both.length) err('seeds', `tune and board must not share a seed (shared: ${both.join(', ')})`);
      }
    }
  }
  // judge
  if (obj.judge !== undefined) {
    const j = obj.judge;
    if (!isObj(j)) err('judge', 'must be an object');
    else {
      for (const k of Object.keys(j)) if (k !== 'kind' && k !== 'tierTarget') err(`judge.${k}`, 'unknown key (kind, tierTarget)');
      if (!GOALS.includes(j.kind)) err('judge.kind', `must be one of ${GOALS.join(', ')}`);
      else if (obj.goal && GOALS.includes(obj.goal) && j.kind !== obj.goal) err('judge.kind', `"${j.kind}" does not fit goal "${obj.goal}"`);
      if (j.kind === 'eco' && ![2, 3].includes(j.tierTarget)) err('judge.tierTarget', 'eco needs tierTarget 2 or 3');
      if (j.kind !== 'eco' && j.tierTarget !== undefined) err('judge.tierTarget', 'only for kind "eco"');
    }
  }

  // rules: only keys the sim reads, valid values
  let rulesOk = false;
  if (obj.rules !== undefined) {
    if (!isObj(obj.rules)) err('rules', 'must be an object');
    else {
      rulesOk = true;
      for (const [k, v] of Object.entries(obj.rules)) {
        if (has(RULE_KEY_REFUSED, k)) { err(`rules.${k}`, RULE_KEY_REFUSED[k]); rulesOk = false; }
        else if (!has(RULE_KEYS, k)) { err(`rules.${k}`, `unknown rule key${didYouMean(k, Object.keys(RULE_KEYS))}; the sim reads: ${Object.keys(RULE_KEYS).join(', ')}`); rulesOk = false; }
        else if (!RULE_KEYS[k].ok(v)) { err(`rules.${k}`, `invalid value ${JSON.stringify(v)}; expected ${RULE_KEYS[k].hint}`); rulesOk = false; }
      }
    }
  }

  // resolve with the sim and compare: resolveRules() clamps and gates silently, a scenario must not
  if (rulesOk && SCENARIO_PRESETS.includes(obj.preset) && [96, 128].includes(obj.mapSize)) {
    const resolved = resolveRules(ruleInput(obj));
    for (const [k, v] of Object.entries(obj.rules)) {
      const got = k === 'startResources' ? Object.fromEntries(Object.keys(v).map((r) => [r, resolved[k][r]])) : resolved[k];
      if (!same(got, v)) err(`rules.${k}`, `the sim does not keep ${JSON.stringify(v)}: it resolves to ${JSON.stringify(got)}`);
    }
    // the cutoff must come first
    if (isInt(60, TIME_LIMIT_S)(obj.maxGameSeconds) && obj.maxGameSeconds >= resolved.timeLimitS) err('maxGameSeconds', `${obj.maxGameSeconds} s is not below the sim time limit of ${resolved.timeLimitS} s; the sim would end the game first and crown a score or seed winner (set it lower or raise rules.timeLimitS)`);
    // goal specific rules
    if (obj.goal === 'destroy') {
      if (resolved.suddenDeath) err('rules.suddenDeath', 'goal "destroy" needs sudden death off (0): a base that crumbles is no destruction win');
      if (resolved.wonder) err('rules.wonder', 'goal "destroy" needs the wonder off (false)');
      if (resolved.shrines) err('rules.shrines', 'goal "destroy" needs the shrines off (false)');
      if (resolved.warAtS && resolved.warAtS < obj.maxGameSeconds) warnings.push(`rules.warAtS: both sides are topped up from ${resolved.warAtS} s; worker caps and economy of the bot levels stop mattering (plan A3)`);
    }
    if (obj.goal === 'eco') {
      if (resolved.wonder) err('rules.wonder', 'goal "eco" needs the wonder off (false)');
      if (resolved.shrines) err('rules.shrines', 'goal "eco" needs the shrines off (false)');
      if (resolved.suddenDeath && resolved.suddenDeath < obj.maxGameSeconds) err('rules.suddenDeath', `sudden death from ${resolved.suddenDeath} s would break buildings inside the measured ${obj.maxGameSeconds} s`);
      if (resolved.warAtS && resolved.warAtS < obj.maxGameSeconds) err('rules.warAtS', `both sides are topped up from ${resolved.warAtS} s; gathered amounts would be meaningless`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

function assertValid(obj, label = 'scenario') {
  const v = validateScenario(obj);
  if (!v.ok) throw new ScenarioError(`${label} is invalid:\n  ${v.errors.join('\n  ')}`, v.errors);
  return v;
}

// -> the complete rules object LiveMatch gets as opts.rules (it passes it through resolveRules() once more; that is stable)
export function resolveScenarioRules(scenario) {
  assertValid(scenario, `scenario "${scenario?.id}"`);
  return resolveRules(ruleInput(scenario));
}

// ---------- frozen board seeds ----------
// scenarios/SEEDS-HASH.txt: one line per scenario version: "<id> v<version> <sha256 of JSON.stringify(board)> <board as JSON>". Append only.
export function parseSeedsHashFile(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-z0-9-]+)\s+v(\d+)\s+([0-9a-f]{64})\s+(\[[\d,\s]*\])$/);
    if (!m) throw new ScenarioError(`${path.basename(SEEDS_HASH_FILE)}: cannot read line "${line.slice(0, 80)}"`);
    // one line per scenario version: a second line would silently replace the frozen list ("append only" means new versions only)
    if (out.has(`${m[1]}@${m[2]}`)) throw new ScenarioError(`${path.basename(SEEDS_HASH_FILE)}: "${m[1]}" v${m[2]} is listed twice. A frozen list is never replaced; a new list is a new scenario version.`);
    out.set(`${m[1]}@${m[2]}`, { sha256: m[3], list: JSON.parse(m[4]) });
  }
  return out;
}

export function verifyBoardSeeds(scenario, { file = SEEDS_HASH_FILE } = {}) {
  if (!fs.existsSync(file)) return { ok: false, error: `${file} is missing: the board seeds are not frozen` };
  let table;
  try { table = parseSeedsHashFile(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, error: e.message }; }
  const frozen = table.get(`${scenario.id}@${scenario.version}`);
  if (!frozen) return { ok: false, error: `board seeds of "${scenario.id}" v${scenario.version} are not frozen in ${path.basename(file)} (add a line, never edit one)` };
  const got = boardSeedsHash(scenario.seeds.board);
  if (got !== frozen.sha256) return { ok: false, error: `board seeds of "${scenario.id}" v${scenario.version} changed: sha256 ${got.slice(0, 12)} in the scenario, ${frozen.sha256.slice(0, 12)} frozen. Board seeds are never changed after the freeze; a new list is a new scenario version.` };
  if (!same(frozen.list, scenario.seeds.board)) return { ok: false, error: `${path.basename(file)} lists a different board for "${scenario.id}" v${scenario.version} than the hash covers` };
  return { ok: true };
}

// ---------- identity of a scenario object ----------
// -> { hash, fromFile, official }
//   hash      the file hash (16 hex) if the object is exactly what loadScenario read from a file, else a hash of the content
//   fromFile  true only for an unchanged loaded scenario. An object made with { ...loaded, maxGameSeconds: 60 } still carries the old
//             fileHash; it must not pass for the file.
//   official  fromFile and the file lies in scenarios/ (a probe file elsewhere with the same id and board list is no official scenario)
export function scenarioIdentity(scenario) {
  const { fileHash, filePath, ...content } = scenario || {};
  if (fileHash && filePath && fs.existsSync(filePath)) {
    try {
      const bytes = fs.readFileSync(filePath);
      if (sha256(bytes) === fileHash && same(JSON.parse(bytes.toString('utf8')), content)) return { hash: fileHash.slice(0, 16), fromFile: true, official: path.dirname(path.resolve(filePath)) === SCENARIO_DIR };
    } catch { /* unreadable: treated as changed */ }
  }
  return { hash: shortHash(content), fromFile: false, official: false };
}

// ---------- loading ----------
export function listScenarioIds(dir = SCENARIO_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadScenario(idOrPath) {
  const arg = String(idOrPath ?? '');
  if (!arg) throw new ScenarioError('loadScenario: needs a scenario id or a file path');
  const isPath = arg.includes('/') || arg.includes(path.sep) || arg.endsWith('.json');
  if (!isPath && !/^[a-z0-9][a-z0-9-]*$/.test(arg)) throw new ScenarioError(`"${arg}" is not a scenario id (lowercase letters, digits, "-")`);
  const file = isPath ? path.resolve(arg) : path.join(SCENARIO_DIR, `${arg}.json`);
  if (!fs.existsSync(file)) throw new ScenarioError(`scenario not found: ${isPath ? file : `"${arg}" (have: ${listScenarioIds().join(', ') || 'none'})`}`);
  const bytes = fs.readFileSync(file);
  let obj;
  try { obj = JSON.parse(bytes.toString('utf8')); } catch (e) { throw new ScenarioError(`${file}: invalid JSON (${e.message})`); }
  assertValid(obj, path.basename(file));
  if (obj.id !== path.basename(file, '.json')) throw new ScenarioError(`${path.basename(file)}: id "${obj.id}" must equal the file name`);
  if (path.dirname(file) === SCENARIO_DIR) {
    const v = verifyBoardSeeds(obj);
    if (!v.ok) throw new ScenarioError(v.error);
  }
  return { ...obj, fileHash: sha256(bytes), filePath: file };
}
