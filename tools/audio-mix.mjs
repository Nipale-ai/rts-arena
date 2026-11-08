#!/usr/bin/env node
// Deterministic offline sound mix for a broadcast cut: replay -> sound triggers (the same SoundDirector as the live page) ->
// plan timeline (fast-forward / slow motion aware) -> ambience + music + one-shots -> ducking under the caster lines ->
// loudness to about -14 LUFS, true peak below -1 dBTP -> WAV. No clock, no Math.random: same replay + plan = same bytes.
//   node tools/audio-mix.mjs replays/<id> [--cut highlight|full] [--out dir] [--limit-s N] [--no-casters] [--target 60,90]
// render-broadcast.mjs calls mixCut() with --audio on (default) and muxes the WAV into the MP4.
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strikesOver } from '../render/lightning.mjs';
import { SoundDirector, shape, limitHoofs, thunderCue, thunderDelay, VoiceBook, Tension, musicWeights, ambientWeights, minPriorityForSpeed, musicSequence, MUSIC_XF, isDeathCue, hash32, packOf, CLASSIC_PACK, VariantPicker, FireControl, fireClass, carpetWeight, carpetId, CARPET_GAIN } from '../render/audio-core.mjs';
import { withSounds, pruneEvents } from '../render/theme/sound-theme.mjs'; // theme: the event table and the sounds of the types (the same code as the live page)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIO_DIR = path.join(ROOT, 'render', 'assets', 'audio');
export const SR = 48000;
export const TARGET_LUFS = -14, TP_CEILING_DB = -2.6;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dbg = (d) => Math.pow(10, d / 20);
export const BUS_DB = { sfx: -1, alerts: -5, ambient: -4, music: -7, big: -2 };            // balance before loudness normalisation
export const DUCK_DB = { sfx: -12, alerts: -12, ambient: -15, music: -20, big: -6 }; // under caster lines (owner 26.10.: music -20, ambience -15, SFX -12; only very big events (priority >= 8: base falls, tier-up fanfares, stings) poke through at -6)
export const BIG_PRIORITY = 8;
export const VOICE_OVER_BED_LU = Number(process.env.RTS_VOICE_OVER_BED_LU) || 15; // the voice sits at least this far above the ducked bed during the lines (owner: 15 LU)
export const DUCK_TIMES = { attack_s: 0.15, release_s: 0.6, hold_gap_s: 1.2, lead_s: 0.15, tail_s: 0.1 }; // gaps shorter than hold_gap_s stay ducked (no pumping)
// gain envelope (linear) for `casters` [{start,end}] in seconds: merged over short gaps, one-pole attack / release
export function duckEnvelope(N, casters, gainLin, T = DUCK_TIMES) {
  const tgt = new Float32Array(N).fill(1), iv = [...casters].sort((a, b) => a.start - b.start).map((c) => [c.start, c.end]), merged = [];
  for (const c of iv) { const l = merged[merged.length - 1]; if (l && c[0] - l[1] < T.hold_gap_s) l[1] = Math.max(l[1], c[1]); else merged.push([...c]); }
  for (const [a, b] of merged) { const s = Math.max(0, Math.round((a - T.lead_s) * SR)), e = Math.min(N, Math.round((b + T.tail_s) * SR)); for (let i = s; i < e; i++) tgt[i] = gainLin; }
  const ka = 1 - Math.exp(-1 / (T.attack_s * SR)), kr = 1 - Math.exp(-1 / (T.release_s * SR)); let v = 1;
  for (let i = 0; i < N; i++) { const t = tgt[i]; v += (t - v) * (t < v ? ka : kr); tgt[i] = v; }
  return tgt;
}

