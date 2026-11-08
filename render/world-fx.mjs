// The living world on screen: weather (rain, snow, sandstorm, fog, lightning, wet ground), chat speech bubbles over the town centres, fish shoals,
// and the weather chip. Everything is a pure function of the snapshot and the animation clock (no wall clock, no random numbers), so the
// frame-exact broadcast renderer draws exactly what the spectator would see. The sim only says which weather runs (snapshot field wx).
import * as THREE from './vendor/three.module.js';
import { WET, WATER_T } from './terrain.mjs';
import { flashOf, newStrike, closeStrike, STORM_LOOK, STORM_RISE_S } from './lightning.mjs';
import { bubbleCenter, bubbleFit, topBelowCards } from './bubble-place.mjs';
import { weatherLooks } from './theme/nature-theme.mjs'; // theme: colour and fog of each weather, style of the storm (the very same LOOKS without a theme)

const WEATHER_KINDS = ['clear', 'rain', 'fog', 'snow', 'storm']; // same order as sim/world-data.mjs
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const WL = -0.36;

// what each weather looks like: sky cover, fog density multiplier, particles, wet ground, storm darkness
const LOOKS = {
  clear: { over: 0, fog: 1, rain: 0, snow: 0, wet: 0, storm: 0, col: 0x8d98a6 },
  rain: { over: 0.32, fog: 0.92, rain: 0.45, snow: 0, wet: 1, storm: 0, col: 0x8d98a6 },
  fog: { over: 0.3, fog: 0.5, rain: 0, snow: 0, wet: 0.25, storm: 0, col: 0xb5bec7 },
  snow: { over: 0.28, fog: 0.92, rain: 0, snow: 0.4, wet: 0, storm: 0, col: 0xbac5d2 },
  storm: { over: 0.5, fog: 0.85, rain: 0.6, snow: 0, wet: 1, storm: STORM_LOOK, col: 0x5d6673 },
};
// desert: the "storm" is a sand storm (golden haze, sand streaks blown sideways, no rain, no wet ground)
const SAND = { over: 0.4, fog: 0.8, rain: 0.5, snow: 0, wet: 0, storm: 0.2, col: 0xb78f58, sand: 1 };

