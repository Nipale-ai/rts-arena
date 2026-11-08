// One LLM player. Async loop, one request in flight, never blocks the game.
//   each tick (called by the match driver):  cmds = player.takeCommands(game); apply them; player.maybeRequest(game)
// A reply that arrives between two ticks is queued and applied at the next tick through the normal command path.
//
// What the harness adds on top of "send observation, apply tool calls" (same for every player, see the prompt):
//   - a reply without any game order (only a note, a broken call, nothing) is re-requested once at once, with tool_errors (retry); every empty reply, no exception
//   - the observation is written shorter (compact.mjs): same information, no empty fields, no static data
//   - memory: the next observation carries the last note, the results of the last orders and a short record of the round before
//   - a purchase that fails for resources while standing orders eat that resource is held: those standing orders pause until it is paid;
//     several held purchases wait in a queue (first in, first bought), each with its own timer; re-issuing a held order keeps its timer
//   - clock, combat digest (own losses / kills / trained since the last round), a longer event list
//   - tok/s is a decode rate measured the same way for every server (client.mjs speedOf); it is labelled and its source is recorded
import { observe } from '../../sim/observe.mjs';
import { TICK_HZ } from '../../sim/util.mjs';
import { buildSystemPrompt, toolDefs, PROMPT_VERSION, promptHash, MAX_CALLS } from './prompt.mjs';
import { resolveConfig, chat, speedOf } from './client.mjs';
import { parseReply, deriveThought } from './parse.mjs';
import { validateCall } from './validate.mjs';
import { compactObs } from './compact.mjs';

export const HOLDABLE = new Set(['train', 'build', 'research', 'advance_tier']); // purchases the harness holds when they fail for resources
export const HOLD_MAX_S = 150; // a held purchase waits at most this many game seconds (cfg.hold_max_s overrides)
export const HOLD_MAX_TICKS = HOLD_MAX_S * TICK_HZ;
export const HOLD_QUEUE_MAX = 4; // held purchases waiting at the same time; a further one is not held (the model is told)
const STREAM_REFUSED = new Set([400, 404, 405, 415, 422, 501]);

// How an error code counts in the HUD / summary: resources (cannot pay now), target (dead / unknown unit or building), args (malformed call), other (rules, state).
const KIND = {
  insufficient_resources: 'resources', pop_cap: 'resources', queue_full: 'resources',
  not_found: 'target', no_units: 'target', no_workers: 'target', not_owner: 'target', cannot_attack: 'target',
  bad_args: 'args', missing_arg: 'args', bad_arg_type: 'args', bad_arg_value: 'args', unknown_tool: 'args', unknown_unit: 'args', bad_json: 'args', cannot_train_here: 'args', wrong_building: 'args', no_commands: 'args', no_tool_calls: 'args', empty_reply: 'args',
};
export const errorKind = (code) => KIND[code] || 'other';

export class LlmPlayer {
  constructor(rawCfg, { pid, rules, onIo = () => {} } = {}) {
    this.cfg = resolveConfig(rawCfg);
    this.pid = pid;
    this.onIo = onIo;
    this.system = buildSystemPrompt(rules);
    this.tools = toolDefs();
    this.rules = rules;
    this.game = null; // set by takeCommands / maybeRequest (read only)
    this.queue = []; // [{cmds, req}] waiting for the next tick
    this.batches = []; // applied batches waiting for their results: [{req, expected, results, round}]
    this.inject = []; // harness commands (hold / restore standing orders) for the next tick
    this.holds = []; // held purchases, first in first bought: [{cmd, need, state, until, paused, since}]; `paused` is one shared list of the standing orders that wait
    this.inflight = null;
    this.nextAllowed = 0; // tick
    this.sinceTick = -1;
    this.feedback = []; // results of applied commands, shown in the next observation
    this.toolErrors = []; // pre-validation errors, shown in the next observation
    this.turns = []; // last finished rounds: {n, game_s, note, orders[]}
    this.lastNote = '';
    this.lostBase = null; // own unit losses at the start of the previous round (for the digest)
    this.lastError = null;
    this.errStreak = 0;
    this.round = 0;
    this.lastRoundTicks = null;
    this.lastLatency = null;
    this.ac = new AbortController();
    this.stopped = false;
    this.thought = '';
    this.lastCmd = '';
    this.lastCmdTick = 0;
    this.m = {
      requests: 0, ok: 0, errors: 0, timeouts: 0, parse_errors: 0, latencies: [], ttfts: [], prompt_tokens: 0, completion_tokens: 0, tok_s_last: null, tok_s_source: null,
      tok_s_sum_tokens: 0, tok_s_sum_ms: 0, tok_s_wall_requests: 0, tok_s_server_tokens: 0, tok_s_server_s: 0,
      cmds_applied: 0, cmds_rejected: 0, cmds_invalid: 0, invalid_by: { resources: 0, target: 0, args: 0, other: 0 }, by_error: {}, by_cmd: {}, via: {},
      rounds: 0, empty_replies: 0, retries: 0, retry_ok: 0, retry_failed: 0, held: 0, hold_bought: 0, hold_expired: 0, hold_failed: 0, hold_refused: 0, stream_fallback: 0,
    };
  }

