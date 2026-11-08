#!/usr/bin/env node
// Checks a theme folder (render/assets/themes/<id>-vN/) against the contract THEME-VERTRAG.md:
// schema of theme.json, sim ids, provenance fields (generator, prompt, seed, license, credits, sha256), the files themselves
// (glb: material names body/team, triangle budget, scale, origin, anchors; atlas size; sound format) and the unlisted files.
//   node tools/theme-check.mjs <theme-id | folder> [more ...] [--strict] [--json]
//   node tools/theme-check.mjs --all [--strict]
// Exit code 0 = no errors (warnings and info are fine), 1 = errors, 2 = usage error or unreadable folder.
// --strict is the release gate: placeholders and an unverified name check count as errors.
// Licences never block (the owner decides): a licence text is only listed as info when it says it is still to be verified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UNITS, BUILDINGS, TECHS } from '../sim/data.mjs';
import {
  validateTheme, parseThemeId, scaleOf, triMaxOf, SCALE_TOLERANCE, ORIGIN_TOLERANCE, LOD_RATIO, ATLAS_MAX, BANNER_BUILDINGS, MATERIALS, KINDS,
  NATURE_CLASS, NATURE_TRI_MAX, NATURE_SCALE, PROJECTILE_TRI_MAX, TEXTURE_SIZES, TREE_GROUPS, NODE_KINDS, RESOURCES,
} from '../render/theme/theme-schema.mjs';
import { glbStats, pngSize, imageSize, oggInfo } from './lib/glb-stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const THEMES_DIR = path.join(ROOT, 'render/assets/themes');
const UNITS_DIR = path.join(ROOT, 'render/assets/models/units');
const AUDIO_DIR = path.join(ROOT, 'render/assets/audio');

// What the schema needs to know about the game: the sim ids, which types shoot or attack, the tech ids, the clip names the renderer plays, the sound events of the manifest.
export function simCatalog(unitsDir = UNITS_DIR, audioDir = AUDIO_DIR) {
  const units = {}, buildings = {}, techs = Object.fromEntries(Object.keys(TECHS).map((k) => [k, {}]));
  for (const [k, u] of Object.entries(UNITS)) units[k] = { shoots: u.projectile !== undefined, attacks: u.atk > 0 || !!u.charge };
  for (const [k, b] of Object.entries(BUILDINGS)) buildings[k] = { shoots: !!b.attack, attacks: !!b.attack };
  let clipKeys, baked = {}, rigs = null, soundEvents;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(unitsDir, 'UNITS.json'), 'utf8'));
    baked = Object.fromEntries(Object.entries(reg.families).map(([f, v]) => [f, Object.keys(v.clips)]));
    clipKeys = [...new Set(Object.values(baked).flat())];
    rigs = Object.keys(reg.units);
  } catch { /* no registry: clip names are only checked for their shape, rig keys are not looked up */ }
  try { soundEvents = Object.keys(JSON.parse(fs.readFileSync(path.join(audioDir, 'manifest.json'), 'utf8')).events); } catch { /* no manifest: event ids are only checked for their shape */ }
  return { units, buildings, techs, clipKeys, baked, rigs, soundEvents };
}

const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const canon = (m) => String(m).toLowerCase();
const pct = (x) => `${(x * 100).toFixed(1)} %`;

