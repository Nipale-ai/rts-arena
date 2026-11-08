#!/usr/bin/env node
// Dev tool (reskin package C0): golden PICTURE PINS of the CLASSIC look of the world: units, buildings, ground, nature, light.
// "The old look did not change": every picture is a fixed scene, shot once, and its md5 is kept. The pins are recorded ONCE on the ORIGINAL code (before any theme hook)
// and checked on the new code (same machine, same Chrome). Nothing is changed in the game, no sound is made, the page gets no random numbers (Math.random is re-seeded).
//
//   node tools/shots-pins.mjs list    [--group units,buildings,ground,nature,light] [--only id,prefix*]       the pictures (no sim, no Chrome)
//   node tools/shots-pins.mjs verify  [--group ...] [--only ...]                                              builds every scene in Node (sim only), checks buildings, cameras, weather: no Chrome
//   node tools/shots-pins.mjs shoot   [--group ...] [--only ...] --out dir                                    only the PNG files (look at them)
//   node tools/shots-pins.mjs record  [--group ...] [--only ...] [--root <tree>] [--file f.json] [--out dir]  shoot and write the md5 into the golden file (on the ORIGINAL tree)
//   node tools/shots-pins.mjs check   [--group ...] [--only ...] [--root <tree>] [--file f.json] [--out dir]  shoot and compare with the golden file (exit 0 = identical)
// --root: the tree whose render/, sim/ and server/ are used (default: the tree this file lives in). To pin the ORIGINAL look from any tree: --root <original-checkout> (read only).
// record refuses a tree that has the theme code (render/theme/theme-loader.mjs): the old look must be recorded before it; --force overrides that on purpose.
// --file: golden file (default test-support/shots-pins-golden.json, RTS_PINS_GOLDEN overrides). A record keeps the older file as <file>.<mtime>.old and only replaces the pictures it shot.
// Granularity: a scene (one page, one sequence of renders) is shot as a whole, so --only/--group never change a picture; they only skip the scenes nobody asked for.
// Heavy: about 4 minutes of Chrome for all 140 pictures (one group: 30 to 90 s). Mac free, not on battery. The hashes belong to one machine, one Chrome and one GPU.
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg' };

export const GROUPS = ['units', 'buildings', 'ground', 'nature', 'light'];
export const MAP_TYPES = ['meadow', 'forest', 'desert', 'winter', 'coast'];
export const SEED = 3;
export const SIZES = { sheet: [1400, 700], grid: [1600, 1000], view: [1920, 1080] };
export const WARM = 8, WARM_WEATHER = 45; // renders before the first picture of a scene (weather needs time to build up)
export const MAP_TICK = 900; // 90 s into a scripted match: bases built, workers busy, no fight yet
export const HP_OF_DAMAGE = { 1: 60, 2: 35, 3: 10 }; // hp percent that gives damage level 1..3 (damageLevel in render/assets3d.mjs: 70 / 45 / 22)
// weather scenes: [kind, map type]
export const WEATHER_SCENES = [['rain', 'meadow'], ['fog', 'meadow'], ['snow', 'meadow'], ['storm', 'meadow'], ['storm', 'desert']];
// building scenes: scripted matches that show most building types at once (found by a scan of the sim, Node only; verify checks them again). harbor needs water: pack grid only.
export const BUILDING_SCENES = [
  { id: 'bld-a', bots: ['rush', 'turtle'], tick: 9900, types: ['town_center', 'house', 'lumber_camp', 'mining_camp', 'mill', 'farm', 'barracks', 'archery_range', 'stables', 'siege_workshop', 'blacksmith', 'tower', 'wall', 'gate', 'castle'] },
  { id: 'bld-b', bots: ['boom', 'towers'], tick: 10200, types: ['market', 'wonder'] },
  { id: 'bld-c', bots: ['boom', 'rush'], tick: 7700, types: ['outpost'] },
];
export const PACK_ONLY = ['harbor'];
const MAP_VIEWS = [['ground', 'wide'], ['ground', 'base'], ['ground', 'closeup'], ['ground', 'water'], ['nature', 'trees'], ['nature', 'gold'], ['nature', 'stone'], ['nature', 'berries'], ['nature', 'herd'], ['light', 'horizon']];