  get hold() { return this.holds[0] || null; } // the purchase that is being saved for now

  get label() { return { name: this.cfg.name, model: this.cfg.model, hardware: this.cfg.hardware }; }

  // ---- called every tick before game.step() ----
  takeCommands(game) {
    this.game = game;
    const out = [];
    const add = (cmds, req, round) => {
      if (!cmds.length) return;
      this.batches.push({ req, expected: cmds.length, results: [], round });
      for (const c of cmds) out.push({ cmd: c, req });
    };
    for (const q of this.queue) {
      this.lastRoundTicks = game.t - q.startTick;
      this.nextAllowed = game.t + Math.round(this.cfg.min_interval_s * TICK_HZ);
      add(q.cmds, q.req, q.round);
    }
    this.queue = [];
    this.stepHold(game);
    if (this.inject.length) { add(this.inject, 'hold', null); this.inject = []; }
    return out;
  }

  recordResult(cmd, res, tick) {
    const b = this.batches[0];
    const hold = b && b.req === 'hold';
    const name = cmd.cmd;
    if (b) {
      b.results.push({ cmd: name, args: argsOf(cmd), ok: !!res.ok, ...(res.ok ? {} : { error: res.error, message: res.message }) });
    }
    if (name === 'note') { if (!hold) this.thought = cmd.text; this.settle(b); return; }
    if (hold) { this.holdResult(cmd, res); this.settle(b); return; }
    this.m.by_cmd[name] = (this.m.by_cmd[name] || 0) + 1;
    if (res.ok) this.m.cmds_applied++; else {
      this.m.cmds_rejected++; this.m.cmds_invalid++;
      this.m.invalid_by[errorKind(res.error)]++;
      this.m.by_error[res.error] = (this.m.by_error[res.error] || 0) + 1;
    }
    const f = { cmd: name, args: argsOf(cmd), ok: res.ok };
    if (!res.ok) { f.error = res.error; f.message = res.message; } else {
      for (const k of ['queued', 'note', 'building_id', 'assigned', 'units', 'at']) if (res[k] !== undefined) f[k] = res[k];
    }
    if (!res.ok && res.error === 'insufficient_resources' && res.need && HOLDABLE.has(name)) {
      const h = this.startHold(cmd, res.need);
      if (h && h.again) f.held = 'HELD already: this order is waiting (see saving_for); its timer was not reset. Do not repeat it.';
      else if (h) f.held = `HELD: ${h.paused.map((x) => x.label).join(', ')} are paused so the money can pile up; this order is placed by itself as soon as you can pay (see saving_for). Do not repeat it.`;
      else if (this.holds.length >= HOLD_QUEUE_MAX) { this.m.hold_refused++; f.held = `NOT HELD: ${HOLD_QUEUE_MAX} orders are already waiting (see saving_for). Wait for one of them.`; }
    } else if (res.ok && this.holds.length && this.holds.some((x) => sameOrder(x.cmd, cmd))) this.endHold(this.holds.find((x) => sameOrder(x.cmd, cmd)), 'done');
    else if (res.ok && this.holds.length && (name === 'auto_train' || name === 'auto_build_houses')) {
      const paused = this.holds[0].paused, keep = paused.filter((x) => x.order !== name || !sameKey(x.args, cmd));
      paused.length = 0; paused.push(...keep); // in place: the list is shared by all held purchases
    }
    this.feedback.push(f);
    if (this.feedback.length > 30) this.feedback.shift();
    this.lastCmd = brief(cmd) + (res.ok ? '' : '  [rejected]');
    this.lastCmdTick = tick;
    this.settle(b);
  }