// Which glb file belongs to which slot and in which role.
// Units and buildings: { kind: 'units'|'buildings', type, role, index, slot, model }. Nature models: { kind: 'nature', type: 'trees.conifer', role, index, cls, name, section, model }.
function usageOf(theme) {
  const use = new Map();
  for (const kind of KINDS) for (const [type, s] of Object.entries(theme[kind] && typeof theme[kind] === 'object' && !Array.isArray(theme[kind]) ? theme[kind] : {})) {
    const m = s?.model;
    const add = (file, role, index = 0) => { if (typeof file === 'string' && !use.has(file)) use.set(file, { kind, type, role, index, slot: s, model: m || null }); };
    if (s?.projectile?.mesh) add(s.projectile.mesh, 'projectile'); // (a slot may carry a projectile mesh without a model of its own)
    if (!m || typeof m !== 'object') continue;
    add(m.file, 'base');
    (m.lods || []).forEach((f, i) => add(f, 'lod', i + 1));
    (m.tiers || []).forEach((f, i) => add(f, 'tier', i + 2));
    (m.damage || []).forEach((f, i) => add(f, 'damage', i + 1));
    (m.damage_t2 || []).forEach((f, i) => add(f, 'damage', i + 1));
    (m.damage_t3 || []).forEach((f, i) => add(f, 'damage', i + 1));
    if (typeof m.atlas === 'string') use.set(m.atlas, { kind, type, role: 'atlas', index: 0, slot: s, model: m });
  }
  // nature: trees (and their per-map refinements), deco, nodes, objects, carry
  const isO = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const entry = (e, section, name, cls) => {
    if (!isO(e) || typeof e.file !== 'string') return;
    const base = { kind: 'nature', type: `${section}.${name}`, cls, name, section, model: e, slot: null };
    if (!use.has(e.file)) use.set(e.file, { ...base, role: 'base', index: 0 });
    (Array.isArray(e.lods) ? e.lods : []).forEach((f, i) => { if (typeof f === 'string' && !use.has(f)) use.set(f, { ...base, role: 'lod', index: i + 1 }); });
    if (typeof e.atlas === 'string' && !use.has(e.atlas)) use.set(e.atlas, { ...base, role: 'atlas', index: 0 });
  };
  const nat = isO(theme.nature) ? theme.nature : {};
  const trees = (t) => { for (const g of TREE_GROUPS) for (const e of Array.isArray(t?.[g]) ? t[g] : []) entry(e, 'trees', g, NATURE_CLASS.trees[g]); };
  if (isO(nat.trees)) { trees(nat.trees); if (isO(nat.trees.maps)) for (const m of Object.values(nat.trees.maps)) trees(m); }
  if (isO(nat.deco)) for (const [g, list] of Object.entries(nat.deco)) for (const e of Array.isArray(list) ? list : []) entry(e, 'deco', g, NATURE_CLASS.deco[g]);
  if (isO(nat.nodes)) for (const [k, v] of Object.entries(nat.nodes)) for (const e of Array.isArray(v?.states) ? v.states : []) entry(e, 'nodes', k, NATURE_CLASS.nodes[k]);
  for (const sec of ['objects', 'carry']) if (isO(nat[sec])) for (const [k, e] of Object.entries(nat[sec])) entry(e, sec, k, NATURE_CLASS[sec][k]);
  return use;
}

function checkMaterials(st, where, out) {
  const names = st.materials;
  const seen = new Map();
  for (const n of names) {
    const c = canon(n);
    if (c !== MATERIALS.body && c !== MATERIALS.team) out.err(where, `material "${n}": only "${MATERIALS.body}" and "${MATERIALS.team}" are allowed (white team areas in the team material, everything else in body)`);
    else if (seen.has(c)) out.err(where, `two materials named "${seen.get(c)}" and "${n}": exactly one ${c} material`);
    else seen.set(c, n);
  }
  if (!seen.has(MATERIALS.body)) out.err(where, 'no "body" material');
  if (!seen.has(MATERIALS.team)) out.err(where, 'no "team" material (the team colour is tinted on it; STIL.md "Team colour")');
}

// A projectile mesh (projectile.mesh, THEME-VERTRAG.md 6.4): points along +Z, centred on the origin along its flight axis, at most PROJECTILE_TRI_MAX triangles, no team material.
// The game scales it so that its z extent is the `length` of the slot, so the size in the file does not matter.
function checkProjectileMesh(st, where, out) {
  if (st.tris > PROJECTILE_TRI_MAX) out.err(where, `${st.tris} triangles, budget for a projectile mesh is ${PROJECTILE_TRI_MAX} (up to 400 shots are in the air at once)`);
  if (st.materials.some((m) => canon(m) === MATERIALS.team)) out.err(where, 'a projectile mesh has no "team" material (a shot has no owner colour)');
  const ex = st.max[0] - st.min[0], ey = st.max[1] - st.min[1], ez = st.max[2] - st.min[2];
  if (!(ez >= 0.9 * Math.max(ex, ey))) out.err(where, `the longest side must lie along +Z (the flight direction): extents x ${ex.toFixed(3)}, y ${ey.toFixed(3)}, z ${ez.toFixed(3)}`);
  else if (ez < 1.5 * Math.max(ex, ey)) out.warn(where, `the mesh is only ${(ez / Math.max(ex, ey, 1e-9)).toFixed(1)} times longer than wide: a shot is slim (the game stretches it to the length of the slot)`);
  const mid = (st.min[2] + st.max[2]) / 2;
  if (ez > 0 && Math.abs(mid) > 0.25 * ez) out.warn(where, `the middle of the mesh is ${mid.toFixed(3)} from the origin along z: centre it on the flight axis`);
}