export const goldenFile = (env = process.env) => env.RTS_PINS_GOLDEN || path.join(HERE, 'test-support/shots-pins-golden.json');
export const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// The plan (pure: reads two json files of the tree, no sim, no Chrome)
const readModels = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, 'render/assets/models', rel), 'utf8'));
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : [x]);

// every model id of the nature slots, sorted: trees (all species, also the ones of the map types), deco, deco_extra, nodes, objects, carry
export function natureIds(map) {
  const ids = new Set();
  const species = (t) => { for (const g of ['conifer', 'broadleaf', 'rare']) for (const e of t?.[g] || []) ids.add(e[0]); };
  species(map.trees);
  for (const b of Object.values(map.biomes || {})) species(b.trees);
  for (const g of [map.deco, map.deco_extra]) for (const v of Object.values(g || {})) for (const id of flat(v)) ids.add(id);
  for (const n of Object.values(map.nodes || {})) for (const id of n.states) ids.add(id);
  for (const o of Object.values(map.objects || {})) ids.add(o.model);
  for (const id of Object.values(map.carry || {})) ids.add(id);
  return [...ids].filter((x) => Number.isInteger(x)).sort((a, b) => a - b);
}
export function buildingIds(map) {
  const out = [];
  for (const b of Object.values(map.buildings)) for (const id of [...b.tiers, ...(b.damage ? b.damage.flat() : [])]) if (!out.includes(id)) out.push(id);
  return out;
}

// the scenes of the broadcast page with all their pictures (a picture = { id, group, view, ...params })
export function scenesOf(map) {
  const out = [];
  for (const m of MAP_TYPES) {
    out.push({ id: `map-${m}`, map: m, bots: ['rush', 'turtle'], rules: { preset: 'classic', mapType: m, weather: 'off' }, tick: MAP_TICK, warm: WARM, shots: MAP_VIEWS.map(([group, view]) => ({ id: `${group}-${view}-${m}`, group, view })) });
  }
  for (const [kind, m] of WEATHER_SCENES) {
    const tag = `${kind}${m === 'meadow' ? '' : '-' + m}`;
    out.push({ id: `wx-${tag}`, map: m, weather: kind, bots: ['rush', 'turtle'], rules: { preset: 'classic', mapType: m, weather: kind }, tick: MAP_TICK, warm: WARM_WEATHER, shots: ['base', 'horizon'].map((view) => ({ id: `light-wx-${tag}-${view}`, group: 'light', view })) });
  }
  for (const s of BUILDING_SCENES) {
    const shots = [];
    for (const type of s.types) {
      const tiers = map.buildings[type].tiers.length;
      for (let tier = 1; tier <= tiers; tier++) shots.push({ id: `buildings-${type}-t${tier}`, group: 'buildings', view: 'building', type, tier });
      if (type === 'tower') (map.buildings.tower.damage || []).forEach((list, t) => list.forEach((_, d) => shots.push({ id: `buildings-tower-t${t + 1}-d${d + 1}`, group: 'buildings', view: 'building', type, tier: t + 1, damage: d + 1, hp: HP_OF_DAMAGE[d + 1] })));
    }
    out.push({ id: s.id, map: 'meadow', bots: s.bots, rules: { preset: 'classic', mapType: 'meadow', weather: 'off' }, tick: s.tick, warm: WARM, types: s.types, shots });
  }
  return out;
}

