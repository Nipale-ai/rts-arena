// Sim versioning: every state of sim/ that ever produced a replay is kept as an immutable snapshot, and every replay
// is re-simulated with the snapshot it was recorded with. See sim-versions/README.md.
//
//   sim version id  = "sim-" + first 12 hex of sha256 over all files of the sim directory (sorted relative paths + bytes).
//                     The rules presets live in sim/rules.mjs and sim/data.mjs, so they are part of the hash.
//   snapshot        = sim-versions/<id>/sim/*.mjs (the exact files) + meta.json + golden/<name>/log.jsonl
//   current sim     = ../sim (loaded directly while its hash equals the id)
//
// This file is deliberately outside sim/, so the sim itself needs no change for versioning.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAP_ROOT = path.join(ROOT, 'sim-versions');
export const CURRENT_DIR = path.join(ROOT, 'sim');
const require = createRequire(import.meta.url);
const ID_RE = /^sim-[0-9a-f]{12}$/;
export const isSimVersion = (s) => typeof s === 'string' && ID_RE.test(s);

function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (/\.(mjs|js|json)$/.test(e.name)) out.push(r);
  }
  return out.sort();
}

// content hash of a sim directory (line endings are normalised so a checkout with CRLF gives the same id)
export function hashSimDir(dir) {
  const h = crypto.createHash('sha256');
  for (const f of listFiles(dir)) {
    h.update(`\n--- ${f} ---\n`);
    h.update(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
  }
  return 'sim-' + h.digest('hex').slice(0, 12);
}

let currentId = null;
export function currentSimVersion({ fresh = false } = {}) {
  if (fresh || !currentId) currentId = hashSimDir(CURRENT_DIR);
  return currentId;
}

export const snapshotDir = (id) => path.join(SNAP_ROOT, id);
export function listSnapshots() {
  if (!fs.existsSync(SNAP_ROOT)) return [];
  return fs.readdirSync(SNAP_ROOT).filter((d) => ID_RE.test(d) && fs.existsSync(path.join(SNAP_ROOT, d, 'meta.json')))
    .map((id) => ({ id, ...JSON.parse(fs.readFileSync(path.join(SNAP_ROOT, id, 'meta.json'), 'utf8')) }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id));
}

// import a sim directory synchronously (Node >= 22.12 require(esm)); modules inside a snapshot import each other with './x.mjs'
const optional = (dir, f) => (fs.existsSync(path.join(dir, f)) ? require(path.join(dir, f)) : null);
const cache = new Map();

// The bundle is the one interface consumers use. Adapter: modules that did not exist in older versions
// (intent view, standing orders, rule presets) get neutral stand-ins, so renderers and tools can call them blindly.
export function bundleOf(dir, id) {
  const game = require(path.join(dir, 'game.mjs')), data = require(path.join(dir, 'data.mjs')), util = require(path.join(dir, 'util.mjs'));
  const obs = optional(dir, 'observe.mjs'), intent = optional(dir, 'intent.mjs'), standing = optional(dir, 'standing.mjs'), rules = optional(dir, 'rules.mjs');
  return {
    id, dir, current: dir === CURRENT_DIR,
    Game: game.Game,
    observe: obs?.observe, catalog: obs?.catalog,
    UNITS: data.UNITS, BUILDINGS: data.BUILDINGS, RESOURCES: data.RESOURCES || ['food', 'wood', 'stone', 'gold'], TECHS: data.TECHS || {},
    TICK_HZ: util.TICK_HZ ?? 10,
    resolveRules: rules?.resolveRules || ((r) => r),
    PRESETS: rules?.PRESETS || {},
    feedOf: intent?.feedOf || (() => []),
    markersOf: intent?.markersOf || (() => []),
    standingChips: standing?.standingChips || (() => []),
  };
}

// load the sim of a version id; the snapshot files are checked against the id first
export function loadSim(id = currentSimVersion()) {
  if (cache.has(id)) return cache.get(id);
  let b;
  if (id === currentSimVersion()) b = bundleOf(CURRENT_DIR, id);
  else {
    if (!isSimVersion(id)) throw new Error(`not a sim version id: ${id}`);
    const dir = path.join(snapshotDir(id), 'sim');
    if (!fs.existsSync(dir)) throw new Error(`sim version ${id} is not frozen here (no ${path.relative(ROOT, dir)}); current is ${currentSimVersion()}. Frozen: ${listSnapshots().map((s) => s.id).join(', ') || 'none'}`);
    const got = hashSimDir(dir);
    if (got !== id) throw new Error(`snapshot ${id} was modified (its files hash to ${got}); snapshots are immutable`);
    b = bundleOf(dir, id);
  }
  cache.set(id, b);
  return b;
}

// ---- replays ----
export const STAMP_FILE = 'sim-version.json';
export function readJsonl(f) { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
export function startLineOf(logFile) {
  const first = fs.readFileSync(logFile, 'utf8').split('\n', 1)[0];
  const s = JSON.parse(first);
  return s.type === 'start' ? s : readJsonl(logFile).find((l) => l.type === 'start');
}

// the stamped version of a replay: start line first, then the sidecar written by the backfill; null when unstamped
export function stampedVersion(dirOrFile, start) {
  if (start?.sim_version) return start.sim_version;
  const dir = fs.statSync(dirOrFile).isDirectory() ? dirOrFile : path.dirname(dirOrFile);
  const side = path.join(dir, STAMP_FILE);
  if (fs.existsSync(side)) { try { return JSON.parse(fs.readFileSync(side, 'utf8')).sim_version || null; } catch { return null; } }
  return null;
}

// Sim for a replay. Unstamped replays (recorded before the mechanism) are matched by trial once (tools/sim-backfill.mjs
// does that for a whole folder); the loader itself never guesses silently: it throws, naming the tool.
// opts.lenient (viewers and render tools): an unstamped replay that could not be matched (recorded from an uncommitted
// working tree) still opens with the current sim and a warning, so it stays watchable; it will not be bit-exact.
export function simForReplay(dirOrFile, start, opts = {}) {
  const dir = path.resolve(dirOrFile);
  const id = stampedVersion(dir, start);
  if (!id && opts.lenient) { console.error(`WARNING: ${dir} has no sim version stamp; using the current sim, the playback may drift from the recording`); return { ...loadSim(), unstamped: true }; }
  if (!id) throw new Error(`replay ${dir} has no sim version stamp; run: node tools/sim-backfill.mjs --replays <folder>`);
  return loadSim(id);
}

// ---- golden replays: a scripted match recorded with a given sim, verified again by the same sim ----
// Adapter for the tools that read a Game: fields that older versions do not have get neutral defaults
// (they are plain extra properties and never enter the state hash).
export function adaptGame(g) {
  if (!Array.isArray(g.godFeed)) g.godFeed = [];
  if (!g.proj) g.proj = [];
  if (!Array.isArray(g.fish)) g.fish = []; // sims before the coast / living world have no fish
  if (!g.wx) g.wx = { over: false };
  if (!Array.isArray(g.chatLog)) g.chatLog = [];
  if (!Array.isArray(g.worldLog)) g.worldLog = []; // sims before the living world have no world log
  return g;
}

export function newGameOf(sim, start) {
  return adaptGame(new sim.Game({ seed: start.seed, players: start.bots.map((b, i) => ({ team: start.teams ? start.teams[i] : i + 1, name: b })), numPlayers: start.bots.length === 4 ? 4 : 2, rules: start.rules, ...(start.map_data ? { map: start.map_data } : {}) }));
}

// Re-simulates log lines with `sim` and compares every state hash (and the result hash).
export function verifyLines(sim, lines, { stopAtMismatch = false } = {}) {
  const start = lines.find((l) => l.type === 'start');
  const states = lines.filter((l) => l.type === 'state'), result = lines.find((l) => l.type === 'result');
  const cmds = lines.filter((l) => l.type === 'cmd');
  const g = newGameOf(sim, start);
  const stateAt = new Map(states.map((s) => [s.t, s.hash]));
  const lastT = states.length ? Math.max(...states.map((s) => s.t)) : 0;
  const endT = cmds.length ? Math.max(lastT, cmds[cmds.length - 1].t) : lastT;
  let i = 0, firstBad = null, checked = 0;
  while (!g.over) {
    while (i < cmds.length && cmds[i].t === g.t) { g.command(cmds[i].p, cmds[i].cmd); i++; }
    if (g.t > endT + 20 && !result) break;
    if (result && g.t >= (result.tick ?? Infinity)) break;
    g.step();
    if (stateAt.has(g.t)) { checked++; if (g.hash() !== stateAt.get(g.t) && firstBad === null) { firstBad = g.t; if (stopAtMismatch) break; } }
  }
  return { game: g, firstBad, checked, commands: cmds.length, result };
}

// Records a scripted-bot match on a snapshot (its own Game and observe; the bots are the current ones). Commands the old
// sim rejects are logged anyway: a replay only needs the same inputs, not valid play.
export function recordGolden(sim, createBot, { bots = ['rush', 'boom'], seed = 3, preset = null, maxTicks = 4000 } = {}) {
  const rl = preset ? sim.resolveRules(preset) : undefined;
  const players = bots.map((b, i) => ({ team: i + 1, name: b }));
  const g = new sim.Game({ seed, players, numPlayers: 2, rules: rl });
  const ais = bots.map((b) => createBot(b));
  const lines = [{ type: 'start', seed, bots, teams: players.map((p) => p.team), map: g.mapName, ...(rl ? { rules: rl } : {}), sim_version: sim.id }];
  const last = bots.map(() => -1);
  while (!g.over && g.t < maxTicks) {
    if (g.t % 20 === 0) {
      const plans = [];
      bots.forEach((_, i) => {
        const pid = i + 1;
        if (!g.players[pid].alive) return;
        const o = JSON.parse(JSON.stringify(sim.observe(g, pid, { sinceTick: last[i] })));
        last[i] = g.t;
        let cmds = [];
        try { cmds = ais[i].think(o); } catch { cmds = []; } // a current bot may not understand an old observation
        plans.push({ i, pid, cmds });
      });
      const rot = g.firstPlayer ? g.firstPlayer(g.t) : 0;
      plans.sort((a, b) => ((a.i + bots.length - rot) % bots.length) - ((b.i + bots.length - rot) % bots.length));
      for (const { pid, cmds } of plans) for (const c of cmds) { const r = g.command(pid, c); lines.push({ type: 'cmd', t: g.t, p: pid, cmd: c, ok: r.ok }); }
    }
    g.step();
    if (g.t % 100 === 0) lines.push({ type: 'state', t: g.t, hash: g.hash() });
  }
  lines.push({ type: 'result', ...g.result(), tick: g.t });
  return lines;
}

// Called by every recorder before it stamps a new replay: when sim/ changed since the last freeze (a working tree that is
// being tested), the files are copied now, so the replay never points at a version that no longer exists. Golden replays
// are added later by tools/sim-freeze.mjs (tests and tools/sim-check.mjs insist on them).
export function ensureFrozen() {
  const id = currentSimVersion({ fresh: true });
  const dst = snapshotDir(id);
  if (fs.existsSync(path.join(dst, 'meta.json'))) return id;
  fs.mkdirSync(path.join(dst, 'sim'), { recursive: true });
  for (const f of fs.readdirSync(CURRENT_DIR)) if (/\.(mjs|js|json)$/.test(f)) fs.copyFileSync(path.join(CURRENT_DIR, f), path.join(dst, 'sim', f));
  fs.writeFileSync(path.join(dst, 'meta.json'), JSON.stringify({ id, date: new Date().toISOString(), commits: [], golden: [], note: 'auto-frozen by a recorder; run node tools/sim-freeze.mjs to add the golden replays' }, null, 1) + '\n');
  return id;
}