  // all results of a batch are in: write the io line of the round, update the memory
  settle(b) {
    if (!b || b.results.length < b.expected) return;
    this.batches.shift();
    if (b.req === 'hold' || !b.round) return;
    const r = b.round;
    const orders = b.results.filter((x) => x.cmd !== 'note').map((x) => `${briefArgs(x.cmd, x.args)}: ${x.ok ? 'ok' : 'FAILED ' + x.error}`);
    this.turns.push({ n: r.n, game_s: r.game_s, note: r.note || '', orders });
    if (this.turns.length > 2) this.turns.shift();
    this.lastNote = r.note || '';
    this.onIo({ ...r.io, results: b.results });
    r.written = true;
  }

  // ---- held purchases (H3) ----
  // An explicit purchase that fails for resources, while standing orders keep spending that resource as it arrives, would fail again and again.
  // The harness then pauses those standing orders (cancel_standing now, the same order again later), places the purchase when it is affordable, and resumes them.
  startHold(cmd, need) {
    const g = this.game, p = g?.players[this.pid];
    if (!p || !p.alive) return null;
    // the same order again (only the count may differ): it is already waiting, its timer keeps running
    const same = this.holds.find((x) => sameOrder(x.cmd, cmd));
    if (same) {
      if (same.state === 'waiting') { same.cmd = { ...cmd }; same.need = { ...need }; }
      return { ...same, again: true };
    }
    if (this.holds.length >= HOLD_QUEUE_MAX) return null;
    const short = Object.keys(need).filter((r) => p.res[r] < need[r]);
    const paused = this.holds.length ? this.holds[0].paused : [];
    for (const o of p.standing) {
      let snap = null;
      if (o.kind === 'train' && Object.keys(p.faction.units[o.unit].cost).some((r) => short.includes(r))) {
        const args = { unit_type: o.unit, ...(o.bid ? { building_id: o.bid } : {}), ...(o.keep !== null ? { keep_queue: o.keep } : {}), ...(o.until !== null ? { until_count: o.until } : {}) };
        snap = { order: 'auto_train', args, id: o.id, label: `auto_train ${o.unit}${o.bid ? ' at ' + o.bid : ''}` };
      } else if (o.kind === 'houses' && short.includes('wood')) snap = { order: 'auto_build_houses', args: { on: true, margin: o.margin }, id: o.id, label: 'auto_build_houses' };
      if (snap && !paused.some((x) => x.id === o.id)) { paused.push(snap); this.inject.push({ cmd: 'cancel_standing', id: o.id }); }
    }
    if (!paused.length) return null;
    this.m.held++;
    const h = { cmd: { ...cmd }, need: { ...need }, state: 'waiting', until: g.t + Math.round((this.cfg.hold_max_s ?? HOLD_MAX_S) * TICK_HZ), paused, since: g.t };
    this.holds.push(h);
    return h;
  }

  stepHold(game) {
    if (!this.holds.length) return;
    const p = game.players[this.pid];
    if (!p || !p.alive || game.over) { this.holds = []; return; }
    for (const h of [...this.holds]) if (h.state === 'waiting' && game.t >= h.until) { this.m.hold_expired++; this.endHold(h, 'expired'); } // each held purchase has its own timer
    const h = this.holds[0];
    if (!h || h.state !== 'waiting') return;
    if (Object.entries(h.need).every(([r, v]) => p.res[r] >= v)) {
      this.inject.push(h.cmd);
      h.state = 'buying';
    }
  }

  holdResult(cmd, res) {
    const h = this.holds[0];
    if (!h) return;
    if (cmd.cmd !== h.cmd.cmd || h.state !== 'buying') return; // cancel / restore results need no follow-up
    const f = { cmd: cmd.cmd, args: argsOf(cmd), ok: !!res.ok };
    if (res.ok) {
      for (const k of ['queued', 'building_id', 'tier', 'tech', 'seconds']) if (res[k] !== undefined) f[k] = res[k];
      f.note = 'your held order was placed automatically once you could pay' + (this.holds.length > 1 ? '; the next held order is saved for now' : '; the paused standing orders are running again (they have new ids)');
      this.m.hold_bought++;
      this.feedback.push(f);
      this.endHold(h, 'bought');
    } else if (res.error === 'insufficient_resources') h.state = 'waiting'; // somebody else spent it first: keep saving
    else {
      f.error = res.error; f.message = `your held order failed when it was placed: ${res.message}`;
      this.m.hold_failed++;
      this.feedback.push(f);
      this.endHold(h, 'failed');
    }
  }

