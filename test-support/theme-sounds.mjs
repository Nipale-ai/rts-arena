// Mini dummies for the sound checker tests (test/check-theme-sounds*.test.mjs, test/listen-sheet.test.mjs): short synthetic sounds, written as Ogg/Opus
// the way tools/audio/make-sounds.mjs writes them, and a theme folder around them. Nothing here touches render/ or the game; every folder is new
// (os.tmpdir()), nothing is deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SR, rng, fade } from '../tools/audio/dsp.mjs';
import { wavBytes, leveled } from '../tools/audio/make-sounds.mjs';

export const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `rts-${name}-`));
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- signals (mono Float32Array at 48 kHz)
// a falling zap with a noise burst, like a short energy shot; `seed` and `f0` make different sounds
export function zap(seed, { dur = 0.42, f0 = 2400, f1 = 300, decay = 8, noise = 0.5 } = {}) {
  const r = rng(seed), n = Math.round(dur * SR), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = f1 + (f0 - f1) * Math.exp(-t * 14);
    ph += (2 * Math.PI * f) / SR;
    x[i] = Math.sin(ph) * Math.exp(-t * decay) + (r.next() * 2 - 1) * noise * Math.exp(-t * 20);
  }
  return fade(x, 1.5, 12);
}
// a short crackle with a dull thump, like a hit
export function crackle(seed, { dur = 0.22 } = {}) {
  const r = rng(seed), n = Math.round(dur * SR), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; x[i] = (r.next() * 2 - 1) * Math.exp(-t * 30) * 0.6 + Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t * 22); }
  return fade(x, 1.5, 12);
}
// the level the sound set uses: loudest 400 ms at `targetDb` dBFS RMS, peak at most -1.5 dBFS (make-sounds.mjs leveled)
export const levelTo = (x, targetDb = -19) => leveled([x], targetDb, -1.5, false).chs[0];
export const silence = (sec) => new Float32Array(Math.round(sec * SR));
export const concat = (...parts) => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
export const scale = (x, g) => Float32Array.from(x, (v) => v * g);
export const clip = (x, g) => Float32Array.from(x, (v) => Math.max(-1, Math.min(1, v * g)));
// a tone that stops at full level: cut off mid-sound
export const cutTone = (sec = 0.3) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR));

// ---- files
// chs: [Float32Array] (mono) or [L, R]; written like make-sounds.mjs: libopus, 48 kHz, no metadata. The WAV goes to ffmpeg through a pipe: no intermediate file.
export function writeOgg(file, chs, { bitrate = '40k' } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on', '-application', 'audio', '-ar', '48000', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', file], { input: wavBytes(chs), stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('ffmpeg failed for ' + file);
  return file;
}

// cases: [{ file: 'audio/archer_shot.ogg', slot: ['units', 'archer', 'shot'] | null, chs, status: 'final' | 'placeholder', prompt, bytes (write these bytes instead), tamper: true (wrong sha256), unlisted: true (no assets entry), noFile: true }]
// -> the folder `dir` with theme.json and the files
export function makeMiniTheme(dir, cases, { id = 'minitest', version = 1 } = {}) {
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  const assets = {}, slots = { units: {}, buildings: {} };
  for (const c of cases) {
    const abs = path.join(dir, c.file);
    if (c.bytes) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c.bytes); }
    else if (c.chs && !c.noFile) writeOgg(abs, c.chs, c);
    const final = c.status !== 'placeholder', has = fs.existsSync(abs);
    if (!c.unlisted) assets[c.file] = { kind: 'sound', status: c.status || 'final', generator: final ? 'test synth' : null, prompt: final ? (c.prompt ?? 'a synthetic test sound') : null, seed: final ? 1 : null, license: final ? 'test' : null, credits: final ? 'test' : null, sha256: final && has ? (c.tamper ? '0'.repeat(64) : sha256(fs.readFileSync(abs))) : null };
    if (c.slot) { const [kind, type, ev] = c.slot; ((slots[kind][type] ||= {}).sound ||= {})[ev] = c.file; }
  }
  const theme = { schema: 'rts-theme-1', id, version, name: 'Mini test theme', description: 'Dummies for the sound checker tests.', fallback: 'classic', status: 'slice', legal: { name_check: { status: 'unverified' } }, assets, units: slots.units, buildings: slots.buildings };
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(theme, null, 1));
  return dir;
}
