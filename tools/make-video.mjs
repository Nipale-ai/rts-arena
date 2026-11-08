#!/usr/bin/env node
// "Make video": the whole post-match broadcast in one command (the arena's job runner starts this as a child process).
//   node tools/make-video.mjs replays/<id> --out dir [--format yt|x|both] [--length highlight|story5|full]
//        [--llm http://host/v1,model]   (key: env OPENAI_API_KEY; no --llm = built-in template script)
//        [--voices on|off] [--tts-url http://host:8000] [--voice caster_a=<dir>] [--limit-s N]
// Steps: check the machine -> script (LLM, grounded by the checker, template fallback) -> voices (HTTP TTS, captions-only fallback)
//        -> render-broadcast.mjs (camera, sound, captions, voices) -> outputs.
// Progress goes to stdout as lines "@@stage|percent|message"; the end is "@@result {json}" or "@@error message" (exit code 1).
// Nothing here ever prints the LLM key.
import '../server/local-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LENGTHS = { highlight: { cut: 'highlight', target: null, label: 'Highlight' }, story5: { cut: 'highlight', target: '270,330', label: 'Story (about 5 min)' }, full: { cut: 'full', target: null, label: 'Full match' } };
export const FORMATS = { yt: { presets: ['yt'], label: 'YouTube 16:9 (1920x1080)' }, x: { presets: ['x'], label: 'X 4:5 (1080x1350)' }, both: { presets: ['x', 'yt'], label: 'both' } };
const PRESET_LABEL = { yt: 'YouTube 16:9 (1920x1080)', x: 'X 4:5 (1080x1350)' };

const emit = (stage, pct, msg = '') => console.log(`@@${stage}|${Math.round(pct)}|${String(msg).replace(/[\r\n|]+/g, ' ').slice(0, 300)}`);
class Fail extends Error {}

function parse(argv) {
  const A = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { A._.push(a); continue; }
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) A[a.slice(2)] = true; else { if (a === '--voice') (A.voice ||= []).push(n); else A[a.slice(2)] = n; i++; }
  }
  return A;
}

// what the renderer needs on this machine; the arena's /check page (server/doctor.mjs) asks the same functions
export const hasFfmpeg = () => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
// the same question without blocking the caller (the arena's /check answer must not stall live matches); false after `timeoutMs`
export const hasFfmpegAsync = ({ env = process.env, timeoutMs = 3000 } = {}) => new Promise((resolve) => {
  try { execFile('ffmpeg', ['-version'], { env, timeout: timeoutMs, windowsHide: true }, (err) => resolve(!err)); } catch { resolve(false); }
});

