// Living deer at the herd nodes (resource `herd`): the stag model (art-v2 model 211, one mesh) gets a small rig (neck, head, four legs with knee)
// from the position of its vertices and is drawn as one skinned mesh per node. The behaviour is in herdpose.mjs (pure maths of node seed and time):
// it grazes and takes a few steps near the node, looks at units that come close, bolts when it is hunted, falls and lies as a carcass on the node
// centre (where the workers stand) and shrinks while the food is taken. Nothing here uses a random number or a timer of its own: the caller passes
// the clock (wall clock of the page, or the output time of the broadcast render).
import * as THREE from './vendor/three.module.js';
import { heightAt } from './terrain.mjs';
import * as P from './herdpose.mjs';

// joints of model 211 (model space: origin = ground centre of the stag, +x = forward, y up; measured on the mesh)
const J_ROOT = [0, 0.42, 0], J_N1 = [0.12, 0.5, 0], J_N2 = [0.195, 0.66, 0], J_HD = [0.25, 0.78, 0];
const LEGS = [ // front left (+z), front right, hind left, hind right
  { hip: [0.165, 0.4, 0.068], knee: [0.152, 0.2, 0.062], front: true, left: true },
  { hip: [0.165, 0.4, -0.068], knee: [0.152, 0.2, -0.062], front: true, left: false },
  { hip: [-0.27, 0.42, 0.085], knee: [-0.255, 0.215, 0.078], front: false, left: true },
  { hip: [-0.27, 0.42, -0.085], knee: [-0.255, 0.215, -0.078], front: false, left: false },
];
const RIGS = { 211: true }; // model ids that have a rig above
export const herdRigged = (pack) => !!RIGS[pack?.map?.nodes?.herd?.states?.[0]];

const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// bones: 0 body, 1 neck, 2 upper neck, 3 head, then (upper leg, lower leg) x 4
function weightsOf(x, y, z, w) {
  w.fill(0);
  let used = 0;
  for (let i = 0; i < 4; i++) {
    const L = LEGS[i];
    const wx = L.front ? sstep(0.07, 0.12, x) * sstep(0.3, 0.25, x) : sstep(-0.1, -0.15, x);
    const wz = L.left ? sstep(-0.025, 0.025, z) : sstep(0.025, -0.025, z);
    const wy = L.front ? sstep(0.4, 0.3, y) : sstep(0.42, 0.3, y);
    const wl = wx * wz * wy;
    if (wl <= 0) continue;
    const low = sstep(L.knee[1] + 0.05, L.knee[1] - 0.05, y);
    w[4 + i * 2] += wl * (1 - low); w[5 + i * 2] += wl * low; used += wl;
  }
  // neck: position along the line from the withers to the skull; three bones share it
  const ax = J_N1[0], ay = J_N1[1], bx = 0.27 - ax, by = 0.82 - ay, bl = bx * bx + by * by;
  const s = ((x - ax) * bx + (y - ay) * by) / bl;
  const gate = sstep(0.44, 0.54, y) * sstep(0, 0.08, x);
  const t1 = gate * sstep(0, 0.4, s), t2 = gate * sstep(0.35, 0.8, s), t3 = gate * sstep(0.7, 1, s);
  w[1] += t1 - t2; w[2] += t2 - t3; w[3] += t3; used += t1;
  w[0] = Math.max(0, 1 - used);
  let sum = 0; for (let i = 0; i < 12; i++) sum += w[i];
  for (let i = 0; i < 12; i++) w[i] /= sum;
}
// the mesh of the stag plus skin indices / weights (at most 4 bones per vertex)
function rigGeometry(src) {
  const geo = src.clone(), pos = geo.attributes.position, n = pos.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), w = new Float32Array(12), ord = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  for (let i = 0; i < n; i++) {
    weightsOf(pos.getX(i), pos.getY(i), pos.getZ(i), w);
    ord.sort((a, b) => w[b] - w[a]);
    let tot = 0; for (let k = 0; k < 4; k++) tot += w[ord[k]];
    for (let k = 0; k < 4; k++) { si[i * 4 + k] = ord[k]; sw[i * 4 + k] = w[ord[k]] / tot; }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geo;
}
const rel = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function makeBones() {
  const bones = [], mk = (p, parent, from) => { const b = new THREE.Bone(); b.position.set(...rel(p, from)); if (parent) parent.add(b); bones.push(b); return b; };
  const root = mk(J_ROOT, null, [0, 0, 0]), n1 = mk(J_N1, root, J_ROOT), n2 = mk(J_N2, n1, J_N1), hd = mk(J_HD, n2, J_N2);
  for (const L of LEGS) { const up = mk(L.hip, root, J_ROOT); mk(L.knee, up, L.hip); }
  return { bones, root, n1, n2, hd };
}

