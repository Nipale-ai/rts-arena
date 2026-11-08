// Replay loading and a deterministic re-simulation driver shared by the broadcast tools.
// A replay is a directory (log.jsonl + optional io.jsonl, result.json) or a bare .jsonl log.
// The driver applies the logged commands exactly like server/replay-verify.mjs and never changes sim behaviour.
import fs from 'node:fs';
import path from 'node:path';
import { TICK_HZ } from '../../sim/util.mjs';
import { simForReplay, newGameOf } from '../../sim-versions/lib.mjs';

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const readJsonOr = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// the recipe maker of a player (id in configs/creators.json): from the start line, else from players.json next to the log
export const creatorOf = (start, sidecar, i) => start.players?.[i]?.creator ?? sidecar?.[i]?.creator ?? start.creators?.[i] ?? null;
// models that would play without the flag of their recipe maker
export const missingFlags = (players, init) => players.filter((p, i) => p.kind === 'llm' && !init.players?.[i]?.creator);
// what the event list needs from the files next to the log: the display name of each recipe maker and the measured numbers (bench.json)
export function enrichEvents(rep, ev, registry = {}) {
  // a copy: rep.players keep the id, the flag in the picture needs it
  ev.players = ev.players.map((p, i) => { const c = rep.players[i]?.creator; return c ? { ...p, creator: registry[c]?.name || c } : p; });
  if (rep.bench) ev.bench = rep.bench;
  // the resolved rules of a day with its own win rule (preset war): the casters may only name their numbers from a fact (tools/caster-facts.mjs dayRulesText). Other days stay as they were.
  if (rep.start?.rules?.noScoreWin) ev.rules = rep.start.rules;
  return ev;
}

// rep.sim is the sim bundle (Game, observe, data ...) of the version the replay was recorded with; every consumer re-simulates with it.
export function loadReplay(dirOrFile) {
  let file = path.resolve(dirOrFile);
  const isDir = fs.statSync(file).isDirectory();
  const dir = isDir ? file : path.dirname(file);
  if (isDir) file = path.join(dir, 'log.jsonl');
  const lines = readJsonl(file);
  const start = lines.find((l) => l.type === 'start');
  if (!start) throw new Error(`replay has no start line: ${file}`);
  const cmds = lines.filter((l) => l.type === 'cmd').map((c, i) => ({ ...c, _i: i })).sort((a, b) => a.t - b.t || a._i - b._i);
  const states = lines.filter((l) => l.type === 'state');
  const result = lines.find((l) => l.type === 'result') || null;
  const ioFile = path.join(dir, 'io.jsonl');
  const io = isDir && fs.existsSync(ioFile) ? readJsonl(ioFile) : [];
  const n = start.bots.length;
  const sidecar = isDir ? readJsonOr(path.join(dir, 'players.json'), null) : null;
  const players = start.bots.map((b, i) => {
    const meta = start.players?.[i];
    if (meta) return { id: i + 1, kind: meta.kind, name: meta.name, model: meta.model, hardware: meta.hardware, creator: creatorOf(start, sidecar, i) };
    return { id: i + 1, kind: 'bot', name: cap(b), model: `scripted bot: ${b}`, hardware: 'Node.js, no GPU' };
  });
  const lastCmd = cmds.length ? cmds[cmds.length - 1].t : 0;
  const lastState = states.length ? states[states.length - 1].t : 0;
  const endTick = result?.tick ?? Math.max(lastCmd, lastState);
  const sim = simForReplay(dir, start, { lenient: true });
  return { id: path.basename(dir), dir, file, sim, simVersion: sim.id, start, cmds, states, result, io, players, n, seed: start.seed, endTick, bench: isDir ? readJsonOr(path.join(dir, 'bench.json'), null) : null };
}

export function newGame(rep) {
  return newGameOf(rep.sim, rep.start);
}

// Steps a replay one tick at a time. sim.game is the live Game; sim.t is the current tick.
export class ReplaySim {
  constructor(rep, game = newGame(rep)) {
    this.rep = rep;
    this.game = game;
    this.i = 0;
  }
  get t() { return this.game.t; }
  get done() { return this.game.over || this.game.t >= this.rep.endTick; }
  step() {
    const g = this.game, c = this.rep.cmds;
    if (this.done) return false;
    while (this.i < c.length && c[this.i].t <= g.t) { g.command(c[this.i].p, c[this.i].cmd); this.i++; }
    g.step();
    return true;
  }
  stepTo(tick) { while (this.game.t < tick && this.step()); }
}

export const secOf = (tick) => tick / TICK_HZ;
