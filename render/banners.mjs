// Creator banners: every player fights under the flag of the maker of its recipe (KONZEPT-BANNER.md).
// Purely cosmetic (never part of the sim, never in the LLM prompt). Team colour (blue / orange) stays on roofs and unit rings;
// the creator colours live on cloth: town centre flag on a mast, hanging banners on production buildings, pennants on towers,
// walls and gates, one banner bearer per army group and pennants on cavalry lances.
// One logo atlas (512 px per logo), one instanced cloth mesh (waves in the vertex shader, driven by the shared time uniform of
// anim.mjs, so the broadcast renders identical frames), one instanced pole mesh. No clocks, no randomness.
import * as THREE from './vendor/three.module.js';
import { U } from './anim.mjs';

const CELL = 512;
const TAU = Math.PI * 2;
const CAP_CLOTH = 1600, CAP_POLE = 2400;
// all cloth hangs / flies in one wind direction: its plane then faces the default camera (az -45 deg) and reads from both sides
const WIND = -Math.PI / 4;
const hash = (n) => { n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); n = Math.imul(n ^ (n >>> 12), 0x297a2d39); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; };

// shape ids: 1 hanging banner (swallowtail, trim, logo), 2 flag (logo in the middle, notched end), 3 pennant (triangle, stripe)
const CLOTH_VERT_DECL = /* glsl */`
attribute vec4 iA; attribute vec3 iC1; attribute vec3 iC2; attribute vec4 iW;
uniform float uTime;
varying vec2 vQ; varying vec4 vA; varying vec4 vW; varying vec3 vC1; varying vec3 vC2;
float clothZ(vec2 uv){
  bool flag = iW.x < 0.5;
  float w = flag ? uv.x : (1.0 - uv.y);          // 0 at the attachment, 1 at the free end
  float k = flag ? 8.0 : 5.0;
  float t = uTime * (flag ? 3.4 : 2.2) + iW.z;
  float s = w * w * (0.55 + 0.45 * w);
  float z = sin(w * k - t) * 0.55 + sin(w * k * 1.85 - t * 1.37 + 1.3) * 0.2 + sin(uv.y * 3.0 + t * 0.6) * 0.1 * w;
  return iW.y * s * z;
}
`;
const CLOTH_FRAG_DECL = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vQ; varying vec4 vA; varying vec4 vW; varying vec3 vC1; varying vec3 vC2;
// logo square: centre c, half width hx (uv units), half height hy; returns rgb + inside flag (a)
vec4 logoAt(vec2 q, float qx, vec2 c, float hx, float hy){
  vec2 l = vec2((qx - c.x) / (2.0 * hx) + 0.5, (q.y - c.y) / (2.0 * hy) + 0.5);
  float inside = step(0.0, l.x) * step(l.x, 1.0) * step(0.0, l.y) * step(l.y, 1.0);
  l = clamp(l, 0.004, 0.996);
  vec3 rgb = texture2D(uAtlas, vA.xy + vA.z * l).rgb;
  return vec4(rgb, inside);
}
`;
const CLOTH_FRAG = /* glsl */`
{
  int shape = int(vA.w + 0.5);
  float asp = vW.w;                                  // width / height of the cloth in tiles
  vec2 uv = vQ;
  float qx = gl_FrontFacing ? uv.x : 1.0 - uv.x;     // the logo reads correctly from both sides
  vec3 col = vC1; float alpha = 1.0;
  bool hasLogo = vA.z > 0.0;
  if (shape == 1) {
    float notch = 0.17 * (1.0 - abs(uv.x * 2.0 - 1.0));
    alpha = smoothstep(notch - 0.006, notch + 0.006, uv.y);
    float bx = 0.065, by = bx * asp;
    float edge = min(min(uv.x, 1.0 - uv.x) / bx, (uv.y - notch) / by);
    if (edge < 1.0 || uv.y > 0.945) col = vC2;
    if (uv.y < 0.40 && uv.y > 0.325 && edge > 1.0) col = vC2;      // band under the logo
    if (hasLogo) {
      float hx = 0.34, hy = hx * asp;
      vec2 c = vec2(0.5, 0.64);
      vec2 d = abs(vec2(uv.x - c.x, (uv.y - c.y) / asp)) ;
      float ring = max(d.x, d.y);
      if (ring < hx + 0.032) col = vC2;
      vec4 lg = logoAt(uv, qx, c, hx, hy);
      if (lg.a > 0.5) col = lg.rgb;
    }
  } else if (shape == 2) {
    float notch = 0.12 * (1.0 - abs(uv.y * 2.0 - 1.0));
    alpha = smoothstep(1.0 - notch + 0.004, 1.0 - notch - 0.004, uv.x);
    float by = 0.07;
    if (uv.y < by || uv.y > 1.0 - by || uv.x < 0.025) col = vC2;
    if (hasLogo) {
      float hy = 0.36, hx = hy / asp;
      vec2 c = vec2(0.46, 0.5);
      vec2 d = vec2(abs(uv.x - c.x) * asp, abs(uv.y - c.y));
      if (max(d.x, d.y) < hy + 0.03) col = vC2;
      vec4 lg = logoAt(uv, qx, c, hx, hy);
      if (lg.a > 0.5) col = lg.rgb;
    }
  } else if (shape == 3) {
    float hw = 0.5 * (1.0 - uv.x * 0.96);
    alpha = smoothstep(hw + 0.01, hw - 0.01, abs(uv.y - 0.5));
    if (uv.x < 0.16) col = vC2;
    else if (abs(uv.y - 0.5) < hw * 0.28) col = mix(vC1, vC2, 0.0);
    if (abs(uv.y - 0.5) < hw * 0.26 && uv.x > 0.16) col = vC2;
  }
  diffuseColor = vec4(col, alpha);
  if (alpha < 0.02) discard;
}
`;

function clothMaterial(atlas) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  m.alphaToCoverage = true;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uAtlas = { value: atlas };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + CLOTH_VERT_DECL)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
{
  vec2 e = vec2(0.02, 0.0);
  float dzu = (clothZ(uv + e.xy) - clothZ(uv - e.xy)) / 0.04, dzv = (clothZ(uv + e.yx) - clothZ(uv - e.yx)) / 0.04;
  objectNormal = normalize(vec3(-dzu, -dzv * 0.6, 1.0));
}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed.z += clothZ(uv);
vQ = uv; vA = iA; vW = iW; vC1 = iC1; vC2 = iC2;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CLOTH_FRAG_DECL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + CLOTH_FRAG)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.16;');
  };
  m.customProgramCacheKey = () => 'creatorcloth';
  return m;
}

// Building anchors (model space, relative to the footprint centre, +z = front, y up). Positions from render/models.mjs.
//   hang: crossbar + banner hanging from y = top;  mast: tall pole with a flag;  flag: pole from y0 with a logo flag (towers);  pen: pole with a pennant
const ANCHORS = {
  town_center: [{ k: 'mast', x: -2.45, z: 1.7, h: 6.6, w: 3.0, ch: 1.9 }],
  barracks: [{ k: 'hang', x: -1.0, z: 1.3, top: 1.8, w: 1.0, ch: 1.65 }, { k: 'hang', x: 1.0, z: 1.3, top: 1.8, w: 1.0, ch: 1.65 }],
  archery_range: [{ k: 'hang', x: -0.6, z: 0.4, top: 2.1, w: 1.1, ch: 1.8 }],
  stables: [{ k: 'hang', x: -1.0, z: 0.7, top: 1.8, w: 1.0, ch: 1.65 }, { k: 'hang', x: 1.0, z: 0.7, top: 1.8, w: 1.0, ch: 1.65 }],
  siege_workshop: [{ k: 'hang', x: -0.7, z: 1.4, top: 1.85, w: 1.05, ch: 1.7 }, { k: 'hang', x: 0.7, z: 1.4, top: 1.85, w: 1.05, ch: 1.7 }],
  tower: [{ k: 'pen', x: -0.55, z: 0.55, y0: 3.15, h: 1.9, w: 1.15, ch: 0.5 }],
  gate: [{ k: 'pen', x: -0.36, z: 0, y0: 1.5, h: 0.9, w: 0.75, ch: 0.3 }, { k: 'pen', x: 0.36, z: 0, y0: 1.5, h: 0.9, w: 0.75, ch: 0.3 }],
};

// 3D pack (o.inner set): anchors that differ from the classic models; everything else keeps ANCHORS
const ANCHORS3D = {
  tower: [{ k: 'flag', x: -1.1, z: 0.25, y0: 3.4, h: 1.5, w: 1.282, ch: 0.81 }],
  blacksmith: [{ k: 'hang', x: -1.3, z: 0.95, top: 1.8, w: 1.147, ch: 1.35 }],
  barracks: [{ k: 'hang', x: -0.9, z: 1.45, top: 1.9, w: 1.35, ch: 2.228 }],
  stables: [{ k: 'hang', x: -1.1, z: 1.45, top: 1.8, w: 1.35, ch: 2.16 }],
  archery_range: [{ k: 'hang', x: -0.9, z: 1.45, top: 1.8, w: 1.35, ch: 2.16 }],
  siege_workshop: [{ k: 'hang', x: -1.0, z: 1.5, top: 1.9, w: 1.35, ch: 2.16 }],
};

export class Banners {
  // init: the 'init' message (players[].creator, creators{id: {name, logo, primary, secondary, accent}}); renderer for anisotropy
  constructor(scene, init, { renderer, heightAt, hostUnits }) {
    this.hAt = heightAt;
    this.owner = []; // owner (1-based) -> { id, c1, c2, c3, cell }
    const ids = [...new Set(init.players.map((p) => p.creator).filter((id) => id && init.creators && init.creators[id]))];
    this.ids = ids;
    this.enabled = ids.length > 0;
    init.players.forEach((p, i) => {
      const cr = p.creator && init.creators ? init.creators[p.creator] : null;
      this.owner[i + 1] = cr ? { id: p.creator, c1: new THREE.Color(cr.primary), c2: new THREE.Color(cr.secondary), c3: new THREE.Color(cr.accent), cell: ids.indexOf(p.creator) } : null;
    });
    this.n = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = this.n * CELL;
    const g = canvas.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, canvas.width, canvas.height);
    this.atlas = new THREE.CanvasTexture(canvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.generateMipmaps = true;
    this.atlas.minFilter = THREE.LinearMipmapLinearFilter;
    this.atlas.magFilter = THREE.LinearFilter;
    this.atlas.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1;
    this.ready = Promise.all(ids.map((id, i) => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        g.imageSmoothingQuality = 'high';
        g.drawImage(im, (i % this.n) * CELL, Math.floor(i / this.n) * CELL, CELL, CELL);
        this.atlas.needsUpdate = true;
        resolve();
      };
      im.onerror = () => resolve();
      im.src = new URL(init.creators[id].logo, location.href).href;
    })));

    // cloth: unit plane (x 0..1 in uv), per-instance attributes
    const geo = new THREE.PlaneGeometry(1, 1, 16, 10);
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(CAP_CLOTH * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iC1 = new THREE.InstancedBufferAttribute(new Float32Array(CAP_CLOTH * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iC2 = new THREE.InstancedBufferAttribute(new Float32Array(CAP_CLOTH * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iW = new THREE.InstancedBufferAttribute(new Float32Array(CAP_CLOTH * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iA', this.iA); geo.setAttribute('iC1', this.iC1); geo.setAttribute('iC2', this.iC2); geo.setAttribute('iW', this.iW);
    this.cloth = new THREE.InstancedMesh(geo, clothMaterial(this.atlas), CAP_CLOTH);
    this.cloth.frustumCulled = false; this.cloth.count = 0; this.cloth.castShadow = false; this.cloth.receiveShadow = true;
    this.cloth.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cloth.userData.noAO = true;
    const pg = new THREE.CylinderGeometry(1, 1, 1, 6, 1).translate(0, 0.5, 0);
    this.poles = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.1 }), CAP_POLE);
    this.poles.frustumCulled = false; this.poles.count = 0; this.poles.castShadow = true; this.poles.receiveShadow = true;
    this.poles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.poles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_POLE * 3), 3).setUsage(THREE.DynamicDrawUsage);
    scene.add(this.cloth, this.poles);

    this.nc = 0; this.np = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0); this._d = new THREE.Vector3();
    this.WOOD = new THREE.Color(0x6b4a2c); this.IRON = new THREE.Color(0x4a4f58);
    this.bearers = []; // visual only: { owner, x, z, ang, ph, mv, age, gone }
    this.bearerNext = 1;
  }

  of(owner) { return this.owner[owner] || null; }

  begin() { this.nc = 0; this.np = 0; }
  end() {
    this.cloth.count = this.nc; this.poles.count = this.np;
    this.cloth.instanceMatrix.needsUpdate = true;
    this.iA.needsUpdate = this.iC1.needsUpdate = this.iC2.needsUpdate = this.iW.needsUpdate = true;
    this.poles.instanceMatrix.needsUpdate = true; this.poles.instanceColor.needsUpdate = true;
  }

  // cloth with its attachment point at (x,y,z). mode 0: flag / pennant, extends along yaw; mode 1: hangs down from the point.
  // w x h in tiles (before the unit scale), shape 1..3, withLogo, amp: wave amplitude (fraction of the width)
  cloth_(owner, shape, mode, x, y, z, yaw, w, h, amp, seed, withLogo = true) {
    const o = this.owner[owner];
    if (!o || this.nc >= CAP_CLOTH) return;
    const i = this.nc++;
    const q = this._q.setFromAxisAngle(this._up, yaw), p = this._p, s = this._s;
    if (mode === 0) p.set(x + Math.cos(yaw) * w * 0.5, y, z - Math.sin(yaw) * w * 0.5); // plane centre; local +x -> (cos, 0, -sin)
    else p.set(x, y - h * 0.5, z);
    s.set(w, h, w);
    this._m.compose(p, q, s);
    this.cloth.setMatrixAt(i, this._m);
    const cs = 1 / this.n, cx = o.cell % this.n, cy = Math.floor(o.cell / this.n);
    this.iA.setXYZW(i, cx * cs, 1 - (cy + 1) * cs, withLogo ? cs : 0, shape);
    this.iC1.setXYZ(i, o.c1.r, o.c1.g, o.c1.b);
    this.iC2.setXYZ(i, o.c2.r, o.c2.g, o.c2.b);
    this.iW.setXYZW(i, mode, amp, seed * TAU, w / h);
  }

  // straight bar from (x,y,z) along dir (unit vector), length len, radius r
  bar(x, y, z, dx, dy, dz, len, r, col) {
    if (this.np >= CAP_POLE) return;
    const i = this.np++;
    this._d.set(dx, dy, dz);
    this._q.setFromUnitVectors(this._up, this._d);
    this._m.compose(this._p.set(x, y, z), this._q, this._s.set(r, len, r));
    this.poles.setMatrixAt(i, this._m);
    this.poles.instanceColor.setXYZ(i, col.r, col.g, col.b);
  }

  // ---------- buildings: o = renderer building record { name, owner, tx, ty, size, prog, grp }; collapsing: skip prog check
  building(o, collapsing) {
    const list = (o.inner && (o.bannerAnchors || ANCHORS3D[o.name])) || ANCHORS[o.name]; // 3D pack: per model id from MAP.json overrides.<id>.banner
    const own = this.owner[o.owner];
    if (!own || (!collapsing && o.prog < 100)) return;
    const gp = o.grp.position, gs = o.grp.scale, key = o.tx * 73 + o.ty * 31;
    if (list) {
      list.forEach((a, k) => {
        const seed = hash(key + k * 7);
        const px = gp.x + a.x * gs.x, pz = gp.z + a.z * gs.z;
        if (a.k === 'mast') {
          const gy = collapsing ? gp.y : this.hAt(px, pz);
          const top = gy + a.h * gs.y;
          this.bar(px, gy, pz, 0, 1, 0, a.h * gs.y, 0.07, this.WOOD);
          this.cloth_(o.owner, 2, 0, px + 0.03, top - 0.1, pz, WIND + (seed - 0.5) * 0.3, a.w, a.ch, 0.2, seed);
        } else if (a.k === 'hang') {
          const top = gp.y + a.top * gs.y;
          const dx = Math.cos(WIND), dz = -Math.sin(WIND); // the cloth plane faces the default camera; the crossbar runs along it
          this.bar(px - dx * a.w * 0.58, top + 0.04, pz - dz * a.w * 0.58, dx, 0, dz, a.w * 1.16, 0.035, this.WOOD);
          this.bar(px + 0.06, gp.y, pz - 0.06, 0, 1, 0, a.top * gs.y + 0.04, 0.03, this.WOOD); // post behind the cloth
          this.cloth_(o.owner, 1, 1, px, top, pz, WIND, a.w, a.ch * gs.y, 0.05, seed);
        } else if (a.k === 'flag') { // tower top: pole with a logo flag in the creator colours (the pennant of the other kinds has no logo)
          const gy = gp.y + a.y0 * gs.y, top = gy + a.h * gs.y;
          this.bar(px, gy, pz, 0, 1, 0, a.h * gs.y, 0.035, this.WOOD);
          this.cloth_(o.owner, 2, 0, px + 0.02, top - 0.06, pz, WIND + (seed - 0.5) * 0.3, a.w, a.ch, 0.22, seed);
        } else {
          const gy = gp.y + a.y0 * gs.y, top = gy + a.h * gs.y;
          this.bar(px, gy, pz, 0, 1, 0, a.h * gs.y, 0.03, this.WOOD);
          this.cloth_(o.owner, 3, 0, px + 0.02, top - 0.08, pz, WIND + (seed - 0.5) * 0.5, a.w, a.ch, 0.25, seed, false);
        }
      });
    } else if (o.name === 'wall') {
      const hsh = hash(key);
      if ((o.tx * 5 + o.ty * 3) % 4 === 0) {
        const gy = gp.y + 1.3 * gs.y, top = gy + 0.75;
        this.bar(gp.x, gy, gp.z, 0, 1, 0, 0.75, 0.025, this.WOOD);
        this.cloth_(o.owner, 3, 0, gp.x + 0.02, top - 0.05, gp.z, WIND + (hsh - 0.5) * 0.5, 0.62, 0.26, 0.25, hsh, false);
      }
    }
  }

  // ---------- cavalry: pennant at the lance tip. M = unit matrix (position, lean/yaw/roll, scale).
  lance(M, owner, seed, heavy) {
    if (!this.owner[owner]) return;
    const p = this._p.set(0.2, heavy ? 1.36 : 1.16, heavy ? 1.06 : 0.88).applyMatrix4(M);
    const e = M.elements, sc = Math.hypot(e[0], e[1], e[2]);
    const yaw = Math.atan2(e[8], e[10]) + Math.PI / 2; // local +x of the cloth points back along the lance (-z of the unit)
    const x = p.x, y = p.y, z = p.z;
    this.cloth_(owner, 3, 0, x, y, z, yaw, 0.8 * sc, 0.3 * sc, 0.3, hash(seed), false);
  }

  // ---------- banner bearers: one per group of military units (cosmetic, not a sim unit)
  // units: array of [owner, x, z] (non-worker, non-siege); starts: init.starts; dt in seconds (fixed per frame in the broadcast)
  updateBearers(units, starts, dt) {
    const R2 = 7.5 * 7.5;
    const byOwner = new Map();
    for (const u of units) { if (!this.owner[u[0]]) continue; if (!byOwner.has(u[0])) byOwner.set(u[0], []); byOwner.get(u[0]).push(u); }
    const groups = [];
    for (const [owner, us] of byOwner) {
      const par = us.map((_, i) => i);
      const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
      // single linkage on a coarse grid (cell = radius): neighbours within R
      const cell = new Map();
      us.forEach((u, i) => { const k = Math.floor(u[1] / 7.5) * 4096 + Math.floor(u[2] / 7.5); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(i); });
      us.forEach((u, i) => {
        const cx = Math.floor(u[1] / 7.5), cz = Math.floor(u[2] / 7.5);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const j of cell.get((cx + dx) * 4096 + cz + dz) || []) {
          if (j <= i) continue;
          const d2 = (us[j][1] - u[1]) ** 2 + (us[j][2] - u[2]) ** 2;
          if (d2 <= R2) par[find(j)] = find(i);
        }
      });
      const comp = new Map();
      us.forEach((u, i) => { const r = find(i); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(u); });
      const mine = [];
      for (const m of comp.values()) {
        if (m.length < 3) continue;
        let sx = 0, sz = 0;
        for (const u of m) { sx += u[1]; sz += u[2]; }
        mine.push({ owner, n: m.length, x: sx / m.length, z: sz / m.length });
      }
      mine.sort((a, b) => b.n - a.n || a.x - b.x || a.z - b.z);
      groups.push(...mine.slice(0, 3));
    }
    // match persistent bearers to groups (nearest first, within 20 tiles); a bearer whose group is gone shrinks away after 0.7 s
    const used = new Set();
    const pairs = [];
    this.bearers.forEach((b, bi) => groups.forEach((g, gi) => { if (g.owner === b.owner) pairs.push([Math.hypot(b.tx - g.x, b.tz - g.z), bi, gi]); }));
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const matched = new Map();
    for (const [d, bi, gi] of pairs) { if (d > 20 || matched.has(bi) || used.has(gi)) continue; matched.set(bi, gi); used.add(gi); }
    this.bearers.forEach((b, bi) => { b.lost = matched.has(bi) ? 0 : b.lost + dt; if (matched.has(bi)) { const g = groups[matched.get(bi)]; b.gx = g.x; b.gz = g.z; } });
    groups.forEach((g, gi) => {
      if (used.has(gi)) return;
      this.bearers.push({ id: this.bearerNext++, owner: g.owner, x: NaN, z: 0, tx: g.x, tz: g.z, gx: g.x, gz: g.z, ang: 0, ph: 0, mv: 0, lost: 0, age: 0 });
    });
    this.bearers = this.bearers.filter((b) => b.lost < 0.7);
    for (const b of this.bearers) {
      const st = starts[b.owner - 1], en = starts[b.owner === 1 ? 1 : 0] || st;
      // stand a little behind the group (toward its own base)
      let bx = b.gx, bz = b.gz;
      if (st) { const dx = st.tx - bx, dz = st.ty - bz, d = Math.hypot(dx, dz) || 1; bx += (dx / d) * 1.6; bz += (dz / d) * 1.6; }
      b.tx = bx; b.tz = bz;
      b.age += dt;
      if (Number.isNaN(b.x)) { b.x = bx; b.z = bz; if (en && st) b.ang = Math.atan2(en.tx - st.tx, en.ty - st.ty); }
      const dist = Math.hypot(bx - b.x, bz - b.z);
      if (dist > 14) { b.x = bx; b.z = bz; b.mv = 0; continue; }
      const k = 1 - Math.exp(-dt * 4.5), mx = (bx - b.x) * k, mz = (bz - b.z) * k, step = Math.hypot(mx, mz);
      b.x += mx; b.z += mz;
      const moving = step / dt > 0.35;
      b.mv += ((moving ? 1 : 0) - b.mv) * (1 - Math.exp(-dt * 9));
      if (step > 0) b.ph += Math.min(step / 1.05 * TAU, 1.0);
      let want = b.ang;
      if (moving) want = Math.atan2(mx, mz);
      else if (en) want = Math.atan2(en.tx - b.x, en.ty - b.z);
      let da = want - b.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
      b.ang += da * (1 - Math.exp(-dt * 8));
    }
    return this.bearers;
  }

  // pole + cloth of one bearer; (x,y,z) = ground point of the bearer, s = unit scale
  bearerBanner(b, gy, s, fade) {
    const sa = Math.sin(b.ang), ca = Math.cos(b.ang);
    const px = b.x + (ca * 0.26 + sa * 0.1) * s, pz = b.z + (-sa * 0.26 + ca * 0.1) * s; // right hand
    const top = gy + 4.1 * fade;
    this.bar(px, gy + 0.3 * s, pz, 0, 1, 0, top - gy - 0.3 * s, 0.045, this.WOOD);
    const seed = hash(b.id * 13 + 5);
    this.bar(px - Math.cos(WIND) * 0.62, top - 0.02, pz + Math.sin(WIND) * 0.62, Math.cos(WIND), 0, -Math.sin(WIND), 1.24, 0.03, this.WOOD); // crossbar along the cloth plane
    this.cloth_(b.owner, 1, 1, px, top - 0.05, pz, WIND, 1.2 * fade, 1.75 * fade, 0.07, seed);
  }
}
