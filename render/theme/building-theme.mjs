// Theme hook for the buildings (reskin package C4): the look of a building (tier 1 to 3, the damage states, the banner places) can come from the folder of a theme.
// Without a theme (or with a theme that gives the buildings no model) nothing in here changes a result: every answer of the Pack is the classic one, and no extra file is asked for.
//
//   attachBuildingTheme(pack)   called once by the constructor of Pack (render/assets3d.mjs). It wraps buildingVariant, buildingIds, ov and lodCount of that pack and puts a thin
//                               loader in front of the glb loader; `pack.buildingTheme` is the layer (hasDamage, bannerAnchors).
//
// What a theme gives (THEME-VERTRAG.md 3.3), read through getThemeSlot(theme, 'buildings.<type>.model'): file = tier 1, tiers = [tier 2, tier 3], damage = the damage states of tier 1,
// damage_t2 and damage_t3 = those of the other tiers, lods, rot. The Theme object has already dropped every file that is only a placeholder and ends each list at the first file that is
// missing, so what arrives here is what is really delivered.
//
// Ids. A themed model gets the id  <theme folder>~<type>[_t2|_t3][_d1|_d2|_d3]  (dustmoon-v1~tower_t2_d1): a string with the folder of the theme in front. A classic id is a number, so the two
// can never meet in the caches of the Pack, and a second theme (or the next version of the same one) has ids of its own. MAP.json is not touched: it stays the table of the classic pack and
// the fallback of everything the theme does not deliver.
//
// Fallback, file by file: tier t shows the file the theme delivers for tier t, else the classic file of tier t (a type the theme gives one look and the classic table one look shows the theme's
// look at every tier, as the classic one is). A damage state comes from the damage list of the theme for that tier (a short list holds its last state, as MAP.json does), else from
// the classic list of that tier (only the tower has one), else the look of the tier stays whole. A file that cannot be loaded (404, broken glb, no mesh in it) is marked and from then on counts as not
// delivered: the next call of buildingVariant answers with the classic id and the building gets its classic 3D model instead of staying a plain box.
//
// Banner places. The model of a theme carries them as nodes banner_slot_0..n (flat quad with UVs 0..1, or an empty). The loader takes these nodes out of the scene before the Pack builds its parts
// (a cloth that is part of the model would be drawn twice and would stretch the footprint), keeps their place and size in model space and anchorsFromSlots turns them into the anchors that
// render/banners.mjs draws the creator banner at (the format of MAP.json overrides.<id>.banner): a hanging banner has its top edge at the top of the slot; the cloth of a flag or a mast flies from
// a pole that stands on the ground at the place of the slot, centred at the height of the slot. The size of the cloth is the size of the quad (an empty has no size: the size of the classic banners).
// A quad counts for the size of the model in tools/theme-check.mjs (the footprint, +-10 %), so a slot outside the footprint, like the mast beside a hall, is an empty. At run time the slots never count:
// they are taken out before Pack.fit measures the model.
// A themed model without slots has no anchors of its own: banners.mjs then uses the classic table for that building type, as before.
// Nothing in here is random, and nothing reads the clock: the broadcast renders frame by frame.
import * as THREE from '../vendor/three.module.js';
import { getThemeSlot } from './theme-loader.mjs';

export const SEP = '~'; // theme folder + SEP + type: the prefix of a themed id
export const isThemeId = (id) => typeof id === 'string' && id.includes(SEP);
const MAX_TIER = 3, MAX_DAMAGE = 3;

// ---- fixed draw order. The classic models use  id * 4 + part  (render/buildings3d.mjs); a string id would give NaN. A themed id gets a number of its own, above every classic one, the same in every run.
const ORDER = new Map();
function registerOrder(keys) { for (const k of [...keys].sort()) if (!ORDER.has(k)) ORDER.set(k, ORDER.size); }
export const themeOrder = (id) => 4000 + 8 * (ORDER.get(id) ?? 0);

// ---- the table: what the theme gives the buildings of the pack, one prefixed id per file
// { types: Map(type -> { name, rot, looks: [id of tier 1, 2, 3 ...], damage: [[ids of tier 1], [tier 2], [tier 3]], lods: [ids], keys: [all ids but the lods], hasDamage }), files: Map(id -> url), owner: Map(id -> type entry) }
// null = this theme gives the buildings nothing (classic, or a theme without a building model): the Pack answers as before.
export function buildTable(theme, map) {
  if (!theme || theme.isClassic || !map?.buildings || typeof theme.types !== 'function') return null;
  const prefix = `${theme.id}${SEP}`, types = new Map(), files = new Map(), owner = new Map();
  for (const name of Object.keys(map.buildings)) { // the order of MAP.json: the same in every run
    const m = getThemeSlot(theme, `buildings.${name}.model`);
    if (!m || typeof m.file !== 'string') continue;
    const base = prefix + name;
    const e = { name, rot: Number.isInteger(m.rot) ? ((m.rot % 4) + 4) % 4 : 0, looks: [base], damage: [[], [], []], lods: [], keys: [base], hasDamage: false };
    files.set(base, m.file);
    (m.lods || []).slice(0, 2).forEach((u, i) => { const k = `${base}_lod${i + 1}`; files.set(k, u); e.lods.push(k); });
    (m.tiers || []).slice(0, MAX_TIER - 1).forEach((u, i) => { const k = `${base}_t${i + 2}`; files.set(k, u); e.looks.push(k); e.keys.push(k); });
    [['damage', ''], ['damage_t2', '_t2'], ['damage_t3', '_t3']].forEach(([field, mid], ti) => {
      (m[field] || []).slice(0, MAX_DAMAGE).forEach((u, i) => { const k = `${base}${mid}_d${i + 1}`; files.set(k, u); e.damage[ti].push(k); e.keys.push(k); e.hasDamage = true; });
    });
    types.set(name, e);
    for (const k of [...e.keys, ...e.lods]) owner.set(k, e);
  }
  if (!types.size) return null;
  registerOrder(files.keys());
  return { prefix, types, files, owner };
}

