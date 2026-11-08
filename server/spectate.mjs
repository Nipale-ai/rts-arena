#!/usr/bin/env node
// Spectator server: runs a real-time match between scripted bots (or replays a command log) and streams
// the state to the browser over Server-Sent Events. No dependencies beyond Node 22. Binds to 127.0.0.1 only.
//
//   node server/spectate.mjs --p1 rush --p2 boom --seed 42 [--speed 1] [--port 0] [--ff 300]
//        [--p1-model "label"] [--p1-hw "label"] [--p2-model ..] [--p2-hw ..] [--no-record]
//        [--theme dustmoon-v1]   (the words the server writes, such as the thought line of a bot, speak that theme; open the page as /?theme=dustmoon-v1 for the picture)
//   node server/spectate.mjs --replay replays/<id>        (a dir with log.jsonl, or a .jsonl log file)
//
// The sim, the bots and tools/ are only imported, never modified.
import './local-env.mjs'; // RTS_* defaults from local-env.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../sim/game.mjs';
import { observe } from '../sim/observe.mjs';
import { createBot, BOT_NAMES } from '../agents/scripted/index.mjs';
import { UNITS, BUILDINGS, RESOURCES } from '../sim/data.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { WILD_UNITS } from '../sim/world-data.mjs';
import { Pacer, driftTimer } from './clock.mjs';
import { feedOf, markersOf } from '../sim/intent.mjs';
import { standingChips } from '../sim/standing.mjs';
import { loadSim, ensureFrozen, simForReplay, newGameOf } from '../sim-versions/lib.mjs';
import { THINK_TICKS } from '../tools/run-match.mjs';
import { guardDirector, cleanDirector, injectToken } from './god.mjs';
import { displayName } from '../render/theme/display-name.mjs';
import { resolveThemeArg, applyThemeArg } from '../tools/lib/theme-arg.mjs'; // --theme

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');

// ---------------- args ----------------
export const args = {};
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const nx = process.argv[i + 1];
  if (nx === undefined || nx.startsWith('--')) args[k] = true;
  else { args[k] = nx; i++; }
}
const SEED_DEFAULT = 42;
const SAY_FRESH_S = 6; // chat lines older than this (game seconds) are not handed out with the first snapshot of a viewer