const _e = new THREE.Euler(), _f = new THREE.Frustum(), _pm = new THREE.Matrix4(), _s = new THREE.Sphere();
const tileSet = (nodes, size) => { const occ = new Map(); for (const n of nodes) for (let j = 0; j < n[4]; j++) for (let i = 0; i < n[4]; i++) occ.set((n[3] + j) * size + n[2] + i, n[0]); return occ; };
const CLEAR = 0.35, CARC = 0.5; // tiles: room around the centre of a standing deer / of the lying carcass (it is about one tile long)
const RING = 16;
const SLOT = 1.5, EASE = 1; // seconds: how often the layout is checked against the world, and how long a change takes to glide in
const _pg = P.newPose();

export class Herd {
  // list: init.nodes entries [id, 'herd', tx, ty, size, amt, max]; env: { rows (terrain strings), size, nodes (all init nodes), dust(x, y, z, s), cry(id, x, z) }
  constructor(scene, pack, list, env = {}) {
    this.scene = scene; this.pack = pack; this.env = env; this.deer = new Map(); this.geo = null; this.disposed = false;
    this.cells = new Map(); this.occ = null; this.tick = null; // obstacles (setBlockers) and the last snapshot tick (sync)
    this.modelId = pack.map.nodes.herd.states[0];
    const size = env.size || 0, occ = env.nodes && size ? tileSet(env.nodes, size) : new Map();
    for (const n of list) {
      const [id, , tx, ty, sz, amt, max] = n, cx = tx + sz / 2, cz = ty + sz / 2, seed = P.herdSeed(tx, ty);
      // terrain: grass only (and the node's own tiles), no other node
      const ground = (x, z) => { const i = Math.floor(z) * size + Math.floor(x); return Math.floor(x) >= 0 && Math.floor(z) >= 0 && Math.floor(x) < size && Math.floor(z) < size && (occ.get(i) === id || (env.rows ? env.rows[Math.floor(z)][Math.floor(x)] === '.' && !occ.has(i) : true)); };
      const frac = max > 0 ? amt / max : 1;
      const d = { id, cx, cz, seed, ground, free: (x, z) => ground(x, z) && this.clear(x, z) >= CLEAR, g: null, frac, mode: frac < 0.999 ? 'carcass' : 'alive', known: false, plan: null, t0: 0, u0: 0, pend: false, hunted: false, chk: null, gp: null, te: 0, nd: 1e9, nx: 0, nz: 0, pose: P.newPose(), mesh: null, rig: null, fit: 1 };
      this.place(d);
      this.deer.set(id, d);
    }
    this.ready = pack.load(this.modelId).then((mdl) => { if (mdl && !this.disposed) this.build(mdl); });
  }
  has(id) { return this.deer.has(id); }
  // rocks, bushes, props and trees as circles { x, z, r, on } (on: false = not drawn) and the building tiles (occ, one byte per tile, kept up to date by the terrain);
  // the deer stays clear of them. Call once, before the first frame.
  setBlockers(items, occ = null) {
    this.cells.clear(); this.occ = occ;
    const size = this.env.size || 0;
    for (const o of items) { const k = Math.floor(o.z) * size + Math.floor(o.x); (this.cells.get(k) || this.cells.set(k, []).get(k)).push(o); }
    for (const d of this.deer.values()) { this.place(d); if (d.mode === 'carcass' && d.mesh) this.settle(d); }
  }
  // distance from (x, z) to the nearest obstacle edge or building tile (Infinity: nothing near)
  clear(x, z) {
    const size = this.env.size || 0, ix = Math.floor(x), iz = Math.floor(z);
    let m = Infinity;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const l = this.cells.get((iz + j) * size + ix + i);
      if (l) for (const o of l) if (o.on !== false) { const e = Math.hypot(x - o.x, z - o.z) - o.r; if (e < m) m = e; }
    }
    if (this.occ) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const tx = ix + i, tz = iz + j;
      if (tx < 0 || tz < 0 || tx >= size || tz >= size || !this.occ[tz * size + tx]) continue;
      const e = Math.hypot(Math.max(tx - x, 0, x - tx - 1), Math.max(tz - z, 0, z - tz - 1));
      if (e < m) m = e;
    }
    return m;
  }
  // wander area of a deer: the largest disc round its home in which it may stand everywhere
  discFree(d, hx, hz, r) {
    for (let a = 0; a < RING; a++) {
      const s = Math.sin((a * Math.PI * 2) / RING), c = Math.cos((a * Math.PI * 2) / RING);
      if (!d.free(hx + s * r, hz + c * r) || !d.free(hx + s * r * 0.5, hz + c * r * 0.5) || !d.ground(hx + s * (r + 0.4), hz + c * (r + 0.4))) return false;
    }
    return d.free(hx, hz);
  }
  // where the deer lives in the world as it is now (pure: obstacles and buildings only, no history): the home (the carcass lies there: the node centre, or the nearest
  // spot with room when a rock or bush sits on it) and the graze radius (shrinks to 0 when it is tight)
  layout(d) {
    let hx = d.cx, hz = d.cz;
    const room = (x, z) => (d.ground(x, z) ? this.clear(x, z) : -1);
    let best = room(hx, hz);
    for (const r of [0.15, 0.3, 0.45, 0.6]) {
      if (best >= CARC) break;
      for (let a = 0; a < RING; a++) {
        const x = d.cx + Math.sin((a * Math.PI * 2) / RING) * r, z = d.cz + Math.cos((a * Math.PI * 2) / RING) * r, m = room(x, z);
        if (m > best + 1e-6) { best = m; hx = x; hz = z; }
      }
    }
    let R = 0;
    for (const r of [1.25, 0.85, 0.45]) if (this.discFree(d, hx, hz, r)) { R = r; break; }
    return { hx, hz, R };
  }
  place(d) { // at once, no glide (start, new obstacles)
    const l = this.layout(d);
    d.g = P.makeGraze(d.seed, l.hx, l.hz, l.R); d.gp = null; d.chk = null;
  }
  build(mdl) {
    const part = mdl.parts[0], geo = rigGeometry(part.geo), fit = Math.min(Math.max(this.pack.fit(this.modelId, 1), 0.5), 1.6);
    this.geo = geo;
    for (const d of this.deer.values()) {
      if (d.mode === 'gone') continue;
      const mat = part.mat ? part.mat.clone() : new THREE.MeshStandardMaterial({ color: 0xb06a30, roughness: 0.9 });
      const mesh = new THREE.SkinnedMesh(geo, mat), rig = makeBones();
      mesh.add(rig.root);
      mesh.bind(new THREE.Skeleton(rig.bones));
      mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 200 + this.modelId * 4;
      mesh.visible = false; mesh.name = 'deer-' + d.id;
      this.scene.add(mesh);
      d.mesh = mesh; d.rig = rig; d.fit = fit;
      if (d.mode === 'carcass') this.settle(d);
    }
    this.release();
  }
  // a carcass that was there at the start of the view: lies at once, no fall
  settle(d) {
    d.plan = P.planHunt(d.g, { ...P.newPose(), x: d.g.cx, z: d.g.cz, yaw: P.rnd(d.seed, 7) * Math.PI * 2 }, null, null);
    d.t0 = -1e9; d.mode = 'carcass';
  }
  // the food left changed (frac = amount / full amount). The first amount a viewer sees (and the first after a jump in game time) is a baseline: an eaten deer lies
  // at once. Only a drop seen later starts the hunt, so chunked broadcast renders show the same as a serial one.
  set(id, frac) {
    const d = this.deer.get(id);
    if (!d) return;
    d.frac = frac;
    const a = P.amountSeen(d.mode, d.known, frac);
    d.known = true;
    if (a === 'carcass') this.settle(d); else if (a === 'hunt') d.pend = true;
  }
  // call for every snapshot (tick = game tick): a jump in game time starts the baseline again
  sync(tick) {
    const j = P.jumped(this.tick, tick);
    this.tick = tick;
    if (j) for (const d of this.deer.values()) d.known = false;
  }
  remove(id) {
    const d = this.deer.get(id);
    if (!d) return;
    d.mode = 'gone'; this.drop(d); this.release();
  }
  drop(d) { // free what the deer owns on the GPU (the textures belong to the model pack)
    if (!d.mesh) return;
    this.scene.remove(d.mesh); d.mesh.skeleton.dispose(); d.mesh.material.dispose(); d.mesh = null; d.rig = null;
  }
  release() { // the shared geometry goes with the last deer
    if (this.geo && [...this.deer.values()].every((d) => !d.mesh)) { this.geo.dispose(); this.geo = null; }
  }
  dispose() {
    this.disposed = true;
    for (const d of this.deer.values()) { d.mode = 'gone'; this.drop(d); }
    this.release();
  }
  // per frame: call begin(), then see() for every unit, then update()
  begin() { for (const d of this.deer.values()) { d.nd = 1e9; d.hunted = false; } }
  // a unit at (x, z); act = its order (2: gathering), work = what it works on {code, tx, tz}
  see(x, z, act, work) {
    for (const d of this.deer.values()) {
      if (d.mode !== 'alive') continue;
      const dx = x - d.cx, dz = z - d.cz;
      if (dx > P.ALERT_R + 2 || dx < -P.ALERT_R - 2 || dz > P.ALERT_R + 2 || dz < -P.ALERT_R - 2) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 < d.nd) { d.nd = d2; d.nx = x; d.nz = z; }
      if (act === 2 && d.known && work && work.code === 10 && Math.abs(work.tx - d.cx) < 0.01 && Math.abs(work.tz - d.cz) < 0.01 && d2 < P.HUNTER_R * P.HUNTER_R) d.hunted = true;
    }
  }
  update(time, dt, camera) {
    if (this.hold != null) time = this.hold; // dev / tests: freeze the deer clock at a chosen time
    _f.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const d of this.deer.values()) {
      if (!d.mesh || d.mode === 'gone') continue;
      const p = this.step(d, time);
      _s.center.set(p.x, heightAt(p.x, p.z) + 0.6, p.z); _s.radius = d.mode === 'hunt' ? 5.5 : d.g.R + 2;
      d.mesh.visible = _f.intersectsSphere(_s);
      if (d.mesh.visible) this.apply(d, p);
    }
  }
  step(d, time) {
    const p = d.pose;
    if (d.mode === 'alive') {
      const k = Math.floor(time / SLOT); // a building may go up or come down: home and radius follow the world, decided per time slot (not per frame shown)
      if (k !== d.chk) {
        d.chk = k;
        const l = this.layout(d), g = d.g;
        if (l.hx !== g.cx || l.hz !== g.cz || l.R !== g.R) { d.gp = g; d.g = P.makeGraze(d.seed, l.hx, l.hz, l.R); d.te = k * SLOT; }
      }
      const near = d.nd < P.ALERT_R * P.ALERT_R, a = near ? P.alertOf(Math.sqrt(d.nd)) : 0;
      const look = a > 0 ? { a, bx: d.nx - p.x, bz: d.nz - p.z } : null;
      P.grazeAt(d.g, time, look, p);
      if (d.gp) { // glide from the old wander area to the new one
        const e = Math.min(Math.max((time - d.te) / EASE, 0), 1), w = e * e * (3 - 2 * e);
        if (e >= 1) d.gp = null;
        else { P.grazeAt(d.gp, time, look, _pg); p.x = _pg.x + (p.x - _pg.x) * w; p.z = _pg.z + (p.z - _pg.z) * w; }
      }
      if (d.pend || d.hunted) { // the hunt begins: it runs from the unit nearest to it
        const hunter = near ? { x: d.nx, z: d.nz } : null;
        d.plan = P.planHunt(d.g, p, hunter, d.free);
        d.t0 = time; d.u0 = 0; d.mode = 'hunt'; d.pend = d.hunted = false; d.cried = d.thud = false;
      }
      return p;
    }
    if (d.mode === 'hunt') {
      const u = time - d.t0, pl = d.plan;
      P.huntAt(pl, u, p);
      if (!d.cried && u >= pl.tCry && u - d.u0 < 1) { d.cried = true; if (this.env.cry) this.env.cry(d.id, p.x, p.z); }
      if (!d.thud && u >= pl.tThud && u - d.u0 < 1) { d.thud = true; if (this.env.dust) this.env.dust(p.x, heightAt(p.x, p.z), p.z, 1.1); }
      d.u0 = u;
      if (u >= pl.total) d.mode = 'carcass';
      return p;
    }
    return P.huntAt(d.plan, 1e9, p);
  }
  apply(d, p) {
    const m = d.mesh, R = d.rig, sc = d.fit * P.carcassScale(d.frac);
    const lie = Math.min(1, Math.abs(p.roll) / 1.2), sink = P.carcassSink(d.frac) * lie;
    m.position.set(p.x, heightAt(p.x, p.z), p.z); m.rotation.y = p.yaw - Math.PI / 2; m.scale.setScalar(sc);
    R.root.position.set(J_ROOT[0], J_ROOT[1] + p.y - sink, J_ROOT[2]);
    R.root.quaternion.setFromEuler(_e.set(p.roll, 0, p.pitch, 'ZXY'));
    R.n1.quaternion.setFromEuler(_e.set(p.nr, 0, p.n1, 'XZY'));
    R.n2.quaternion.setFromEuler(_e.set(p.nr * 0.5, p.hy * 0.5, p.n2, 'YZX'));
    R.hd.quaternion.setFromEuler(_e.set(p.nr * 0.5, p.hy * 0.5, p.hd, 'YZX'));
    for (let i = 0; i < 4; i++) {
      R.bones[4 + i * 2].quaternion.setFromEuler(_e.set(p.splay[i], 0, p.leg[i * 2], 'ZXY'));
      R.bones[5 + i * 2].quaternion.setFromEuler(_e.set(0, 0, p.leg[i * 2 + 1], 'XYZ'));
    }
  }
}
