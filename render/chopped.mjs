// The trees of the forest that are being chopped: they wobble at every axe hit, fall when the wood of their tile runs out and leave a stump.
// They stay instances of their forest Scatter (one draw call per species, no mesh of their own): a wobbling or falling tree only gets another matrix in
// its instance slot. The stumps are two more instanced meshes for the whole forest (body and cut top). All timing is in treefall.mjs (pure maths); this file
// only applies it. Nothing here uses a random number or a clock: the caller passes the time (page clock, or the output time of the broadcast render).
import * as THREE from './vendor/three.module.js';
import { heightAt } from './terrain.mjs';
import * as TF from './treefall.mjs';

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _ax = new THREE.Vector3(), _ay = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color();
const BARK = [0.3, 0.2, 0.12]; // fallback bark colour (linear)
const CELL = 3, cellKey = (x, z) => Math.floor(x / CELL) * 65537 + Math.floor(z / CELL); // grid of the drawn trees

// stump parts: a short, slightly flared trunk (unit radius at the foot, height 1) and the cut top with a few darker rings
function stumpBody() {
  const g = new THREE.CylinderGeometry(0.84, 1, 1, 12, 1, true).translate(0, 0.5, 0);
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const y = g.attributes.position.getY(i), v = 0.7 + 0.3 * y; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = v; } // darker towards the foot
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function stumpTop() {
  const rings = [0.0, 0.3, 0.55, 0.78, 1], tone = [0.5, 0.62, 0.52, 0.6, 0.3]; // rings of the wood (linear light: warm pale wood, not white), darker bark rim
  const pos = [], col = [], idx = [], seg = 12;
  rings.forEach((r, k) => { for (let j = 0; j < (k ? seg : 1); j++) { const a = (j / seg) * Math.PI * 2; pos.push(Math.sin(a) * r * 0.84, 1, Math.cos(a) * r * 0.84); col.push(tone[k], tone[k] * 0.68, tone[k] * 0.38); } });
  const at = (k, j) => (k === 0 ? 0 : 1 + (k - 1) * seg + (j % seg));
  for (let j = 0; j < seg; j++) idx.push(0, at(1, j + 1), at(1, j));
  for (let k = 1; k < rings.length - 1; k++) for (let j = 0; j < seg; j++) idx.push(at(k, j), at(k, j + 1), at(k + 1, j), at(k, j + 1), at(k + 1, j + 1), at(k + 1, j));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export class Chopped {
  // items: [[scatter, index in the scatter, x, z, plan entry {id, s, ry, ...}]]; index: Map tile -> item numbers (the standing trees of the tile; this class removes the tile);
  // env: { dust(x, y, z, size) } called when a tree hits the ground
  constructor(scene, pack, size, items, index, env = {}) {
    this.scene = scene; this.pack = pack; this.size = size; this.items = items; this.index = index; this.env = env;
    this.chop = new Map(); // tile -> { hits: [time], seen: time, cx, cz } woodcutters at work on or next to a tile
    this.falls = []; // trees that are falling: { k, t0, yaw, hits, impact, sp }
    this.wob = new Set(); // item numbers that are tilted by a wobble (their matrix is not the standing one)
    this.proxy = new Map(); // forest tile without a tree of its own -> item number of the nearest tree that stands in for it (see adopt)
    this.home = new Map(); this.rank = new Map(); // item number -> tile it was planted on, its number among the trees of that tile (what the stump and the fall are hashed from: a tree that stands in for another tile looks the same however it was reached)
    for (const [tile, ks] of index) ks.forEach((k, q) => { this.home.set(k, tile); this.rank.set(k, q); });
    this.gone = new Set(); // item numbers of trees that fell (or are falling): a tree that stands in for a tile can go before its own tile does
    this.pend = []; // [tile, jump] wood gone messages, handled by the next frame
    this.tick = null; this.jump = true; this.time = 0;
    this.species = new Map(); // model id -> { r (trunk radius, model units), bark: [r g b] }
    this.n = 0; this.stat = { falls: 0, stumps: 0, hits: 0, sees: 0 };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    this.body = new THREE.InstancedMesh(stumpBody(), mat, Math.max(1, items.length));
    this.top = new THREE.InstancedMesh(stumpTop(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }), Math.max(1, items.length));
    for (const m of [this.body, this.top]) { m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true; m.name = 'stumps'; m.renderOrder = 190; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, items.length) * 3), 3); scene.add(m); }
    this.stumps = []; // placed stumps: { k, tile, x, z, r, h, ry, hidden (its tree still stands), covered (a building stands on its tile) }
    this.fallback = []; // stump slots made with the fallback trunk (see refit)
    this.foot = new Set(); this.footSig = null; // tiles under buildings (cover())
  }

  // The drawn forest is thinner than the forest of the sim (crowns overlap, so about 4 of 10 forest tiles hold no tree): a woodcutter at such a tile would chop at nothing.
  // Every such tile gets a tree within 2.5 tiles to stand in for it: that tree wobbles at the axe and falls when the wood of the tile is gone. The tree is the one nearest to the
  // side of the tile where the woodcutter stands (see axeSide), not to the tile centre. Trees that no other tile has taken are preferred, so a clearing of empty tiles takes
  // several trees, not one. The choice may not depend on what a woodcutter did: a render chunk that starts after the fall never sees him, and must put the stump on the same
  // tree as a serial render. So it depends on the plan and the forest tiles only, the same for every viewer.
  adopt(tiles, reach = 2.5) {
    const cell = CELL, key = cellKey;
    const grid = this.treeGrid(), forest = new Set(tiles);
    const taken = new Set();
    for (const tile of [...tiles].sort((a, b) => a - b)) {
      if (this.index.has(tile) || this.proxy.has(tile)) continue;
      const cx = (tile % this.size) + 0.5, cz = Math.floor(tile / this.size) + 0.5, side = this.axeSide(tile, forest), ax = cx + side[0], az = cz + side[1], near = [];
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) for (const k of grid.get(key(cx + i * cell, cz + j * cell)) || []) {
        if (Math.hypot(this.items[k][2] - cx, this.items[k][3] - cz) <= reach) near.push([Math.hypot(this.items[k][2] - ax, this.items[k][3] - az), k]);
      }
      if (!near.length) continue;
      near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const pick = near.find(([, k]) => !taken.has(k)) || near[0];
      taken.add(pick[1]); this.proxy.set(tile, pick[1]);
    }
  }
  // Where a woodcutter stands at a forest tile, as an offset from the tile centre: on the open side. He walks in from the ground that is not forest, so the offset points
  // towards the open tiles of the 5 x 5 square around the tile (nearer ones count more) and is 0.9 tiles long; a tile with open ground on all sides or none has [0, 0].
  // Tiles outside the map count as forest. Pure function of the forest tiles.
  axeSide(tile, forest) {
    const tx = tile % this.size, tz = Math.floor(tile / this.size);
    let sx = 0, sz = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      if (!i && !j) continue;
      const x = tx + i, z = tz + j;
      if (x < 0 || z < 0 || x >= this.size || z >= this.size || forest.has(z * this.size + x)) continue;
      const d = Math.hypot(i, j); sx += i / (d * d); sz += j / (d * d);
    }
    const len = Math.hypot(sx, sz);
    return len < 0.25 ? [0, 0] : [(sx / len) * 0.9, (sz / len) * 0.9];
  }
  // grid of the drawn trees (cells of CELL tiles), built once: the plan does not change
  treeGrid() {
    if (this.grid) return this.grid;
    const grid = this.grid = new Map();
    this.items.forEach((it, k) => { const q = cellKey(it[2], it[3]); (grid.get(q) || grid.set(q, []).get(q)).push(k); });
    return grid;
  }
  // the standing trees that show the wood of a tile: its own, else the one that stands in for it (null: none)
  treesOf(tile) {
    const own = this.index.get(tile);
    if (own) { const ks = own.filter((k) => !this.gone.has(k)); return ks.length ? ks : null; }
    const k = this.proxy.get(tile);
    return k !== undefined && !this.gone.has(k) ? [k] : null;
  }

  // ---------------------------------------------------------------- what the page tells us
  // an axe hit on tile (tx, tz) (tile centre or any point in it), by a woodcutter standing at (wx, wz)
  hit(tx, tz, time, wx, wz) {
    const e = this.entry(tx, tz, wx, wz, time);
    if (!e) return;
    e.hits = e.hits.filter((h) => time - h < TF.HIT.dur && h <= time);
    e.hits.push(time); this.stat.hits++;
  }
  // a woodcutter is at work on tile (tx, tz) right now (every frame)
  see(tx, tz, wx, wz, time) { this.stat.sees++; this.entry(tx, tz, wx, wz, time); }
  entry(tx, tz, wx, wz, time) {
    const ix = Math.floor(tx), iz = Math.floor(tz);
    if (ix < 0 || iz < 0 || ix >= this.size || iz >= this.size) return null;
    const key = iz * this.size + ix;
    let e = this.chop.get(key);
    if (!e) this.chop.set(key, e = { hits: [], seen: time, cx: wx, cz: wz });
    e.seen = time; e.cx = wx; e.cz = wz;
    return e;
  }
  // call for every snapshot (tick = game tick): a jump in game time makes the "wood gone" messages of this snapshot a baseline (stumps at once)
  sync(tick) { this.jump = TF.jumped(this.tick, tick); this.tick = tick; }
  // the wood of this tile is gone (message of a snapshot). Taken up by the next frame, which knows the time.
  fell(tile) { if (this.index.has(tile) || this.proxy.has(tile)) this.pend.push([tile, this.jump]); }

  // ---------------------------------------------------------------- per frame
  frame(time) {
    if (time < this.time - 1e-9) this.rewind(time); // the clock went back (a cut): forget what was seen
    this.time = time;
    for (const [tile, jump] of this.pend) this.begin(tile, jump, time);
    this.pend.length = 0;
    this.wobbles(time);
    this.drop(time);
    if (this.fallback.length) this.refit();
    for (const [tile, e] of this.chop) if (time - e.seen > TF.MEMORY && !TF.hitsLeft(e.hits, time)) this.chop.delete(tile);
  }
  rewind(time) {
    this.chop.clear();
    for (const k of this.wob) this.stand(k);
    this.wob.clear();
    // the sim says these trees are felled (their tile has left the index for good): they cannot stand up again, so a fall that is cut short ends as a stump now
    for (const f of this.falls) { const it = this.items[f.k]; this.reveal(f.slot); it[0].setAlive(it[1], false); }
    this.falls.length = 0;
  }
  // woodcutter within two tiles of the tile who was seen most recently: { since, cx, cz } or null
  cutterNear(tile, time) {
    const ix = tile % this.size, iz = Math.floor(tile / this.size);
    let best = null;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { // the picture picks the tile next to the woodcutter itself, which may be a tile or two off the tile of the sim
      const e = this.chop.get((iz + j) * this.size + ix + i);
      if (!e) continue;
      const since = time - e.seen;
      if (!best || since < best.since) best = { since, cx: e.cx, cz: e.cz, hits: e.hits };
    }
    return best;
  }
  begin(tile, jump, time) {
    const ks = this.treesOf(tile);
    this.index.delete(tile); this.proxy.delete(tile);
    if (!ks) return;
    const cut = this.cutterNear(tile, time), kind = TF.fellKind(jump, cut ? cut.since : null);
    const own = this.chop.get(tile);
    ks.forEach((k0, q0) => {
      const k = k0, t = this.home.get(k) ?? tile, q = this.rank.get(k) ?? q0;
      this.wob.delete(k); this.gone.add(k);
      if (kind === 'stump') { this.stump(k, t, q); this.items[k][0].setAlive(this.items[k][1], false); this.stat.stumps++; return; }
      const it = this.items[k], away = cut ? TF.awayFrom(cut.cx, cut.cz, it[2], it[3]) : null;
      // the stump shows when the tree starts to lean over (drop), not before: while it still stands it hides the foot
      const slot = this.stump(k, t, q, true);
      this.falls.push({ k, slot, t0: time + TF.fallDelay(t, q), yaw: TF.fallYaw(t, q, away), hits: own ? own.hits.slice() : [], impact: false, stumped: false });
      this.stat.falls++;
    });
    this.chop.delete(tile);
  }
  // matrix of tree k: foot at its seat, rotation = tilt about the foot towards `dir` (heading), plus a quiver sideways, scaled by `scale`, lowered by `down`
  pose(k, tilt, dir, quiver = 0, scale = 1, down = 0) {
    const it = this.items[k], f = it[0], i = it[1], t = it[4];
    _qy.setFromAxisAngle(_ay, t.ry);
    _ax.set(Math.cos(dir), 0, -Math.sin(dir)); _qa.setFromAxisAngle(_ax, tilt);
    if (quiver) { _ax.set(Math.sin(dir), 0, Math.cos(dir)); _qb.setFromAxisAngle(_ax, quiver); _qa.premultiply(_qb); }
    _q.copy(_qa).multiply(_qy);
    f.setQ(i, f.pos[i * 3], f.pos[i * 3 + 1] - down, f.pos[i * 3 + 2], _q, t.s * scale);
  }
  stand(k) { this.pose(k, 0, 0); this.wob.delete(k); }
  wobbles(time) {
    const touched = new Set();
    for (const [tile, e] of this.chop) {
      if (!e.hits.length || !TF.hitsLeft(e.hits, time)) continue;
      const ks = this.treesOf(tile);
      if (!ks) continue;
      // the tree nearest to the woodcutter takes the whole blow, the others (same tile) a share
      let near = ks[0], nd = Infinity;
      for (const k of ks) { const it = this.items[k], d = Math.hypot(it[2] - e.cx, it[3] - e.cz); if (d < nd) { nd = d; near = k; } }
      for (const k of ks) {
        const it = this.items[k], t = it[4], away = TF.awayFrom(e.cx, e.cz, it[2], it[3]) ?? TF.rnd(tile, k, 31) * Math.PI * 2;
        this.pose(k, TF.wobbleSum(e.hits, time, t.s, k === near ? 1 : 0.5, k === near ? 0 : 0.04), away);
        this.wob.add(k); touched.add(k);
      }
    }
    for (const k of this.wob) if (!touched.has(k)) this.stand(k); // the shaking is over: the exact standing matrix again
  }
  drop(time) {
    for (let n = this.falls.length - 1; n >= 0; n--) {
      const f = this.falls[n], it = this.items[f.k], t = it[4], age = time - f.t0, p = TF.fallPose(age);
      if (p.done) { if (!f.stumped) this.reveal(f.slot); it[0].setAlive(it[1], false); this.falls.splice(n, 1); continue; }
      if (p.phase === 'stand') { this.pose(f.k, TF.wobbleSum(f.hits, time, t.s), f.yaw); continue; }
      if (!f.stumped && age >= TF.FALL.creak * 0.5) { f.stumped = true; this.reveal(f.slot); }
      const H = it[0].boxR * 2 * t.s;
      this.pose(f.k, p.tilt, f.yaw, p.shiver, p.scale, p.sink * H * 0.45);
      if (!f.impact && age >= TF.IMPACT) { f.impact = true; if (this.env.dust) this.env.dust(it[2] + Math.sin(f.yaw) * H * 0.4, it[0].pos[it[1] * 3 + 1], it[3] + Math.cos(f.yaw) * H * 0.4, 1.0 + 0.3 * t.s); }
    }
  }

  // ---------------------------------------------------------------- stumps
  info(id) {
    let s = this.species.get(id);
    if (s) return s;
    const m = this.pack.peek ? this.pack.peek(id, 0) : null;
    s = m ? trunkOf(m) : null;
    if (!s) return { r: 0.12, bark: BARK, fallback: true }; // model not loaded: not cached, asked again next time (refit() corrects the stumps made meanwhile)
    this.species.set(id, s);
    return s;
  }
  // size, shape and colour of stump n from the trunk of its species (same values whenever they are computed: only the hash of tile and tree number and the model count)
  fit(n, sp) {
    const s = this.stumps[n], t = this.items[s.k][4], d = TF.stumpOf(sp.r, t.s, s.tile, s.q);
    s.r = d.r; s.h = d.h; s.ry = d.ry;
    _c.setRGB(Math.max(0.1, sp.bark[0]) * d.tone * 1.25, Math.max(0.06, sp.bark[1]) * d.tone * 1.25, Math.max(0.04, sp.bark[2]) * d.tone * 1.25);
    this.body.setColorAt(n, _c); _c.setRGB(d.tone, d.tone, d.tone); this.top.setColorAt(n, _c);
    this.body.instanceColor.needsUpdate = this.top.instanceColor.needsUpdate = true;
  }
  // adds a stump (its slot is fixed now, so the order is the same in a serial and in a chunked render); hidden: shown later by reveal()
  stump(k, tile, q, hidden = false) {
    const it = this.items[k], sp = this.info(it[4].id), n = this.n++;
    this.stumps.push({ k, q, x: it[2], z: it[3], r: 0, h: 0, ry: 0, hidden, tile, covered: this.foot.has(tile) });
    this.fit(n, sp);
    if (sp.fallback) this.fallback.push(n); // the model is not loaded yet (a live page just after the start): the real trunk is taken as soon as it is
    this.place(n);
    this.body.count = this.top.count = this.n;
    return n;
  }
  // stumps that were made before their model was loaded get the real size and colour now
  refit() {
    for (let i = this.fallback.length - 1; i >= 0; i--) {
      const n = this.fallback[i], sp = this.info(this.items[this.stumps[n].k][4].id);
      if (sp.fallback) continue;
      this.fit(n, sp); this.place(n); this.fallback.splice(i, 1);
    }
  }
  reveal(n) { this.stumps[n].hidden = false; this.place(n); }
  place(n) {
    const s = this.stumps[n], y = heightAt(s.x, s.z) - 0.02;
    _q.setFromAxisAngle(_ay, s.ry);
    _m.compose(_p.set(s.x, y, s.z), _q, _s.set(s.r, s.h, s.r).multiplyScalar(s.hidden || s.covered ? 0 : 1));
    this.body.setMatrixAt(n, _m); this.top.setMatrixAt(n, _m);
    this.body.instanceMatrix.needsUpdate = this.top.instanceMatrix.needsUpdate = true;
  }
  // buildings = [[tx, ty, size]] (the footprints in the current snapshot). A stump on a tile that a building covers is not drawn, and comes back when the building is gone.
  // It depends only on the buildings of the snapshot, so a render chunk and a serial render agree whatever happened before.
  cover(buildings) {
    let sig = buildings.length;
    for (const [tx, ty, sz] of buildings) sig = (Math.imul(sig, 31) + tx * 4099 + ty * 17 + sz) | 0;
    if (sig === this.footSig) return;
    this.footSig = sig;
    const set = new Set();
    for (const [tx, ty, sz] of buildings) for (let j = 0; j < sz; j++) for (let i = 0; i < sz; i++) set.add((ty + j) * this.size + tx + i);
    this.foot = set;
    for (let n = 0; n < this.n; n++) { const s = this.stumps[n], c = set.has(s.tile); if (c !== s.covered) { s.covered = c; this.place(n); } }
  }
  reseat() { for (let n = 0; n < this.n; n++) this.place(n); } // the ground changed height
  stats() { return { ...this.stat, standing: this.index.size, falling: this.falls.length, stumpsDrawn: this.n }; }
  dispose() { for (const m of [this.body, this.top]) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); m.dispose(); } }
}

