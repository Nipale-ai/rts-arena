#!/usr/bin/env node
// Event log from a replay. Re-simulates the match (commands + seed), never changes sim results, and writes events.json:
// first contact, battles, tier-ups, key buildings, expansions, destroyed buildings / bases, momentum swings,
// resign / victory, every LLM decision (thought, latency, tokens) and a per-second series for highlight scoring.
//   node tools/events.mjs replays/<id> [--out replays/<id>/events.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReplay, ReplaySim } from './lib/replay.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { digestObservation } from './commentary.mjs';
import { resolveSubjects } from './subjects.mjs';
import { cleanThought } from './lib/thought.mjs';
import { UNITS } from '../sim/data.mjs';

export const EVENTS_VERSION = 1;
export const KEY_BUILDINGS = ['barracks', 'archery_range', 'stables', 'siege_workshop', 'blacksmith', 'tower', 'castle', 'market'];
// announcements of the victory paths (sim/victory.mjs) that become events of the same name
const ANNOUNCED = new Set(['wonder_started', 'wonder_warning', 'wonder_destroyed', 'wonder_completed', 'control_point_captured', 'control_victory']);
const SKIRMISH_MIN_VALUE = 150; // a cluster of kills below this is not reported as a battle
const LOSS_WINDOW_TICKS = 30;   // unit losses of one side to one killer within this many ticks are one feed line
const BATTLE_GAP_TICKS = 60;    // kills further apart in time than this start a new battle
const BATTLE_MAX_TICKS = 900;   // a fight that lasts longer is cut into several battles
const BATTLE_RADIUS = 26;       // tiles, kills further from the cluster centre start a new battle
const NAVAL_GAP_TICKS = 150, NAVAL_RADIUS = 20; // sunk ships this close in time and space are one sea battle
const SWING_MIN = 150, SWING_FRAC = 0.2; // army-value lead needed to count as "leading"

const sum = (c) => { let v = 0; for (const k in c) v += c[k]; return v; };
const r1 = (v) => Math.round(v * 10) / 10;

function armyValue(g, p) {
  let a = 0;
  for (const u of g.units.values()) if (u.owner === p.id && !u.dead && u.type !== 'worker') a += sum(p.faction.units[u.type].cost);
  return a;
}
// what a side really has on the field right now (a model's report is older: it was taken when the model was asked, before it answered)
function workersOf(g, p) { let n = 0; for (const u of g.units.values()) if (u.owner === p.id && !u.dead && u.type === 'worker') n++; return n; }
function armyTypes(g, p) { const m = {}; for (const u of g.units.values()) if (u.owner === p.id && !u.dead && u.type !== 'worker') m[u.type] = (m[u.type] || 0) + 1; return m; }
const fighting = (u) => (u.ord.t === 'attack' || u.ord.t === 'amove') && u.tgt;

// what a decision really cost: when an answer held no orders the game asked again, so the first answer counts too
export function decisionCost(e) {
  const f = e.retry?.first;
  return {
    latency_ms: e.latency_ms == null ? null : e.latency_ms + (f?.latency_ms || 0),
    completion_tokens: e.completion_tokens == null ? null : e.completion_tokens + (f?.completion_tokens || 0),
    asked_again: !!f,
  };
}