// A nature model (tree, deco, resource node, object, carry item): triangle budget of its class (error), on the ground (error above 0.1, warning above 0.03), size range (warning).
function checkNatureGlb(st, u, where, out) {
  const max = NATURE_TRI_MAX[u.cls];
  if (max === undefined) out.warn(where, `no triangle budget for ${u.type} in the schema`);
  else if (st.tris > max) out.err(where, `${st.tris} triangles, budget for ${u.type} (${u.cls}) is ${max} (SKALA.md "Poly budgets used")`);
  if (!st.materials.length) out.warn(where, 'the model has no material');
  if (u.section !== 'objects' && st.materials.some((m) => canon(m) === MATERIALS.team)) out.warn(where, 'a "team" material on a nature model: it is tinted with an owner colour, but nature has no owner (only the shrine does)');
  if (u.role === 'lod') return;
  const low = Math.abs(st.min[1]);
  if (low > 0.1) out.err(where, `lowest vertex is at y=${st.min[1].toFixed(3)}: the origin must be the ground (the model is seated on the terrain)`);
  else if (low > ORIGIN_TOLERANCE) out.warn(where, `lowest vertex is at y=${st.min[1].toFixed(3)} (ground expected within +-${ORIGIN_TOLERANCE})`);
  const sc = NATURE_SCALE[u.section]?.[u.name];
  if (sc) {
    const got = sc[0] === 'height' ? st.height985 : st.extent;
    if (got < sc[1] * 0.9 || got > sc[2] * 1.1) out.warn(where, `${sc[0] === 'height' ? 'height (98.5 % of the vertices)' : 'longest horizontal extent'} is ${got.toFixed(3)} tiles, SKALA.md and the classic models say ${sc[1]} to ${sc[2]} for ${u.type} (guidance, not a rule)`);
  }
}

function checkGlb(file, rel, u, out) {
  const where = `assets["${rel}"]`;
  let st;
  try { st = glbStats(file); } catch (e) { out.err(where, `cannot read the glb: ${e.message}`); return null; }
  if (st.empty) { out.err(where, 'the glb has no triangles'); return null; }
  if (st.nonTriangles) out.warn(where, `${st.nonTriangles} primitive(s) are not triangle lists and were not counted`);
  if (st.approx) out.info(where, 'compressed glb: triangle count is exact, the size is taken from the accessor bounds');
  if (u.role === 'projectile') { checkProjectileMesh(st, where, out); return st; }
  if (u.kind === 'nature') { checkNatureGlb(st, u, where, out); return st; }
  checkMaterials(st, where, out);
  const max = triMaxOf(u.kind, u.type);
  if (max === null) out.warn(where, `no triangle budget for ${u.type} in the schema (SKALA.md has no line for it)`);
  else if (st.tris > max) out.err(where, `${st.tris} triangles, budget for ${u.type} is ${max} (SKALA.md "Poly budgets used")`);
  const sc = scaleOf(u.kind, u.type);
  if (!sc) out.warn(where, `no scale entry for ${u.type} in the schema (SKALA.md has no line for it): size not checked`);
  else {
    const got = sc.measure === 'height' ? st.height985 : st.extent;
    const dev = got / sc.tiles - 1;
    const label = sc.measure === 'height' ? 'height (98.5 % of the vertices)' : 'longest horizontal extent';
    if (Math.abs(dev) > SCALE_TOLERANCE) {
      const msg = `${label} is ${got.toFixed(3)} tiles, SKALA.md says ${sc.tiles}${sc.derived ? ` (${sc.derived})` : ''}: ${dev > 0 ? '+' : ''}${pct(dev)}, allowed +-${pct(SCALE_TOLERANCE)}`;
      u.role === 'lod' ? out.warn(where, msg) : out.err(where, msg);
    }
  }
  if (u.role !== 'lod') {
    if (Math.abs(st.min[1]) > ORIGIN_TOLERANCE) out.err(where, `lowest vertex is at y=${st.min[1].toFixed(3)}: the origin must be the ground centre (+-${ORIGIN_TOLERANCE})`);
    const off = Math.hypot(...st.centre), lim = Math.max(0.15, 0.05 * st.extent);
    if (off > lim) out.warn(where, `the horizontal centre is ${off.toFixed(2)} tiles from the origin (ground centre expected)`);
  }
  return st;
}

