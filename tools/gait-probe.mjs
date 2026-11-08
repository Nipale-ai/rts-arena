#!/usr/bin/env node
// Measures the hoof tracks of the baked rider clips (render/assets/models/units/*.anim): where the four hooves touch the ground and how far one cycle
// carries the horse at ground contact. render/gait.mjs keeps these numbers as constants; test/gait.test.mjs recomputes them with this file.
//   node tools/gait-probe.mjs [key ...]      (default: the three riders)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'render', 'assets', 'models', 'units');
export const KEYS = ['reiter', 'schwere-reiterei', 'kundschafter'];
const reg = JSON.parse(fs.readFileSync(path.join(DIR, 'UNITS.json'), 'utf8'));
const h2f = (h) => { const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1; return e === 0 ? s * 5.960464477539063e-8 * m : e === 31 ? NaN : s * 2 ** (e - 15) * (1 + m / 1024); };

// one track per hoof: the lowest bind-pose vertex of every leg (split front / hind by z, left / right by x), skinned with the baked matrices of every frame
export function hooves(key) {
  const fam = reg.families[reg.units[key].family], n = reg.units[key].lods[0].verts;
  const b = fs.readFileSync(path.join(DIR, `${key}_0.bin`));
  const pos = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 12));
  const off = n * 12 + n * 4 + n * 4, J = b.subarray(off, off + n * 4), W = b.subarray(off + n * 4, off + n * 8);
  const an = fs.readFileSync(path.join(DIR, `${key}.anim`)), A = new Uint16Array(an.buffer.slice(an.byteOffset, an.byteOffset + an.length)), Wd = fam.bones * 3;
  const skin = (v, row) => {
    const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], o = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const w = W[v * 4 + k] / 255; if (!w) continue; const bone = J[v * 4 + k];
      for (let r = 0; r < 3; r++) { const base = (row * Wd + bone * 3 + r) * 4; o[r] += w * (h2f(A[base]) * p[0] + h2f(A[base + 1]) * p[1] + h2f(A[base + 2]) * p[2] + h2f(A[base + 3])); }
    }
    return o;
  };
  let ymin = 1e9; for (let v = 0; v < n; v++) ymin = Math.min(ymin, pos[v * 3 + 1]);
  const lows = []; for (let v = 0; v < n; v++) if (pos[v * 3 + 1] < ymin + 0.07) lows.push(v);
  const zs = lows.map((v) => pos[v * 3 + 2]).sort((a, c) => a - c), zm = (zs[0] + zs[zs.length - 1]) / 2, grp = new Map();
  for (const v of lows) { const k = (pos[v * 3] > 0 ? 1 : 0) + (pos[v * 3 + 2] > zm ? 2 : 0), cur = grp.get(k); if (!cur || pos[v * 3 + 1] < pos[cur * 3 + 1]) grp.set(k, v); }
  const legs = [...grp.values()].map((v) => ({ v, x: pos[v * 3], z: pos[v * 3 + 2] })).sort((a, c) => c.z - a.z || a.x - c.x); // front legs first
  const clips = {};
  for (const clip of ['walk', 'run']) { const c = fam.clips[clip]; clips[clip] = { n: c.n, legs: legs.map((l) => { const t = []; for (let f = 0; f < c.n; f++) t.push(skin(l.v, c.start + f)); return t; }) }; }
  return { key, legs, clips };
}

// ground contact samples [leg, backward speed of the hoof in model units per cycle] (the hoof is low and moves backwards)
function contacts(h, clip) {
  const { n, legs } = h.clips[clip], smp = [];
  legs.forEach((t, i) => {
    const ys = t.map((p) => p[1]), lo = Math.min(...ys), hi = Math.max(...ys);
    for (let f = 0; f < n; f++) { const dz = -(t[(f + 1) % n][2] - t[(f + n - 1) % n][2]) / 2 * n; if (ys[f] <= lo + 0.02 + (hi - lo) * 0.2 && dz > 0.3) smp.push([i, dz, i < 2 ? 1 : 0.6]); }
  });
  return smp;
}
// stride that fits the contact samples best (least squares of the relative slip): `stride` model units per cycle, `slip` = RMS of the relative sliding
export function bestStride(key, clip, h = hooves(key)) {
  const smp = contacts(h, clip); let best = null;
  for (let S = 0.2; S <= 5; S += 0.01) {
    let e = 0, w = 0; for (const [, dz, wt] of smp) { const r = 1 - dz / S; e += wt * r * r; w += wt; }
    const rms = Math.sqrt(e / w); if (!best || rms < best.slip) best = { stride: +S.toFixed(2), slip: +rms.toFixed(3) };
  }
  return { ...best, samples: smp.length };
}
// touchdown frames per leg: walk = forward extreme of the swing, run = the hoof falling below the ground threshold (a leg may land more than once)
export function touchdowns(key, clip, h = hooves(key)) {
  const { n, legs } = h.clips[clip];
  return legs.map((t) => {
    const ys = t.map((p) => p[1]), zs = t.map((p) => p[2]);
    if (clip === 'walk') {
      let b = 0; for (let f = 1; f < n; f++) if (zs[f] > zs[b]) b = f;
      const a = zs[(b + n - 1) % n], c = zs[b], d = zs[(b + 1) % n], o = (a - d) / (2 * (a - 2 * c + d));
      return [+(((b + o) % n + n) % n).toFixed(1)];
    }
    const lo = Math.min(...ys), hi = Math.max(...ys), thr = lo + 0.03 + (hi - lo) * 0.1, out = [];
    for (let f = 0; f < n; f++) { const a = ys[(f + n - 1) % n], c = ys[f]; if (a > thr && c <= thr) out.push(+((((f - 1 + (a - thr) / (a - c)) % n) + n) % n).toFixed(1)); }
    return out;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const key of process.argv.length > 2 ? process.argv.slice(2) : KEYS) {
    const h = hooves(key);
    for (const clip of ['walk', 'run']) console.log(key, clip, 'frames', h.clips[clip].n, 'stride', JSON.stringify(bestStride(key, clip, h)), 'touchdown frames (fl fr hl hr)', JSON.stringify(touchdowns(key, clip, h)));
  }
}