// sheets of the rigged units: one picture per group of up to 6 units and 3 clips, from render/units-preview.html (rows = clips, columns = units, as tools/shots-units.mjs)
export function unitSheets(reg) {
  const out = [];
  for (const [fam, f] of Object.entries(reg.families)) {
    const keys = Object.keys(reg.units).filter((k) => reg.units[k].family === fam);
    const clips = Object.keys(f.clips);
    chunk(keys, 6).forEach((ks, i) => chunk(clips, 3).forEach((cs, j) => {
      const dist = Math.max(9, Math.round(ks.length * 1.6 * 0.96 * 10) / 10);
      out.push({ id: `units-${fam}-k${i + 1}-c${j + 1}`, group: 'units', kind: 'sheet', size: SIZES.sheet, t: 0.4, meta: { keys: ks, clips: cs }, query: { keys: ks.join(','), clips: cs.join(','), cell: '1.6', lod: '0', dist: String(dist), az: '0', el: '48' } });
    }));
  }
  return out;
}

// grids of the models of the pack, from render/assets-preview.html (ids on a grid at the game's camera angle, labelled)
export function packGrids(map) {
  const out = [];
  chunk(buildingIds(map), 12).forEach((ids, i) => out.push({ id: `buildings-pack-${i + 1}`, group: 'buildings', kind: 'grid', size: SIZES.grid, meta: { ids }, query: { ids: ids.join(','), cols: '4', cell: '8', cy: '1.5', time: '0' } }));
  chunk(natureIds(map), 12).forEach((ids, i) => out.push({ id: `nature-pack-${i + 1}`, group: 'nature', kind: 'grid', size: SIZES.grid, meta: { ids }, query: { ids: ids.join(','), cols: '4', cell: '4', cy: '0.8', time: '0' } }));
  return out;
}

const wanted = (id, only) => !only || !only.length || only.some((o) => (o.endsWith('*') ? id.startsWith(o.slice(0, -1)) : id === o));
export const splitList = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : null);

