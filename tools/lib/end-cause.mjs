// Why did a match end? Tools only, never sim/: wraps kill() and eliminate() on a Game object to see what removed the
// last building that put a player out. The wrappers only read; they never change a field the sim hashes
// (tools/test: g.hash() is identical with and without them).
//
//   const tr = trackEndCause(g);  ...run the match...  classifyEnd(g.result(), tr.summary(), { over: g.over })

// Classes of an end. 'destroyed' = real elimination by attack (also when only the town center is left: no unit, no food, flag
// stranded). 'decay' = the last building that put the loser out
// crumbled in sudden death (a kill with no killer). The owner counts decay as "by time" (see timeShare).
export const END_CLASSES = ['destroyed', 'decay', 'wonder', 'shrine', 'resign', 'mutual', 'time', 'cutoff', 'unknown'];
export const END_LABEL = { destroyed: 'destroyed', decay: 'decay', wonder: 'wonder', shrine: 'shrine', resign: 'resign', mutual: 'mutual', time: 'time limit', cutoff: 'cutoff', unknown: 'unknown' };

const PRODUCTION_FALLBACK = new Set(['barracks', 'archery_range', 'stables', 'siege_workshop', 'castle']);

// a building whose loss can put a player out: the town center or a production building
function critical(g, e) {
  if (e.type === 'town_center') return true;
  const d = g.players?.[e.owner]?.faction?.buildings?.[e.type];
  return d ? !!d.production : PRODUCTION_FALLBACK.has(e.type);
}

export function trackEndCause(g) {
  const lastCritical = {}; // owner -> the latest town center / production building that was killed
  const elims = [];
  const kill0 = g.kill, elim0 = g.eliminate;
  if (typeof kill0 === 'function') {
    g.kill = function (e, killerOwner, src) {
      if (e && e.kind === 2 && !e.dead && !e.dying && critical(this, e)) lastCritical[e.owner] = { t: this.t, type: e.type, killer: killerOwner || 0, src: src || null };
      return kill0.call(this, e, killerOwner, src);
    };
  }
  if (typeof elim0 === 'function') {
    g.eliminate = function (p, reason) {
      let tc = false;
      for (const b of this.buildings.values()) if (b.owner === p.id && b.type === 'town_center' && !b.dead && !b.dying) tc = true;
      const lk = lastCritical[p.id] || null;
      // resigned: the player's own command. A town center still standing: the economy ran dry (no unit, no food).
      // Otherwise the last critical building decides: no killer = sudden-death decay.
      const cause = reason === 'resigned' ? 'resign' : tc ? 'stranded' : lk && lk.killer === 0 ? 'decay' : 'destroyed';
      elims.push({ p: p.id, team: p.team, t: this.t, reason, cause, last: lk });
      return elim0.call(this, p, reason);
    };
  }
  return { summary: () => ({ elims: elims.map((e) => ({ ...e })) }) };
}

// -> { cls, decayMutual?, inferred? }
//   res    a Game.result() / result.json object ({ reason, winnerTeam, seconds })
//   sum    trackEndCause(...).summary() or null (then the class is inferred from the result and the opts)
//   opts   { over, resigned, sdStartS }  over: did the game end (false = cutoff); resigned / sdStartS only feed the inference
export function classifyEnd(res, sum, opts = {}) {
  const reason = res.reason || '';
  if (opts.over === false) return { cls: 'cutoff' };
  if (reason === 'wonder') return { cls: 'wonder' };
  if (reason === 'shrines' || reason === 'shrine') return { cls: 'shrine' };
  if (reason.startsWith('time')) return { cls: 'time' };
  const elims = sum?.elims;
  if (reason.startsWith('mutual')) {
    let decay = false;
    if (elims?.length) {
      const tEnd = Math.max(...elims.map((e) => e.t));
      decay = elims.filter((e) => e.t === tEnd).every((e) => e.cause === 'decay');
    }
    return { cls: 'mutual', decayMutual: decay };
  }
  if (reason === 'victory') {
    if (elims?.length) {
      // the elimination that ended the match: the last one of a player on a team other than the winner
      const lose = elims.filter((e) => e.team !== res.winnerTeam);
      const e = lose.length ? lose[lose.length - 1] : elims[elims.length - 1];
      return e.cause === 'stranded' ? { cls: 'destroyed', stranded: true } : { cls: e.cause };
    }
    if (opts.resigned) return { cls: 'resign', inferred: true };
    // no per-kill info: before sudden death a base can only have fallen to an attack
    if (opts.sdStartS && res.seconds < opts.sdStartS) return { cls: 'destroyed', inferred: true };
    return { cls: 'unknown', inferred: true };
  }
  return { cls: 'unknown', inferred: true };
}

export const sdStartOf = (rules) => (rules && rules.suddenDeath) || 0;

// Counts and shares of a list of classifyEnd() results.
// timeShare = time limit + cutoff + decay (the owner's rule: a base that falls to sudden-death decay is "by time");
// timeShareMutual also adds mutual destruction caused by decay on both sides.
export function tallyEnds(list) {
  const n = list.length, c = Object.fromEntries(END_CLASSES.map((k) => [k, 0]));
  let decayMutual = 0, stranded = 0;
  for (const e of list) {
    const cls = e.cls === 'stranded' ? 'destroyed' : e.cls; // older json files carry 'stranded' as a class of its own
    c[cls]++;
    if (e.stranded || e.cls === 'stranded') stranded++;
    if (cls === 'mutual' && e.decayMutual) decayMutual++;
  }
  const share = (x) => (n ? x / n : 0);
  return { n, counts: c, decayMutual, stranded, timeShare: share(c.time + c.cutoff + c.decay), timeShareMutual: share(c.time + c.cutoff + c.decay + decayMutual) };
}

// one line for tools/balance.mjs
export function tallyLine(list) {
  const t = tallyEnds(list), pc = (x) => (t.n ? Math.round((100 * x) / t.n) : 0);
  const parts = END_CLASSES.filter((k) => t.counts[k]).map((k) => `${END_LABEL[k]} ${pc(t.counts[k])}%`);
  return `ended by: ${parts.join(', ')}; time share (time limit + cutoff + decay) ${(100 * t.timeShare).toFixed(0)}%`;
}