// ---- banner places
// kind of cloth per building type (render/banners.mjs ANCHORS): a flag on a mast for the big halls, a flag on a pole for the tower, a banner hanging from a crossbar for the rest
export const BANNER_KIND = { town_center: 'mast', castle: 'mast', wonder: 'mast', tower: 'flag' };
const CLOTH = { hang: { w: 1.15, ch: 1.35 }, flag: { w: 1.28, ch: 0.81 }, mast: { w: 2.7, ch: 1.75 } }; // an empty slot has no size: the size of the classic 3D models (MAP.json)
const CQ = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // cos and sin of a quarter turn about the vertical axis
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The banner_slot_N nodes of a loaded scene, as { n, cx, cz, top, mid, w, h } in model space (centre of the slot, its top edge and its middle height, width = longest horizontal side, height).
// A flat quad gives all of it, an empty only its place (top = mid = its height, w and h are 0: the size of the cloth then comes from the kind). The nodes are taken out of the scene.
export function extractSlots(scene) {
  scene.updateMatrixWorld(true);
  const found = [];
  scene.traverse((o) => { const m = /^banner_slot_(\d+)$/.exec(o.name || ''); if (m) found.push({ n: +m[1], o }); });
  found.sort((a, b) => a.n - b.n); // (the sort is stable: two nodes with one number keep their order)
  const box = new THREE.Box3(), size = new THREE.Vector3(), centre = new THREE.Vector3();
  const slots = found.map(({ n, o }) => {
    box.makeEmpty().setFromObject(o);
    if (box.isEmpty()) { o.getWorldPosition(centre); return { n, cx: centre.x, cz: centre.z, top: centre.y, mid: centre.y, w: 0, h: 0 }; }
    box.getSize(size); box.getCenter(centre);
    const h = size.y > 0.02 ? size.y : 0; // a quad that lies flat has no height to hang
    return { n, cx: centre.x, cz: centre.z, top: box.max.y, mid: centre.y, w: Math.max(size.x, size.z), h };
  });
  for (const { o } of found) o.removeFromParent();
  return slots;
}

// slots (model space) -> anchors of render/banners.mjs in tiles, relative to the footprint centre: the model is scaled by `fit` and turned by `rotQ` quarter turns, as Bld3D does.
// { k: 'hang', x, z, top, w, ch }  { k: 'mast', x, z, h, w, ch }  { k: 'flag', x, z, y0, h, w, ch }. Walls and gates have their own pennants (null = the table of banners.mjs).
export function anchorsFromSlots(slots, name, fit, rotQ = 0) {
  if (!slots?.length || name === 'wall' || name === 'gate') return null;
  const kind = BANNER_KIND[name] || 'hang', d = CLOTH[kind], [c, s] = CQ[((rotQ % 4) + 4) % 4];
  return slots.map((sl) => {
    const x = (sl.cx * c + sl.cz * s) * fit, z = (-sl.cx * s + sl.cz * c) * fit;
    const w = clamp(sl.w > 0 ? sl.w * fit : d.w, 0.3, 3.2), ch = clamp(sl.h > 0 ? sl.h * fit : d.ch, 0.3, 2.4);
    if (kind === 'hang') return { k: 'hang', x, z, top: Math.max(sl.top * fit, 0.3), w, ch }; // the cloth hangs from the top of the slot
    const mid = Math.max((sl.mid ?? sl.top) * fit, 0.3); // a flag flies from the pole with its middle 0.1 (mast) or 0.06 (pole) below the top of the pole, as banners.mjs draws it
    if (kind === 'mast') return { k: 'mast', x, z, h: mid + 0.1, w, ch };
    return { k: 'flag', x, z, y0: 0, h: mid + 0.06, w, ch };
  });
}