// The pictures to shoot, in a fixed order: units, buildings, ground, nature, light. root: the tree whose json files are read.
export function planPins({ root = HERE, groups = null, only = null } = {}) {
  const map = readModels(root, 'MAP.json'), reg = readModels(root, 'units/UNITS.json');
  const gs = groups && groups.length ? groups : GROUPS;
  for (const g of gs) if (!GROUPS.includes(g)) throw new Error(`unknown group "${g}" (groups: ${GROUPS.join(', ')})`);
  const scenes = scenesOf(map);
  const all = [...unitSheets(reg), ...packGrids(map), ...scenes.flatMap((s) => s.shots.map((p) => ({ ...p, kind: 'shot', scene: s.id, size: SIZES.view })))];
  const ids = new Set();
  for (const p of all) { if (ids.has(p.id)) throw new Error(`pin id twice: ${p.id}`); ids.add(p.id); }
  const pins = GROUPS.filter((g) => gs.includes(g)).flatMap((g) => all.filter((p) => p.group === g)).filter((p) => wanted(p.id, only));
  for (const o of only || []) if (!o.endsWith('*') && !ids.has(o)) throw new Error(`--only: no picture "${o}" (see: node tools/shots-pins.mjs list)`);
  return { pins, scenes, map, reg };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Node side of a scene: the sim, from a scripted match (test-support/replays.mjs does the same for the other pins)
export async function loadTools(root = HERE) {
  const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
  if (fs.existsSync(path.join(root, 'server/local-env.mjs'))) await imp('server/local-env.mjs');
  const [spectate, run, video] = await Promise.all([imp('server/spectate.mjs'), imp('tools/run-match.mjs'), imp('tools/make-video.mjs')]);
  return { root, spectateArgs: spectate.args, Match: spectate.Match, runMatch: run.runMatch, video };
}

const quiet = (f) => { const log = console.log; console.log = () => {}; try { return f(); } finally { console.log = log; } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const nearest = (pts, from) => pts.reduce((b, p) => (!b || Math.hypot(p.x - from.x, p.y - from.y) < Math.hypot(b.x - from.x, b.y - from.y) ? p : b), null);
const tiles = (init, ch) => init.terrain.flatMap((row, y) => [...row].flatMap((c, x) => (c === ch ? [{ x, y }] : [])));
const cam = (x, h, z, dist, az, pol) => ({ tx: +x.toFixed(2), ty: h, tz: +z.toFixed(2), dist, az, pol, fov: 32 });

// The camera of a picture, from the init message and the snapshot of the scene (pure; deterministic). Tile x is world x, tile y is world z.
export function cameraFor(shot, { init, snap }) {
  const s1 = { x: init.starts[0].tx, y: init.starts[0].ty }, S = init.size;
  const at = (p, h, dist, az, pol) => cam(p.x + 0.5, h, p.y + 0.5, dist, az, pol);
  switch (shot.view) {
    case 'wide': return cam(S / 2, 0, S / 2, Math.round(S * 1.15), 0.78, 0.55);
    case 'base': return cam(s1.x + 3, 0.5, s1.y + 3, 24, 0.78, 0.95);
    case 'closeup': { // the open ground tile nearest to a point 9 tiles beside the base; steep look down so the ground texture fills the picture
      const want = { x: s1.x + 9, y: s1.y + 2 };
      const t = nearest(tiles(init, '.'), want);
      return at(t, 0, 6, 0.78, 0.5);
    }
    case 'trees': return at(nearest(tiles(init, 'f'), s1), 0.8, 10, 0.6, 1.0);
    case 'water': return at(nearest(tiles(init, '~'), s1), 0, 14, 0.78, 1.0);
    case 'gold': case 'stone': case 'berries': case 'herd': {
      const n = nearest(init.nodes.filter((q) => q[1] === shot.view).map((q) => ({ x: q[2], y: q[3] })), s1);
      if (!n) throw new Error(`scene has no ${shot.view} node`);
      return at(n, 0.4, 8, 0.6, 1.05);
    }
    case 'horizon': return cam(s1.x + 28, 1, s1.y + 28, 40, -2.356, 1.42); // from the first base across the map: sky, haze, far trees
    case 'building': {
      const ti = init.buildings.indexOf(shot.type), size = init.buildingDefs[shot.type].size;
      const all = snap.buildings.filter((b) => b[2] === ti);
      const b = all.filter((q) => q[6] >= 100).sort((p, q) => p[0] - q[0])[0] || all.sort((p, q) => p[0] - q[0])[0];
      if (!b) throw new Error(`scene has no ${shot.type}`);
      return cam(b[3] + size / 2, Math.max(0.8, +(size * 0.3).toFixed(2)), b[4] + size / 2, +(5 + size * 1.6).toFixed(1), 0.78, 0.95);
    }
    default: throw new Error(`unknown view "${shot.view}"`);
  }
}

// Runs the scripted match up to the tick of the scene. Returns { init, snaps: [tick-1, tick], cams: { pictureId: cam }, info }.
export async function sceneData(scene, T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-pins-replay-'));
  T.runMatch({ seed: SEED, bots: scene.bots, rules: scene.rules, log: path.join(dir, 'log.jsonl'), maxMinutes: Math.ceil(scene.tick / 600) + 1 });
  Object.assign(T.spectateArgs, { replay: dir, 'no-record': true });
  const match = quiet(() => new T.Match());
  const init = clone(quiet(() => match.initMsg()));
  while (!match.game.over && match.game.t < scene.tick - 1) quiet(() => match.tick());
  const a = clone(quiet(() => match.snapshot()));
  quiet(() => match.tick());
  const b = clone(quiet(() => match.snapshot()));
  if (b.t < scene.tick) throw new Error(`scene ${scene.id}: the match ended at tick ${b.t}, before tick ${scene.tick}`);
  if (init.mapType !== scene.rules.mapType) throw new Error(`scene ${scene.id}: map type ${init.mapType}, expected ${scene.rules.mapType}`);
  if (scene.weather && !init.weatherOn) throw new Error(`scene ${scene.id}: weather ${scene.weather} is not on`);
  if (scene.weather && !Array.isArray(b.wx)) throw new Error(`scene ${scene.id}: the snapshot has no weather`);
  for (const t of scene.types || []) if (!b.buildings.some((q) => init.buildings[q[2]] === t)) throw new Error(`scene ${scene.id}: no ${t} at tick ${b.t}`);
  const cams = {};
  for (const s of scene.shots) cams[s.id] = cameraFor(s, { init, snap: b });
  const kinds = {};
  for (const q of b.buildings) kinds[init.buildings[q[2]]] = (kinds[init.buildings[q[2]]] || 0) + 1;
  return { init, snaps: [a, b], cams, info: { tick: b.t, buildings: kinds, units: b.units.length, wx: b.wx ?? null } };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// The golden file
export function envInfo(chrome, renderer = null) {
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  return { node: process.version, platform: process.platform, arch: process.arch, chrome: chrome ? `${chrome} | ${run(chrome, ['--version'])}` : 'unknown', renderer };
}

// pure: rec = golden file { pins: { id: { md5 } }, runs }, cur = { pins: { id: { md5 } }, env }. wantedIds: the pictures that were shot now (check judges only those).
export function comparePins(rec, cur, wantedIds = Object.keys(cur.pins || {})) {
  const problems = [], differ = [], missing = [], extra = [];
  const recPins = rec.pins || {}, curPins = cur.pins || {};
  if (!Object.keys(recPins).length) problems.push('no pictures recorded');
  for (const id of wantedIds) {
    if (!curPins[id]) { problems.push(`${id}: not shot now`); continue; }
    if (!recPins[id]) { missing.push(id); continue; }
    if (recPins[id].md5 !== curPins[id].md5) differ.push(id);
  }
  for (const id of Object.keys(curPins)) if (!wantedIds.includes(id)) extra.push(id);
  if (differ.length) problems.push(`${differ.length} of ${wantedIds.length} pictures differ: ${differ.slice(0, 20).join(', ')}${differ.length > 20 ? ', ...' : ''}`);
  if (missing.length) problems.push(`${missing.length} pictures are not in the record: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''}`);
  const envDiff = [];
  const last = (rec.runs || []).at(-1)?.env || rec.env || {};
  for (const k of ['platform', 'arch', 'chrome', 'renderer']) if (last[k] !== undefined && last[k] !== cur.env?.[k]) envDiff.push(`${k}: recorded "${last[k]}", now "${cur.env?.[k]}"`);
  return { ok: problems.length === 0, problems, differ, missing, extra, envDiff };
}

// pure: the golden file after a record: the older pictures stay, the shot ones are replaced, the run is added to the list
export function mergeGolden(old, shot, run) {
  const pins = { ...(old?.pins || {}) };
  for (const [id, p] of Object.entries(shot)) pins[id] = p;
  return { version: 1, pins: Object.fromEntries(Object.entries(pins).sort(([a], [b]) => (a < b ? -1 : 1))), runs: [...(old?.runs || []), run] };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Chrome side (all of it needs puppeteer-core and Chrome)
const RESEED = '(() => { let s = 0x2545f491; Math.random = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; s ^= s >>> 13; return (s >>> 0) / 4294967296; }; })()';

function serve(root, port = 0) {
  const RENDER = path.join(root, 'render');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname)));
    if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

const ignorable = (t) => /favicon|404 \(Not Found\)|Failed to load resource: the server responded with a status of 404/.test(t);

async function newPage(browser, [w, h], problems) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (['error', 'warning', 'warn'].includes(m.type()) && !ignorable(m.text())) problems.warnings.push(m.text()); });
  page.on('pageerror', (e) => problems.errors.push('pageerror ' + e.message));
  return page;
}

