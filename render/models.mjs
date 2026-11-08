// Original low-poly models, built from simple primitives. Every model is two geometries:
//   body: fixed colours (vertex colours), team: white, tinted per owner at draw time.
// Local frame: +z is "forward", y is up, the model sits on y = 0 and is about 1 tile wide.
import * as THREE from './vendor/three.module.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();

// ANIMATION PARTS (render/anim.mjs shaders): every vertex carries a part id (aPart) and the pivot it moves about (aPivot).
//   part 0 = fixed. Options on add()/box()/cyl()...: part, pv:[x,y,z] (pivot in model space before the builder's dy lift), dy (override lift).
// Unit parts: 1 leg A / horse front-left, 2 leg B, 3 weapon arm, 4 shield/bow arm, 5 nocked arrow, 6 horse head+neck, 7 catapult arm,
//   8 ram log, 9 horse tail, 11 horse hind-left, 12 horse hind-right, 13 thrown javelin, 14 catapult stone, 15 bow, 16 horse front-right,
//   17 wheel, 18 held weapon/tool (pivot in the hand), 19 sapper fuse spark (only visible while the charge burns), 20 mortar tube (recoils on a shot).
// Building parts: 20 mill sails, 21 flag/pennant, 22 forge glow.
export class Builder {
  constructor() { this.pos = []; this.col = []; this.part = []; this.piv = []; this.dy = 0; }
  add(geo, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    const dy = o.dy ?? this.dy;
    _e.set(o.rx || 0, o.ry || 0, o.rz || 0);
    _q.setFromEuler(_e);
    _m.compose(_p.set(o.x || 0, (o.y || 0) + dy, o.z || 0), _q, _s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1));
    g.applyMatrix4(_m);
    const p = g.attributes.position.array;
    _c.set(o.c ?? 0xffffff);
    const tint = o.tint ?? 0;
    const part = o.part || 0, pv = o.pv || [0, 0, 0];
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      const k = 1 + tint * (((i * 2654435761) >>> 0) % 100 / 100 - 0.5);
      this.col.push(_c.r * k, _c.g * k, _c.b * k);
      this.part.push(part);
      this.piv.push(pv[0], part ? pv[1] + dy : 0, pv[2]);
    }
    g.dispose();
    return this;
  }
  // bottom-anchored helpers
  box(w, h, d, x, y, z, c, o = {}) { return this.add(new THREE.BoxGeometry(w, h, d), { x, y: y + h / 2, z, c, ...o }); }
  cyl(rt, rb, h, seg, x, y, z, c, o = {}) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), { x, y: y + h / 2, z, c, ...o }); }
  cone(r, h, seg, x, y, z, c, o = {}) { return this.add(new THREE.ConeGeometry(r, h, seg), { x, y: y + h / 2, z, c, ...o }); }
  ball(r, x, y, z, c, o = {}) { return this.add(new THREE.SphereGeometry(r, 7, 5), { x, y: y + r, z, c, ...o }); }
  gable(w, h, d, x, y, z, c, o = {}) { return this.add(gableGeo(w, h, d), { x, y, z, c, ...o }); }
  pyramid(w, h, x, y, z, c, o = {}) { return this.add(new THREE.ConeGeometry(w * Math.SQRT1_2, h, 4), { x, y: y + h / 2, z, c, ry: Math.PI / 4, ...o }); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.piv, 3));
    g.computeVertexNormals(); // non-indexed: flat shaded
    return g;
  }
}