export function checkTheme(dir, { strict = false, unitsDir = UNITS_DIR } = {}) {
  const out = { errors: [], warnings: [], notes: [], err(p, m) { this.errors.push({ path: p, message: m }); }, warn(p, m) { this.warnings.push({ path: p, message: m }); }, info(p, m) { this.notes.push({ path: p, message: m }); } };
  const result = { dir, id: path.basename(dir), hash: null, theme: null, ...out };
  const fail = (msg) => { out.err('', msg); return result; };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return fail(`${dir} is not a folder`);
  const tfile = path.join(dir, 'theme.json');
  if (!fs.existsSync(tfile)) return fail('theme.json is missing');
  const text = fs.readFileSync(tfile, 'utf8');
  result.hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  let theme;
  try { theme = JSON.parse(text); } catch (e) { return fail(`theme.json is not valid JSON: ${e.message}`); }
  result.theme = theme;

  const folder = path.basename(dir), pid = parseThemeId(folder);
  if (!pid) out.err('', `the folder name "${folder}" must be <id>-v<number>, like dustmoon-v1`);
  else if (theme && (`${theme.id}-v${theme.version}` !== pid.folder)) out.err('', `the folder is ${folder} but theme.json says ${theme.id}-v${theme.version}`);

  const cat = simCatalog(unitsDir);
  const rep = validateTheme(theme, { units: cat.units, buildings: cat.buildings, techs: cat.techs, soundEvents: cat.soundEvents, clipKeys: cat.clipKeys, strict });
  for (const e of rep.errors) out.err(e.path, e.message);
  for (const w of rep.warnings) out.warn(w.path, w.message);

  const assets = theme && typeof theme.assets === 'object' && theme.assets && !Array.isArray(theme.assets) ? theme.assets : {};
  const usage = usageOf(theme || {});
  const files = new Set(walk(dir).filter((f) => f !== 'theme.json' && !f.split('/').some((p) => p.startsWith('.'))));

  // files that nobody listed: no provenance
  for (const f of files) if (!assets[f]) out.err(f, 'file is not listed in assets (every file needs generator, prompt, seed, license, credits, sha256)');

  // Stereo is right for a sound the engine does not place in the world (ambience beds, music, fanfares, stings, alerts: manifest `spatial: false`; SOUND.md: stereo for loops, music, fanfares and stings); only a positioned one-shot must be mono. The files of such events (theme.event_sounds) are not warned about.
  const unplaced = new Set();
  try {
    const mev = JSON.parse(fs.readFileSync(path.join(AUDIO_DIR, 'manifest.json'), 'utf8')).events;
    const es = theme && typeof theme.event_sounds === 'object' && theme.event_sounds ? theme.event_sounds : {};
    for (const [ev, v] of Object.entries(es)) if (mev[ev] && mev[ev].spatial === false) for (const f of [].concat(v)) if (typeof f === 'string') unplaced.add(f);
  } catch { /* no manifest: every stereo file is warned about, as before */ }

  // the manifest entries against the files
  let placeholders = 0, finals = 0;
  const stats = new Map();
  for (const [rel, a] of Object.entries(assets)) {
    if (!a || typeof a !== 'object') continue;
    const where = `assets["${rel}"]`, abs = path.join(dir, rel);
    const there = files.has(rel);
    if (a.status === 'placeholder') placeholders++;
    if (a.status === 'final') finals++;
    if (typeof a.license === 'string' && /to verify|unverified|todo|unknown/i.test(a.license)) out.info(where, `licence still to be verified: "${a.license}" (info only, a licence never blocks)`);
    if (!there) {
      if (a.status === 'final') out.err(where, 'status is final but the file is not in the folder');
      else if (a.status === 'placeholder') out.info(where, 'placeholder: file not delivered yet, the game uses classic for it');
      continue;
    }
    if (typeof a.sha256 === 'string') { const got = sha256File(abs); if (got !== a.sha256) out.err(where, `sha256 does not match the file (file ${got.slice(0, 16)}..., manifest ${a.sha256.slice(0, 16)}...): a delivered file is never edited, make a new theme version`); }
    const u = usage.get(rel);
    if (a.kind === 'model') {
      if (!u) { try { glbStats(abs); } catch (e) { out.err(where, `cannot read the glb: ${e.message}`); } continue; }
      const st = checkGlb(abs, rel, u, out);
      if (st) stats.set(rel, st);
    } else if (a.kind === 'atlas') {
      const sz = pngSize(abs);
      if (!sz) { out.err(where, 'not a PNG file'); continue; }
      const lim = u?.kind === 'nature' ? ATLAS_MAX.units : ATLAS_MAX[u?.kind || 'units'];
      if (sz.width > lim || sz.height > lim) out.err(where, `atlas is ${sz.width}x${sz.height}, the limit is ${lim}x${lim} (SKALA.md)`);
      else if (sz.width !== sz.height) out.warn(where, `atlas is ${sz.width}x${sz.height}, square expected`);
    } else if (a.kind === 'sprite') {
      if (!pngSize(abs)) out.err(where, 'not a PNG file');
    } else if (a.kind === 'texture') {
      const sz = imageSize(abs);
      if (!sz) out.err(where, 'not a PNG or JPEG file');
      else if ((sz.format === 'jpeg') !== /\.jpe?g$/.test(rel)) out.err(where, `the file is a ${sz.format.toUpperCase()} but is named .${rel.split('.').pop()}`);
      else if (sz.width > 2048 || sz.height > 2048) out.err(where, `texture is ${sz.width}x${sz.height}, the limit is 2048x2048`);
      else if (sz.width !== sz.height || !TEXTURE_SIZES.includes(sz.width)) out.warn(where, `texture is ${sz.width}x${sz.height}: a tiling ground texture is square with ${TEXTURE_SIZES.join(', ')} pixels per side (the classic ones are 512)`);
    } else if (a.kind === 'sound') {
      const o = oggInfo(abs);
      if (!o) out.err(where, 'not an Ogg file (OGG/Opus, 48 kHz, mono for one-shots; SOUND.md)');
      else if (!o.opus) out.err(where, 'Ogg file without an Opus stream (OGG/Opus expected)');
      else if (o.channels !== 1 && !unplaced.has(rel)) out.warn(where, `${o.channels} channels: one-shot sounds are mono (SOUND.md)`);
    }
  }

  // relations between the files of one slot: LOD order, tier footprint, anchors
  for (const [rel, u] of usage) {
    if (u.role !== 'base' || !stats.has(rel)) continue;
    const base = stats.get(rel), m = u.model;
    let prev = base.tris;
    (m.lods || []).forEach((f, i) => {
      const st = stats.get(f);
      if (!st) return;
      if (st.tris >= prev) out.err(`assets["${f}"]`, `LOD${i + 1} has ${st.tris} triangles, the level before has ${prev}: every LOD is smaller`);
      const [lo, hi] = LOD_RATIO[`lod${i + 1}`], ratio = st.tris / base.tris;
      if (ratio < lo || ratio > hi) out.warn(`assets["${f}"]`, `LOD${i + 1} is ${pct(ratio)} of LOD0 (the pipeline aims for ${pct(lo)} to ${pct(hi)})`);
      prev = st.tris;
    });
    if (!u.slot) continue; // (a nature model has no anchors)
    const names = new Set([...base.nodeNames, ...base.meshNames]);
    if (u.slot.muzzle?.anchor === 'muzzle_anchor' && !names.has('muzzle_anchor')) out.err(`assets["${rel}"]`, 'muzzle.anchor is "muzzle_anchor" but the model has no node of that name');
    if (u.kind === 'buildings' && BANNER_BUILDINGS.includes(u.type) && ![...names].some((n) => /^banner_slot_\d+$/.test(n))) out.warn(`assets["${rel}"]`, 'no banner_slot_N node (creator banners need one; STIL.md "Creator-banner slots")');
  }

  // rig keys (units.<id>.model.rig): the baked game copy of a delivered model (package R5: <rig>_0.bin, <rig>.anim, <rig>.jpg and an entry in UNITS.json)
  for (const [type, s] of Object.entries(theme?.units && typeof theme.units === 'object' ? theme.units : {})) {
    const rig = s?.model?.rig, where = `units.${type}.model.rig`;
    if (typeof rig !== 'string') continue;
    const delivered = assets[s.model.file]?.status === 'final', inRegistry = cat.rigs ? cat.rigs.includes(rig) : null;
    if (inRegistry === null) out.info(where, `the registry (render/assets/models/units/UNITS.json) cannot be read: the rig "${rig}" was not looked up`);
    else if (!inRegistry) {
      const msg = `the rig "${rig}" is not in the registry (render/assets/models/units/UNITS.json): the rig fit (R5) has not baked it, the game shows the classic figure`;
      if (!delivered) out.info(where, `${msg}; the model file is still a placeholder`);
      else if (strict) out.err(where, msg);
      else out.warn(where, msg);
    } else for (const ext of ['_0.bin', '.anim', '.jpg']) {
      if (!fs.existsSync(path.join(unitsDir, rig + ext))) out.err(where, `the registry names the rig "${rig}" but the baked file ${rig + ext} is missing`);
    }
  }

  // the name check of the new names is still open
  if (theme?.legal?.name_check?.status === 'unverified') out.info('legal.name_check', 'name check not done yet (to verify, SPEC.md line 6); fine for a slice, not for a release');
  out.info('', `${Object.keys(assets).length} assets: ${finals} final, ${placeholders} placeholder; theme.json hash ${result.hash}`);
  return result;
}

