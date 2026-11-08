// Judge of a solo run, computed after the fact from result.json and log.jsonl. Never from live game events and never from what the
// model said: a resign or a "gg" in the log is only read as a command, the verdict comes from how the match really ended.
//
//   judge({ result, logPath, scenario, modelSeat, runMeta?, endSummary?, resim? })
//     result      parsed result.json of the run (null: the result line of log.jsonl is used)
//     logPath     the replay folder or its log.jsonl (an io.jsonl next to it is read for cut-off replies)
//     scenario    a loaded scenario (needs goal / judge.kind, and judge.tierTarget for "eco")
//     modelSeat   seat number (1-based) of the model; the other seats are bots
//     runMeta     optional, from the runner: { crashed, error, abort, pacer: { dropped, maxDelayMs } }
//                 abort = why the run was stopped from outside ("stopped", "model_server_dead"): such a run is "invalid", whatever the log shows
//     endSummary  optional trackEndCause(...).summary() taken during the live run (skips the re-simulation of the end class; goal "eco"
//                 still re-simulates once for the exact tier time)
//     resim       default true: re-simulate the replay with its own sim version to find out how the last base fell
//   -> { outcome, endClass, reason, metrics, notes, end }
//
//   outcome   goal "destroy": "win" | "loss" | "cutoff" | "invalid".  goal "eco": "measured" | "invalid" (no win or loss word).
//             "cutoff" counts as a loss in the lists. "invalid" = rerun with the same seed (crash, a run stopped from outside, pacer.dropped > 0,
//             no log or result, a "cutoff" that came before the scenario cutoff, or an end class that cannot be determined). The rule is blind for
//             the result: an unknown end class is invalid for a model win and for a model loss alike.
//   endClass  destroyed | decay | wonder | shrine | resign | mutual | time | cutoff | unknown   (tools/lib/end-cause.mjs)
//   win       only endClass "destroyed" (stranded included) with the model's team as winner. Decay (sudden death), mutual destruction
//             (also with a seed tie-break winner), time limit, cutoff, wonder, shrine, resign are never a win.
//   end       { cls, stranded, decayMutual, inferred, source: "resim" | "endSummary" | "log" }
//
// How the end class is found. 1. A resim of the replay with its stamped sim version, accepted only when every logged state hash and
// the final hash of result.json are reproduced. It tells whether the last critical building fell to an attack or to decay.
// 2. Otherwise the class is inferred from the result and the rules in the start line (note "inferred"): a victory without sudden death
// in the rules and without a resign command can only be a destruction.
import fs from 'node:fs';
import path from 'node:path';
import { classifyEnd, trackEndCause, sdStartOf } from '../lib/end-cause.mjs';
import { loadReplay, newGame, ReplaySim } from '../lib/replay.mjs';
import { stampedVersion } from '../../sim-versions/lib.mjs';
import { resolveRules } from '../../sim/rules.mjs';
import { TICK_HZ } from '../../sim/util.mjs';
import { canonical, ruleInput } from './scenario.mjs';

const TIERS = [2, 3];
const ZERO_G = { food: 0, wood: 0, stone: 0, gold: 0 };

function readLines(file, notes) {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    try { lines.push(JSON.parse(raw[i])); } catch (e) {
      if (i === raw.length - 1) { notes.push('last log line is cut off and was ignored (the run did not shut down cleanly)'); break; }
      throw new Error(`log line ${i + 1} is not JSON`);
    }
  }
  return lines;
}

// class of the end from the result and the log only (no re-simulation)
function inferEnd(res, start, cmds) {
  const reason = res.reason || '';
  const over = res.over !== false && reason !== 'cutoff';
  const resigned = cmds.some((c) => c.cmd?.cmd === 'resign' && c.ok);
  if (over && reason.startsWith('no result')) return { cls: 'time', inferred: true }; // technical stop of the war preset
  const sdStartS = sdStartOf(start?.rules); // no rules in the start line = the classic default of an old log = no sudden death
  const e = classifyEnd(res, null, { over, resigned, sdStartS });
  if (e.cls === 'unknown' && reason === 'victory' && !sdStartS) return { cls: 'destroyed', inferred: true };
  return e;
}