// gable roof: footprint w (x) by d (z), ridge along z at height h, base at y=0
function gableGeo(w, h, d) {
  const x = w / 2, z = d / 2;
  const v = [
    // front/back triangles
    -x, 0, z, x, 0, z, 0, h, z,
    x, 0, -z, -x, 0, -z, 0, h, -z,
    // slopes
    -x, 0, z, 0, h, z, 0, h, -z, -x, 0, z, 0, h, -z, -x, 0, -z,
    x, 0, -z, 0, h, -z, 0, h, z, x, 0, -z, 0, h, z, x, 0, z,
    // underside
    -x, 0, -z, x, 0, -z, x, 0, z, -x, 0, -z, x, 0, z, -x, 0, z,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}

const PAL = {
  skin: 0xe9c19a, cloth: 0xb9a98a, dark: 0x2c3340, steel: 0xaeb8c6, steelD: 0x7d8796, wood: 0x8a5a33, woodD: 0x5d3b22, woodL: 0xb98a55,
  leather: 0x6b4a32, gold: 0xf2c14e, stone: 0x8d96a3, stoneD: 0x6a7280, stoneL: 0xb3bac6, thatch: 0xc9a85a, white: 0xffffff,
  horse: 0x8c6a4a, horseD: 0x5c4531, grey: 0x9aa1ab, fire: 0xff9a3c, glass: 0x9ad0ff,
};

// ---------------- units ----------------
const LIFT = 0.12; // humans: legs are 0.27 tall, everything else is lifted by this (builder dy)
const T2 = Math.PI * 2;
// returns the shoulder height (before the lift); legs + arms are animated parts
function human(b, t, o = {}) {
  const h = o.h ?? 0.42, sy = 0.1 + h - 0.06, cloth = o.cloth ?? PAL.cloth;
  if (o.legs !== false) for (const [x, part] of [[-0.08, 1], [0.08, 2]]) b.box(0.1, 0.27, 0.1, x, 0, 0, PAL.dark, { dy: 0, part, pv: [x, 0.25, 0] });
  b.cyl(0.15, 0.19, h, 7, 0, 0.1, 0, cloth);
  b.ball(0.13, 0, 0.1 + h, 0, PAL.skin);
  for (const [x, part] of [[0.2, 3], [-0.2, 4]]) {
    b.box(0.07, 0.26, 0.07, x, sy - 0.26, 0, cloth, { part, pv: [x, sy, 0] });
    b.ball(0.05, x, sy - 0.3, 0, PAL.skin, { part, pv: [x, sy, 0] });
  }
  return { sy, hand: [0.22, sy - 0.27, 0.08] };
}

const UNIT_BUILD = {
  worker(b, t) {
    const { sy, hand } = human(b, t, { h: 0.36, cloth: 0xc9b38a });
    t.cyl(0.18, 0.18, 0.1, 7, 0, 0.3, 0, 0xffffff); // team sash
    t.cone(0.17, 0.16, 7, 0, 0.64, 0, 0xffffff); // team hood
    b.box(0.07, 0.5, 0.07, 0.24, 0.12, 0.1, PAL.woodD, { rx: -0.35, part: 18, pv: hand }); // pick handle
    b.box(0.3, 0.07, 0.07, 0.24, 0.58, 0.2, PAL.steel, { part: 18, pv: hand }); // pick head
  },
  spearman(b, t) {
    const { sy, hand } = human(b, t, { cloth: 0xa59676 });
    t.cyl(0.24, 0.24, 0.06, 6, -0.22, 0.28, 0.08, 0xffffff, { rz: Math.PI / 2, part: 4, pv: [-0.2, sy, 0] }); // round shield (team)
    b.cyl(0.03, 0.03, 1.35, 5, 0.22, 0.0, 0.1, PAL.woodL, { part: 18, pv: hand });
    b.cone(0.06, 0.2, 4, 0.22, 1.35, 0.1, PAL.steel, { part: 18, pv: hand });
    b.cyl(0.19, 0.19, 0.1, 7, 0, 0.62, 0, PAL.steelD); // helm
  },
  swordsman(b, t) {
    const { sy } = human(b, t, { h: 0.5, cloth: 0x8f98a6 });
    const hand = [0.24, sy - 0.27, 0.2];
    b.box(0.36, 0.14, 0.2, 0, 0.5, 0, PAL.steelD); // pauldrons
    t.box(0.07, 0.5, 0.34, -0.26, 0.2, 0.05, 0xffffff, { part: 4, pv: [-0.2, sy, 0] }); // slab shield (team)
    b.box(0.06, 0.8, 0.02, 0.24, 0.35, 0.2, PAL.steel, { rx: 0.4, part: 18, pv: hand }); // blade
    b.box(0.2, 0.04, 0.04, 0.24, 0.32, 0.2, PAL.gold, { part: 18, pv: hand });
    b.cone(0.17, 0.2, 6, 0, 0.78, 0, PAL.steel); // helm
  },
  archer(b, t) {
    const { sy } = human(b, t, { h: 0.36, cloth: 0x7f9a6a });
    t.cone(0.16, 0.22, 7, 0, 0.66, 0, 0xffffff, { sy: 0.8 }); // team cap
    // bow: an arc in the vertical plane, bulging forward; string at z = 0.12 (parts 15, slides forward when the arm is raised)
    b.add(new THREE.TorusGeometry(0.34, 0.025, 4, 10, Math.PI), { x: 0.22, y: 0.46, z: 0.12, rz: -Math.PI / 2, ry: -Math.PI / 2, c: PAL.woodL, part: 15 });
    b.box(0.01, 0.66, 0.01, 0.22, 0.13, 0.12, 0xe8e4d8, { part: 15 });
    b.box(0.014, 0.014, 0.52, 0.22, 0.46, 0.38, 0xe8e4d8, { part: 5 }); // nocked arrow (shown while drawing)
    b.box(0.12, 0.3, 0.1, -0.12, 0.2, -0.16, PAL.leather); // quiver
  },
  skirmisher(b, t) {
    const { sy, hand } = human(b, t, { h: 0.34, cloth: 0xa98f6b });
    t.box(0.34, 0.1, 0.22, 0, 0.36, 0, 0xffffff); // team scarf
    for (let i = 0; i < 3; i++) b.cyl(0.015, 0.015, 0.7, 4, -0.2 + i * 0.05, 0.1, -0.12, PAL.woodL, { rx: 0.5, rz: 0.15 - i * 0.12 });
    b.cone(0.15, 0.1, 6, 0, 0.62, 0, PAL.leather);
    b.cyl(0.018, 0.018, 0.95, 4, 0.22, 0.0, 0.12, PAL.woodL, { rx: 0.35, part: 13, pv: hand }); // thrown javelin
    b.add(new THREE.ConeGeometry(0.04, 0.12, 4), { x: 0.22, y: 0.977, z: 0.303, c: PAL.steel, rx: 0.35, part: 13, pv: hand });
  },
  light_cavalry(b, t) {
    horse(b, t, 1, PAL.horse);
  },
  heavy_cavalry(b, t) {
    horse(b, t, 1.2, 0x6a5a4a, true);
  },
  // scout: a light, small horse and a rider with a pennant on a short staff (team colour)
  scout(b, t) {
    horse(b, t, 0.88, 0xa07c55);
    b.cyl(0.012, 0.012, 0.55, 4, -0.16, 0.95, -0.05, PAL.woodL);
    t.box(0.22, 0.12, 0.02, -0.16, 1.36, -0.05, 0xffffff, { part: 9, pv: [-0.16, 1.4, -0.05] }); // pennant (waves like the tail)
  },
  // healer: a long robe, a hood and a staff with a glowing green orb
  healer(b, t) {
    const { sy, hand } = human(b, t, { h: 0.5, cloth: 0xe6e0cf });
    b.cyl(0.2, 0.3, 0.42, 7, 0, 0.0, 0, 0xe6e0cf); // robe skirt
    t.cyl(0.21, 0.21, 0.07, 7, 0, 0.36, 0, 0xffffff); // team sash
    t.cone(0.17, 0.2, 7, 0, 0.7, 0, 0xffffff, { sy: 0.9 }); // team hood
    b.box(0.07, 0.07, 0.05, 0.0, 0.62, 0.15, PAL.gold); // clasp
    b.cyl(0.025, 0.025, 1.15, 5, 0.22, 0.0, 0.1, PAL.woodL, { part: 18, pv: hand });
    b.ball(0.08, 0.22, 1.12, 0.1, 0x7dffa8, { part: 18, pv: hand });
    b.box(0.2, 0.025, 0.025, 0.22, 1.05, 0.1, PAL.gold, { part: 18, pv: hand });
    b.box(0.025, 0.2, 0.025, 0.22, 1.05, 0.1, PAL.gold, { part: 18, pv: hand });
  },
  // sapper: helmet, a keg of powder on the back with a fuse, a coil of rope; crouches and lights the fuse (act 13)
  sapper(b, t) {
    const { sy, hand } = human(b, t, { h: 0.4, cloth: 0x8a6d4a });
    b.cyl(0.18, 0.18, 0.1, 7, 0, 0.5, 0, PAL.steelD); // helmet
    b.cone(0.16, 0.12, 7, 0, 0.58, 0, PAL.steelD);
    b.cyl(0.2, 0.2, 0.42, 8, 0, 0.12, -0.28, PAL.woodD); // keg
    t.cyl(0.205, 0.205, 0.06, 8, 0, 0.2, -0.28, 0xffffff); // team bands
    t.cyl(0.205, 0.205, 0.06, 8, 0, 0.42, -0.28, 0xffffff);
    b.cyl(0.012, 0.012, 0.2, 4, 0, 0.54, -0.28, 0x333333); // fuse
    b.box(0.07, 0.07, 0.07, 0, 0.74, -0.28, 0xffb347, { part: 19, pv: [0, 0.78, -0.28] }); // spark (only while burning)
    b.box(0.07, 0.4, 0.07, 0.24, 0.1, 0.1, PAL.woodD, { rx: -0.35, part: 18, pv: hand }); // short crowbar
    b.box(0.16, 0.05, 0.05, 0.24, 0.46, 0.18, PAL.steel, { part: 18, pv: hand });
  },
  // mortar: a heavy baseplate on skids, a fat short tube tilted up (recoils), a stack of shells
  mortar(b, t) {
    b.box(1.0, 0.12, 1.2, 0, 0.0, 0, PAL.woodD);
    b.cyl(0.12, 0.12, 0.5, 8, -0.4, 0.12, -0.45, PAL.dark, { rz: Math.PI / 2 }); // cross beams
    b.cyl(0.12, 0.12, 0.5, 8, 0.4, 0.12, -0.45, PAL.dark, { rz: Math.PI / 2 });
    t.box(0.9, 0.08, 0.2, 0, 0.12, 0.45, 0xffffff); // team plank
    b.box(0.5, 0.24, 0.5, 0, 0.12, -0.05, PAL.stoneD); // breech block
    b.cyl(0.19, 0.25, 0.95, 9, 0, 0.0, 0.0, PAL.dark, { rx: 0.9, y: 0.65, z: 0.28, part: 20 }); // tube
    b.cyl(0.24, 0.2, 0.12, 9, 0, 0.0, 0.0, PAL.steelD, { rx: 0.9, y: 1.04, z: 0.62, part: 20 }); // muzzle ring
    t.cyl(0.255, 0.255, 0.06, 9, 0, 0.0, 0.0, 0xffffff, { rx: 0.9, y: 0.82, z: 0.44, part: 20 }); // team band on the tube
    for (let i = 0; i < 3; i++) b.ball(0.1, -0.35 + i * 0.12, 0.14, 0.5, PAL.stone);
  },
  // God mode event unit: grey wolf. Legs, head and tail use the horse animation parts.
  wolf(b, t) {
    const fur = 0x8b9099, furD = 0x5a5f68;
    b.box(0.26, 0.26, 0.62, 0, 0.26, 0, fur);
    b.box(0.22, 0.12, 0.3, 0, 0.4, 0.18, furD); // darker saddle of fur
    for (const [x, z, part] of [[-0.09, 0.22, 1], [0.09, 0.22, 16], [-0.09, -0.22, 11], [0.09, -0.22, 12]]) b.box(0.07, 0.3, 0.07, x, 0, z, furD, { dy: 0, part, pv: [x, 0.3, z] });
    const npv = [0, 0.45, 0.3];
    b.box(0.18, 0.2, 0.2, 0, 0.36, 0.38, fur, { part: 6, pv: npv });
    b.box(0.17, 0.16, 0.16, 0, 0.42, 0.52, fur, { part: 6, pv: npv });
    b.box(0.09, 0.08, 0.16, 0, 0.4, 0.64, furD, { part: 6, pv: npv }); // snout
    for (const x of [-0.06, 0.06]) { b.cone(0.04, 0.1, 4, x, 0.56, 0.5, furD, { part: 6, pv: npv }); b.box(0.025, 0.025, 0.02, x, 0.5, 0.6, 0xffd24a, { part: 6, pv: npv }); }
    b.box(0.07, 0.07, 0.34, 0, 0.3, -0.45, fur, { rx: 0.5, part: 9, pv: [0, 0.44, -0.3] }); // tail
    t.box(0.2, 0.05, 0.12, 0, 0.5, 0.33, 0xffffff); // team colour: a collar so that a wolf pack of a God event can still be told apart from a player's units
  },
  // ---- the living world (sim/naval.mjs, sim/world.mjs): ships and the neutral trade caravan ----
  // hull helper: a boat is a tapered stack of boxes with a pointed bow (+z)
  fishing_boat(b, t) {
    const L = 1.7, W = 0.5, H = 0.4;
    hull(b, t, L, W, H, 0x8a5a33, 0x3b3a42);
    b.box(0.34, 0.05, 0.55, 0, 0.14, -0.15, PAL.woodL); b.box(0.34, 0.05, 0.3, 0, 0.14, 0.4, PAL.woodL); // thwarts
    b.cyl(0.028, 0.034, 1.25, 6, 0, 0.12, 0.2, PAL.wood); // mast
    b.cyl(0.02, 0.02, 0.9, 5, 0, 0.0, 0.0, PAL.woodL, { rx: Math.PI / 2, y: 1.0, z: 0.2 }); // yard
    sailShape(t, 0.2, 1.0, 0.88, 0.62, 0.0, 0xffffff, 0.14); // team sail (a curved sheet)
    b.cyl(0.012, 0.012, 0.5, 4, 0.0, 0.3, 0.2, 0xb9a37a, { rx: 0.9, z: 0.5, y: 0.7 }); // stay
    // net heap with floats, a basket of fish and the fisherman
    b.add(new THREE.SphereGeometry(0.2, 7, 5), { x: 0.0, y: 0.26, z: -0.45, sy: 0.55, sx: 1.1, c: 0x6d6a55 });
    for (const [x, z] of [[-0.12, -0.5], [0.1, -0.38], [0.0, -0.58], [0.14, -0.55], [-0.1, -0.35]]) b.ball(0.035, x, 0.38, z, 0xd2692c);
    b.cyl(0.1, 0.08, 0.14, 8, 0.17, 0.14, 0.45, 0x9a7340); b.add(new THREE.SphereGeometry(0.07, 6, 4), { x: 0.17, y: 0.31, z: 0.45, sy: 0.4, c: 0x9fb3c0 });
    b.cyl(0.07, 0.09, 0.28, 7, -0.1, 0.14, 0.0, 0x4d6384); b.ball(0.07, -0.1, 0.42, 0.0, PAL.skin); b.cone(0.1, 0.07, 7, -0.1, 0.5, 0.0, 0xc2993a); // fisherman and hat
    b.cyl(0.012, 0.012, 0.85, 4, 0.2, 0.2, -0.05, PAL.woodL, { rz: -0.9, rx: 0.3 }); // oar
    t.box(0.1, 0.16, 0.02, 0, 0.55, -0.82, 0xffffff); b.cyl(0.012, 0.012, 0.35, 4, 0, 0.3, -0.82, PAL.woodL); // stern pennant
  },
  war_boat(b, t) {
    const L = 2.8, W = 0.62, H = 0.42;
    hull(b, t, L, W, H, 0x8d3a2c, 0x35323a);
    b.box(W * 1.5, 0.05, L * 0.62, 0, 0.17, 0, 0xb98a55); // plank deck
    for (let i = 0; i < 9; i++) { const z = -0.9 + i * 0.22; // oars on both sides, shields along the rail
      for (const x of [-1, 1]) { b.cyl(0.012, 0.012, 0.8, 4, x * 0.46, 0.26, z, PAL.woodL, { rz: x * 1.15 }); b.box(0.05, 0.015, 0.14, x * 0.82, 0.0, z, PAL.woodL, { y: 0.04 }); b.cyl(0.085, 0.085, 0.025, 8, x * 0.335, 0.28, z, i % 2 ? 0x9a2a22 : 0xd0b270, { rz: Math.PI / 2 }); } }
    b.cyl(0.04, 0.05, 1.6, 6, 0, 0.17, 0.1, PAL.wood); // mast
    b.cyl(0.022, 0.022, 1.15, 5, 0, 0.0, 0.1, PAL.woodL, { rx: 0, rz: Math.PI / 2, y: 1.45 }); // yard
    sailShape(t, 0.1, 1.42, 1.1, 0.95, 0.0, 0xffffff, 0.16); // big square team sail
    t.box(0.02, 0.2, 0.34, 0, 1.72, 0.0, 0xffffff); // pennant at the masthead
    b.box(0.46, 0.16, 0.5, 0, 0.17, -1.0, PAL.woodD); b.box(0.3, 0.1, 0.34, 0, 0.33, -1.0, PAL.steelD); // aft castle with ballista
    b.cyl(0.025, 0.025, 0.5, 5, 0, 0.0, 0.0, PAL.dark, { rx: Math.PI / 2 - 0.3, y: 0.5, z: -0.85 });
    b.cone(0.1, 0.42, 5, 0, 0.12, 1.5, 0xc7a24a, { rx: Math.PI / 2 }); // ram
    b.box(0.16, 0.1, 0.05, 0, 0.26, 1.18, 0xdfe6ea); // an eye on the bow
  },
  transport(b, t) {
    const L = 2.4, W = 0.78, H = 0.5;
    hull(b, t, L, W, H, 0x8a5a33, 0x3b3a42);
    b.box(W * 1.35, 0.06, L * 0.6, 0, 0.22, 0.05, 0xa8794a); // deck
    for (const [x, z, k] of [[-0.2, 0.0, 0.34], [0.22, 0.2, 0.3], [-0.12, 0.55, 0.26], [0.2, -0.3, 0.28]]) { b.box(k, k, k, x, 0.28, z, PAL.leather); b.box(k * 1.05, 0.03, 0.04, x, 0.28 + k * 0.5, z, PAL.dark); }
    for (const [x, z] of [[-0.12, -0.4], [0.1, -0.5]]) b.cyl(0.11, 0.1, 0.26, 8, x, 0.28, z, 0x7a5a38); // barrels
    b.cyl(0.04, 0.05, 1.45, 6, 0, 0.2, 0.75, PAL.wood);
    b.cyl(0.022, 0.022, 0.95, 5, 0, 0.0, 0.75, PAL.woodL, { rz: Math.PI / 2, y: 1.25 });
    sailShape(t, 0.75, 1.22, 0.9, 0.85, 0.0, 0xffffff, 0.15);
    b.box(0.5, 0.2, 0.4, 0, 0.28, -0.85, PAL.wood); b.gable(0.55, 0.16, 0.45, 0, 0.48, -0.85, PAL.woodD); // little cabin
    t.box(0.1, 0.14, 0.02, 0, 0.7, -1.15, 0xffffff); b.cyl(0.012, 0.012, 0.4, 4, 0, 0.35, -1.15, PAL.woodL);
  },
  caravan(b, t) {
    b.box(0.55, 0.07, 1.0, 0, 0.26, -0.15, PAL.woodD); // wagon bed
    b.box(0.55, 0.4, 0.06, 0, 0.3, -0.62, PAL.wood); b.box(0.06, 0.35, 0.9, -0.28, 0.3, -0.15, PAL.wood); b.box(0.06, 0.35, 0.9, 0.28, 0.3, -0.15, PAL.wood);
    b.add(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 8, 1, true, 0, Math.PI), { x: 0, y: 0.78, z: -0.15, rx: Math.PI / 2, rz: Math.PI / 2, c: 0xe3d9bd }); // canvas cover
    t.box(0.6, 0.06, 0.3, 0, 0.98, -0.15, 0xffffff); // team-neutral stripe (white) so that it is easy to spot
    for (const z of [-0.5, 0.2]) for (const x of [-0.31, 0.31]) wheel(b, x, 0.2, z, 0.2);
    b.box(0.3, 0.3, 0.3, 0, 0.55, 0.15, PAL.leather); b.box(0.2, 0.2, 0.2, 0.1, 0.55, -0.4, PAL.gold); // goods and a gold box
    // an ox in front
    b.box(0.3, 0.3, 0.62, 0, 0.3, 0.75, 0x6b5036);
    for (const [x, z] of [[-0.1, 0.55], [0.1, 0.55], [-0.1, 0.95], [0.1, 0.95]]) b.box(0.08, 0.32, 0.08, x, 0, z, 0x3d2c1c, { dy: 0 });
    b.box(0.2, 0.2, 0.22, 0, 0.42, 1.15, 0x6b5036); b.box(0.5, 0.04, 0.04, 0, 0.62, 1.15, 0xe3d9bd);
    b.box(0.04, 0.04, 0.5, 0, 0.36, 0.45, PAL.woodL); // yoke pole
  },
  ram(b, t) {
    b.box(0.8, 0.12, 1.5, 0, 0.18, 0, PAL.woodD);
    for (const z of [-0.5, 0.5]) for (const x of [-0.45, 0.45]) wheel(b, x, 0.18, z, 0.18);
    b.gable(0.95, 0.5, 1.2, 0, 0.7, -0.1, PAL.wood);
    t.gable(0.97, 0.12, 1.22, 0, 1.12, -0.1, 0xffffff);
    for (const x of [-0.38, 0.38]) for (const z of [-0.55, 0.35]) b.box(0.07, 0.5, 0.07, x, 0.3, z, PAL.woodL);
    b.cyl(0.12, 0.12, 1.7, 7, 0, 0.0, 0.1, PAL.woodL, { rx: Math.PI / 2, y: 0.6, part: 8 }); // log (swings back and forth)
    b.cone(0.16, 0.3, 6, 0, 0.0, 1.02, PAL.steelD, { rx: Math.PI / 2, y: 0.6, part: 8 }); // iron cap
  },
  catapult(b, t) {
    b.box(0.8, 0.14, 1.3, 0, 0.2, 0, PAL.woodD);
    for (const z of [-0.45, 0.45]) for (const x of [-0.46, 0.46]) wheel(b, x, 0.2, z, 0.2);
    b.box(0.08, 0.7, 0.08, -0.3, 0.32, 0, PAL.woodL); b.box(0.08, 0.7, 0.08, 0.3, 0.32, 0, PAL.woodL);
    b.box(0.7, 0.07, 0.07, 0, 0.98, 0, PAL.woodL);
    const pv = [0, 0.745, 0.1];
    b.box(0.09, 0.09, 1.3, 0, 0.7, 0.1, PAL.wood, { rx: -0.5, part: 7, pv }); // arm
    t.box(0.34, 0.12, 0.34, 0, 1.1, 0.7, 0xffffff, { y: 1.2, part: 7, pv }); // bucket (team)
    b.ball(0.15, 0, 1.28, 0.7, PAL.stoneD, { part: 14, pv });
    b.box(0.3, 0.3, 0.3, 0, 0.4, -0.55, PAL.stoneD); // counterweight
  },
};

