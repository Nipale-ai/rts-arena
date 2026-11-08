// Scatter: many static copies of one model with distance LOD and frustum culling, drawn as InstancedMeshes (one per LOD and part).
// Used for trees, bushes, rocks, props and resource nodes. Items can be removed (tree felled, node emptied) or seated again on
// a changed height field. Everything here is deterministic: no timers, only the camera state decides what is drawn.
import * as THREE from './vendor/three.module.js';

// video render only (tools/render-story.mjs --lod0 puts lodk=N into the page address): every LOD distance of a scatter times N, so a wide shot still draws the best level. Without the parameter: 1, nothing changes.
const LODK = typeof location === 'undefined' ? 1 : (+new URLSearchParams(location.search).get('lodk') || 1);
const _f = new THREE.Frustum(), _pm = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _s = new THREE.Sphere(), _v = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _sc = new THREE.Vector3(), _m = new THREE.Matrix4();

export class Scatter {
  // opts: lods [0,1,2] to load, dist [d0,d1] camera distances where lod1 / lod2 start, shadow [bool x lods], cullPad, fallbackColor,
  //       matFn(material, lod) to patch materials (wind sway), receive (bool), maxDraw (distance beyond which nothing is drawn)
  constructor(scene, pack, id, n, opts = {}) {
    this.scene = scene; this.pack = pack; this.id = id; this.n = n;
    this.lods = opts.lodList ? opts.lodList.filter((l) => l < pack.lodCount(id)) : [0, 1, 2].slice(0, Math.min(opts.maxLods || 3, pack.lodCount(id)));
    if (!this.lods.length) this.lods = [0];
    this.dist = (opts.dist || [60, 120]).map((d) => d * LODK);
    this.shadow = opts.shadow || [true, true, false];
    this.pad = opts.cullPad ?? 5;
    this.matFn = opts.matFn || null;
    this.receive = opts.receive ?? true;
    this.maxDraw = opts.maxDraw || 1e9;
    this.mats = new Float32Array(n * 16);
    this.pos = new Float32Array(n * 3);
    this.smax = new Float32Array(n); this.sy = new Float32Array(n);
    this.col = new Float32Array(n * 3).fill(1);
    this.alive = new Uint8Array(n);
    this.meshes = []; // per lod: [InstancedMesh per part]
    this.group = new THREE.Group();
    this.group.name = 'scatter-' + id;
    scene.add(this.group);
    this.dirty = true; this.lastCam = new Float32Array(7); this.ready = false;
    this.boxR = 1;
    this.promise = Promise.all(this.lods.map((l) => pack.load(id, l))).then((models) => {
      this.build(models);
    });
  }
  build(models) {
    const base = models[0];
    if (!base) return;
    this.boxR = base.box.getBoundingSphere(new THREE.Sphere()).radius;
    models.forEach((m, li) => {
      if (!m) { this.meshes[li] = []; return; }
      const arr = [];
      let shared = null, sharedC = null;
      for (const part of m.parts) {
        let mat = part.mat || new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.9 });
        mat = mat.clone();
        if (this.matFn) mat = this.matFn(mat, li) || mat;
        const im = new THREE.InstancedMesh(part.geo, mat, this.n);
        im.count = 0; im.frustumCulled = false;
        im.renderOrder = 200 + this.id * 4 + li; // fixed draw order (material ids depend on the async load order, which would make frames differ between runs)
        im.castShadow = !!this.shadow[li]; im.receiveShadow = this.receive;
        if (!shared) { shared = im.instanceMatrix; sharedC = im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 3), 3); } else { im.instanceMatrix = shared; im.instanceColor = sharedC; }
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); sharedC.setUsage(THREE.DynamicDrawUsage);
        this.group.add(im); arr.push(im);
      }
      this.meshes[li] = arr;
    });
    this.ready = true; this.dirty = true;
  }
  // place item i: world position, rotation about Y, scale (uniform or [sx,sy,sz]), optional tint colour
  set(i, x, y, z, ry, s, color) {
    const sx = Array.isArray(s) ? s[0] : s, sy = Array.isArray(s) ? s[1] : s, sz = Array.isArray(s) ? s[2] : s;
    _e.set(0, ry, 0); _q.setFromEuler(_e);
    _m.compose(_p.set(x, y, z), _q, _sc.set(sx, sy, sz));
    _m.toArray(this.mats, i * 16);
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.smax[i] = Math.max(sx, sy, sz); this.sy[i] = sy;
    if (color) { this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b; }
    this.alive[i] = 1; this.dirty = true;
  }
  // like set(), with a ready rotation (a tree that wobbles or falls) and a uniform scale. The culling position and radius stay those of set(): the foot of the tree.
  setQ(i, x, y, z, q, s) {
    _m.compose(_p.set(x, y, z), q, _sc.set(s, s, s));
    _m.toArray(this.mats, i * 16);
    this.dirty = true;
  }
  setAlive(i, on) { if (this.alive[i] !== (on ? 1 : 0)) { this.alive[i] = on ? 1 : 0; this.dirty = true; } }
  // move item i vertically (terrain changed) keeping everything else
  reseat(i, y) {
    this.mats[i * 16 + 13] = y;
    this.pos[i * 3 + 1] = y; this.dirty = true;
  }
  // Viewer throttle: update(camera, now, minInterval) skips the work when less than `minInterval` (same unit as `now`, the caller's clock)
  // passed since the last real update; `dirty` and the camera delta stay pending, so the next call that is due catches up. The defaults
  // (no clock, interval 0) never skip, which is what the frame-exact broadcast path relies on: Scatter reads no clock itself.
  update(camera, now = 0, minInterval = 0) {
    if (!this.ready) return;
    if (minInterval > 0 && this.lastRun !== undefined && now - this.lastRun < minInterval) return;
    const c = camera.matrixWorld.elements, lc = this.lastCam;
    if (!this.dirty && Math.abs(c[12] - lc[0]) + Math.abs(c[13] - lc[1]) + Math.abs(c[14] - lc[2]) < 0.35 && Math.abs(c[8] - lc[3]) + Math.abs(c[9] - lc[4]) + Math.abs(c[10] - lc[5]) < 0.004) return;
    lc[0] = c[12]; lc[1] = c[13]; lc[2] = c[14]; lc[3] = c[8]; lc[4] = c[9]; lc[5] = c[10];
    this.dirty = false; this.lastRun = now;
    _inv.copy(camera.matrixWorld).invert();
    _pm.multiplyMatrices(camera.projectionMatrix, _inv);
    _f.setFromProjectionMatrix(_pm);
    const cx = c[12], cy = c[13], cz = c[14];
    const d0 = this.dist[0] * this.dist[0], d1 = this.dist[1] * this.dist[1], dm = this.maxDraw * this.maxDraw;
    const cnt = [0, 0, 0], M = this.meshes;
    const mats = this.mats, pos = this.pos, col = this.col, alive = this.alive, smax = this.smax, sy = this.sy, pad = this.pad, bR = this.boxR;
    const arrs = M.map((a) => (a && a[0] ? a[0].instanceMatrix.array : null));
    const carr = M.map((a) => (a && a[0] ? a[0].instanceColor.array : null));
    for (let i = 0; i < this.n; i++) {
      if (!alive[i]) continue;
      const x = pos[i * 3], y = pos[i * 3 + 1] + bR * 0.5 * sy[i], z = pos[i * 3 + 2];
      const dx = x - cx, dy = y - cy, dz = z - cz, dd = dx * dx + dy * dy + dz * dz;
      if (dd > dm) continue;
      _s.center.set(x, y, z); _s.radius = bR * smax[i] + pad;
      if (!_f.intersectsSphere(_s)) continue;
      let l = dd < d0 ? 0 : dd < d1 ? 1 : 2;
      while (l > 0 && !arrs[l]) l--;
      if (!arrs[l]) continue;
      const k = cnt[l]++;
      const dst = arrs[l], a16 = k * 16, s16 = i * 16; // plain copy, no subarray view per instance
      for (let j = 0; j < 16; j++) dst[a16 + j] = mats[s16 + j];
      const o = k * 3; carr[l][o] = col[i * 3]; carr[l][o + 1] = col[i * 3 + 1]; carr[l][o + 2] = col[i * 3 + 2];
    }
    for (let l = 0; l < 3; l++) {
      if (!M[l]) continue;
      for (const im of M[l]) im.count = cnt[l];
      if (M[l][0]) { M[l][0].instanceMatrix.needsUpdate = true; M[l][0].instanceColor.needsUpdate = true; }
    }
    this.counts = cnt;
  }
  get drawn() { return this.counts ? this.counts[0] + this.counts[1] + this.counts[2] : 0; }
}