// ---------------------------------------------------------------- 1. triggers from the replay (re-simulation, read only)
export async function collectTriggers(rep, window, { dirOpts = {} } = {}) {
  const { args: spectateArgs, Match } = await import('../server/spectate.mjs');
  spectateArgs.replay = rep.dir;
  rep.players.forEach((p, i) => { spectateArgs[`p${i + 1}-model`] = p.model; spectateArgs[`p${i + 1}-hw`] = p.hardware; });
  const log = console.log; console.log = () => {};
  let match, init;
  try { match = new Match(); init = match.initMsg(); } finally { console.log = log; }
  const dir = new SoundDirector(init, { alerts: ['base', 'building_lost', 'tier'], ...withSounds(dirOpts) }); // (a shooter table brings the sound theme of its theme with it, unless dirOpts.sounds says otherwise)
  const game = match.game, out = [], emit = [];
  const [a, b] = window;
  console.log = () => {};
  try {
    while (!game.over && game.t < Math.min(b, rep.endTick)) {
      match.tick();
      if (game.t < a) continue;
      const snap = match.snapshot(), r = dir.feed(snap);
      for (const t of r.triggers) out.push(t);
      if (game.t % 5 === 0) emit.push({ t: game.t, wx: snap.wx ? snap.wx[0] : 0, fighting: r.fighting.length, fp: r.fighting.length ? [r.fighting.reduce((s, f) => s + f[0], 0) / r.fighting.length, r.fighting.reduce((s, f) => s + f[1], 0) / r.fighting.length] : null, buildings: game.buildings.size });
    }
  } finally { console.log = log; }
  return { init, triggers: out, samples: emit, dir };
}

// ---------------------------------------------------------------- 2. clip loading (ffmpeg decode, cached)
const clipCache = new Map();
// where a clip file is: a manifest file is relative to render/assets/audio/; a theme sound is a file: url or an absolute path (render/shooter-theme.mjs soundEvents)
export const clipPath = (file) => (/^file:/i.test(file) ? fileURLToPath(file) : path.isAbsolute(file) ? file : path.join(AUDIO_DIR, file));
export function loadClip(file, stereo) {
  const key = file + (stereo ? ':2' : ':1');
  if (clipCache.has(key)) return clipCache.get(key);
  const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', clipPath(file), '-f', 'f32le', '-ac', stereo ? '2' : '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('cannot decode ' + file);
  const f = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
  let c;
  if (stereo) { const n = f.length / 2, l = new Float32Array(n), rr = new Float32Array(n); for (let i = 0; i < n; i++) { l[i] = f[2 * i]; rr[i] = f[2 * i + 1]; } c = [l, rr]; } else c = [f];
  clipCache.set(key, c); return c;
}
// the manifest of a sound pack (render/assets/<pack>/manifest.json). A pack other than the classic one has its files relative to its own folder (they may point into other folders with ..): here they become absolute paths, which clipPath / loadClip take as they are.
export const manifest = (pack = CLASSIC_PACK) => {
  const dir = path.join(ROOT, 'render', 'assets', pack), m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (pack !== CLASSIC_PACK) for (const e of Object.values(m.events)) e.files = e.files.map((f) => path.resolve(dir, f));
  return m;
};

