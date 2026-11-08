#!/usr/bin/env node
// Solo runner (A3a): one model (or mock, or null agent) plays one scenario against a scripted bot of a given level.
// It drives the existing LiveMatch (server/live-match.mjs), it does not run a match loop of its own.
//   node tools/solo/run-solo.mjs --scenario <id|file> --level 3 [--style boom] --player <config.json|mock:<bot>:<delay_ms>|null>
//        --seeds 1,2,3 [--seats 1,2] --out <dir> [--speed 1] [--seed-set tune|board] [--box-class "32 GB"] [--theme default] [--bot-chat]
//
// What it adds on top of LiveMatch:
//   - box check before the first tick: the LLM base URL must answer (GET <base>/models), else the run is not started
//   - the scenario cutoff is handed over as LiveMatch's maxGameSeconds: the match ends with reason "cutoff" and no winner
//     (live-match.mjs: maxTicks, finish()). It must lie below the rules time limit, else the sim would end it with a tie-break winner.
//   - the opponent seat is a scripted bot of the level (0 = "idle", 3 = the style bot, default boom); the model seat can be 1 or 2
//   - the chat of the bots is off (plan A1: the opening line of a style bot names the style); option botChat / --bot-chat turns it on, the key says which
//   - runMeta.json next to result.json (result.json is not touched): solo marker, key fields, pacer.dropped, largest delay, validity, verdict
//   - seeds: seedSet "board" only for the unchanged, frozen scenario file and a seed from its board list; the played list and its hash go into the key.
//     Without seedSet the seed is free: the run is kept, but it is no board run (the report says so)
//   - why the match ended (tools/lib/end-cause.mjs) is tracked while the match runs and goes to the judge and runMeta.json
// Not in here (later packages): the ladder with stop rule and 4 styles x 2 seats (A3b), levels 1 and 2 (A1b).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LiveMatch } from '../../server/live-match.mjs';
import { startMock } from '../../agents/llm/mock-server.mjs';
import { BOT_NAMES, STYLE_BOT_NAMES } from '../../agents/scripted/index.mjs';
import { resolveConfig } from '../../agents/llm/client.mjs';
import { TICK_HZ } from '../../sim/util.mjs';
import { trackEndCause, classifyEnd } from '../lib/end-cause.mjs';
import { NullAgent } from './null-agent.mjs';
import { worldOptions } from '../../agents/scripted/world-bot.mjs';
import { loadScenario, resolveScenarioRules, hashRules, verifyBoardSeeds, seedsHash, scenarioIdentity } from './scenario.mjs';
import { judge as judgeSolo } from './judge.mjs';
import { RUN_META_SCHEMA, sha256, writeRunMeta } from './meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Proposal of the plan (A1): no valid answer for 3 minutes while requests keep failing = the model server is dead. Not measured yet; set before the pilot.
export const DEAD_SERVER_S = 180;

export class SoloPreflightError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SoloPreflightError';
    this.code = 'SOLO_BOX_DOWN';
    this.detail = detail;
  }
}

// ---------------- opponent ----------------
// level 0 -> "idle" (agents/scripted/idle.mjs), level 3 -> the style bot (default boom). Levels 1 and 2 come with A1b ("<bot>@<n>").
export function levelBot(level, style) {
  const lv = Number(level);
  if (lv === 0) return 'idle';
  if (lv === 3) return style || 'boom';
  return `${style || 'boom'}@${lv}`;
}

// level 3 plays one of the four style bots (never "idle": that is level 0); levels 1 and 2 are not built yet
function checkBot(bot, level) {
  const lv = Number(level);
  if (lv === 0 ? bot === 'idle' : lv === 3 && STYLE_BOT_NAMES.includes(bot)) return;
  const why = lv === 0 ? 'level 0 is the idle bot' : lv === 3 ? `level 3 needs a style bot (have: ${STYLE_BOT_NAMES.join(', ')})` : 'levels 1 and 2 need the name parser from A1b';
  throw new Error(`opponent "${bot}" (level ${level}) is not available: ${why}`);
}

// Hash of the bot code (agents/scripted, with the level table if it lives there). Bot code is outside sim/, the sim version does not see it.
export function botVersion(root = ROOT) {
  const dir = path.join(root, 'agents', 'scripted'), files = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (/\.(mjs|js|json)$/.test(e.name)) files.push(r);
    }
  };
  walk('');
  const h = files.sort().map((f) => `--- ${f} ---\n` + fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')).join('\n');
  return 'bots-' + sha256(h).slice(0, 12);
}