const fmt = (list, tag) => list.map((p) => `${tag} ${p.path ? p.path + ': ' : ''}${p.message}`);
export function report(res) {
  const lines = [...fmt(res.errors, 'ERROR'), ...fmt(res.warnings, 'warn '), ...fmt(res.notes, 'info ')];
  lines.push(`theme-check ${res.id}: ${res.errors.length} error(s), ${res.warnings.length} warning(s) -> ${res.errors.length ? 'FAILED' : 'OK'}`);
  return lines.join('\n');
}

export function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--')), flag = (f) => argv.includes(f);
  let targets = args;
  if (flag('--all')) targets = fs.existsSync(THEMES_DIR) ? fs.readdirSync(THEMES_DIR).filter((d) => parseThemeId(d)).sort().map((d) => path.join(THEMES_DIR, d)) : [];
  if (!targets.length) { console.error('usage: node tools/theme-check.mjs <theme-id | folder> [more ...] [--strict] [--json]   or   --all'); return 2; }
  let code = 0;
  const all = [];
  for (const t of targets) {
    const dir = fs.existsSync(t) ? path.resolve(t) : path.join(THEMES_DIR, t);
    const res = checkTheme(dir, { strict: flag('--strict') });
    all.push({ id: res.id, hash: res.hash, errors: res.errors, warnings: res.warnings, info: res.notes });
    if (!flag('--json')) console.log(report(res));
    if (res.errors.length) code = Math.max(code, res.errors.some((e) => e.message.endsWith('is not a folder') || e.message === 'theme.json is missing') ? 2 : 1);
  }
  if (flag('--json')) console.log(JSON.stringify(all, null, 1));
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