// The one place that knows where Chrome / Chromium is: the video renderer, the screenshot tools and /check all call chromePath().
// Order: env RTS_CHROME (taken as it is, also when nothing is there: a wrong value must show up as an error, not be skipped);
// on macOS the app folders (Google Chrome first, so a Mac with Chrome always gets the same path as before); a command on PATH
// (google-chrome, google-chrome-stable, chromium, chromium-browser); on Windows the usual install folders (best effort, not tested here).
// Nothing found: the usual place of the platform, so a message can name something real. hasChrome() tells whether it is there.
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const MAC_APPS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
const CHROME_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
export function chromePath({ env = process.env, platform = process.platform, exists = isFile, home = os.homedir() } = {}) {
  if (env.RTS_CHROME) return env.RTS_CHROME;
  const win = platform === 'win32';
  const winBases = [env.PROGRAMFILES || 'C:\\Program Files', env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
  const winApps = winBases.map((b) => `${b}\\Google\\Chrome\\Application\\chrome.exe`);
  const apps = platform === 'darwin' ? [...MAC_APPS, path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')] : [];
  for (const f of apps) if (exists(f)) return f;
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  for (const name of CHROME_COMMANDS) for (const dir of dirs) for (const ext of win ? ['.exe', ''] : ['']) { const f = path.join(dir, name + ext); if (exists(f)) return f; }
  if (win) for (const f of winApps) if (exists(f)) return f;
  return platform === 'darwin' ? MAC_APPS[0] : win ? winApps[0] : 'google-chrome';
}
export const hasChrome = (opts) => isFile(chromePath(opts));
export const puppeteerDir = () => process.env.PUPPETEER_CORE || path.join(ROOT, 'node_modules');
export const hasPuppeteer = () => fs.existsSync(path.join(puppeteerDir(), 'puppeteer-core'));
// GPU flag of the headless browser: ANGLE's Metal backend exists on macOS only, elsewhere Chrome picks its own. Spread it into `args`.
export const angleArgs = (platform = process.platform) => (platform === 'darwin' ? ['--use-angle=metal'] : []);

function preflight(replayDir) {
  if (!fs.existsSync(path.join(replayDir, 'log.jsonl'))) throw new Fail(`Replay not found: ${path.basename(replayDir)} has no log.jsonl.`);
  if (!hasFfmpeg()) throw new Fail('ffmpeg was not found. Install it (brew install ffmpeg) and try again.');
  if (!hasChrome()) throw new Fail(process.env.RTS_CHROME ? `RTS_CHROME points to "${process.env.RTS_CHROME}", but there is no file there.`
    : 'Chrome or Chromium was not found. Install Google Chrome or Chromium (on Linux the command google-chrome or chromium must work in a terminal), or set RTS_CHROME to the browser executable.');
  if (!hasPuppeteer()) throw new Fail(`puppeteer-core was not found in ${puppeteerDir()}. Set PUPPETEER_CORE to the node_modules folder that contains puppeteer-core (where \`npm install puppeteer-core\` puts it).`);
}

async function main() {
  const A = parse(process.argv.slice(2));
  const src = A._[0];
  if (!src || !A.out) { console.error('usage: node tools/make-video.mjs replays/<id> --out dir [--format yt|x|both] [--length highlight|story5|full] [--llm base,model] [--voices on|off] [--tts-url url]'); process.exit(2); }
  try { os.setPriority(0, 10); } catch { /* nice */ }
  const replayDir = path.resolve(src), out = path.resolve(A.out);
  const lengthArg = LENGTHS[A.length || 'highlight'], format = FORMATS[A.format || 'yt'];
  if (!lengthArg) throw new Fail(`Unknown length "${A.length}" (highlight, story5, full).`);
  if (!format) throw new Fail(`Unknown format "${A.format}" (yt, x, both).`);
  const warnings = [];
  const key = process.env.OPENAI_API_KEY || '';
  fs.mkdirSync(out, { recursive: true });

  emit('check', 1, 'Checking the replay and the machine');
  preflight(replayDir);
  const { loadReplay } = await import('./lib/replay.mjs');
  let rep;
  try { rep = loadReplay(replayDir); } catch (e) { throw new Fail(`This replay cannot be loaded: ${e.message}`); }
  if (rep.n !== 2) throw new Fail('Broadcast videos are made for 2-player matches only (this one has ' + rep.n + ' players).');
  const cls = rep.start.class || '';

  // ---- story cut (length story5): tools/render-story.mjs makes its own script (story beats) and renders in parallel chunks
  let lengthKey = A.length || 'highlight';
  const workers = Math.max(1, Math.min(32, +(A.workers || 8) || 8));
  if (lengthKey === 'story5') {
    const done = await storyCut({ A, rep, replayDir, out, format, key, workers, warnings });
    if (done) { emit('done', 100, 'Done'); console.log('@@result ' + JSON.stringify(done)); process.exit(0); }
    lengthKey = 'highlight'; // the story script failed: a highlight cut still gives a video
  }
  const length = LENGTHS[lengthKey];

  // ---- script
  emit('script', 4, 'Preparing the cut');
  const { prepare } = await import('./render-broadcast.mjs');
  const pa = length.target ? { target: length.target } : {};
  const { ev, plans } = prepare(rep, pa);
  const plan = plans[length.cut];
  const { makeCasterTrack, writeTrack, parseLlmArg } = await import('./casters.mjs');
  const llm = typeof A.llm === 'string' && A.llm ? parseLlmArg(A.llm) : null;
  if (llm) llm.key = key;
  emit('script', 7, llm ? `Writing the commentary with ${llm.model}` : 'Writing the commentary (built-in template)');
  // The template writer can trip over its own fact checker on some matches (a variant that names a speed or a number the facts do not
  // hold). Another variant seed fixes that; if every seed fails, the video is made without commentary and says so.
  let r = null, files = null, seed = 0, scriptError = null;
  for (; seed < 12 && !r; seed++) {
    try { r = await makeCasterTrack({ ev, plan, cls, llm, cacheDir: path.join(out, 'llm-cache'), seed, rounds: 2, log: (m) => console.log(String(m).replace(key || '\u0000', '***')) }); break; } catch (e) { scriptError = e.message; }
  }
  if (r) { seed = Math.min(seed, 11); files = writeTrack(out, `${rep.id}-${length.cut}`, r); if (seed > 0) warnings.push(`The commentary needed another wording variant (${seed}) to pass the fact check.`); }
  else warnings.push(`The commentary could not be written (${String(scriptError).slice(0, 140)}). This video has no commentary.`);
  const gen = r?.track.generated || { source: 'none' };
  let llmUsable = !!llm && !!r && gen.source !== 'template';
  if (r && llm && gen.source === 'template') warnings.push(`The script LLM did not deliver (${String(gen.llm_error || 'no usable lines').replace(key || '\u0000', '***').slice(0, 160)}). The built-in template wrote the commentary instead.`);
  else if (r && llm && gen.replaced?.length) warnings.push(`${gen.replaced.length} LLM line(s) failed the fact check and were replaced by template lines.`);
  emit('script', 12, r ? `Script ready: ${r.track.lines.length} lines (${gen.source})` : 'No commentary');

  // ---- voices
  let voiceJson = null;
  const wantVoices = A.voices === 'on' && !!r;
  if (wantVoices) {
    const { checkTts, buildVoices, VoiceError } = await import('./video-voices.mjs');
    emit('voices', 13, 'Checking the voice server');
    const st = await checkTts(A['tts-url']);
    if (!st.ok) warnings.push(`Voices skipped: ${st.error}. This video has captions only.`);
    else {
      try {
        const voiceDirs = Object.fromEntries((A.voice || []).map((s) => s.split('=')));
        const v = await buildVoices({ manifestFile: files.tts, castersFile: files.json, outDir: out, url: A['tts-url'], voiceDirs, key: process.env.RTS_TTS_KEY || '',
          log: (m) => console.log(m), onProgress: (d, n) => emit('voices', 13 + 17 * (d / n), `Voicing line ${d} of ${n}`) });
        voiceJson = v.json;
        if (v.dropped.length) warnings.push(`${v.dropped.length} line(s) could not be voiced and are missing (captions removed too).`);
      } catch (e) {
        if (!(e instanceof VoiceError) && !/ffmpeg|decode/i.test(e.message)) console.log('voice error: ' + e.stack);
        warnings.push(`Voices failed: ${e.message}. This video has captions only.`);
      }
    }
  }
  const renderStart = wantVoices ? 30 : 14;

  // ---- render (render-broadcast.mjs writes the casters again from the cache; the script hash must match the voices)
  const presets = format.presets;
  const rargs = [path.join(ROOT, 'tools/render-broadcast.mjs'), replayDir, '--cut', length.cut, '--preset', presets.length === 2 ? 'both' : presets[0], '--out', out, '--audio', 'on', '--crf', String(A.crf || 20)]; // crf 20: the renderer's default 16 gives 500 MB for 2 minutes of 1080p60
  if (length.target) rargs.push('--target', length.target);
  if (!r) rargs.push('--no-casters');
  else if (seed > 0) rargs.push('--casters-seed', String(seed));
  if (llmUsable) rargs.push('--llm', A.llm);
  if (voiceJson) rargs.push('--voices', voiceJson);
  if (A['limit-s']) rargs.push('--limit-s', String(A['limit-s']));
  emit('render', renderStart, 'Starting the renderer');
  const tail = [];
  let preset = 0, started = 0;
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, rargs, { cwd: ROOT, env: { ...process.env, OPENAI_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { try { p.kill('SIGTERM'); } catch { /* gone */ } };
    process.on('SIGTERM', () => { stop(); setTimeout(() => process.exit(143), 500); });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const parts = buf.split('\n'); buf = parts.pop();
      for (const raw of parts) {
        const line = raw.replace(key || '\u0000', '***');
        if (!line.trim()) continue;
        tail.push(line); if (tail.length > 12) tail.shift();
        console.log(line);
        const rm = /^render (\w+) \/ (\w+):/.exec(line);
        if (rm) { started++; preset = started - 1; emit('render', renderStart + ((97 - renderStart) * preset) / presets.length, `Rendering ${PRESET_LABEL[rm[2]] || rm[2]}`); }
        const fm = /frame (\d+)\/(\d+) \((\d+)%\)/.exec(line);
        if (fm) emit('render', renderStart + ((97 - renderStart) * (preset + +fm[1] / +fm[2])) / presets.length, `Rendering ${PRESET_LABEL[presets[Math.min(preset, presets.length - 1)]]}: frame ${fm[1]} of ${fm[2]}`);
        if (/^\s+-> .*\.mp4/.test(line)) emit('render', renderStart + ((97 - renderStart) * (preset + 1)) / presets.length, 'Encoded');
      }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', reject);
    p.on('exit', (c, sig) => (c === 0 ? resolve() : reject(new Fail(`The renderer stopped (${sig || 'exit ' + c}). ${friendly(tail)}`))));
  });

  // ---- outputs
  emit('finish', 98, 'Collecting the files');
  const outputs = [];
  for (const pr of presets) {
    const f = path.join(out, `${rep.id}-${length.cut}-${pr}.mp4`);
    if (!fs.existsSync(f)) throw new Fail(`The renderer finished but ${path.basename(f)} is missing.`);
    outputs.push({ file: path.basename(f), kind: 'video', preset: pr, label: PRESET_LABEL[pr], bytes: fs.statSync(f).size });
  }
  if (files && fs.existsSync(files.srt)) outputs.push({ file: path.basename(files.srt), kind: 'captions', label: 'Captions (.srt)', bytes: fs.statSync(files.srt).size });
  const res = { outputs, warnings, script: { source: gen.source, model: gen.model || null, lines: r ? r.track.lines.length : 0 }, voices: !!voiceJson, length: lengthKey, format: A.format || 'yt' };
  fs.writeFileSync(path.join(out, 'make-video-result.json'), JSON.stringify(res, null, 1));
  emit('done', 100, 'Done');
  console.log('@@result ' + JSON.stringify(res));
  process.exit(0);
}

// run a node tool, call onLine for every output line; resolves { code, tail }
function runTool(args, env, onLine, onChild) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(p);
    const tail = []; let buf = '';
    const onData = (d) => { buf += d.toString(); const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) if (l.trim()) { tail.push(l); if (tail.length > 12) tail.shift(); console.log(l); onLine?.(l); } };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', reject);
    p.on('exit', (code, sig) => resolve({ code: code ?? 1, sig, tail }));
  });
}

