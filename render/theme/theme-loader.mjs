// Theme loader: reads render/assets/themes/<id>-vN/theme.json (an immutable folder), checks it against the schema and gives
// the renderer one frozen Theme object per match. Whatever the theme does not provide falls back to classic, slot by slot,
// field by field, file by file. Without a theme (no ?theme=) nothing is fetched and classic is returned.
//
//   const theme = await loadThemeSafe(themeIdFromSearch(location.search));
//   theme.slot('units', 'archer')   // { name, plural, description, model|null, clips|null, projectile|null, ..., from: { name: 'theme', model: 'classic', ... } }
//   theme.slot('techs', 'wood_axe') // { name, plural, description, from } (words only)
//   theme.world('ground', 'desert') // the resolved ground / nature / light slot for a map type, or the event sound table ('event_sounds'); null = classic; files as urls, only the delivered ones
//   theme.describe()                // { id, hash, name } for the start line of a match (R2b)
//
// A theme belongs to a match, never to a player: no function here takes a player or an owner. Nothing here is random, and
// nothing here touches sim/ or the prompt: the model does not see the theme in phase 1 (plan B2).
import { validateTheme, parseThemeId, CLASSIC, SLOT_FIELDS, KINDS, TEXT_KINDS, WORLD_SLOTS, EVENT_SOUNDS, TREE_GROUPS, MAP_TYPES } from './theme-schema.mjs';
import { displayName, displayPlural, displayRole } from './display-name.mjs'; // R1: the one place that knows the classic words

export { CLASSIC, parseThemeId };

export class ThemeError extends Error {
  constructor(message, problems = []) { super(message); this.name = 'ThemeError'; this.problems = problems; }
}

export const DEFAULT_BASE = new URL('../assets/themes/', import.meta.url);

// ?theme=dustmoon-v1 -> 'dustmoon-v1'; no parameter -> 'classic'
export function themeIdFromSearch(search) {
  const v = new URLSearchParams(search || '').get('theme');
  return v ? v.trim() : CLASSIC;
}

