// Forest from the new tree models: one tree per forest tile (species by biome patch, deterministic hash noise), LOD by camera distance.
// Same interface as terrain.buildTrees: remove(tile) fells a tile; plus update(camera) once per frame.
import * as THREE from './vendor/three.module.js';
import { hash, vnoise, heightAt, onHeightsChanged } from './terrain.mjs';
import { Scatter } from './scatter.mjs';
import { planGroves, crownOf } from './grove.mjs';
import * as ANIM from './anim.mjs';
import { Chopped } from './chopped.mjs';
import { natureThemed } from './theme/nature-theme.mjs'; // theme: the tree models of the map type (classic pack without a theme)

function pick(list, r) {
  let tot = 0;
  for (const e of list) tot += e[1];
  let a = r * tot;
  for (const e of list) { a -= e[1]; if (a <= 0) return e; }
  return list[list.length - 1];
}

// env: { dust(x, y, z, size) } puff where a felled tree hits the ground
export function buildForest(scene, pack, size, rows, seed = 0, biome = 'meadow', env = {}) {
  pack = natureThemed(pack, biome);
  const T = { ...pack.map.trees, ...(pack.map.biomes?.[biome]?.trees || {}) }; // map type: palms in the desert, snow spruce in the winter, ...
  const cand = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (rows[y][x] === 'f') cand.push([x, y, 1]);
  // one species per grove, spaced by crown radius (render/grove.mjs); the sim tiles stay as they are
  const sc = T.scale || [1.1, 1.55], second = T.second ?? 0.5;
  const plan = planGroves(T, seed, cand, { scale: sc, per: 3, spacing: 0.6 }); // crowns overlap: a closed forest, not single trees
  const ids = [...new Set(plan.map((t) => t.id))];
  const count = new Map(ids.map((id) => [id, 0]));
  for (const t of plan) count.set(t.id, count.get(t.id) + 1);
  const field = new Map(), next = new Map();
  const sway = (mat, lod) => (lod < 2 ? ANIM.swayMaterial(mat, 0.8) : mat);
  for (const id of ids) {
    field.set(id, new Scatter(scene, pack, id, count.get(id), { dist: [48, 100], shadow: [true, true, false], matFn: sway, cullPad: 6 }));
    next.set(id, 0);
  }
  const items = []; // [scatter, index, x, z]
  const index = new Map(); // tile -> item indices
  const col = new THREE.Color();
  for (const t of plan) {
    const f = field.get(t.id), i = next.get(t.id); next.set(t.id, i + 1);
    col.setRGB(t.b, t.b * (0.97 + t.cr * 0.06), t.b * (0.95 + (1 - t.cr) * 0.08));
    f.set(i, t.x, heightAt(t.x, t.z), t.z, t.ry, t.s, col);
    items.push([f, i, t.x, t.z, t]);
    const key = t.ty * size + t.tx;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(items.length - 1);
  }
  const work = new Chopped(scene, pack, size, items, index, env); // wobble at axe hits, falling trees, stumps (render/chopped.mjs)
  work.adopt(cand.map(([x, y]) => y * size + x)); // forest tiles without a drawn tree: the nearest tree stands in for them (render/chopped.mjs)
  const seat = () => { for (const it of items) it[0].reseat(it[1], heightAt(it[2], it[3])); work.reseat(); };
  onHeightsChanged((soft) => { if (!soft) seat(); });
  return {
    work,
    hit: (tx, tz, time, wx, wz) => work.hit(tx, tz, time, wx, wz), // an axe hit on a tile
    see: (tx, tz, wx, wz, time) => work.see(tx, tz, wx, wz, time), // a woodcutter at work on a tile (every frame)
    cover: (buildings) => work.cover(buildings), // every snapshot: footprints [[tx, ty, size]]; stumps under buildings are not drawn
    sync: (tick) => work.sync(tick), // every snapshot: a jump in game time makes the fells of that snapshot stumps at once
    frame: (time) => work.frame(time), // every frame, after the units: wobble, falls, stumps
    placed: plan.map((t) => [t.x, t.z, crownOf(t.id) * t.s]),
    scatters: [...field.values()],
    remove(tile) { work.fell(tile); }, // the wood of the tile is gone: its trees fall (or are stumps at once, see Chopped.begin), a stump stays
    update(camera) { for (const f of field.values()) f.update(camera); },
    get ready() { return Promise.all([...field.values()].map((f) => f.promise)); },
    stats() { let d = 0, n = 0; for (const f of field.values()) { d += f.drawn; n += f.n; } return { trees: n, drawn: d, ...work.stats() }; },
  };
}

