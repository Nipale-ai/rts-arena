#!/usr/bin/env node
// Dev tool (reskin assembly): a still of a REAL scene with archers from a replay, with and without a theme, from the same camera.
// The sim is re-run from the replay in Node (as tools/render-broadcast.mjs does), the snapshots around the moment with the most archer shots are handed to the frame-exact
// broadcast page (render/broadcast.html), once classic and once with ?theme=<id>. Nothing is recorded, no sim is changed, no sound is made, no random numbers.
//   node tools/shots-replay-still.mjs replays/<id> --out dir [--theme dustmoon-v1] [--tick N] [--span 8] [--sub 3] [--dist N] [--az 0.55] [--pol 1.1] [--fov 32] [--frames 3,7,12] [--port 8893]
// --tick N: the first tick of the window (default: the tick with the most archer shots in the replay, found by a scan); the window is --span ticks long.
// Writes still-NNN.png (frame number inside the window, SUB frames per tick) and prints the tick, the camera, the archer counts and what the page reported (bolts, arrows).
//
// Golden pin of the classic look of the shots ("the pictures did not change" for arrows, muzzle, hit sparks, units that shoot): a fixed scene, 27 frames, the md5 of every PNG.
//   node tools/shots-replay-still.mjs record [--file f.json]   (on the ORIGINAL code, without the theme patch)
//   node tools/shots-replay-still.mjs check  [--file f.json]   (on the new code, same machine, same Chrome)
// The scene: a scripted bot match (test-support/replays.mjs, no local replay needed), 33 archers, 27 arrows in the air (SETUP). Default file: test-support/shots-golden.json (RTS_SHOTS_GOLDEN overrides).
// The hashes belong to one machine: another GPU or Chrome can change pixels without any code change. `check` prints the environment difference. Heavy: about 15 s of Chrome. Not for battery.
import '../server/local-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { args as spectateArgs, Match } from '../server/spectate.mjs';
import { chromePath, angleArgs, puppeteerDir, hasChrome, hasPuppeteer } from './make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg' };
const W = 1920, H = 1080;

// the golden scene: scripted match rush against turtle, seed 3, the window of 9 ticks that starts at tick 10625 (the tick with the most archer shots of that match), 3 frames per tick
export const SETUP = { bots: ['rush', 'turtle'], seed: 3, tick: 10625, span: 8, sub: 3, frames: 27 };
export const goldenFile = (env = process.env) => env.RTS_SHOTS_GOLDEN || path.join(ROOT, 'test-support/shots-golden.json');