// returns the result object, or null when the story script could not be written (the caller falls back to the highlight cut)
async function storyCut({ A, rep, replayDir, out, format, key, workers, warnings }) {
  const env = { ...process.env, OPENAI_API_KEY: key };
  const scrub = (l) => l.replace(key || '\u0000', '***');
  const base = [path.join(ROOT, 'tools/render-story.mjs'), replayDir, '--target', '300', '--out', out, '--crf', String(A.crf || 20)];
  let llmArgs = typeof A.llm === 'string' && A.llm ? ['--llm', A.llm] : [];
  emit('script', 6, llmArgs.length ? 'Writing the story script with the LLM' : 'Writing the story script (built-in template)');
  let r = await runTool([...base, '--stage', 'casters', ...llmArgs], env, null);
  if (r.code !== 0 && llmArgs.length) { warnings.push('The script LLM failed on the story cut; the built-in template wrote it instead.'); llmArgs = []; r = await runTool([...base, '--stage', 'casters'], env, null); }
  const casters = path.join(out, `${rep.id}-story-casters.json`), tts = path.join(out, `${rep.id}-story-casters-tts.json`);
  if (r.code !== 0 || !fs.existsSync(casters)) { warnings.push(`The story cut could not be prepared (${scrub(r.tail.slice(-1)[0] || 'unknown error').slice(0, 140)}). A highlight cut was made instead.`); return null; }
  const gen = JSON.parse(fs.readFileSync(casters, 'utf8')).generated || {};
  if (llmArgs.length && gen.source === 'template') { warnings.push(`The script LLM did not deliver (${String(gen.llm_error || 'no usable lines').replace(key || '\u0000', '***').slice(0, 160)}). The built-in template wrote the commentary instead.`); llmArgs = []; }
  emit('script', 12, `Story script ready (${gen.source})`);

  let voiceJson = null;
  if (A.voices === 'on') {
    const { checkTts, buildVoices } = await import('./video-voices.mjs');
    emit('voices', 13, 'Checking the voice server');
    const st = await checkTts(A['tts-url']);
    if (!st.ok) warnings.push(`Voices skipped: ${st.error}. This video has captions only.`);
    else {
      try {
        const voiceDirs = Object.fromEntries((A.voice || []).map((x) => x.split('=')));
        const v = await buildVoices({ manifestFile: tts, castersFile: casters, outDir: out, url: A['tts-url'], voiceDirs, key: process.env.RTS_TTS_KEY || '', log: (m) => console.log(m), onProgress: (d, n) => emit('voices', 13 + 17 * (d / n), `Voicing line ${d} of ${n}`) });
        voiceJson = v.json;
        if (v.dropped.length) warnings.push(`${v.dropped.length} line(s) could not be voiced and are missing (captions removed too).`);
      } catch (e) { warnings.push(`Voices failed: ${e.message}. This video has captions only.`); }
    }
  }
  const start = A.voices === 'on' ? 30 : 14, presets = format.presets;
  const args = [...base, '--preset', presets.length === 2 ? 'both' : presets[0], '--workers', String(workers), ...llmArgs];
  if (voiceJson) args.push('--voices', voiceJson);
  if (A['limit-s']) args.push('--limit-s', String(A['limit-s']));
  emit('render', start, `Rendering the story cut (${workers} parallel chunks)`);
  let preset = 0, child = null;
  process.on('SIGTERM', () => { try { child?.kill('SIGTERM'); } catch { /* gone */ } setTimeout(() => process.exit(143), 500); });
  const res = await runTool(args, env, (line) => {
    const pm = /^\s+parallel \d+ s: (.*)$/.exec(line);
    if (pm) { const f = [...pm[1].matchAll(/(\d+)\/(\d+)/g)].map((m) => +m[1] / +m[2]); if (f.length) emit('render', start + ((97 - start) * (preset + f.reduce((a, b) => a + b, 0) / f.length)) / presets.length, `Rendering the story cut: ${Math.round(100 * f.reduce((a, b) => a + b, 0) / f.length)}% of the frames`); }
    const fm = /frame (\d+)\/(\d+) \((\d+)%\)/.exec(line);
    if (fm && workers === 1) emit('render', start + ((97 - start) * (preset + +fm[1] / +fm[2])) / presets.length, `Rendering the story cut: frame ${fm[1]} of ${fm[2]}`);
    if (/^\s+-> .*\.mp4/.test(line)) { preset++; emit('render', start + ((97 - start) * preset) / presets.length, 'Encoded'); }
  }, (p) => { child = p; });
  if (res.code !== 0) throw new Fail(`The story renderer stopped (${res.sig || 'exit ' + res.code}). ${scrub(res.tail.slice(-3).join(' | ')).slice(0, 300)}`);
  emit('finish', 98, 'Collecting the files');
  const outputs = [];
  for (const pr of presets) {
    let f = path.join(out, `${rep.id}-story-${pr}.mp4`);
    if (!fs.existsSync(f) && A['limit-s']) f = path.join(out, `${rep.id}-story-${pr}-main.mp4`); // a test window has no cold open and no joined file
    if (!fs.existsSync(f)) throw new Fail(`The renderer finished but ${path.basename(f)} is missing.`);
    outputs.push({ file: path.basename(f), kind: 'video', preset: pr, label: PRESET_LABEL[pr], bytes: fs.statSync(f).size });
  }
  const srt = path.join(out, `${rep.id}-story-casters.srt`);
  if (fs.existsSync(srt)) outputs.push({ file: path.basename(srt), kind: 'captions', label: 'Captions (.srt)', bytes: fs.statSync(srt).size });
  const result = { outputs, warnings, script: { source: gen.source, model: gen.model || null, lines: 0 }, voices: !!voiceJson, length: 'story5', format: A.format || 'yt' };
  fs.writeFileSync(path.join(out, 'make-video-result.json'), JSON.stringify(result, null, 1));
  return result;
}

// readable text for the last renderer lines
function friendly(tail) {
  const t = tail.join(' ');
  if (/Cannot find module.*puppeteer/i.test(t)) return 'puppeteer-core is missing (set PUPPETEER_CORE).';
  if (/ENOSPC/.test(t)) return 'The disk is full.';
  if (/WARNING: re-simulation/.test(t)) return 'The replay does not re-simulate to the recorded result (wrong sim version?).';
  return tail.slice(-3).join(' | ').slice(0, 300);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.log('@@error ' + String(e instanceof Fail ? e.message : `Unexpected error: ${e.message}`).replace(process.env.OPENAI_API_KEY || '\u0000', '***').replace(/\n+/g, ' ').slice(0, 500));
    if (!(e instanceof Fail)) console.log(e.stack);
    process.exit(1);
  });
}