// The ring of forest around the map: the same tree models, shadows and clump pattern as inside, thinning out toward the outer edge, standing on the
// far-field hills (heightFn from render/post.mjs). Beyond R the cheap far-LOD trees of the far field take over.
export function buildFarForest(scene, pack, size, seed, biome, heightFn, R = 50, occupied = []) {
  pack = natureThemed(pack, biome);
  const T = { ...pack.map.trees, ...(pack.map.biomes?.[biome]?.trees || {}) };
  const sc = T.scale || [1.1, 1.55];
  const cand = [];
  for (let y = -R; y < size + R; y++) for (let x = -R; x < size + R; x++) {
    const d = Math.max(-x, x - size + 1, -y, y - size + 1);
    if (d <= 0) continue; // inside the map: the real forest
    const patch = vnoise(x / 7, y / 7, seed + 611) * 0.7 + vnoise(x / 2.7, y / 2.7, seed + 612) * 0.3;
    const fade = 1 - Math.min(1, d / R);
    if (patch < 0.56 - 0.1 * fade || hash(x, y, 620) > 0.35 + 0.65 * fade) continue;
    cand.push([x, y, 1]);
  }
  const plan = planGroves(T, seed, cand, { scale: sc, per: 2, occupied, salt: 7, spacing: 0.75 });
  const ids = [...new Set(plan.map((t) => t.id))];
  const count = new Map(ids.map((id) => [id, 0]));
  for (const t of plan) count.set(t.id, count.get(t.id) + 1);
  const field = new Map(), next = new Map();
  for (const id of ids) { field.set(id, new Scatter(scene, pack, id, count.get(id), { dist: [48, 100], shadow: [true, true, false], cullPad: 6, maxDraw: 230 })); next.set(id, 0); }
  const col = new THREE.Color();
  for (const t of plan) {
    const f = field.get(t.id), i = next.get(t.id); next.set(t.id, i + 1);
    col.setRGB(t.b, t.b * (0.97 + t.cr * 0.06), t.b * (0.95 + (1 - t.cr) * 0.08));
    f.set(i, t.x, heightFn(t.x, t.z) - 0.05, t.z, t.ry, t.s, col);
  }
  return { placed: plan.map((t) => [t.x, t.z, crownOf(t.id) * t.s]), update(camera) { for (const f of field.values()) f.update(camera); }, get ready() { return Promise.all([...field.values()].map((f) => f.promise)); } };
}

// The far field beyond the ring: the same tree models at their lowest LOD (instanced, no shadow maps), groves of one species each (render/grove.mjs),
// bigger and sparser with the distance, plus a baked soft ground shadow per tree (one instanced disc, offset along the sun). Density comes from the
// same forest-patch noise as the ring. heightFn: far-field ground height (render/post.mjs); occupied: [x, z, r] of the trees already standing.
export function buildFarTrees(scene, pack, size, seed, biome, heightFn, occupied = [], sunDir = null) {
  pack = natureThemed(pack, biome);
  const T = { ...pack.map.trees, ...(pack.map.biomes?.[biome]?.trees || {}) };
  const sc0 = T.scale || [1.1, 1.55];
  const R0 = 50, R1 = 330, bands = [[R0, 120, 1, 1.0], [120, 215, 2, 1.6], [215, R1, 3, 2.3]]; // [from, to, tile stride, size factor]
  const placed = occupied.slice(), plan = [];
  for (const [d0, d1, st, k] of bands) {
    const cand = [];
    for (let y = -d1; y < size + d1; y += 1) for (let x = -d1; x < size + d1; x += 1) {
      const d = Math.max(-x, x - size + 1, -y, y - size + 1);
      if (d < d0 || d >= d1) continue;
      if (st > 1 && (hash(x, y, 801) > 1 / (st * st))) continue;
      const patch = vnoise(x / 9, y / 9, seed + 811) * 0.7 + vnoise(x / 3, y / 3, seed + 812) * 0.3;
      const fade = 1 - (d - R0) / (R1 - R0);
      if (patch < 0.55 || hash(x, y, 820) > 0.18 + 0.55 * fade) continue;
      cand.push([x, y, 1]);
    }
    const out = planGroves(T, seed, cand, { scale: [sc0[0] * k, sc0[1] * k], per: 1, occupied: placed, salt: 17 + st * 3 });
    for (const t of out) { plan.push(t); placed.push([t.x, t.z, crownOf(t.id) * t.s]); }
  }
  const ids = [...new Set(plan.map((t) => t.id))];
  const count = new Map(ids.map((id) => [id, 0]));
  for (const t of plan) count.set(t.id, count.get(t.id) + 1);
  const field = new Map(), next = new Map();
  for (const id of ids) { field.set(id, new Scatter(scene, pack, id, count.get(id), { lodList: [(id === 120 || id === 121) ? 1 : 2], dist: [1e9, 1e9], shadow: [false], cullPad: 6, maxDraw: 420 })); next.set(id, 0); }
  const col = new THREE.Color();
  for (const t of plan) {
    const f = field.get(t.id), i = next.get(t.id); next.set(t.id, i + 1);
    col.setRGB(t.b, t.b * (0.97 + t.cr * 0.06), t.b * (0.95 + (1 - t.cr) * 0.08));
    f.set(i, t.x, heightFn(t.x, t.z) - 0.05, t.z, t.ry, t.s, col);
  }
  // baked ground shadow: a soft dark disc per tree, shifted away from the sun
  let shadows = null;
  if (plan.length) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    gr.addColorStop(0, 'rgba(8,14,10,0.55)'); gr.addColorStop(0.6, 'rgba(8,14,10,0.34)'); gr.addColorStop(1, 'rgba(8,14,10,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true });
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    shadows = new THREE.InstancedMesh(geo, mat, plan.length);
    const dm = new THREE.Object3D(), sx = sunDir ? -sunDir.x : -0.5, sz = sunDir ? -sunDir.z : -0.4, sl = Math.hypot(sx, sz) || 1;
    plan.forEach((t, q) => {
      const r = crownOf(t.id) * t.s * 1.5;
      dm.position.set(t.x + (sx / sl) * r * 0.35, heightFn(t.x, t.z) + 0.55, t.z + (sz / sl) * r * 0.35);
      dm.rotation.set(0, Math.atan2(sx, sz), 0); dm.scale.set(r * 1.7, 1, r * 2.3); dm.updateMatrix(); shadows.setMatrixAt(q, dm.matrix);
    });
    shadows.instanceMatrix.needsUpdate = true; shadows.frustumCulled = false; shadows.renderOrder = 5; shadows.userData.noAO = true; shadows.name = 'far-tree-shadows';
    scene.add(shadows);
  }
  return { count: plan.length, update(camera) { for (const f of field.values()) f.update(camera); }, get ready() { return Promise.all([...field.values()].map((f) => f.promise)); } };
}