// ---------------------------------------------------------------- 3. mix
function putMono(bus, src, start, gain, pan, rate, lp) {
  let s = src;
  if (rate !== 1) { const n = Math.floor(src.length / rate), o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * rate, j = Math.floor(p), f = p - j; o[i] = src[j] * (1 - f) + (src[j + 1] || 0) * f; } s = o; }
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4, gl = Math.cos(a) * gain, gr = Math.sin(a) * gain;
  const k = lp && lp < 17000 ? 1 - Math.exp((-2 * Math.PI * lp) / SR) : 1; let z = 0;
  const L = bus[0], R = bus[1], base = Math.max(0, start);
  for (let i = 0; i < s.length && base + i < L.length; i++) { z += (s[i] - z) * k; L[base + i] += z * gl; R[base + i] += z * gr; }
}
function loopInto(bus, clip, env, ctlSamples) { // env: per-control-point gain, linear interpolation
  const n = bus[0].length, st = clip.length === 2 ? clip : [clip[0], clip[0]], len = st[0].length;
  for (let i = 0; i < n; i++) { const x = i / ctlSamples, j = Math.floor(x), f = x - j, g = (env[j] ?? 0) * (1 - f) + (env[j + 1] ?? env[j] ?? 0) * f; if (g < 1e-4) continue; const m = i % len; bus[0][i] += st[0][m] * g; bus[1][i] += st[1][m] * g; }
}
// music stem = playlist of variants joined by equal-power crossfades (same order as the live page: musicSequence)
function chainInto(bus, clips, env, ctlSamples, order, xf) {
  const n = bus[0].length; let start = 0;
  for (let k = 0; k < order.length && start < n; k++) {
    const c = clips[order[k]], len = c[0].length, f = Math.min(xf, Math.floor(len / 4));
    for (let i = 0; i < len && start + i < n; i++) {
      const o = start + i, x = o / ctlSamples, j = Math.floor(x), fr = x - j, g = (env[j] ?? 0) * (1 - fr) + (env[j + 1] ?? env[j] ?? 0) * fr; if (g < 1e-4) continue;
      let cg = 1; if (k > 0 && i < f) cg = Math.sin((i / f) * Math.PI / 2); else if (i >= len - f) cg = Math.cos(((i - (len - f)) / f) * Math.PI / 2);
      bus[0][o] += c[0][i] * g * cg; bus[1][o] += c[1][i] * g * cg;
    }
    start += len - f;
  }
}
const smoothstepCurve = (arr, ctlSec, up, down) => { let v = arr[0]; return arr.map((t) => { const k = 1 - Math.exp(-ctlSec / (t > v ? up : down)); v += (t - v) * k; return v; }); };