  // one held purchase is over (bought, failed, expired, or the model bought it itself). The paused standing orders run again when no held purchase is left.
  endHold(h, why) {
    if (!h) return;
    const i = this.holds.indexOf(h);
    if (i < 0) return;
    this.holds.splice(i, 1);
    if (!this.holds.length) for (const s of h.paused) this.inject.push({ cmd: s.order, ...s.args });
    if (why === 'expired') this.feedback.push({ cmd: h.cmd.cmd, args: argsOf(h.cmd), ok: false, error: 'hold_expired', message: `your held order was not affordable within ${this.cfg.hold_max_s ?? HOLD_MAX_S} s and was dropped${this.holds.length ? '' : '; the standing orders run again'}` });
  }

  // ---- the observation of one round ----
  buildObs(game, round) {
    const p = game.players[this.pid];
    const obs = observe(game, this.pid, { sinceTick: round.since, fullIds: true });
    delete obs.results; // replaced by last_commands (what the model asked, and what happened)
    delete obs.note;
    delete obs.events; // rebuilt below (observe() keeps 12 and most of them are "trained")
    // clock
    const tl = game.rules.timeLimitS, sd = game.rules.suddenDeath || 0;
    obs.clock = { time_left_s: Math.max(0, tl - obs.t) };
    if (sd) obs.clock.sudden_death_in_s = Math.max(0, sd - obs.t);
    if (game.rules.warAtS) { obs.clock.war_phase_in_s = Math.max(0, game.rules.warAtS - obs.t); delete obs.clock.time_left_s; }
    // events (own player state, same source as observe) and the digest of the last round
    const trained = {};
    const ev = [];
    for (const e of p.events) {
      if (e.t <= round.since) continue;
      if (e.type === 'trained') { trained[e.unit] = (trained[e.unit] || 0) + 1; continue; }
      ev.push({ ...e, t: Math.floor(e.t / TICK_HZ) });
    }
    if (ev.length) obs.events = ev.slice(-16);
    const lost = {}, killed = {}, razed = {};
    const cur = {};
    for (const [t, s] of Object.entries(p.unitStats || {})) cur[t] = s.lost;
    const base = round.lostBase;
    if (base) for (const [t, n] of Object.entries(cur)) if (n > (base[t] || 0)) lost[t] = n - (base[t] || 0);
    for (const k of p.killFeed || []) if (k.t > round.since && round.since >= 0) { const m = k.kind === 'unit' ? killed : razed; m[k.victimType] = (m[k.victimType] || 0) + 1; }
    const d = {};
    if (Object.keys(lost).length) d.your_units_lost = lost;
    if (Object.keys(killed).length) d.enemy_units_killed = killed;
    if (Object.keys(razed).length) d.enemy_buildings_destroyed = razed;
    if (Object.keys(trained).length) d.your_units_trained = trained;
    if (Object.keys(d).length) obs.since_last_round = d;
    round.lostSnap = cur;
    // memory
    obs.last_commands = round.pre.feedback;
    if (this.lastNote) obs.last_note = this.lastNote;
    if (this.turns.length > 1) obs.turn_before = this.turns[this.turns.length - 2];
    if (round.pre.toolErrors.length) obs.tool_errors = round.pre.toolErrors;
    if (round.pre.lastError) obs.request_error = round.pre.lastError;
    if (this.holds.length) {
      const [h, ...more] = this.holds;
      const left = (x) => Math.max(0, Math.round((x.until - game.t) / TICK_HZ));
      obs.saving_for = { order: briefArgs(h.cmd.cmd, argsOf(h.cmd)), need: h.need, paused_standing_orders: h.paused.map((x) => `${x.label} (was #${x.id})`), seconds_left: left(h) };
      if (more.length) obs.saving_for.then = more.map((x) => ({ order: briefArgs(x.cmd.cmd, argsOf(x.cmd)), need: x.need, seconds_left: left(x) }));
    }
    obs.meta = { round: round.n, last_round_took_game_s: this.lastRoundTicks === null ? null : +(this.lastRoundTicks / TICK_HZ).toFixed(1) };
    if (round.attempt > 1) obs.meta.retry = true;
    return obs;
  }

