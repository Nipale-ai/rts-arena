import { parentPort } from 'node:worker_threads';
import { runMatch } from './run-match.mjs';

parentPort.on('message', (job) => {
  const r = runMatch({ seed: job.seed, bots: job.bots, rules: job.rules });
  const res = r.result;
  parentPort.postMessage({
    id: job.id, bots: job.bots, seed: job.seed, godMode: res.godMode, winnerTeam: res.winnerTeam, reason: res.reason, seconds: res.seconds,
    firstAttack: r.firstAttack, wallMs: r.wallMs,
    end: r.end, // why it ended: destroyed, decay, wonder, shrine, resign, mutual, time, cutoff (tools/lib/end-cause.mjs)
    // content 2: how the match ended and what the new content did
    extra: {
      vp: res.vp || null, flips: (r.game.shrines || []).reduce((a, x) => a + x.flips, 0),
      wonders: r.game.announcements.filter((e) => e.type === 'wonder_started').map((e) => e.owner),
      wonderLost: r.game.announcements.filter((e) => e.type === 'wonder_destroyed').map((e) => e.owner),
      trades: r.game.players.filter(Boolean).map((p) => p.mkt.trades), built: r.game.players.filter(Boolean).map((p) => ({ market: p.built.market || 0, castle: p.built.castle || 0, outpost: p.built.outpost || 0 })),
    },
    players: res.players.map((p) => ({ id: p.id, alive: p.alive, score: p.score, trained: p.trained, unitStats: p.unitStats, tier: p.tier })),
  });
});
