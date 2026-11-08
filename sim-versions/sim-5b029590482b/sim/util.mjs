// Shared constants and tiny helpers. Everything in the sim is integer math:
// positions are in milli-tiles (1 tile = 1000 units), time is in ticks (10 Hz).
export const SUB = 1000;
export const INF = 0x3fffffff;
export const TICK_HZ = 10;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// FNV-1a style hash step on a 32 bit int.
export function hashStep(h, v) {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}

// Compress a list of ids into "101-112,130".
export function idsToString(ids) {
  const a = [...ids].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < a.length; ) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`);
    i = j + 1;
  }
  return out.join(',');
}

// Parse "101-112,130" into [101..112,130]. Returns null on syntax error.
export function stringToIds(s) {
  const out = [];
  for (const part of String(s).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) return null;
    const a = +m[1], b = m[2] === undefined ? a : +m[2];
    if (b < a || b - a > 5000) return null;
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}
