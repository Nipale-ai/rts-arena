// Theme slots of the natural world (package C5b of the reskin): trees, ground decoration (bushes, rocks, camps, ruins ...), resource nodes, the relic shrine,
// carried goods, the ground textures and the weather colours. THEME-VERTRAG.md sections 3.6 to 3.8 and 4 are the contract; this file is the one place
// that reads the slots `nature`, `ground.textures` and `light.weather` for the renderer (the palette, the water colours and the sky belong to render/theme/ground-theme.mjs, C5a:
// waterLook() there reads `ground.water`, so this file does not touch the water, and the two packages do not edit the same lines of render/terrain.mjs).
//
// Classic stays classic, per model, per group, per texture, per colour. Without a theme, or with a theme that has none of these slots, every function here hands back
// the object it was given (the same pack, the same constants), so the plan of the trees, the order of the draw calls and the picture do not change by one bit.
//
//   natureThemed(pack, mapType?)               the pack itself, or a VIEW of it (below); render/forest.mjs, props3d.mjs and shrines.mjs call it first
//   groundTheme(pack, mapType?)                { url(name), own, extra } for loadGround (render/assets3d.mjs)
//   groundImageSrc(img, classicUrl, themedUrl, onFallback)   starts a ground texture; if the theme file does not load, the classic texture of the layer is loaded
//   weatherLooks(theme, mapType, LOOKS, SAND)  the weather looks for render/world-fx.mjs
//   themedStaticUnit(pack, name, sg)           the static unit (MAP.json units: today only the neutral caravan) with the model of the theme, or null (= classic, the way render/app.mjs always drew it)
//
// The view is Object.create(pack) with five members changed: `map`, `lodCount`, `load`, `peek`, `fit` and `ov`. Everything else (theme, loader, maxAniso, the classic models) is the
// pack's own. In `map` the model lists of the slots the theme fills are replaced by ids of this file (numbers from 1000 up; the classic art-v2 ids end at 239), in the same shapes
// MAP.json has, so forest.mjs, props3d.mjs, herd.mjs, shrines.mjs, chopped.mjs and scatter.mjs read them as before and need no code for them:
//   trees   [id, weight, 1]   weights are the theme's (scaled up so that the smallest is 0.5: render/grove.mjs keeps lighter ones out of the groves); `scale`, `second` from the theme
//   deco    [id, ...]         a weight becomes repeats of the id (MAP.json does the same: rock [137, 137, 138, 139]); camp and ruin keep the order of the theme (every model has a job)
//   nodes   { states: [id] }  all states or none (the loader drops a node with a missing state)
//   objects { relic_shrine: { model: id }, caravan: { model: id } }, carry { 1..4: id }   (1 food, 2 wood, 3 stone, 4 gold); `rot` of an object entry (quarter turns) comes back from ov(id).rot
//     The caravan is no object of MAP.json objects: the classic pack has it as MAP.json units.caravan (a static unit, drawn by render/app.mjs). The view gives it a model id here, and themedStaticUnit() hands app.mjs the numbers.
// A model entry of the theme is loaded when it is first asked for. `brightness` multiplies the material colour and `scale` the geometry when the model is loaded (an object's
// `scale` multiplies its fit instead, because the shrine is fitted to a footprint). If the base file of an entry cannot be loaded, the classic model of the same slot takes
// its place (a warning once); LODs that cannot be loaded are skipped (the scatter then draws the next lower look).
//
// Known limits, on purpose: the crown radius of a theme tree is the default of render/grove.mjs (0.8), only the size range and `scale` change how far trees stand apart;
// groups the classic renderer never plants (deco pebbles, bridge, cart) have no effect for a theme either; the `herd` node of a theme is a still model (the living deer
// of render/herd.mjs are made for the classic stag); `atlas` is not read (a glb carries its own textures).
//
// Pure data and pure functions plus the glb parse of the view: no DOM, no clock, no Math.random (the ids come from a hash of the theme key and the file name, so a run on
// another port or another machine draws in the same order).
import * as THREE from '../vendor/three.module.js';
import { TREE_GROUPS, MAP_TYPES, WEATHER_KINDS, RESOURCES } from './theme-schema.mjs';