// one page of render/broadcast.html for a scene, then every picture of the scene in a fixed order (the sequence of renders is the same whatever is asked for)
async function shootScene(browser, base, scene, data, ask, outDir, problems, log) {
  const page = await newPage(browser, SIZES.view, problems);
  const got = {};
  try {
    await page.goto(`${base}/broadcast.html?capture=1&preset=yt&quality=live`, { waitUntil: 'load' });
    await page.waitForFunction('window.__bcReady === true', { timeout: 60000 });
    await page.evaluate(async (m) => { const h = window.__bcHooks; h.init(m); await h.ready; }, data.init);
    await page.addStyleTag({ content: '#stage > :not(#view){display:none!important}' }); // the scene only: no overlay
    await page.evaluate(RESEED);
    await page.evaluate((s) => window.__bcHooks.snap(s), data.snaps[0]);
    await page.evaluate((s) => window.__bcHooks.snap(s), data.snaps[1]);
    let n = 0;
    const frame = (c) => page.evaluate((cm, t) => window.__bcHooks.render(1, t, 1 / 30, cm), c, n++ / 30);
    for (let i = 0; i < scene.warm; i++) await frame(data.cams[scene.shots[0].id]);
    let hpNow = null;
    for (const shot of scene.shots) {
      const c = data.cams[shot.id];
      await page.evaluate((t) => { window.__rts.forceTier = t; }, shot.view === 'building' ? shot.tier : 0);
      if (shot.hp !== undefined || hpNow !== null) { // a damaged tower: the same snapshot with other hp, and back
        const s = clone(data.snaps[1]); s.ev = []; s.dead = []; // the events of this tick were played with the first snapshot; a repeat must not play them again
        if (shot.hp !== undefined) { const ti = data.init.buildings.indexOf(shot.type); for (const b of s.buildings) if (b[2] === ti) b[5] = shot.hp; }
        hpNow = shot.hp !== undefined ? shot.hp : null;
        await page.evaluate((x) => window.__bcHooks.snap(x), s);
      }
      for (let i = 0; i < 6; i++) await frame(c);
      if (!ask.has(shot.id)) continue;
      const file = path.join(outDir, `${shot.id}.png`);
      await page.screenshot({ path: file, type: 'png' });
      got[shot.id] = { group: shot.group, md5: md5(fs.readFileSync(file)), size: SIZES.view, scene: scene.id, view: shot.view, cam: c };
    }
    const renderer = await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'), e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown'; });
    return { got, renderer };
  } finally { await page.close(); }
}

