#!/usr/bin/env node
// Dev tool: side-view screenshot sequence of one rider moving over flat ground, to judge the gait against the ground speed (foot sliding).
// The sim is run in Node on an empty arena, the page is driven frame by frame like the broadcast render (render/broadcast.mjs).
//   node tools/gait-shots.mjs --out dir [--unit light_cavalry] [--escort 4] [--frames 24] [--skip 6] [--step 1] [--dist 4.5] [--ty 0.9] [--fov 26] [--dx 0] [--pre 2.4] [--az 0] [--w 1280] [--h 720]
// --escort N sends N spearmen along, so the group marches at their pace (a slow ride); --skip = frames dropped after the start; --step = rendered frames between two shots.
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
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const A = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const n = process.argv[i + 1]; if (n === undefined || n.startsWith('--')) A[a.slice(2)] = true; else { A[a.slice(2)] = n; i++; } } }
const OUT = A.out || 'gait-out', UNIT = A.unit || 'light_cavalry', ESCORT = +(A.escort || 0), FRAMES = +(A.frames || 24), SKIP = +(A.skip || 6), STEP = +(A.step || 1), DIST = +(A.dist || 4.5), W = +(A.w || 1280), H = +(A.h || 720);
const FPS = 60;

Object.assign(spectateArgs, { 'no-record': true, p1: 'turtle', p2: 'turtle', seed: A.seed || 7 });
const log = console.log; console.log = () => {};
const match = new Match(); const initMsg = match.initMsg(); console.log = log;
match.bots = []; // no scripted bots: only the units set up here move
const g = match.game, N = g.W;
// a straight lane in the middle of the map, east -> west on +x
const y0 = Math.floor(N / 2) * 1000 + 500, x0 = 20000;
const ids = [];
const rider = g.addUnit(1, UNIT, x0, y0); ids.push(rider.id ?? rider);
for (let k = 0; k < ESCORT; k++) ids.push((g.addUnit(1, 'spearman', x0 - 800 - k * 100, y0 + (k - ESCORT / 2) * 500)).id);
const target = [(x0 + 60000) / 1000, y0 / 1000];
log('rider id', ids[0], 'units', ids.length, 'map', N);
const r = g.command(1, { cmd: 'move', units: ids, to: target }); log('move', JSON.stringify(r));
const tick = () => { console.log = () => {}; match.tick(); console.log = log; };

const { srv, port } = await new Promise((res) => { const s = http.createServer((req, rs) => { const u = new URL(req.url, 'http://127.0.0.1'); const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname))); if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(rs); }); s.listen(0, '127.0.0.1', () => res({ srv: s, port: s.address().port })); });
const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', protocolTimeout: 900000, args: [...angleArgs(), '--ignore-gpu-blocklist', '--no-sandbox', '--force-device-scale-factor=1', `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log('[page]', m.text()); });
page.on('pageerror', (e) => log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/broadcast.html?capture=1&preset=yt`, { waitUntil: 'load' });
await page.waitForFunction('window.__bcReady === true', { timeout: 30000 });
await page.evaluate((m, c) => window.__bc.setup(m, c), initMsg, { cls: '', footer: '', story: false });
fs.mkdirSync(OUT, { recursive: true });

// run SKIP ticks first, then render the frames
await page.addStyleTag({ content: '#stage > *:not(#view) { display: none !important; }' });
const anchor = +(A.anchor || 36);
const rx = () => { const s = match.snapshot(), u = s.units.find((q) => q[0] === ids[0]); return u ? u[3] : 0; };
for (let k = 0; k < 8; k++) tick();
const PRE = +(A.pre || 2.4); // tiles ridden before the first shot (the page renders them too, so facing and speed have settled)
while (rx() < anchor - PRE && !g.over) tick();
let prev = match.snapshot();
const pos = (s) => { const u = s.units.find((q) => q[0] === ids[0]); return u ? [u[3], u[4]] : null; };
let first = true, f = 0, shot = 0;
const speeds = [];
const total = (SKIP + FRAMES * STEP);
while (shot < FRAMES) {
  tick(); const cur = match.snapshot();
  const pa = pos(prev), pc = pos(cur);
  if (pa && pc) log('pos', pc.map((v) => v.toFixed(2)).join(','));
  if (pa && pc) speeds.push(Math.hypot(pc[0] - pa[0], pc[1] - pa[1]) * 10);
  for (let j = 0; j < 6; j++) {
    const alpha = j / 6;
    const x = pa ? pa[0] + (pc[0] - pa[0]) * alpha : 0, z = pa ? pa[1] + (pc[1] - pa[1]) * alpha : 0;
    // static camera: the side view stays where the rider passes (x = anchor), so slip shows as hoof drift on the screen
    const cx = (A.follow ? x : anchor) + +(A.dx || 0);
    const snaps = j === 0 ? (first ? [prev, cur] : [cur]) : []; first = false;
    await page.evaluate((fr) => { const H = window.__bcHooks; for (const s of fr.snaps) H.snap(s); H.render(fr.alpha, fr.animT, fr.dt, fr.cam); }, { snaps, alpha, animT: f / FPS, dt: 1 / FPS, cam: { tx: cx, ty: +(A.ty ?? 0.9), tz: z, dist: DIST, az: +(A.az ?? 0), pol: Math.PI / 2 - 0.12, fov: +(A.fov ?? 26) }, }).catch((e) => { log('frame error', e.message); process.exit(1); });
    if (f >= SKIP && (f - SKIP) % STEP === 0 && shot < FRAMES) { await page.screenshot({ path: path.join(OUT, `f${String(shot).padStart(3, '0')}.png`), type: 'png' }); shot++; }
    f++;
  }
  prev = cur;
}
log('ground speed tiles/s (per tick):', speeds.map((s) => s.toFixed(2)).join(' '));
await browser.close(); srv.close();