export const NATURE_ID_BASE = 1000;
const NATURE_ID_SPAN = 60000;
export const DECO_MAIN = ['bush', 'fern', 'flowers', 'rock', 'cliff', 'pebbles', 'camp', 'ruin', 'single', 'mushrooms', 'tuft']; // MAP.json deco
export const DECO_EXTRA = ['cactus', 'dune', 'dryTuft', 'snow', 'reed', 'wreck', 'bridge', 'cart']; // MAP.json deco_extra
export const DECO_NO_HOOK = ['pebbles', 'bridge', 'cart']; // the classic renderer plants nothing from these groups
const POSITIONAL = new Set(['camp', 'ruin']); // every model of these groups has a job (tent, fire, crates ...): the order of the theme is kept, weights are not read
export const CARRY_INDEX = Object.freeze(Object.fromEntries(RESOURCES.map((r, i) => [r, i + 1]))); // MAP.json carry is keyed by the resource number: food 1, wood 2, stone 3, gold 4
const MAX_SLOTS = 48; // longest deco list a set of weights is turned into
const NO_OV = Object.freeze({});
const BASE = Symbol('nature.base');

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// small helpers
const hexOf = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null;
  const m = typeof v === 'string' ? /^#([0-9a-f]{6})$/i.exec(v) : null;
  return m ? parseInt(m[1], 16) : null;
};
function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
const baseName = (url) => String(url).split('#')[0].split('?')[0].split('/').pop();
const themeKeyOf = (theme) => String(theme.key || theme.id || 'theme');

// Weights of a tree group: scaled by one factor so that the smallest is 0.5 (render/grove.mjs makeGroves only lets entries from 0.5 up fill a grove). The ratios stay.
export function floorWeights(ws) {
  const m = Math.min(...ws);
  const k = m > 0 && m < 0.5 ? 0.5 / m : 1;
  return ws.map((w) => w * k);
}

// A list that is picked uniformly (deco): the weights as repeats of the ids, the smallest weight is one repeat, at most MAX_SLOTS repeats in all.
export function weightedList(ids, weights) {
  if (ids.length <= 1 || weights.every((w) => w === weights[0])) return ids.slice();
  const unit = Math.min(...weights);
  let counts = weights.map((w) => Math.max(1, Math.round(w / unit)));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total > MAX_SLOTS) counts = weights.map((w) => Math.max(1, Math.round((w / unit) * (MAX_SLOTS / total))));
  return ids.flatMap((id, i) => Array(counts[i]).fill(id));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the models of a theme: one entry per (file, brightness, scale), one number per entry
const STATE = new WeakMap(); // pack -> { byKey, byId, models, done, views, warned }
function stateOf(pack) {
  let s = STATE.get(pack);
  if (!s) STATE.set(pack, (s = { byKey: new Map(), byId: new Map(), models: new Map(), done: new Map(), views: new Map(), warned: new Set() }));
  return s;
}

// e: a resolved model entry of theme.world('nature') { file, lods, atlas, weight, brightness, scale } (urls); fallback: the classic model id that stands in for it
function register(st, theme, e, kind, fallback) {
  const bake = kind === 'object' ? 1 : e.scale, fitScale = kind === 'object' ? e.scale : 1; // an object is fitted to a footprint: its scale must come after the fit
  const rot = kind === 'object' && Number.isInteger(e.rot) ? e.rot : 0;
  const key = `${themeKeyOf(theme)}|${baseName(e.file)}|${+e.brightness}|${+bake}|${+fitScale}${rot ? `|r${rot}` : ''}`; // (no rot: the key of every entry is what it was)
  let ent = st.byKey.get(key);
  if (!ent) {
    let id = NATURE_ID_BASE + (fnv1a(key) % NATURE_ID_SPAN);
    while (st.byId.has(id)) id++;
    ent = { id, key, kind, url: e.file, lods: [...(e.lods || [])], brightness: e.brightness, bake, fitScale, rot, fallback: fallback ?? null, failed: false };
    st.byKey.set(key, ent);
    st.byId.set(id, ent);
  } else if (ent.fallback === null && fallback !== undefined && fallback !== null) ent.fallback = fallback;
  return ent.id;
}

