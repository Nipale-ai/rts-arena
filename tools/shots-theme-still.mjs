#!/usr/bin/env node
// Dev tool (R3 + R4): a staged firing line for the shooter theme hooks, rendered with the frame-exact broadcast page.
// Three archers of player 1 stand on an open strip next to the first base and shoot at three swordsmen of player 2 (shot rows, cooldowns and damage are made up
// for the picture; no sim is changed, nothing is recorded). Same scene with and without a theme, so the two sets can be laid side by side.
//   node tools/shots-theme-still.mjs --out dir [--theme id] [--port 8892] [--sub 3] [--dist 8.5] [--pol 1.22] [--az 0.55] [--fov 32] [--frames 4,9,15]
// Writes one PNG per output frame (3 per sim tick by default; with --frames only the listed ones) and prints what the page reported (themed shots, particles).
import '../server/local-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { args as spectateArgs, Match } from '../server/spectate.mjs';
import { chromePath, angleArgs, puppeteerDir } from './make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };
const A = {};
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!A.out) { console.error('usage: node tools/shots-theme-still.mjs --out dir [--theme id] [--port 8892] [--sub 3] [--dist 8.5] [--pol 1.22] [--az 0.55] [--fov 32] [--frames 4,9,15]'); process.exit(2); }
const out = path.resolve(A.out), W = 1920, H = 1080, SUB = +A.sub || 3, PORT = +A.port || 8892;
const only = A.frames ? new Set(String(A.frames).split(',').map(Number)) : null;
fs.mkdirSync(out, { recursive: true });

Object.assign(spectateArgs, { p1: 'rush', p2: 'boom', seed: '7', 'no-record': true });
const log = console.log;
console.log = () => {};
const match = new Match();
const init = match.initMsg();
for (let i = 0; i < 1200; i++) match.tick();
const base = match.snapshot();
const game = match.game, st = game.starts[0];
console.log = log;
const uIdx = (n) => init.units.indexOf(n);

// an open strip (no forest, water or rock), 7 tiles wide, near the first base
const D = 6, free = (x, z) => x >= 2 && z >= 2 && x < game.W - 2 && z < game.H - 2 && game.terrain[Math.floor(z) * game.W + Math.floor(x)] === 0;
let best = null;
for (let dz = -14; dz <= 34 && !best; dz++) for (let dx = -16; dx <= 16 && !best; dx++) {
  const x0 = st.tx + dx, z0 = st.ty + dz;
  let ok = true;
  for (let i = -3; i <= D + 3 && ok; i++) for (let j = -4; j <= 4 && ok; j++) if (!free(x0 + i, z0 + j)) ok = false;
  if (ok) best = [x0 + 0.5, z0 + 0.5];
}
if (!best) throw new Error('no open strip');
const [ox, oz] = best;

// ---- the staged snapshots: 16 ticks, the archers fire at tick 2 (cooldown 1.6 s = 16 ticks), the bolts need 5 ticks, the victims lose hit points when they land
const SPEED = 1400, STEP = SPEED / 1000, FIRE = 2, N = Math.ceil(D / STEP), TICKS = 16, LANES = [-0.9, 0, 0.9];
const snaps = [];
for (let k = 0; k < TICKS; k++) {
  const units = [], proj = [];
  LANES.forEach((lz, i) => {
    const age = k - FIRE + 1, flying = age >= 1 && age <= N, hit = age > N;
    units.push([9001 + i, 1, uIdx('archer'), +ox.toFixed(2), +(oz + lz).toFixed(2), 100, 4, 9101 + i, 0, k < FIRE ? 0 : 16 - (k - FIRE)]);
    units.push([9101 + i, 2, uIdx('swordsman'), +(ox + D).toFixed(2), +(oz + lz).toFixed(2), hit ? 84 : 100, 0, 0, 0, 0]);
    if (flying) proj.push([+(ox + Math.min(D, STEP * age)).toFixed(2), +(oz + lz).toFixed(2), +(ox + D).toFixed(2), +(oz + lz).toFixed(2), 1, SPEED, 0, uIdx('archer'), 9001 + i, age]);
  });
  snaps.push({ ...base, t: base.t + k, units, proj, dead: [], ev: [], mk: [], say: [] });
}

// ---- page
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname)));
  if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: [...angleArgs(), '--ignore-gpu-blocklist', '--no-sandbox', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/broadcast.html?capture=1&preset=yt&quality=${A.quality || 'live'}${A.theme ? '&theme=' + encodeURIComponent(A.theme) : ''}`, { waitUntil: 'load' });
await page.waitForFunction('window.__bcReady === true', { timeout: 30000 });
await page.evaluate(async (m) => { const h = window.__bcHooks; h.init(m); await h.ready; }, init);
await page.addStyleTag({ content: '#stage > :not(#view){display:none!important}' });

const cam = { tx: ox + D * 0.45, ty: A.cy ? +A.cy : 1.15, tz: oz, dist: A.dist ? +A.dist : 8.5, az: A.az !== undefined ? +A.az : 0.55, pol: A.pol ? +A.pol : 1.22, fov: A.fov ? +A.fov : 32 };
await page.evaluate((s) => window.__bcHooks.snap(s), snaps[0]);
let n = 0;
for (let k = 0; k < snaps.length - 1; k++) {
  await page.evaluate((s) => window.__bcHooks.snap(s), snaps[k + 1]);
  for (let a = 0; a < SUB; a++) {
    await page.evaluate((al, t, c) => window.__bcHooks.render(al, t, 1 / 30, c), a / SUB, n / 30, cam);
    if (!only || only.has(n)) await page.screenshot({ path: path.join(out, `still-${String(n).padStart(3, '0')}.png`), type: 'png' });
    n++;
  }
}
const info = await page.evaluate(() => { const w = window.__rts.world; return { bolts: w.projT ? w.projT.count : null, meshes: w.projM ? w.projM.count : null, arrows: w.proj.count, units: Object.values(w.units).filter((u) => u.name === 'archer').length }; });
console.log('theme', A.theme || 'classic', 'frames', n, 'last-frame counters', JSON.stringify(info), 'cam', JSON.stringify(cam));
await browser.close();
srv.close();
process.exit(0);
