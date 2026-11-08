// New 3D asset pack (art-v2): glb loading, per-model cache, entity -> asset table (assets/models/MAP.json).
// ?models=classic switches everything back to the procedural models in models.mjs.
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/jsm/loaders/GLTFLoader.js';
import { themeIdFromSearch, loadThemeSafe, classicTheme } from './theme/theme-loader.mjs'; // R2a: the theme of the match (classic unless ?theme=<id>-vN), nothing reads it yet
import { bindPageTheme } from './theme/page-theme.mjs'; // C2: the words of the page follow that theme
import { attachBuildingTheme } from './theme/building-theme.mjs'; // C4: the look of the buildings (tiers, damage, banner places) from the folder of the theme

export const USE_3D = typeof location === 'undefined' ? true : new URLSearchParams(location.search).get('models') !== 'classic';
const BASE = 'assets/models/';

// A loaded model: parts = [{ geo, mat, team }], box = bounds in model space (origin: ground centre, 1 tile = 1 unit).
export class Pack {
  constructor() {
    this.map = null;
    this.cache = new Map(); // key -> Promise<Model>
    this.done = new Map(); // key -> Model
    this.loader = new GLTFLoader();
    this.pending = 0;
    this.maxAniso = 8;
    this.theme = classicTheme();
    attachBuildingTheme(this); // C4: no theme or no building model in it = every answer below stays the classic one
  }
  async init() {
    const r = await fetch(BASE + 'MAP.json');
    this.map = await r.json();
    this.lods = await (await fetch(BASE + 'LODS.json')).json(); // id -> highest lod file that exists
    this.theme = await loadThemeSafe(themeIdFromSearch(typeof location === 'undefined' ? '' : location.search)); // classic without ?theme=: no file is read
    bindPageTheme(this.theme); // names in the HUD, the God panel and the broadcast follow the theme (classic: nothing changes)
    if (this.theme && this.theme.isClassic === false && typeof document !== 'undefined' && document.documentElement) document.documentElement.classList.add('themed'); // the page may make room for longer words (render/broadcast.css .themed ...); classic: no class, no new rule applies
    return this;
  }
  lodCount(id) { return (this.lods?.[id] ?? 0) + 1; }
  ov(id) { return this.map?.overrides?.[id] || {}; }
  key(id, lod) { return lod ? `${id}_lod${lod}` : String(id); }
  peek(id, lod = 0) { return this.done.get(this.key(id, lod)); }
  // lod falls back to a lower lod if the file does not exist
  load(id, lod = 0) {
    const k = this.key(id, lod);
    if (this.cache.has(k)) return this.cache.get(k);
    this.pending++;
    const p = this.loader.loadAsync(`${BASE}${k}.glb`).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const parts = [], box = new THREE.Box3();
      let tris = 0;
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
        geo.computeBoundingBox();
        box.union(geo.boundingBox);
        const team = /^TEAM/i.test(o.material.name || '');
        const mat = o.material;
        for (const t of [mat.map, mat.normalMap]) if (t) { t.anisotropy = this.maxAniso; }
        tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
        // TEAM with a texture (building roofs, see tools/lib/team-split.mjs): the material is kept, buildVisual tints it per owner
        parts.push({ geo, mat: team && !mat.map ? null : mat, team, gain: mat.userData?.teamGain || 1, flag: team && geo.attributes._flag ? mat.userData?.flagAxis || 'z' : null, glow: !team && !!geo.attributes._glow });
      });
      const spin = this.ov(id).spin;
      if (spin && lod === 0) splitSpin(parts, spin);
      if (this.ov(id).band && lod === 0) addBands(parts, this.ov(id).band);
      const m = { id, lod, parts, box, tris, size: box.getSize(new THREE.Vector3()), spin: spin || null };
      this.done.set(k, m);
      this.pending--;
      return m;
    }, (e) => { this.pending--; this.cache.delete(k); console.warn('model load failed', k, e?.message || e); return null; });
    this.cache.set(k, p);
    return p;
  }
  loadAll(ids, lods = [0]) { return Promise.all(ids.flatMap((id) => lods.map((l) => this.load(id, l)))); }
  // the game-size fit of a model: scale so that the longest horizontal extent equals `foot` tiles (override: ov.fit multiplies)
  fit(id, foot) {
    const m = this.peek(id, 0);
    if (!m) return 1;
    const ext = Math.max(m.size.x, m.size.z) || 1;
    return (foot / ext) * (this.ov(id).fit ?? 1);
  }
  // ---- table lookups ----
  buildingIds(name) {
    const b = this.map?.buildings?.[name];
    if (!b) return [];
    return [...b.tiers, ...(b.damage ? b.damage.flat() : [])];
  }
  // the asset id for a building: tier 1..3 of the owner, damage 0..3 (tower)
  buildingVariant(name, tier, dmg = 0) {
    const b = this.map?.buildings?.[name];
    if (!b) return null;
    const t = Math.min(Math.max(tier, 1), b.tiers.length) - 1;
    if (dmg > 0 && b.damage?.[t]) return b.damage[t][Math.min(dmg, b.damage[t].length) - 1];
    return b.tiers[t];
  }
  allBuildingIds() { return Object.keys(this.map.buildings).flatMap((n) => this.buildingIds(n)); }
}