// The glb -> Model step of Pack.load (render/assets3d.mjs), the same fields (a test keeps the two equal), plus the two numbers of a theme entry.
export function parseModel(gltf, ent, lod, anisotropy = 8) {
  gltf.scene.updateMatrixWorld(true);
  const parts = [], box = new THREE.Box3();
  let tris = 0;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (ent.bake !== 1) geo.scale(ent.bake, ent.bake, ent.bake); // the origin is the ground centre: the model grows from the ground
    geo.computeBoundingBox();
    box.union(geo.boundingBox);
    const team = /^TEAM/i.test(o.material.name || '');
    let mat = o.material;
    for (const t of [mat.map, mat.normalMap]) if (t) { t.anisotropy = anisotropy; }
    if (ent.brightness !== 1 && !team && mat.color) { mat = mat.clone(); mat.color.multiplyScalar(ent.brightness); } // a TEAM material is tinted per owner: not here
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    parts.push({ geo, mat: team && !mat.map ? null : mat, team, gain: mat.userData?.teamGain || 1, flag: team && geo.attributes._flag ? mat.userData?.flagAxis || 'z' : null, glow: !team && !!geo.attributes._glow });
  });
  return { id: ent.id, lod, parts, box, tris, size: box.getSize(new THREE.Vector3()), spin: null };
}