// ---------------- match sources ----------------
// creator banners (configs/creators.json); the page and the broadcast only get the ones that play
let CREATORS = null;
function creatorRegistry() {
  if (!CREATORS) {
    try { CREATORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'configs', 'creators.json'), 'utf8')).creators || {}; } catch { CREATORS = {}; }
  }
  return CREATORS;
}
const COLORS = /^(#[0-9a-f]{6},){3}#[0-9a-f]{6}$/i.test(process.env.RTS_COLORS || '') ? process.env.RTS_COLORS.split(',') : ['#4d8dff', '#ff7a45', '#3ddc97', '#c77dff']; // video: RTS_COLORS=c1,c2,c3,c4 sets the team colours (the orange of player 2 is hard to read on sand); unset = as always
const WORD = { rush: 'rushing', boom: 'booming', turtle: 'turtling' };

function fmtCmd(c) {
  if (!c) return '';
  const n = c.cmd ?? c.name;
  const a = c.args && typeof c.args === 'object' ? c.args : c;
  const xy = (v) => (Array.isArray(v) ? `(${Math.round(v[0])},${Math.round(v[1])})` : v === undefined ? '' : `#${v}`);
  switch (n) {
    case 'train': return `train ${a.count ?? 1}x ${a.unit_type}`;
    case 'build': return `build ${a.building_type} near ${xy(a.near)}`;
    case 'gather': return `gather ${a.resource ?? a.res ?? ''}`.trim();
    case 'attack_move': return `attack_move ${xy(a.target)}`;
    case 'move': return `move ${xy(a.to)}`;
    case 'research': return `research ${a.tech}`;
    case 'advance_tier': return 'advance_tier';
    case 'set_rally': return `set_rally ${xy(a.xy)}`;
    case 'scout': return `scout ${xy(a.xy)}`;
    case 'say': case 'note': return '';
    default: return n;
  }
}

// What a scripted bot is up to, as one short line for the "thought" slot. Reads only its public state.
export function intentOf(botName, bot, cmds) { // exported for test/display-name.test.mjs
  const st = bot?.s?.state;
  const pre = WORD[botName] || botName;
  const rank = { attack_move: 6, advance_tier: 5, research: 4, build: 3, train: 2, gather: 1 };
  let best = null;
  for (const c of cmds) {
    const n = c.cmd ?? c.name;
    let r = rank[n] || 0;
    if (n === 'train' && (c.unit_type ?? c.args?.unit_type) === 'worker') r = 1.5;
    if (!best || r > best.r) best = { c, r };
  }
  if (st === 'attack' && (!best || best.r < 5)) return `${pre}: wave is attacking`;
  if (!best || best.r < 1.5) return null;
  const c = best.c, a = c.args || c, n = c.cmd ?? c.name;
  let d;
  if (n === 'attack_move') d = st === 'attack' ? 'launching the attack wave' : 'defending the base';
  else if (n === 'advance_tier') d = 'advancing to the next tier';
  else if (n === 'research') d = `researching ${displayName('tech', a.tech)}`;
  else if (n === 'build') d = `building ${displayName('building', a.building_type)}`;
  else if (n === 'train') d = `training ${a.count ?? 1} ${displayName('unit', a.unit_type)}`;
  else d = fmtCmd(c);
  if (!d) return null;
  return `${pre}: ${d}`.slice(0, 120);
}

// --rules fast | --rules '{"preset":"fast","weather":"storm"}', plus --map-type desert|forest|winter|coast|meadow and --weather <kind|off|auto>
function liveRules() {
  if (typeof args.rules !== 'string' && !args['map-type'] && !args.weather) return undefined;
  const base = typeof args.rules === 'string' ? (args.rules.trim().startsWith('{') ? JSON.parse(args.rules) : { preset: args.rules }) : { preset: 'classic' };
  return { ...base, ...(args['map-type'] ? { mapType: args['map-type'] } : {}), ...(args.weather ? { weather: args.weather } : {}) };
}

export class Match {
  constructor() {
    this.speed = +args.speed || 1;
    this.paused = false;
    this.acc = 0;
    this.mode = args.replay ? 'replay' : 'live';
    this.logFd = null;
    this.events = []; // pending feed events for the next snapshot
    this.evSeen = 0;
    this.prevIds = new Map();
    this.nodesGone = [];
    this.treesGone = [];
    this.treeAlive = null;
    this.fogPid = 0;
    this.snapNo = 0;
    if (this.mode === 'replay') this.initReplay();
    else this.initLive();
    const g = this.game;
    const dup = (n) => this.names.filter((x) => x === n).length > 1;
    this.labels = g.players.slice(1).map((p, i) => ({
      name: dup(this.names[i]) ? `${this.names[i]} ${i + 1}` : this.names[i], model: this.models[i], hw: this.hws[i], color: COLORS[i % 4], team: p.team,
      creator: creatorRegistry()[this.creators?.[i]] ? this.creators[i] : null,
    }));
    this.metrics = g.players.slice(1).map(() => ({ lastCmd: '', lastCmdT: 0, thought: '', latency: null, tokS: null, tokSrc: null, thinks: 0, cmds: 0, invalid: 0, invalidBy: null, empty: 0 }));
    this.treeAlive = new Uint8Array(g.W * g.H);
    for (let i = 0; i < g.W * g.H; i++) this.treeAlive[i] = g.wood[i] > 0 ? 1 : 0;
    this.forest0 = this.treeAlive.slice(); // the tiles that carried wood when the match began (a viewer who joins late learns which of them are gone: initMsg)
    this.nodeAlive = new Set(g.nodes.keys());
    this.nodeMax = new Map([...g.nodes.values()].map((n) => [n.id, n.amt])); // full amounts: a late viewer still sees a hunted herd as such
  }

  initLive() {
    const seed = +(args.seed ?? SEED_DEFAULT);
    this.botNames = [args.p1 || 'rush', args.p2 || 'boom'];
    if (args.p3) this.botNames.push(args.p3);
    if (args.p4) this.botNames.push(args.p4);
    for (const b of this.botNames) if (!BOT_NAMES.includes(b)) { console.error(`unknown bot "${b}"; available: ${BOT_NAMES.join(', ')}`); process.exit(1); }
    const n = this.botNames.length;
    const players = this.botNames.map((b, i) => ({ team: i + 1, name: b }));
    this.seed = seed;
    this.game = new Game({ seed, players, numPlayers: n === 4 ? 4 : 2, rules: liveRules() });
    this.bots = this.botNames.map((b) => createBot(b));
    this.names = this.botNames.map((b) => b[0].toUpperCase() + b.slice(1));
    this.models = this.botNames.map((b, i) => args[`p${i + 1}-model`] || `scripted bot: ${b}`);
    this.hws = this.botNames.map((_, i) => args[`p${i + 1}-hw`] || 'Node.js, no GPU');
    this.creators = this.botNames.map((_, i) => (typeof args[`p${i + 1}-creator`] === 'string' ? args[`p${i + 1}-creator`] : null));
    this.cls = typeof args.class === 'string' ? args.class : null;
    this.lastThink = this.botNames.map(() => -1);
    this.id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${this.botNames.join('-')}-s${seed}`;
    if (!args['no-record']) {
      const dir = path.join(ROOT, 'replays', this.id);
      fs.mkdirSync(dir, { recursive: true });
      this.dir = dir;
      this.logFd = fs.openSync(path.join(dir, 'log.jsonl'), 'w');
      this.writeLog({ type: 'start', sim_version: ensureFrozen(), seed, rules: this.game.rules, bots: this.botNames, teams: players.map((p) => p.team), map: this.game.mapName, ...(this.creators.some(Boolean) ? { creators: this.creators } : {}), ...(this.cls ? { class: this.cls } : {}) });
    }
  }

  initReplay() {
    let file = path.resolve(String(args.replay));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      const cands = ['log.jsonl', 'commands.jsonl', 'replay.jsonl'].map((f) => path.join(file, f)).filter((f) => fs.existsSync(f));
      const any = fs.readdirSync(file).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(file, f));
      file = cands[0] || any[0];
    }
    if (!file || !fs.existsSync(file)) { console.error(`replay not found: ${args.replay}`); process.exit(1); }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const start = lines.find((l) => l.type === 'start');
    if (!start) { console.error('replay log has no start line'); process.exit(1); }
    this.seed = start.seed;
    this.botNames = start.bots;
    const n = this.botNames.length;
    const players = this.botNames.map((b, i) => ({ team: start.teams ? start.teams[i] : i + 1, name: b }));
    // the replay runs on the sim version it was recorded with (sim-versions/); live matches always use the current sim
    this.sim = simForReplay(file, start, { lenient: true });
    this.game = newGameOf(this.sim, start);
    this.cmdLog = lines.filter((l) => l.type === 'cmd').sort((a, b) => a.t - b.t);
    this.cmdPos = 0;
    this.hudLog = lines.filter((l) => l.type === 'state' && l.hud).sort((a, b) => a.t - b.t); // think / tok/s figures of LLM players
    this.hudPos = 0;
    this.names = this.botNames.map((b) => b[0].toUpperCase() + b.slice(1));
    this.models = this.botNames.map((b, i) => args[`p${i + 1}-model`] || start.players?.[i]?.model || `scripted bot: ${b}`);
    this.hws = this.botNames.map((_, i) => args[`p${i + 1}-hw`] || start.players?.[i]?.hardware || 'Node.js, no GPU');
    this.creators = this.botNames.map((_, i) => (typeof args[`p${i + 1}-creator`] === 'string' ? args[`p${i + 1}-creator`] : start.players?.[i]?.creator ?? start.creators?.[i] ?? null));
    this.cls = typeof args.class === 'string' ? args.class : start.class || null;
    this.id = path.basename(path.dirname(file)) + '/' + path.basename(file);
    this.replayEnd = lines.find((l) => l.type === 'result') || null;
  }

  writeLog(o) {
    if (this.logFd !== null) fs.writeSync(this.logFd, JSON.stringify(o) + '\n');
  }

  // God mode: one intervention of the spectator, applied between two ticks and logged with its tick (live matches only)
  director(cmd) {
    const g = this.game;
    if (this.mode === 'replay') return { ok: false, error: 'replay', message: 'a replay cannot be changed' };
    if (this.finished || g.over) return { ok: false, error: 'game_over', message: 'the match is over' };
    const r = g.command(0, cmd);
    this.writeLog({ type: 'cmd', t: g.t, p: 0, cmd, ok: r.ok, err: r.ok ? undefined : r.error });
    return r;
  }

  note(pid, cmd, r) {
    const m = this.metrics[pid - 1];
    m.cmds++;
    if (!r.ok) m.invalid++;
    const n = cmd.cmd ?? cmd.name;
    if (n === 'note') { m.thought = String(cmd.text ?? cmd.args?.text ?? '').slice(0, 120); return; }
    m.lastCmd = fmtCmd(cmd) + (r.ok ? '' : '  [rejected]');
    m.lastCmdT = this.game.t;
  }

  tick() {
    const g = this.game;
    if (g.over) return;
    if (this.mode === 'live') {
      const n = this.bots.length;
      if (g.t % THINK_TICKS === 0) {
        for (let k = 0; k < n; k++) {
          const i = (k + g.t / THINK_TICKS) % n;
          const pid = i + 1;
          if (!g.players[pid].alive) continue;
          const obs = JSON.parse(JSON.stringify(observe(g, pid, { sinceTick: this.lastThink[i] })));
          this.lastThink[i] = g.t;
          const t0 = performance.now();
          const cmds = this.bots[i].think(obs);
          const ms = performance.now() - t0;
          const m = this.metrics[i];
          m.latency = ms;
          m.thinks++;
          for (const c of cmds) {
            const r = g.command(pid, c);
            this.note(pid, c, r);
            this.writeLog({ type: 'cmd', t: g.t, p: pid, cmd: c, ok: r.ok, err: r.ok ? undefined : r.error });
          }
          const intent = intentOf(this.botNames[i], this.bots[i], cmds);
          if (intent && !g.players[pid].note) m.thought = intent;
        }
      }
    } else {
      while (this.hudPos < this.hudLog.length && this.hudLog[this.hudPos].t <= g.t) {
        const h = this.hudLog[this.hudPos++].hud;
        h.forEach((x, i) => { if (x && this.metrics[i]) Object.assign(this.metrics[i], { latency: x.latency, tokS: x.tokS, thinks: x.thinks, tokSrc: x.tokSrc ?? null, invalidBy: x.invalidBy ?? null, empty: x.empty ?? 0 }); });
      }
      while (this.cmdPos < this.cmdLog.length && this.cmdLog[this.cmdPos].t <= g.t) {
        const l = this.cmdLog[this.cmdPos++];
        const r = g.command(l.p, l.cmd);
        if (l.p === 0) continue; // director command (God mode): shown through the game's own God feed
        this.note(l.p, l.cmd, r);
        if (l.p >= 1 && this.botNames) {
          const st = fmtCmd(l.cmd);
          if (st) this.metrics[l.p - 1].thought = `replay: ${st}`.slice(0, 120);
        }
      }
    }
    g.step();
    for (const p of g.players) {
      if (!p) continue;
      const m = this.metrics[p.id - 1];
      if (p.note && p.noteTick >= 0) m.thought = p.note;
    }
    if (g.over) this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    const res = this.game.result();
    console.log(`match over: ${res.reason}, winner team ${res.winnerTeam || 'none'}, ${(res.seconds / 60).toFixed(1)} min game time, hash ${this.game.hash()}`);
    this.writeLog({ type: 'result', ...res });
    if (this.logFd !== null) { fs.closeSync(this.logFd); this.logFd = null; }
    if (this.dir) fs.writeFileSync(path.join(this.dir, 'result.json'), JSON.stringify({ id: this.id, seed: this.seed, bots: this.botNames, hash: this.game.hash(), ...res }, null, 1));
  }

  // ---------------- snapshots ----------------
  // sim bundle of this match (a frozen older one for replays of older versions)
  get simB() { return this.sim || (this.sim = loadSim()); }

  // forest tiles that were cut before now (sim: wood <= 0 sets terrain 0). A viewer who joins late would see bare ground and no stumps, so the
  // init message gives such tiles back as forest ('f') and lists them in `fells`: the renderer plants the trees and fells them at once as stumps.
  // One list per viewer, built from the sim state: it does not grow with the snapshots, and it changes nothing for the other viewers.
  fellsNow() {
    const g = this.game, out = [];
    if (!this.forest0) return out;
    for (let i = 0; i < g.W * g.H; i++) if (this.forest0[i] && g.wood[i] <= 0 && g.terrain[i] === 0) out.push(i);
    return out;
  }

  initMsg() {
    const g = this.game;
    const { UNITS, BUILDINGS, RESOURCES } = this.simB;
    const fells = this.fellsNow(), cut = new Set(fells);
    const un = [...Object.keys(UNITS), ...WILD_UNITS], bn = Object.keys(BUILDINGS);
    return {
      type: 'init', id: this.id, mode: this.mode, seed: this.seed, size: g.W, terrain: [...Array(g.H).keys()].map((y) => {
        let s = '';
        for (let x = 0; x < g.W; x++) s += '.f~#'[cut.has(y * g.W + x) ? 1 : g.terrain[y * g.W + x]];
        return s;
      }),
      nodes: [...g.nodes.values()].map((n) => [n.id, n.res, n.tx, n.ty, n.size, n.amt, this.nodeMax.get(n.id)]),
      players: this.labels, units: un, buildings: bn, resources: RESOURCES, timeLimit: g.rules?.timeLimitS ?? 1800,
      unitDefs: Object.fromEntries(un.map((k) => [k, UNITS[k] ? { cls: UNITS[k].cls, cost: UNITS[k].cost, range: UNITS[k].range, speed: UNITS[k].speed } : { cls: k === 'caravan' ? 'trader' : 'beast', cost: {}, range: 1, speed: k === 'caravan' ? 1.35 : 3.1 }])),
      buildingDefs: Object.fromEntries(bn.map((k) => [k, { size: BUILDINGS[k].size, cost: BUILDINGS[k].cost }])),
      starts: g.starts,
      fells: fells.length ? fells : undefined,
      mapType: g.mapType, weatherOn: g.wxOn || undefined,
      fish: g.fish && g.fish.length ? g.fish.map((f) => [f.id, f.tx, f.ty, f.amt]) : undefined,
      cls: this.cls || null,
      creators: Object.fromEntries(this.labels.filter((l) => l.creator).map((l) => [l.creator, creatorRegistry()[l.creator]])),
    };
  }

  snapshot() {
    const g = this.game;
    const { UNITS, BUILDINGS, RESOURCES, standingChips, feedOf, markersOf } = this.simB;
    const un = [...Object.keys(UNITS), ...WILD_UNITS], bn = Object.keys(BUILDINGS);
    const uIdx = Object.fromEntries(un.map((k, i) => [k, i]));
    const bIdx = Object.fromEntries(bn.map((k, i) => [k, i]));
    const rIdx = Object.fromEntries(RESOURCES.map((k, i) => [k, i + 1]));
    const units = [], buildings = [], cur = new Map();
    const army = [], pw = [];
    for (const p of g.players) if (p) { army[p.id] = 0; pw[p.id] = 0; }
    for (const u of g.units.values()) {
      if (u.dead || u.boarded) continue;
      const o = u.ord.t;
      const act = o === 'idle' ? 0 : o === 'gather' ? 2 : o === 'build' ? 3 : (o === 'attack' || o === 'amove') && u.tgt ? 4 : 1;
      const row = [u.id, u.owner, uIdx[u.type], Math.round(u.x / 10) / 100, Math.round(u.y / 10) / 100,
        Math.max(1, Math.round((100 * u.hp) / u.maxhp)), act, u.tgt || 0, u.amt > 0 && u.res ? rIdx[u.res] || 0 : 0, u.cd || 0];
      if (o === 'gather') workOf(u.ord, row); // [10..12]: what the worker works on right now (the renderer must not guess it from the map)
      units.push(row);
      cur.set(u.id, [1, u.owner, u.type, u.x / 1000, u.y / 1000]);
      if (u.type === 'worker') pw[u.owner]++;
      else if (u.ship || u.owner === 0) continue;
      else {
        const c = UNITS[u.type]?.cost;
        if (c) for (const k in c) army[u.owner] += c[k];
      }
    }
    for (const b of g.buildings.values()) {
      if (b.dead) continue;
      const d = BUILDINGS[b.type];
      const prog = b.built ? 100 : Math.min(99, Math.round((100 * b.prog) / ((d?.time || 1) * TICK_HZ * 1000)));
      buildings.push([b.id, b.owner, bIdx[b.type], b.tx, b.ty, Math.max(1, Math.round((100 * b.hp) / b.maxhp)), prog, b.queue.length + (b.research ? 1 : 0)]);
      cur.set(b.id, [2, b.owner, b.type, b.tx, b.ty, b.size]);
    }
    // deaths since the last snapshot (diff of ids), used for effects and the kill feed
    const dead = [];
    for (const [id, v] of this.prevIds) if (!cur.has(id)) dead.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
    this.prevIds = cur;
    // resource nodes / trees that ran out
    if (g.t % 5 === 0 || !this.scanned) { // the first snapshot of a viewer (a render chunk, a late join) lists everything that went since the start, in one go
      this.scanned = true;
      for (const id of [...this.nodeAlive]) if (!g.nodes.has(id)) { this.nodeAlive.delete(id); this.nodesGone.push(id); }
      const W = g.W;
      for (let i = 0; i < W * g.H; i++) if (this.treeAlive[i] && g.wood[i] <= 0) { this.treeAlive[i] = 0; this.treesGone.push(i); }
    }
    // progress events (tier, tech, buildings)
    const ev = [];
    for (const p of g.players) {
      if (!p) continue;
      for (const e of p.events) {
        if (e.t <= (this.evSeen2?.[p.id] ?? -1)) continue;
        if (e.type === 'tier') ev.push({ k: 'tier', p: p.id, tier: e.tier, t: e.t });
        else if (e.type === 'tech_done') ev.push({ k: 'tech', p: p.id, tech: e.tech, t: e.t });
        else if (e.type === 'built') ev.push({ k: 'built', p: p.id, b: e.b, t: e.t });
      }
      (this.evSeen2 ||= {})[p.id] = g.t;
    }
    // wonder and shrine announcements (once each)
    for (const a of g.announcements || []) if (a.n > (this.annSeen || 0)) ev.push({ k: 'ann', a: a.type, p: a.owner, team: a.team, x: a.x, y: a.y, secs: a.secs ?? a.secs_left ?? 0, vp: a.vp ?? 0, by: a.by || 0, t: a.t });
    if (g.announcements && g.announcements.length) this.annSeen = g.announcements[g.announcements.length - 1].n;
    // sound only (render/audio-core.mjs): a market trade (the trade counter of a player went up) and a caravan that paid out. The first
    // snapshot of a viewer only marks what is already there as seen (no burst of old trades on a late join or a fast-forward)
    const first = !this.mktSeen;
    this.mktSeen ||= {};
    for (const p of g.players) { if (!p || !p.mkt) continue; if (!first && p.mkt.trades > (this.mktSeen[p.id] ?? 0)) ev.push({ k: 'mkt', p: p.id, t: g.t }); this.mktSeen[p.id] = p.mkt.trades; }
    this.wlSeen ||= new WeakSet();
    for (const w of g.worldLog || []) if (!this.wlSeen.has(w)) { this.wlSeen.add(w); if (!first && w.type === 'caravan_trade') ev.push({ k: 'caravan', x: w.x, y: w.y, t: w.t }); }
    const players = g.players.slice(1).map((p, i) => {
      const m = this.metrics[i];
      let adv = 0;
      if (p.advancing) adv = p.advancing;
      return {
        id: p.id, alive: p.alive, res: p.res, pop: p.pop, cap: p.cap, tier: p.tier, adv,
        army: army[p.id], workers: pw[p.id], score: g.score(p), kills: p.kills, losses: p.losses, killValue: p.killValue,
        lastCmd: m.lastCmd, lastCmdAge: m.lastCmd ? Math.round((g.t - m.lastCmdT) / TICK_HZ) : null,
        thought: m.thought, latency: m.latency, tokS: m.tokS, tokSrc: m.tokSrc, cmds: m.cmds, invalid: m.invalid, invalidBy: m.invalidBy, empty: m.empty,
        gathered: p.gathered, standing: standingChips(p), feed: feedOf(g, p),
      };
    });
    const msg = {
      type: 'snap', no: ++this.snapNo, t: g.t, speed: this.paused ? 0 : this.speed, paused: this.paused,
      units, buildings, dead, ev, players, mk: markersOf(g),
      proj: g.proj.map((q) => [Math.round(q.x / 10) / 100, Math.round(q.y / 10) / 100, Math.round(q.tx / 10) / 100, Math.round(q.ty / 10) / 100, q.owner, q.speed, q.splash ? 1 : 0, q.src ? (uIdx[q.src] ?? -1) : -1, q.sid, 120 - q.life]), // [7] unit type of the shooter (-1: building), [8] shooter id, [9] age in ticks (render/app.mjs: thrown javelins leave the hand of the skirmisher)
    };
    if (this.nodesGone.length) { msg.ng = this.nodesGone; this.nodesGone = []; }
    if (this.treesGone.length) { msg.tg = this.treesGone; this.treesGone = []; }
    if (this.nodeAlive.size) {
      // remaining amounts change slowly: send every 2 s
      if (g.t % 20 < 2) msg.na = [...g.nodes.values()].map((n) => [n.id, n.amt]);
    }
    if (g.rules.wonder || g.rules.shrines) msg.vic = g.victoryView();
    // the living world: weather [kind index, seconds left, next kind index], chat bubbles (new lines), fish amounts
    if (g.wxOn || (g.wx && g.wx.over)) msg.wx = g.worldView().wx;
    // chat bubbles: lines newer than the last one handed out. The very first snapshot of a viewer that does not start at tick 0 (a render
    // from a later tick, a late joiner, a fast-forward) would otherwise get the old chat log at once: lines older than SAY_FRESH_S of game time
    // are skipped there (still marked as seen). A function of the game tick only, so renders stay deterministic.
    const fresh = (g.chatLog || []).filter((m) => m.seq > (this.saySeen || 0));
    const say = this.saySeen === undefined ? fresh.filter((m) => g.t - m.t <= SAY_FRESH_S * TICK_HZ) : fresh;
    if (fresh.length) this.saySeen = fresh[fresh.length - 1].seq; else if (this.saySeen === undefined) this.saySeen = 0;
    if (say.length) msg.say = say.map((m) => [m.p, m.text, m.seq]);
    if (g.fish && g.fish.length && g.t % 20 < 2) msg.fa = g.fish.map((f) => [f.id, f.amt]);
    if (g.godMode) msg.god = g.godView();
    if (g.over) {
      const r = g.result();
      msg.over = { winnerTeam: r.winnerTeam, reason: r.reason, seconds: r.seconds, godMode: r.godMode, players: r.players.map((p) => ({ id: p.id, score: p.score, alive: p.alive })) };
    }
    if (this.fogPid && g.players[this.fogPid] && this.snapNo % 4 === 0) {
      const p = g.players[this.fogPid];
      const f = new Uint8Array(g.W * g.H);
      for (let i = 0; i < f.length; i++) f[i] = p.vis[i] ? 2 : p.expl[i] ? 1 : 0;
      msg.fog = { p: this.fogPid, d: Buffer.from(f).toString('base64') };
    }
    return msg;
  }
}

// What a gathering worker works on, from its order in the sim (the renderer would otherwise have to guess it from the nearest thing on the map: a field next to
// a bush, a tree tile without a drawn tree). Appends to the unit row: [10] = 0 (walking to the node, carrying goods back, waiting) or 1 + index in WORK_KINDS
// while the worker is at work, then [11], [12] = the middle of the node (tiles). A row of 10 numbers = no order data (not gathering, or an old sim version): the renderer guesses.
export const WORK_KINDS = ['wood', 'berries', 'herd', 'farm', 'stone', 'gold'];
function workOf(ord, row) {
  const kind = WORK_KINDS.indexOf(ord.kind);
  if (kind < 0) return;
  const cx = (ord.x0 + ord.x1) / 2000, cy = (ord.y0 + ord.y1) / 2000;
  if (ord.st !== 'work' || !ord.node || !Number.isFinite(cx) || !Number.isFinite(cy)) { row.push(0); return; }
  row.push(kind + 1, Math.round(cx * 100) / 100, Math.round(cy * 100) / 100);
}

// ---------------- http / sse ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
export function serve(match) {
const clients = new Set();
let lastMsg = null;

function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function broadcast(obj) {
  lastMsg = obj;
  for (const c of clients) send(c, obj);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send(res, match.initMsg());
    clients.add(res);
    broadcast(match.snapshot()); // snapshot() hands out tg/ng/dead/ev only once: the other viewers must get what this one drains
    req.on('close', () => clients.delete(res));
    return;
  }
  if (u.pathname === '/api/director') {
    const gd = guardDirector(req);
    res.writeHead(gd.ok ? 200 : gd.code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (!gd.ok) { res.end(JSON.stringify({ ok: false, error: gd.error })); return; }
    const chunks = [];
    req.on('data', (d) => { if (chunks.length < 64) chunks.push(d); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* empty */ }
      const r = match.director(cleanDirector(body));
      res.end(JSON.stringify(r));
      if (clients.size) broadcast(match.snapshot());
    });
    return;
  }
  if (u.pathname.startsWith('/api/')) {
    const q = u.searchParams;
    if (u.pathname === '/api/speed') { match.speed = Math.max(0.25, Math.min(64, +q.get('x') || 1)); match.paused = false; }
    else if (u.pathname === '/api/pause') match.paused = q.get('on') === '1' ? true : q.get('on') === '0' ? false : !match.paused;
    else if (u.pathname === '/api/fog') match.fogPid = +q.get('p') || 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ speed: match.speed, paused: match.paused, fog: match.fogPid }));
    if (clients.size) broadcast(match.snapshot());
    return;
  }
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(RENDER, p));
  if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (p === '/index.html') res.end(injectToken(fs.readFileSync(f, 'utf8')));
  else fs.createReadStream(f).pipe(res);
});

// fast-forward before the first client (for screenshots and quick looks)
if (args.ff) {
  const target = +args.ff * TICK_HZ;
  while (match.game.t < target && !match.game.over) match.tick();
  console.log(`fast-forwarded to ${(match.game.t / TICK_HZ).toFixed(0)}s game time`);
}

const pacer = new Pacer();
driftTimer(() => {
  if (match.paused) { pacer.hold(); return; }
  if (!match.started) {
    if (!clients.size && !args['run-without-viewer']) { pacer.hold(); return; } // wait for the first viewer
    match.started = true;
    pacer.hold();
  }
  if (!match.game.over) {
    const n = pacer.take(match.speed);
    for (let i = 0; i < n && !match.game.over; i++) match.tick();
  }
  const sig = `${match.game.t}|${match.paused}|${match.speed}|${match.fogPid}`;
  if (clients.size && (!match.game.over || !match.sentOver) && sig !== match.lastSig) {
    match.lastSig = sig;
    broadcast(match.snapshot());
    if (match.game.over) match.sentOver = true;
  }
}, 50);

server.listen(+(args.port || 0), '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`Spectator: http://127.0.0.1:${port}/   (${match.mode}, seed ${match.seed}, ${match.botNames.join(' vs ')}, speed ${match.speed}x)`);
  if (match.dir) console.log(`Recording to ${path.relative(ROOT, match.dir)}/log.jsonl (replay with --replay)`);
});
process.on('SIGINT', () => { match.finish?.(); process.exit(0); });
process.on('SIGTERM', () => { match.finish?.(); process.exit(0); });
return server;
}

if (isMain) {
  let themeArg; // --theme: a wrong id stops the server before it starts; nothing set is classic, as before
  try { themeArg = await resolveThemeArg(args.theme, { video: false }); } catch (e) { console.error(e.message); process.exit(2); }
  applyThemeArg(themeArg, { video: false, log: console.log });
  serve(new Match());
}