// A lofted hull: sections along z (bow +z), each a half profile keel -> bilge -> gunwale, with the sheer rising at bow and stern.
// Outer planks in two tones, a team-coloured gunwale band, an inner wall and a floor. Length L, beam W, depth H.
function hull(b, t, L, W, H, wood, under) {
  const N = 11, prof = [[0, 0], [0.45, 0.1], [0.82, 0.42], [1, 1]]; // (x fraction of half-beam, y fraction of depth)
  const secs = [];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1), z = (u - 0.5) * L, e = Math.abs(2 * u - 1);
    const w = (W / 2) * Math.pow(Math.max(0.0001, 1 - Math.pow(e, u > 0.5 ? 2.4 : 3.0)), 0.7) * (u > 0.5 ? 1 : 0.85); // fuller at the middle, pointed bow
    const sheer = H * (1 + 0.5 * Math.pow(e, 2.2) * (u > 0.5 ? 1.15 : 0.7)), keel = 0.12 * (1 - Math.pow(e, 2)) ;
    secs.push({ z, w, sheer, keel });
  }
  const pt = (sec, k, side) => [side * sec.w * prof[k][0], sec.keel * (1 - prof[k][1]) + sec.sheer * prof[k][1] - 0.02, sec.z];
  const strip = (k, side, flip) => { const pos = [];
    for (let i = 0; i < N - 1; i++) { const a = pt(secs[i], k, side), bq = pt(secs[i], k + 1, side), c = pt(secs[i + 1], k, side), d = pt(secs[i + 1], k + 1, side);
      const tri = flip ? [[a, c, bq], [bq, c, d]] : [[a, bq, c], [bq, d, c]]; for (const T of tri) for (const v of T) pos.push(...v); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); return g; };
  const cols = [under, wood, new THREE.Color(wood).multiplyScalar(0.8).getHex()];
  for (const side of [-1, 1]) for (let k = 0; k < 3; k++) { b.add(strip(k, side, side < 0), { c: cols[k] }); }
  // inner wall (lighter, faces inward) and the floor
  for (const side of [-1, 1]) b.add(strip(2, side, side > 0), { c: new THREE.Color(wood).multiplyScalar(0.62).getHex(), x: -side * 0.02 });
  const fl = []; for (let i = 0; i < N - 1; i++) { const a = secs[i], c = secs[i + 1], y = 0.1; fl.push(-a.w * 0.8, y, a.z, a.w * 0.8, y, a.z, -c.w * 0.8, y, c.z, a.w * 0.8, y, a.z, c.w * 0.8, y, c.z, -c.w * 0.8, y, c.z); }
  const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(fl, 3)); b.add(fg, { c: 0x4d3523 });
  // team gunwale band on top of the rail and a bow/stern post
  for (const side of [-1, 1]) { const q = []; for (let i = 0; i < N - 1; i++) { const a = secs[i], c = secs[i + 1]; const ax = side * a.w, cx = side * c.w, ay = a.sheer + 0.0, cy = c.sheer + 0.0, o = 0.05 * side;
      q.push(ax, ay, a.z, ax - o, ay, a.z, cx, cy, c.z, ax - o, ay, a.z, cx - o, cy, c.z, cx, cy, c.z); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(q, 3)); t.add(g, { c: 0xffffff }); }
  b.box(0.06, secs[N - 1].sheer + 0.15, 0.1, 0, 0, L / 2 - 0.02, PAL.woodL, { rx: -0.25 }); // stem post
  b.box(0.06, secs[0].sheer + 0.12, 0.08, 0, 0, -L / 2 + 0.02, PAL.woodL, { rx: 0.2 });
}
// a sail: a sheet bulging in the wind, centred at (0, y, z), w wide and h tall, billow depth bulge
function sailShape(t, z, yTop, w, h, _x, c, bulge) {
  const nx = 6, ny = 4, pos = [];
  const P = (i, j) => { const u = i / nx, v = j / ny; return [(u - 0.5) * w, yTop - v * h, z + Math.sin(Math.PI * u) * Math.sin(Math.PI * (0.15 + 0.7 * v)) * bulge]; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = P(i, j), bq = P(i + 1, j), cq = P(i, j + 1), d = P(i + 1, j + 1);
    for (const T of [[a, cq, bq], [bq, cq, d], [a, bq, cq], [bq, d, cq]]) for (const v of T) pos.push(...v); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); t.add(g, { c });
}

