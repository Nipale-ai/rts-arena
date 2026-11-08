// Second half of tools/caster-voice.mjs: chosen takes -> polish -> placement -> casters-voice.wav / .json / .srt.
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { integratedLufs, measure } from './audio-mix.mjs';
import { SR, convolve, VOICE_FX, DELIVERY_DB, pickBest, polishTake, placeTakes, cueTimes, toSrt, boothIR, wavF32, scriptHash, FIT_TOLERANCE, MAX_LATE_S, GAP, SAMPLING, MODEL_ID } from './caster-voice.mjs';

const sha = (s) => crypto.createHash("sha1").update(typeof s === "string" ? s : JSON.stringify(s)).digest('hex');
const POST_VERSION = 'post-v3-dry-gate';

const lufsOf = (x) => { if (x.length < SR * 0.45) { let e = 0; for (const v of x) e += v * v; return 10 * Math.log10(e / x.length + 1e-12) - 0.7 + 3; } return integratedLufs(x, x); };

function readF32(file) { const b = fs.readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
function writeF32(file, x) { fs.writeFileSync(file, Buffer.from(x.buffer, x.byteOffset, x.byteLength)); }

const RELIEF_FROM_S = 0.9; // A2: relief starts before the hard limit, so lines that quote the chat stay in step with their bubble
export async function assemble(r, { outDir, base, lufs = -20, room = 0, dropFailed = false, tailS = 1.0 }) {
  const { entries, st, voices, cacheDir, track, man, stats } = r;
  fs.mkdirSync(outDir, { recursive: true });
  const postDir = path.join(cacheDir, 'post'); fs.mkdirSync(postDir, { recursive: true });
  const lines = [], dropped = [];
  const polish = async (e, best) => {
    const pk = sha([best.key, POST_VERSION, lufs, e.delivery, JSON.stringify(VOICE_FX[e.voice]), JSON.stringify(DELIVERY_DB)]).slice(0, 20);
    const f32 = path.join(postDir, pk + '.f32'), info = path.join(postDir, pk + '.json');
    let pinfo;
    if (fs.existsSync(f32) && fs.existsSync(info)) pinfo = JSON.parse(fs.readFileSync(info, 'utf8'));
    else {
      const p = await polishTake(path.join(cacheDir, best.key + '.wav'), best.metrics, e.voice, e.delivery, { lufs, lufsFn: lufsOf });
      writeF32(f32, p.samples); pinfo = { offset_s: p.offset_s, lufs_before: p.lufs_before, gain_db: p.gain_db, peak_limited: p.peak_limited, dehaze: p.dehaze, denoise: p.denoise, dur: p.dur };
      fs.writeFileSync(info, JSON.stringify(pinfo));
    }
    return { pinfo, f32 };
  };
  // 08.11.: among the passing takes of a voice's consecutive lines pick the sequence with the smallest pitch jumps (limit 3 semitones, 5 when a line is excited), score only as a mild preference
  const smooth = new Map();
  if (process.env.RTS_SMOOTH !== '0') {
    const exc = (e) => ['hype', 'laugh', 'tense'].includes(e.delivery) || /!\s*$/.test(e.text || '');
    const stOf = (a, b) => Math.abs(12 * Math.log2(b / a));
    for (const voice of new Set(entries.map((e) => e.voice))) {
      const seq = entries.filter((e) => e.voice === voice).map((e) => {
        const all = st.get(e.id).takes.filter((t) => t.metrics && !t.metrics.error && t.metrics.f0);
        const ok = all.filter((t) => t.res.ok).sort((x, y) => y.res.score - x.res.score).slice(0, 10);
        return { e, cand: ok.length ? ok : [], top: ok.length ? ok[0].res.score : 0 };
      });
      let prev = null; // dp over lines that have passing takes with a pitch; others cut the chain
      const run = []; const chains = [];
      for (const q of seq) { if (q.cand.length) run.push(q); else if (run.length) { chains.push([...run]); run.length = 0; } }
      if (run.length) chains.push([...run]);
      for (const ch of chains) {
        let cost = ch[0].cand.map((t) => (ch[0].top - t.res.score) * 0.15), back = [];
        for (let i = 1; i < ch.length; i++) {
          const nc = [], bk = [];
          for (const t of ch[i].cand) {
            let bestC = Infinity, bi = 0;
            ch[i - 1].cand.forEach((u, k) => { const j = stOf(u.metrics.f0, t.metrics.f0), lim = exc(ch[i - 1].e) || exc(ch[i].e) ? 8 : 3; const c = cost[k] + Math.max(0, j - lim) * 10 + 0.5 * j; if (c < bestC) { bestC = c; bi = k; } });
            nc.push(bestC + (ch[i].top - t.res.score) * 0.15); bk.push(bi);
          }
          cost = nc; back.push(bk);
        }
        let k = cost.indexOf(Math.min(...cost));
        for (let i = ch.length - 1; i >= 0; i--) { smooth.set(ch[i].e.id, ch[i].cand[k]); if (i > 0) k = back[i - 1][k]; }
      }
    }
  }
  for (const e of entries) {
    const s = st.get(e.id), best = smooth.get(e.id) || pickBest(s.takes);
    const usable = best && best.metrics && !best.metrics.error;
    if (!usable || (dropFailed && !best.res.ok)) { dropped.push({ id: e.id, why: !usable ? 'no usable take' : 'failed the checks: ' + best.res.fails.join('; ') }); continue; }
    const { pinfo, f32 } = await polish(e, best);
    lines.push({ e, s, best, pinfo, f32, dur: pinfo.dur });
  }
  // A2: a passing but long take can be swapped for a shorter passing one (score within 40 points) when a main line would start more than MAX_LATE_S late
  const relieve = async () => {
    for (let round = 0; round < 60; round++) {
      const pr = placeTakes(lines.map((l) => ({ id: l.e.id, interject: !!l.e.interject, speaker: l.e.speaker, beat: l.e.beat, planned: l.e.start_s, latest_end: l.e.latest_end_s, dur: l.dur })), { duration: track?.duration_s ?? Infinity });
      const late = pr.placed.map((p) => ({ id: p.id, seconds: p.nudge_s })).filter((p) => !lines.find((l) => l.e.id === p.id)?.e.interject && p.seconds > RELIEF_FROM_S).sort((a, b) => b.seconds - a.seconds)[0];
      if (!late) return;
      const mains = lines.filter((l) => !l.e.interject).sort((a, b) => a.e.start_s - b.e.start_s), at = mains.findIndex((l) => l.e.id === late.id);
      let pick = null;
      for (const l of mains.slice(Math.max(0, at - 14), at + 1)) {
        for (const t of l.s.takes) {
          if (!(t.res?.ok || (process.env.RTS_CLEAN === '1' && !l.best.res?.ok && t.res)) || !t.metrics || t.res.score < l.best.res.score - 40 || t.key === l.best.key) continue; // RTS_CLEAN: a line without a passing take may also swap to a shorter take that fails as well (07.11.)
          const gain = (l.best.res.eff ?? 0) - (t.res.eff ?? 0);
          if (gain > 0.05 && (!pick || gain > pick.gain)) pick = { l, t, gain };
        }
      }
      if (!pick) return;
      const { pinfo, f32 } = await polish(pick.l.e, pick.t);
      Object.assign(pick.l, { best: pick.t, pinfo, f32, dur: pinfo.dur });
    }
  };
  await relieve();
  const duration = track?.duration_s ?? Math.max(...entries.map((e) => e.latest_end_s));
  const { placed, changes } = placeTakes(lines.map((l) => ({ id: l.e.id, interject: !!l.e.interject, speaker: l.e.speaker, beat: l.e.beat, planned: l.e.start_s, latest_end: l.e.latest_end_s, dur: l.dur })), { duration });
  const late = changes.filter((c) => c.kind === 'late');
  if (late.length) throw new Error(`voice track: ${late.map((c) => `${c.id} starts ${c.seconds} s late`).join(', ')} (limit ${MAX_LATE_S} s). A take is never sped up: shorten these lines or the lines just before them.`);
  const pl = new Map(placed.map((p) => [p.id, p]));
  const total = Math.max(duration, ...placed.map((p) => p.end)) + tailS;
  const N = Math.ceil(total * SR), L = new Float32Array(N), R = new Float32Array(N);
  const outLines = [];
  for (const l of lines) {
    const p = pl.get(l.e.id);
    const x = readF32(l.f32); // never time-stretched (see FIT_TOLERANCE in caster-voice.mjs)
    const pan = (VOICE_FX[l.e.voice]?.pan ?? 0), ang = (pan + 1) * Math.PI / 4, gl = Math.cos(ang) * Math.SQRT2, gr = Math.sin(ang) * Math.SQRT2;
    const s0 = Math.round(p.start * SR);
    for (let i = 0; i < x.length && s0 + i < N; i++) { L[s0 + i] += x[i] * gl; R[s0 + i] += x[i] * gr; }
    const realEnd = +(p.start + x.length / SR).toFixed(3);
    const track0 = track?.lines.find((t) => t.id === l.e.id);
    const cues = track0 ? cueTimes(track0.cues, l.best.metrics.words, { offset: l.pinfo.offset_s, stretch: p.stretch, start: p.start, end: realEnd }) : [];
    outLines.push({
      id: l.e.id, speaker: l.e.speaker, voice: l.e.voice, delivery: l.e.delivery, text: l.e.text, start: p.start, end: realEnd, planned_start: p.planned, window_end: p.window_end,
      nudge_s: p.nudge_s, stretch: p.stretch, interject: !!l.e.interject, gain_db: l.pinfo.gain_db, lufs_before_gain: l.pinfo.lufs_before == null ? null : +l.pinfo.lufs_before.toFixed(2), peak_limited: l.pinfo.peak_limited, dehaze: !!l.pinfo.dehaze, denoise: !!l.pinfo.denoise,
      take: { key: l.best.key, index: l.best.index, round: l.best.round, score: l.best.res.score, passed: l.best.res.ok, fails: l.best.res.fails, soft: l.best.res.soft, wer: l.best.metrics.wer, wer_soft: l.best.metrics.wer_soft, noise: { floor_db: l.best.metrics.n_floor_db, pause_db: l.best.metrics.n_pause_db, pause_hf_db: l.best.metrics.n_pause_hf_db, hum_db: l.best.metrics.n_hum_db, floor_speech_db: l.best.metrics.n_floor_speech_db, haze_db: l.best.metrics.haze_db }, heard: l.best.metrics.heard, raw_dur: l.best.metrics.dur, clicks: l.best.metrics.clicks },
      takes: l.s.takes.map((t) => ({ key: t.key, index: t.index, round: t.round, ok: t.res.ok, score: t.res.score, dur: t.metrics?.dur ?? null, wer_soft: t.metrics?.wer_soft ?? null, fails: t.res.fails, soft: t.res.soft })),
      cues: cues.map(({ s0, s1, text }) => ({ s0, s1, text })),
    });
  }
  // dry studio voice by default; --room dB adds a small synthetic booth (convolution, high-passed and darkened) for both voices
  if (room < 0) {
    const ir = boothIR(), wet = [convolve(L, ir[0]), convolve(R, ir[1])];
    const hpLp = (x) => { const a = Math.exp(-2 * Math.PI * 220 / SR), c = Math.exp(-2 * Math.PI * 7500 / SR); let lp = 0, lo = 0; const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { lp = (1 - a) * x[i] + a * lp; const hp = x[i] - lp; lo = (1 - c) * hp + c * lo; y[i] = lo; } return y; };
    const wg = Math.pow(10, room / 20), W = [hpLp(wet[0]), hpLp(wet[1])];
    for (let i = 0; i < N; i++) { L[i] += W[0][i] * wg; R[i] += W[1][i] * wg; }
  }
  let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak > 0.89) { const g = 0.89 / peak; for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; } }
  const wavOut = path.join(outDir, `${base}-casters-voice.wav`);
  const raw = wavF32([L, R]);
  const ff = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'pcm_s24le', wavOut], { input: raw, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (ff.status !== 0) throw new Error('ffmpeg failed: ' + String(ff.stderr).slice(0, 400));
  const wavDur = (fs.statSync(wavOut).size - 44) / (SR * 2 * 3);
  const meas = measure(wavOut);
  const per = {};
  for (const sp of ['caster_a', 'caster_b']) {
    const ls = outLines.filter((l) => l.voice === sp); if (!ls.length) continue;
    const buf = ls.flatMap((l) => { const a = Math.round(l.start * SR), b = Math.round(l.end * SR); return [Array.from(L.subarray(a, b))]; });
    const cat = new Float32Array(buf.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of buf) { cat.set(a, o); o += a.length; }
    per[sp] = { lines: ls.length, lufs: +integratedLufs(cat, cat).toFixed(2) };
  }
  const srtCues = outLines.flatMap((l) => l.cues.map((c) => ({ ...c, name: l.speaker === 'pbp' ? 'Dex' : 'Juno' }))).sort((a, b) => a.s0 - b.s0);
  const srtFile = path.join(outDir, `${base}-casters-voice.srt`);
  if (track) fs.writeFileSync(srtFile, toSrt(track.cues ? srtCues.map((c) => ({ ...c, name: track.casters[outLines.find((l) => l.id === c.line)?.speaker ?? '']?.short ?? c.name })) : srtCues));
  const failedLines = outLines.filter((l) => !l.take.passed).map((l) => ({ id: l.id, why: l.take.fails }));
  const json = {
    version: 1, tool: 'tools/caster-voice.mjs', created: new Date().toISOString(), manifest: { file: path.basename(r.manifestFile || ""), script_hash: scriptHash(entries) },
    wav: path.basename(wavOut), sr: SR, channels: 2, duration_s: +wavDur.toFixed(3), model: MODEL_ID, sampling: SAMPLING, post: { version: POST_VERSION, target_lufs_per_line: lufs, delivery_db: DELIVERY_DB, booth: room < 0 ? `synthetic small room, wet ${room} dB, same for both voices` : 'none (dry studio voice)', time_stretch: 'never', fit_tolerance: FIT_TOLERANCE, max_late_s: MAX_LATE_S, gap_s: GAP },
    refs: Object.fromEntries(Object.values(voices).map((v) => { const f = path.join(cacheDir, `refs-${v.server}.json`); return [v.name, { server_name: v.server, cleaned: v.cleaned, ...(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}) }]; })),
    lines: outLines, dropped, changes, failed: failedLines, loudness: { track: meas, per_caster: per }, rounds: stats.rounds, gpu_minutes: stats.gpu_minutes,
  };
  const jsonFile = path.join(outDir, `${base}-casters-voice.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(json, null, 1));
  const summary = {
    lines: entries.length, placed: outLines.length, dropped: dropped.length, failed_lines: failedLines.length, takes_total: [...st.values()].reduce((n, s) => n + s.takes.length, 0),
    rounds: stats.rounds, wer_mean_soft: +(outLines.reduce((a, l) => a + l.take.wer_soft, 0) / Math.max(1, outLines.length)).toFixed(3), wer_max_soft: Math.max(...outLines.map((l) => l.take.wer_soft)),
    changes: changes.length, loudness: json.loudness, duration_s: json.duration_s, gpu_minutes: stats.gpu_minutes,
  };
  return { summary, files: [wavOut, jsonFile, ...(track ? [srtFile] : [])], json };
}