// the classic words of a type (R1 display-name.mjs, theme 'classic'): the fallback of every text field
const R1_KIND = { units: 'unit', buildings: 'building', techs: 'tech' };
export const classicName = (type, kind) => displayName(R1_KIND[kind] || 'any', type, CLASSIC);
export const classicPlural = (type, kind) => displayPlural(R1_KIND[kind] || 'any', type, CLASSIC);
export const classicRole = (type, kind) => displayRole(R1_KIND[kind] || 'any', type, CLASSIC) || null;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// SHA-256 of a text (UTF-8), the same in the browser and in Node. Pure code on purpose: crypto.subtle does not exist on a page served over plain http from another machine.
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const ror = (x, n) => (x >>> n) | (x << (32 - n));
export function sha256Hex(text) {
  const msg = new TextEncoder().encode(text), len = msg.length;
  const buf = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  buf.set(msg); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor((len * 8) / 4294967296)); dv.setUint32(buf.length - 4, (len * 8) >>> 0);
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let i = 0; i < buf.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      w[t] = (w[t - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[t - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + w[t]) >>> 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + k].map((x) => x >>> 0);
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

// reads a text file from a file: URL (Node) or over http (browser)
export async function defaultReadText(url) {
  const u = new URL(url);
  if (u.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return readFile(u, 'utf8');
  }
  const res = await fetch(u);
  if (!res.ok) throw new ThemeError(`${u.pathname}: HTTP ${res.status}`);
  return res.text();
}

const frozenNone = (kind, type) => deepFreeze({ kind, type, source: 'classic', name: classicName(type, kind), plural: classicPlural(type, kind), description: classicRole(type, kind), model: null, clips: null, projectile: null, muzzle: null, hit: null, sound: null,
  from: Object.fromEntries(SLOT_FIELDS[kind].map((f) => [f, 'classic'])) });

export class Theme {
  constructor({ folder, base, json, hash, problem = null }) {
    this.isClassic = !json;
    this.id = json ? folder : CLASSIC;
    this.name = json ? json.name : 'Classic';
    this.version = json ? json.version : 0;
    this.status = json ? json.status : 'complete';
    this.hash = hash || null; // first 16 hex digits of the sha256 of theme.json (classic: null)
    this.key = json ? `${folder}@${this.hash}` : CLASSIC;
    this.base = json ? base : null;
    this.legal = json ? json.legal : null;
    this.problem = problem; // set when a theme was asked for and classic is used instead
    this._json = json ? deepFreeze(json) : null;
    this._cache = new Map();
    Object.freeze(this);
  }
  // { id, hash, name } for the start line and the observation of a match
  describe() { return { id: this.id, hash: this.hash, name: this.name }; }
  types(kind) { return this._json?.[kind] ? Object.keys(this._json[kind]) : []; }
  has(kind, type) { return !!this._json?.[kind]?.[type]; }
  // url of a file of this theme, or null when the asset is only a placeholder (not delivered yet) or unknown
  fileUrl(file) {
    const a = this._json?.assets?.[file];
    return a && a.status === 'final' ? new URL(file, this.base).href : null;
  }
  // The slot with every field resolved: the theme's value, or null = use classic (text always has a value). `from` says per field where it came from.
  slot(kind, type) {
    const key = `${kind}/${type}`;
    let s = this._cache.get(key);
    if (!s) { s = this._resolve(kind, type); this._cache.set(key, s); }
    return s;
  }
  // the words for a type: the theme's name (or plural), else classic. (R1's displayName() in display-name.mjs is the one every text should ask.)
  text(kind, type, plural = false) { const s = this.slot(kind, type); return plural ? s.plural : s.name; }
  // ---- the world slots (package C0): ground, nature, light and the table of event sounds. null = classic. Colours and numbers as written; a file only as a url and only when it is delivered
  // (a placeholder counts as missing, the rest of the slot is still used). mapType (meadow, forest, desert, winter, coast) applies the refinement `maps.<type>` of the theme over its base.
  world(name, mapType0 = null) {
    if (!WORLD_SLOTS.includes(name) && name !== EVENT_SOUNDS) return null;
    const mapType = name !== EVENT_SOUNDS && MAP_TYPES.includes(mapType0) ? mapType0 : null; // the event sounds have no map types; an unknown map type is the base
    const key = `world/${name}/${mapType || ''}`;
    if (!this._cache.has(key)) this._cache.set(key, this._resolveWorld(name, mapType));
    return this._cache.get(key);
  }
  // the effect colours of the theme (code package 2): the object `effects` as written ({ palette, sapper }), or null = classic. render/theme/fx-theme.mjs turns it into colours
  effects() { const e = this._json?.effects; return e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length ? e : null; }
  _resolveWorld(name, mapType) {
    const raw = this._json?.[name];
    if (!raw) return null;
    const m = mapType && raw.maps && Object.hasOwn(raw.maps, mapType) ? raw.maps[mapType] : null;
    const out = name === 'ground' ? this._ground(raw, m) : name === 'light' ? this._light(raw, m) : name === 'nature' ? this._nature(raw, mapType) : this._eventSounds(raw);
    return Object.keys(out).length ? deepFreeze(out) : null;
  }
  _ground(raw, m) {
    const out = {}, merge = (k) => ({ ...(raw[k] || {}), ...(m?.[k] || {}) });
    const palette = merge('palette'), water = merge('water'), textures = {};
    for (const [k, f] of Object.entries(merge('textures'))) { const u = this.fileUrl(f); if (u) textures[k] = u; }
    if (Object.keys(palette).length) out.palette = palette;
    if (Object.keys(textures).length) out.textures = textures;
    if (Object.keys(water).length) out.water = water;
    return out;
  }
  _light(raw, m) {
    const out = {};
    for (const k of ['sky', 'haze', 'sun', 'far']) { const v = { ...(raw[k] || {}), ...(m?.[k] || {}) }; if (Object.keys(v).length) out[k] = v; }
    if (raw.fill) out.fill = { ...raw.fill };
    if (raw.exposure !== undefined) out.exposure = raw.exposure;
    if (raw.weather) out.weather = Object.fromEntries(Object.entries(raw.weather).map(([k, v]) => [k, { ...v }]));
    return out;
  }
  // one nature model: the base file must be delivered (else null = classic for this model); a LOD list stops at the first look that is missing
  _entry(e) {
    const file = this.fileUrl(e?.file);
    if (!file) return null;
    const lods = []; for (const f of e.lods || []) { const u = this.fileUrl(f); if (!u) break; lods.push(u); }
    return { file, lods, atlas: e.atlas ? this.fileUrl(e.atlas) : null, weight: e.weight ?? 1, brightness: e.brightness ?? 1, scale: e.scale ?? 1, ...(Number.isInteger(e.rot) ? { rot: e.rot } : {}) }; // rot: objects only (quarter turns), absent for everything else
  }
  _entries(list) { return (list || []).map((e) => this._entry(e)).filter(Boolean); }
  _nature(raw, mapType) {
    const out = {};
    if (raw.trees) {
      const t = raw.trees, mt = mapType && t.maps && Object.hasOwn(t.maps, mapType) ? t.maps[mapType] : null, trees = {};
      for (const g of TREE_GROUPS) { const l = this._entries(mt?.[g] ?? t[g]); if (l.length) trees[g] = l; }
      const scale = mt?.scale ?? t.scale, second = mt?.second ?? t.second;
      if (scale) trees.scale = [...scale];
      if (second !== undefined) trees.second = second;
      if (Object.keys(trees).length) out.trees = trees;
    }
    if (raw.deco) {
      const deco = {};
      for (const [g, list] of Object.entries(raw.deco)) { const l = this._entries(list); if (l.length) deco[g] = l; }
      if (Object.keys(deco).length) out.deco = deco;
    }
    if (raw.nodes) { // the states of a resource node (full ... depleted) are all or nothing: a missing state would show the wrong stage
      const nodes = {};
      for (const [k, v] of Object.entries(raw.nodes)) { const st = (v.states || []).map((e) => this._entry(e)); if (st.length && st.every(Boolean)) nodes[k] = { states: st }; }
      if (Object.keys(nodes).length) out.nodes = nodes;
    }
    for (const k of ['objects', 'carry']) {
      if (!raw[k]) continue;
      const o = {};
      for (const [id, e] of Object.entries(raw[k])) { const x = this._entry(e); if (x) o[id] = x; }
      if (Object.keys(o).length) out[k] = o;
    }
    return out;
  }
  // event id -> the delivered variants (urls); an event none of whose files is delivered stays classic
  _eventSounds(raw) {
    const out = {};
    for (const [ev, v] of Object.entries(raw)) { const l = (Array.isArray(v) ? v : [v]).map((f) => this.fileUrl(f)).filter(Boolean); if (l.length) out[ev] = l; }
    return out;
  }
  _resolve(kind, type) {
    const raw = this._json?.[kind]?.[type];
    if (!raw) return frozenNone(kind, type);
    const out = { kind, type, source: 'theme', name: classicName(type, kind), plural: classicPlural(type, kind), description: classicRole(type, kind), model: null, clips: null, projectile: null, muzzle: null, hit: null, sound: null, from: {} };
    for (const f of SLOT_FIELDS[kind]) out.from[f] = 'classic';
    const use = (f, v) => { if (v !== null && v !== undefined) { out[f] = v; out.from[f] = 'theme'; } };
    if (raw.name !== undefined) { use('name', raw.name); use('plural', raw.plural ?? raw.name); use('description', raw.description); } // (a tech has no plural: the name stands for it, never a classic word)
    // model: the base file must be delivered, or the whole model falls back; a list stops at the first look that is not delivered
    const m = raw.model;
    if (m && this.fileUrl(m.file)) {
      const chain = (list) => { const o = []; for (const f of list || []) { const u = this.fileUrl(f); if (!u) break; o.push(u); } return o; };
      use('model', { file: this.fileUrl(m.file), lods: chain(m.lods), atlas: m.atlas ? this.fileUrl(m.atlas) : null, tiers: chain(m.tiers), damage: chain(m.damage), damage_t2: chain(m.damage_t2), damage_t3: chain(m.damage_t3), rot: Number.isInteger(m.rot) ? m.rot : 0, rig: typeof m.rig === 'string' ? m.rig : null });
    }
    if (raw.clips) use('clips', { ...raw.clips });
    if (raw.projectile && (raw.projectile.shape !== 'mesh' || this.fileUrl(raw.projectile.mesh))) {
      use('projectile', { ...raw.projectile, mesh: raw.projectile.mesh ? this.fileUrl(raw.projectile.mesh) : null });
    }
    for (const f of ['muzzle', 'hit']) {
      const e = raw[f];
      if (e && (e.fx !== 'sprite' || this.fileUrl(e.sprite))) use(f, { ...e, sprite: e.sprite ? this.fileUrl(e.sprite) : null });
    }
    if (raw.sound) {
      const snd = {};
      for (const [ev, file] of Object.entries(raw.sound)) { const u = this.fileUrl(file); if (u) snd[ev] = u; }
      if (Object.keys(snd).length) use('sound', snd);
    }
    out.source = Object.values(out.from).some((v) => v === 'theme') ? 'theme' : 'classic';
    return deepFreeze(out);
  }
}

let CLASSIC_THEME = null;
export function classicTheme(problem = null) {
  if (problem) return new Theme({ problem });
  return CLASSIC_THEME || (CLASSIC_THEME = new Theme({}));
}

// theme.json text -> Theme. `folder` is the folder name (<id>-vN) it was read from. ctx: see theme-schema.mjs validateTheme.
export async function buildTheme(text, { folder, base, ctx = {} }) {
  const p = parseThemeId(folder);
  if (!p) throw new ThemeError(`"${folder}" is not a theme folder name (<id>-v<number>, like dustmoon-v1)`);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new ThemeError(`${folder}/theme.json is not valid JSON: ${e.message}`); }
  const rep = validateTheme(json, ctx);
  if (rep.errors.length) throw new ThemeError(`${folder}/theme.json has ${rep.errors.length} problem(s): ${rep.errors[0].path || 'theme.json'}: ${rep.errors[0].message}`, rep.errors);
  if (`${json.id}-v${json.version}` !== p.folder) throw new ThemeError(`${folder}/theme.json says ${json.id}-v${json.version}: the folder name must be <id>-v<version>`);
  const hash = sha256Hex(text).slice(0, 16);
  return new Theme({ folder: p.folder, base: new URL(`${p.folder}/`, base), json, hash });
}