const PART_VS = /* glsl */ `
uniform float uT, uK, uBox, uH, uLen; uniform vec3 uC; uniform vec2 uWind; uniform float uSpeed;
attribute vec4 aSeed; attribute float aEnd;
varying float vA;
void main() {
  float dens = min(1.0, uK * (1.7 * uBox * uBox / ${'COUNT'}.0));
  float live = step(aSeed.w, dens);
  vec2 g = aSeed.xy * uBox;
  vec2 p = mod(g - uC.xz + uBox * 0.5, uBox) - uBox * 0.5 + uC.xz;
  float fall = fract(aSeed.z + uT * uSpeed * (0.92 + aSeed.w * 0.2));
  float y = uH * (1.0 - fall);
  vec3 head = vec3(p.x + uWind.x * y * 0.06, y, p.y + uWind.y * y * 0.06);
  vec3 dir = normalize(vec3(uWind.x * 0.5, -1.0, uWind.y * 0.5));
  vec3 pos = head - dir * uLen * aEnd;
  float dc = length(p - uC.xz) / (uBox * 0.5);
  vA = live * (1.0 - smoothstep(0.55, 1.0, dc)) * mix(1.0, 0.35, aEnd) * smoothstep(0.0, 1.5, y);
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;
const PART_FS = /* glsl */ `uniform vec3 uCol; uniform float uAlpha; varying float vA; void main() { if (vA < 0.01) discard; gl_FragColor = vec4(uCol, vA * uAlpha); }`;

const SNOW_VS = /* glsl */ `
uniform float uT, uK, uBox, uH, uSize, uScale; uniform vec3 uC; uniform vec2 uWind;
attribute vec4 aSeed;
varying float vA;
void main() {
  float dens = min(1.0, uK * (0.9 * uBox * uBox / ${'COUNT'}.0));
  float live = step(aSeed.w, dens);
  vec2 g = aSeed.xy * uBox;
  float fall = fract(aSeed.z + uT * (0.055 + aSeed.w * 0.02));
  float y = uH * (1.0 - fall);
  vec2 p = mod(g - uC.xz + uBox * 0.5, uBox) - uBox * 0.5 + uC.xz;
  p += vec2(sin(uT * 0.8 + aSeed.x * 40.0), cos(uT * 0.65 + aSeed.y * 40.0)) * 0.8 + uWind * y * 0.04;
  vec4 mv = viewMatrix * vec4(p.x, y, p.y, 1.0);
  float dc = length(p - uC.xz) / (uBox * 0.5);
  vA = live * (1.0 - smoothstep(0.55, 1.0, dc)) * smoothstep(0.0, 1.5, y);
  gl_PointSize = uSize * uScale / max(1.0, -mv.z) * (0.7 + aSeed.w * 0.9);
  gl_Position = projectionMatrix * mv;
}`;
const SNOW_FS = /* glsl */ `varying float vA; void main() { float d = length(gl_PointCoord - 0.5); if (vA < 0.01 || d > 0.5) discard; gl_FragColor = vec4(1.0, 1.0, 1.0, vA * smoothstep(0.5, 0.2, d) * 0.7); }`;

// a small seeded generator for the particle seeds (fixed, so every run sees the same flakes)
function lcg(n) { let s = n >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

export class WorldFx {
  constructor({ scene, camera, post, init, heightAt, root = document.body, bc = false, theme = null }) {
    this.scene = scene; this.camera = camera; this.post = post; this.init = init; this.heightAt = heightAt;
    this.bc = bc;
    this.sand = init.mapType === 'desert';
    this.weather = weatherLooks(theme, init.mapType, LOOKS, SAND); // { looks, sand, stormSand }: LOOKS and SAND themselves without a theme
    this.kind = 0; this.nextKind = -1; this.endsIn = null; this.on = !!init.weatherOn;
    this.cur = { over: 0, fog: 1, rain: 0, snow: 0, wet: 0, storm: 0, col: new THREE.Color(0x8d98a6), wind: 0 };
    this.time = 0; this.strikes = 0; this.onStrike = null;
    this.bubbles = []; this.pending = [];
    this.fishInfo = new Map();
    this.buildParticles();
    this.buildFish(init.fish || []);
    this.chip = bc ? null : this.buildChip(root);
    this.wxSeed = init.seed | 0;
    this.ships = new Map(); this.shipSet = new Set(['fishing_boat', 'war_boat', 'transport']);
    this.wakeGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.wakeU = { uT: { value: 0 } };
  }

  // ---------------- particles ----------------
  buildParticles() {
    const RAIN_N = 9000, SNOW_N = 7000, rnd = lcg(0x51ed);
    const mkSeeds = (n) => { const a = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) a[i] = rnd(); return a; };
    // rain / sand streaks: line segments (2 vertices per drop)
    {
      const seeds = mkSeeds(RAIN_N), s2 = new Float32Array(RAIN_N * 8), end = new Float32Array(RAIN_N * 2), pos = new Float32Array(RAIN_N * 6);
      for (let i = 0; i < RAIN_N; i++) { for (let v = 0; v < 2; v++) { for (let k = 0; k < 4; k++) s2[(i * 2 + v) * 4 + k] = seeds[i * 4 + k]; end[i * 2 + v] = v; } }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(s2, 4));
      g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
      this.rainU = { uT: { value: 0 }, uK: { value: 0 }, uBox: { value: 60 }, uH: { value: 38 }, uLen: { value: 1.6 }, uC: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(0.3, 0.1) }, uSpeed: { value: 1.3 }, uCol: { value: new THREE.Color(0xcfd9e6) }, uAlpha: { value: 0.5 } };
      this.rain = new THREE.LineSegments(g, new THREE.ShaderMaterial({ uniforms: this.rainU, vertexShader: PART_VS.replace('COUNT', String(RAIN_N)), fragmentShader: PART_FS, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      this.rain.frustumCulled = false; this.rain.visible = false; this.rain.renderOrder = 9; this.rain.userData.noAO = true; this.rain.userData.noBloomOccluder = true;
      this.scene.add(this.rain);
    }
    {
      const seeds = mkSeeds(SNOW_N), pos = new Float32Array(SNOW_N * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
      this.snowU = { uT: { value: 0 }, uK: { value: 0 }, uBox: { value: 60 }, uH: { value: 34 }, uSize: { value: 0.5 }, uScale: { value: 900 }, uC: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(0.5, 0.2) } };
      this.snow = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: this.snowU, vertexShader: SNOW_VS.replace('COUNT', String(SNOW_N)), fragmentShader: SNOW_FS, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      this.snow.frustumCulled = false; this.snow.visible = false; this.snow.renderOrder = 9; this.snow.userData.noAO = true; this.snow.userData.noBloomOccluder = true;
      this.scene.add(this.snow);
    }
  }

  // ---------------- fish shoals (coast maps): rippling rings with a few fish circling in them ----------------
  buildFish(list) {
    this.fish = [];
    if (!list.length) return;
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mat = (u) => new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthWrite: false, fog: false, toneMapped: false,
      vertexShader: 'varying vec2 vU; void main(){ vU = uv - 0.5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uT, uSize, uSeed; varying vec2 vU;
        float fishShape(vec2 p, float ang){ float c = cos(ang), s = sin(ang); p = mat2(c, -s, s, c) * p; p.x *= 1.0; float body = length(p * vec2(1.0, 2.6)) ; float tail = length((p - vec2(-0.16, 0.0)) * vec2(2.6, 1.3)); return min(smoothstep(0.17, 0.12, body), 0.0) + (1.0 - smoothstep(0.1, 0.14, body)) + (1.0 - smoothstep(0.045, 0.07, tail)) * 0.7; }
        void main(){
          vec2 p = vU * 2.0; float r = length(p);
          float a = 0.0;
          float ring = fract(uT * 0.35 + uSeed);
          a += smoothstep(0.05, 0.0, abs(r - ring * 0.8)) * (1.0 - ring) * 0.22;
          
          float f = 0.0;
          for (int i = 0; i < 5; i++) {
            float k = float(i), ph = uT * (0.35 + 0.06 * k) + k * 1.37 + uSeed * 6.0, rad = (0.22 + 0.12 * mod(k, 3.0)) * uSize;
            vec2 q = p - vec2(cos(ph), sin(ph)) * rad;
            f += fishShape(q * 5.5, ph + 1.5708);
          }
          vec3 col = mix(vec3(0.82, 0.93, 1.0), vec3(0.16, 0.26, 0.34), clamp(f, 0.0, 1.0));
          a = max(a, clamp(f, 0.0, 1.0) * 0.75);
          a *= smoothstep(1.0, 0.8, r);
          if (a < 0.01) discard;
          gl_FragColor = vec4(col, a);
        }`,
    });
    for (const [id, tx, ty, amt] of list) {
      const u = { uT: { value: 0 }, uSize: { value: 1 }, uSeed: { value: ((id * 0.6180339) % 1) } };
      const m = new THREE.Mesh(geo, mat(u));
      m.position.set(tx + 0.5, WL + 0.03, ty + 0.5); m.scale.set(4, 1, 4); m.renderOrder = 3; m.userData.noAO = true;
      this.scene.add(m);
      this.fish.push({ id, m, u, max: amt, amt });
      this.fishInfo.set(id, this.fish[this.fish.length - 1]);
    }
  }

  // ---------------- weather chip (spectator only) ----------------
  buildChip(root) {
    const el = document.createElement('div');
    el.id = 'wxchip';
    const top = document.getElementById('top'); // in the column under the clock, above the victory strip (#vic): nothing covers it at any window size
    el.style.cssText = (top ? '' : 'position:fixed;top:156px;left:50%;transform:translateX(-50%);') + 'padding:5px 13px;border-radius:10px;font:600 12px ui-monospace,Menlo,monospace;color:#e6ebf2;background:rgba(10,14,20,.78);border:1px solid rgba(255,255,255,.1);pointer-events:none;display:none;white-space:nowrap;z-index:5;backdrop-filter:blur(6px)';
    if (top) top.insertBefore(el, document.getElementById('vic')); else root.appendChild(el);
    return el;
  }
  chipText() {
    const k = WEATHER_KINDS[this.kind], icon = { clear: 'SUN', rain: 'RAIN', fog: 'FOG', snow: 'SNOW', storm: this.weather.stormSand ? 'SAND STORM' : 'STORM' }[k];
    const eff = { clear: '', rain: 'food gathering -10%', fog: 'sight -25%', snow: 'land units -8%, food -5%', storm: 'gathering -15%, sight -10%' }[k];
    const next = this.nextKind >= 0 ? `   next: ${WEATHER_KINDS[this.nextKind]}` : '';
    const left = this.endsIn != null ? `   ${Math.max(0, this.endsIn)}s` : '';
    return `${icon}${eff ? '  ' + eff : ''}${left}${next}`;
  }

  // ---------------- snapshot -> state ----------------
  snap(s) {
    if (s.wx) {
      const k = s.wx[0];
      if (k !== this.kind) this.kind = k;
      this.endsIn = s.wx[1]; this.nextKind = s.wx[2];
      this.on = true;
    }
    if (s.say) for (const [p, text, seq] of s.say) this.pending.push({ p, text, seq });
    if (s.units && this.init.mapType === 'coast') {
      const seen = new Set();
      for (const u of s.units) {
        const nm = this.init.units && this.init.units[u[2]];
        if (!this.shipSet.has(nm)) continue;
        seen.add(u[0]);
        let sh = this.ships.get(u[0]);
        if (!sh) { sh = this.makeWake(nm); sh.id = u[0]; sh.x = u[3]; sh.z = u[4]; sh.hx = 0; sh.hz = 1; this.ships.set(u[0], sh); }
        sh.tx = u[3]; sh.tz = u[4];
      }
      for (const [id, sh] of this.ships) if (!seen.has(id)) { this.scene.remove(sh.m); sh.m.material.dispose(); if (sh.net) this.removeNet(sh.net); this.ships.delete(id); }
    }
    if (s.fa) for (const [id, amt] of s.fa) { const f = this.fishInfo.get(id); if (f) f.amt = amt; }
    if (this.chip && (this.on || this.init.weatherOn)) {
      this.chip.style.display = 'block';
      this.chip.textContent = this.chipText();
    }
  }

  // ---------------- ship wakes: a V of foam behind a moving ship, a soft ring when it rests ----------------
  makeWake(nm) {
    const u = { uT: this.wakeU.uT, uSpeed: { value: 0 }, uLen: { value: nm === 'war_boat' ? 1.2 : 1 } };
    const m = new THREE.Mesh(this.wakeGeo, new THREE.ShaderMaterial({ uniforms: u, transparent: true, depthWrite: false, fog: false, toneMapped: false,
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uT, uSpeed, uLen; varying vec2 vU;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          vec2 p = vec2(vU.x - 0.5, 1.0 - vU.y);            // x across, p.y 0 at the ship .. 1 far behind
          float arm = abs(abs(p.x) - (0.06 + p.y * 0.34 * uLen)); // the two arms of the V
          float a = smoothstep(0.045, 0.0, arm) * (1.0 - p.y) * smoothstep(0.0, 0.08, p.y) * uSpeed;
          a *= 0.55 + 0.45 * sin(p.y * 40.0 - uT * 5.0 + h(floor(p * 30.0)) * 3.0);
          float trail = smoothstep(0.1 + 0.12 * p.y, 0.0, abs(p.x)) * (1.0 - p.y) * 0.5 * uSpeed;
          float ring = smoothstep(0.05, 0.0, abs(length(vec2(p.x, p.y - 0.12)) - 0.16 - 0.03 * sin(uT * 1.6))) * (1.0 - uSpeed) * 0.35;
          float f = max(a * 0.8, max(trail, ring));
          if (f < 0.01) discard;
          gl_FragColor = vec4(0.93, 0.98, 1.0, f);
        }` }));
    m.renderOrder = 4; m.userData.noAO = true; m.frustumCulled = false;
    this.scene.add(m);
    return { m, u, x: 0, z: 0, tx: 0, tz: 0, hx: 0, hz: 1, v: 0, net: nm === 'fishing_boat' ? this.makeNet() : null };
  }
  // casting net of a fishing boat (a pure function of time + boat id, 9 s cycle): thrown over the side, opens in the air, floats and sags on the
  // water, is hauled back as a bag. Three cheap draws per net, all shaped in the vertex shader from the same few uniforms: the diamond-mesh net
  // (a polar grid that follows the sag curve), the floats on its rope rim (instanced low-poly beads) and the hand line to the boat (a ribbon).
  makeNet() {
    const G = this.netGeo || (this.netGeo = netGeos());
    const u = { uR: { value: 0.9 }, uH: { value: WL }, uDome: { value: 0 }, uFloor: { value: WL }, uT: { value: 0 }, uRot: { value: 0 }, uRip: { value: 1 }, uC: { value: new THREE.Vector2() },
      uOp: { value: 1 }, uWet: { value: 0 }, uCells: { value: 7 }, uFR: { value: 0.046 }, uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uSag: { value: 0.1 }, uW: { value: 0.05 } };
    const mk = (geo, vs, fs, order, extra = {}) => {
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: vs, fragmentShader: fs, transparent: true, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide, ...extra }));
      m.renderOrder = order; m.userData.noAO = true; m.frustumCulled = false; return m;
    };
    const grp = new THREE.Group(); grp.visible = false;
    const parts = [
      mk(G.disc, NET_COMMON + NET_VS, NET_FS, 5),
      mk(G.float, NET_COMMON + FLOAT_VS, FLOAT_FS, 6),
      mk(G.rope, ROPE_VS, ROPE_FS, 6),
    ];
    for (const m of parts) grp.add(m);
    this.scene.add(grp);
    return { grp, u, mats: parts.map((m) => m.material) };
  }
  removeNet(n) { this.scene.remove(n.grp); for (const m of n.mats) m.dispose(); }
  updateNet(sh, ang, time) {
    const n = sh.net; if (!n) return;
    const T = 9, ph = (((time + (sh.id | 0) * 2.37) % T) + T) % T / T;
    if (sh.v > 0.2 || ph > 0.92) { n.grp.visible = false; return; }
    const sx = Math.cos(ang), sz = -Math.sin(ang);               // starboard of the boat
    const hx = Math.sin(ang), hz = Math.cos(ang);
    const e = (x) => x * x * (3 - 2 * x), u = n.u;
    const FL = WL + 0.015, RIM = WL + 0.075;                      // lowest point of the net (water surface) / rim height when floating
    let off, R, h, dome, op = 1, wet = 0, rip = 1, sag = 0.12;
    if (ph < 0.14) {                                              // thrown out, opening in the air like an umbrella
      const k = ph / 0.14;
      off = 0.35 + 0.85 * e(k); R = 0.2 + 0.6 * e(k); h = RIM + 0.3 * (1 - k) + 0.5 * Math.sin(Math.PI * k); dome = 0.22 * Math.sin(Math.PI * k);
      op = 0.6 + 0.4 * k; rip = 0.3; sag = 0.16 * Math.sin(Math.PI * k) + 0.02;
    } else if (ph < 0.58) {                                       // floating: the rim rides on the floats, the middle sags into the water
      const k = (ph - 0.14) / 0.44;
      off = 1.2 + 0.04 * Math.sin(k * 6.28); R = 0.8 + 0.06 * e(Math.min(1, k * 3)) + 0.012 * Math.sin(k * 12.5);
      h = RIM; dome = -0.055 * e(Math.min(1, k * 4)); wet = e(Math.min(1, k * 3));
    } else {                                                      // hauled in: the rim is lifted and gathered, the net hangs as a bag
      const k = (ph - 0.58) / 0.34;
      off = 1.2 - 0.9 * e(k); R = 0.86 - 0.5 * e(k); h = RIM + 0.3 * e(k); dome = -0.055 - 0.2 * e(k);
      wet = 1 - 0.3 * k; op = 1 - 0.85 * k * k * k; rip = 0.5; sag = 0.05;
    }
    const cx = sh.x + sx * off - hx * 0.05, cz = sh.z + sz * off - hz * 0.05;
    u.uR.value = R; u.uH.value = h; u.uDome.value = dome; u.uFloor.value = FL; u.uT.value = time; u.uRot.value = ang + ph * 1.2; u.uRip.value = rip;
    u.uC.value.set(cx, cz); u.uOp.value = op; u.uWet.value = wet; u.uSag.value = sag;
    u.uA.value.set(sh.x + sx * 0.42 - hx * 0.15, WL + 0.4, sh.z + sz * 0.42 - hz * 0.15);   // the starboard rail
    u.uB.value.set(cx, Math.max(h + dome, FL), cz);                                           // the middle of the net
    n.grp.visible = true;
  }
  updateShips(dt, time) {
    this.wakeU.uT.value = time;
    for (const sh of this.ships.values()) {
      const px = sh.x, pz = sh.z, k = 1 - Math.exp(-dt / 0.12);
      sh.x += (sh.tx - sh.x) * k; sh.z += (sh.tz - sh.z) * k;
      const dx = sh.x - px, dz = sh.z - pz, sp = Math.hypot(dx, dz) / Math.max(dt, 1e-3);
      if (sp > 0.25) { const hk = 1 - Math.exp(-dt / 0.3); sh.hx += (dx / (sp * dt) - sh.hx) * hk; sh.hz += (dz / (sp * dt) - sh.hz) * hk; }
      sh.v += (Math.min(1, sp / 2.2) - sh.v) * (1 - Math.exp(-dt / 0.4));
      const ang = Math.atan2(sh.hx, sh.hz), len = 5.5, wid = 4.2;
      sh.m.position.set(sh.x - Math.sin(ang) * len * 0.46, WL + 0.04, sh.z - Math.cos(ang) * len * 0.46);
      sh.m.rotation.y = ang + Math.PI; sh.m.scale.set(wid, 1, len);
      sh.u.uSpeed.value = sh.v;
      sh.m.visible = true;
      this.updateNet(sh, ang, time);
    }
  }

  // ---------------- speech bubbles ----------------
  makeBubble(p, text) {
    const colour = this.init.players[p - 1]?.color || '#ffffff';
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    const font = '600 30px ui-sans-serif, -apple-system, "Segoe UI", sans-serif';
    ctx.font = font;
    const maxW = 520, words = text.split(/\s+/), lines = [];
    let ln = '';
    for (const w of words) { const t = ln ? ln + ' ' + w : w; if (ctx.measureText(t).width > maxW && ln) { lines.push(ln); ln = w; } else ln = t; }
    if (ln) lines.push(ln);
    const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 44, lh = 38, h = lines.length * lh + 34, tail = 22;
    c.width = w + 8; c.height = h + tail + 8;
    const g = c.getContext('2d');
    g.font = font; g.textBaseline = 'middle';
    const r = 20;
    g.beginPath();
    g.moveTo(4 + r, 4); g.lineTo(4 + w - r, 4); g.quadraticCurveTo(4 + w, 4, 4 + w, 4 + r); g.lineTo(4 + w, 4 + h - r); g.quadraticCurveTo(4 + w, 4 + h, 4 + w - r, 4 + h);
    g.lineTo(4 + w / 2 + 16, 4 + h); g.lineTo(4 + w / 2, 4 + h + tail); g.lineTo(4 + w / 2 - 16, 4 + h); g.lineTo(4 + r, 4 + h); g.quadraticCurveTo(4, 4 + h, 4, 4 + h - r); g.lineTo(4, 4 + r); g.quadraticCurveTo(4, 4, 4 + r, 4);
    g.closePath();
    g.fillStyle = 'rgba(250,251,253,0.97)'; g.fill();
    g.lineWidth = 7; g.strokeStyle = colour; g.stroke();
    g.fillStyle = '#10151d';
    lines.forEach((l, i) => g.fillText(l, 4 + 22, 4 + 17 + lh * (i + 0.5)));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    spr.userData.noAO = true; spr.renderOrder = 40;
    const k = 0.034; // world units per canvas pixel: readable from the overview camera
    spr.scale.set(c.width * k, c.height * k, 1);
    spr.center.set(0.5, 0);
    return spr;
  }
  addBubble(b) {
    const st = this.init.starts[b.p - 1];
    if (!st) return;
    const x = st.tx + 2, z = st.ty + 2;
    const spr = this.makeBubble(b.p, b.text);
    const mine = this.bubbles.filter((q) => q.p === b.p).length;
    const y = this.heightAt(x, z) + 7.5 + mine * 0 + 0.0;
    spr.position.set(x, y, z);
    this.scene.add(spr);
    // older bubbles of the same player move up
    for (const q of this.bubbles) if (q.p === b.p) q.lift += spr.scale.y * 0.9;
    this.bubbles.push({ p: b.p, spr, t0: this.time, base: y, lift: 0, x, z });
  }

  // a bubble near the frame edge slides along the edge instead of leaving the picture, and one wider than BUBBLE_MAX_W of the frame shrinks (narrow formats, small windows)
  keepOnScreen(spr) {
    spr.userData.ndc = null; // the box the bubble covers in NDC (labels on the map keep off it, see bubbleBoxes)
    const cam = this.camera, P = _bp.copy(spr.position).project(cam);
    if (Math.abs(P.z) > 1) { spr.center.set(0.5, 0); return; } // behind the camera or past the far plane
    _br.setFromMatrixColumn(cam.matrixWorld, 0); _bu.setFromMatrixColumn(cam.matrixWorld, 1);
    let dx = _bq.copy(spr.position).addScaledVector(_br, spr.scale.x).project(cam).x - P.x, dy = _bq.copy(spr.position).addScaledVector(_bu, spr.scale.y).project(cam).y - P.y;
    if (!(dx > 0 && dy > 0)) return;
    if (dx > 2 * BUBBLE_MAX_W) { const f = (2 * BUBBLE_MAX_W) / dx; spr.scale.x *= f; spr.scale.y *= f; dx *= f; dy *= f; }
    if (P.x + dx / 2 < -1 || P.x - dx / 2 > 1 || P.y + dy < -1 || P.y > 1) { spr.center.set(0.5, 0); return; } // wholly outside: stays outside (no bubbles of towns far off screen)
    // center (0.5, 0) puts the tail on the town centre; moving it shifts the bubble on screen (NDC: -1..1)
    const at = { px: P.x, py: P.y, dx, dy, margin: BUBBLE_MARGIN, top: this.bubbleTop(), bottom: this.bc ? BUBBLE_BOTTOM_BC : BUBBLE_MARGIN, side: this.overlaySides() };
    const k = bubbleFit(at); // wider than the free span beside the overlay: smaller, instead of leaving the picture
    if (k < 1) { spr.scale.x *= k; spr.scale.y *= k; at.dx *= k; at.dy *= k; }
    const c = bubbleCenter(at);
    spr.center.set(c.cx, c.cy);
    spr.userData.ndc = { x0: P.x - c.cx * at.dx, x1: P.x + (1 - c.cx) * at.dx, y0: P.y - c.cy * at.dy, y1: P.y + (1 - c.cy) * at.dy };
  }

  // the boxes of the visible bubbles in NDC (x0, x1 left to right, y0, y1 bottom to top): the labels of the broadcast keep off them
  bubbleBoxes() { return this.bubbles.filter((b) => b.spr.userData.ndc && b.spr.material.opacity > 0.3).map((b) => b.spr.userData.ndc); }

  // what lies over the picture in the broadcast, in NDC: 16:9 has a full column on each side (player panel, decision card, action feed), 4:5 the action feed top left
  // (its reserved height, not its current one: a bubble must not jump when a feed line comes or goes). Spectator page: nothing, it has its own bubbleTop.
  overlaySides() {
    if (!this.bc || typeof document === 'undefined') return null;
    const rect = (id) => document.getElementById(id)?.getBoundingClientRect();
    const view = rect('view'), a = rect('pn0'), b = rect('pn1'), f = rect('feed');
    if (!view?.height) return null;
    const X = (x) => -1 + (2 * (x - view.left)) / view.width, Y = (y) => 1 - (2 * (y - view.top)) / view.height;
    if (a?.width && b?.width && a.top < view.bottom) return { left: X(a.right + BUBBLE_GAP_PX), right: X(b.left - BUBBLE_GAP_PX), below: -Infinity };
    if (f?.width) return { left: X(f.right + BUBBLE_GAP_PX), right: 1 - BUBBLE_MARGIN, below: Y(f.top + FEED_RESERVE_PX) };
    return null;
  }

  // top margin for bubbles in NDC: in the spectator page the column under the clock (#top: speed bar, weather chip, shrine boxes) reaches far
  // down, so a bubble stays below it instead of sliding under it (read twice a second, it changes only when the chip or the strip appears)
  bubbleTop() {
    if (typeof document === 'undefined') return BUBBLE_TOP;
    if (this.bc) { // 16:9 keeps its cards in the side columns (overlaySides); 4:5 has the plan cards over the top of the picture. Their place counts also while they fade: a bubble must not jump
      const rect = (id) => document.getElementById(id)?.getBoundingClientRect(), view = rect('view'), a = rect('pn0');
      if (!view?.height || (a?.width && a.top < view.bottom)) return BUBBLE_TOP;
      return topBelowCards({ viewTop: view.top, viewHeight: view.height, bottoms: [rect('sc0')?.bottom, rect('sc1')?.bottom], base: BUBBLE_TOP });
    }
    if (this.topAt === undefined || this.time - this.topAt > 0.5 || this.time < this.topAt) {
      const el = document.getElementById('top'), h = window.innerHeight;
      this.topNdc = el && h ? Math.max(BUBBLE_TOP, (2 * (el.getBoundingClientRect().bottom + 8)) / h) : BUBBLE_TOP;
      this.topAt = this.time;
    }
    return this.topNdc;
  }

  // ---------------- per frame ----------------
  // time: animation clock in seconds, dt: seconds since the last frame, camS: smoothed camera {tx, tz, dist}
  update(time, dt, camS) {
    this.time = time; WATER_T.value = time;
    const kn = WEATHER_KINDS[this.kind] || 'clear';
    const W = this.weather, L = this.on ? (kn === 'storm' && W.stormSand ? W.sand : kn === 'rain' && this.sand ? W.looks.clear : W.looks[kn]) : W.looks.clear;
    const c = this.cur, k = 1 - Math.exp(-dt / STORM_RISE_S);
    for (const key of ['over', 'fog', 'rain', 'snow', 'wet', 'storm']) c[key] += (L[key] - c[key]) * k;
    c.col.lerp(_col.set(L.col), k);
    c.sand = L.sand ? Math.min(1, (c.sand || 0) + dt * 0.4) : Math.max(0, (c.sand || 0) - dt * 0.4);
    const flash = this.on && !L.sand ? flashOf(time, this.wxSeed, c.storm) : 0;
    if (newStrike(flash, this.lastFlash || 0) && this.onStrike) { this.strikes++; this.onStrike(closeStrike(this.strikes), this.strikes); } // a new strike: the app plays the thunder
    this.lastFlash = flash;
    this.post.setWeather({ over: c.over, overCol: c.col, storm: c.storm, flash, fogMul: c.fog });
    WET.value = c.wet;
    // particles around the camera target (anchored in the world: panning does not drag the rain along)
    const d = camS ? camS.dist : 120, box = clamp(d * 0.62, 30, 120);
    const cx = camS ? camS.tx : 0, cz = camS ? camS.tz : 0;
    const sandy = c.sand > 0.5;
    this.rain.visible = c.rain > 0.02;
    if (this.rain.visible) {
      const u = this.rainU;
      u.uT.value = time; u.uK.value = c.rain; u.uBox.value = box; u.uC.value.set(cx, 0, cz);
      u.uH.value = clamp(d * 0.28, 22, 48);
      u.uWind.value.set(sandy ? 9.0 : 0.35 + c.storm * 1.1, sandy ? 3.0 : 0.15 + c.storm * 0.4);
      u.uLen.value = sandy ? 3.2 : 1.1 + c.storm * 0.9;
      u.uSpeed.value = sandy ? 1.9 : 1.35 + c.storm * 0.4;
      u.uCol.value.set(sandy ? 0xe0bd7e : 0xd6e0ee); u.uAlpha.value = sandy ? 0.4 : 0.3;
    }
    this.snow.visible = c.snow > 0.02;
    if (this.snow.visible) {
      const u = this.snowU;
      u.uT.value = time; u.uK.value = c.snow; u.uBox.value = box; u.uC.value.set(cx, 0, cz); u.uH.value = clamp(d * 0.26, 20, 42);
      u.uScale.value = (window.innerHeight || 900) * 1.1 * Math.min(2, window.devicePixelRatio || 1);
    }
    // fish
    for (const f of this.fish) {
      const frac = f.max ? clamp(f.amt / f.max, 0, 1) : 1;
      f.m.visible = f.amt > 0;
      f.u.uT.value = time;
      f.u.uSize.value = 0.6 + 0.4 * frac;
      const s = 2.4 + 2.2 * Math.sqrt(frac);
      f.m.scale.set(s, 1, s);
    }
    this.updateShips(dt, time);
    // bubbles
    while (this.pending.length) this.addBubble(this.pending.shift());
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i], age = time - b.t0, life = 6.0;
      if (age < 0) b.t0 = time;
      if (age > life) { this.scene.remove(b.spr); b.spr.material.map.dispose(); b.spr.material.dispose(); this.bubbles.splice(i, 1); continue; }
      const pop = clamp(age / 0.28, 0, 1), fade = clamp((life - age) / 0.9, 0, 1);
      b.spr.material.opacity = Math.min(fade, pop);
      const sc = 0.82 + 0.18 * (1 - (1 - pop) * (1 - pop));
      b.spr.scale.x = b.spr.userData.sx ??= b.spr.scale.x; b.spr.scale.y = b.spr.userData.sy ??= b.spr.scale.y;
      b.spr.scale.set(b.spr.userData.sx * sc, b.spr.userData.sy * sc, 1);
      b.spr.position.y = b.base + b.lift + Math.sin(age * 2.2) * 0.12;
      this.keepOnScreen(b.spr);
    }
    if (this.chip && this.chip.style.display === 'block') this.chip.textContent = this.chipText();
  }
}
// ---- casting net shaders and geometry (see WorldFx.makeNet) ----
const NET_SECT = 56, NET_RINGS = 14, NET_FLOATS = 18;
const NET_COMMON = /* glsl */ `
uniform float uR, uH, uDome, uFloor, uT, uRot, uRip; uniform vec2 uC;
// a point d of the unit disc -> world: rotated by uRot, radius uR, height = rim height + dome (middle above the rim) or sag (below), little ripples
vec3 netAt(vec2 d) {
  float r = length(d), c = cos(uRot), s = sin(uRot), ang = atan(d.y, d.x + 1e-6);
  vec2 q = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  float y = uH + uDome * (1.0 - r * r) + uRip * r * (0.012 * sin(ang * 5.0 + uT * 2.3 + r * 4.0) + 0.007 * sin(ang * 11.0 - uT * 3.1));
  return vec3(uC.x + q.x * uR, max(y, uFloor), uC.y + q.y * uR);
}
`;
const NET_VS = /* glsl */ `
varying vec2 vD; varying float vH;
void main() { vD = position.xz; vec3 w = netAt(vD); vH = w.y; gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`;
const NET_FS = /* glsl */ `
uniform float uOp, uWet, uCells; varying vec2 vD; varying float vH;
void main() {
  float r = length(vD);
  if (r > 1.0) discard;
  vec2 q = vec2(vD.x + vD.y, vD.x - vD.y) * (0.7071 * uCells);      // diamond mesh: two families of twine at 45 degrees
  vec2 f = abs(fract(q + 0.5) - 0.5), w = fwidth(q);
  vec2 th = max(vec2(0.05), w * 0.7);                                 // twine half width, never thinner than about a pixel
  vec2 ln = 1.0 - smoothstep(th - w * 0.5, th + w * 0.5, f);
  float twine = max(ln.x, ln.y);
  float knot = 1.0 - smoothstep(th.x * 1.5, th.x * 2.6 + w.x, length(f));
  float rope = smoothstep(0.915, 0.935, r) * (1.0 - smoothstep(0.985, 1.0, r));   // thick twisted rope along the rim
  float tw = 0.5 + 0.5 * sin(atan(vD.y, vD.x + 1e-6) * 120.0 + r * 40.0);
  float wet = uWet * (1.0 - 0.55 * r);
  vec3 dry = vec3(0.68, 0.53, 0.32), soaked = vec3(0.28, 0.38, 0.36);
  vec3 col = mix(dry, soaked, wet) * (0.9 + 0.2 * clamp((vH - ${'WLV'}) * 2.0, 0.0, 1.0));
  vec3 rc = mix(vec3(0.46, 0.35, 0.2), vec3(0.78, 0.64, 0.4), tw);
  float fill = 0.1 + 0.08 * uWet;                                       // shadow of the net on the water: the meshed area reads as one thing
  float a = max(max(twine * 0.92, knot * 0.95), fill);
  vec3 c = mix(mix(vec3(0.05, 0.13, 0.17), col, step(0.0001, max(twine, knot))), rc, rope);
  a = max(a, rope);
  gl_FragColor = vec4(c, a * uOp);
}`.replace('WLV', String(WL.toFixed(3)));
const FLOAT_VS = /* glsl */ `
attribute float aAng, aTone; uniform float uFR; varying vec3 vN; varying float vTone;
void main() { vec3 c = netAt(vec2(cos(aAng), sin(aAng))); vN = normalize(position); vTone = aTone; gl_Position = projectionMatrix * viewMatrix * vec4(c + position * vec3(uFR, uFR * 0.85, uFR), 1.0); }`;
const FLOAT_FS = /* glsl */ `
uniform float uOp; varying vec3 vN; varying float vTone;
void main() {
  vec3 n = normalize(vN);
  float l = 0.5 + 0.5 * dot(n, normalize(vec3(-0.35, 0.85, 0.4)));
  vec3 base = mix(vec3(0.9, 0.28, 0.05), vec3(0.88, 0.82, 0.66), vTone);
  vec3 c = base * (0.5 + 0.6 * l) + vec3(0.3) * pow(max(0.0, dot(n, normalize(vec3(-0.3, 0.9, 0.3)))), 24.0);
  gl_FragColor = vec4(c, uOp);
}`;
const ROPE_VS = /* glsl */ `
uniform vec3 uA, uB; uniform float uSag, uW, uFloor; varying vec2 vU;
void main() {
  vU = uv; float t = uv.x;
  vec3 p = mix(uA, uB, t); p.y -= uSag * 4.0 * t * (1.0 - t); p.y = max(p.y, uFloor + 0.012);
  vec2 d = uB.xz - uA.xz; vec2 sd = vec2(-d.y, d.x) / max(length(d), 1e-4);
  p.xz += sd * (uv.y - 0.5) * uW;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const ROPE_FS = /* glsl */ `
uniform float uOp; varying vec2 vU;
void main() {
  float tw = 0.5 + 0.5 * sin(vU.x * 190.0 + (vU.y - 0.5) * 9.0);
  float a = 1.0 - smoothstep(0.34, 0.5, abs(vU.y - 0.5));
  gl_FragColor = vec4(mix(vec3(0.42, 0.32, 0.18), vec3(0.78, 0.64, 0.4), tw), a * uOp);
}`;
// the shared geometries of all nets: the polar disc (position.xz = point of the unit disc), the float beads (instanced), the line ribbon
function netGeos() {
  const pos = [], idx = [];
  for (let j = 0; j <= NET_RINGS; j++) for (let i = 0; i <= NET_SECT; i++) { const r = j / NET_RINGS, a = i / NET_SECT * Math.PI * 2; pos.push(Math.cos(a) * r, 0, Math.sin(a) * r); }
  for (let j = 0; j < NET_RINGS; j++) for (let i = 0; i < NET_SECT; i++) { const a = j * (NET_SECT + 1) + i, b = a + 1, c = a + NET_SECT + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const disc = new THREE.BufferGeometry(); disc.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); disc.setIndex(idx);
  const float = new THREE.InstancedBufferGeometry();
  float.setAttribute('position', new THREE.IcosahedronGeometry(1, 1).attributes.position);
  float.setAttribute('aAng', new THREE.InstancedBufferAttribute(new Float32Array(NET_FLOATS).map((_, i) => i / NET_FLOATS * Math.PI * 2), 1));
  float.setAttribute('aTone', new THREE.InstancedBufferAttribute(new Float32Array(NET_FLOATS).map((_, i) => (i % 3 === 0 ? 1 : 0)), 1));
  float.instanceCount = NET_FLOATS;
  return { disc, float, rope: new THREE.PlaneGeometry(1, 1, 18, 1) };
}
const _col = new THREE.Color();
const _bp = new THREE.Vector3(), _bq = new THREE.Vector3(), _br = new THREE.Vector3(), _bu = new THREE.Vector3();
const BUBBLE_GAP_PX = 10, FEED_RESERVE_PX = 180, BUBBLE_BOTTOM_BC = 0.3; // broadcast: distance to the overlays, height of the action feed, room for the captions at the bottom
const BUBBLE_MAX_W = 0.46, BUBBLE_MARGIN = 0.03, BUBBLE_TOP = 0.22; // share of the frame width; margins in NDC (the top one keeps clear of the clock and the build banner)