// wheel with two spokes so that the rolling is visible (part 17)
function wheel(b, x, y, z, r) {
  const pv = [x, y, z], o = x < 0 ? -1 : 1;
  b.cyl(r, r, 0.08, 8, x, 0.0, z, PAL.dark, { rz: Math.PI / 2, y, part: 17, pv });
  b.box(0.1, r * 1.8, 0.045, x + o * 0.02, y - r * 0.9, z, PAL.woodL, { part: 17, pv });
  b.box(0.1, 0.045, r * 1.8, x + o * 0.02, y - 0.0225, z, PAL.woodL, { part: 17, pv });
}

function horse(b, t, s, coat, armoured) {
  b.box(0.38 * s, 0.38 * s, 0.95 * s, 0, 0.42 * s, 0, coat);
  // legs: front-left 1, front-right 16, hind-left 11, hind-right 12
  for (const [x, z, part] of [[-0.12, 0.32, 1], [0.12, 0.32, 16], [-0.12, -0.32, 11], [0.12, -0.32, 12]]) {
    b.box(0.1 * s, 0.44 * s, 0.1 * s, x * s, 0, z * s, PAL.horseD, { dy: 0, part, pv: [x * s, 0.44 * s, z * s] });
  }
  const npv = [0, 0.7 * s, 0.4 * s]; // neck base: head nods about it
  b.box(0.16 * s, 0.4 * s, 0.2 * s, 0, 0.62 * s, 0.5 * s, coat, { rx: -0.5, part: 6, pv: npv });
  b.box(0.15 * s, 0.17 * s, 0.32 * s, 0, 0.92 * s, 0.7 * s, coat, { part: 6, pv: npv });
  b.box(0.06 * s, 0.28 * s, 0.06 * s, 0.14 * s, 0.82 * s, 0.4 * s, PAL.dark, { rz: 0.3, part: 6, pv: npv });
  b.box(0.04 * s, 0.3 * s, 0.1 * s, 0, 0.5 * s, -0.5 * s, PAL.horseD, { rx: 0.5, part: 9, pv: [0, 0.62 * s, -0.46 * s] }); // tail
  t.box(0.42 * s, 0.07, 0.5 * s, 0, 0.8 * s, 0, 0xffffff); // team saddle cloth
  // rider
  b.cyl(0.13, 0.15, 0.36 * s, 7, 0, 0.84 * s, -0.05, armoured ? PAL.steelD : PAL.cloth);
  b.ball(0.12, 0, 0.84 * s + 0.36 * s, -0.05, PAL.skin);
  const lpv = [0.18, 0.84 * s + 0.2, 0.05]; // lance hand
  if (armoured) {
    b.cone(0.14, 0.2, 6, 0, 0.84 * s + 0.44 * s, -0.05, PAL.steel);
    t.box(0.04, 0.3, 0.14, 0, 0.84 * s + 0.62 * s, -0.12, 0xffffff); // team plume
    t.box(0.44 * s, 0.2 * s, 0.7 * s, 0, 0.42 * s, 0, 0xffffff, { sx: 1.05, sy: 0.55, sz: 0.6, y: 0.62 * s }); // barding plate
    b.cyl(0.02, 0.02, 1.3, 4, 0.2, 0.55 * s, 0.4, PAL.woodL, { rx: Math.PI / 2 - 0.15, part: 18, pv: lpv });
  } else {
    t.cone(0.14, 0.22, 6, 0, 0.84 * s + 0.4 * s, -0.05, 0xffffff);
    b.cyl(0.02, 0.02, 1.0, 4, 0.2, 0.55 * s, 0.35, PAL.woodL, { rx: Math.PI / 2 - 0.2, part: 18, pv: lpv });
  }
}