  maybeRequest(game) {
    if (this.stopped || this.inflight || game.over) return;
    const p = game.players[this.pid];
    if (!p || !p.alive || game.t < this.nextAllowed) return;
    this.game = game;
    const n = ++this.round;
    const round = {
      n, startTick: game.t, since: this.sinceTick, attempt: 1, lostBase: this.lostBase, game_s: Math.floor(game.t / TICK_HZ),
      pre: { feedback: this.feedback, toolErrors: this.toolErrors, lastError: this.lastError },
    };
    this.feedback = [];
    this.toolErrors = [];
    this.lastError = null;
    this.send(game, round);
  }

  send(game, round) {
    const obs = this.buildObs(game, round);
    this.sinceTick = game.t; // the next round reports what happens after this observation
    this.lostBase = round.lostSnap;
    const user = JSON.stringify(compactObs(obs));
    const messages = [{ role: 'system', content: this.system }, { role: 'user', content: user }];
    const entry = { n: round.n, p: this.pid, tick: round.startTick, game_s: round.game_s, wall: new Date().toISOString(), model: this.cfg.model, prompt_version: PROMPT_VERSION, user };
    if (round.attempt > 1) { entry.attempt = round.attempt; entry.tick_retry = game.t; }
    this.m.requests++;
    this.inflight = this.call(messages).then(
      (res) => this.onReply(res, entry, round),
      (err) => this.onError(err, entry, round),
    );
  }

  // one request; a server that refuses streaming is asked again without it (and stays non-streaming)
  async call(messages) {
    try {
      return await chat(this.cfg, messages, this.tools, { signal: this.ac.signal });
    } catch (err) {
      if (this.cfg.stream && err.kind === 'http' && STREAM_REFUSED.has(err.status) && !this.stopped) {
        this.cfg = { ...this.cfg, stream: false };
        this.m.stream_fallback++;
        return await chat(this.cfg, messages, this.tools, { signal: this.ac.signal });
      }
      throw err;
    }
  }