async function shootFlat(browser, base, pin, outDir, problems) {
  const page = await newPage(browser, pin.size, problems);
  try {
    const qs = new URLSearchParams(pin.query);
    if (pin.kind === 'sheet') {
      await page.goto(`${base}/units-preview.html?${qs}`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.title === 'ready', { timeout: 60000 });
      const tris = await page.evaluate((t) => window.__prev.set({ t }), pin.t);
      const file = path.join(outDir, `${pin.id}.png`);
      await page.screenshot({ path: file, type: 'png' });
      return { group: pin.group, md5: md5(fs.readFileSync(file)), size: pin.size, ...pin.meta, tris };
    }
    await page.goto(`${base}/assets-preview.html?${qs}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__done === true', { timeout: 60000 });
    const file = path.join(outDir, `${pin.id}.png`);
    await page.screenshot({ path: file, type: 'png' });
    return { group: pin.group, md5: md5(fs.readFileSync(file)), size: pin.size, ...pin.meta };
  } finally { await page.close(); }
}

// Shoots the planned pictures. Returns { pins: { id: { md5, ... } }, env, problems }
export async function shootPins({ root = HERE, plan, outDir, log = console.log }) {
  const T = await loadTools(root);
  const { hasChrome, hasPuppeteer, chromePath, angleArgs, puppeteerDir } = T.video;
  if (!hasChrome() || !hasPuppeteer()) throw new Error(`shots-pins: needs Chrome and puppeteer-core (have: chrome ${hasChrome()}, puppeteer ${hasPuppeteer()})`);
  fs.mkdirSync(outDir, { recursive: true });
  const problems = { errors: [], warnings: [] };
  const pins = {};
  let renderer = null;
  const { srv, base } = await serve(root);
  const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
  const [w, h] = SIZES.view;
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: [...angleArgs(), '--ignore-gpu-blocklist', '--no-sandbox', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', `--window-size=${w},${h}`] });
  try {
    const askIds = new Set(plan.pins.map((p) => p.id));
    for (const pin of plan.pins.filter((p) => p.kind !== 'shot')) { pins[pin.id] = await shootFlat(browser, base, pin, outDir, problems); log(`  ${pin.id}`); }
    for (const scene of plan.scenes) {
      if (!scene.shots.some((s) => askIds.has(s.id))) continue;
      log(`scene ${scene.id}: ${scene.bots.join(' vs ')}, ${scene.rules.mapType}${scene.weather ? ', ' + scene.weather : ''}, tick ${scene.tick}`);
      const data = await sceneData(scene, T);
      const r = await shootScene(browser, base, scene, data, askIds, outDir, problems, log);
      Object.assign(pins, r.got); renderer = r.renderer;
      log(`  ${Object.keys(r.got).length} pictures (${Object.keys(r.got).join(' ')})`);
    }
  } finally { await browser.close(); srv.close(); }
  const env = envInfo(chromePath(), renderer);
  return { pins, env, problems, outDir };
}

// record | check
export async function runPins(mode, { root = HERE, file = goldenFile(), groups = null, only = null, outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-pins-')), log = console.log, force = false } = {}) {
  if (mode !== 'record' && mode !== 'check' && mode !== 'shoot') throw new Error(`shots-pins: mode must be shoot, record or check, got "${mode}"`);
  if (mode === 'record' && !force && fs.existsSync(path.join(root, 'render/theme/theme-loader.mjs'))) throw new Error(`shots-pins: ${root} has the theme code (render/theme/theme-loader.mjs). The pins of the OLD look are recorded on the original tree (--root <original-checkout>); --force records here anyway.`);
  if (mode === 'check' && !fs.existsSync(file)) throw new Error(`shots-pins: no record at ${file}. Run "record" on the original tree first.`);
  const plan = planPins({ root, groups, only });
  if (!plan.pins.length) throw new Error('shots-pins: no picture selected');
  log(`shots-pins ${mode}: ${plan.pins.length} pictures from ${root} -> ${outDir}`);
  const cur = await shootPins({ root, plan, outDir, log });
  for (const e of cur.problems.errors) log('  PAGE ERROR ' + e);
  if (cur.problems.warnings.length) log(`  page warnings: ${[...new Set(cur.problems.warnings)].slice(0, 8).join(' | ')}`);
  const fatal = cur.problems.errors.length > 0 || cur.problems.warnings.some((x) => /model load failed/.test(x));
  const ids = plan.pins.map((p) => p.id);
  if (mode === 'shoot') { log(`shots-pins shoot: ${ids.length} pictures in ${outDir}`); return { ok: !fatal, outDir }; }
  if (mode === 'record') {
    if (fatal) throw new Error('shots-pins: the page reported errors, nothing recorded (a pin of a broken picture proves nothing)');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let old = null;
    if (fs.existsSync(file)) { old = JSON.parse(fs.readFileSync(file, 'utf8')); fs.renameSync(file, `${file}.${Math.floor(fs.statSync(file).mtimeMs)}.old`); } // never delete, keep the older record
    const run = { at: new Date().toISOString(), root, groups: groups || GROUPS, pictures: ids.length, env: cur.env, simVersion: simVersionOf(root) };
    fs.writeFileSync(file, JSON.stringify(mergeGolden(old, cur.pins, run), null, 2) + '\n');
    log(`shots-pins record: ${ids.length} pictures recorded -> ${file}`);
    return { ok: true, file, outDir };
  }
  const res = comparePins(JSON.parse(fs.readFileSync(file, 'utf8')), { pins: cur.pins, env: cur.env }, ids);
  log(`shots-pins check: ${ids.length} pictures checked: ${res.ok && !fatal ? 'IDENTICAL' : 'DIFFERENT'}`);
  for (const p of res.problems) log('  ' + p);
  if (res.envDiff.length) log('  environment differs (a pixel difference may not come from the code):\n    ' + res.envDiff.join('\n    '));
  if (!res.ok || fatal) log(`  new pictures are in ${outDir}`);
  return { ...res, ok: res.ok && !fatal, file, outDir };
}

function simVersionOf(root) {
  try { return JSON.parse(execFileSync(process.execPath, ['-e', "import('./sim-versions/lib.mjs').then((m)=>console.log(JSON.stringify(m.currentSimVersion({fresh:true}))))"], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}

// verify: every scene in Node (sim only), no Chrome
export async function verifyScenes({ root = HERE, groups = null, only = null, log = console.log } = {}) {
  const plan = planPins({ root, groups, only });
  const T = await loadTools(root);
  const ask = new Set(plan.pins.map((p) => p.id));
  const problems = [];
  for (const scene of plan.scenes) {
    if (!scene.shots.some((s) => ask.has(s.id))) continue;
    try {
      const d = await sceneData(scene, T);
      const types = Object.keys(d.info.buildings).sort();
      log(`${scene.id}: tick ${d.info.tick}, ${scene.rules.mapType}${scene.weather ? ' ' + scene.weather : ''}, ${scene.shots.length} pictures, ${d.info.units} units, ${types.length} building types${scene.weather ? ', wx ' + JSON.stringify(d.info.wx) : ''}`);
      for (const s of scene.shots.filter((x) => ask.has(x.id))) { const c = d.cams[s.id]; if (![c.tx, c.tz, c.dist].every(Number.isFinite) || c.tx < 0 || c.tz < 0 || c.tx > d.init.size || c.tz > d.init.size) problems.push(`${s.id}: camera outside the map ${JSON.stringify(c)}`); }
    } catch (e) { problems.push(`${scene.id}: ${e.message}`); log(`${scene.id}: FAILED ${e.message}`); }
  }
  return { ok: problems.length === 0, problems, pictures: plan.pins.length };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
function parse(argv) {
  const A = { _: [] };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) A[a.slice(2)] = true; else { A[a.slice(2)] = n; i++; } } else A._.push(a); }
  return A;
}
const USAGE = 'usage: node tools/shots-pins.mjs list|verify|shoot|record|check [--group units,buildings,ground,nature,light] [--only id,prefix*] [--root tree] [--file f.json] [--out dir] [--force]';

async function main() {
  const A = parse(process.argv.slice(2)), mode = A._[0];
  if (!['list', 'verify', 'shoot', 'record', 'check'].includes(mode)) { console.error(USAGE); process.exit(2); }
  const root = A.root ? path.resolve(String(A.root).replace(/^~(?=$|\/)/, os.homedir())) : HERE;
  const groups = splitList(A.group), only = splitList(A.only);
  try {
    if (mode === 'list') {
      const plan = planPins({ root, groups, only });
      const by = {};
      for (const p of plan.pins) (by[p.group] ||= []).push(p.id);
      for (const g of GROUPS) if (by[g]) console.log(`${g} (${by[g].length}): ${by[g].join(' ')}`);
      console.log(`${plan.pins.length} pictures in ${plan.scenes.filter((s) => s.shots.some((x) => plan.pins.some((p) => p.id === x.id))).length} scenes`);
      process.exit(0);
    }
    try { os.setPriority(0, 10); } catch { /* nice */ }
    if (mode === 'verify') { const r = await verifyScenes({ root, groups, only }); for (const p of r.problems) console.error('PROBLEM ' + p); console.log(r.ok ? `verify: ${r.pictures} pictures, every scene builds` : 'verify: FAILED'); process.exit(r.ok ? 0 : 1); }
    const r = await runPins(mode, { root, groups, only, file: A.file ? path.resolve(A.file) : goldenFile(), outDir: A.out ? path.resolve(A.out) : undefined, force: !!A.force });
    process.exit(r.ok ? 0 : 1);
  } catch (e) { console.error(e.message); process.exit(2); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