// ---------------- buildings ----------------
const hy0 = () => 1.25;
function groundPad(b, size, c, h = 0.06) { b.box(size - 0.1, h, size - 0.1, 0, 0, 0, c); }

const BUILDING_BUILD = {
  town_center(b, t) {
    const s = 4;
    groundPad(b, s, PAL.stoneL, 0.15);
    b.box(2.2, 1.6, 2.2, 0, 0.15, 0, PAL.stone, { tint: 0.15 });
    b.box(2.5, 0.2, 2.5, 0, 1.75, 0, PAL.stoneD);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.cyl(0.38, 0.45, 2.2, 8, sx * 1.35, 0.15, sz * 1.35, PAL.stoneL, { tint: 0.12 });
      t.cone(0.55, 0.8, 8, sx * 1.35, 2.35, sz * 1.35, 0xffffff);
    }
    b.box(1.5, 1.0, 1.5, 0, 1.95, 0, PAL.stone);
    t.pyramid(1.9, 1.1, 0, 2.95, 0, 0xffffff);
    b.box(0.26, 0.7, 0.26, -0.55, 3.25, -0.55, PAL.stoneD); // chimney (smoke anchor, see SMOKE)
    b.cyl(0.04, 0.04, 1.4, 5, 0, 4.0, 0, PAL.woodD);
    t.add(new THREE.BoxGeometry(0.7, 0.4, 0.04, 10, 3, 1), { x: 0.38, y: 5.1, z: 0, c: 0xffffff, part: 21, pv: [0.03, 0, 0] }); // banner (waves)
    b.box(0.8, 1.1, 0.12, 0, 0.15, 1.12, PAL.woodD); // door
    b.gable(1.0, 0.35, 0.3, 0, 1.25, 1.2, PAL.woodL);
    for (const x of [-0.7, 0.7]) b.box(0.28, 0.4, 0.1, x, 1.05, 1.12, PAL.glass);
  },
  house(b, t) {
    groundPad(b, 2, PAL.stoneL);
    b.box(1.35, 0.8, 1.35, 0, 0.06, 0, 0xd6c8a8, { tint: 0.1 });
    t.gable(1.65, 0.75, 1.65, 0, 0.86, 0, 0xffffff);
    b.box(0.3, 0.5, 0.06, 0, 0.06, 0.7, PAL.woodD);
    b.box(0.22, 0.22, 0.06, 0.4, 0.4, 0.7, PAL.glass);
    b.box(0.2, 0.55, 0.2, -0.4, 1.2, -0.2, PAL.stoneD);
  },
  lumber_camp(b, t) {
    groundPad(b, 2, 0x6b5a3c);
    for (const x of [-0.8, 0.8]) for (const z of [-0.6, 0.6]) b.box(0.1, 1.1, 0.1, x, 0.06, z, PAL.woodL);
    t.gable(2.0, 0.5, 1.7, 0, 1.15, 0, 0xffffff);
    for (let i = 0; i < 4; i++) b.cyl(0.14, 0.14, 1.1, 6, -0.4 + (i % 2) * 0.3, 0.06 + Math.floor(i / 2) * 0.26, 0.1, PAL.wood, { rz: Math.PI / 2 });
    b.box(0.5, 0.5, 0.5, 0.6, 0.06, -0.5, PAL.woodL);
    b.box(0.08, 0.6, 0.08, 0.6, 0.56, -0.5, PAL.woodD, { rz: 0.8 }); b.box(0.28, 0.1, 0.06, 0.78, 1.0, -0.5, PAL.steel);
  },
  mining_camp(b, t) {
    groundPad(b, 2, 0x5d5d63);
    for (const x of [-0.8, 0.8]) b.box(0.12, 1.2, 0.12, x, 0.06, -0.2, PAL.woodL);
    b.box(1.8, 0.1, 0.14, 0, 1.2, -0.2, PAL.woodL);
    t.box(1.9, 0.14, 0.9, 0, 1.28, -0.35, 0xffffff, { rx: -0.3 });
    b.box(0.7, 0.35, 0.5, 0.2, 0.2, 0.5, PAL.woodD); // cart
    for (const x of [-0.25, 0.65]) b.cyl(0.14, 0.14, 0.06, 7, x, 0.0, 0.8, PAL.dark, { rz: Math.PI / 2, y: 0.14 });
    b.ball(0.18, 0.1, 0.52, 0.5, PAL.gold); b.ball(0.15, 0.35, 0.5, 0.5, PAL.stoneL);
    b.cone(0.4, 0.6, 5, -0.6, 0.06, 0.5, PAL.stoneD);
  },
  mill(b, t) {
    groundPad(b, 2, PAL.stoneL);
    b.cyl(0.45, 0.65, 1.7, 8, 0, 0.06, 0, 0xd9ccb0);
    t.cone(0.62, 0.65, 8, 0, 1.76, 0, 0xffffff);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + 0.5, hx = 0, hy = 1.35, c = Math.cos(a), s = Math.sin(a);
      b.box(0.07, 1.3, 0.05, hx - s * 0.65, 0, 0.55, PAL.woodL, { rz: a, y: hy + c * 0.65, part: 20, pv: [0, 1.35, 0.55] });
      t.box(0.3, 0.7, 0.03, hx - s * 0.9 - c * 0.18, 0, 0.58, 0xffffff, { rz: a, y: hy + c * 0.9 - s * 0.18, part: 20, pv: [0, 1.35, 0.55] });
    }
    b.ball(0.12, 0, hy0(), 0.55, PAL.dark);
    b.box(0.4, 0.6, 0.06, 0, 0.06, 0.62, PAL.woodD);
  },
  farm(b, t) {
    b.box(1.9, 0.08, 1.9, 0, 0, 0, 0x5a4026);
    for (let i = 0; i < 4; i++) {
      b.box(1.7, 0.2, 0.26, 0, 0.06, -0.69 + i * 0.46, i % 2 ? 0xe2c04a : 0x7fb74a);
    }
    t.box(0.08, 0.6, 0.08, 0.85, 0.06, 0.85, 0xffffff); // team marker post
    b.box(0.25, 0.07, 0.07, 0.85, 0.5, 0.85, PAL.woodL);
  },
  barracks(b, t) {
    groundPad(b, 3, PAL.stoneL);
    b.box(2.5, 1.0, 1.8, 0, 0.06, -0.15, 0xc7b79a, { tint: 0.1 });
    t.gable(2.8, 1.0, 2.1, 0, 1.06, -0.15, 0xffffff, { ry: 0 });
    b.box(0.6, 0.8, 0.08, 0, 0.06, 0.78, PAL.woodD);
    for (let i = 0; i < 3; i++) b.cyl(0.025, 0.025, 1.2, 4, -0.9 + i * 0.2, 0.06, 1.1, PAL.woodL); // spear rack
    b.box(0.7, 0.07, 0.07, -0.7, 1.0, 1.1, PAL.woodD);
    t.cyl(0.25, 0.25, 0.05, 8, 0.9, 0.55, 1.05, 0xffffff, { rx: Math.PI / 2 });
    b.box(0.08, 0.9, 0.08, 0.9, 0.06, 1.05, PAL.woodD);
  },
  archery_range(b, t) {
    groundPad(b, 3, 0x6b7a4a);
    b.box(1.5, 0.9, 1.1, -0.6, 0.06, -0.8, 0xc7b79a);
    t.gable(1.8, 0.7, 1.4, -0.6, 0.96, -0.8, 0xffffff);
    for (const x of [-0.7, 0.6]) {
      b.box(0.07, 0.9, 0.07, x, 0.06, 0.9, PAL.woodD);
      b.cyl(0.4, 0.4, 0.06, 10, x, 0.6, 0.86, 0xf3ecd8, { rx: Math.PI / 2 });
      t.cyl(0.22, 0.22, 0.07, 10, x, 0.6, 0.87, 0xffffff, { rx: Math.PI / 2 });
      b.cyl(0.08, 0.08, 0.08, 8, x, 0.6, 0.88, PAL.gold, { rx: Math.PI / 2 });
    }
    b.box(0.08, 0.5, 0.08, 1.2, 0.06, -0.4, PAL.woodL); b.box(0.5, 0.06, 0.06, 1.2, 0.5, -0.4, PAL.woodL);
  },
  stables(b, t) {
    groundPad(b, 3, 0x7d6a45);
    b.box(2.5, 1.0, 1.5, 0, 0.06, -0.6, PAL.woodL, { tint: 0.15 });
    t.gable(2.8, 0.9, 1.8, 0, 1.06, -0.6, 0xffffff);
    b.box(0.9, 0.8, 0.08, 0, 0.06, 0.16, PAL.woodD);
    for (let i = 0; i < 6; i++) b.box(0.07, 0.5, 0.07, -1.2 + i * 0.48, 0.06, 1.2, PAL.woodD);
    b.box(2.5, 0.06, 0.06, 0, 0.5, 1.2, PAL.woodD); b.box(2.5, 0.06, 0.06, 0, 0.3, 1.2, PAL.woodD);
    b.box(0.5, 0.4, 0.4, 1.0, 0.06, 0.8, 0xd6c06a); // hay
  },
  siege_workshop(b, t) {
    groundPad(b, 3, 0x5c5f66);
    b.box(0.12, 1.5, 0.12, -1.2, 0.06, -0.6, PAL.woodL); b.box(0.12, 1.5, 0.12, 1.2, 0.06, -0.6, PAL.woodL);
    b.box(0.12, 1.5, 0.12, -1.2, 0.06, 0.9, PAL.woodL); b.box(0.12, 1.5, 0.12, 1.2, 0.06, 0.9, PAL.woodL);
    t.gable(2.8, 0.9, 2.1, 0, 1.56, 0.15, 0xffffff);
    b.box(2.2, 0.8, 0.12, 0, 0.06, -0.6, PAL.woodD);
    b.cyl(0.4, 0.4, 0.14, 10, -0.4, 0.3, 0.2, PAL.steelD, { rx: Math.PI / 2 }); // gear
    b.cyl(0.14, 0.14, 0.18, 6, -0.4, 0.5, 0.2, PAL.steel, { rx: Math.PI / 2 });
    b.box(0.1, 1.1, 0.1, 0.7, 0.06, 0.4, PAL.woodL); b.box(0.9, 0.08, 0.08, 0.4, 1.1, 0.4, PAL.woodL);
    b.box(0.3, 0.3, 0.3, 0.7, 0.3, 0.9, PAL.stoneD);
  },
  blacksmith(b, t) {
    groundPad(b, 3, PAL.stoneL);
    b.box(2.0, 1.1, 1.8, -0.2, 0.06, -0.3, PAL.stoneD, { tint: 0.2 });
    t.gable(2.3, 0.8, 2.1, -0.2, 1.16, -0.3, 0xffffff);
    b.box(0.4, 1.8, 0.4, -0.8, 0.06, -0.6, PAL.stone);
    b.box(0.3, 0.2, 0.06, 0.2, 0.5, 0.62, PAL.fire, { part: 22 }); // forge glow (flickers)
    b.box(0.5, 0.3, 0.3, 1.0, 0.06, 0.9, PAL.dark); b.box(0.7, 0.14, 0.2, 1.0, 0.36, 0.9, PAL.steelD); // anvil
    b.box(0.5, 0.5, 0.06, -0.2, 0.06, 0.62, PAL.woodD);
  },
  tower(b, t) {
    groundPad(b, 2, PAL.stoneL, 0.1);
    b.cyl(0.62, 0.78, 2.6, 8, 0, 0.1, 0, PAL.stone, { tint: 0.15 });
    b.cyl(0.82, 0.74, 0.4, 8, 0, 2.7, 0, PAL.stoneD);
    for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; b.box(0.2, 0.28, 0.2, Math.sin(a) * 0.78, 3.1, Math.cos(a) * 0.78, PAL.stoneL); }
    t.cone(0.7, 0.9, 8, 0, 3.4, 0, 0xffffff);
    b.box(0.14, 0.3, 0.06, 0, 1.6, 0.68, PAL.dark);
    b.cyl(0.03, 0.03, 0.5, 4, 0, 4.2, 0, PAL.woodD);
    t.add(new THREE.BoxGeometry(0.46, 0.22, 0.03, 7, 2, 1), { x: 0.25, y: 4.5, z: 0, c: 0xffffff, part: 21, pv: [0.03, 0, 0] }); // pennant
  },
  wall(b, t) {
    b.box(1.02, 1.1, 1.02, 0, 0, 0, PAL.stone, { tint: 0.2 });
    t.box(0.5, 0.15, 0.5, 0, 1.1, 0, 0xffffff);
    for (const x of [-0.3, 0.3]) b.box(0.3, 0.2, 0.3, x, 1.1, x < 0 ? -0.3 : 0.3, PAL.stoneL);
  },
  gate(b, t) {
    b.box(0.3, 1.5, 1.0, -0.36, 0, 0, PAL.stone); b.box(0.3, 1.5, 1.0, 0.36, 0, 0, PAL.stone);
    b.box(1.02, 0.3, 1.0, 0, 1.2, 0, PAL.stoneD);
    b.box(0.5, 1.0, 0.1, 0, 0, 0, PAL.woodD);
    t.box(0.4, 0.2, 0.4, 0, 1.5, 0, 0xffffff);
  },
};