// trunk radius at the foot of a model (model units, scale 1) and the colour of its bark (linear rgb), from the vertices at the foot and the texture at their uv
export function trunkOf(model) {
  const part = model.parts[0];
  if (!part) return null;
  const geo = part.geo, pos = geo.attributes.position, H = Math.max(model.box.max.y, 0.1), lim = H * 0.08;
  let n = 0, cx = 0, cz = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < lim) { n++; cx += pos.getX(i); cz += pos.getZ(i); }
  if (!n) return null;
  cx /= n; cz /= n;
  let r = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < lim) r += Math.hypot(pos.getX(i) - cx, pos.getZ(i) - cz);
  r = Math.min(Math.max((r / n) * 0.85, 0.05), 0.4);
  let bark = BARK;
  try {
    const img = part.mat && part.mat.map && part.mat.map.image, uv = geo.attributes.uv;
    if (img && uv && typeof document !== 'undefined') {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 64, 64);
      let R = 0, G = 0, B = 0, c = 0;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) >= lim) continue;
        const px = g.getImageData(Math.min(63, Math.max(0, Math.floor(uv.getX(i) * 64))), Math.min(63, Math.max(0, Math.floor(uv.getY(i) * 64))), 1, 1).data;
        R += px[0]; G += px[1]; B += px[2]; c++;
      }
      if (c) { const col = new THREE.Color().setRGB(R / c / 255, G / c / 255, B / c / 255, THREE.SRGBColorSpace); bark = [Math.min(1, col.r * 1.1), Math.min(1, col.g * 1.1), Math.min(1, col.b * 1.1)]; }
    }
  } catch { /* the texture cannot be read: the fallback bark colour stays */ }
  return { r, bark };
}
