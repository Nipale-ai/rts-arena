// Particle effects: soft billboard puffs (dust, smoke), additive glows (fire, flashes) and solid debris (sparks, chips, shards).
// Three instanced meshes, updated from the frame dt only; spawn jitter uses Math.random (seeded by render/broadcast.mjs in broadcast mode).
import * as THREE from './vendor/three.module.js';
import { FX_PALETTE_DEFAULTS } from './theme/fx-palette.mjs'; // the colours of the effects: the classic literals, a theme may name its own (render/theme/fx-theme.mjs)

const R = () => Math.random();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function softTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.75)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// per-instance alpha for MeshBasicMaterial (attribute aAlpha)
function alphaMaterial(params) {
  const m = new THREE.MeshBasicMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
  };
  m.customProgramCacheKey = () => 'fxalpha';
  return m;
}

export class Fx {
  constructor(scene, camera, cap = 3000) {
    this.camera = camera;
    this.groundAt = () => 0;
    this.caps = { puff: Math.round(cap * 0.55), glow: Math.round(cap * 0.2), debris: Math.round(cap * 0.45) };
    const tex = softTexture(), plane = new THREE.PlaneGeometry(1, 1);
    const mk = (geo, mat, n) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.frustumCulled = false; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.renderOrder = 4;
      scene.add(m);
      return m;
    };
    this.puffMesh = mk(plane, alphaMaterial({ map: tex, transparent: true, depthWrite: false }), this.caps.puff);
    this.glowMesh = mk(plane.clone(), alphaMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), this.caps.glow);
    this.debMesh = mk(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), this.caps.debris);
    this.glowMesh.userData.bloom = true; this.debMesh.userData.bloom = true; // post.mjs: sparks and flames glow
    for (const m of [this.puffMesh, this.glowMesh]) {
      m.geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count), 1).setUsage(THREE.DynamicDrawUsage));
    }
    this.p = [];
    this.n = { puff: 0, glow: 0, debris: 0 };
    this._q = new THREE.Quaternion(); this._qz = new THREE.Quaternion(); this._m = new THREE.Matrix4();
    this._pos = new THREE.Vector3(); this._sc = new THREE.Vector3(); this._c = new THREE.Color(); this._e = new THREE.Euler();
    this._ax = new THREE.Vector3(0, 0, 1);
  }
  get load() { return this.p.length / (this.caps.puff + this.caps.glow + this.caps.debris); }

  // the death of a unit in a video: team-coloured soft sparks (round, additive) instead of the cubes of shards(); same spread, no gravity, they fade out
  softSparks(x, y, z, color, n, speed = 2, size = 0.3, life = 0.7) { // (not 'sparks': that name is the sapper's fuse below, a second method of the same name would replace it)
    for (let i = 0; i < n; i++) {
      const a = R() * 6.28, up = 0.4 + R() * 1.1, sp = (0.3 + R()) * speed;
      this.emit('glow', { x, y, z, vx: Math.cos(a) * sp, vy: up * speed * 0.6, vz: Math.sin(a) * sp, s0: size * (0.7 + R() * 0.6), s1: size * 0.15, life: life * (0.6 + R() * 0.7), col: color, a0: 0.8, drag: 2.2, fade: 0.2, rot: 0, vr: 0 });
    }
  }
  // kind: 'puff' | 'glow' | 'debris'
  emit(kind, o) {
    if (this.n[kind] >= this.caps[kind]) return;
    this.n[kind]++;
    this.p.push({ kind, x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, s0: o.s0, s1: o.s1 ?? o.s0, life: o.life, max: o.life,
      col: new THREE.Color(o.col ?? 0xffffff), a0: o.a0 ?? 1, g: o.g || 0, drag: o.drag || 0, rot: o.rot ?? R() * 6.28, vr: o.vr ?? (R() - 0.5) * (o.spin ?? 1.2), bounce: o.bounce ?? 0.3, fade: o.fade ?? 0.12 });
  }

  // ---------- compatible helpers (older call sites)
  burst(x, y, z, color, n, speed = 2.5, size = 0.12, life = 0.7) { this.shards(x, y, z, color, n, speed, size, life); }
  puff(x, y, z, color, size = 0.5, life = 1.6) {
    this.emit('puff', { x: x + (R() - 0.5) * 0.4, y, z: z + (R() - 0.5) * 0.4, vx: (R() - 0.5) * 0.3, vy: 0.9 + R() * 0.5, vz: (R() - 0.5) * 0.3, s0: size * 0.8, s1: size * 3, life, col: color, a0: 0.5, drag: 0.4 });
  }

  // ---------- seeded effects: `rand` is a deterministic generator (anim.mjs `seq`), never Math.random, so broadcast renders stay frame-exact and chunked renders equal serial ones.
  // Particle `emit` takes explicit rot/vr here for the same reason.
  _d(kind, rand, o) { this.emit(kind, { ...o, rot: rand() * 6.28, vr: (rand() - 0.5) * (o.spin ?? 1.2) }); }
  // the hit of a work tool at its tip (x,y,z): code 8 wood chips, 9 stone sparks, 11 hammer on timber. (dx,dz) = unit vector the tool moves along (the unit's facing).
  workFx(code, x, y, z, dx, dz, rand) {
    const sx = -dz, sz = dx; // sideways
    const out = (n, sp, up, back = 0.35) => { // direction of one particle: mostly away from the tool, a little back towards the worker, spread sideways
      const f = (rand() - 0.5) * 1.6, b = (rand() - back) * sp;
      return { vx: sx * f * sp * 0.6 + dx * b * 0.5, vz: sz * f * sp * 0.6 + dz * b * 0.5, vy: up * (0.6 + rand() * 0.8) };
    };
    if (code === 8) {
      for (let i = 0; i < 7; i++) { const v = out(i, 2.0, 2.2); this._d('debris', rand, { x, y, z, ...v, s0: 0.05 + rand() * 0.045, life: 0.5 + rand() * 0.4, col: rand() < 0.5 ? 0xe2c08a : 0xb98a52, g: 8, spin: 12 }); }
      this._d('puff', rand, { x, y: y - 0.02, z, vx: dx * 0.15, vy: 0.3, vz: dz * 0.15, s0: 0.08, s1: 0.26, life: 0.45, col: 0xcdb98e, a0: 0.28, drag: 1.4 });
    } else if (code === 9) {
      this._d('glow', rand, { x, y, z, s0: 0.38, s1: 0.1, life: 0.12, col: 0xfff0c0, a0: 0.9, fade: 0.1 });
      for (let i = 0; i < 5; i++) { const v = out(i, 2.8, 2.6, 0.2); this._d('debris', rand, { x, y, z, ...v, s0: 0.035 + rand() * 0.025, life: 0.22 + rand() * 0.28, col: rand() < 0.5 ? 0xfff0b0 : 0xffc060, g: 9, spin: 0 }); }
      for (let i = 0; i < 3; i++) { const v = out(i, 1.6, 1.4); this._d('debris', rand, { x, y, z, ...v, s0: 0.04 + rand() * 0.03, life: 0.45 + rand() * 0.25, col: 0x8d8f94, g: 8, spin: 10 }); }
      this._d('puff', rand, { x, y: y - 0.03, z, vx: dx * 0.1, vy: 0.3, vz: dz * 0.1, s0: 0.07, s1: 0.22, life: 0.4, col: 0xb7b0a2, a0: 0.26, drag: 1.5 });
    } else {
      this._d('glow', rand, { x, y, z, s0: 0.2, s1: 0.06, life: 0.09, col: 0xffe4a0, a0: 0.55, fade: 0.08 });
      for (let i = 0; i < 4; i++) { const v = out(i, 1.6, 1.5); this._d('debris', rand, { x, y, z, ...v, s0: 0.035 + rand() * 0.03, life: 0.4 + rand() * 0.25, col: rand() < 0.5 ? 0xd2ad72 : 0x9a7442, g: 8, spin: 10 }); }
      this._d('puff', rand, { x, y: y - 0.02, z, vx: dx * 0.1, vy: 0.3, vz: dz * 0.1, s0: 0.07, s1: 0.22, life: 0.4, col: 0xc4b48e, a0: 0.26, drag: 1.5 });
    }
  }

  // a weapon connects with a unit at (x,y,z): a white flash, a few small sparks and a puff of dust, no blood (youth-safe). (dx,dz) = unit vector from the attacker to the victim, `heavy` = sword / lance / ram.
  contact(x, y, z, dx, dz, rand, heavy = false) {
    const sx = -dz, sz = dx;
    this._d('glow', rand, { x, y, z, s0: heavy ? 0.9 : 0.65, s1: 0.2, life: 0.14, col: 0xffffff, a0: 0.95, fade: 0.1 });
    const n = heavy ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const f = (rand() - 0.5) * 1.8, v = 0.6 + rand() * 1.6;
      this._d('debris', rand, { x, y, z, vx: sx * f * 1.4 + dx * v * 0.8, vy: 0.5 + rand() * 1.5, vz: sz * f * 1.4 + dz * v * 0.8, s0: 0.045 + rand() * 0.03, life: 0.22 + rand() * 0.24, col: rand() < 0.5 ? 0xffffff : 0xffe9a8, g: 9, spin: 0 });
    }
    this._d('puff', rand, { x: x + dx * 0.05, y: y - 0.45, z: z + dz * 0.05, vx: dx * 0.35, vy: 0.3, vz: dz * 0.35, s0: 0.09, s1: heavy ? 0.34 : 0.26, life: 0.45, col: 0xcfc6b0, a0: 0.3, drag: 1.5 });
  }

  // ---------- theme effects of the shooters (render/shooter-theme.mjs, hooks in render/app.mjs). Seeded like the two above (`rand` = anim.mjs seq), never Math.random.
  // `e` = { fx: 'flash' | 'sparks' | 'puff', color, size (tiles, the bright core), life (s) } as the theme names it (THEME-VERTRAG.md: muzzle, hit).
  // muzzle flash at the barrel (x,y,z); (dx,dz) = unit vector away from the shooter: a white-hot core and a larger halo in the theme colour, plus a fan of sparks (sparks), a puff (puff) or two stray sparks (flash)
  muzzle(x, y, z, dx, dz, e, rand) {
    const s = e.size, L = e.life;
    this._d('glow', rand, { x, y, z, s0: s * 1.6, s1: s * 0.5, life: L, col: e.core ?? 0xffffff, a0: 0.95, fade: 0.08 }); // (core: the colour the theme names for the hot centre, else white)
    this._d('glow', rand, { x: x + dx * s * 0.5, y, z: z + dz * s * 0.5, s0: s * 3, s1: s, life: L * 1.4, col: e.color, a0: 0.7, fade: 0.08 });
    const n = e.fx === 'sparks' ? Math.min(14, Math.round(4 + s * 9)) : e.fx === 'flash' ? 2 : 0;
    for (let i = 0; i < n; i++) {
      const f = (rand() - 0.5) * 0.9, v = 2.2 + rand() * 2.2;
      this._d('debris', rand, { x, y, z, vx: dx * v - dz * f * v * 0.5, vy: (rand() - 0.3) * 0.9, vz: dz * v + dx * f * v * 0.5, s0: 0.035 + rand() * 0.025, life: 0.14 + rand() * 0.14, col: e.color, g: 2, spin: 0 });
    }
    if (e.fx === 'puff') this._d('puff', rand, { x: x + dx * 0.15, y, z: z + dz * 0.15, vx: dx * 0.5, vy: 0.2, vz: dz * 0.5, s0: s * 0.7, s1: s * 2.2, life: 0.5, col: e.color, a0: 0.3, drag: 1.5 });
  }
  // a themed shot lands at (x,y,z): a flash in the theme colour and, by `fx`, sparks (the default, in the colour and white), a puff or just the flash; a faint puff of dust under sparks
  boltHit(x, y, z, e, rand) {
    const s = e.size;
    this._d('glow', rand, { x, y, z, s0: s * 3.2, s1: s * 0.6, life: e.life * 0.8, col: e.color, a0: 0.95, fade: 0.1 });
    if (e.fx === 'sparks' || e.fx === 'flash') {
      const n = e.fx === 'sparks' ? Math.min(14, Math.round(4 + s * 12)) : 2;
      for (let i = 0; i < n; i++) {
        const a = rand() * 6.28, sp = (0.5 + rand()) * 2.8;
        this._d('debris', rand, { x, y, z, vx: Math.cos(a) * sp, vy: 0.9 + rand() * 2.2, vz: Math.sin(a) * sp, s0: 0.06 + rand() * 0.04, life: e.life + rand() * 0.2, col: rand() < 0.35 ? (e.spark ?? 0xffffff) : e.color, g: 9, spin: 0 }); // (spark: the colour the theme names for the bright third, else white)
      }
      if (e.fx === 'sparks') this._d('puff', rand, { x, y: y - 0.4, z, vx: (rand() - 0.5) * 0.3, vy: 0.3, vz: (rand() - 0.5) * 0.3, s0: 0.1, s1: 0.3, life: 0.4, col: this.pal.dust, a0: 0.2, drag: 1.5 });
    } else this._d('puff', rand, { x, y: y - 0.2, z, vx: (rand() - 0.5) * 0.3, vy: 0.5, vz: (rand() - 0.5) * 0.3, s0: s * 0.7, s1: s * 2.2, life: 0.55, col: e.color, a0: 0.3, drag: 1.2 });
  }
  // one light of the trail of a themed bolt (or, short and big, its halo): needs no random number (a round glow looks the same turned)
  boltTrail(x, y, z, col, life = 0.24, size = 0.2) {
    this.emit('glow', { x, y, z, s0: size, s1: size * 0.2, life, col, a0: 0.6, fade: 0.05, rot: 0, vr: 0 });
  }

  // ---------- effects
  shards(x, y, z, color, n, speed = 2.5, size = 0.12, life = 0.7) {
    if (this.soft && size >= 0.15) { // video (this.soft): no cubes. Clods of rubble and dust instead: soft round puffs in the colour of the pieces, flung out and falling; the tiny chips (size < 0.15) stay
      for (let i = 0; i < n; i++) {
        const a = R() * 6.28, up = 0.5 + R() * 1.5, sp = (0.3 + R()) * speed;
        this.emit('puff', { x, y, z, vx: Math.cos(a) * sp, vy: up * speed * 0.8, vz: Math.sin(a) * sp, s0: size * (1.5 + R() * 1.2), s1: size * (2.6 + R() * 1.4), life: life * (0.7 + R() * 0.8), col: color, a0: 0.8, g: 6, drag: 1.1, fade: 0.4 });
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const a = R() * 6.28, up = 0.5 + R() * 1.5, sp = (0.3 + R()) * speed;
      this.emit('debris', { x, y, z, vx: Math.cos(a) * sp, vy: up * speed * 0.8, vz: Math.sin(a) * sp, s0: size * (0.6 + R()), life: life * (0.6 + R() * 0.7), col: color, g: 8, spin: 10 });
    }
  }
  dust(x, y, z, size = 0.2, strength = 1, color = this.pal.dust) {
    this.emit('puff', { x: x + (R() - 0.5) * size, y: y + 0.05, z: z + (R() - 0.5) * size, vx: (R() - 0.5) * 0.5, vy: 0.3 + R() * 0.3, vz: (R() - 0.5) * 0.5, s0: size * 0.6, s1: size * 2, life: 0.5 + R() * 0.25, col: color, a0: 0.33 * strength, drag: 1.6 });
  }
  cloud(x, y, z, radius, n, color = this.pal.cloud, a0 = 0.5, size = 0.8) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + R() * 0.5, sp = 0.8 + R() * 1.4, r0 = radius * (0.3 + R() * 0.5);
      this.emit('puff', { x: x + Math.cos(a) * r0, y: y + 0.15, z: z + Math.sin(a) * r0, vx: Math.cos(a) * sp, vy: 0.3 + R() * 0.7, vz: Math.sin(a) * sp, s0: size * (0.5 + R() * 0.5), s1: size * (1.8 + R()), life: 1.1 + R() * 0.9, col: color, a0, drag: 1.3 });
    }
  }
  chimney(x, y, z, strong = 1) {
    this.emit('puff', { x: x + (R() - 0.5) * 0.06, y, z: z + (R() - 0.5) * 0.06, vx: 0.2 + R() * 0.12, vy: 0.5 + R() * 0.15, vz: 0.05 + (R() - 0.5) * 0.1, s0: 0.12 * strong, s1: 0.7 * strong, life: 2.8 + R() * 0.8, col: this.pal.chimney, a0: 0.42, drag: 0.15 });
  }
  smoke(x, y, z, size = 0.5, dark = 0.5, life = 1.8) {
    const c = dark > 0.5 ? this.pal.smoke_dark : this.pal.smoke_light;
    this.emit('puff', { x, y, z, vx: 0.25 + (R() - 0.5) * 0.3, vy: 0.9 + R() * 0.5, vz: (R() - 0.5) * 0.3, s0: size * 0.6, s1: size * 2.6, life, col: c, a0: 0.5, drag: 0.3 });
  }
  flame(x, y, z, size = 0.35) {
    this.emit('glow', { x, y, z, vx: (R() - 0.5) * 0.25, vy: 0.9 + R() * 0.8, vz: (R() - 0.5) * 0.25, s0: size, s1: size * 0.15, life: 0.45 + R() * 0.3, col: R() < 0.5 ? this.pal.flame : this.pal.flame2, a0: 0.85, drag: 0.5, fade: 0.2 });
    if (R() < 0.25) this.emit('debris', { x, y, z, vx: (R() - 0.5) * 0.6, vy: 1.2 + R() * 1.2, vz: (R() - 0.5) * 0.6, s0: 0.045, life: 0.9 + R() * 0.6, col: this.pal.ember, g: -0.4, spin: 0 });
  }
  flash(x, y, z, size = 0.5, col = this.pal.flash) {
    this.emit('glow', { x, y, z, s0: size, s1: size * 0.25, life: 0.13, col, a0: 0.9, fade: 0.1 });
  }
  sparks(x, y, z, n = 5, speed = 2.6, c1 = this.pal.spark, c2 = this.pal.spark2, cf = this.pal.flash, fs = 0.42) { // (c1, c2, cf, fs: the sapper's fuse names its own; the defaults are the old colours and the old size)
    this.flash(x, y, z, fs, cf);
    for (let i = 0; i < n; i++) {
      const a = R() * 6.28, sp = (0.4 + R()) * speed;
      this.emit('debris', { x, y, z, vx: Math.cos(a) * sp, vy: 0.8 + R() * 2.0, vz: Math.sin(a) * sp, s0: 0.05 + R() * 0.03, life: 0.25 + R() * 0.3, col: R() < 0.5 ? c1 : c2, g: 9, spin: 0 });
    }
  }
  chips(x, y, z, color, n = 6, speed = 2.2, size = 0.09) { this.shards(x, y, z, color, n, speed, size, 0.8); }
  trail(x, y, z, big = false) {
    if (big) this.emit('puff', { x, y, z, vx: (R() - 0.5) * 0.2, vy: 0.15, vz: (R() - 0.5) * 0.2, s0: 0.22, s1: 0.65, life: 1.0, col: this.pal.trail_big, a0: 0.4, drag: 0.5 });
    else this.emit('puff', { x, y, z, s0: 0.07, s1: 0.16, life: 0.32, col: this.pal.trail_small, a0: 0.4, drag: 0 });
  }
  // catapult stone lands: shock cloud, debris, flash
  impact(x, z, splash, fiery = false) {
    const y = this.groundAt(x, z);
    if (splash && fiery) { // mortar shell: bright flash, dark smoke, debris
      this.blast(x, z, 0.75);
      return;
    }
    if (splash) {
      this.cloud(x, y, z, 1.2, 16, this.pal.impact_dust, 0.72, 1.15);
      this.shards(x, y + 0.3, z, this.pal.shard_stone, 14, 4.2, 0.2, 1.1);
      this.shards(x, y + 0.2, z, this.pal.shard_earth, 8, 3.2, 0.16, 1.1);
      this.flash(x, y + 0.5, z, 1.4);
    } else {
      this.dust(x, y, z, 0.3, 1);
      this.emit('debris', { x, y: y + 0.1, z, vx: (R() - 0.5), vy: 1.5, vz: (R() - 0.5), s0: 0.05, life: 0.4, col: 0xf1e7c8, g: 9, spin: 0 });
    }
  }
  // a themed splash shot (catapult stone, mortar shell) lands: the classic landing in the palette colours, and on top the `hit` effect of the theme (flash / sparks / puff, seeded like boltHit)
  splashHit(x, z, fiery, e, rand) {
    this.impact(x, z, true, fiery);
    this.boltHit(x, this.groundAt(x, z) + 0.6, z, e, rand);
  }
  // charge or mortar shell goes off: white-hot flash, a fire ball, debris and a column of black smoke
  blast(x, z, size = 1, o = null) { // o: { flash, fire, fire2 } = the colours the sapper's blast names (a theme); null = the palette
    const y = this.groundAt(x, z), P = this.pal, cf = o ? o.flash : P.blast_flash, c1 = o ? o.fire : P.blast_fire, c2 = o ? o.fire2 : P.blast_fire2;
    this.flash(x, y + 0.7, z, 2.4 * size, cf);
    for (let i = 0; i < 6; i++) this.emit('glow', { x: x + (R() - 0.5) * 0.8 * size, y: y + 0.4 + R() * 0.8, z: z + (R() - 0.5) * 0.8 * size, vy: 0.6 + R(), s0: 0.9 * size, s1: 0.2, life: 0.4 + R() * 0.3, col: R() < 0.5 ? c1 : c2, a0: 0.85, fade: 0.1 });
    this.cloud(x, y, z, 1.1 * size, Math.round(12 * size) + 4, P.blast_smoke, 0.62, 1.1 * size);
    this.shards(x, y + 0.5, z, P.shard_earth, Math.round(12 * size) + 4, 4.6, 0.2, 1.2);
    this.shards(x, y + 0.5, z, P.shard_stone, Math.round(8 * size) + 2, 4, 0.16, 1.1);
    for (let i = 0; i < 3; i++) this.smoke(x + (R() - 0.5) * 0.6, y + 0.8, z + (R() - 0.5) * 0.6, 0.9 * size, 0.85, 2.4);
  }
  // a unit was healed: small rising green glow and a plus-like twinkle
  heal(x, y, z) {
    this.emit('glow', { x: x + (R() - 0.5) * 0.3, y, z: z + (R() - 0.5) * 0.3, vy: 0.9, s0: 0.35, s1: 0.1, life: 0.55, col: this.pal.heal, a0: 0.9, fade: 0.08 });
  }
  // building falls down: dust wall, rubble, smoke column
  collapse(cx, cz, size, y = 0) {
    this.cloud(cx, y, cz, size * 0.55, 14 + Math.round(size * 5), this.pal.collapse_dust, 0.8, 1.1 + size * 0.3);
    this.shards(cx, y + 0.8, cz, this.pal.rubble_wood, 14 + size * 4, 3.4, 0.22, 1.3);
    this.shards(cx, y + 0.6, cz, this.pal.rubble_stone, 8 + size * 3, 3.0, 0.2, 1.3);
    for (let i = 0; i < 5; i++) this.smoke(cx + (R() - 0.5) * size * 0.6, y + 0.8, cz + (R() - 0.5) * size * 0.6, 0.9, 0.7, 2.6);
  }

  update(dt) {
    const g0 = this.groundAt;
    const cq = this.camera.quaternion, q = this._q, qz = this._qz, m = this._m, pos = this._pos, sc = this._sc, col = this._c, e = this._e;
    const cnt = { puff: 0, glow: 0, debris: 0 };
    const P = this.p;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= dt;
      if (p.life <= 0) { this.n[p.kind]--; P[i] = P[P.length - 1]; P.pop(); continue; }
      if (p.drag) { const k = Math.max(0, 1 - p.drag * dt); p.vx *= k; p.vz *= k; if (p.kind !== 'debris') p.vy *= k; }
      p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.kind === 'debris' && p.g > 0) {
        const gy = g0(p.x, p.z) + 0.03;
        if (p.y < gy) { p.y = gy; p.vy *= -p.bounce; p.vx *= 0.6; p.vz *= 0.6; }
      }
      p.rot += p.vr * dt;
    }
    for (const p of P) {
      const f = p.life / p.max, age = 1 - f;
      if (p.kind === 'debris') {
        const s = p.s0 * Math.min(1, f * 3.5);
        e.set(p.rot, p.rot * 0.7, p.rot * 1.3); q.setFromEuler(e);
        pos.set(p.x, p.y, p.z); sc.set(s, s, s); m.compose(pos, q, sc);
        const i = cnt.debris++;
        this.debMesh.setMatrixAt(i, m);
        this.debMesh.instanceColor.setXYZ(i, p.col.r, p.col.g, p.col.b);
      } else {
        const mesh = p.kind === 'puff' ? this.puffMesh : this.glowMesh;
        const i = p.kind === 'puff' ? cnt.puff++ : cnt.glow++;
        const s = p.s0 + (p.s1 - p.s0) * (p.kind === 'glow' ? age : Math.sqrt(age));
        qz.setFromAxisAngle(this._ax, p.rot); q.copy(cq).multiply(qz);
        pos.set(p.x, p.y, p.z); sc.set(s, s, s); m.compose(pos, q, sc);
        mesh.setMatrixAt(i, m);
        mesh.instanceColor.setXYZ(i, p.col.r, p.col.g, p.col.b);
        mesh.geometry.attributes.aAlpha.array[i] = p.a0 * clamp(age / p.fade, 0, 1) * (p.kind === 'glow' ? f : Math.pow(f, 0.8));
      }
    }
    for (const [mesh, n] of [[this.puffMesh, cnt.puff], [this.glowMesh, cnt.glow], [this.debMesh, cnt.debris]]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
      if (mesh.geometry.attributes.aAlpha) mesh.geometry.attributes.aAlpha.needsUpdate = true;
    }
  }
}
// the colours of the effects: the old literals; app.mjs sets `fx.pal` to the palette of the theme (render/theme/fx-theme.mjs). On the prototype, so an Fx made without the constructor (the tests) has them too
Fx.prototype.pal = FX_PALETTE_DEFAULTS;