// fallback for unknown types
function generic(b, t, size) { b.box(size * 0.8, 1, size * 0.8, 0, 0, 0, PAL.stone); t.pyramid(size * 0.8, 0.6, 0, 1, 0, 0xffffff); }

const cache = new Map();
const HUMAN = new Set(['worker', 'spearman', 'swordsman', 'archer', 'skirmisher', 'healer', 'sapper']);
// chimney smoke anchors (model space, relative to the building centre) and the building's flame spots
export const SMOKE = { house: [-0.4, 1.78, -0.2], town_center: [-0.55, 4.0, -0.55], blacksmith: [-0.8, 1.9, -0.6] };
// open scaffold (poles, rails, braces) of unit height; the caller scales y with the construction progress
const scaf = new Map();
// steel = the scaffold of a world with no wood (video, page parameter scaffold=steel): gunmetal posts and rails, ochre braces, thicker, two rails instead of a picket fence of three (Dustmoon, Partie 11 check 05.11.)
export function scaffoldModel(size, steel = false) {
  const key = steel ? 'steel' + size : size;
  if (scaf.has(key)) return scaf.get(key);
  const b = new Builder(), h = size * 0.5 + 0.12, L = size + 0.24;
  const post = steel ? 0x59606a : PAL.woodL, rail = steel ? 0x30353c : PAL.woodD, brace = steel ? 0xc9953a : PAL.woodD, pw = steel ? 0.13 : 0.08, rw = steel ? 0.08 : 0.05;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(pw, 1, pw, sx * h, 0, sz * h, post);
  for (const yy of steel ? [0.46, 0.94] : [0.3, 0.62, 0.94]) {
    for (const sz of [-1, 1]) b.box(L, rw, rw, 0, yy, sz * h, rail);
    for (const sx of [-1, 1]) b.box(rw, rw, L, sx * h, yy, 0, rail);
  }
  for (const sz of [-1, 1]) for (const k of [-1, 1]) b.box(steel ? 0.06 : 0.04, 1.25, steel ? 0.06 : 0.04, 0, 0, sz * h, brace, { y: 0.5, rz: k * Math.min(0.9, (size * 0.5) / 1.1) });
  const g = b.build();
  scaf.set(key, g);
  return g;
}
// construction marker (page parameter scaffold=marker): four gunmetal pylons with amber caps and no rails; the hazard-stripe panels between them are made in app.mjs (not a fence silhouette, Dustmoon, Partie 11 check 05.11.)
export function markerModel(size) {
  const key = 'marker' + size;
  if (scaf.has(key)) return scaf.get(key);
  const b = new Builder(), h = size * 0.5 + 0.12;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { b.box(0.2, 1, 0.2, sx * h, 0, sz * h, 0x59606a); b.box(0.32, 0.07, 0.32, sx * h, 0.96, sz * h, 0xffb028); }
  const g = b.build();
  scaf.set(key, g);
  return g;
}
export function unitModel(name) {
  if (cache.has('u' + name)) return cache.get('u' + name);
  const b = new Builder(), t = new Builder();
  if (HUMAN.has(name)) b.dy = t.dy = LIFT; // humans stand on animated legs
  (UNIT_BUILD[name] || ((bb, tt) => { bb.box(0.4, 0.6, 0.4, 0, 0, 0, PAL.cloth); tt.box(0.42, 0.15, 0.42, 0, 0.6, 0, 0xffffff); }))(b, t);
  const m = { body: b.build(), team: t.build() };
  cache.set('u' + name, m);
  return m;
}
export function buildingModel(name, size) {
  if (cache.has('b' + name)) return cache.get('b' + name);
  const b = new Builder(), t = new Builder();
  (BUILDING_BUILD[name] || ((bb, tt) => generic(bb, tt, size)))(b, t);
  const m = { body: b.build(), team: t.build() };
  cache.set('b' + name, m);
  return m;
}