// opts: { triggers, samples, init, ev, tl, durationS, casters: [{start,end}], voice: optional [Float32 L,R] }
export function mixCut({ triggers, samples, init, ev, tl, durationS, casters = [], voice = null, voiceOverBedLu = VOICE_OVER_BED_LU, listenerRef = 1.6, manifestObj = manifest() }) {
  const N = Math.round(durationS * SR), mk = () => [new Float32Array(N), new Float32Array(N)];
  const bus = { sfx: mk(), alerts: mk(), ambient: mk(), music: mk(), big: mk() }, man = manifestObj.events, book = new VoiceBook({ maxVoices: 24, groupMax: 6 });
  const stats = { placed: 0, dropped: { gate: 0, cooldown: 0, group: 0, voices: 0, full: 0, quiet: 0, late: 0, fire: 0 }, byId: {}, byFile: {}, plays: [], fireOffered: 0 }; // (byFile and plays: what was really placed, for the sound diagnosis)
  const focusAt = (() => { const fx = ev.series.focus_x, fy = ev.series.focus_y; let last = [init.size / 2, init.size / 2]; const arr = fx.map((x, i) => { if (x !== null && fy[i] !== null) last = [x, fy[i]]; return last; }); return (tick) => arr[clamp(Math.floor(tick / 10), 0, arr.length - 1)] || last; })();
  // hoof beats: per tick only the few nearest (and quieter the more riders there are), like the live page (limitHoofs); the rest of the triggers is untouched
  const sIdx = (tick) => { let best = 0; for (let i = 0; i < samples.length; i++) { if (samples[i].t <= tick) best = i; else break; } return samples[best]; };
  // thunder: the flashes of the picture run on the output clock (render/lightning.mjs), each thunder follows its flash like on the live page. A desert storm is sand, without lightning
  const thunder = init.mapType === 'desert' ? [] : strikesOver(durationS, init.seed | 0, (out) => sIdx(tl.tickAt(Math.min(out, tl.duration_s)))?.wx === 4).map((k) => { const out = k.t + thunderDelay(k.n); return { ...thunderCue(k.close, k.n), out, t: tl.tickAt(Math.min(out, tl.duration_s)) }; });
  if (thunder.length) triggers = [...triggers, ...thunder].sort((a, b) => a.t - b.t);
  const hoofK = new Map(), perTick = new Map();
  for (const tr of triggers) if (tr.hoof) (perTick.get(tr.t) || perTick.set(tr.t, []).get(tr.t)).push(tr);
  for (const [t, list] of perTick) { const foc = focusAt(t); for (const h of limitHoofs(list, man, { x: foc[0], y: foc[1], ref: listenerRef })) hoofK.set(h.tr, h.k); }
  // zoom proxy for the density of fire: the broadcast mix has no camera distance, so the number of fighters in the picture stands for it (more fighters = farther camera = single rifles are lost in the din)
  const zoomMemo = new Map(), zoomAt = (tick) => { const k = Math.floor(tick / 5); let z = zoomMemo.get(k); if (z === undefined) { z = clamp(Math.sqrt(Math.max(1, sIdx(tick)?.fighting || 0) / 10), 1, 1.8); zoomMemo.set(k, z); } return z; };
  const picker = new VariantPicker(), fire = new FireControl(), fireTimes = [];
  // one-shots, in trigger order (already ordered by tick)
  for (const tr0 of triggers) {
    const tr = !man[tr0.id] && tr0.alt && man[tr0.alt] ? { ...tr0, id: tr0.alt } : tr0; // a theme clip that is not in the manifest falls back to its classic clip (as on the live page); a trigger with a known id is used as it is
    const e = man[tr.id]; if (!e || e.loop) continue;
    if (tr.hoof && !hoofK.has(tr)) { stats.dropped.quiet++; continue; }
    // a hoof beat falls inside its tick (tr.at, in ticks)
    const out = tr.out ?? tl.outAt(tr.at ?? tr.t);
    if (out < 0 || out >= durationS) { stats.dropped.late++; continue; }
    const speed = tl.speedAtTick(tr.t);
    if (e.priority < minPriorityForSpeed(speed) && !tr.big) { stats.dropped.gate++; continue; }
    const foc = focusAt(tr.t), sh = shape(tr, e, { x: foc[0], y: foc[1], ref: listenerRef }, 1, 0);
    if (!sh || sh.gain < 0.015) { stats.dropped.quiet++; continue; }
    const fc = fireClass(tr.id) || fireClass(e.theme); // shots and hits: offered to the density control (a few single clips, the rest is the carpet below)
    if (fc) { fireTimes.push(out); if (!fire.admit(fc, out, zoomAt(tr.t), (hash32(tr.t, tr.ent | 0, 77) % 1000) / 1000)) { stats.dropped.fire++; continue; } }
    const slow = speed < 0.99 ? clamp(0.5 + 0.5 * speed, 0.6, 1) : 1, v = picker.pick(e, tr.id, [tr.t, tr.ent, tr.id.length, tr.id.charCodeAt(0) * 31 + tr.id.charCodeAt(tr.id.length - 1)]);
    const clip = loadClip(e.files[v.index], false)[0], rate = v.rate * slow;
    const gain = sh.gain * dbg(e.gain_db) * (1 / Math.sqrt(1 + book.crowd(out) / 8)) * (slow < 1 ? 1.15 : 1) * (hoofK.get(tr) ?? 1) * v.k;
    const adm = book.admit(e, tr.id, e.priority, gain, out);
    if (!adm.ok) { stats.dropped[adm.why === 'cooldown' ? 'cooldown' : adm.why === 'group' ? 'group' : adm.why === 'voices' ? 'voices' : 'full']++; continue; }
    if (adm.steal) book.drop(adm.steal);
    picker.commit(tr.id, v.index);
    book.commit(e, tr.id, e.priority, gain, out, out + v.delay + clip.length / SR / rate, null);
    putMono(bus[e.priority >= BIG_PRIORITY && e.bus !== 'music' && e.bus !== 'ambient' ? 'big' : e.bus], clip, Math.round((out + v.delay) * SR), gain, shapePan(sh.pan), rate, sh.lp * (slow < 1 ? 0.7 : 1));
    stats.placed++; stats.byId[tr.id] = (stats.byId[tr.id] || 0) + 1; const pf = e.files[v.index]; stats.byFile[pf] = (stats.byFile[pf] || 0) + 1; stats.plays.push([+(out + v.delay).toFixed(3), tr.id, v.index, +rate.toFixed(3)]);
  }
  // ambience + music beds: control points every 0.25 s of output time
  const CTL = 0.25, ctlSamples = Math.round(CTL * SR), M = Math.ceil(durationS / CTL) + 2;
  const env = {}; const tension = new Tension(); const tv = [];
  fireTimes.sort((a, b) => a - b); stats.fireOffered = fireTimes.length;
  const lowerBound = (x) => { let lo = 0, hi = fireTimes.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (fireTimes[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  const fireRateAt = (out) => (lowerBound(out + 1) - lowerBound(out - 1)) / 2; // offered shots + hits per second around this moment
  const cid = carpetId(man);
  const tierAt = (tick) => { let t = 1; for (const x of ev.events) if (x.type === 'tier_up' && x.t <= tick) t = Math.max(t, x.tier); return t; };
  for (let m = 0; m < M; m++) {
    const out = m * CTL, tick = tl.tickAt(Math.min(out, tl.duration_s)), sp = tl.speedAtOut(out), sm = sIdx(tick) || { fighting: 0, buildings: 0, fp: null };
    const deaths = triggers.filter((t) => isDeathCue(t) && t.t <= tick && t.t > tick - 80).length;
    const near = sm.fighting; const tt = tension.update(near, deaths, CTL * Math.min(1, 1 / Math.max(0.25, sp > 1 ? sp / 3 : 1) * 1)); tv.push(tt);
    const foc = focusAt(tick), ff = sp >= 8 ? 0.6 : 1;
    const amb = ambientWeights(init, foc[0], foc[1], { tension: tt, buildingsNear: Math.min(12, (sm.buildings || 0) / 2), weather: sm.wx || 0 }), mus = musicWeights(tt, tierAt(tick));
    const cw = carpetWeight(fireRateAt(out)) * (CARPET_GAIN[cid] ?? 1); if (cw > 0.001) amb[cid] = Math.max(amb[cid] || 0, cw); // the firefight carpet takes over where single clicks are thinned
    for (const [id, w] of [...Object.entries(amb), ...Object.entries(mus)]) (env[id] ||= new Array(M).fill(0))[m] = w * ff * dbg(man[id]?.gain_db || 0);
  }
  for (const id of Object.keys(env)) { const e = man[id]; if (!e || Math.max(...env[id]) < 0.02) continue; env[id] = smoothstepCurve(env[id], CTL, 1.2, 2.5); if (e.bus === 'music' || e.files.length > 1) chainInto(bus[e.bus], e.files.map((f) => loadClip(f, true)), env[id], ctlSamples, musicSequence(id, e.files.length, 40), MUSIC_XF * SR); else loopInto(bus[e.bus], loadClip(e.files[0], true), env[id], ctlSamples); }
  // loop emitters are left to the live page (position dependent); the broadcast keeps its beds and one-shots only
  // ducking under the casters
  const duck = {};
  for (const b of Object.keys(bus)) {
    const tgt = duckEnvelope(N, casters, dbg(DUCK_DB[b]));
    duck[b] = tgt;
  }
  const L = new Float32Array(N), R = new Float32Array(N);
  for (const b of Object.keys(bus)) { const g = dbg(BUS_DB[b]), d = duck[b]; for (let i = 0; i < N; i++) { L[i] += bus[b][0][i] * g * d[i]; R[i] += bus[b][1][i] * g * d[i]; } }
  // the voice track (tools/caster-voice.mjs) goes on top: level = the bed during the lines + voiceOverBedLu
  if (voice) {
    const lines = casters.map((c) => [c.start, c.end]);
    const bed = loudnessOver(L, R, lines), vo = loudnessOver(voice.L, voice.R, lines);
    const gDb = Number.isFinite(bed) && Number.isFinite(vo) ? bed + voiceOverBedLu - vo : 0, g = dbg(gDb);
    for (let i = 0, n = Math.min(N, voice.L.length); i < n; i++) { L[i] += voice.L[i] * g; R[i] += voice.R[i] * g; }
    stats.voice = { gain_db: +gDb.toFixed(2), bed_lines_lufs: +bed.toFixed(2), voice_lines_lufs: +vo.toFixed(2), over_bed_lu: voiceOverBedLu };
  }
  // fade in / out
  const fi = Math.round(0.08 * SR), fo = Math.round(Math.min(1.2, durationS * 0.1) * SR);
  for (let i = 0; i < fi; i++) { L[i] *= i / fi; R[i] *= i / fi; }
  for (let i = 0; i < fo; i++) { const f = i / fo; L[N - 1 - i] *= f; R[N - 1 - i] *= f; }
  return { L, R, stats, tension: tv };
}
// integrated loudness of the parts of a stereo signal inside the intervals [[from_s, to_s]] (joined)
export function loudnessOver(L, R, intervals) {
  const parts = intervals.map(([a, b]) => [Math.max(0, Math.round(a * SR)), Math.min(L.length, Math.round(b * SR))]).filter(([a, b]) => b > a);
  const n = parts.reduce((t, [a, b]) => t + b - a, 0); if (n < SR * 0.5) return NaN;
  const l = new Float32Array(n), r = new Float32Array(n); let o = 0;
  for (const [a, b] of parts) { l.set(L.subarray(a, b), o); r.set(R.subarray(a, b), o); o += b - a; }
  return integratedLufs(l, r);
}
export function loadStereoWav(file) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('cannot decode ' + file);
  const f = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength)), n = f.length / 2, l = new Float32Array(n), rr = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = f[2 * i]; rr[i] = f[2 * i + 1]; }
  return { L: l, R: rr };
}
const shapePan = (p) => p * 0.6;

