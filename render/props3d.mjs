// Resource nodes (gold mine, quarry, berry bush, herd) and ground decoration (bushes, ferns, boulders, cliff rocks, camps, ruins)
// from the new 3D models. Placement uses the same hash as the classic deco so maps look the same under both model sets.
import * as THREE from './vendor/three.module.js';
import { hash, vnoise, heightAt, onHeightsChanged } from './terrain.mjs';
import { Scatter } from './scatter.mjs';
import * as ANIM from './anim.mjs';
import { Herd, herdRigged } from './herd.mjs';
import { natureThemed } from './theme/nature-theme.mjs'; // theme: models of the resource nodes and of the ground decoration (classic pack without a theme)

const FACE_CAM = -Math.PI / 4; // default camera looks from -x/+z: model front (+z) turned toward it

// nodes: init.nodes entries [id, res, tx, ty, size, amt, max]. States by remaining fraction.
// env (for the deer): { rows, size, nodes, dust(x, y, z, s), cry(id, x, z) }; with a rigged herd model the herd nodes are living deer (herd.mjs), not scatter items
export function buildNodes(scene, pack, nodes, env = {}) {
  pack = natureThemed(pack);
  const herd = herdRigged(pack) && nodes.some((n) => n[1] === 'herd') ? new Herd(scene, pack, nodes.filter((n) => n[1] === 'herd'), { ...env, nodes }) : null;
  const byKind = {};
  for (const n of nodes) if (!(herd && n[1] === 'herd')) (byKind[n[1]] ||= []).push(n);
  const kinds = {}, byId = new Map();
  for (const [res, list] of Object.entries(byKind)) {
    const states = pack.map.nodes[res]?.states;
    if (!states) continue;
    const sc = states.map((id) => new Scatter(scene, pack, id, list.length, { dist: [40, 90], shadow: [true, true, false], cullPad: 4 }));
    const foot = res === 'gold' || res === 'stone' ? 2 : 1;
    list.forEach((n, i) => {
      const [id, , tx, ty, size, amt] = n;
      const cx = tx + size / 2, cz = ty + size / 2;
      const info = { res, i, sc, cx, cz, foot: size, max: amt, state: -1, ry: res === 'gold' || res === 'stone' ? FACE_CAM + (hash(tx, ty, 5) - 0.5) * 0.5 : hash(tx, ty, 6) * 6.28, ids: states };
      byId.set(id, info);
    });
    kinds[res] = { sc, list };
  }
  // scale needs the loaded model: place when the first state of each kind is ready
  const pending = [];
  for (const [res, k] of Object.entries(kinds)) {
    pending.push(Promise.all(k.sc.map((s) => s.promise)).then(() => {
      for (const n of k.list) {
        const info = byId.get(n[0]);
        const fit = pack.fit(info.ids[0], info.foot);
        info.fit = Math.min(Math.max(fit, 0.5), 1.6);
        place(info, 1);
      }
    }));
  }
  function place(info, frac) {
    const states = info.sc.length;
    const st = states === 3 ? (frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2) : states === 2 ? (frac > 0.5 ? 0 : 1) : 0;
    if (info.state === st) return;
    if (info.state >= 0) info.sc[info.state].setAlive(info.i, false);
    info.state = st;
    const y = heightAt(info.cx, info.cz);
    const s = info.fit * (info.res === 'herd' ? 0.75 + 0.25 * frac : 1);
    info.sc[st].set(info.i, info.cx, y, info.cz, info.ry, s);
  }
  return {
    scatters: Object.values(kinds).flatMap((k) => k.sc),
    herd,
    set(id, frac) { if (herd && herd.has(id)) return herd.set(id, Math.max(0, Math.min(1, frac))); const info = byId.get(id); if (info && info.fit) place(info, Math.max(0, Math.min(1, frac))); },
    remove(id) { if (herd && herd.has(id)) return herd.remove(id); const info = byId.get(id); if (info && info.state >= 0) { info.sc[info.state].setAlive(info.i, false); info.state = -2; } },
    update(camera) { for (const k of Object.values(kinds)) for (const s of k.sc) s.update(camera); },
    get ready() { return Promise.all(herd ? [...pending, herd.ready] : pending); },
  };
}