// Re-simulation. Accepted only if it reproduces every logged state hash and the result.
function resimulate(dir, file, start, res) {
  const out = { ok: false, why: '' };
  let rep;
  try {
    if (!stampedVersion(dir, start)) { out.why = 'the replay has no sim version stamp'; return out; }
    rep = loadReplay(file);
  } catch (e) { out.why = `cannot load the replay (${e.message.split('\n')[0]})`; return out; }
  const g = newGame(rep), tr = trackEndCause(g), sim = new ReplaySim(rep, g);
  const stateAt = new Map(rep.states.map((s) => [s.t, s.hash]));
  const tierAt = {}; // pid -> { tier: first tick }
  let bad = null;
  while (sim.step()) {
    for (const p of g.players) {
      if (!p) continue;
      const m = (tierAt[p.id] ||= {});
      for (const t of TIERS) if (p.tier >= t && m[t] === undefined) m[t] = g.t;
    }
    if (stateAt.has(g.t) && g.hash() !== stateAt.get(g.t)) { bad = g.t; break; }
  }
  if (bad !== null) { out.why = `the replay drifts from its recording at tick ${bad}`; return out; }
  const r = g.result();
  if (res.hash !== undefined && res.hash !== g.hash()) { out.why = 'the final hash differs from result.json'; return out; }
  if (res.winnerTeam !== undefined && r.winnerTeam !== res.winnerTeam) { out.why = 'the winner differs from the result'; return out; }
  return { ok: true, simVersion: rep.simVersion, end: classifyEnd(r, tr.summary(), { over: g.over }), over: g.over, reason: r.reason, tierAt };
}

// first state line in which the seat has the tier (upper bound, resolution 10 s)
function tierFromStates(lines, seat) {
  const out = {};
  for (const t of TIERS) out[t] = null;
  for (const l of lines) {
    if (l.type !== 'state') continue;
    const p = l.players?.find((x) => x.id === seat);
    if (!p) continue;
    for (const t of TIERS) if (out[t] === null && p.tier >= t) out[t] = l.t / TICK_HZ;
  }
  return out;
}

const sum = (o, k) => Object.values(o || {}).reduce((a, u) => a + (u?.[k] || 0), 0);
const total = (g) => (g.food || 0) + (g.wood || 0) + (g.stone || 0) + (g.gold || 0);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function ioStats(dir, seat) {
  const f = path.join(dir, 'io.jsonl');
  if (!fs.existsSync(f)) return { cutOffReplies: null };
  let cut = 0;
  for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!raw) continue;
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if (o.p !== seat) continue;
    if (o.finish_reason === 'length') cut++;
  }
  return { cutOffReplies: cut };
}