// ---------------------------------------------------------------- 4. loudness (ITU-R BS.1770-4 / EBU R128) and limiter
function biquad(x, b, a) { const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } return y; }
export function integratedLufs(L, R) {
  const sh = [[1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]], rl = [[1, -2, 1], [1, -1.99004745483398, 0.99007225036621]]; // 48 kHz coefficients
  const k = (x) => biquad(biquad(x, sh[0], sh[1]), rl[0], rl[1]);
  const kl = k(L), kr = k(R), blk = Math.round(0.4 * SR), hop = Math.round(0.1 * SR), z = [];
  for (let s = 0; s + blk <= kl.length; s += hop) { let a = 0, b = 0; for (let i = s; i < s + blk; i++) { a += kl[i] * kl[i]; b += kr[i] * kr[i]; } z.push((a + b) / blk); }
  const lufs = (m) => -0.691 + 10 * Math.log10(m + 1e-12), abs = z.filter((m) => lufs(m) > -70); if (!abs.length) return -70;
  const rel = lufs(abs.reduce((p, c) => p + c, 0) / abs.length) - 10, g = abs.filter((m) => lufs(m) > rel);
  return lufs(g.reduce((p, c) => p + c, 0) / Math.max(1, g.length));
}
export function limit(L, R, ceilDb = TP_CEILING_DB, lookMs = 5) {
  const N = L.length, la = Math.round((lookMs / 1000) * SR), ceil = dbg(ceilDb), g = new Float32Array(N);
  for (let i = 0; i < N; i++) { const p = Math.max(Math.abs(L[i]), Math.abs(R[i])); g[i] = p > ceil ? ceil / p : 1; }
  const m = new Float32Array(N); // m[j] = min(g[j-la .. j])  (sliding minimum, monotone deque)
  const dq = new Int32Array(N); let h = 0, t = 0;
  for (let j = 0; j < N; j++) { while (t > h && g[dq[t - 1]] >= g[j]) t--; dq[t++] = j; while (dq[h] < j - la) h++; m[j] = g[dq[h]]; }
  const out = [new Float32Array(N), new Float32Array(N)]; let acc = 0; const win = new Float64Array(la + 1);
  for (let j = 0; j < N + la; j++) { const v = j < N ? m[j] : 1; acc += v - (win[j % (la + 1)] ?? 0); win[j % (la + 1)] = v; const o = j - la; if (o >= 0 && o < N) { const gg = acc / (la + 1); out[0][o] = L[o] * Math.min(1, gg + 0); out[1][o] = R[o] * Math.min(1, gg + 0); } }
  return out;
}
// gentle knee (tanh) above 0.45 of the ceiling: tames the few big transients so the limiter hardly has to work and the loudness holds
export function softKnee(x, ceilDb = TP_CEILING_DB) { const c = dbg(ceilDb), t = c * 0.45, o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); o[i] = a <= t ? x[i] : Math.sign(x[i]) * (t + (c - t) * Math.tanh((a - t) / (c - t))); } return o; }
export function normalise(L, R, target = TARGET_LUFS) {
  const cur = integratedLufs(L, R); let gdb = target - cur, res = null;
  for (let k = 0; k < 5; k++) { // the limiter takes some loudness back: raise the gain until the limited result sits on the target
    const gain = dbg(gdb), gl = new Float32Array(L.length), gr = new Float32Array(R.length);
    for (let i = 0; i < L.length; i++) { gl[i] = L[i] * gain; gr[i] = R[i] * gain; }
    const [ol, or] = limit(softKnee(gl), softKnee(gr)), after = integratedLufs(ol, or);
    res = { L: ol, R: or, before_lufs: cur, gain_db: gdb, after_lufs: after };
    if (Math.abs(after - target) < 0.25) break;
    gdb += target - after;
  }
  return res;
}
export function wavFloatToBuffer(L, R) { const n = L.length, b = Buffer.alloc(44 + n * 4); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40); for (let i = 0; i < n; i++) { b.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), 44 + i * 4); b.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), 46 + i * 4); } return b; }
export const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);