// Loads a theme or throws a ThemeError. 'classic' (or nothing) is the built-in theme and reads no file.
export async function loadTheme(id, { base = DEFAULT_BASE, readText = defaultReadText, ctx = {} } = {}) {
  if (!id || id === CLASSIC) return classicTheme();
  const p = parseThemeId(id);
  if (!p) throw new ThemeError(`"${id}" is not a theme id (<id>-v<number>, like dustmoon-v1, or classic)`);
  const root = new URL(base);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  const folderBase = new URL(`${p.folder}/`, root);
  let text;
  try { text = await readText(new URL('theme.json', folderBase)); } catch (e) { throw new ThemeError(`theme ${id} not found or not readable: ${e.message}`); }
  return buildTheme(text, { folder: p.folder, base: root, ctx });
}

// Never throws: a theme that cannot be loaded gives classic with `problem` set (the viewer keeps working, the match is not themed).
export async function loadThemeSafe(id, opts) {
  try { return await loadTheme(id, opts); } catch (e) {
    const msg = e instanceof ThemeError ? e.message : `theme ${id}: ${e?.message || e}`;
    if (typeof console !== 'undefined') console.warn('theme not used, classic instead:', msg);
    return classicTheme(msg);
  }
}

// One theme per match. The match owner binds the theme once; asking again with another theme is an error, so no part
// of a match can show a different theme than the rest (and no player gets his own).
export function createMatchTheme() {
  let bound = null;
  return {
    bind(theme) {
      if (bound && bound.key !== theme.key) throw new ThemeError(`this match already uses ${bound.key}; a match has exactly one theme (asked for ${theme.key})`);
      bound = theme;
      return bound;
    },
    get() { return bound || classicTheme(); },
  };
}

