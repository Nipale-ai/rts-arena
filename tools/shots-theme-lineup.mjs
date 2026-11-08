#!/usr/bin/env node
// Dev tool (reskin look check): staged close-ups of units, buildings and nature, rendered with the frame-exact broadcast page, with or without a theme.
// Nothing is simulated beyond the first 1200 ticks of a made-up match (only used for a real map and the init message); the snapshots are made up for the picture, nothing is recorded.
//   node tools/shots-theme-lineup.mjs --out dir --mode units|close|buildings|nature [--theme id] [--only a,b,c] [--tiers 1,2,3] [--w 1920 --h 1080] [--port 8893] [--quality live]
// units:     group shots, per group one row of unit types, team 1 in front, team 2 behind (the same type next to each other)
// close:     one shot per unit type (--only to choose), team 1 left, team 2 right, near camera
// buildings: one shot per building type and tier (the page forces the tier), team 1 left, team 2 right
// nature:    forest, rocks, resource nodes and deco of the map around the first base from a few angles
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
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.anim': 'application/octet-stream', '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml' };
const A = {};
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!A.out || !['units', 'close', 'buildings', 'nature'].includes(A.mode)) { console.error('usage: node tools/shots-theme-lineup.mjs --out dir --mode units|close|buildings|nature [--theme id] [--only a,b] [--tiers 1,2,3] [--w 1920 --h 1080] [--port 8893] [--quality live] [--teamtint 0.35] [--lod0 1]'); process.exit(2); }
const out = path.resolve(A.out), W = +A.w || 1920, H = +A.h || 1080, PORT = +A.port || 8893;
const only = A.only ? new Set(String(A.only).split(',')) : null;
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
const uIdx = (n) => init.units.indexOf(n), bIdx = (n) => init.buildings.indexOf(n);
const tpl = base.units[0];
const terr = (x, z) => game.terrain[Math.floor(z) * game.W + Math.floor(x)];

// the first open (or, for boats, wet) rectangle of w x d tiles near the first base
// (units that left a snapshot lie dying for a while, so every unit shot gets its own place: `used` keeps the earlier ones apart)
const used = [];
function findArea(w, d, kind = 0, apart = false) {
  const ok = (x, z) => x >= 2 && z >= 2 && x < game.W - 2 && z < game.H - 2 && terr(x, z) === kind;
  for (let r = 0; r <= 60; r += 2) for (let dz = -r; dz <= r; dz += 2) for (let dx = -r; dx <= r; dx += 2) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const x0 = st.tx + dx, z0 = st.ty + dz;
    let good = true;
    for (let i = -1; i <= w + 1 && good; i++) for (let j = -1; j <= d + 1 && good; j++) if (!ok(x0 + i, z0 + j)) good = false;
    if (good && apart && used.some((u) => Math.hypot(u[0] - x0, u[1] - z0) < 14)) good = false;
    if (good) { if (apart) used.push([x0, z0]); return [x0, z0]; }
  }
  return null;
}

let nextId = 9001;
// row: [id, owner, type, x, z, hp, act, target, carried goods, cooldown] (server/spectate.mjs snapshot); the template is a working worker, so act, carry and the work fields (10..12) must be cleared: otherwise every unit shows a carried-goods cube (and a work marker) like a worker at the berries
const unitRow = (name, owner, x, z) => { const r = tpl.slice(0, 10); r[0] = nextId++; r[1] = owner; r[2] = uIdx(name); r[3] = +x.toFixed(2); r[4] = +z.toFixed(2); r[5] = 100; r[6] = 0; r[7] = 0; r[8] = 0; r[9] = 0; return r; };
const bldRow = (name, owner, x, y) => [nextId++, owner, bIdx(name), x, y, 100, 100, 0];
const shots = []; // { name, units, buildings, cam, tier }