// ffmpeg ebur128 measurement of a file (WAV or MP4): { I, LRA, TP }
export function measure(file) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const t = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const g = (re) => { const m = t.match(re); return m ? +m[1] : null; };
  return { I: g(/I:\s+(-?[\d.]+) LUFS/), LRA: g(/LRA:\s+(-?[\d.]+) LU/), TP: g(/Peak:\s+(-?[\d.]+) dBFS/) };
}

// true peak of what the viewer hears: the WAV encoded as the muxed AAC (192k) and measured again (AAC overshoots the WAV peak by up to 1.5 dB)
export function measureAac(wav) { const tmp = path.join(os.tmpdir(), 'rts-aac-check-' + process.pid + '.m4a'); const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', tmp]); if (r.status !== 0) throw new Error('aac check failed'); const m = measure(tmp); return m; }
// ---------------------------------------------------------------- 5. one call for render-broadcast and the CLI
export async function mixCutFromReplay({ rep, ev, plan, tl, track = null, voiceWav = null, outFile, limitS = Infinity, log = () => {}, dirOpts = {} }) { // dirOpts: options of the SoundDirector, e.g. { shooters } of a theme
  const durationS = Math.min(tl.duration_s, limitS);
  const col = await collectTriggers(rep, plan.window, { dirOpts });
  const casters = (track?.lines || []).map((l) => ({ start: l.start, end: l.end }));
  const pack = packOf(col.dir.sounds?.theme || col.dir.shooters?.theme); // the sound pack of the skin (render/assets/audio-dustmoon for Dustmoon, else the classic one)
  const man = manifest(pack); // theme: the shot and hit files of the shooters, the event table and the sounds of the types join the events, as on the live page (SoundDirector.soundEvents)
  const onDisk = (f) => { try { return fs.existsSync(clipPath(f)); } catch { return false; } }; // (a file: url with a host is no file here)
  const themed = pruneEvents(col.dir.soundEvents(man.events, { pack: pack !== CLASSIC_PACK }), onDisk); // a theme file that is not on disk is left out: its event keeps the classic clip (mixCut: a trigger without its event plays its `alt`)
  Object.assign(man.events, themed);
  const m = mixCut({ ...col, ev, tl, durationS, casters, voice: voiceWav ? loadStereoWav(voiceWav) : null, manifestObj: man });
  let n = normalise(m.L, m.R), wav = wavFloatToBuffer(n.L, n.R);
  fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, wav);
  let meas = measureAac(outFile);
  for (let k = 0; k < 4 && meas.TP !== null && meas.TP > -1.3; k++) { const lim = limit(n.L, n.R, TP_CEILING_DB - 0.7 * (k + 1)); n = { ...n, L: lim[0], R: lim[1], after_lufs: integratedLufs(lim[0], lim[1]) }; wav = wavFloatToBuffer(n.L, n.R); fs.writeFileSync(outFile, wav); meas = measureAac(outFile); }
  const info = { file: outFile, seconds: durationS, hash: sha(wav), lufs_js: +n.after_lufs.toFixed(2), ...meas, placed: m.stats.placed, dropped: m.stats.dropped, by_id: m.stats.byId, by_file: m.stats.byFile, triggers: col.triggers.length, gain_db: +n.gain_db.toFixed(2), casters: casters.length, voice: m.stats.voice || null, pack, fire_offered: m.stats.fireOffered, ...(col.dir.sounds || col.dir.shooters ? { theme_events: Object.keys(themed).length } : {}) };
  Object.defineProperty(info, 'plays', { value: m.stats.plays, enumerable: false }); // [out s, id, variant, rate] of every placed one-shot (not written into the JSON files)
  log(`audio ${path.basename(outFile)}: ${info.placed} one-shots of ${info.triggers} triggers, ${info.I} LUFS, TP ${info.TP} dBFS, hash ${info.hash}`);
  return info;
}
// mux the WAV into the finished MP4 (video stream copied, AAC 192k); the MP4 is replaced atomically
export function muxAudio(mp4, wav) {
  const tmp = mp4.replace(/\.mp4$/, '') + '.mux.mp4';
  const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', mp4, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', tmp], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('mux failed');
  fs.renameSync(tmp, mp4);
}