// ---- the read interface of the renderer hooks (R3 + R4: render/shooter-theme.mjs, render/units3d.mjs) ----
// getThemeSlot(theme, 'units.archer.projectile') -> the value of that slot, or undefined = classic for this slot.
// A loaded Theme answers with its resolved slots (a field the theme does not have, or whose file is only a placeholder, is undefined).
// A plain object is read too, nested ({ units: { archer: { ... } } }) or flat ({ slots: { 'units.archer.projectile': ... } }): the test themes of render/theme/placeholder-themes.mjs are plain objects.
const SLOT_ALIAS = { clip: 'clips' }; // the hooks of R3 spell the clip table `clip`; the schema field is `clips`
const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
export function getThemeSlot(theme, slotPath) {
  if (!theme || typeof slotPath !== 'string') return undefined;
  const parts = slotPath.split('.');
  if (theme instanceof Theme) {
    if (theme.isClassic) return undefined;
    const [kind, type, rawField, ...rest] = parts;
    if (WORLD_SLOTS.includes(kind) || kind === EVENT_SOUNDS) { // ground / nature / light / event_sounds: the resolved slot (base, no map type; ask theme.world(name, mapType) for one), walked by the rest of the path
      let v = theme.world(kind);
      for (const k of parts.slice(1)) { if (!hasOwn(v, k)) return undefined; v = v[k]; }
      return v ?? undefined;
    }
    if (kind === 'effects') { // code package 2: effects.palette.dust, effects.sapper.fuse ...
      let v = theme.effects();
      for (const k of parts.slice(1)) { if (!hasOwn(v, k)) return undefined; v = v[k]; }
      return v ?? undefined;
    }
    if (!TEXT_KINDS.includes(kind) || !type || !theme.has(kind, type)) return undefined;
    const slot = theme.slot(kind, type);
    if (!rawField) return slot;
    const field = SLOT_ALIAS[rawField] || rawField;
    if (!SLOT_FIELDS[kind].includes(field) || slot.from[field] !== 'theme') return undefined;
    let v = slot[field];
    for (const k of rest) { if (!hasOwn(v, k)) return undefined; v = v[k]; }
    return v ?? undefined;
  }
  if (hasOwn(theme.slots, slotPath)) return theme.slots[slotPath];
  let v = theme;
  for (const k of parts) { if (!hasOwn(v, k)) return undefined; v = v[k]; }
  return v;
}

export { KINDS };
