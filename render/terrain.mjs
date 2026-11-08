// Terrain: smooth height field (rolling hills, plateaus under buildings, raised cliffs, shallow banks),
// vertex-coloured ground with worn paths, soft water, instanced trees and decoration.
// Visual only: the sim stays a flat grid. Everything is deterministic (hash noise from the map seed, no Math.random).
import * as THREE from './vendor/three.module.js';
import { treeModel } from './models.mjs';
import { waterLook } from './theme/ground-theme.mjs'; // package C5A: the water colours of a theme (the classic ones without a theme)

const WL = -0.36;        // water surface height
export const WATER_T = { value: 0 }; // animation clock for the shore foam (render/world-fx.mjs sets it)
export const WET = { value: 0 }; // weather: rain wets the ground (render/world-fx.mjs sets it): darker, glossier
const SUB = 2;           // vertices per tile
export const hash = (x, y, s = 0) => {
  let h = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
// smooth value noise on a hashed lattice
export function vnoise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// ---- public height query (tile coordinates). Stub (0) until buildTerrain has run. ----
let _T = null;
export function heightAt(x, z) { return _T ? _T.heightAt(x, z) : 0; }
// ground normal (unit vector) at a tile position, handy for tilting props
export function normalAt(x, z) {
  const e = 0.35, hx = heightAt(x - e, z) - heightAt(x + e, z), hz = heightAt(x, z - e) - heightAt(x, z + e);
  const l = Math.hypot(hx, 2 * e, hz);
  return [hx / l, 2 * e / l, hz / l];
}
const changeListeners = [];
export function onHeightsChanged(fn) { changeListeners.push(fn); }

function blur(arr, n, r, passes) {
  const tmp = new Float32Array(arr.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) {
      const o = j * n;
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) { const ii = i + k; if (ii < 0 || ii >= n) continue; s += arr[o + ii]; c++; }
        tmp[o + i] = s / c;
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) { const jj = j + k; if (jj < 0 || jj >= n) continue; s += tmp[jj * n + i]; c++; }
        arr[j * n + i] = s / c;
      }
    }
  }
  return arr;
}

const col = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const PAL = {
  grassA: col(0x275f2f), grassB: col(0x387637), grassC: col(0x558838), grassD: col(0x728b3e),
  forest: col(0x1f4528), forestB: col(0x3a3a24),
  sand: col(0xb9a874), sandWet: col(0x8c805c), sandDry: col(0xcdbd86),
  seabedDeep: col(0x142f45),
  dirt: col(0x8d6c45), dirtB: col(0x74563a), soil: col(0x5f4229),
  rockA: col(0x4a5262), rockB: col(0x7a8294), rockWarm: col(0x6e6458),
  skirt: col(0x1a2029),
};

