// Camera plan of the commentary: every placed caster line has a subject (a unit group, a building, a base, a fight; ids from the fact
// sheet, which come from the log). The director flies to the subject a little before the line starts and holds it while it is discussed.
//   focusPlan(placed, beats, sheet, duration_s, opts) -> [{ o0, o1, subject, line }]   contiguous segments over the video, no segment shorter than min_dwell_s
export const FOCUS = {
  lead_s: 1.7,       // the camera starts to fly this long before the line starts
  hold_s: 0.6,       // and stays this long after it ends when nothing else follows
  min_dwell_s: 2.6,  // a subject stays on screen at least this long (no hectic switching)
};

export function focusPlan(placed, beats, sheet, duration, opts = {}) {
  const F = { ...FOCUS, ...opts };
  const byBeat = new Map(beats.map((b) => [b.id, b]));
  const known = new Set((sheet.subjects || []).map((s) => s.id));
  const lines = [...placed].filter((l) => !l.interject).sort((a, b) => a.start - b.start);
  const subjOf = (l) => (l.subject && known.has(l.subject) ? l.subject : byBeat.get(l.beat)?.subjects?.[0] ?? null);
  // one segment per run of lines with the same subject
  let segs = [];
  for (const l of lines) {
    const sj = subjOf(l);
    if (!sj) continue;
    const last = segs[segs.length - 1];
    if (last && last.subject === sj) { last.end = Math.max(last.end, l.end); continue; }
    segs.push({ subject: sj, start: l.start, end: l.end, line: l.id });
  }
  const first = beats[0]?.subjects?.[0] ?? null;
  if (!segs.length && first) segs.push({ subject: first, start: 0, end: duration, line: null });
  // the first segment starts at 0; every later one starts `lead_s` before its first line (but not before the previous line is half done)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], prev = segs[i - 1];
    s.o0 = i === 0 ? 0 : Math.max(prev.o0 + 0.5, Math.min(s.start - F.lead_s, s.start - 0.3));
  }
  // a subject that would be on screen less than min_dwell_s is skipped (its line is still said, over the neighbour's shot)
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const len = (segs[i + 1] ? segs[i + 1].o0 : duration) - segs[i].o0;
      if (len < F.min_dwell_s && i + 1 < segs.length) { segs.splice(i, 1); changed = true; if (i === 0) segs[0].o0 = 0; break; }
    }
  }
  for (let i = 0; i < segs.length; i++) segs[i].o1 = i + 1 < segs.length ? segs[i + 1].o0 : duration;
  return segs.map((s) => ({ o0: +s.o0.toFixed(2), o1: +s.o1.toFixed(2), subject: s.subject, line: s.line }));
}
