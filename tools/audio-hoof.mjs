#!/usr/bin/env node
// Writes the hoof sounds of the riders (render/assets/audio/hoof/*.ogg) and their events in the manifest. Procedural, own work, no samples:
// one hoof landing on dirt = a low thump with a falling pitch, a short crunch of the ground, a faint click of the shoe and, for the heavy horse,
// a rattle of harness. Seeded, so the same call writes the same files.
//   node tools/audio-hoof.mjs [--no-manifest]
// The beats themselves (which beat falls where in a stride) come from render/gait.mjs; this file only makes the single hit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO = path.join(ROOT, 'render', 'assets', 'audio');
const SR = 48000;
const mulberry = (a) => () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// one hit; heavy = deeper, longer, with the rattle of harness
export function hit(seed, heavy) {
  const R = mulberry(seed), j = (v, k) => v * (1 + (R() * 2 - 1) * k), n = Math.round(SR * (heavy ? 0.3 : 0.22)), out = new Float32Array(n);
  const f0 = j(heavy ? 105 : 150, 0.08), f1 = j(heavy ? 52 : 78, 0.08), tauB = j(heavy ? 0.05 : 0.03, 0.15), tauD = j(0.022, 0.2), tauT = j(heavy ? 0.075 : 0.05, 0.2);
  const aB = j(0.9, 0.08), aD = j(heavy ? 0.6 : 0.7, 0.12), aC = j(heavy ? 0.18 : 0.3, 0.2), aT = j(heavy ? 0.45 : 0.25, 0.15);
  const jr = heavy || R() < 0.4 ? j(0.07, 0.3) : 0, jf1 = j(1850, 0.12), jf2 = j(2900, 0.12);
  const lp = (a) => 1 - Math.exp((-2 * Math.PI * a) / SR);
  let ph = 0, z1 = 0, z2 = 0, z3 = 0, z4 = 0;
  const k1 = lp(2200), k2 = lp(380), k3 = lp(3500), k4 = lp(420);
  for (let i = 0; i < n; i++) {
    const t = i / SR, w = R() * 2 - 1;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.018); ph += (2 * Math.PI * f) / SR;
    z1 += (w - z1) * k1; z2 += (w - z2) * k2; z3 += (w - z3) * k3; z4 += (w - z4) * k4;
    let v = aB * Math.sin(ph) * Math.exp(-t / tauB);
    v += aD * (z1 - z2) * 2.2 * Math.exp(-t / tauD);                // crunch of the ground (band 380 - 2200 Hz)
    v += aC * (w - z3) * Math.exp(-t / 0.0025);                      // click of the shoe
    v += aT * z4 * 2.5 * Math.exp(-t / tauT);                        // low rumble of the impact
    if (jr && t > 0.004) { const e = Math.exp(-(t - 0.004) / 0.07); v += jr * e * (Math.sin(2 * Math.PI * jf1 * t) + 0.6 * Math.sin(2 * Math.PI * jf2 * t)); }
    out[i] = v * Math.min(1, t / 0.0004) * Math.min(1, (n - 1 - i) / (SR * 0.02));
  }
  let pk = 0; for (const v of out) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] *= 0.7 / pk;
  return out;
}
const rms400 = (x) => { const w = Math.round(0.4 * SR); let best = 0, s = 0; for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; if (i >= w) s -= x[i - w] * x[i - w]; best = Math.max(best, s); } return +(10 * Math.log10(best / w)).toFixed(1); };

const KINDS = { hoof_light: { heavy: false, seeds: [9101, 9102, 9103, 9104, 9105], gain_db: 3 }, hoof_heavy: { heavy: true, seeds: [9201, 9202, 9203, 9204, 9205], gain_db: 3 } };

function main() {
  const dir = path.join(AUDIO, 'hoof'); fs.mkdirSync(dir, { recursive: true });
  const man = JSON.parse(fs.readFileSync(path.join(AUDIO, 'manifest.json'), 'utf8')), events = {};
  let bytes = 0, clips = 0;
  for (const [id, K] of Object.entries(KINDS)) {
    const files = [], levels = [];
    K.seeds.forEach((seed, i) => {
      const x = hit(seed, K.heavy), rel = `hoof/${id}_${i + 1}.ogg`, tmp = path.join(os.tmpdir(), `${id}_${i + 1}.f32`);
      fs.writeFileSync(tmp, Buffer.from(x.buffer));
      const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', tmp, '-c:a', 'libopus', '-b:a', '64k', path.join(AUDIO, rel)]);
      if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr);
      fs.unlinkSync(tmp);
      files.push(rel); levels.push(rms400(x)); bytes += fs.statSync(path.join(AUDIO, rel)).size; clips++;
    });
    events[id] = { group: 'hoof', bus: 'sfx', loop: false, spatial: true, files, gain_db: K.gain_db, pitch: [0.94, 1.06], cooldown_ms: 0, max_voices: 8, priority: 1, ref_dist: 9, dur_s: null, level_rms_db: levels,
      source: { generator: 'procedural', script: 'tools/audio-hoof.mjs', seeds: K.seeds }, licence: 'own work (code), no samples' };
  }
  if (process.argv.includes('--no-manifest')) { console.log(JSON.stringify(events, null, 1)); return; }
  Object.assign(man.events, events);
  man.groups.hoof = { events: Object.keys(KINDS).length, clips, bytes };
  fs.writeFileSync(path.join(AUDIO, 'manifest.json'), JSON.stringify(man, null, 1));
  console.log(`hoof: ${clips} clips, ${bytes} bytes`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