export function judge({ result, logPath, scenario, modelSeat, runMeta = null, endSummary = null, resim = true } = {}) {
  if (!scenario || !['destroy', 'eco'].includes(scenario.judge?.kind)) throw new TypeError('judge: needs a scenario with judge.kind "destroy" or "eco"');
  if (!Number.isInteger(modelSeat) || modelSeat < 1) throw new TypeError('judge: modelSeat must be a seat number (1, 2, ...)');
  if (!logPath) throw new TypeError('judge: needs logPath (replay folder or log.jsonl)');
  const kind = scenario.judge.kind;
  const notes = [];
  const blank = { gameSeconds: null, gathered: null, tierReachedAtS: null, kills: null, losses: null, invalidCommands: null, decisions: null };
  const invalid = (reason, metrics = {}) => ({ outcome: 'invalid', endClass: 'unknown', reason, metrics: { ...blank, ...metrics }, notes, end: null });

  // ---- inputs ----
  const abs = path.resolve(logPath);
  if (!fs.existsSync(abs)) return invalid(`no log: ${logPath} does not exist`);
  const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const file = fs.statSync(abs).isDirectory() ? path.join(abs, 'log.jsonl') : abs;
  if (!fs.existsSync(file)) return invalid(`no log.jsonl in ${dir}`);
  let lines;
  try { lines = readLines(file, notes); } catch (e) { return invalid(`unreadable log: ${e.message}`); }
  const start = lines.find((l) => l.type === 'start');
  const logResult = lines.find((l) => l.type === 'result') || null;
  if (!start) return invalid('the log has no start line');
  const dropped = runMeta?.pacer?.dropped ?? result?.pacer?.dropped ?? 0;
  const crashed = !!(runMeta?.crashed || runMeta?.error);
  if (crashed) return invalid(`the run crashed${runMeta?.error ? `: ${String(runMeta.error).slice(0, 120)}` : ''}`);
  if (runMeta?.abort) return invalid(`the run was stopped before the match ended (${String(runMeta.abort).slice(0, 60)}): rerun with the same seed`);
  if (dropped > 0) return invalid(`the game clock dropped ${dropped} tick(s) (pacer.dropped > 0): the run is not comparable, rerun with the same seed`);
  const res = result || logResult;
  if (!res) return invalid('no result: the run was aborted before the match ended');
  if (!result) notes.push('no result.json: the result line of log.jsonl was used (no agent summary)');
  else if (logResult && (logResult.reason !== result.reason || logResult.winnerTeam !== result.winnerTeam || logResult.tick !== result.tick)) return invalid('result.json and the result line of log.jsonl disagree');
  const seatCount = start.bots?.length || 0;
  if (modelSeat > seatCount) throw new TypeError(`judge: modelSeat ${modelSeat} but the match has ${seatCount} seats`);
  const modelTeam = start.teams?.[modelSeat - 1] ?? modelSeat;
  const cmds = lines.filter((l) => l.type === 'cmd');

  // ---- how the match ended ----
  let end, source, tierAt = null;
  if (endSummary) {
    end = classifyEnd(res, endSummary, { over: res.over !== false && res.reason !== 'cutoff' });
    source = 'endSummary';
    // goal "eco" measures the time to a tier: state lines give only 10 s steps (an upper bound), so the replay is run once for the exact tick
    if (kind === 'eco' && resim) {
      const r = resimulate(dir, file, start, res);
      if (r.ok) tierAt = r.tierAt;
      else notes.push(`tier times in 10 s steps, no exact value (no re-simulation: ${r.why})`);
    }
  } else if (resim) {
    const r = resimulate(dir, file, start, res);
    if (r.ok) { end = r.end; source = 'resim'; tierAt = r.tierAt; if (r.simVersion) notes.push(`end class from a re-simulation with ${r.simVersion}`); }
    else notes.push(`no re-simulation (${r.why}); the end class is inferred from the log`);
  }
  if (!end) { end = inferEnd(res, start, cmds); source = 'log'; }
  else if (end.cls === 'unknown' && String(res.reason).startsWith('no result')) end = { cls: 'time' };
  if (end.cls === 'unknown') notes.push('the end class could not be determined');
  else if (source === 'log') notes.push('end class inferred from the result and the rules, not from the kills');
  const cls = end.cls;
  const wonByModel = res.winnerTeam === modelTeam && res.winnerTeam !== 0 && cls !== 'cutoff';
  const endInfo = { cls, stranded: !!end.stranded, decayMutual: !!end.decayMutual, inferred: !!end.inferred || source === 'log', source };

  // ---- measures ----
  const gameSeconds = typeof res.seconds === 'number' ? res.seconds : typeof res.tick === 'number' ? res.tick / TICK_HZ : null;
  const me = res.players?.find((p) => p.id === modelSeat) || null;
  const foe = res.players?.find((p) => p.team !== modelTeam) || null;
  const agent = res.agents?.find((a) => a.pid === modelSeat) || null;
  const io = ioStats(dir, modelSeat);
  const tierReached = tierAt ? Object.fromEntries(TIERS.map((t) => [t, tierAt[modelSeat]?.[t] !== undefined ? tierAt[modelSeat][t] / TICK_HZ : null])) : tierFromStates(lines, modelSeat);
  const gathered = me ? { ...ZERO_G, ...me.gathered, total: total(me.gathered || {}) } : null;
  const decisions = agent && typeof agent.rounds === 'number' ? agent.rounds : null;
  const metrics = {
    gameSeconds, endTick: res.tick ?? null, winnerTeam: res.winnerTeam ?? null, modelTeam,
    modelAlive: me ? !!me.alive : null, opponentAlive: foe ? !!foe.alive : null,
    gathered, tierFinal: me?.tier ?? null, tierReachedAtS: tierReached, tierTimeSource: tierAt ? 'resim (exact)' : 'state lines (10 s steps)',
    kills: me ? sum(me.unitStats, 'kills') : null, losses: me ? sum(me.unitStats, 'lost') : null,
    killValue: me?.killValue ?? null, lostValue: me?.lostValue ?? null,
    decisions, decisionsPerMinute: decisions !== null && gameSeconds ? +(decisions / (gameSeconds / 60)).toFixed(2) : null,
    invalidCommands: agent && typeof agent.commands_invalid === 'number' ? agent.commands_invalid : null,
    parseErrors: agent?.parse_errors ?? null, requestErrors: agent?.errors ?? null, timeouts: agent?.timeouts ?? null,
    cutOffReplies: io.cutOffReplies, latencyMedianMs: agent?.latency_ms?.median ?? null, latencyMaxMs: agent?.latency_ms?.max ?? null,
    pacerDropped: dropped, rulesMatchScenario: null,
  };
  if (!agent) notes.push(`no agent summary for seat ${modelSeat}: decisions and invalid commands are unknown`);
  // Rule: a reply cut off at the token limit is wrong. Here it is only counted and named: agents/llm/player.mjs does not count it as an invalid command
  if (metrics.cutOffReplies > 0) notes.push(`${metrics.cutOffReplies} reply(ies) were cut off at the token limit (noted, not part of the invalid commands)`);
  if (start.rules && scenario.rules) {
    try {
      const diff = rulesDiff(start.rules, scenario);
      metrics.rulesMatchScenario = diff.length === 0;
      if (diff.length) notes.push(`the recorded rules differ from the scenario at: ${diff.slice(0, 6).join(', ')}${diff.length > 6 ? ', ...' : ''}`);
    } catch { /* scenario without a resolvable preset: no comparison */ }
  }

  // ---- verdict ----
  // A match that ends with class "cutoff" before the scenario cutoff was stopped from outside (arena stop, a pulled plug): no real cutoff, no loss.
  const cutAt = scenario.maxGameSeconds;
  if (cls === 'cutoff' && gameSeconds !== null && Number.isFinite(cutAt) && gameSeconds < cutAt - 1) {
    return { ...invalid(`the match was stopped at ${mmss(gameSeconds)}, before the scenario cutoff at ${mmss(cutAt)}: no cutoff, rerun with the same seed`, metrics), endClass: cls, end: endInfo };
  }
  if (kind === 'eco') {
    const target = scenario.judge.tierTarget;
    const at = tierReached[target];
    if (cls !== 'cutoff') notes.push(`the match ended before the cutoff (${cls} at ${mmss(gameSeconds)}); the measures cover only that time`);
    if (me && !me.alive) notes.push('the model seat was eliminated; the gathered amount stops there');
    const reason = `tier ${target} ${at === null ? 'not reached' : `reached at ${mmss(at)}`}; ${gathered ? gathered.total : '?'} gathered in ${gameSeconds === null ? '?' : mmss(gameSeconds)}`;
    return { outcome: 'measured', endClass: cls, reason, metrics: { ...metrics, tierTarget: target, tierTargetAtS: at, gatheredTotal: gathered?.total ?? null }, notes, end: endInfo };
  }

  // goal "destroy". Blind for the result: an unknown end class is invalid for both seats (only the winner would need a proof, but a rule
  // that reruns only wins would favour the loser's side).
  if (cls === 'unknown') return { ...invalid(`the end class is unknown: ${wonByModel ? 'a destruction win cannot be confirmed' : 'the end of the match cannot be classified'}; rerun or re-simulate`, metrics), endClass: 'unknown', end: endInfo };
  let outcome, reason;
  const at = gameSeconds === null ? '?' : mmss(gameSeconds);
  if (cls === 'cutoff') { outcome = 'cutoff'; reason = `no win: the scenario cutoff came at ${at}`; }
  else if (cls === 'destroyed' && wonByModel) { outcome = 'win'; reason = `win: the opponent was destroyed at ${at}${end.stranded ? ' (stranded: its town center stood, nothing left to rebuild)' : ''}`; }
  else {
    outcome = 'loss';
    if (cls === 'destroyed') reason = `loss: the model's base was destroyed at ${at}`;
    else if (cls === 'decay') reason = `no win: the last base fell to sudden-death decay at ${at}`;
    else if (cls === 'mutual') reason = `no win: mutual destruction at ${at}${res.winnerTeam ? ' (a seed tie-break named a winner, that is no victory)' : ''}`;
    else if (cls === 'time') reason = `no win: time limit at ${at}`;
    else if (cls === 'wonder' || cls === 'shrine') reason = `no win: ended by ${cls} at ${at}, not by destruction`;
    else if (cls === 'resign') reason = `no win: a player resigned at ${at}`;
    else reason = `no win: end class ${cls} at ${at}`;
  }
  return { outcome, endClass: cls, reason, metrics, notes, end: endInfo };
}

// keys at which the rules recorded in the run differ from the scenario's resolved rules
function rulesDiff(recorded, scenario) {
  const resolved = resolveRules(ruleInput(scenario));
  const keys = new Set([...Object.keys(resolved), ...Object.keys(recorded)]);
  return [...keys].filter((k) => canonical(resolved[k]) !== canonical(recorded[k])).sort();
}