export function computeEvents(repOrDir) {
  const rep = typeof repOrDir === 'string' ? loadReplay(repOrDir) : repOrDir;
  const sim = new ReplaySim(rep);
  const g = sim.game;
  const N = g.numPlayers;
  const events = [];
  const add = (e) => events.push(e);

  // ---- hooks (observe only) ----
  const kills = [];
  const origKill = g.kill.bind(g);
  g.kill = (e, killerOwner, src) => {
    const was = e.dying || e.dead;
    origKill(e, killerOwner, src);
    if (was || !e.dying || e.kind === 3 || e.owner === 0) return; // owner 0 = wolves of a God mode event: not part of the player statistics
    const vp = g.pl(e.owner);
    const unit = e.kind === 1;
    const value = sum(unit ? vp.faction.units[e.type].cost : vp.faction.buildings[e.type].cost);
    const x = unit ? e.x / 1000 : e.tx + e.size / 2, y = unit ? e.y / 1000 : e.ty + e.size / 2;
    kills.push({ t: g.t, owner: e.owner, kind: unit ? 'unit' : 'building', type: e.type, value, x, y, by: killerOwner || 0, src: src || null });
  };
  if (g.announce) {
    const origAnnounce = g.announce.bind(g);
    g.announce = (a) => {
      origAnnounce(a);
      if (ANNOUNCED.has(a.type)) add({ t: g.t, type: a.type, p: a.owner || null, team: a.team ?? null, loc: [a.x, a.y], secs: a.secs ?? a.secs_left ?? null, by: a.by || null, from_team: a.from_team ?? null, vp: a.vp ?? null });
    };
  }
  const keySeen = new Set();
  const origEvent = g.event.bind(g);
  g.event = (p, ev) => {
    origEvent(p, ev);
    if (ev.type === 'tier') add({ t: g.t, type: 'tier_up', p: p.id, tier: ev.tier });
    else if (ev.type === 'built') {
      let tcs = 0;
      if (ev.b === 'town_center') for (const b of g.buildings.values()) if (b.owner === p.id && b.type === 'town_center' && b.built) tcs++;
      if (ev.b === 'town_center' && tcs >= 2) add({ t: g.t, type: 'expansion', p: p.id, loc: [ev.x, ev.y], count: tcs });
      else if (KEY_BUILDINGS.includes(ev.b) && !keySeen.has(`${p.id}:${ev.b}`)) { keySeen.add(`${p.id}:${ev.b}`); add({ t: g.t, type: 'key_building', p: p.id, building: ev.b, loc: [ev.x, ev.y] }); }
    }
  };

  // ---- per-second sampling ----
  const S = { army: Array.from({ length: N }, () => []), workers: Array.from({ length: N }, () => []), army_types: Array.from({ length: N }, () => []), lost: Array.from({ length: N }, () => []), fight: Array.from({ length: N }, () => []), destroyed: [], fx: [], fy: [], spread: [] };
  const fightSamples = []; // per second: [owner, x, y, ...]
  let contact = false;
  let leader = 0;
  let prevKillIdx = 0;
  // what exists when (for the show tags of the casters): every finished building {p,type,tx,ty,size,t0,t1} and, per player and unit type, the intervals in which at least one unit lives
  const structs = new Map(), openU = new Map(), rosterOut = [];
  const trackWorld = () => {
    for (const b of g.buildings.values()) if (b.owner > 0 && b.built && !b.dead && !structs.has(b.id)) structs.set(b.id, { p: b.owner, type: b.type, tx: b.tx, ty: b.ty, size: b.size, t0: g.t, t1: null });
    for (const [id, st] of structs) if (st.t1 == null) { const b = g.buildings.get(id); if (!b || b.dead) st.t1 = g.t; }
    const alive = new Set();
    for (const u of g.units.values()) if (!u.dead && u.owner > 0) alive.add(`${u.owner}:${u.type}`);
    for (const k of alive) { const o = openU.get(k); if (o) o[1] = g.t; else openU.set(k, [g.t, g.t]); }
    for (const [k, o] of openU) if (!alive.has(k)) { rosterOut.push([k, o]); openU.delete(k); }
  };
  const sampleSecond = () => {
    trackWorld();
    const s = S.destroyed.length;
    // value destroyed during second s-1 .. (kills are binned by tick/10)
    void s;
    for (let i = 0; i < N; i++) { S.army[i].push(armyValue(g, g.players[i + 1])); S.workers[i].push(workersOf(g, g.players[i + 1])); S.army_types[i].push(armyTypes(g, g.players[i + 1])); }
    const f = [];
    const cnt = new Array(N).fill(0);
    let cx = 0, cy = 0, n = 0;
    for (const u of g.units.values()) {
      if (u.dead || u.owner === 0 || !fighting(u)) continue;
      cnt[u.owner - 1]++;
      f.push(u.owner, u.x / 1000, u.y / 1000);
      cx += u.x / 1000; cy += u.y / 1000; n++;
    }
    for (let i = 0; i < N; i++) S.fight[i].push(cnt[i]);
    fightSamples.push(f);
    if (n) {
      cx /= n; cy /= n;
      let sp = 0;
      for (let k = 0; k < f.length; k += 3) sp += Math.hypot(f[k + 1] - cx, f[k + 2] - cy);
      S.fx.push(r1(cx)); S.fy.push(r1(cy)); S.spread.push(r1(sp / n));
    } else { S.fx.push(null); S.fy.push(null); S.spread.push(null); }
    // momentum swing (army value lead flips)
    if (N === 2) {
      const a = S.army[0][S.army[0].length - 1], b = S.army[1][S.army[1].length - 1];
      const lead = a - b, thr = Math.max(SWING_MIN, SWING_FRAC * Math.max(a, b));
      const now = lead > thr ? 1 : lead < -thr ? 2 : 0;
      if (now && now !== leader) {
        if (leader) add({ t: g.t, type: 'momentum_swing', from: leader, to: now, lead: Math.abs(lead), army: [a, b] });
        leader = now;
      }
    }
    // first contact: some player currently sees an enemy unit or building
    if (!contact && g.t > 0) {
      for (const p of g.players) {
        if (!p || contact) continue;
        const W = g.W;
        const seen = (x, y) => p.vis[Math.floor(y) * W + Math.floor(x)];
        for (const u of g.units.values()) if (!u.dead && u.owner !== 0 && !u.boarded && g.team[u.owner] !== p.team && seen(u.x / 1000, u.y / 1000)) { contact = true; add({ t: g.t, type: 'first_contact', p: p.id, other: u.owner, loc: [r1(u.x / 1000), r1(u.y / 1000)], what: u.type }); break; }
        if (contact) break;
        for (const b of g.buildings.values()) if (!b.dead && g.team[b.owner] !== p.team && seen(b.tx + b.size / 2, b.ty + b.size / 2)) { contact = true; add({ t: g.t, type: 'first_contact', p: p.id, other: b.owner, loc: [b.tx, b.ty], what: b.type }); break; }
      }
    }
    void prevKillIdx;
  };

  const want = new Map(rep.states.map((s) => [s.t, s.hash]));
  let checked = 0, firstBad = null;
  sampleSecond(); // second 0
  while (sim.step()) {
    if (g.t % TICK_HZ === 0) sampleSecond();
    if (want.has(g.t)) { checked++; if (g.hash() !== want.get(g.t) && firstBad === null) firstBad = g.t; }
  }
  if (g.t % TICK_HZ !== 0) sampleSecond();
  const endTick = g.t;
  const secs = S.army[0].length;

  // ---- per-second destroyed value from the kill list ----
  S.destroyed = new Array(secs).fill(0);
  for (let i = 0; i < N; i++) S.lost[i] = new Array(secs).fill(0);
  for (const k of kills) {
    const s = Math.min(secs - 1, Math.floor(k.t / TICK_HZ));
    S.destroyed[s] += k.value;
    S.lost[k.owner - 1][s] += k.value;
  }

  // ---- battles: clusters of kills in time and space ----
  const clusters = [];
  for (const k of kills) {
    let best = null;
    for (const c of clusters) {
      if (k.t - c.last > BATTLE_GAP_TICKS || k.t - c.kills[0].t > BATTLE_MAX_TICKS) continue;
      if (Math.hypot(k.x - c.cx, k.y - c.cy) > BATTLE_RADIUS) continue;
      best = c;
    }
    if (!best) { best = { kills: [], last: k.t, cx: k.x, cy: k.y, w: 0 }; clusters.push(best); }
    best.kills.push(k);
    best.last = k.t;
    best.cx = (best.cx * best.w + k.x * k.value) / (best.w + k.value);
    best.cy = (best.cy * best.w + k.y * k.value) / (best.w + k.value);
    best.w += k.value;
  }
  for (const c of clusters) {
    const total = c.kills.reduce((a, k) => a + k.value, 0);
    if (total < SKIRMISH_MIN_VALUE) continue;
    const t0 = c.kills[0].t, t1 = c.kills[c.kills.length - 1].t;
    const perSec = new Map();
    for (const k of c.kills) perSec.set(Math.floor(k.t / TICK_HZ), (perSec.get(Math.floor(k.t / TICK_HZ)) || 0) + k.value);
    let peakS = 0, peakV = 0;
    for (const [s, v] of [...perSec].sort((a, b) => a[0] - b[0])) if (v > peakV) { peakV = v; peakS = s; }
    const participants = {};
    for (let p = 1; p <= N; p++) participants[p] = { lost_units: 0, lost_value: 0, lost_buildings: 0, lost_by_type: {}, peak_fighting: 0 };
    for (const k of c.kills) {
      const P = participants[k.owner];
      P.lost_value += k.value;
      if (k.kind === 'unit') P.lost_units++; else P.lost_buildings++;
      P.lost_by_type[k.type] = (P.lost_by_type[k.type] || 0) + 1;
    }
    const s0 = Math.max(0, Math.floor(t0 / TICK_HZ) - 3), s1 = Math.min(secs - 1, Math.ceil(t1 / TICK_HZ) + 1);
    for (let s = s0; s <= s1; s++) {
      const cnt = {};
      const f = fightSamples[s];
      for (let k = 0; k < f.length; k += 3) if (Math.hypot(f[k + 1] - c.cx, f[k + 2] - c.cy) <= BATTLE_RADIUS) cnt[f[k]] = (cnt[f[k]] || 0) + 1;
      for (const o in cnt) participants[o].peak_fighting = Math.max(participants[o].peak_fighting, cnt[o]);
    }
    add({
      t: t0, type: 'battle', t_end: t1, loc: [r1(c.cx), r1(c.cy)], value: Math.round(total), kills: c.kills.length,
      peak_value_per_s: peakV, peak_tick: Math.min(t1, Math.max(t0, peakS * TICK_HZ + 5)), participants,
    });
  }
  // ---- destroyed buildings and bases ----
  for (const k of kills) {
    if (k.kind !== 'building') continue;
    if (k.type === 'town_center') add({ t: k.t, type: 'base_destroyed', p: k.owner, loc: [r1(k.x), r1(k.y)], by: k.by, value: k.value, src: k.src });
    else if (!['wall', 'gate', 'farm', 'house'].includes(k.type) || k.value >= 100) add({ t: k.t, type: 'building_destroyed', p: k.owner, building: k.type, loc: [r1(k.x), r1(k.y)], by: k.by, value: k.value, src: k.src });
  }

  // ---- unit losses for the action feed: kills of one killer / victim pair, grouped over LOSS_WINDOW_TICKS (timed at the last kill) ----
  {
    const open = new Map();
    const flush = (g) => { const types = {}; let value = 0; for (const k of g.kills) { types[k.type] = (types[k.type] || 0) + 1; value += k.value; } add({ t: g.last, type: 'losses', p: g.owner, by: g.by, n: g.kills.length, types, value }); };
    for (const k of kills) {
      if (k.kind !== 'unit') continue;
      const key = `${k.owner}:${k.by}`;
      let g = open.get(key);
      if (g && k.t - g.t0 > LOSS_WINDOW_TICKS) { flush(g); g = null; }
      if (!g) { g = { owner: k.owner, by: k.by, t0: k.t, last: k.t, kills: [] }; open.set(key, g); }
      g.kills.push(k); g.last = k.t;
    }
    for (const g of open.values()) flush(g);
  }

  // ---- the living world: weather changes, caravan raids and trades, chat lines (the sim keeps g.worldLog), naval battles ----
  for (const w of g.worldLog || []) {
    if (w.type === 'weather') add({ t: w.t, type: 'weather_change', kind: w.kind, from: w.from });
    else if (w.type === 'caravan_raid') add({ t: w.t, type: 'caravan_raid', p: w.p, gold: w.gold, loc: [w.x, w.y] });
    else if (w.type === 'caravan_trade') add({ t: w.t, type: 'caravan_trade', paid: w.paid, loc: [w.x, w.y] });
    else if (w.type === 'chat') add({ t: w.t, type: 'chat', p: w.p, text: w.text });
  }
  {
    const ships = kills.filter((k) => k.kind === 'unit' && UNITS[k.type]?.cls === 'naval');
    const groups = [];
    for (const k of ships) {
      let c = groups.find((x) => k.t - x.last <= NAVAL_GAP_TICKS && Math.hypot(k.x - x.cx, k.y - x.cy) <= NAVAL_RADIUS);
      if (!c) { c = { t0: k.t, last: k.t, cx: k.x, cy: k.y, kills: [] }; groups.push(c); }
      c.kills.push(k); c.last = k.t;
    }
    for (const c of groups) {
      const value = c.kills.reduce((a, k) => a + k.value, 0), lost = {};
      for (const k of c.kills) lost[k.owner] = (lost[k.owner] || 0) + 1;
      if (c.kills.length >= 2 || value >= 150) add({ t: c.t0, type: 'naval_battle', t_end: c.last, loc: [r1(c.cx), r1(c.cy)], value, ships_lost: lost, by: [...new Set(c.kills.map((k) => k.by))] });
    }
  }

  // ---- God mode: every intervention of the spectator (and its outcome) shows on the ticker ----
  for (const f of g.godFeed) add({ t: f.t, type: 'god', text: f.text, kind: f.kind, p: f.p || 0 });

  // ---- resign / victory ----
  for (const c of rep.cmds) if (c.cmd.cmd === 'resign' && c.ok !== false && c.t <= endTick) add({ t: c.t, type: 'resign', p: c.p });
  if (g.over) add({ t: endTick, type: 'victory', winner_team: g.winnerTeam, winner: g.winnerTeam ? g.players.find((p) => p && p.team === g.winnerTeam)?.id ?? null : null, reason: g.endReason });

  // ---- LLM decisions ----
  const ioBy = new Map();
  for (const e of rep.io) ioBy.set(`${e.p}:${e.n}`, e);
  const byReq = new Map();
  for (const c of rep.cmds) if (c.req !== undefined) { const k = `${c.p}:${c.req}`; if (!byReq.has(k)) byReq.set(k, []); byReq.get(k).push(c); }
  const starts = {};
  for (const e of rep.io) (starts[e.p] ||= []).push(e.tick);
  for (const e of rep.io) {
    const key = `${e.p}:${e.n}`;
    if (e.error) { add({ t: Math.min(endTick, e.tick + Math.ceil((e.latency_ms || 0) / 100)), type: 'llm_error', p: e.p, n: e.n, start_tick: e.tick, kind: e.error.kind, message: e.error.message, latency_ms: e.latency_ms }); continue; }
    const cs = byReq.get(key) || [];
    const note = cs.find((c) => c.cmd.cmd === 'note');
    const ords = cs.filter((c) => c.cmd.cmd !== 'note');
    let land = cs.length ? cs[0].t : null, estimated = false;
    if (land === null) {
      const nextStart = (starts[e.p] || []).find((t) => t > e.tick);
      land = Math.min(nextStart ?? Infinity, e.tick + Math.ceil((decisionCost(e).latency_ms || 0) / 100));
      estimated = true;
    }
    if (land > endTick) continue;
    add({
      t: land, type: 'llm_decision', p: e.p, n: e.n, start_tick: e.tick, estimated,
      thought: note ? cleanThought(note.cmd.text) : null, // no log tag, no filler sentence (tools/lib/thought.mjs)
      orders: ords.map((c) => c.cmd.cmd),
      summary: summarize(ords.map((c) => c.cmd)),
      rejected: ords.filter((c) => c.ok === false).length,
      ...decisionCost(e), prompt_tokens: e.prompt_tokens ?? null,
      tok_s: e.tok_s != null ? r1(e.tok_s) : null, finish_reason: e.finish_reason ?? null,
      errors: (e.errors || []).map((x) => x.error),
      seen: digestObservation(e.user), // what the model was shown (fog-limited observation)
      subjects: resolveSubjects(e.user, ords.concat(note ? [note] : []).map((c) => c.cmd), e.p), // what the decision is about (units / buildings named in the log)
    });
  }

  events.sort((a, b) => a.t - b.t || (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || (a.p ?? 0) - (b.p ?? 0) || (a.n ?? 0) - (b.n ?? 0));
  events.forEach((e, i) => { e.id = i + 1; });
  const resultFile = rep.result ? { winner_team: rep.result.winnerTeam, reason: rep.result.reason, tick: rep.result.tick } : null;
  return {
    version: EVENTS_VERSION, replay: rep.id, seed: rep.seed, map: rep.start.map, tick_hz: TICK_HZ, ticks: endTick, seconds: endTick / TICK_HZ,
    players: rep.players, starts: g.starts, result: resultFile, end_hash: g.hash(),
    final: g.players.filter(Boolean).filter((p) => p.id > 0).map((p) => ({ p: p.id, kills: p.kills, losses: p.losses, kill_value: p.killValue, lost_value: p.lostValue, gathered: Object.values(p.gathered).reduce((a, b) => a + b, 0), score: g.score(p), tier: p.tier, alive: p.alive })),
    verified: { states_checked: checked, first_mismatch_tick: firstBad, ok: firstBad === null && checked > 0 }, events,
    structures: [...structs.values()],
    roster: (() => { for (const [k, o] of openU) rosterOut.push([k, o]); const r = {}; for (const [k, [a, b]] of rosterOut) { const [pl, ty] = k.split(':'); ((r[pl] ||= {})[ty] ||= []).push([a, b]); } return r; })(),
    series: { per_second: true, army: S.army, workers: S.workers, army_types: S.army_types, lost: S.lost, fighting: S.fight, destroyed: S.destroyed, focus_x: S.fx, focus_y: S.fy, focus_spread: S.spread },
  };
}

const ORDER = { weather_change: 0.5, first_contact: 0, tier_up: 1, key_building: 2, expansion: 3, battle: 4, losses: 4.5, momentum_swing: 5, naval_battle: 4.6, caravan_raid: 5.5, caravan_trade: 5.6, chat: 5.7, building_destroyed: 6, base_destroyed: 7, wonder_started: 7.1, wonder_warning: 7.2, wonder_destroyed: 7.3, wonder_completed: 7.4, control_point_captured: 7.5, control_victory: 7.6, llm_decision: 8, llm_error: 9, resign: 10, victory: 11 };

function summarize(cmds) {
  const parts = [];
  for (const c of cmds) {
    if (c.cmd === 'train') parts.push(`train ${c.count ?? 1}x ${c.unit_type}`);
    else if (c.cmd === 'build') parts.push(`build ${c.building_type}`);
    else if (c.cmd === 'research') parts.push(`research ${c.tech}`);
    else if (c.cmd === 'attack_move') parts.push('attack');
    else if (c.cmd === 'advance_tier') parts.push('advance tier');
    else if (c.cmd !== 'gather' && c.cmd !== 'set_rally') parts.push(c.cmd);
  }
  return parts.slice(0, 4).join(', ');
}

// stable text form (used by tests and for writing the file)
export function eventsToJson(ev) { return JSON.stringify(ev); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const src = a.find((x) => !x.startsWith('--'));
  if (!src) { console.error('usage: node tools/events.mjs replays/<id> [--out events.json]'); process.exit(2); }
  const oi = a.indexOf('--out');
  const rep = loadReplay(src);
  const ev = computeEvents(rep);
  const out = oi >= 0 ? a[oi + 1] : path.join(rep.dir, 'events.json');
  fs.writeFileSync(out, JSON.stringify(ev));
  if (!ev.verified.ok) console.error(`WARNING: re-simulation does not match the recorded state hashes (first mismatch at tick ${ev.verified.first_mismatch_tick}); the sim changed since this replay was recorded?`);
  const counts = {};
  for (const e of ev.events) counts[e.type] = (counts[e.type] || 0) + 1;
  console.log(`${out}: ${ev.events.length} events, ${ev.seconds}s game time`, JSON.stringify(counts));
}