// deco: bushes and boulders (classic positions), ferns, wild flower clusters, cliff rocks, camps, ruins and single props
export function buildDeco3D(scene, pack, size, rows, starts, T, bio = null) {
  pack = natureThemed(pack, bio && bio.id);
  const D = pack.map.deco, X = pack.map.deco_extra || {}, dk = bio?.deco || {};
  const dm = (k, base) => (dk[k] === undefined ? base : dk[k]); // per map type: how much of each kind of decoration (1 = as on the meadow)
  const cl = (x, y) => (x < 0 || y < 0 || x >= size || y >= size ? '#' : rows[y][x]);
  const near = (x, y, ch, r) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (cl(x + i, y + j) === ch) return true; return false; };
  const awayFromStart = (x, y, d) => (starts || []).every((s) => Math.hypot(x - (s.tx + 2), y - (s.ty + 2)) > d);
  const lists = new Map(); // model id -> [{x,z,ry,s,tint,kind}]
  const add = (id, x, z, ry, s, kind, tint = 1) => { if (id == null) return; s *= pack.ov(id).decoScale ?? 1; tint *= pack.ov(id).decoTint ?? 1; if (!lists.has(id)) lists.set(id, []); lists.get(id).push({ x, z, ry, s, kind, tint }); };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = rows[y][x];
    if (c === '~') continue;
    const r = hash(x, y, 50);
    if (c === '#') {
      if (hash(x, y, 120) < 0.05 && near(x, y, '.', 1)) add(pick(D.cliff, hash(x, y, 121)), x + hash(x, y, 122), y + hash(x, y, 123), hash(x, y, 124) * 6.28, 0.85 + hash(x, y, 125) * 0.6, 'cliff');
      continue;
    }
    if (c === '.') {
      if (D.bush.length && hash(x, y, 70) < (near(x, y, 'f', 2) ? 0.07 : 0.012) * dm('bush', 1)) add(pick(D.bush, hash(x, y, 73)), x + hash(x, y, 71), y + hash(x, y, 72), hash(x, y, 74) * 6.28, 0.8 + hash(x, y, 75) * 0.7, 'bush', 0.85 + hash(x, y, 76) * 0.3);
      // map type extras: cactus, dunes and dry tufts (desert), snow patches (winter), reeds and a wreck at the shore (coast)
      if (dk.cactus && X.cactus && hash(x, y, 150) < dk.cactus) add(X.cactus[0], x + hash(x, y, 151), y + hash(x, y, 152), hash(x, y, 153) * 6.28, 0.8 + hash(x, y, 154) * 0.7, 'cactus', 0.9 + hash(x, y, 155) * 0.2);
      if (dk.dune && X.dune && hash(x, y, 160) < dk.dune) add(X.dune[0], x + hash(x, y, 161), y + hash(x, y, 162), hash(x, y, 163) * 6.28, 1.2 + hash(x, y, 164) * 1.8, 'dune');
      if (dk.dryTuft && X.dryTuft && hash(x, y, 170) < dk.dryTuft) add(X.dryTuft[0], x + hash(x, y, 171), y + hash(x, y, 172), hash(x, y, 173) * 6.28, 0.9 + hash(x, y, 174) * 0.8, 'tuft');
      if (dk.snow && X.snow && hash(x, y, 180) < dk.snow) add(X.snow[0], x + hash(x, y, 181), y + hash(x, y, 182), hash(x, y, 183) * 6.28, 1.0 + hash(x, y, 184) * 1.6, 'snow');
      if (dk.reed && X.reed && near(x, y, '~', 1) && hash(x, y, 190) < dk.reed) add(X.reed[0], x + hash(x, y, 191), y + hash(x, y, 192), hash(x, y, 193) * 6.28, 0.9 + hash(x, y, 194) * 0.7, 'reed');
      if (dk.wreck && X.wreck && near(x, y, '~', 2) && hash(x, y, 195) < dk.wreck) add(X.wreck[0], x + hash(x, y, 196), y + hash(x, y, 197), hash(x, y, 198) * 6.28, 1.0, 'prop');
      if (hash(x, y, 80) < (near(x, y, '#', 2) ? 0.09 : 0.008)) add(pick(D.rock, hash(x, y, 83)), x + hash(x, y, 81), y + hash(x, y, 82), hash(x, y, 84) * 6.28, 0.8 + hash(x, y, 85) * 1.3, 'rock', 0.85 + hash(x, y, 86) * 0.25);
      if (hash(x, y, 130) < (0.012 + (near(x, y, 'f', 2) ? 0.03 : 0)) * dm('fern', 1)) add(pick(D.fern, hash(x, y, 135)), x + hash(x, y, 131), y + hash(x, y, 132), hash(x, y, 133) * 6.28, 0.9 + hash(x, y, 134) * 0.6, 'fern');
      if (D.mushrooms && near(x, y, 'f', 2) && hash(x, y, 150) < 0.022) add(D.mushrooms[0], x + hash(x, y, 151), y + hash(x, y, 152), hash(x, y, 153) * 6.28, 0.9 + hash(x, y, 154) * 0.7, 'mushrooms'); // forest edge
      if (D.tuft && vnoise(x / 9, y / 9, 95) < 0.38 && hash(x, y, 160) < 0.03) add(D.tuft[0], x + hash(x, y, 161), y + hash(x, y, 162), hash(x, y, 163) * 6.28, 0.8 + hash(x, y, 164) * 0.7, 'tuft'); // dry patches
      if (vnoise(x / 7, y / 7, 91) > 0.62 && hash(x, y, 140) < 0.1 * dm('flowers', 1)) add(D.flowers[0], x + hash(x, y, 141), y + hash(x, y, 142), hash(x, y, 143) * 6.28, 0.8 + hash(x, y, 144) * 0.6, 'flowers');
    } else if (c === 'f' && D.bush.length && hash(x, y, 90) < 0.1) add(pick(D.bush, hash(x, y, 93)), x + hash(x, y, 91), y + hash(x, y, 92), hash(x, y, 94) * 6.28, 0.8 + hash(x, y, 95) * 0.7, 'bush', 0.85 + hash(x, y, 96) * 0.3);
  }
  // 8x8 cells: camps, ruins, lone props (open grass only, away from the start areas)
  for (let cy = 0; cy < size / 8; cy++) for (let cx = 0; cx < size / 8; cx++) {
    const h = hash(cx, cy, 200);
    if (h > 0.2) continue;
    const x = cx * 8 + 2 + hash(cx, cy, 201) * 4, y = cy * 8 + 2 + hash(cx, cy, 202) * 4;
    let open = true;
    for (let j = -2; j <= 2 && open; j++) for (let i = -2; i <= 2; i++) if (cl(Math.floor(x) + i, Math.floor(y) + j) !== '.') { open = false; break; }
    if (!open || !awayFromStart(x, y, 20)) continue;
    const rr = (k) => hash(cx, cy, 210 + k);
    if (h < 0.06) { // camp: tent, fire, crates, barrels, sacks, hay
      add(D.camp[0], x, y, FACE_CAM + (rr(0) - 0.5), 1, 'prop');
      add(D.camp[1], x + 1.2, y + 0.9, 0, 1, 'prop');
      D.camp.slice(2).forEach((id, k) => add(id, x - 1.1 + k * 0.7 + rr(k) * 0.3, y + 1.4 + rr(k + 7) * 0.8 - (k % 2) * 0.4, rr(k + 3) * 6.28, 1, 'prop'));
    } else if (h < 0.12) { // ruin: a few columns, menhirs, a grave, bones
      D.ruin.forEach((id, k) => { const n = k < 2 ? 2 : 1; for (let q = 0; q < n; q++) add(id, x + (rr(k * 3 + q) - 0.5) * 3.4, y + (rr(k * 3 + q + 20) - 0.5) * 3.4, rr(k * 3 + q + 40) * 6.28, 0.9 + rr(k + 60) * 0.4, 'prop'); });
    } else { add(D.single[Math.floor(rr(5) * D.single.length)], x, y, rr(6) * 6.28, 1, 'prop'); }
  }
  const sway = (mat, lod) => (lod < 2 ? ANIM.swayMaterial(mat, 0.9) : mat);
  const fields = [];
  const col = new THREE.Color();
  for (const [id, list] of lists) {
    const kind = list[0].kind;
    const f = new Scatter(scene, pack, id, list.length, { dist: [34, 70], maxDraw: kind === 'prop' ? 160 : kind === 'fern' || kind === 'flowers' || kind === 'mushrooms' || kind === 'tuft' ? 110 : 200, shadow: [!['flowers', 'fern', 'mushrooms', 'snow', 'dune', 'tuft'].includes(kind), false, false], receive: kind !== 'flowers', matFn: ['bush', 'fern', 'flowers', 'cactus', 'tuft', 'reed'].includes(kind) ? sway : null, cullPad: 3 });
    fields.push({ f, list, id });
  }
  const place = () => {
    for (const { f, list } of fields) {
      list.forEach((it, i) => {
        const tx = Math.min(size - 1, Math.floor(it.x)), tz = Math.min(size - 1, Math.floor(it.z));
        const blocked = T && T.occ[tz * size + tx] || (T && it.kind !== 'rock' && it.kind !== 'bush' && it.kind !== 'cliff' && T.dirtAt(it.x, it.z) > 0.3);
        it.on = !blocked;
        if (blocked) { f.setAlive(i, false); return; }
        col.setRGB(it.tint, it.tint, it.tint);
        f.set(i, it.x, heightAt(it.x, it.z) - (it.kind === 'rock' ? 0.04 : 0), it.z, it.ry, it.s, col);
      });
    }
  };
  place();
  onHeightsChanged(() => place());
  // what a deer must keep clear of: radius in tiles at scale 1 (items carry r and, from place(), on = drawn)
  const BLOCK = { rock: 0.4, bush: 0.32, cliff: 0.5, prop: 0.6, cactus: 0.25 }, blockers = [];
  for (const { list } of fields) for (const it of list) if (BLOCK[it.kind]) { it.r = BLOCK[it.kind] * it.s; blockers.push(it); }
  return {
    scatters: fields.map((x) => x.f), blockers,
    update(camera) { for (const { f } of fields) f.update(camera); },
    get ready() { return Promise.all(fields.map((x) => x.f.promise)); },
  };
}
function pick(list, r) { return list[Math.min(list.length - 1, Math.floor(r * list.length))]; }