// Renders the window and returns { files, tick0, cam, seen, info, warnings, archers }. theme: a theme folder name (dustmoon-v1) or null = classic.
export async function renderStills({ dir, out, theme = null, tick = null, span = 8, sub = 3, dist = null, az = null, pol = null, fov = null, frames = null, port = 8893, quality = 'live' }) {
  const SUB = +sub || 3, SPAN = +span || 8, only = frames ? new Set(String(frames).split(',').map(Number)) : null;
  fs.mkdirSync(out, { recursive: true });

  // ---- the sim, from the replay
  Object.assign(spectateArgs, { replay: dir, 'no-record': true });
  const log = console.log;
  const quiet = (f) => { console.log = () => {}; try { return f(); } finally { console.log = log; } };
  const newMatch = () => quiet(() => new Match());
  let match = newMatch();
  const init = quiet(() => match.initMsg());
  const ARCHER = init.units.indexOf('archer');
  const isArcherBolt = (q) => q[7] === ARCHER && q[6] !== 1; // (q[6] === 1: not an arrow, see render/app.mjs)

  // scan (only without a tick): the tick with the most archer shots in the air (fresh shots count double: they carry the muzzle flash). The snapshots of the scan are not kept.
  let tick0 = tick !== null && tick !== undefined ? +tick : null;
  if (tick0 === null) {
    let best = -1, bestTick = 1;
    while (!match.game.over) {
      quiet(() => match.tick());
      const n = (quiet(() => match.snapshot()).proj || []).filter(isArcherBolt);
      const score = n.length + n.filter((q) => q[9] <= 2).length;
      if (score > best) { best = score; bestTick = match.game.t; }
    }
    tick0 = Math.max(1, bestTick - 2);
    match = newMatch(); // from the start again
  }
  const snaps = [];
  while (!match.game.over && match.game.t <= tick0 + SPAN) {
    quiet(() => match.tick());
    if (match.game.t >= tick0) snaps.push(quiet(() => match.snapshot()));
  }
  if (snaps.length < 2) throw new Error(`no snapshots from tick ${tick0}`);

  // ---- the camera: on the archer shots of the middle snapshot
  const mid = snaps[Math.min(snaps.length - 1, 3)];
  const pts = [];
  for (const q of mid.proj || []) if (isArcherBolt(q)) pts.push([q[0], q[1]], [q[2], q[3]]);
  if (!pts.length) throw new Error(`no archer shots at tick ${mid.t}`);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const spread = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cz)));
  const cam = { tx: cx, ty: 1.0, tz: cz, dist: dist ? +dist : Math.max(9, spread * 2.4), az: az !== null && az !== undefined ? +az : 0.55, pol: pol ? +pol : 1.1, fov: fov ? +fov : 32 };
  const archers = (s) => (s.units || []).filter((u) => u[2] === ARCHER).length;

  // ---- the page (the server hands out render/ only)
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname)));
    if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: [...angleArgs(), '--ignore-gpu-blocklist', '--no-sandbox', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', `--window-size=${W},${H}`] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const warnings = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.type() === 'warn') warnings.push(m.text()); });
    page.on('pageerror', (e) => warnings.push('pageerror ' + e.message));
    await page.goto(`http://127.0.0.1:${port}/broadcast.html?capture=1&preset=yt&quality=${quality}${theme ? '&theme=' + encodeURIComponent(theme) : ''}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__bcReady === true', { timeout: 30000 });
    await page.evaluate(async (m) => { const h = window.__bcHooks; h.init(m); await h.ready; }, init);
    await page.addStyleTag({ content: '#stage > :not(#view){display:none!important}' }); // the scene only: no overlay

    await page.evaluate((s) => window.__bcHooks.snap(s), snaps[0]);
    let n = 0, seen = { bolts: 0, arrows: 0 };
    const files = [];
    for (let k = 0; k < snaps.length - 1; k++) {
      await page.evaluate((s) => window.__bcHooks.snap(s), snaps[k + 1]);
      for (let a = 0; a < SUB; a++) {
        await page.evaluate((al, t, c) => window.__bcHooks.render(al, t, 1 / 30, c), a / SUB, n / 30, cam);
        if (!only || only.has(n)) { const f = path.join(out, `still-${String(n).padStart(3, '0')}.png`); await page.screenshot({ path: f, type: 'png' }); files.push(f); }
        const c = await page.evaluate(() => { const w = window.__rts.world; return { bolts: w.projT ? w.projT.count : 0, arrows: w.proj.count }; });
        seen = { bolts: Math.max(seen.bolts, c.bolts), arrows: Math.max(seen.arrows, c.arrows) };
        n++;
      }
    }
    const info = await page.evaluate(() => { const w = window.__rts.world; return { archerModels: Object.values(w.units).filter((u) => u.name === 'archer').length }; });
    // which GL renderer drew the frames (a GPU that fell back to software rendering gives other pixels without any code change)
    const renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'), e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown'; });
    return { files, frames: n, tick0, lastTick: snaps[snaps.length - 1].t, firstTick: snaps[0].t, cam, seen, info, warnings, archers: archers(snaps[0]), renderer };
  } finally {
    await browser.close();
    srv.close();
  }
}

// ---- the golden pin
const run = (cmd, args, opts = {}) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); } catch { return ''; } };
export const md5File = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

export function envInfo(renderer = null) {
  const chrome = chromePath();
  return { node: process.version, platform: process.platform, arch: process.arch, chrome: `${chrome} | ${run(chrome, ['--version'])}`, renderer };
}

// pure: rec and cur are { frames: [md5...], env }. Returns { ok, problems, envDiff }.
export function compareStills(rec, cur) {
  const problems = [], a = rec.frames || [], b = cur.frames || [];
  if (!a.length) problems.push('no frames recorded');
  if (a.length !== b.length) problems.push(`${a.length} frames recorded, ${b.length} now`);
  const bad = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) bad.push(i);
  if (bad.length) problems.push(`${bad.length} of ${Math.min(a.length, b.length)} frames differ (first at frame ${bad[0]}: ${a[bad[0]]} != ${b[bad[0]]}; frames ${bad.slice(0, 12).join(',')}${bad.length > 12 ? ',...' : ''})`);
  const envDiff = [];
  for (const k of ['platform', 'arch', 'chrome', 'renderer']) if (rec.env?.[k] !== cur.env?.[k]) envDiff.push(`${k}: recorded "${rec.env?.[k]}", now "${cur.env?.[k]}"`);
  return { ok: problems.length === 0, problems, envDiff };
}

export async function renderGoldenStills(outDir) {
  const { scriptedReplay } = await import('../test-support/replays.mjs');
  const dir = scriptedReplay(SETUP.bots, SETUP.seed);
  const r = await renderStills({ dir, out: outDir, tick: SETUP.tick, span: SETUP.span, sub: SETUP.sub, port: 8895 });
  if (r.frames !== SETUP.frames) throw new Error(`golden stills: ${r.frames} frames rendered, expected ${SETUP.frames}`);
  if (!r.seen.arrows) throw new Error('golden stills: no arrow in the scene (the scene must show arrows)');
  return { frames: r.files.map(md5File), env: envInfo(r.renderer), seen: r.seen, archers: r.archers, warnings: [...new Set(r.warnings)], outDir };
}

export async function runStillGolden(mode, { file = goldenFile(), log = console.log, outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-shots-golden-')) } = {}) {
  if (mode !== 'record' && mode !== 'check') throw new Error(`golden stills: mode must be record or check, got "${mode}"`);
  if (!hasChrome() || !hasPuppeteer()) throw new Error(`golden stills: needs Chrome and puppeteer-core (have: chrome ${hasChrome()}, puppeteer ${hasPuppeteer()})`);
  if (mode === 'check' && !fs.existsSync(file)) throw new Error(`golden stills: no record at ${file}. Run "record" on the original code first.`);
  const cur = await renderGoldenStills(outDir);
  if (mode === 'record') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.${Math.floor(fs.statSync(file).mtimeMs)}.old`); // never delete, keep the older record
    fs.writeFileSync(file, JSON.stringify({ setup: SETUP, env: cur.env, seen: cur.seen, archers: cur.archers, frames: cur.frames }, null, 2) + '\n');
    log(`golden stills: recorded ${cur.frames.length} frames (${cur.archers} archers, up to ${cur.seen.arrows} arrows in one frame) -> ${file}`);
    return { ok: true, file };
  }
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = compareStills(rec, cur);
  log(`golden stills: ${cur.frames.length} frames checked: ${res.ok ? 'IDENTICAL' : 'DIFFERENT'}`);
  for (const p of res.problems) log('  ' + p);
  if (res.envDiff.length) log('  environment differs (a pixel difference may not come from the code):\n    ' + res.envDiff.join('\n    '));
  if (!res.ok) log(`  new frames are in ${cur.outDir}${cur.warnings.length ? `\n  page warnings: ${cur.warnings.join(' | ')}` : ''}`);
  return { ...res, file };
}

