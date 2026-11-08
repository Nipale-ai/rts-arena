// Real-time match driver: scripted bots and LLM players in any mix, command log + model I/O log.
// No HTTP in here; server/match.mjs adds the spectator page, tests drive it directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pacer } from './clock.mjs';
import { Game } from '../sim/game.mjs';
import { observe } from '../sim/observe.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { loadMap } from '../sim/mapio.mjs';
import { ensureFrozen } from '../sim-versions/lib.mjs';
import { createBot, BOT_NAMES } from '../agents/scripted/index.mjs';
import { THINK_TICKS } from '../tools/run-match.mjs';
import { LlmPlayer, brief } from '../agents/llm/player.mjs';
import { publicConfig, resolveConfig } from '../agents/llm/client.mjs';
import { buildSystemPrompt, toolDefs, PROMPT_VERSION, promptVersion, promptHash } from '../agents/llm/prompt.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// spec: "scripted:boom" | "boom" | path/to/config.json | config object
export function loadSpec(spec) {
  if (spec && typeof spec === 'object') return { kind: 'llm', cfg: resolveConfig(spec) };
  const s = String(spec);
  const bot = s.startsWith('scripted:') ? s.slice(9) : BOT_NAMES.includes(s) ? s : null;
  if (bot) {
    if (!BOT_NAMES.includes(bot)) throw new Error(`unknown scripted bot "${bot}" (have: ${BOT_NAMES.join(', ')})`);
    return { kind: 'bot', bot };
  }
  const file = path.resolve(s);
  if (!fs.existsSync(file)) throw new Error(`player config not found: ${s}`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${s}: invalid JSON (${e.message})`); }
  return { kind: 'llm', cfg: resolveConfig(raw) };
}

const NON_PLAN = new Set(['say', 'note']);

export class LiveMatch {
  // opts: seed, p1, p2 (specs), record (default true), outRoot, maxGameSeconds
  constructor(opts) {
    this.seed = +(opts.seed ?? 42);
    const specs = (opts.specs || [opts.p1, opts.p2]).map(loadSpec);
    // rules preset: "fast" is the default whenever an LLM plays; "classic" for pure bot matches (or set opts.rules)
    this.rules = resolveRules(opts.rules ?? (specs.some((s) => s.kind === 'llm') ? 'fast' : 'classic'));
    this.maxTicks = Math.round((opts.maxGameSeconds ?? this.rules.timeLimitS + 60) * TICK_HZ);
    if (specs.length !== 2 && specs.length !== 4) throw new Error('2 or 4 players are supported by the map generator');
    this.teams = specs.map((_, i) => (opts.teams && opts.teams[i]) || i + 1);
    this.slots = specs.map((s, i) => {
      const pid = i + 1;
      // creator banner (cosmetic: id from configs/creators.json). It is only shown in the renderer and never reaches the LLM prompt.
      const creator = (opts.creators && opts.creators[i]) || (s.kind === 'llm' ? s.cfg.creator : null) || null;
      if (s.kind === 'bot') {
        const nm = s.bot[0].toUpperCase() + s.bot.slice(1);
        return { kind: 'bot', pid, bot: createBot(s.bot), botName: s.bot, name: nm, model: `scripted bot: ${s.bot}`, hw: 'Node.js, no GPU', last: -1, creator };
      }
      const player = new LlmPlayer(s.cfg, { pid, rules: this.rules, onIo: (e) => this.writeIo(e) });
      return { kind: 'llm', pid, agent: player, name: s.cfg.name, model: s.cfg.model, hw: s.cfg.hardware, cfg: s.cfg, creator };
    });
    // memory class of the match (big label top-left in the broadcast): option, else the first player config that has one
    this.cls = opts.cls || specs.map((s) => (s.kind === 'llm' ? s.cfg.class : null)).find(Boolean) || null;
    // equal names would collide in logs
    for (const s of this.slots) if (this.slots.filter((o) => o.name === s.name).length > 1) s.name = `${s.name} ${s.pid}`;
    this.names = this.slots.map((s) => s.name);
    this.models = this.slots.map((s) => s.model);
    this.hws = this.slots.map((s) => s.hw);
    this.creators = this.slots.map((s) => s.creator);
    this.botNames = this.names;
    // opts.map: a custom `rts-map-1` object (world editor); it is stored in the replay start line so the replay rebuilds the same world
    this.mapData = opts.map ? loadMap(opts.map) : null;
    this.game = new Game({ seed: this.seed, players: this.slots.map((s, i) => ({ team: this.teams[i], name: s.name })), numPlayers: specs.length, rules: this.rules, ...(this.mapData ? { map: this.mapData } : {}) });
    this.wall0 = performance.now();
    this.finished = false;
    this.logFd = null;
    this.ioFd = null;
    this.id = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${this.names.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-')).join('-vs-')}-s${this.seed}`;
    if (opts.record !== false) this.openRecording(opts.outRoot || path.join(ROOT, 'replays'));
  }

  openRecording(root) {
    let dir = path.join(root, this.id), k = 1;
    while (fs.existsSync(dir)) dir = path.join(root, `${this.id}-${++k}`);
    this.id = path.basename(dir);
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.logFd = fs.openSync(path.join(dir, 'log.jsonl'), 'w');
    this.ioFd = fs.openSync(path.join(dir, 'io.jsonl'), 'w');
    fs.writeFileSync(path.join(dir, 'system-prompt.txt'), buildSystemPrompt(this.rules));
    fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(toolDefs(), null, 1));
    fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify(this.slots.map((s) => (s.kind === 'llm' ? { kind: 'llm', ...publicConfig(s.cfg) } : { kind: 'bot', bot: s.botName })), null, 1));
    this.writeLog({
      type: 'start', sim_version: ensureFrozen(), seed: this.seed, bots: this.names, teams: this.teams, map: this.game.mapName, mode: 'llm',
      prompt_version: promptVersion(this.rules), prompt_hash: promptHash(this.rules), rules: this.rules,
      players: this.slots.map((s) => ({ kind: s.kind, name: s.name, model: s.model, hardware: s.hw, ...(s.creator ? { creator: s.creator } : {}) })),
      ...(this.cls ? { class: this.cls } : {}),
      ...(this.mapData ? { map_data: this.mapData } : {}),
    });
  }

  writeLog(o) { if (this.logFd !== null) fs.writeSync(this.logFd, JSON.stringify(o) + '\n'); }
  writeIo(e) { if (this.ioFd !== null) fs.writeSync(this.ioFd, JSON.stringify(e) + '\n'); }

  apply(pid, cmd, req) {
    const g = this.game;
    const r = g.command(pid, cmd);
    this.writeLog({ type: 'cmd', t: g.t, p: pid, cmd, ok: r.ok, err: r.ok ? undefined : r.error, msg: r.ok ? undefined : r.message, ...(req ? { req } : {}) });
    return r;
  }

  // God mode: one intervention of the spectator, applied between two ticks and logged with its tick like any other command
  director(cmd) {
    const g = this.game;
    if (this.finished || g.over) return { ok: false, error: 'game_over', message: 'the match is over' };
    const r = g.command(0, cmd);
    this.writeLog({ type: 'cmd', t: g.t, p: 0, cmd, ok: r.ok, err: r.ok ? undefined : r.error });
    return r;
  }

  // one 100 ms game tick
  tick() {
    const g = this.game;
    if (g.over || this.finished) return;
    const n = this.slots.length;
    if (g.t % THINK_TICKS === 0) {
      for (let k = 0; k < n; k++) {
        const i = (k + g.t / THINK_TICKS) % n;
        const s = this.slots[i];
        if (s.kind !== 'bot' || !g.players[s.pid].alive) continue;
        const obs = JSON.parse(JSON.stringify(observe(g, s.pid, { sinceTick: s.last })));
        s.last = g.t;
        const cmds = s.bot.think(obs);
        s.cmdCount = (s.cmdCount || 0) + cmds.length;
        for (const c of cmds) this.apply(s.pid, c);
        const top = cmds.filter((c) => c.cmd !== 'gather' && c.cmd !== 'set_rally').pop() || cmds[cmds.length - 1];
        if (top) {
          s.lastCmd = brief(top); s.lastCmdTick = g.t;
          // chat/notes never become the thought line (it would read "boom: say"); keep the last real plan, else the bot's note
          const real = cmds.filter((c) => !NON_PLAN.has(c.cmd) && c.cmd !== 'gather' && c.cmd !== 'set_rally').pop();
          if (real) s.thought = `${s.botName}: ${brief(real)}`.slice(0, 120);
          else if (!s.thought) s.thought = '';
        }
      }
    }
    for (const s of this.slots) {
      if (s.kind !== 'llm') continue;
      for (const { cmd, req } of s.agent.takeCommands(g)) {
        const r = this.apply(s.pid, cmd, req);
        s.agent.recordResult(cmd, r, g.t);
      }
      s.agent.maybeRequest(g);
    }
    g.step();
    if (g.t % 100 === 0)
      this.writeLog({ type: 'state', t: g.t, hash: g.hash(), players: g.players.filter(Boolean).map((p) => ({ id: p.id, res: p.res, pop: p.pop, cap: p.cap, tier: p.tier, score: g.score(p) })),
        hud: this.slots.map((s) => { if (s.kind !== 'llm') return null; const h = s.agent.hud(); return { latency: h.latency, tokS: h.tokS, tokSrc: h.tokSource, thinks: h.thinks, cmds: h.cmds, invalid: h.invalid, invalidBy: h.invalidBy, empty: h.empty }; }) });
    if (g.over || g.t >= this.maxTicks) this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    const g = this.game;
    for (const s of this.slots) if (s.kind === 'llm') s.agent.stop();
    const res = g.result();
    if (!g.over) res.reason = 'cutoff';
    this.result = { id: this.id, seed: this.seed, bots: this.names, ticks: g.t, hash: g.hash(), prompt_version: promptVersion(this.rules), prompt_hash: promptHash(this.rules), rules: this.rules,
      wall_seconds: +((performance.now() - this.wall0) / 1000).toFixed(1), ...res,
      agents: this.slots.map((s) => (s.kind === 'llm' ? { pid: s.pid, kind: 'llm', ...s.agent.summary() } : { pid: s.pid, kind: 'bot', name: s.botName, commands: s.cmdCount || 0 })) };
    this.writeLog({ type: 'result', ...res });
    if (this.logFd !== null) { fs.closeSync(this.logFd); this.logFd = null; }
    if (this.ioFd !== null) { fs.closeSync(this.ioFd); this.ioFd = null; }
    if (this.dir) fs.writeFileSync(path.join(this.dir, 'result.json'), JSON.stringify(this.result, null, 1));
  }

  // Headless real-time loop. speed = game seconds per wall second. Resolves with the result. Fixed-step and drift corrected (Pacer).
  async run({ speed = 1, onFrame } = {}) {
    const pacer = new Pacer();
    this.pacer = pacer;
    while (!this.finished) {
      await new Promise((r) => setTimeout(r, 10));
      let k = pacer.take(speed);
      while (k-- > 0 && !this.finished) this.tick();
      if (onFrame) onFrame(this);
    }
    return this.result;
  }
}