// ---- the layer of one Pack
class BuildingThemeLayer {
  constructor(pack, inner, classic) {
    this.pack = pack;
    this.inner = inner; // the glb loader the pack had: classic files go to it unchanged
    this.classic = classic; // the original methods of the pack (called on the pack)
    this.failed = new Set(); // ids of delivered files that could not be loaded: they count as not delivered
    this.slots = new Map(); // id -> banner slots of the model (model space)
    this._theme = null; this._map = null; this._table = null;
    this.loader = { loadAsync: (url, onProgress) => this.loadFile(url, onProgress) };
  }
  // the table of the theme of the pack (null while classic); rebuilt when the pack gets another theme or another map
  get table() {
    const { theme, map } = this.pack;
    if (theme !== this._theme || map !== this._map) { this._theme = theme; this._map = map; this._table = buildTable(theme, map); }
    return this._table;
  }
  usable(id) { return !!id && !this.failed.has(id); }
  hasDamage(name) { return !!this.table?.types.get(name)?.hasDamage; }
  entry(id) { return this.table?.owner.get(id) || null; }

  // ---- the asset id of a look (a classic number, or a prefixed id of the theme)
  variant(name, tier, dmg = 0) {
    const T = this.table?.types.get(name);
    if (!T) return this.classic.buildingVariant(name, tier, dmg);
    const b = this.pack.map.buildings[name], nClassic = b.tiers.length;
    const t = clamp(Number.isFinite(+tier) ? Math.floor(+tier) : 1, 1, Math.max(nClassic, T.looks.length)); // (a type with one classic look and one themed look shows that look at every tier)
    if (dmg > 0) {
      const chain = T.damage[t - 1];
      let n = 0; while (n < chain.length && this.usable(chain[n])) n++;
      if (n) return chain[Math.min(dmg, n) - 1]; // a short chain holds its last state
      if (t <= nClassic && b.damage?.[t - 1]) return this.classic.buildingVariant(name, t, dmg); // no damage state of the theme for this tier: the classic ones (only the tower has them)
    }
    return this.usable(T.looks[t - 1]) ? T.looks[t - 1] : this.classic.buildingVariant(name, t, 0); // no look of the theme for this tier: the classic one
  }
  // every id of a type that may be shown (the broadcast loads them all before the first frame): the classic ones and the delivered ones of the theme
  ids(name) {
    const c = this.classic.buildingIds(name), T = this.table?.types.get(name);
    return T ? [...c, ...T.keys.filter((k) => this.usable(k))] : c;
  }
  // the overrides of MAP.json for an id of this table: only the turn of the type (Pack.fit scales the model to the footprint of the building by itself); null = not one of ours
  override(id) { const e = this.entry(id); return e ? { rot: e.rot } : null; }
  lodCount(id) { const e = this.entry(id); return e ? (e.looks[0] === id ? 1 + e.lods.length : 1) : null; }
  // anchors of the creator banner for a themed model with banner slots, else null
  bannerAnchors(id, name, fit, rotQ = 0) {
    if (!isThemeId(id)) return null;
    return anchorsFromSlots(this.slots.get(id), name, fit, rotQ);
  }

  // ---- the loader in front of the glb loader: ids of the theme are loaded from the theme folder, everything else goes to the loader the pack had
  loadFile(url, onProgress) {
    const text = String(url), id = text.slice(text.lastIndexOf('/') + 1).replace(/\.glb$/i, '');
    const src = isThemeId(id) ? this.table?.files.get(id) : null;
    if (!src) return this.inner.loadAsync(url, onProgress);
    return this.inner.loadAsync(src, onProgress).then((gltf) => this.prepare(id, gltf)).catch((e) => { this.failed.add(id); throw e; });
  }
  // the scene of a themed file before the Pack builds its parts from it
  prepare(id, gltf) {
    const slots = extractSlots(gltf.scene);
    let meshes = 0;
    gltf.scene.traverse((o) => { if (o.isMesh) meshes++; });
    if (!meshes) throw new Error('no mesh in the model');
    if (slots.length) this.slots.set(id, slots);
    return gltf;
  }
}

export function attachBuildingTheme(pack) {
  if (pack.buildingTheme) return pack.buildingTheme;
  const base = { buildingVariant: pack.buildingVariant, buildingIds: pack.buildingIds, ov: pack.ov, lodCount: pack.lodCount }; // the methods of the class, before they are wrapped
  const classic = {
    buildingVariant: (name, tier, dmg) => base.buildingVariant.call(pack, name, tier, dmg),
    buildingIds: (name) => base.buildingIds.call(pack, name),
    ov: (id) => base.ov.call(pack, id),
    lodCount: (id) => base.lodCount.call(pack, id),
  };
  const layer = new BuildingThemeLayer(pack, pack.loader, classic);
  pack.loader = layer.loader;
  pack.buildingVariant = (name, tier, dmg = 0) => layer.variant(name, tier, dmg);
  pack.buildingIds = (name) => layer.ids(name);
  pack.ov = (id) => layer.override(id) ?? classic.ov(id); // (only an id of this table is answered here, so a hook of another package can sit next to this one)
  pack.lodCount = (id) => layer.lodCount(id) ?? classic.lodCount(id);
  pack.buildingTheme = layer;
  return layer;
}