async function main() {
  const rest = process.argv.slice(2);
  if (rest[0] === 'record' || rest[0] === 'check') {
    const fi = rest.indexOf('--file');
    try { os.setPriority(0, 10); } catch { /* nice */ }
    try { const r = await runStillGolden(rest[0], fi > 0 ? { file: path.resolve(rest[fi + 1]) } : {}); process.exit(r.ok ? 0 : 1); } catch (e) { console.error(e.message); process.exit(2); }
  }
  const A = {};
  const dir = rest[0] && !rest[0].startsWith('--') ? path.resolve(rest.shift()) : null;
  for (let i = 0; i < rest.length; i += 2) A[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (!dir || !A.out) { console.error('usage: node tools/shots-replay-still.mjs replays/<id> --out dir [--theme id] [--tick N] [--span 8] [--sub 3] [--dist N] [--az 0.55] [--pol 1.1] [--fov 32] [--frames 3,7,12] [--port 8893]\n   or: node tools/shots-replay-still.mjs record|check [--file f.json]'); process.exit(2); }
  const r = await renderStills({ dir, out: path.resolve(A.out), theme: A.theme || null, tick: A.tick !== undefined ? +A.tick : null, span: A.span, sub: A.sub, dist: A.dist, az: A.az, pol: A.pol, fov: A.fov, frames: A.frames, port: +A.port || 8893, quality: A.quality || 'live' });
  console.log('replay', path.basename(dir), 'theme', A.theme || 'classic', 'ticks', r.firstTick, '-', r.lastTick, 'frames', r.frames, 'archers in the first snapshot', r.archers, 'page', JSON.stringify(r.info), 'max in one frame', JSON.stringify(r.seen), 'cam', JSON.stringify(r.cam));
  if (r.warnings.length) console.log('[page warnings]', [...new Set(r.warnings)].join(' | '));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