const LAND = ['worker', 'spearman', 'swordsman', 'archer', 'skirmisher', 'scout', 'light_cavalry', 'heavy_cavalry', 'ram', 'catapult', 'mortar', 'sapper', 'bulwark', 'healer'];
const BOATS = ['fishing_boat', 'war_boat', 'transport'];
const keep = (arr) => arr.filter((n) => !only || only.has(n));

if (A.mode === 'units') {
  const groups = [['worker', 'spearman', 'swordsman', 'archer', 'skirmisher', 'healer'], ['scout', 'light_cavalry', 'heavy_cavalry', 'bulwark', 'sapper'], ['ram', 'catapult', 'mortar']];
  groups.forEach((g, gi) => {
    const list = keep(g); if (!list.length) return;
    const area = findArea(list.length * 3 + 2, 6, 0, true);
    if (!area) { console.log('skip group', gi + 1, '(no place)'); return; }
    const gap = gi === 2 ? 3.2 : 2.1, units = [];
    list.forEach((n, i) => { const x = area[0] + 1 + i * gap; units.push(unitRow(n, 1, x, area[1] + 4.2), unitRow(n, 2, x, area[1] + 1.4)); });
    const cx = area[0] + 1 + (list.length - 1) * gap / 2;
    shots.push({ name: `units-group${gi + 1}`, units, buildings: [], cam: { tx: cx, ty: 0.9, tz: area[1] + 2.8, dist: 4.4 + list.length * 1.35, az: 0.0, pol: 1.12, fov: 32 } });
  });
  {
    const list = keep(BOATS), wet = list.length ? findArea(14, 5, 2, true) : null;
    if (wet) {
      const units = []; list.forEach((n, i) => units.push(unitRow(n, 1, wet[0] + 1 + i * 3.6, wet[1] + 3.6), unitRow(n, 2, wet[0] + 1 + i * 3.6, wet[1] + 1.2)));
      shots.push({ name: 'units-boats', units, buildings: [], cam: { tx: wet[0] + 1 + (list.length - 1) * 1.8, ty: 0.3, tz: wet[1] + 2.4, dist: 11, az: 0.0, pol: 1.05, fov: 32 } });
    }
  }
}
if (A.mode === 'close') {
  for (const n of keep([...LAND, ...BOATS])) {
    const where = findArea(8, 6, BOATS.includes(n) ? 2 : 0, true);
    if (!where) { console.log('skip', n, '(no place)'); continue; }
    const gap = ['ram', 'catapult', 'mortar', 'transport', 'war_boat'].includes(n) ? 3.0 : 1.5;
    const units = [unitRow(n, 1, where[0] + 3 - gap / 2, where[1] + 3), unitRow(n, 2, where[0] + 3 + gap / 2, where[1] + 3)];
    shots.push({ name: `close-${n}`, units, buildings: [], cam: { tx: where[0] + 3, ty: 0.7, tz: where[1] + 3, dist: 2.3 + gap * 1.05, az: 0.35, pol: 1.15, fov: 17 } });
  }
}
if (A.mode === 'buildings') {
  const tiers = String(A.tiers || '1,2,3').split(',').map(Number);
  for (const n of keep(Object.keys(init.buildingDefs))) {
    const sz = init.buildingDefs[n].size || 2, area = findArea(sz * 2 + 4, sz + 3);
    if (!area) { console.log('skip', n, '(no place)'); continue; }
    const x1 = Math.ceil(area[0]) + 1, x2 = x1 + sz + 3, y = Math.ceil(area[1]) + 1;
    for (const tier of tiers) shots.push({ name: `bld-${n}-t${tier}`, tier, units: [], buildings: [bldRow(n, 1, x1, y), bldRow(n, 2, x2, y)], cam: { tx: (x1 + x2 + sz) / 2, ty: 0.9, tz: y + sz / 2, dist: 6 + sz * 3.3, az: 0.55, pol: 0.95, fov: 32 } });
  }
}
if (A.mode === 'nature') {
  const find = (code, nearX, nearZ) => { let best = null, bd = 1e9; for (let z = 3; z < game.H - 3; z++) for (let x = 3; x < game.W - 3; x++) if (game.terrain[z * game.W + x] === code) { const d = (x - nearX) ** 2 + (z - nearZ) ** 2; if (d < bd) { bd = d; best = [x + 0.5, z + 0.5]; } } return best; };
  const spots = [['forest', find(1, st.tx, st.ty)], ['rocks', find(3, st.tx, st.ty)], ['water', find(2, st.tx, st.ty)]];
  for (const [nm, p] of spots) {
    if (!p) { console.log('skip', nm); continue; }
    [[0.2, 1.0, 9], [1.9, 0.85, 6.5], [3.6, 1.1, 14]].forEach(([az, pol, dist], i) => shots.push({ name: `nature-${nm}-${i + 1}`, units: [], buildings: [], cam: { tx: p[0], ty: 0.8, tz: p[1], dist, az, pol, fov: 32 } }));
  }
  // resource nodes: row [id, type, x, z, state?, amount, max] (init.nodes): per type the node nearest to the first base, two views each
  const nodes = init.nodes || [];
  for (const type of ['gold', 'stone', 'berries']) {
    const q = nodes.filter((n) => n[1] === type).sort((m, n) => ((m[2] - st.tx) ** 2 + (m[3] - st.ty) ** 2) - ((n[2] - st.tx) ** 2 + (n[3] - st.ty) ** 2))[0];
    if (!q) { console.log('skip node', type); continue; }
    [[0.55, 1.0, 6], [2.4, 0.9, 11]].forEach(([az, pol, dist], i) => shots.push({ name: `node-${type}-${i + 1}`, units: [], buildings: [], cam: { tx: q[2] + 0.5, ty: 0.5, tz: q[3] + 0.5, dist, az, pol, fov: 32 } }));
  }
}
if (!shots.length) throw new Error('nothing to shoot (check --only)');

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
await page.goto(`http://127.0.0.1:${PORT}/broadcast.html?capture=1&preset=yt&quality=${A.quality || 'live'}${A.theme ? '&theme=' + encodeURIComponent(A.theme) : ''}${A.teamtint ? '&teamtint=' + encodeURIComponent(A.teamtint) : ''}${A.lod0 ? '&riglod=0&lodk=8' : ''}`, { waitUntil: 'load' });
await page.waitForFunction('window.__bcReady === true', { timeout: 30000 });
await page.evaluate(async (m) => { const h = window.__bcHooks; h.init(m); await h.ready; }, init);
await page.addStyleTag({ content: '#stage > :not(#view){display:none!important}' });