async function main() {
  const A = process.argv.slice(2), opt = (k) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : null; };
  const src = A.find((x, i) => !x.startsWith('--') && !(A[i - 1] || '').startsWith('--'));
  if (!src) { console.error('usage: node tools/audio-mix.mjs replays/<id> [--cut highlight|full] [--out dir] [--limit-s N] [--no-casters] [--target 60,90] [--plan plan.json] [--casters casters.json] [--voices casters-voice.json]'); process.exit(2); }
  const { loadReplay } = await import('./lib/replay.mjs'), { prepare } = await import('./render-broadcast.mjs'), { timelineOf } = await import('./plan.mjs'), { makeCasterTrack } = await import('./casters.mjs');
  const rep = loadReplay(src), { ev, plans } = prepare(rep, { target: opt('--target') || undefined });
  const cut = opt('--cut') === 'full' ? 'full' : 'highlight', plan = opt('--plan') ? JSON.parse(fs.readFileSync(opt('--plan'), 'utf8')) : plans[cut], tl = timelineOf(plan);
  const outDir = path.resolve(opt('--out') || path.join(rep.dir, 'broadcast'));
  let track = null;
  if (opt('--casters')) track = JSON.parse(fs.readFileSync(opt('--casters'), 'utf8'));
  else if (!A.includes('--no-casters')) track = (await makeCasterTrack({ ev, plan, cls: rep.start.class || '', seed: 0, rounds: 0 })).track;
  let voiceWav = null;
  if (opt('--voices')) { // real line times of the voice track drive the ducking
    const vf = path.resolve(opt('--voices')), v = JSON.parse(fs.readFileSync(vf, 'utf8'));
    track = (await import('./caster-voice.mjs')).applyVoices(track, v); voiceWav = path.join(path.dirname(vf), v.wav);
  }
  const info = await mixCutFromReplay({ rep, ev, plan, tl, track, voiceWav, outFile: path.join(outDir, `${rep.id}-${cut}-audio.wav`), limitS: opt('--limit-s') ? +opt('--limit-s') : Infinity, log: console.log });
  fs.writeFileSync(path.join(outDir, `${rep.id}-${cut}-audio.json`), JSON.stringify(info, null, 1));
  console.log(JSON.stringify({ ...info, by_id: undefined }));
  process.exit(0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