  onReply(res, entry, round) {
    this.inflight = null;
    if (this.stopped) return;
    const sp = speedOf(res);
    const parsed = parseReply(res.message);
    const cmds = [];
    const errs = parsed.errors.map((e) => ({ error: e.kind, message: e.message }));
    let note = parsed.note;
    let n = 0;
    for (const call of parsed.calls) {
      const v = validateCall(call);
      if (!v.ok) { errs.push({ error: v.error, tool: call.name, message: v.message }); this.m.cmds_invalid++; this.m.invalid_by.args++; this.m.by_error[v.error] = (this.m.by_error[v.error] || 0) + 1; continue; }
      if (v.cmd.cmd === 'note') { note = v.cmd.text; continue; }
      if (++n > MAX_CALLS) { if (n === MAX_CALLS + 1) errs.push({ error: 'too_many_calls', message: `only the first ${MAX_CALLS} calls of a reply are used` }); continue; }
      cmds.push(v.cmd);
    }
    if (res.finish_reason === 'length') errs.push({ error: 'cut_off', message: `your reply was cut off at max_tokens (${this.cfg.max_tokens}); think less, answer faster` });
    const own = note ? String(note).replace(/\s+/g, ' ').trim().slice(0, 120) : ''; // the note the model wrote itself
    if (parsed.errors.length) this.m.parse_errors++;
    this.m.ok++;
    this.m.latencies.push(res.latency_ms);
    if (sp.ttft_ms !== null) this.m.ttfts.push(sp.ttft_ms);
    this.m.via[parsed.via] = (this.m.via[parsed.via] || 0) + 1;
    if (sp.prompt_tokens) this.m.prompt_tokens += sp.prompt_tokens;
    if (sp.completion_tokens) {
      this.m.completion_tokens += sp.completion_tokens;
      if (sp.tok_s_source === 'stream-decode') { this.m.tok_s_sum_tokens += sp.completion_tokens - 1; this.m.tok_s_sum_ms += sp.decode_ms; } else this.m.tok_s_wall_requests++;
      if (sp.tok_s_server) { this.m.tok_s_server_tokens += sp.completion_tokens; this.m.tok_s_server_s += sp.completion_tokens / sp.tok_s_server; }
    }
    if (sp.tok_s) { this.m.tok_s_last = sp.tok_s; this.m.tok_s_source = sp.tok_s_source; }
    this.lastLatency = res.latency_ms;
    const rec = { latency_ms: Math.round(res.latency_ms), ...sp, finish_reason: res.finish_reason, via: parsed.via, response: { message: res.message, usage: res.usage, timings: res.timings, ...(res.extra ? { extra: res.extra } : {}), ...(res.stream ? { stream: res.stream } : {}) }, n_calls: parsed.calls.length };

    // no game order in the reply: ask once more at once, with the reason (H1)
    const game = this.game;
    // every empty reply gets the second request, as the prompt says (an earlier version skipped the one after a failed retry: that made the
    // result depend on the parity of the empty replies, and the skipped round got no no_orders message)
    if (!cmds.length && round.attempt === 1) this.m.empty_replies++;
    if (!cmds.length && round.attempt === 1 && this.cfg.retry_empty !== false && game && !game.over && game.players[this.pid]?.alive) {
      this.m.retries++;
      round.attempt = 2;
      round.first = { ...rec, errors: errs, note: own };
      round.pre = { ...round.pre, toolErrors: [...errs.slice(0, 6), { error: 'no_orders', message: 'Your last reply had no game order (only a note, a broken call or nothing). Nothing was done. Answer again now with game tools (train, build, gather, attack_move ...) plus one note. Keep your thinking short.' }] };
      this.send(game, round);
      return;
    }
    if (round.attempt > 1) { if (cmds.length) this.m.retry_ok++; else this.m.retry_failed++; }
    this.errStreak = 0;
    this.toolErrors = errs.slice(0, 8);
    let shown = own;
    if (!shown) shown = deriveThought(res.message); // missing / empty / wrong-key note: first sentence of the answer or the reasoning
    if (shown) cmds.push({ cmd: 'note', text: String(shown).replace(/\s+/g, ' ').trim().slice(0, 120) });
    this.m.rounds++;
    round.note = own;
    round.io = {
      ...entry, ...rec, n_commands: cmds.length, errors: errs,
      ...(round.first ? { retry: { reason: 'no_orders', first: round.first } } : {}),
    };
    this.queue.push({ cmds, req: round.n, startTick: round.startTick, round });
    if (!cmds.length) { round.io.results = []; round.written = true; this.onIo(round.io); }
  }

  onError(err, entry, round) {
    this.inflight = null;
    if (this.stopped) return;
    this.m.errors++;
    if (err.kind === 'timeout') this.m.timeouts++;
    this.errStreak++;
    this.lastError = String(err.message).slice(0, 200);
    this.nextAllowed = round.startTick + Math.round(Math.min(10, 2 * this.errStreak) * TICK_HZ);
    // a failed retry keeps the tool errors of the empty reply for the next round
    if (round.attempt > 1) { this.toolErrors = round.pre.toolErrors.filter((e) => e.error !== 'no_orders').slice(0, 8); this.feedback = round.pre.feedback.concat(this.feedback).slice(-30); }
    this.onIo({ ...entry, latency_ms: Math.round(err.latency_ms ?? 0), error: { kind: err.kind || 'unknown', message: String(err.message).slice(0, 300) }, ...(round.first ? { retry: { reason: 'no_orders', first: round.first } } : {}) });
  }

  // wall-clock figures for the HUD
  hud() {
    const m = this.m;
    return {
      latency: this.lastLatency, tokS: m.tok_s_last, tokSource: m.tok_s_source, thinks: m.requests, cmds: m.cmds_applied + m.cmds_rejected,
      invalid: m.cmds_invalid + m.parse_errors, invalidBy: { ...m.invalid_by, parse: m.parse_errors }, empty: m.empty_replies,
      thought: this.thought, lastCmd: this.lastCmd, lastCmdTick: this.lastCmdTick,
    };
  }