// the base snapshot without its own units and buildings: only the staged ones are in the picture
const empty = { ...base, units: [], buildings: [], proj: [], dead: [], ev: [], mk: [], say: [] };
let tick = 0;
for (const s of shots) {
  await page.evaluate((t) => { window.__rts.forceTier = t || 0; }, s.tier || 0);
  const snap = { ...empty, t: base.t + ++tick, units: s.units, buildings: s.buildings };
  await page.evaluate((x) => window.__bcHooks.snap(x), snap);
  await page.evaluate((x) => window.__bcHooks.snap(x), { ...snap, t: snap.t + 1 });
  // models and textures load on demand: render a few times with a pause until nothing changes
  for (let a = 0; a < 4; a++) { await page.evaluate((c) => window.__bcHooks.render(0.5, 0, 1 / 30, c), s.cam); await new Promise((r) => setTimeout(r, a < 2 ? 700 : 300)); }
  await page.evaluate((c) => window.__bcHooks.render(1, 0.1, 1 / 30, c), s.cam);
  await page.screenshot({ path: path.join(out, `${s.name}.png`), type: 'png' });
  console.log('saved', s.name);
}
console.log('theme', A.theme || 'classic', 'mode', A.mode, 'shots', shots.length, 'size', `${W}x${H}`);
await browser.close();
srv.close();
process.exit(0);
