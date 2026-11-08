// Runs one headless match between scripted bots. Used by match-headless, balance and tests.
import fs from 'node:fs';
import { Game } from '../sim/game.mjs';
import { observe } from '../sim/observe.mjs';
import { createBot } from '../agents/scripted/index.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { ensureFrozen } from '../sim-versions/lib.mjs';
import { trackEndCause, classifyEnd } from './lib/end-cause.mjs';

export const THINK_TICKS = 20; // a bot thinks every 2 game seconds

// trackEnd (default on): wrap kill/eliminate to learn why the match ended (tools/lib/end-cause.mjs); read-only, the state hash is the same without it.
export function runMatch({ seed = 1, bots = ['rush', 'boom'], teams, map, maxMinutes, onTick, log, rules, trackEnd = true } = {}) {
  const rl = resolveRules(rules);
  if (maxMinutes === undefined) maxMinutes = rl.timeLimitS / 60 + 1;
  const n = bots.length;
  const players = bots.map((b, i) => ({ team: teams ? teams[i] : i + 1, name: b }));
  const numPlayers = map ? undefined : n === 4 ? 4 : 2;
  const g = new Game({ seed, players, map, numPlayers, rules: rl });
  const ais = bots.map((b) => createBot(b));
  const tracker = trackEnd ? trackEndCause(g) : null;
  const lastThink = bots.map(() => -1);
  const firstAttack = { t: null };
  const maxTicks = Math.round(maxMinutes * 60 * TICK_HZ);
  const wall0 = performance.now();
  const logFd = log ? fs.openSync(log, 'w') : null;
  const writeLog = (o) => fs.writeSync(logFd, JSON.stringify(o) + '\n');
  if (logFd !== null) writeLog({ type: 'start', sim_version: ensureFrozen(), seed, bots, teams: players.map((p) => p.team), map: g.mapName, rules: rl, ...(map ? { map_data: map } : {}) });
  let prevKills = 0;
  while (!g.over && g.t < maxTicks) {
    if (g.t % THINK_TICKS === 0) {
      // Everybody observes and thinks on the same state; only then are the commands applied, in a rotating
      // order. (Applying while the next bot still has to observe would let the first bot's orders show up in the
      // second bot's observation.)
      const plans = [];
      for (let i = 0; i < n; i++) {
        const pid = i + 1;
        if (!g.players[pid].alive) continue;
        const obs = JSON.parse(JSON.stringify(observe(g, pid, { sinceTick: lastThink[i] })));
        lastThink[i] = g.t;
        plans.push({ i, pid, cmds: ais[i].think(obs) });
      }
      const rot = g.firstPlayer(g.t); // seeded, so no seat is always first
      plans.sort((a, b) => ((a.i + n - rot) % n) - ((b.i + n - rot) % n));
      for (const { pid, cmds } of plans) {
        for (const c of cmds) {
          const r = g.command(pid, c);
          if (logFd !== null) writeLog({ type: 'cmd', t: g.t, p: pid, cmd: c, ok: r.ok, err: r.ok ? undefined : r.error });
        }
      }
    }
    g.step();
    if (firstAttack.t === null && g.t % 10 === 0) {
      let k = 0;
      for (const p of g.players) if (p) k += p.kills + p.lostValue;
      if (k > 0 && prevKills === 0) firstAttack.t = g.t / TICK_HZ;
      prevKills = k;
    }
    if (logFd !== null && g.t % 100 === 0)
      writeLog({ type: 'state', t: g.t, hash: g.hash(), players: g.players.filter(Boolean).map((p) => ({ id: p.id, res: p.res, pop: p.pop, cap: p.cap, tier: p.tier, score: g.score(p) })) });
    if (onTick) onTick(g);
  }
  const wallMs = performance.now() - wall0;
  const res = g.result();
  if (logFd !== null) {
    writeLog({ type: 'result', ...res });
    fs.closeSync(logFd);
  }
  const end = tracker ? classifyEnd(res, tracker.summary(), { over: g.over }) : null;
  return { game: g, result: res, end, endCause: tracker ? tracker.summary() : null, wallMs, firstAttack: firstAttack.t, ticks: g.t, bots, ais };
}