export function damageLevel(hpPct) { return hpPct >= 70 ? 0 : hpPct >= 45 ? 1 : hpPct >= 22 ? 2 : 3; }

// Ground textures for the terrain shader (render/terrain.mjs groundShader). Returns at once; `det.value` rises to 1 when all are loaded
// (until then the terrain looks as before), `ready` resolves at the same time.
import { groundTheme, groundImageSrc } from './theme/nature-theme.mjs'; // C5b: ground textures of the theme (classic per layer); an import may stand here, it is hoisted
export function loadGround(pack, anisotropy = 8, mapType = null) {
  const names = Object.keys(pack.map.ground);
  const GT = groundTheme(pack, mapType); // the theme's textures for this map type (nothing for classic)
  const tex = {}, mean = {};
  const det = { value: 0 };
  const ready = Promise.all(names.map((n) => new Promise((resolve) => {
    mean[n] = new THREE.Vector3(1, 1, 1);
    const t = new THREE.Texture();
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = anisotropy;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    tex[n] = t;
    const im = new Image();
    im.onload = () => {
      t.image = im; t.needsUpdate = true;
      // mean colour (linear) from a small downscale
      const c = document.createElement('canvas'); c.width = c.height = 16;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      let r = 0, gr = 0, b = 0;
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      for (let i = 0; i < d.length; i += 4) { r += lin(d[i]); gr += lin(d[i + 1]); b += lin(d[i + 2]); }
      const k = 1 / (d.length / 4);
      mean[n].set(r * k, gr * k, b * k);
      resolve();
    };
    im.onerror = () => resolve();
    groundImageSrc(im, BASE + pack.map.ground[n], GT.url(n), () => GT.own && GT.own.delete(n));
  }))).then(() => { det.value = 0.7; });
  return { tex, mean, det, ready, ...GT.extra };
}

