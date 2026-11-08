#!/usr/bin/env node
// Golden check for the frame-exact broadcast render: "the pictures did not change" instead of "two runs agree".
// It renders the same short x and yt cuts as test/broadcast.test.mjs (scripted rush-vs-boom match, seed 3, highlight cut, 12 fps, 1.5 s = 18 frames),
// takes the ffmpeg framemd5 of every frame and either records the list or compares against a recorded one.
//   node tools/golden-broadcast.mjs record [--file f.json]   (on the OLD build, e.g. af30cf3)
//   node tools/golden-broadcast.mjs check  [--file f.json]   (on the NEW build, same machine, same Chrome and ffmpeg)
// Default file: ~/.rts-golden/broadcast-framemd5.json (outside the repo, so it survives a checkout); RTS_GOLDEN_FILE overrides it.
// Needs Google Chrome, puppeteer-core and ffmpeg (the same as test/broadcast.test.mjs). Heavy: about a minute of GPU and CPU. Not for battery.
// The hashes belong to one machine: another GPU, Chrome or ffmpeg can change pixels without any code change. `check` prints the environment difference.
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the exact setup of test/broadcast.test.mjs
export const SETUP = { bots: ['rush', 'boom'], seed: 3, presets: ['x', 'yt'], cls: '32 GB', fps: 12, crf: 28, limitS: 1.5, frames: 18 };

export const goldenFile = (env = process.env) => env.RTS_GOLDEN_FILE || path.join(os.homedir(), '.rts-golden', 'broadcast-framemd5.json');

const run = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); } catch { return ''; } };

export function frameHashes(file) {
  const out = execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

export function envInfo(chrome) {
  return {
    head: run('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }) || 'unknown',
    dirty: run('git', ['status', '--porcelain', '--', 'render', 'sim', 'tools', 'server'], { cwd: ROOT }) !== '',
    node: process.version, platform: process.platform, arch: process.arch,
    ffmpeg: run('ffmpeg', ['-version']).split('\n')[0] || 'unknown',
    chrome: chrome ? `${chrome} | ${run(chrome, ['--version'])}` : 'unknown',
  };
}

// pure: rec and cur are { cuts: { x: [md5...], yt: [md5...] }, env }. Returns { ok, problems, envDiff }.
export function compareGolden(rec, cur) {
  const problems = [];
  const names = [...new Set([...Object.keys(rec.cuts || {}), ...Object.keys(cur.cuts || {})])].sort();
  if (!names.length) problems.push('no cuts to compare');
  for (const n of names) {
    const a = rec.cuts?.[n], b = cur.cuts?.[n];
    if (!a || !b) { problems.push(`${n}: missing in ${a ? 'new render' : 'record'}`); continue; }
    if (a.length !== b.length) problems.push(`${n}: ${a.length} frames recorded, ${b.length} now`);
    const bad = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) bad.push(i);
    if (bad.length) problems.push(`${n}: ${bad.length} of ${Math.min(a.length, b.length)} frames differ (first at frame ${bad[0]}: ${a[bad[0]]} != ${b[bad[0]]}; frames ${bad.slice(0, 12).join(',')}${bad.length > 12 ? ',...' : ''})`);
  }
  const envDiff = [];
  for (const k of ['platform', 'arch', 'ffmpeg', 'chrome']) if (rec.env?.[k] !== cur.env?.[k]) envDiff.push(`${k}: recorded "${rec.env?.[k]}", now "${cur.env?.[k]}"`);
  return { ok: problems.length === 0, problems, envDiff };
}

export async function canRender() {
  const { hasChrome, hasPuppeteer } = await import('./make-video.mjs');
  return { chrome: hasChrome(), puppeteer: hasPuppeteer(), ffmpeg: run('ffmpeg', ['-version']) !== '' };
}

// renders both cuts, returns { cuts: { x: [...], yt: [...] }, env, outDir }
export async function renderGoldenCuts(outDir) {
  const { loadReplay } = await import('./lib/replay.mjs');
  const { prepare, renderCut } = await import('./render-broadcast.mjs');
  const { scriptedReplay } = await import('../test-support/replays.mjs');
  const { chromePath } = await import('./make-video.mjs');
  const rep = loadReplay(scriptedReplay(SETUP.bots, SETUP.seed));
  const { ev, plans } = prepare(rep);
  fs.mkdirSync(outDir, { recursive: true });
  const cuts = {};
  for (const pr of SETUP.presets) {
    const r = await renderCut({ rep, ev, plan: plans.highlight, presetName: pr, outFile: path.join(outDir, `${pr}.mp4`), cls: SETUP.cls, fps: SETUP.fps, crf: SETUP.crf, limitS: SETUP.limitS });
    if (r.frames !== SETUP.frames) throw new Error(`golden: ${pr} rendered ${r.frames} frames, expected ${SETUP.frames}`);
    cuts[pr] = frameHashes(r.file);
  }
  return { cuts, env: envInfo(chromePath()), outDir };
}

export async function runGolden(mode, { file = goldenFile(), log = console.log } = {}) {
  if (mode !== 'record' && mode !== 'check') throw new Error(`golden: mode must be record or check, got "${mode}"`);
  const can = await canRender();
  if (!can.chrome || !can.puppeteer || !can.ffmpeg) throw new Error(`golden: needs Chrome, puppeteer-core and ffmpeg (have: ${JSON.stringify(can)})`);
  if (mode === 'check' && !fs.existsSync(file)) throw new Error(`golden: no record at ${file}. Run "record" on the old build first.`);
  const head = envInfo().head;
  const cur = await renderGoldenCuts(path.join(path.dirname(file), `${mode}-${head}`));
  if (mode === 'record') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.${Math.floor(fs.statSync(file).mtimeMs)}.old`); // never delete, keep the older record
    fs.writeFileSync(file, JSON.stringify({ setup: SETUP, env: cur.env, cuts: cur.cuts }, null, 2) + '\n');
    log(`golden: recorded ${Object.entries(cur.cuts).map(([k, v]) => `${k} ${v.length} frames`).join(', ')} at ${head}${cur.env.dirty ? ' (working tree has uncommitted changes)' : ''} -> ${file}`);
    return { ok: true, file };
  }
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = compareGolden(rec, cur);
  log(`golden: recorded at ${rec.env?.head}${rec.env?.dirty ? ' (dirty)' : ''}, checked at ${cur.env.head}${cur.env.dirty ? ' (dirty)' : ''}: ${res.ok ? 'IDENTICAL' : 'DIFFERENT'}`);
  for (const p of res.problems) log('  ' + p);
  if (res.envDiff.length) log('  environment differs (a pixel difference may not come from the code):\n    ' + res.envDiff.join('\n    '));
  if (!res.ok) log(`  new cuts are in ${cur.outDir}`);
  return { ...res, file };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  const fi = process.argv.indexOf('--file');
  if (mode !== 'record' && mode !== 'check') { console.error('usage: node tools/golden-broadcast.mjs record|check [--file f.json]'); process.exit(2); }
  try { os.setPriority(0, 10); } catch { /* nice */ }
  runGolden(mode, fi > 0 ? { file: path.resolve(process.argv[fi + 1]) } : {}).then((r) => process.exit(r.ok ? 0 : 1), (e) => { console.error(e.message); process.exit(2); });
}