function themedModel(base, st, ent, lod) {
  const url = lod === 0 ? ent.url : ent.lods[lod - 1];
  if (!url) return Promise.resolve(null);
  const k = `${ent.id}:${lod}`;
  if (st.models.has(k)) return st.models.get(k);
  const fail = (e) => { if (!st.warned.has(url)) { st.warned.add(url); console.warn('theme model not loaded, classic instead:', baseName(url), e?.message || e); } return null; };
  let p;
  try {
    p = base.loader.loadAsync(url).then((gltf) => { const m = parseModel(gltf, ent, lod, base.maxAniso); st.done.set(k, m); return m; }, fail);
  } catch (e) { p = Promise.resolve(fail(e)); }
  st.models.set(k, p);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the tables of the view: the same shapes as MAP.json
function themedTrees(bmap, nt, mt, add) {
  const T = { ...(bmap.trees || {}), ...((mt && bmap.biomes?.[mt]?.trees) || {}) }; // the classic table of this map type, as forest.mjs builds it
  let any = false;
  for (const g of TREE_GROUPS) {
    const list = nt[g];
    if (!list || !list.length) continue; // a group the theme does not fill stays classic as a whole
    const w = floorWeights(list.map((e) => e.weight));
    T[g] = list.map((e, i) => [add(e, 'tree', T[g]?.[0]?.[0]), w[i], 1]);
    any = true;
  }
  if (nt.scale) { T.scale = [...nt.scale]; any = true; }
  if (nt.second !== undefined) { T.second = nt.second; any = true; }
  return any ? T : null;
}

function themedDeco(bmap, nd, add) {
  const D = { ...(bmap.deco || {}) }, X = { ...(bmap.deco_extra || {}) };
  let any = false;
  for (const [g, list] of Object.entries(nd)) {
    const tbl = DECO_MAIN.includes(g) ? D : DECO_EXTRA.includes(g) ? X : null;
    if (!tbl || !list || !list.length) continue;
    const ids = list.map((e) => add(e, 'deco', tbl[g]?.[0]));
    tbl[g] = POSITIONAL.has(g) ? ids : weightedList(ids, list.map((e) => e.weight));
    any = true;
  }
  return any ? { D, X } : null;
}

function themedNodes(bmap, nn, add) {
  const N = { ...(bmap.nodes || {}) };
  let any = false;
  for (const [k, v] of Object.entries(nn)) {
    const classic = bmap.nodes?.[k]?.states || [];
    N[k] = { ...(bmap.nodes?.[k] || {}), states: v.states.map((e, i) => add(e, 'node', classic.length ? classic[Math.min(i, classic.length - 1)] : null)) };
    any = true;
  }
  return any ? N : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the view
export function natureThemed(pack, mapType = null) {
  if (!pack) return pack;
  const base = pack[BASE] || pack;
  const theme = base.theme;
  if (!theme || theme.isClassic || typeof theme.world !== 'function') return base; // classic: the pack as it is
  const mt = MAP_TYPES.includes(mapType) ? mapType : null;
  const nat = theme.world('nature', mt);
  if (!nat) return base; // the theme has nothing for nature
  const st = stateOf(base), vk = `${themeKeyOf(theme)}|${mt || ''}`;
  let view = st.views.get(vk);
  if (!view) st.views.set(vk, (view = makeView(base, theme, mt, nat, st)));
  return view;
}

function makeView(base, theme, mt, nat, st) {
  const bmap = base.map || {};
  const add = (e, kind, fallback) => register(st, theme, e, kind, fallback);
  const map = { ...bmap };
  if (nat.trees) {
    const T = themedTrees(bmap, nat.trees, mt, add);
    if (T) { // the theme answered for this map type: the classic table of the map type must not lay its own groups over it
      map.trees = T;
      if (mt) map.biomes = { ...(bmap.biomes || {}), [mt]: { ...(bmap.biomes?.[mt] || {}), trees: {} } };
    }
  }
  if (nat.deco) { const d = themedDeco(bmap, nat.deco, add); if (d) { map.deco = d.D; map.deco_extra = d.X; } }
  if (nat.nodes) { const n = themedNodes(bmap, nat.nodes, add); if (n) map.nodes = n; }
  if (nat.objects) {
    const o = { ...(bmap.objects || {}) };
    for (const [k, e] of Object.entries(nat.objects)) o[k] = { ...(bmap.objects?.[k] || {}), model: add(e, 'object', bmap.objects?.[k]?.model ?? null) };
    map.objects = o;
  }
  if (nat.carry) {
    const c = { ...(bmap.carry || {}) };
    for (const [res, e] of Object.entries(nat.carry)) { const i = CARRY_INDEX[res]; if (i) c[i] = add(e, 'carry', bmap.carry?.[i] ?? null); }
    map.carry = c;
  }

  const view = Object.create(base);
  const own = (id) => st.byId.get(id);
  const fallbackLoad = (ent, lod) => (ent.fallback !== null ? base.load(ent.fallback, lod) : Promise.resolve(null));
  const lodLoad = (ent, lod) => themedModel(base, st, ent, 0).then((m0) => { // a LOD is only worth loading next to a base look that loaded
    if (!m0) { ent.failed = true; return fallbackLoad(ent, lod); }
    return lod === 0 ? m0 : themedModel(base, st, ent, lod);
  });
  Object.defineProperties(view, {
    [BASE]: { value: base },
    mapType: { value: mt },
    map: { value: map, enumerable: true },
    lodCount: { value: (id) => { const e = own(id); return e ? (e.failed ? base.lodCount(e.fallback) : 1 + e.lods.length) : base.lodCount(id); } },
    load: { value: (id, lod = 0) => { const e = own(id); if (!e) return base.load(id, lod); return e.failed ? fallbackLoad(e, lod) : lodLoad(e, lod); } },
    peek: { value: (id, lod = 0) => { const e = own(id); if (!e) return base.peek(id, lod); return e.failed ? (e.fallback !== null ? base.peek(e.fallback, lod) : undefined) : st.done.get(`${e.id}:${lod}`); } },
    ov: { value: (id) => { const e = own(id); return e ? (e.rot ? { rot: e.rot } : NO_OV) : base.ov(id); } }, // (shrines.mjs reads .rot: quarter turns of an object, theme field `rot`)
    fit: {
      value: (id, foot) => {
        const e = own(id);
        if (!e) return base.fit(id, foot);
        if (e.failed) return e.fallback !== null ? base.fit(e.fallback, foot) : 1;
        const m = st.done.get(`${e.id}:0`);
        if (!m) return 1;
        return (foot / (Math.max(m.size.x, m.size.z) || 1)) * e.fitScale;
      },
    },
  });
  return view;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// static units: the units of MAP.json `units` (siege, boats, the neutral caravan) are one rigid model each, drawn by render/app.mjs from that table. A theme brings its own model for the ones named here.
// FOOT: the longest horizontal extent of the classic model in model units (caravan = model 77: 1.797 x 1.026 x 0.673, measured 05.11.2026); the theme model is fitted to it, `scale` of the entry multiplies.
export const STATIC_UNIT_FOOT = Object.freeze({ caravan: 1.8, scout: 1.4, light_cavalry: 1.7, heavy_cavalry: 2.0, ram: 2.0 }); // ram: the Auger Rig (siege, MAP.json units.ram), a theme without a wooden wagon brings its own
// riders of a theme without a rig: one rigid model like the caravan (nature.objects.<type>); the rigged layer skips them (render/units3d.mjs noRig). The classic riders are rigged and have no entry in MAP.json units.
export const STATIC_RIDERS = Object.freeze(['scout', 'light_cavalry', 'heavy_cavalry']);

// null = classic (no theme, no nature slot, no entry for this unit, or a unit not named above): app.mjs then draws the table entry as it always did.
// Else { pack, sg, foot, fit }: pack = the view (its load() gives the model, null when the file does not load: app.mjs then falls back to the classic entry), sg = the table entry with the
// model id of the theme and rotY (quarter turns of the entry, 1.5708 per turn, like MAP.json units.caravan.rotY), fit() = the scale for the loaded model (valid after load()).
export function themedStaticUnit(pack, name, sg) {
  if (!pack || !sg || !Object.hasOwn(STATIC_UNIT_FOOT, name)) return null;
  const view = natureThemed(pack);
  const o = view && view.map && view.map.objects && view.map.objects[name];
  if (!o || o.model === undefined || o.model === null) return null;
  const foot = STATIC_UNIT_FOOT[name], model = o.model, rot = view.ov(model).rot || 0;
  return { pack: view, sg: { model, lunge: sg.lunge, lean: sg.lean, rotY: (rot * Math.PI) / 2 }, foot, fit: () => view.fit(model, foot) };
}

// The entries a view or a pack has made so far (id, kind, file, numbers), sorted by id: for tests and for looking at what a theme brought.
export function natureEntries(pack) {
  const base = pack && (pack[BASE] || pack);
  const st = base && STATE.get(base);
  return st ? [...st.byId.values()].sort((a, b) => a.id - b.id).map(({ id, kind, url, lods, brightness, bake, fitScale, fallback, failed }) => ({ id, kind, file: baseName(url), lods: lods.map(baseName), brightness, scale: bake !== 1 ? bake : fitScale, fallback, failed })) : [];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ground textures: read by loadGround (render/assets3d.mjs) and buildTerrain (render/terrain.mjs, the `own` guard)
const NO_GROUND = Object.freeze({ url: () => null, own: null, extra: Object.freeze({}) });

// url(name): the delivered texture file of the layer or null (= classic); own: the set of layers the theme names (the terrain lets the map type's texture swap, desert sand, winter snow,
// stand back for a layer the theme names itself); extra: what loadGround adds to its result (nothing for classic)
export function groundTheme(pack, mapType = null) {
  const theme = pack && pack.theme;
  if (!theme || theme.isClassic || typeof theme.world !== 'function') return NO_GROUND;
  const g = theme.world('ground', MAP_TYPES.includes(mapType) ? mapType : null);
  if (!g) return NO_GROUND;
  const tex = g.textures || {}, own = new Set(Object.keys(tex));
  const extra = {};
  if (own.size) extra.own = own;
  return { url: (name) => tex[name] || null, own, extra };
}

// Starts the load of a ground texture. A theme file that cannot be loaded gives the classic texture of the layer (onFallback says so), a classic file that cannot be loaded ends as before.
export function groundImageSrc(img, classicUrl, themedUrl, onFallback = null) {
  if (!themedUrl) { img.src = classicUrl; return; }
  const last = img.onerror;
  img.onerror = (e) => { img.onerror = last; if (onFallback) onFallback(); img.src = classicUrl; };
  img.src = themedUrl;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// weather: the colour of the cloud cover and the fog of each kind (render/world-fx.mjs LOOKS), and the style of the storm
// Returns { looks, sand, stormSand }: looks (kind -> look), sand (the look of a sand storm), stormSand (the storm is a sand storm: the classic look on a desert map).
// Without a theme the very same objects come back.
export function weatherLooks(theme, mapType, LOOKS, SAND) {
  const desert = mapType === 'desert';
  const classic = { looks: LOOKS, sand: SAND, stormSand: desert };
  const light = theme && !theme.isClassic && typeof theme.world === 'function' ? theme.world('light', MAP_TYPES.includes(mapType) ? mapType : null) : null;
  const w = light && light.weather;
  if (!w) return classic;
  const tune = (look, t) => {
    const o = { ...look }, c = hexOf(t.color);
    if (c !== null) o.col = c;
    if (typeof t.fog === 'number') o.fog = look.fog * t.fog; // a multiple of the classic density of that weather
    return o;
  };
  const looks = { ...LOOKS };
  for (const k of WEATHER_KINDS) if (w[k] && LOOKS[k]) looks[k] = tune(LOOKS[k], w[k]);
  const style = w.storm && w.storm.style;
  return { looks, sand: w.storm ? tune(SAND, w.storm) : SAND, stormSand: style === 'sand' ? true : style === 'standard' ? false : desert };
}