// Mill sails etc.: the triangles around `spin.hub` (in the plane z >= spin.zmin, y >= spin.ymin, farther than spin.rmin from the hub axis)
// become their own part (flag `spin`) that shares the vertex buffers, so the caller can rotate it about the hub.
function splitSpin(parts, spin) {
  const out = [];
  for (const p of parts) {
    if (p.team || !p.geo.index) { out.push(p); continue; } // (the TEAM part is never split)
    const pos = p.geo.attributes.position, idx = p.geo.index.array, keep = [], mov = [];
    const [hx, hy] = spin.hub;
    for (let t = 0; t < idx.length; t += 3) {
      let x = 0, y = 0, zlo = 9, zhi = -9;
      for (let k = 0; k < 3; k++) { x += pos.getX(idx[t + k]); y += pos.getY(idx[t + k]); const zz = pos.getZ(idx[t + k]); zlo = Math.min(zlo, zz); zhi = Math.max(zhi, zz); }
      x /= 3; y /= 3;
      const r = Math.hypot(x - hx, y - hy);
      const inSail = zlo >= spin.zmin && zhi <= (spin.zmax ?? 9) && y >= spin.ymin && r > (spin.rmin ?? 0.15) && r < (spin.rmax ?? 2);
      (inSail ? mov : keep).push(idx[t], idx[t + 1], idx[t + 2]);
    }
    const mk = (arr) => {
      const g = new THREE.BufferGeometry();
      for (const k in p.geo.attributes) g.setAttribute(k, p.geo.attributes[k]);
      g.setIndex(new THREE.BufferAttribute(idx instanceof Uint32Array ? new Uint32Array(arr) : new Uint16Array(arr), 1));
      g.boundingBox = p.geo.boundingBox; g.boundingSphere = p.geo.boundingSphere;
      return g;
    };
    out.push({ geo: mk(keep), mat: p.mat, team: false });
    if (mov.length) out.push({ geo: mk(mov), mat: p.mat, team: false, spin: true });
  }
  parts.length = 0; parts.push(...out);
}

// Team-colour sashes for walls, gates and ruins (MAP.json overrides.<id>.band = [{ axis: 'x' | 'z' (length direction), a: [from, to], y: [from, to], lift }] or { ring: true, y: [from, to] }):
// thin TEAM plates on both faces, snapped to the surface that the model really has in that window (the largest depth of the vertices inside the window), so the sash sits on
// the wall like a painted band or a cloth runner. A ring wraps a round tower. The plates become a TEAM part (flat owner colour, see Bld3D.teamFor).
function addBands(parts, specs) {
  const pos = [], idx = [];
  const quad = (a, b, c, d) => { const o = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
  for (const sp of specs) {
    const [y0, y1] = sp.y, lift = sp.lift ?? 0.012;
    let reach = [0, 0, 0, 0]; // x+, x-, z+, z- (ring: radius at y0, y1)
    const win = (x, y, z) => y >= y0 && y <= y1 && (sp.ring || (sp.axis === 'z' ? z >= sp.a[0] && z <= sp.a[1] : x >= sp.a[0] && x <= sp.a[1]));
    const rr = [0, 0];
    for (const p of parts) {
      const P = p.geo.attributes.position;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        if (!win(x, y, z)) continue;
        reach[0] = Math.max(reach[0], x); reach[1] = Math.min(reach[1], x); reach[2] = Math.max(reach[2], z); reach[3] = Math.min(reach[3], z);
        const r = Math.hypot(x, z), k = (y - y0) / (y1 - y0 || 1);
        if (k < 0.5) rr[0] = Math.max(rr[0], r); else rr[1] = Math.max(rr[1], r);
      }
    }
    if (sp.ring) {
      const n = 20, r0 = (rr[0] || rr[1]) + lift, r1 = (rr[1] || rr[0]) + lift;
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        const v = (a, r, y) => [Math.sin(a) * r, y, Math.cos(a) * r];
        quad(v(a0, r0, y0), v(a1, r0, y0), v(a1, r1, y1), v(a0, r1, y1));
      }
      continue;
    }
    if (sp.axis === 'z') { // length along z, faces at +-x
      for (const [x, flip] of [[reach[0] + lift, 0], [reach[1] - lift, 1]]) { const q = [[x, y0, sp.a[0]], [x, y0, sp.a[1]], [x, y1, sp.a[1]], [x, y1, sp.a[0]]]; if (flip) q.reverse(); quad(...q); }
    } else {
      for (const [z, flip] of [[reach[2] + lift, 0], [reach[3] - lift, 1]]) { const q = [[sp.a[0], y0, z], [sp.a[1], y0, z], [sp.a[1], y1, z], [sp.a[0], y1, z]]; if (flip) q.reverse(); quad(...q); }
    }
  }
  if (!pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  parts.push({ geo: g, mat: null, team: true, gain: 1, flag: null, glow: false });
}
