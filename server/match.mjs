#!/usr/bin/env node
// Real-time match with LLM players (or LLM vs scripted bot) plus the spectator page.
//   node server/match.mjs --p1 configs/mock-fast.json --p2 scripted:boom --seed 42 [--speed 1] [--port 0]
//        [--headless] [--run-without-viewer] [--max-game-min N] [--no-record]
//   node server/match.mjs --verify replays/<id>        replay the command log and compare the end hash
// Player spec: path to a config JSON (see configs/example-llamacpp.json), "scripted:<boom|rush|turtle>".
import { args, Match, serve } from './spectate.mjs';
import { LiveMatch } from './live-match.mjs';
import { verifyReplay } from './replay-verify.mjs';
import { TICK_HZ } from '../sim/util.mjs';

const A = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const nx = process.argv[i + 1];
  if (nx === undefined || nx.startsWith('--')) A[a.slice(2)] = true;
  else { A[a.slice(2)] = nx; i++; }
}

if (A.verify) {
  const r = verifyReplay(String(A.verify));
  console.log(JSON.stringify(r));
  console.log(r.ok ? 'replay reproduces the recorded match' : 'REPLAY DIFFERS');
  process.exit(r.ok ? 0 : 1);
}
if (!A.p1 || !A.p2) {
  console.error('usage: node server/match.mjs --p1 <config.json|scripted:boom> --p2 <config.json|scripted:boom> [--seed 42] [--speed 1] [--headless]');
  process.exit(2);
}

const liveOpts = { seed: A.seed ?? 42, p1: A.p1, p2: A.p2, record: !A['no-record'], cls: typeof A.class === 'string' ? A.class : undefined, creators: [A['p1-creator'], A['p2-creator']].map((c) => (typeof c === 'string' ? c : null)), maxGameSeconds: A['max-game-min'] ? +A['max-game-min'] * 60 : undefined };

function report(live) {
  const r = live.result;
  console.log(`match over: ${r.reason}, winner team ${r.winnerTeam || 'none'}, ${(r.seconds / 60).toFixed(1)} min game time, ${r.wall_seconds}s wall, hash ${r.hash}`);
  for (const a of r.agents) {
    if (a.kind === 'llm') console.log(`  P${a.pid} ${a.name} (${a.model}, ${a.hardware}): ${a.replies}/${a.requests} replies, ${a.errors} errors, latency median ${a.latency_ms.median} ms, ${a.tok_s_avg ?? '-'} tok/s, ${a.commands_applied} orders ok, ${a.commands_rejected} rejected, ${a.parse_errors} unparsable replies`);
    else console.log(`  P${a.pid} scripted ${a.name}: ${a.commands} commands`);
  }
  if (live.dir) console.log(`replay: ${live.dir}`);
}

if (A.headless) {
  const live = new LiveMatch(liveOpts);
  console.log(`headless: ${live.names.join(' vs ')}, seed ${live.seed}, speed ${A.speed || 1}x${live.dir ? ', recording to ' + live.dir : ''}`);
  let lastPrint = 0;
  process.on('SIGINT', () => { live.finish(); report(live); process.exit(0); });
  await live.run({ speed: +(A.speed || 1), onFrame: (m) => { if (m.game.t - lastPrint >= 600) { lastPrint = m.game.t; console.log(`  t=${Math.round(m.game.t / TICK_HZ)}s ` + m.slots.map((s) => (s.kind === 'llm' ? `${s.name}: ${s.agent.m.requests} req ${s.agent.m.cmds_applied} ok` : s.name)).join(' | ')); } } });
  report(live);
  process.exit(0);
}

// spectator mode: same server and page as server/spectate.mjs
Object.assign(args, { speed: A.speed, port: A.port, 'run-without-viewer': A['run-without-viewer'], 'no-record': A['no-record'] });

class LlmMatch extends Match {
  initLive() {
    this.live = new LiveMatch(liveOpts);
    const l = this.live;
    this.seed = l.seed;
    this.game = l.game;
    this.botNames = l.names;
    this.names = l.names;
    this.models = l.models;
    this.hws = l.hws;
    this.creators = l.creators;
    this.cls = l.cls;
    this.id = l.id;
    this.dir = l.dir;
  }
  tick() {
    this.live.tick();
    const g = this.game;
    this.live.slots.forEach((s, i) => {
      const m = this.metrics[i];
      if (s.kind === 'llm') {
        const h = s.agent.hud();
        m.latency = h.latency; m.tokS = h.tokS; m.tokSrc = h.tokSource; m.thinks = h.thinks; m.cmds = h.cmds; m.invalid = h.invalid; m.invalidBy = h.invalidBy; m.empty = h.empty;
        m.thought = h.thought; m.lastCmd = h.lastCmd; m.lastCmdT = h.lastCmdTick;
      } else if (s.lastCmd) {
        m.lastCmd = s.lastCmd; m.lastCmdT = s.lastCmdTick; m.thought = s.thought || '';
      }
    });
    if (this.live.finished && !this.finished) this.finish();
    void g;
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.live.finish();
    report(this.live);
  }
}

serve(new LlmMatch());