// ---------------- box check ----------------
// GET <base_url>/models. ok = the server answered (2xx, or 404/405 when it has no model list). Network error, timeout, 401/403 and 5xx are not ok.
export async function checkBox(cfg, { timeoutMs = 20000 } = {}) {
  const base = String(cfg.base_url).replace(/\/+$/, '');
  const url = base + '/models';
  const out = { url, ok: false, status: null, ms: null, error: null, model_listed: null, warn: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: 'GET', headers: cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}, signal: ctl.signal });
    const text = await r.text();
    out.ms = Math.round(performance.now() - t0);
    out.status = r.status;
    if (r.status >= 200 && r.status < 300) {
      out.ok = true;
      try {
        const ids = (JSON.parse(text).data || []).map((m) => m.id);
        if (ids.length) {
          out.model_listed = ids.includes(cfg.model);
          if (!out.model_listed) out.warn = `server answers, but model "${cfg.model}" is not in its list`;
        }
      } catch { /* no JSON list: fine */ }
    } else if (r.status === 404 || r.status === 405) {
      out.ok = true;
      out.warn = `server answers, but has no model list (HTTP ${r.status})`;
    } else {
      out.error = r.status === 401 || r.status === 403 ? `HTTP ${r.status}: the server refuses the key` : `HTTP ${r.status}`;
    }
  } catch (e) {
    out.ms = Math.round(performance.now() - t0);
    out.error = ctl.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : `not reachable (${e.cause?.code || e.message})`;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

// ---------------- player ----------------
// player: LLM config (as in players.json / configs/*.json, or a path to such a file), { type: 'mock', strategy, delay_ms }, or { type: 'null' }
async function preparePlayer(player) {
  let p = player;
  if (typeof p === 'string') {
    try { p = JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')); } catch (e) { throw new Error(`player config "${player}": ${e.message}`); }
  }
  if (!p || typeof p !== 'object') throw new Error('runSolo: "player" is required (LLM config, { type: "mock" } or { type: "null" })');
  if (p.type === 'null') {
    const agent = { name: p.name || 'Null agent', model: 'null-agent', hardware: 'none, sends no orders', commands: Array.isArray(p.standing) ? p.standing : [] };
    // placeholder LLM config only so that LiveMatch can build the slot; the agent is swapped for a NullAgent right after
    return { type: 'null', anchor: 'null', spec: { name: agent.name, base_url: 'http://127.0.0.1:9/v1', model: agent.model, hardware: agent.hardware }, agent, cfg: null, close: async () => {} };
  }
  if (p.type === 'mock') {
    const strategy = p.strategy || 'boom';
    if (!BOT_NAMES.includes(strategy)) throw new Error(`mock strategy "${strategy}" is not a scripted bot (have: ${BOT_NAMES.join(', ')})`);
    const delay = Math.round(Number(p.delay_ms ?? 150));
    if (!(delay >= 0)) throw new Error(`mock delay_ms must be >= 0 (got ${p.delay_ms})`);
    // same mock as the arena makes (server/arena.mjs: mockUrl and the mock config); a long delay needs a longer request timeout
    const mock = await startMock({ strategy, delayMs: delay, jitterMs: Math.round(delay / 4), tokS: 80, seed: 7, ...(p.mock_opts || {}) });
    const spec = {
      name: p.name || `Mock ${strategy}`, base_url: mock.url, model: `mock-${strategy}`, hardware: p.hardware || `mock server, ${delay} ms`, thinking: false, max_tokens: 1024,
      timeout_s: Math.max(30, Math.ceil((delay * 1.25) / 1000) + 10), min_interval_s: 1, sampling: { temperature: 0.6, seed: 42 }, ...(p.class ? { class: p.class } : {}),
    };
    return { type: 'mock', anchor: `mock:${strategy}:${delay}`, strategy, delay_ms: delay, spec, cfg: resolveConfig(spec), close: () => mock.close() };
  }
  const { type, kind, saved, ...raw } = p; // players.json carries bookkeeping fields that are no harness settings
  void type; void kind; void saved;
  const cfg = resolveConfig(raw);
  return { type: 'llm', anchor: null, spec: raw, cfg, close: async () => {} };
}

// ---------------- one run ----------------
// -> { replayDir, judge, runMeta }
//   scenario   id or file (loadScenario), or an object that passes validateScenario (resolveScenarioRules refuses anything else)
//   level      0 (idle) or 3 (style bot); modelSeat 1 or 2; seed; player (see preparePlayer); outDir = replay root (a run folder is made inside)
//   optional   speed (default scenario.speed or 1), style (level 3, default boom), runIndex (0 = first try; a re-run after an invalid run counts up),
//              seedSet ('tune'|'board'), boxClass, theme, deadServerS, signal (AbortSignal: stops the run, it is then invalid), onFrame(match),
//              botChat (default false: the bots stay silent)
export async function runSolo({ scenario: scenarioArg, level, modelSeat, seed, player, outDir, speed, style, runIndex = 0, seedSet = null, boxClass = null, theme, deadServerS = DEAD_SERVER_S, signal, onFrame: userFrame, preflightTimeoutMs, botChat = false } = {}) {
  // TUNE (agents/scripted/common.mjs) changes bot parameters for the whole process and is no part of bot_version: plan A3 "not via TUNE"
  if (process.env.TUNE) throw new Error('runSolo: the environment variable TUNE is set. It changes bot parameters for the whole process and is not in bot_version, so the opponent would not be the level bot. Unset TUNE and run again.');
  const scenario = typeof scenarioArg === 'string' ? loadScenario(scenarioArg) : scenarioArg;
  if (!scenario || typeof scenario !== 'object') throw new Error('runSolo: "scenario" is required (id, file or object)');
  if (!outDir) throw new Error('runSolo: "outDir" is required');
  if (!Number.isFinite(+seed)) throw new Error('runSolo: "seed" must be a number');
  const seat = Number(modelSeat), opp = seat === 1 ? 2 : 1;
  if (seat !== 1 && seat !== 2) throw new Error(`runSolo: modelSeat must be 1 or 2 (got ${modelSeat})`);
  if (Array.isArray(scenario.modelSeats) && !scenario.modelSeats.includes(seat)) throw new Error(`scenario ${scenario.id}: model seat ${seat} is not allowed (modelSeats ${JSON.stringify(scenario.modelSeats)})`);
  if (Array.isArray(scenario.levels) && scenario.levels.length === 2 && !(level >= scenario.levels[0] && level <= scenario.levels[1])) throw new Error(`scenario ${scenario.id}: level ${level} is outside ${JSON.stringify(scenario.levels)}`);
  // The scenario validator (resolveScenarioRules throws) already demands cutoff < sim time limit: at the sim limit the sim itself would crown
  // a score or seed winner. The cutoff goes to LiveMatch as maxGameSeconds; the match then ends with reason "cutoff" and no winner.
  const rules = resolveScenarioRules(scenario);
  const cutoff = Number(scenario.maxGameSeconds);
  // identity of the scenario: the file hash only for an unchanged scenario file; a changed copy (same id, other cutoff or seeds) gets a hash of its content
  const identity = scenarioIdentity(scenario);
  let seedList = null, boardFrozen = null;
  if (seedSet !== null && seedSet !== undefined) {
    // seeds come from the frozen lists and are never picked after a result
    const list = scenario.seeds?.[seedSet];
    if (!Array.isArray(list)) throw new Error(`scenario ${scenario.id}: seedSet must be "tune" or "board" (got ${JSON.stringify(seedSet)})`);
    if (!list.includes(+seed)) throw new Error(`scenario ${scenario.id}: seed ${seed} is not in seeds.${seedSet}`);
    seedList = list.slice();
    if (seedSet === 'board') {
      // a board run is only a board run for the frozen list (scenarios/SEEDS-HASH.txt) of the unchanged scenario file
      const frozen = verifyBoardSeeds(scenario);
      if (!frozen.ok) throw new Error(`scenario ${scenario.id}: no board run, the board seeds are not frozen: ${frozen.error}`);
      if (!identity.official) throw new Error(`scenario ${scenario.id}: no board run, the scenario is not the unchanged file in scenarios/ (a changed copy or a file elsewhere is a probe: use seedSet "tune")`);
      boardFrozen = true;
    }
  }
  const bot = levelBot(level, style);
  checkBot(bot, level);
  const tempo = Number(speed ?? scenario.speed ?? 1);
  if (!(tempo > 0)) throw new Error(`runSolo: speed must be > 0 (got ${speed})`);

  const pl = await preparePlayer(player);
  const chat0 = worldOptions.chat; // process-wide switch of the bots (agents/scripted/world-bot.mjs): runs of one process follow each other, never in parallel; restored at the end
  worldOptions.chat = !!botChat;
  try {
    // ---- box check: nothing is recorded when the box does not answer ----
    let preflight = null;
    if (pl.cfg) {
      preflight = await checkBox(pl.cfg, { timeoutMs: preflightTimeoutMs });
      if (!preflight.ok) throw new SoloPreflightError(`box check failed, run not started: LLM server ${preflight.url} - ${preflight.error}. Start the model server (or fix base_url / key) and run again.`, preflight);
    }

    const specs = [null, null];
    specs[seat - 1] = pl.spec;
    specs[opp - 1] = `scripted:${bot}`;
    const cls = boxClass || pl.cfg?.class || undefined;
    const live = new LiveMatch({ seed: +seed, specs, record: true, outRoot: path.resolve(outDir), rules, maxGameSeconds: cutoff, ...(cls ? { cls } : {}) });
    if (pl.type === 'null') {
      live.slots[seat - 1].agent.stop(); // the placeholder LlmPlayer never sent anything
      live.slots[seat - 1].agent = new NullAgent(pl.agent);
      fs.writeFileSync(path.join(live.dir, 'players.json'), JSON.stringify(live.slots.map((s) => (s.kind === 'llm' ? { kind: 'null', name: s.name, model: s.model, hardware: s.hw } : { kind: 'bot', bot: s.botName })), null, 1));
    }
    const tracker = trackEndCause(live.game);
    const dir = live.dir;
    const scenarioHash = identity.hash;
    const startLine = JSON.parse(fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n', 1)[0]);
    const cfg = pl.cfg;
    const harness = cfg ? { max_tokens: cfg.max_tokens, timeout_s: cfg.timeout_s, thinking: cfg.thinking, min_interval_s: cfg.min_interval_s, sampling: cfg.sampling, reasoning_budget_tokens: cfg.reasoning_budget_tokens, stream: cfg.stream } : null;
    const keys = {
      scenario_hash: scenarioHash, level: Number(level), seed_set: seedSet, seed_list_hash: seedList ? seedsHash(seedList) : null, speed: tempo, prompt_hash: startLine.prompt_hash, sim_version: startLine.sim_version,
      rules_hash: hashRules(live.rules), bot_version: botVersion(), bot_chat: !!botChat, harness, theme: theme || scenario.theme || 'default', box_class: cls || null,
    };
    const model = {
      type: pl.type, anchor: pl.anchor, name: live.slots[seat - 1].name, model: live.slots[seat - 1].model, hardware: live.slots[seat - 1].hw,
      quant: cfg?.quant ?? null, creator: cfg?.creator ?? null, class: cls || null,
      ...(pl.type === 'mock' ? { strategy: pl.strategy, delay_ms: pl.delay_ms } : {}),
    };
    const meta = {
      schema: RUN_META_SCHEMA, status: 'running', runner: { name: 'solo-runner-1', node: process.version },
      // marker for the ranking protection (server/results.mjs rankedOf): a solo run never ranks
      solo: { scenario: scenario.id, level: Number(level), seed: +seed, runIndex }, ranked: false,
      scenario: { id: scenario.id, name: scenario.name ?? null, version: scenario.version ?? null, goal: scenario.goal ?? null, preset: rules.preset, hash: scenarioHash, from_file: identity.fromFile, official: identity.official, speed: scenario.speed ?? null },
      level: Number(level), style: Number(level) === 0 ? null : bot, opponent: { bot, level: Number(level), seat: opp }, model_seat: seat, seed: +seed, seed_set: seedSet,
      // the list this seed was taken from and whether it is the frozen board list; the report needs both for a board verdict
      seed_list: seedList, board_frozen: boardFrozen,
      speed: tempo, cutoff_s: cutoff, player: model, keys, preflight, replay_id: live.id, started_at: new Date().toISOString(),
      // plan A7 (pilot without A5): the model reads the old 1-vs-1 prompt. It calls the opponent "another AI" and names a score win after the sim time limit; the cutoff is not in it.
      prompt_note: `old 1-vs-1 prompt ${startLine.prompt_version} (no solo briefing yet, A5): it names another AI as opponent and a score win at the sim time limit; the scenario cutoff is not in it`,
    };
    writeRunMeta(dir, meta);

    // ---- run, watch the pacer and the model server ----
    const st = { frames: 0, max_frame_gap_ms: 0, max_burst_ticks: 0, first_drop_game_s: null };
    let lastWall = performance.now(), lastIssued = 0, abort = null, crash = null;
    const llmSlot = live.slots.find((s) => s.kind === 'llm' && typeof s.agent.errStreak === 'number');
    let okSeen = 0, lastOkWall = lastWall;
    const stop = (why) => { if (!abort) { abort = why; live.finish(); } };
    if (signal) {
      if (signal.aborted) stop('stopped');
      else signal.addEventListener('abort', () => stop('stopped'), { once: true });
    }
    const onFrame = (m) => {
      const now = performance.now();
      st.frames++;
      st.max_frame_gap_ms = Math.max(st.max_frame_gap_ms, now - lastWall);
      lastWall = now;
      const issued = m.pacer.issued;
      st.max_burst_ticks = Math.max(st.max_burst_ticks, issued - lastIssued);
      lastIssued = issued;
      if (m.pacer.dropped > 0 && st.first_drop_game_s === null) st.first_drop_game_s = m.game.t / TICK_HZ;
      if (llmSlot) {
        const a = llmSlot.agent;
        if (a.m.ok > okSeen) { okSeen = a.m.ok; lastOkWall = now; }
        // dead = requests keep failing and no valid answer for a while; a long thinking pause of a slow model is no failure
        if (a.errStreak > 0 && now - lastOkWall > deadServerS * 1000) stop('model_server_dead');
      }
      if (userFrame) userFrame(m);
    };
    const wall0 = performance.now();
    try {
      await live.run({ speed: tempo, onFrame });
    } catch (e) {
      crash = e;
      try { live.finish(); } catch { /* the state is whatever it is */ }
    }
    const wallSeconds = +((performance.now() - wall0) / 1000).toFixed(1);

    // ---- close the books ----
    const res = live.result || null;
    // maxDelayMs = the longest wall-clock gap between two frames of the run loop (a healthy loop shows ~10-30 ms); the judge reads pacer.dropped and pacer.maxDelayMs
    const pacer = { dropped: live.pacer?.dropped ?? null, issued: live.pacer?.issued ?? null, frames: st.frames, maxDelayMs: Math.round(st.max_frame_gap_ms), maxBurstTicks: st.max_burst_ticks, maxBurstS: +(st.max_burst_ticks / TICK_HZ).toFixed(2), firstDropGameS: st.first_drop_game_s };
    const invalid = [];
    if (crash) invalid.push(`crash: ${String(crash.message).slice(0, 200)}`);
    if (abort) invalid.push(abort);
    if (pacer.dropped > 0) invalid.push('pacer_dropped');
    const a = res?.agents?.[seat - 1] || null;
    const mins = res ? res.seconds / 60 : 0;
    const modelStats = a && {
      rounds: a.rounds ?? 0, requests: a.requests ?? 0, replies: a.replies ?? 0, errors: a.errors ?? 0, timeouts: a.timeouts ?? 0, parse_errors: a.parse_errors ?? 0,
      commands_applied: a.commands_applied ?? 0, commands_rejected: a.commands_rejected ?? 0, commands_invalid: a.commands_invalid ?? 0,
      latency_median_ms: a.latency_ms?.median ?? null, latency_p90_ms: a.latency_ms?.p90 ?? null, latency_max_ms: a.latency_ms?.max ?? null,
      prompt_tokens: a.prompt_tokens ?? 0, completion_tokens: a.completion_tokens ?? 0, tok_s_avg: a.tok_s_avg ?? null,
      decisions_per_min: mins > 0 ? +((a.rounds ?? 0) / mins).toFixed(2) : null,
    };
    let verdict;
    if (res) {
      try {
        verdict = judgeSolo({
          result: res, logPath: path.join(dir, 'log.jsonl'), scenario, modelSeat: seat,
          runMeta: { crashed: !!crash, error: crash ? String(crash.message) : undefined, abort: abort || undefined, pacer: { dropped: pacer.dropped, maxDelayMs: pacer.maxDelayMs } },
          endSummary: tracker.summary(), // taken during the live run: no re-simulation needed
        });
      } catch (e) {
        verdict = { outcome: 'invalid', endClass: 'unknown', reason: `judge failed: ${e.message}`, metrics: {}, notes: [], end: null };
      }
    } else {
      verdict = { outcome: 'invalid', endClass: 'unknown', reason: 'no result (run crashed)', metrics: {}, notes: [] };
    }
    // end class: the judge's own (one place decides); only when the judge gave none (crash, pacer drop) the live tracker is asked
    const end = verdict.end ?? (res ? classifyEnd(res, tracker.summary(), { over: live.game.over }) : null);
    const runMeta = {
      ...meta, status: 'done', valid: invalid.length === 0, invalid_reasons: invalid, finished_at: new Date().toISOString(), wall_seconds: wallSeconds,
      pacer, end, end_cause: tracker.summary(),
      game: res && { seconds: res.seconds, ticks: res.ticks, over: res.over, reason: res.reason, winnerTeam: res.winnerTeam, hash: res.hash },
      model: modelStats, judge: verdict,
    };
    writeRunMeta(dir, runMeta);
    return { replayDir: dir, judge: verdict, runMeta };
  } finally {
    worldOptions.chat = chat0;
    await pl.close();
  }
}

// ---------------- several runs, one after the other ----------------
// games: [{ seed, modelSeat, style?, runIndex?, level? }]; or seeds + seats: every seed is played from every seat (seat swap), seat after seat.
// runSolo handles a failing game itself (the run is recorded as invalid), so anything thrown here is a set-up problem (bad input, box down)
// and stops the series at once: the next seed would fail the same way.
export async function runSeries({ games, seeds, seats = [1, 2], onRun, ...common } = {}) {
  const list = games || (seeds || []).flatMap((seed) => seats.map((modelSeat) => ({ seed, modelSeat })));
  if (!list.length) throw new Error('runSeries: no games (pass "games", or "seeds" and "seats")');
  const out = [];
  for (const g of list) {
    const r = await runSolo({ ...common, ...g });
    out.push(r);
    if (onRun) onRun(r);
  }
  return out;
}

// ---------------- command line ----------------
function parseArgs(argv) {
  const A = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const nx = argv[i + 1];
    if (nx === undefined || nx.startsWith('--')) A[argv[i].slice(2)] = true;
    else { A[argv[i].slice(2)] = nx; i++; }
  }
  return A;
}

function playerFromArg(s) {
  if (s === 'null') return { type: 'null' };
  const m = /^mock:([a-z]+)(?::(\d+))?$/.exec(s || '');
  if (m) return { type: 'mock', strategy: m[1], delay_ms: m[2] !== undefined ? +m[2] : 150 };
  return s;
}

async function main() {
  const A = parseArgs(process.argv.slice(2));
  if (!A.scenario || !A.player || !A.seeds || !A.out || A.level === undefined) {
    console.error('usage: node tools/solo/run-solo.mjs --scenario <id|file> --level <0|3> --player <config.json|mock:<bot>:<delay_ms>|null> --seeds 1,2,3 --out <dir> [--seats 1,2] [--style boom] [--speed 1] [--seed-set tune|board] [--box-class "32 GB"] [--theme default] [--bot-chat]\n  without --seed-set the seeds are free: the runs are kept, but they are no board runs');
    process.exit(2);
  }
  try {
    const runs = await runSeries({
      scenario: A.scenario, level: +A.level, player: playerFromArg(A.player), seeds: String(A.seeds).split(',').map(Number), seats: A.seats ? String(A.seats).split(',').map(Number) : [1, 2],
      outDir: A.out, ...(A.speed ? { speed: +A.speed } : {}), ...(A.style ? { style: A.style } : {}), ...(A['seed-set'] ? { seedSet: A['seed-set'] } : {}),
      ...(A['box-class'] ? { boxClass: A['box-class'] } : {}), ...(A.theme ? { theme: A.theme } : {}), ...(A['bot-chat'] ? { botChat: true } : {}),
      onRun: (r) => console.log(`seed ${r.runMeta.seed} seat ${r.runMeta.model_seat}: ${r.judge.outcome} (${r.judge.reason})${r.runMeta.valid ? '' : ' INVALID ' + r.runMeta.invalid_reasons.join(',')} ${r.replayDir}`),
    });
    // 4 = at least one run is invalid and has to be run again with the same seed
    process.exit(runs.some((r) => !r.runMeta.valid) ? 4 : 0);
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof SoloPreflightError ? 3 : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