  summary() {
    const m = this.m, L = [...m.latencies].sort((a, b) => a - b);
    const q = (f) => (L.length ? Math.round(L[Math.min(L.length - 1, Math.floor(f * L.length))]) : null);
    const T = [...m.ttfts].sort((a, b) => a - b);
    return {
      name: this.cfg.name, model: this.cfg.model, hardware: this.cfg.hardware, thinking: this.cfg.thinking, max_tokens: this.cfg.max_tokens, sampling: this.cfg.sampling,
      requests: m.requests, replies: m.ok, rounds: m.rounds, errors: m.errors, timeouts: m.timeouts, parse_errors: m.parse_errors,
      latency_ms: { median: q(0.5), p90: q(0.9), max: L.length ? Math.round(L[L.length - 1]) : null },
      ttft_ms_median: T.length ? Math.round(T[Math.floor(T.length / 2)]) : null,
      prompt_tokens: m.prompt_tokens, completion_tokens: m.completion_tokens,
      // decode tokens per second, one method for every player: streamed token timing (client.mjs speedOf). tok_s_server_avg is the server's own figure, a cross-check.
      tok_s_avg: m.tok_s_sum_ms ? +((m.tok_s_sum_tokens * 1000) / m.tok_s_sum_ms).toFixed(2) : null,
      tok_s_method: m.tok_s_sum_ms ? (m.tok_s_wall_requests ? 'stream-decode (some replies: wall latency)' : 'stream-decode') : m.tok_s_wall_requests ? 'wall-latency' : null,
      tok_s_server_avg: m.tok_s_server_s ? +(m.tok_s_server_tokens / m.tok_s_server_s).toFixed(2) : null,
      empty_replies: m.empty_replies, retries: m.retries, retry_ok: m.retry_ok, retry_failed: m.retry_failed,
      held_purchases: m.held, hold_bought: m.hold_bought, hold_expired: m.hold_expired, hold_failed: m.hold_failed, hold_refused: m.hold_refused, stream_fallback: m.stream_fallback,
      commands_applied: m.cmds_applied, commands_rejected: m.cmds_rejected, commands_invalid: m.cmds_invalid, invalid_by_kind: m.invalid_by, errors_by_code: m.by_error, by_cmd: m.by_cmd, reply_format: m.via,
    };
  }

  stop() {
    this.stopped = true;
    this.ac.abort(new Error('match over'));
    // io lines of rounds whose orders were never applied (match over)
    for (const q of this.queue) if (q.round && q.round.io && !q.round.written) { q.round.written = true; this.onIo({ ...q.round.io, results: null }); }
    for (const b of this.batches) if (b.round && b.round.io && !b.round.written) { b.round.written = true; this.onIo({ ...b.round.io, results: b.results }); }
    this.queue = [];
    this.batches = [];
  }
}

// the same purchase: same command and the same arguments, a different count does not make a different order
const orderKey = (c) => { const { count, ...rest } = argsOf(c); void count; return c.cmd + JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]])); };
const sameOrder = (a, b) => orderKey(a) === orderKey(b);
const argsOf = (cmd) => { const a = { ...cmd }; delete a.cmd; return a; };
const sameKey = (snapArgs, cmd) => snapArgs.unit_type === cmd.unit_type && (snapArgs.building_id ?? null) === (cmd.building_id ?? null) || (cmd.cmd === 'auto_build_houses' && snapArgs.margin !== undefined);

// one-line text of a command for the HUD
export function brief(c) {
  const xy = (v) => (Array.isArray(v) ? `(${Math.round(v[0])},${Math.round(v[1])})` : v === undefined ? '' : `#${v}`);
  switch (c.cmd) {
    case 'train': return `train ${c.count ?? 1}x ${c.unit_type}`;
    case 'build': return `build ${c.building_type} near ${xy(c.near)}`;
    case 'gather': return `gather ${c.resource}${c.count ? ' x' + c.count : ''}`;
    case 'attack_move': return `attack_move ${xy(c.target)}`;
    case 'move': return `move ${xy(c.to)}`;
    case 'research': return `research ${c.tech}`;
    case 'set_rally': return `set_rally ${xy(c.xy)}`;
    case 'scout': return `scout ${xy(c.xy)}`;
    default: return c.cmd;
  }
}
const briefArgs = (name, a) => brief({ cmd: name, ...a });
