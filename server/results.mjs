// Which finished matches count for rankings, statistics and posts about model strength.
// A match in which the spectator intervened (God mode: gifts, spawned or removed units, events, reveal ...) never counts.
// Every place that records or lists results for comparison must filter through here.

// x: a result.json / Game.result() object, or a match record that holds one in .result
export function isGodMode(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.godMode === true) return true;
  return !!(x.result && typeof x.result === 'object' && x.result.godMode === true);
}

// A solo run (tools/solo/: one model against a scripted bot in a scenario) is measured on its own list. It never counts for the model-against-model rankings.
// The marker is solo: { scenario, level, seed, runIndex }. It lives in runMeta.json next to the replay and, for a solo start through the arena, in the match record.
export function isSolo(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.solo && typeof x.solo === 'object') return true;
  return !!(x.result && typeof x.result === 'object' && x.result.solo && typeof x.result.solo === 'object');
}

// a marker from outside (API body, file) reduced to the four plain fields, or null
export function soloMarker(x) {
  if (!x || typeof x !== 'object') return null;
  const n = (v) => (Number.isFinite(+v) ? Math.trunc(+v) : 0);
  return { scenario: typeof x.scenario === 'string' ? x.scenario.slice(0, 60) : '', level: n(x.level), seed: n(x.seed), runIndex: n(x.runIndex) };
}

export function countsForRanking(x) {
  return !!x && !isGodMode(x) && !isSolo(x);
}

// The `ranked` flag of a finished match record. countsForRanking(result) alone does not see how the run ended:
//   stopped  stopped by hand (arena: e.stopped; LiveMatch then writes reason "cutoff")
//   solo     the solo marker (runMeta.solo, or record.solo)
//   invalid  a run declared invalid (runMeta.valid === false, or a runMeta that never reached status "done")
// A result with reason "cutoff" has no ending, so it never ranks either.
export function rankedOf(result, { stopped = false, solo = null, invalid = false } = {}) {
  if (stopped || invalid || solo) return false;
  if (result && result.reason === 'cutoff') return false;
  return countsForRanking(result);
}

export function rankableMatches(list) {
  return (list || []).filter(countsForRanking);
}