// 3D pack: tiling ground textures modulate the vertex colours (texture / its mean colour, so hue and brightness of the stylised
// terrain stay; only the detail comes from the texture). Layers: three grass variants, forest floor, sand, dirt path, rock, field soil.
function groundShader(sh, G) {
  const names = ['grass_a', 'grass_b', 'grass_c', 'forest', 'sand', 'dirt', 'rock', 'field'];
  names.forEach((n, i) => { sh.uniforms['tG' + i] = { value: G.tex[n] }; });
  sh.uniforms.uMean = { value: names.map((n) => G.mean[n]) };
  sh.uniforms.uDet = G.det;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 aSplat; attribute float aSplat2; varying vec4 vSp; varying float vSp2;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSp = aSplat; vSp2 = aSplat2;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec4 vSp; varying float vSp2; uniform float uDet; uniform vec3 uMean[8];
${names.map((n, i) => `uniform sampler2D tG${i};`).join(' ')}
vec3 dtex(sampler2D t, vec2 uv, vec3 m){ vec3 c = texture2D(t, uv).rgb / m; float l = dot(c, vec3(0.299, 0.587, 0.114)); return mix(vec3(l), c, 0.25); }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 gp = vWP.xz;
  float vs = vn(gp * 0.045), vs2 = vn(gp * 0.031 + 17.0);
  vec3 gA = dtex(tG0, gp * 0.21, uMean[0]), gB = dtex(tG1, gp * 0.19 + 0.37, uMean[1]), gC = dtex(tG2, gp * 0.17 + 0.71, uMean[2]);
  vec3 g = mix(mix(gA, gB, smoothstep(0.35, 0.55, vs)), gC, smoothstep(0.6, 0.8, vs2));
  g *= mix(vec3(1.0), dtex(tG0, gp * 0.047 + 0.3, uMean[0]), 0.5);
  vec3 dt = g;
  dt = mix(dt, dtex(tG3, gp * 0.23, uMean[3]), clamp(vSp.x, 0.0, 1.0));
  dt = mix(dt, dtex(tG4, gp * 0.26, uMean[4]), clamp(vSp.y, 0.0, 1.0));
  dt = mix(dt, dtex(tG7, gp * 0.3, uMean[7]), clamp(vSp2, 0.0, 1.0));
  dt = mix(dt, dtex(tG5, gp * 0.3, uMean[5]), clamp(vSp.z, 0.0, 1.0));
  dt = mix(dt, dtex(tG6, gp * 0.2, uMean[6]), clamp(vSp.w, 0.0, 1.0));
  diffuseColor.rgb *= mix(vec3(1.0), clamp(dt, 0.35, 2.2), uDet);
}`);
}

export function buildTerrain(size, rows, opts = {}) {
  const seed = (opts.seed | 0) + 17;
  const bio = opts.biome || null; // render/biomes.mjs: palette and ground textures of the map type (null = the original meadow look)
  const P = bio && bio.pal ? { ...PAL, ...bio.pal } : PAL;
  const code = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? -1 : '.f~#'.indexOf(rows[y][x]));
  const NV = size * SUB + 1, NC = NV - 1, NVV = NV * NV;
  const vx = (i) => i / SUB;

  // ---- static masks at vertex resolution ----
  const mWater = new Float32Array(NVV), mCliff = new Float32Array(NVV), mForest = new Float32Array(NVV);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
    let w = 0, c = 0, f = 0, n = 0;
    for (let dj = -1; dj <= 0; dj++) for (let di = -1; di <= 0; di++) {
      const ci = clamp(i + di, 0, NC - 1), cj = clamp(j + dj, 0, NC - 1);
      const cd = code(ci >> 1, cj >> 1); n++;
      if (cd === 2) w++; else if (cd === 3) c++; else if (cd === 1) f++;
    }
    const k = j * NV + i;
    mWater[k] = w / n; mCliff[k] = c / n; mForest[k] = f / n;
  }
  const mSandWide = blur(Float32Array.from(mWater), NV, 3, 2);
  blur(mWater, NV, 2, 3);
  blur(mCliff, NV, 1, 1);
  blur(mForest, NV, 2, 2);

  // start areas stay flat (plateau under every start)
  const starts = (opts.starts || []).map((s) => [s.tx + 2, s.ty + 2]);
  const startFlat = (x, z) => {
    let d = 1e9;
    for (const [sx, sz] of starts) d = Math.min(d, Math.hypot(x - sx, z - sz));
    return sstep(11, 20, d);
  };

  // ---- base height field ----
  const base = new Float32Array(NVV);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
    const x = vx(i), z = vx(j), k = j * NV + i;
    const q = 0.62 * vnoise(x / 26, z / 26, seed) + 0.28 * vnoise(x / 11, z / 11, seed + 1) + 0.10 * vnoise(x / 4.5, z / 4.5, seed + 2);
    let hill = 2.6 * sstep(0.44, 0.86, q) + 0.1 * sstep(0.38, 0.6, q) * vnoise(x / 2.6, z / 2.6, seed + 3);
    hill *= startFlat(x, z);
    hill *= 1 - sstep(0.0, 0.55, mWater[k]);
    const ct = 1.7 + 0.8 * vnoise(x * 0.45, z * 0.45, seed + 4) + 0.35 * vnoise(x * 1.7, z * 1.7, seed + 5);
    const cm = sstep(0.22, 0.72, mCliff[k]);
    let h = lerp(hill, ct + hill * 0.25, cm);
    h = lerp(h, -1.5 - 0.2 * vnoise(x / 3, z / 3, seed + 6), sstep(0.1, 0.9, mWater[k]));
    base[k] = h;
  }
  const H = Float32Array.from(base);

  // ---- plateaus (building footprints, nodes), applied on top of the base field ----
  const plateaus = []; // {x0,z0,x1,z1,h,m}
  const baseAtTile = (cx, cz) => {
    const i = clamp(Math.round(cx * SUB), 0, NV - 1), j = clamp(Math.round(cz * SUB), 0, NV - 1);
    return base[j * NV + i];
  };
  function addPlateau(tx, ty, sz, margin) {
    const cx = tx + sz / 2, cz = ty + sz / 2;
    const hh = (baseAtTile(cx, cz) + baseAtTile(tx, ty) + baseAtTile(tx + sz, ty) + baseAtTile(tx, ty + sz) + baseAtTile(tx + sz, ty + sz)) / 5;
    plateaus.push({ x0: tx, z0: ty, x1: tx + sz, z1: ty + sz, h: Math.max(0, hh), m: margin });
  }
  function applyPlateaus(list) {
    for (const p of list) {
      const i0 = clamp(Math.floor((p.x0 - p.m) * SUB), 0, NV - 1), i1 = clamp(Math.ceil((p.x1 + p.m) * SUB), 0, NV - 1);
      const j0 = clamp(Math.floor((p.z0 - p.m) * SUB), 0, NV - 1), j1 = clamp(Math.ceil((p.z1 + p.m) * SUB), 0, NV - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = vx(i), z = vx(j);
        const dx = Math.max(p.x0 - x, 0, x - p.x1), dz = Math.max(p.z0 - z, 0, z - p.z1);
        const w = 1 - sstep(0, p.m, Math.hypot(dx, dz));
        if (w <= 0) continue;
        const k = j * NV + i;
        if (base[k] < WL - 0.2 || mCliff[k] > 0.5) continue; // never lift water / cliff
        H[k] = lerp(H[k], p.h, w);
      }
    }
  }
  for (const nd of opts.nodes || []) addPlateau(nd[2], nd[3], nd[4], 1.0);
  for (const [sx, sz] of starts) addPlateau(sx - 2, sz - 2, 4, 3);
  applyPlateaus(plateaus);

  // ---- exact height query: same triangulation as the mesh ----
  function heightAtXZ(x, z) {
    const fxv = clamp(x * SUB, 0, NC - 1e-6), fzv = clamp(z * SUB, 0, NC - 1e-6);
    const i = Math.floor(fxv), j = Math.floor(fzv), fx = fxv - i, fz = fzv - j;
    const a = H[j * NV + i], b = H[j * NV + i + 1], c = H[(j + 1) * NV + i], d = H[(j + 1) * NV + i + 1];
    return fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (c - a) * fz + (d - c) * fx;
  }

  // ---- geometry ----
  const nSkirt = 4 * NV * 2;
  const pos = new Float32Array((NVV + nSkirt) * 3), nor = new Float32Array((NVV + nSkirt) * 3), colA = new Float32Array((NVV + nSkirt) * 3);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) { const k = (j * NV + i) * 3; pos[k] = vx(i); pos[k + 2] = vx(j); nor[k + 1] = 1; }
  const idx = new Uint32Array(NC * NC * 6 + 4 * NC * 6);
  let ni = 0;
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) {
    const a = j * NV + i, b = a + 1, c = a + NV, d = c + 1;
    idx[ni++] = a; idx[ni++] = c; idx[ni++] = d; idx[ni++] = a; idx[ni++] = d; idx[ni++] = b;
  }
  // skirt: 4 sides, each NV top vertices (copy of the edge) + NV bottom vertices
  const skirtTop = []; // [skirt vertex, grid index]
  const edgeIdx = [(t) => [t, 0, 0, -1], (t) => [t, NC, 0, 1], (t) => [0, t, -1, 0], (t) => [NC, t, 1, 0]];
  edgeIdx.forEach((f, side) => {
    const o = NVV + side * NV * 2;
    for (let t = 0; t < NV; t++) {
      const [ii, jj, nx, nz] = f(t);
      const top = o + t, bot = o + NV + t;
      pos[bot * 3] = pos[top * 3] = vx(ii); pos[bot * 3 + 2] = pos[top * 3 + 2] = vx(jj);
      pos[bot * 3 + 1] = -3.2;
      nor[top * 3] = nor[bot * 3] = nx; nor[top * 3 + 2] = nor[bot * 3 + 2] = nz;
      colA.set([0.05, 0.07, 0.09], bot * 3);
      skirtTop.push([top, jj * NV + ii]);
    }
    const flip = side === 0 || side === 3;
    for (let t = 0; t < NC; t++) {
      const a = o + t, b = o + t + 1, c = o + NV + t, d = o + NV + t + 1;
      const q = flip ? [a, b, d, a, d, c] : [a, d, b, a, c, d];
      for (const v of q) idx[ni++] = v;
    }
  });
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3), norAttr = new THREE.BufferAttribute(nor, 3), colAttr = new THREE.BufferAttribute(colA, 3);
  geo.setAttribute('position', posAttr); geo.setAttribute('normal', norAttr); geo.setAttribute('color', colAttr);
  // ground texture splat weights (only used with the 3D asset pack: opts.ground): forest floor, sand, dirt path, rock | soil
  let G3 = opts.ground || null;
  if (G3 && bio && bio.tex) { // desert, winter: the three grass layers use sand, mud or snow textures (the shader keeps hue and brightness of the vertex colours)
    const t = { ...G3.tex }, mn = { ...G3.mean };
    for (const [k, v] of Object.entries(bio.tex)) if (G3.tex[v] && !(G3.own && G3.own.has(k))) { t[k] = G3.tex[v]; mn[k] = G3.mean[v]; } // (a layer the theme names itself is not swapped)
    G3 = { ...G3, tex: t, mean: mn };
  }
  const spA = G3 ? new Float32Array((NVV + nSkirt) * 4) : null, spB = G3 ? new Float32Array(NVV + nSkirt) : null;
  const spAttr = G3 ? new THREE.BufferAttribute(spA, 4) : null, spBAttr = G3 ? new THREE.BufferAttribute(spB, 1) : null;
  if (G3) { geo.setAttribute('aSplat', spAttr); geo.setAttribute('aSplat2', spBAttr); }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(size / 2, 0, size / 2), size * 0.8);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, -3.3, 0), new THREE.Vector3(size, 4, size));

  // ---- static colour layers ----
  const grassRGB = new Float32Array(NVV * 3), nz1 = new Float32Array(NVV);
  for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
    const x = vx(i), z = vx(j), k = j * NV + i;
    const n1 = vnoise(x / 9, z / 9, seed + 20), n2 = vnoise(x / 3.2, z / 3.2, seed + 21), n3 = vnoise(x / 1.1, z / 1.1, seed + 22);
    nz1[k] = n3;
    const t = clamp(0.55 * n1 + 0.3 * n2 + 0.15 * n3, 0, 1);
    let c;
    if (t < 0.45) c = P.grassA.map((v, m) => lerp(v, P.grassB[m], t / 0.45));
    else if (t < 0.65) c = P.grassB.map((v, m) => lerp(v, P.grassC[m], (t - 0.45) / 0.2));
    else c = P.grassC.map((v, m) => lerp(v, P.grassD[m], (t - 0.65) / 0.35));
    const dry = sstep(0.62, 0.8, vnoise(x / 14, z / 14, seed + 23)) * 0.35;
    c = c.map((v, m) => lerp(v, P.grassD[m], dry));
    grassRGB.set(c, k * 3);
  }

  // ---- dynamic state: dirt paths, farm soil, building occupancy ----
  const dirtCur = new Float32Array(NVV), dirtTgt = new Float32Array(NVV), soilW = new Float32Array(NVV);
  const occ = new Uint8Array(size * size);
  const rec = new Map(); // building id -> {name,tx,ty,size,owner}
  const nodes = (opts.nodes || []).map((n) => ({ res: n[1], tx: n[2], ty: n[3], size: n[4] }));
  const forestTiles = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (rows[y][x] === 'f') forestTiles.push([x + 0.5, y + 0.5]);
  const DROP = new Set(['town_center', 'lumber_camp', 'mining_camp', 'mill']);

  const tmpC = [0, 0, 0];
  const mix = (a, b, t) => { tmpC[0] = lerp(a[0], b[0], t); tmpC[1] = lerp(a[1], b[1], t); tmpC[2] = lerp(a[2], b[2], t); };
  const mixInto = (c, b, t) => { c[0] = lerp(c[0], b[0], t); c[1] = lerp(c[1], b[1], t); c[2] = lerp(c[2], b[2], t); };

  const water = buildWater();
  let fading = false;
  const dmark = new Uint8Array(NVV); // scratch for syncBuildings(): vertices already on the dirty list
  function refresh() {
    for (let k = 0; k < NVV; k++) pos[k * 3 + 1] = H[k];
    for (const [s, g] of skirtTop) { pos[s * 3 + 1] = H[g]; pos[(s + NV) * 3 + 1] = H[g] - 0.5; } // thin lip: the far field continues the land past the edge
    for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) {
      const k = j * NV + i;
      const hl = H[j * NV + Math.max(i - 1, 0)], hr = H[j * NV + Math.min(i + 1, NC)];
      const hd = H[Math.max(j - 1, 0) * NV + i], hu = H[Math.min(j + 1, NC) * NV + i];
      const sx = (hl - hr), sz = (hd - hu), sy = 2 / SUB;
      const l = Math.hypot(sx, sy, sz);
      nor[k * 3] = sx / l; nor[k * 3 + 1] = sy / l; nor[k * 3 + 2] = sz / l;
    }
    recolor();
    posAttr.needsUpdate = norAttr.needsUpdate = true;
    water.refresh();
  }
  // The colour of a vertex is a function of that vertex alone (its height, normal, masks, worn path and soil), no blending between neighbours happens here: recolorSome()
  // may therefore redo only the vertices whose inputs changed and still leave exactly the bytes a full recolor() leaves.
  const tc = [0, 0, 0];
  function recolorVertex(i, j, c) {
    {
      const k = j * NV + i, h = H[k], ny = nor[k * 3 + 1];
      const x = vx(i), z = vx(j), n3 = nz1[k];
      c[0] = grassRGB[k * 3]; c[1] = grassRGB[k * 3 + 1]; c[2] = grassRGB[k * 3 + 2];
      const fw = sstep(0.05, 0.7, mForest[k]);
      if (fw > 0) {
        mix(P.forest, P.forestB, sstep(0.45, 0.8, vnoise(x / 2.2, z / 2.2, seed + 30)) * 0.7);
        mixInto(c, tmpC, fw * 0.85);
      }
      const shore = Math.max(1 - sstep(WL + 0.04, WL + 0.42, h), sstep(0.12, 0.55, mSandWide[k]) * 0.85);
      if (shore > 0) {
        mix(P.sandDry, P.sand, 0.5 + n3 * 0.5);
        if (h < WL + 0.18) mix(P.sand, P.sandWet, sstep(WL + 0.18, WL - 0.1, h));
        mixInto(c, tmpC, shore * 0.92);
      }
      if (h < WL) { mix(P.sandWet, P.seabedDeep, sstep(WL, -1.3, h)); mixInto(c, tmpC, sstep(WL + 0.05, WL - 0.25, h)); }
      if (soilW[k] > 0) mixInto(c, P.soil, soilW[k] * 0.9);
      const dw = dirtCur[k];
      if (dw > 0.01) {
        mix(P.dirt, P.dirtB, vnoise(x * 2.3, z * 2.3, seed + 31));
        mixInto(c, tmpC, Math.min(0.95, dw * 1.25));
      }
      const cm = sstep(0.2, 0.6, mCliff[k]), slope = sstep(0.42, 0.74, 1 - ny);
      const rw = Math.max(cm, slope * (h > WL + 0.4 ? 1 : 0.4));
      if (rw > 0.01) {
        const band = 0.5 + 0.5 * Math.sin(h * 6 + vnoise(x * 0.8, z * 0.8, seed + 32) * 5);
        mix(P.rockA, P.rockB, clamp(0.25 + n3 * 0.5 + (ny - 0.3) * 0.5, 0, 1));
        const warm = sstep(0.55, 0.8, vnoise(x / 3, z / 3, seed + 33)) * 0.5;
        tmpC[0] = lerp(tmpC[0], P.rockWarm[0], warm); tmpC[1] = lerp(tmpC[1], P.rockWarm[1], warm); tmpC[2] = lerp(tmpC[2], P.rockWarm[2], warm);
        const d = 0.84 + band * 0.2;
        tmpC[0] *= d; tmpC[1] *= d; tmpC[2] *= d;
        mixInto(c, tmpC, rw);
      }
      if (G3) {
        spA[k * 4] = fw * 0.85; spA[k * 4 + 1] = Math.min(1, shore * 0.92 + (h < WL ? sstep(WL + 0.05, WL - 0.25, h) : 0));
        spA[k * 4 + 2] = Math.min(0.95, dw * 1.25); spA[k * 4 + 3] = rw; spB[k] = soilW[k] * 0.9;
      }
      const tint = 0.95 + clamp(h, 0, 2.5) * 0.03;
      colA[k * 3] = c[0] * tint; colA[k * 3 + 1] = c[1] * tint; colA[k * 3 + 2] = c[2] * tint;
    }
  }
  function recolorDone() {
    for (const [s, g] of skirtTop) for (const q of [s, s + NV]) { colA[q * 3] = colA[g * 3] * 0.9; colA[q * 3 + 1] = colA[g * 3 + 1] * 0.9; colA[q * 3 + 2] = colA[g * 3 + 2] * 0.85; }
    colAttr.needsUpdate = true;
    if (G3) { spAttr.needsUpdate = true; spBAttr.needsUpdate = true; }
  }
  function recolor() {
    for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) recolorVertex(i, j, tc);
    recolorDone();
  }
  // only the given vertex numbers (k = j * NV + i)
  function recolorSome(list) {
    for (const k of list) recolorVertex(k % NV, (k / NV) | 0, tc);
    recolorDone();
  }

  const NOISE_GLSL = `