// trees, rocks, ore, bushes (resource nodes and decoration)
export function treeModel() {
  const b = new Builder(), t = new Builder();
  b.cyl(0.07, 0.1, 0.4, 5, 0, 0, 0, 0x6b4a32);
  t.cone(0.42, 0.7, 6, 0, 0.3, 0, 0xffffff);
  t.cone(0.33, 0.6, 6, 0, 0.7, 0, 0xffffff);
  t.cone(0.22, 0.5, 6, 0, 1.1, 0, 0xffffff);
  return { trunk: b.build(), leaves: t.build() };
}
export function nodeModel(kind, size) {
  const b = new Builder(), t = new Builder();
  if (kind === 'gold') {
    b.cone(0.5, 0.9, 5, -0.3, 0, -0.2, 0x6a7280); b.cone(0.45, 0.7, 5, 0.4, 0, 0.3, 0x7d8796);
    for (const [x, z, h, r] of [[0, 0.1, 1.2, 0.2], [0.5, -0.4, 0.8, 0.15], [-0.45, 0.5, 0.7, 0.16], [0.1, -0.5, 0.6, 0.14]]) {
      t.add(new THREE.OctahedronGeometry(r, 0), { x, y: h * 0.5 + 0.1, z, sy: 2.2, c: 0xffffff, ry: x * 3 });
    }
  } else if (kind === 'stone') {
    b.add(new THREE.DodecahedronGeometry(0.62, 0), { x: -0.25, y: 0.45, z: -0.2, c: 0x9aa1ab, sy: 0.85 });
    b.add(new THREE.DodecahedronGeometry(0.5, 0), { x: 0.5, y: 0.35, z: 0.3, c: 0x808998, sy: 0.8, ry: 1 });
    b.add(new THREE.DodecahedronGeometry(0.3, 0), { x: -0.4, y: 0.22, z: 0.55, c: 0xb3bac6 });
    t.box(0.001, 0.001, 0.001, 0, 0, 0, 0xffffff);
  } else if (kind === 'berries') {
    b.ball(0.38, 0, 0, 0, 0x3c7a3a, { sy: 0.8 });
    for (let i = 0; i < 7; i++) { const a = i * 0.9; b.ball(0.06, Math.sin(a) * 0.3, 0.3 + (i % 3) * 0.08, Math.cos(a) * 0.3, 0xd8344f); }
    t.box(0.001, 0.001, 0.001, 0, 0, 0, 0xffffff);
  } else { // herd animal
    b.box(0.4, 0.3, 0.7, 0, 0.3, 0, 0xcbb08a);
    for (const x of [-0.12, 0.12]) for (const z of [-0.25, 0.25]) b.box(0.07, 0.3, 0.07, x, 0, z, 0x8a7355);
    b.box(0.2, 0.2, 0.28, 0, 0.5, 0.42, 0xcbb08a); b.box(0.04, 0.2, 0.04, -0.06, 0.66, 0.46, 0x8a7355); b.box(0.04, 0.2, 0.04, 0.06, 0.66, 0.46, 0x8a7355);
    t.box(0.001, 0.001, 0.001, 0, 0, 0, 0xffffff);
  }
  return { body: b.build(), accent: t.build() };
}