varying vec3 vWP;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }`;
  const patch = (sh, body) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + NOISE_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + body);
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    patch(sh, `{ float n = 0.55 * vn(vWP.xz * 3.1) + 0.3 * vn(vWP.xz * 7.7) + 0.15 * vn(vWP.xz * 19.0);
  float big = vn(vWP.xz * 0.21);
  diffuseColor.rgb *= (${G3 ? '0.92 + 0.16' : '0.86 + 0.28'} * n) * (0.94 + 0.12 * big);
  // golden-afternoon macro tint: broad sun-dried yellow and cooler lush patches, so the meadow is not one flat green
  float mt = smoothstep(0.30, 0.72, vn(vWP.xz * 0.034 + 5.0) * 0.65 + vn(vWP.xz * 0.011) * 0.35);
  diffuseColor.rgb *= mix(vec3(0.99, 1.0, 0.92), vec3(0.88, 1.03, 0.98), mt); }`);
    if (G3) groundShader(sh, G3);
    // rain: wet ground is darker and glossy (the sun and the sky glint in it)
    sh.uniforms.uWet = WET;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uWet;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.28, uWet * 0.85);')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 - 0.24 * uWet;');
  };
  mat.customProgramCacheKey = () => (G3 ? 'ground3d' : 'ground-classic');
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.name = 'terrain';

  // ---- water: same grid, alpha from depth, only where the base field dips near the surface ----
  function buildWater() {
    const widx = [];
    for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) {
      const a = j * NV + i, b = a + 1, c = a + NV, d = c + 1;
      if (Math.min(base[a], base[b], base[c], base[d]) > WL + 0.5) continue;
      widx.push(a, c, d, a, d, b);
    }
    const wpos = new Float32Array(NVV * 3), wcol = new Float32Array(NVV * 4), nrm = new Float32Array(NVV * 3);
    for (let k = 0; k < NVV; k++) { wpos[k * 3] = vx(k % NV); wpos[k * 3 + 1] = WL; wpos[k * 3 + 2] = vx((k / NV) | 0); nrm[k * 3 + 1] = 1; }
    const g = new THREE.BufferGeometry();
    const ca = new THREE.BufferAttribute(wcol, 4);
    g.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', ca);
    g.setIndex(widx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(size / 2, 0, size / 2), size * 0.8);
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.6, roughness: 0.12, metalness: 0.15, depthWrite: false });
    m.onBeforeCompile = (sh) => {
      patch(sh, `{ float r = vn(vWP.xz * 1.6) * 0.6 + vn(vWP.xz * 4.3) * 0.4; diffuseColor.rgb *= 0.9 + 0.2 * r;
  // living water: foam lines wash up the shore (vertex alpha is the depth), glints drift over the deep part
  float dp = vColor.a;
  float shore = 1.0 - smoothstep(0.30, 0.78, dp);
  float wave = 0.5 + 0.5 * sin(uWT * 1.3 - dp * 16.0 + vn(vWP.xz * 0.9) * 5.0);
  float fm = shore * smoothstep(0.35, 0.95, wave * (0.55 + 0.6 * vn(vWP.xz * 2.7 + uWT * 0.15)));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.97, 0.98), fm * 0.55);
  diffuseColor.rgb *= mix(1.0, 0.82, smoothstep(0.7, 1.0, dp)); // deeper = darker
  diffuseColor.rgb += vec3(0.05, 0.07, 0.08) * smoothstep(0.75, 0.9, vn(vWP.xz * 3.3 + vec2(uWT * 0.35, -uWT * 0.2))) * smoothstep(0.5, 0.9, dp); }`);
      sh.uniforms.uWT = WATER_T;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uWT;');
    };
    const wm = new THREE.Mesh(g, m);
    wm.renderOrder = 1;
    wm.userData.baseOpacity = 0.6;
    const deep = col(0x123f63), shallow = col(0x4fb0cf), foam = col(0xe6f4f7);
    const W = waterLook(bio, { deep, shallow, foam, opacity: 0.6 }); // the water of the theme (render/theme/ground-theme.mjs); exactly the three colours above and 0.6 without one
    if (W.opacity !== 0.6) m.opacity = wm.userData.baseOpacity = W.opacity;
    return {
      mesh: wm,
      refresh() {
        const { deep, shallow, foam } = W; // (the classic constants above, or the theme's)
        for (let k = 0; k < NVV; k++) {
          const depth = WL - H[k];
          const t = Math.exp(-Math.max(depth, 0) * 1.5);
          const f = (1 - sstep(0.0, 0.1, Math.abs(depth - 0.02))) * 0.7;
          wcol[k * 4] = lerp(lerp(deep[0], shallow[0], t), foam[0], f);
          wcol[k * 4 + 1] = lerp(lerp(deep[1], shallow[1], t), foam[1], f);
          wcol[k * 4 + 2] = lerp(lerp(deep[2], shallow[2], t), foam[2], f);
          wcol[k * 4 + 3] = clamp(0.25 + depth * 1.8, 0.0, 1.0);
        }
        ca.needsUpdate = true;
      },
    };
  }

  // ---- worn paths ----
  function stampDisk(arr, cx, cz, r, strength) {
    const i0 = clamp(Math.floor((cx - r) * SUB), 0, NV - 1), i1 = clamp(Math.ceil((cx + r) * SUB), 0, NV - 1);
    const j0 = clamp(Math.floor((cz - r) * SUB), 0, NV - 1), j1 = clamp(Math.ceil((cz + r) * SUB), 0, NV - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(vx(i) - cx, vx(j) - cz);
      if (d > r) continue;
      const k = j * NV + i;
      const w = sstep(r, r * 0.3, d) * strength * (0.72 + 0.28 * nz1[k]);
      if (w > arr[k]) arr[k] = w;
    }
  }
  function drawPath(ax, az, bx, bz, width, strength, salt) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) return;
    const steps = Math.max(2, Math.ceil(len / 0.35));
    const px = -(bz - az) / len, pz = (bx - ax) / len;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const wob = (vnoise(t * len / 5, salt, seed + 40) - 0.5) * 1.6 * Math.sin(Math.PI * t);
      stampDisk(dirtTgt, lerp(ax, bx, t) + px * wob, lerp(az, bz, t) + pz * wob, width, strength);
    }
  }
  function rebuildPaths() {
    dirtTgt.fill(0); soilW.fill(0);
    const list = [...rec.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    const drops = list.filter((b) => DROP.has(b.name));
    const ctr = (b) => [b.tx + b.size / 2, b.ty + b.size / 2];
    for (const n of nodes) {
      if (n.res === 'herd') continue;
      const nx = n.tx + n.size / 2, nz = n.ty + n.size / 2;
      let best = null, bd = 17;
      for (const d of drops) {
        if (n.res === 'berries' && d.name !== 'mill' && d.name !== 'town_center') continue;
        if ((n.res === 'gold' || n.res === 'stone') && d.name !== 'mining_camp' && d.name !== 'town_center') continue;
        const [cx, cz] = ctr(d), dd = Math.hypot(cx - nx, cz - nz);
        if (dd < bd) { bd = dd; best = d; }
      }
      if (best) { const [cx, cz] = ctr(best); drawPath(cx, cz, nx, nz, 1.0, 0.85, n.tx * 7 + n.ty); }
    }
    for (const d of drops) {
      if (d.name !== 'lumber_camp' && d.name !== 'town_center') continue;
      const [cx, cz] = ctr(d);
      const near = [];
      for (const [fx, fz] of forestTiles) { const dd = Math.hypot(fx - cx, fz - cz); if (dd < 15) near.push([dd, fx, fz]); }
      near.sort((a, b) => a[0] - b[0]);
      const picked = [];
      for (const p of near) {
        if (picked.length >= (d.name === 'lumber_camp' ? 3 : 2)) break;
        if (picked.every((q) => Math.hypot(q[1] - p[1], q[2] - p[2]) > 5)) picked.push(p);
      }
      for (const p of picked) drawPath(cx, cz, p[1], p[2], 0.95, 0.8, d.tx * 13 + p[1]);
    }
    for (const b of list) {
      if (b.name === 'wall' || b.name === 'gate' || DROP.has(b.name) || b.name === 'farm') continue;
      let best = null, bd = 16;
      const [bx, bz] = ctr(b);
      for (const d of drops) { if (d.name !== 'town_center' || d.owner !== b.owner) continue; const [cx, cz] = ctr(d); const dd = Math.hypot(cx - bx, cz - bz); if (dd < bd) { bd = dd; best = d; } }
      if (best) { const [cx, cz] = ctr(best); drawPath(cx, cz, bx, bz, b.name === 'house' ? 0.7 : 0.9, b.name === 'house' ? 0.55 : 0.75, b.tx * 5 + b.ty); }
    }
    for (const b of list) {
      if (b.name !== 'farm') continue;
      const [bx, bz] = ctr(b);
      const i0 = clamp(Math.floor((b.tx - 0.7) * SUB), 0, NV - 1), i1 = clamp(Math.ceil((b.tx + b.size + 0.7) * SUB), 0, NV - 1);
      const j0 = clamp(Math.floor((b.ty - 0.7) * SUB), 0, NV - 1), j1 = clamp(Math.ceil((b.ty + b.size + 0.7) * SUB), 0, NV - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = Math.max(b.tx - vx(i), 0, vx(i) - b.tx - b.size), dz = Math.max(b.ty - vx(j), 0, vx(j) - b.ty - b.size);
        const w = 1 - sstep(0.1, 0.65, Math.hypot(dx, dz));
        const k = j * NV + i; if (w > soilW[k]) soilW[k] = w;
      }
      let best = null, bd = 12;
      for (const d of drops) { if (d.name !== 'mill' && d.name !== 'town_center') continue; const [cx, cz] = ctr(d); const dd = Math.hypot(cx - bx, cz - bz); if (dd < bd) { bd = dd; best = d; } }
      if (best) { const [cx, cz] = ctr(best); drawPath(cx, cz, bx, bz, 0.75, 0.55, b.tx * 3 + b.ty); }
    }
  }

  // ---- building sync: call with every snapshot, list of {id,name,tx,ty,size,owner} ----
  function syncBuildings(list) {
    let changed = false, heightsDirty = false;
    const seen = new Set();
    for (const b of list) {
      seen.add(b.id);
      if (rec.has(b.id)) continue;
      rec.set(b.id, { name: b.name, tx: b.tx, ty: b.ty, size: b.size, owner: b.owner });
      changed = true;
      for (let y = b.ty; y < b.ty + b.size; y++) for (let x = b.tx; x < b.tx + b.size; x++) if (x >= 0 && y >= 0 && x < size && y < size) occ[y * size + x] = 1;
      if (b.name !== 'wall' && b.name !== 'gate') { addPlateau(b.tx, b.ty, b.size, b.name === 'farm' ? 1.2 : 1.8); heightsDirty = true; }
    }
    for (const [id, r] of rec) if (!seen.has(id)) {
      rec.delete(id); changed = true;
      for (let y = r.ty; y < r.ty + r.size; y++) for (let x = r.tx; x < r.tx + r.size; x++) if (x >= 0 && y >= 0 && x < size && y < size) occ[y * size + x] = 0;
    }
    if (heightsDirty) { H.set(base); applyPlateaus(plateaus); refresh(); }
    // the vertices whose colour can differ from what the buffer holds: soil that moved with the buildings, paths that are still fading in or out
    const dirty = [];
    const touch = (k) => { if (!dmark[k]) { dmark[k] = 1; dirty.push(k); } };
    if (changed) {
      const soilOld = soilW.slice();
      rebuildPaths(); fading = true;
      for (let k = 0; k < NVV; k++) if (soilW[k] !== soilOld[k]) touch(k);
    }
    if (fading) {
      // ease the worn paths in over a second or so (per snapshot, so replays stay frame-exact)
      let maxd = 0;
      for (let k = 0; k < NVV; k++) {
        const d = dirtTgt[k] - dirtCur[k];
        if (d !== 0) { const was = dirtCur[k]; dirtCur[k] += d * 0.22; if (Math.abs(d) < 0.01) dirtCur[k] = dirtTgt[k]; maxd = Math.max(maxd, Math.abs(d)); if (dirtCur[k] !== was) touch(k); }
      }
      if (opts.fullRecolor) recolor(); else if (dirty.length) recolorSome(dirty); // same bytes either way (test/terrain-recolor.test.mjs); only the changed vertices cost time while watching live
      if (maxd < 0.01) fading = false;
    }
    for (const k of dirty) dmark[k] = 0;
    if (heightsDirty || changed || fading) for (const fn of changeListeners) fn(!heightsDirty);
  }

  const api = {
    ground: G3, mesh, water: water.mesh, code, heightAt: heightAtXZ, height: heightAtXZ, syncBuildings, occ, size, recolorAll: recolor, // recolorAll: the full recolor, for the test that compares it with the incremental one
    dirtAt: (x, z) => dirtCur[clamp(Math.round(z * SUB), 0, NV - 1) * NV + clamp(Math.round(x * SUB), 0, NV - 1)],
    // colour of one tile for the minimap, [r,g,b] 0..255 including a simple hillshade
    miniRGB(tx, ty) {
      const k = clamp(Math.round((ty + 0.5) * SUB), 0, NV - 1) * NV + clamp(Math.round((tx + 0.5) * SUB), 0, NV - 1);
      if (H[k] < WL) { const t = sstep(WL, -1.3, H[k]); return [lerp(60, 22, t) | 0, lerp(140, 70, t) | 0, lerp(180, 112, t) | 0]; }
      const sh = 0.85 + 0.5 * clamp(nor[k * 3] * -0.45 + nor[k * 3 + 2] * -0.35 + 0.25, 0, 1);
      return [clamp(colA[k * 3] * 255 * sh * 1.1, 0, 255) | 0, clamp(colA[k * 3 + 1] * 255 * sh * 1.1, 0, 255) | 0, clamp(colA[k * 3 + 2] * 255 * sh * 1.1, 0, 255) | 0];
    },
  };
  _T = api;
  refresh();
  return api;
}

// Trees on forest tiles: two instanced meshes (trunk + leaves). Returns handles to remove trees.
export function buildTrees(size, rows, wood) {
  const tm = treeModel();
  const tiles = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (rows[y][x] === 'f') tiles.push([x, y]);
  const per = 2;
  const cap = tiles.length * per || 1;
  const trunk = new THREE.InstancedMesh(tm.trunk, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), cap);
  const leaves = new THREE.InstancedMesh(tm.leaves, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), cap);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  const index = new Map(); // tile index -> instance ids
  const inst = [], alive = []; // per instance: x, z, rotY, scale, scaleY
  let n = 0;
  for (const [x, y] of tiles) {
    const ids = [];
    for (let k = 0; k < per; k++) {
      const hx = hash(x, y, 10 + k), hz = hash(x, y, 20 + k), hs = hash(x, y, 30 + k);
      const sc = 1.15 + hs * 0.75;
      inst.push([x + 0.2 + hx * 0.6, y + 0.2 + hz * 0.6, hs * 6.28, sc, sc * (0.9 + hz * 0.3)]);
      alive.push(true);
      col.setHSL(0.31 + (hx - 0.5) * 0.06, 0.45, 0.2 + hs * 0.1);
      leaves.setColorAt(n, col);
      ids.push(n);
      n++;
    }
    index.set(y * size + x, ids);
  }
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const seat = () => {
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const [x, z, ry, sc, scy] = inst[i];
      p.set(x, heightAt(x, z), z);
      e.set(0, ry, 0); q.setFromEuler(e); s.set(sc, scy, sc);
      m.compose(p, q, s);
      trunk.setMatrixAt(i, m); leaves.setMatrixAt(i, m);
    }
    trunk.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
  };
  seat();
  onHeightsChanged((soft) => { if (!soft) seat(); });
  trunk.count = leaves.count = n;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  trunk.castShadow = leaves.castShadow = true;
  const remove = (tile) => {
    const ids = index.get(tile);
    if (!ids) return;
    for (const id of ids) { alive[id] = false; trunk.setMatrixAt(id, zero); leaves.setMatrixAt(id, zero); }
    trunk.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
    index.delete(tile);
  };
  return { trunk, leaves, remove };
}

// Ground cover: grass tufts, flowers, bushes, rocks and pebbles (instanced, seated on the height field,
// hidden where a building or a worn path covers the ground).
export function buildDeco(size, rows, skip = []) {
  const matA = new THREE.MeshStandardMaterial({ roughness: 1 });
  const cl = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? '#' : rows[y][x]);
  const kinds = {
    tuft: { geo: new THREE.ConeGeometry(0.1, 0.28, 4).translate(0, 0.14, 0), list: [], shadow: false },
    flower: { geo: new THREE.SphereGeometry(0.06, 5, 4).translate(0, 0.2, 0), list: [], shadow: false },
    bush: { geo: new THREE.IcosahedronGeometry(0.3, 0).translate(0, 0.2, 0), list: [], shadow: true },
    rock: { geo: new THREE.DodecahedronGeometry(0.22, 0).translate(0, 0.1, 0), list: [], shadow: true },
    pebble: { geo: new THREE.OctahedronGeometry(0.07, 0).translate(0, 0.05, 0), list: [], shadow: false },
  };
  const near = (x, y, ch, r) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (cl(x + i, y + j) === ch) return true; return false; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = rows[y][x];
    if (c === '#' || c === '~') continue;
    const r = hash(x, y, 50), px = x + hash(x, y, 51), pz = y + hash(x, y, 52);
    if (c === '.') {
      if (r < 0.16) kinds.tuft.list.push([px, pz, r]);
      else if (r > 0.97) kinds.pebble.list.push([px, pz, r]);
      if (vnoise(x / 7, y / 7, 91) > 0.62 && hash(x, y, 60) < 0.45) kinds.flower.list.push([x + hash(x, y, 61), y + hash(x, y, 62), hash(x, y, 63)]);
      if (hash(x, y, 70) < (near(x, y, 'f', 2) ? 0.07 : 0.012)) kinds.bush.list.push([x + hash(x, y, 71), y + hash(x, y, 72), hash(x, y, 73)]);
      if (hash(x, y, 80) < (near(x, y, '#', 2) ? 0.09 : 0.008)) kinds.rock.list.push([x + hash(x, y, 81), y + hash(x, y, 82), hash(x, y, 83)]);
    } else if (c === 'f' && hash(x, y, 90) < 0.1) kinds.bush.list.push([x + hash(x, y, 91), y + hash(x, y, 92), hash(x, y, 93)]);
  }
  const meshes = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  const flowerCols = [0xf3d34a, 0xf2f2f2, 0xe3607f, 0xb48cf0, 0xf08a3c];
  for (const name of skip) delete kinds[name];
  for (const [name, k] of Object.entries(kinds)) {
    const im = new THREE.InstancedMesh(k.geo, matA, k.list.length || 1);
    im.userData.kind = name;
    k.list.forEach(([x, z, r], i) => {
      if (name === 'tuft') col.setHSL(0.27 + r * 0.1, 0.45, 0.26 + r * 0.3);
      else if (name === 'flower') col.set(flowerCols[(r * 997 | 0) % flowerCols.length]);
      else if (name === 'bush') col.setHSL(0.3 + r * 0.05, 0.42, 0.17 + r * 0.1);
      else if (name === 'rock') col.setHSL(0.08 + r * 0.05, 0.06, 0.38 + r * 0.14);
      else col.setHSL(0.6, 0.05, 0.45 + r * 0.1);
      im.setColorAt(i, col);
    });
    im.count = k.list.length;
    im.castShadow = k.shadow;
    k.mesh = im;
    meshes.push(im);
  }
  const place = () => {
    const T = _T;
    for (const [name, k] of Object.entries(kinds)) {
      k.list.forEach((it, i) => {
        const [x, z, r] = it;
        const tx = Math.min(size - 1, Math.floor(x)), tz = Math.min(size - 1, Math.floor(z));
        const blocked = T && (T.occ[tz * size + tx] || (name !== 'rock' && name !== 'bush' && T.dirtAt(x, z) > 0.3));
        if (blocked) s.set(0, 0, 0);
        else if (name === 'tuft') s.set(1, 0.7 + r * 3, 1);
        else if (name === 'flower') s.set(1, 0.6 + r * 0.9, 1).multiplyScalar(0.9 + r * 0.5);
        else if (name === 'bush') s.set(1.0 + r * 0.9, 0.7 + r * 0.5, 1.0 + r * 0.7);
        else if (name === 'rock') s.set(0.8 + r * 1.8, 0.7 + r * 1.2, 0.8 + r * 1.5);
        else s.set(1 + r, 1, 1 + r);
        p.set(x, heightAt(x, z) - (name === 'rock' ? 0.04 : 0), z);
        e.set(0, r * 40, name === 'rock' ? r * 0.5 : 0); q.setFromEuler(e);
        m.compose(p, q, s);
        k.mesh.setMatrixAt(i, m);
      });
      k.mesh.instanceMatrix.needsUpdate = true;
    }
  };
  place();
  onHeightsChanged(() => place());
  return meshes;
}
