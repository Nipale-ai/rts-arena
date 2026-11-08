// Animation: instanced unit rigs (vertex shader parts), building/tree/water shader motion, and the per-unit pose logic.
// Everything is driven by the time that app.mjs passes in (sim/output time), never by Math.random or performance.now,
// so the broadcast renderer produces identical frames on every run.
import * as THREE from './vendor/three.module.js';
import { GAITS, GALLOP, TICK_HZ, BLEND_S, newState, pickGait, advance, beatsIn } from './gait.mjs';

export const U = { uTime: { value: 0 } }; // shared time uniform (seconds)
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// wrap an existing onBeforeCompile (the terrain agent patches its own materials) instead of replacing it
function patchMaterial(mat, key, fn) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { if (prev) prev(sh, r); sh.uniforms.uTime = U.uTime; fn(sh); };
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
  mat.customProgramCacheKey = () => prevKey() + '|' + key;
  mat.needsUpdate = true;
  return mat;
}

// ---------------------------------------------------------------- units: GLSL rig
// per-instance attribute iAnim = (walk phase [rad], walk amplitude [rad], action code, action phase 0..1); see models.mjs for parts
const UNIT_GLSL = /* glsl */`
attribute float aPart;
attribute vec3 aPivot;
attribute vec4 iAnim;
uniform float uTime;
mat3 aR; mat3 aR2; vec3 aS; vec3 aSh; float aSc; float aNest;
mat3 rotXm(float a){ float c = cos(a), s = sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 rotYm(float a){ float c = cos(a), s = sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
// attack pose curve k: +1 at the hit (cooldown restart), decays to 0, rests, winds up to -1, snaps to +1
float kcur(float ap){
  if (ap < 0.25) { float t = 1.0 - ap / 0.25; return t * t; }
  if (ap < 0.62) return 0.0;
  if (ap < 0.9) { float t = (ap - 0.62) / 0.28; return -t * t * (3.0 - 2.0 * t); }
  float t = (ap - 0.9) / 0.1; return -1.0 + 2.0 * t * t;
}
float bowUp(float ap){ if (ap >= 0.7 || ap < 0.2) return 1.0; if (ap < 0.45) return 1.0 - smoothstep(0.2, 0.45, ap); return smoothstep(0.45, 0.7, ap); }
float bowDraw(float ap){ return ap < 0.7 ? 0.0 : smoothstep(0.7, 0.98, ap); }
float armRx(int act, float ap, float sw, float amp, float idle, float kh, float kw){
  float r = sw * amp * 0.45 + idle;
  if (act == 1) r = -0.9 * kh + 0.3 * kw;
  else if (act == 2 || act == 4 || act == 8 || act == 9) r = -1.3 * kh + 1.1 * kw;
  else if (act == 13) r = -1.0;
  else if (act == 3) r = -1.35 * bowUp(ap);
  else if (act == 10) r = -0.6 - 0.45 * sin(ap * 6.2832);
  else if (act == 11) r = -0.7 + 0.5 * sin(ap * 12.566);
  return r;
}
void animCompute(){
  aR = mat3(1.0); aR2 = mat3(1.0); aS = vec3(0.0); aSh = vec3(0.0); aSc = 1.0; aNest = 0.0;
  int part = int(aPart + 0.5);
  if (part == 0) return;
  float ph = iAnim.x, amp = iAnim.y; int act = int(iAnim.z + 0.5); float ap = iAnim.w;
  float seed = float(gl_InstanceID) * 1.618;
  float sw = sin(ph);
  float k = kcur(ap), kw = max(-k, 0.0), kh = max(k, 0.0);
  float idle = sin(uTime * 1.4 + seed) * 0.035 * (1.0 - min(amp * 2.0, 1.0));
  float rx = 0.0, ry = 0.0; vec3 sl = vec3(0.0);
  float am = clamp(amp, 0.0, 1.0);
  if (part == 1) rx = sw * amp;
  else if (part == 2) rx = -sw * amp;
  else if (part == 16) rx = sin(ph + 0.9) * amp;
  else if (part == 11) rx = sin(ph + 3.64) * amp;
  else if (part == 12) rx = sin(ph + 4.54) * amp;
  else if (part == 3) rx = armRx(act, ap, sw, amp, idle, kh, kw);
  else if (part == 4) {
    rx = -sw * amp * 0.45 - idle;
    if (act == 3) rx = -1.1 * bowUp(ap) + 0.8 * bowDraw(ap) * bowUp(ap);
    else if (act == 1 || act == 2) rx = -0.35 * kh;
    else if (act == 8 || act == 9 || act == 10 || act == 11) rx = -0.4;
  }
  else if (part == 15 || part == 5) {
    // the bow keeps its orientation but follows the raised right hand (shoulder at (0.2, 0.52, 0), bow centre (0.22, 0.32, 0.12))
    float ra = (act == 3) ? -1.35 * bowUp(ap) : sw * amp * 0.45 + idle;
    vec3 C = vec3(0.22, 0.32, 0.12), S = vec3(0.2, 0.52, 0.0);
    aS = rotXm(ra) * (C - S) - (C - S);
    if (part == 5) { aS.z -= 0.2 * bowDraw(ap); if (act != 3 || ap < 0.55) aSc = 0.0; }
  }
  else if (part == 18 || part == 13) {
    float ra = armRx(act, ap, sw, amp, idle, kh, kw);
    rx = sw * amp * 0.12;
    if (act == 1) { rx = 1.25 * kh - 0.4 * kw; sl.z = 0.5 * kh - 0.15 * kw; }
    else if (act == 2) rx = 2.2 * kh - 0.9 * kw;
    else if (act == 4) rx = 1.8 * kh - 0.8 * kw;
    else if (act == 8) rx = 2.4 * kh - 1.0 * kw;
    else if (act == 9) rx = 2.1 * kh - 0.8 * kw;
    else if (act == 10) rx = 0.9 + 0.8 * sin(ap * 6.2832);
    else if (act == 11) rx = 1.2 + 0.7 * sin(ap * 12.566);
    else if (act == 13) rx = 1.0 + 0.5 * sin(ap * 40.0);
    if (act == 5) { sl.z = 0.6 * kh - 0.25 * kw; rx = 0.0; }
    else { aNest = 1.0; aR2 = rotXm(ra); aSh = vec3(0.2, aPivot.y + 0.27, 0.0); }
    if (part == 13 && act == 4 && ap < 0.6) aSc = 0.0; // javelin has left the hand
    aR = rotXm(rx); aS = sl; return;
  }
  else if (part == 6) rx = 0.1 + sin(ph) * 0.12 * am + sin(uTime * 0.7 + seed) * 0.05 * (1.0 - am);
  else if (part == 9) { ry = sin(uTime * 2.0 + seed) * 0.35 * (1.0 - am); rx = 0.5 * am; }
  else if (part == 7 || part == 14) {
    if (act == 7) rx = 1.05 * kw - 0.55 * kh;
    if (part == 14 && act == 7 && ap < 0.62) aSc = 0.0; // the stone has been thrown
  }
  else if (part == 8) { if (act == 6) sl.z = -0.6 * kw + 0.55 * kh; }
  else if (part == 20) { if (act == 12) { sl.z = -0.16 * kh; sl.y = -0.09 * kh; } }   // mortar tube kicks back at the shot
  else if (part == 19) { aSc = (act == 13) ? 0.7 + 0.5 * sin(uTime * 38.0 + seed) : 0.0; }   // sapper fuse spark: only while burning
  else if (part == 17) rx = ph;
  aR = rotYm(ry) * rotXm(rx); aS += sl;
}
vec3 animPos(vec3 p){
  vec3 q = aPivot + aR * ((p - aPivot) * aSc) + aS;
  if (aNest > 0.5) q = aSh + aR2 * (q - aSh);
  return q;
}
vec3 animNrm(vec3 n){ n = aR * n; if (aNest > 0.5) n = aR2 * n; return n; }
`;

// Patched clone of a unit material (body or team). The shadow pass gets the same rig through customDepthMaterial.
export function unitMaterial(base) {
  const m = base.clone();
  patchMaterial(m, 'unitrig', (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + UNIT_GLSL)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nanimCompute();\nobjectNormal = animNrm(objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = animPos(transformed);');
  });
  return m;
}
export function unitDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchMaterial(m, 'unitrigdepth', (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + UNIT_GLSL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nanimCompute();\ntransformed = animPos(transformed);');
  });
  return m;
}

// ---------------------------------------------------------------- buildings: sails, flags, forge glow
const BUILD_GLSL = /* glsl */`
attribute float aPart;
attribute vec3 aPivot;
uniform float uTime;
varying float vGlow;
`;
export function buildingMaterial(base) {
  const m = base.clone();
  patchMaterial(m, 'bldanim', (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + BUILD_GLSL)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
vGlow = 0.0;
float bph = modelMatrix[3].x * 0.37 + modelMatrix[3].z * 0.23;
float bFlagSlope = 0.0;
if (aPart > 20.5 && aPart < 21.5) {
  float fx = max(position.x - aPivot.x, 0.0);
  float arg = fx * 7.0 - uTime * 4.0 + bph;
  bFlagSlope = cos(arg) * 7.0 * fx * 0.12 + sin(arg) * 0.12;
  if (abs(objectNormal.z) > 0.5) objectNormal = normalize(vec3(-bFlagSlope * sign(objectNormal.z), 0.0, objectNormal.z));
}
if (aPart > 19.5 && aPart < 20.5) objectNormal = vec3(rotZb(uTime * 0.5 + bph) * objectNormal);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
if (aPart > 21.5) vGlow = 0.65 + 0.35 * sin(uTime * 9.0 + bph) * sin(uTime * 5.3 + 1.7);
if (aPart > 19.5 && aPart < 20.5) transformed = aPivot + rotZb(uTime * 0.5 + bph) * (transformed - aPivot);
if (aPart > 20.5 && aPart < 21.5) {
  float fx2 = max(position.x - aPivot.x, 0.0);
  float arg2 = fx2 * 7.0 - uTime * 4.0 + bph;
  transformed.z += sin(arg2) * fx2 * 0.12;
  transformed.y += sin(arg2 * 0.8 + 1.0) * fx2 * 0.02;
}`);
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'mat3 rotZb(float a){ float c = cos(a), s = sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }\nvoid main() {');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.42, 0.08) * vGlow * 0.9;');
  });
  return m;
}

// ---------------------------------------------------------------- 3D pack buildings: baked flags wave, forge embers glow
// Clone of a model material with the vertex attributes written by tools/lib/team-split.mjs: `_flag` (0 at the pole / hem fixed, 1 at the
// free end; the cloth moves along the plane normal axis `flag` = 'x' | 'z') and `_glow` (embers: emissive pulse, modulated by the texture).
const modelMats = new Map();
// the cloth wave, shared by the visible material and the shadow depth material (the shadow follows the wave)
function flagWaveGLSL(flag) {
  if (!flag) return '';
  const ax = flag === 'x' ? 'vec3(1.0, 0.0, 0.0)' : 'vec3(0.0, 0.0, 1.0)';
  return `{
  float fph = modelMatrix[3].x * 0.37 + modelMatrix[3].z * 0.23;
  float farg = (position.x + position.z) * 6.0 + position.y * 2.5 - uTime * 3.6 + fph;
  float fw = _flag * _flag * 0.6 + _flag * 0.4;
  transformed += ${ax} * (sin(farg) * 0.06 + sin(farg * 1.9 + 1.3) * 0.02) * fw;
  transformed.y -= fw * (0.5 + 0.5 * sin(farg * 0.7)) * 0.03;
}`;
}
export function modelMaterial(base, { flag = null, glow = false } = {}) {
  const m = base.clone();
  patchMaterial(m, 'model' + (flag || '') + (glow ? 'g' : ''), (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
${flag ? 'attribute float _flag;' : ''}
${glow ? 'attribute float _glow; varying float vGlowW;' : ''}
uniform float uTime;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${glow ? 'vGlowW = _glow;' : ''}
${flagWaveGLSL(flag)}`);
    if (glow) sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlowW;\nuniform float uTime;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{ float pulse = 0.75 + 0.25 * sin(uTime * 9.0 + 1.0) * sin(uTime * 5.3 + 1.7) + 0.1 * sin(uTime * 21.0);
  totalEmissiveRadiance += diffuseColor.rgb * vec3(2.4, 1.0, 0.35) * vGlowW * pulse; }`);
  });
  return m;
}
// cached by (base material, options): parts of one model share the material
export function modelMaterialCached(base, opts) {
  const k = base.uuid + '|' + (opts.flag || '') + (opts.glow ? 'g' : '');
  let m = modelMats.get(k);
  if (!m) modelMats.set(k, m = modelMaterial(base, opts));
  return m;
}

// the shadow pass of a waving flag: the same displacement on the depth material (shared uTime)
const modelDepths = new Map();
export function modelDepthMaterialCached(flag) {
  let m = modelDepths.get(flag);
  if (!m) {
    modelDepths.set(flag, m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
    patchMaterial(m, 'modeldepth' + flag, (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float _flag;\nuniform float uTime;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + flagWaveGLSL(flag));
    });
  }
  return m;
}

// ---------------------------------------------------------------- trees / grass sway (instanced, phase from the world position)
export function swayMaterial(base, strength = 1, clone = false) {
  const m = clone ? base.clone() : base;
  patchMaterial(m, 'sway' + strength, (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
  vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  #else
  vec2 ip = vec2(0.0);
  #endif
  float wh = position.y;
  float sw = ${(0.032 * strength).toFixed(4)} * wh * wh;
  float gust = 0.6 + 0.4 * sin(uTime * 0.35 + ip.x * 0.05 + ip.y * 0.03);
  transformed.x += (sin(uTime * 1.25 + ip.x * 0.6 + ip.y * 0.4) * gust + sin(uTime * 2.9 + ip.y * 1.3) * 0.18) * sw;
  transformed.z += (cos(uTime * 1.05 + ip.y * 0.55 + ip.x * 0.2) * gust + sin(uTime * 3.3 + ip.x * 1.1) * 0.18) * sw * 0.7;
}`);
  });
  return m;
}

// ---------------------------------------------------------------- water: vertex waves, glints, lapping foam on the existing terrain water
export function animateWater(mesh) {
  const m = mesh.material;
  if (!m) return;
  patchMaterial(m, 'waterwave', (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
varying float vDepth;
vec3 waveH(vec2 p, float t){
  float a1 = p.x * 1.15 + p.y * 0.35 + t * 0.85, a2 = p.y * 1.35 - p.x * 0.55 - t * 1.05, a3 = (p.x + p.y) * 0.62 + t * 0.55;
  float h = sin(a1) * 0.5 + sin(a2) * 0.35 + sin(a3) * 0.5;
  float dx = cos(a1) * 1.15 * 0.5 - cos(a2) * 0.55 * 0.35 + cos(a3) * 0.62 * 0.5;
  float dz = cos(a1) * 0.35 * 0.5 + cos(a2) * 1.35 * 0.35 + cos(a3) * 0.62 * 0.5;
  return vec3(h, dx, dz);
}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
float wAmp = 0.032 * smoothstep(0.3, 0.8, color.a);
vec3 wv = waveH(position.xz, uTime);
objectNormal = normalize(vec3(-wv.y * wAmp, 1.0, -wv.z * wAmp));
vDepth = color.a;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += wv.x * wAmp;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vDepth;')
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // lapping foam where the water is shallow (vDepth ~ 0.25 at the shoreline, rising with depth)
  float dep = clamp((vDepth - 0.25) / 1.8, -0.2, 1.0);
  float lap = 0.05 + 0.045 * sin(uTime * 1.3 + vWP.x * 0.9 + vWP.z * 0.7);
  float lace = 0.5 + 0.5 * sin(vWP.x * 9.0 + uTime * 0.9) * sin(vWP.z * 8.0 - uTime * 0.7);
  float band = smoothstep(lap + 0.035, lap - 0.01, dep) * (0.35 + 0.65 * lace);
  float line = smoothstep(0.03, 0.0, dep) * 0.8;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.98, 1.0), clamp(band * 0.55 + line, 0.0, 0.9));
  float gl = sin(vWP.x * 3.1 + uTime * 1.3) * sin(vWP.z * 2.7 - uTime * 1.1) * sin((vWP.x - vWP.z) * 1.7 + uTime * 0.7);
  diffuseColor.rgb += vec3(0.5, 0.65, 0.75) * smoothstep(0.55, 0.9, gl) * 0.22 * smoothstep(0.2, 0.5, dep);
}`);
  });
}

// ---------------------------------------------------------------- unit pose logic (CPU side, per frame)
export const UNIT_SCALE = 1.5;
const CLS = {
  worker: { amp: 0.75, stride: 1.05, turn: 12, bob: 0.06, roll: 0.06, lean: 0.05, dust: 1.0, dsz: 0.14 },
  infantry: { amp: 0.8, stride: 1.05, turn: 11, bob: 0.06, roll: 0.06, lean: 0.06, dust: 1.0, dsz: 0.16 },
  ranged: { amp: 0.8, stride: 1.05, turn: 11, bob: 0.06, roll: 0.06, lean: 0.06, dust: 1.0, dsz: 0.15 },
  cavalry: { amp: 0.95, stride: 1.9, turn: 7, bob: 0.12, roll: 0.03, lean: 0.06, dust: 0.8, dsz: 0.3 },
  trader: { amp: 0.3, stride: 1.89, turn: 5, bob: 0.014, roll: 0.02, lean: 0.01, dust: 1.5, dsz: 0.24 }, // the caravan: one static mesh (no bones, no clips), so no legs to drive. Stride = one turn of the wagon wheel (2 pi * 0.2 * UNIT_SCALE), a small sway instead of the bounce of a foot soldier
  beast: { amp: 0.95, stride: 1.5, turn: 9, bob: 0.08, roll: 0.03, lean: 0.05, dust: 0.9, dsz: 0.2 },
  siege: { amp: 0, stride: 1.8, turn: 3.2, bob: 0.012, roll: 0.01, lean: 0.0, dust: 0.9, dsz: 0.38 },
  support: { amp: 0.7, stride: 1.0, turn: 10, bob: 0.05, roll: 0.05, lean: 0.04, dust: 1.0, dsz: 0.14 },
  sapper: { amp: 0.85, stride: 1.05, turn: 11, bob: 0.07, roll: 0.07, lean: 0.12, dust: 0.9, dsz: 0.16 }, // a human on foot although it is a siege unit
};
const ACT = { spearman: 1, swordsman: 2, archer: 3, skirmisher: 4, light_cavalry: 5, heavy_cavalry: 5, ram: 6, catapult: 7, mortar: 12, sapper: 13 };
export function actOf(name, def) {
  if (ACT[name] !== undefined) return ACT[name];
  return def.cls === 'ranged' ? 3 : def.cls === 'cavalry' || def.cls === 'beast' ? 5 : def.cls === 'siege' ? (def.range > 3 ? 7 : 6) : 2;
}
export function kcur(ap) {
  if (ap < 0.25) { const t = 1 - ap / 0.25; return t * t; }
  if (ap < 0.62) return 0;
  if (ap < 0.9) return -smooth((ap - 0.62) / 0.28);
  const t = (ap - 0.9) / 0.1;
  return -1 + 2 * t * t;
}
export const WORK = { 8: 1.25, 9: 1.35, 10: 2.4, 11: 1.1 }; // seconds per cycle: chop, mine, farm/forage, build
export const WORK_ACTS = new Set([8, 9, 10, 11]); // a worker in one of these poses has both hands on the tool: the carried goods are stowed

// ---- pure pose and timing functions of the rigged units (render/units3d.mjs plays baked clips; tools/rig bakes every clip with a long dead hold in it) ----
// Everything here is a function of a cycle phase (0..1) or of an age in seconds, no clock and no random numbers: broadcast renders stay frame-exact.
const frac = (v) => v - Math.floor(v);
const easeOut = (t) => 1 - (1 - clamp(t, 0, 1)) * (1 - clamp(t, 0, 1));

// small deterministic random numbers for effects: hash of up to three integers -> [0, 1), and a sequence generator seeded by two integers
export function hash01(a, b = 0, c = 0) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0; h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function seq(a, b = 0) {
  let s = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ 0x1b873593) >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Melee clips (slash, thrust, rider attack; 40 frames): frame 0 is the hit, 0..10 the recovery, 11..25 a static ready pose, 26..36 the wind-up, 37..39 the strike.
// `ap` = cooldown phase (0 = the hit just happened). The ready pose is shortened and the wind-up gets half of the cooldown, so the viewer sees it coming.
export const ATTACK_FRAMES = 40;
export function attackFrame(ap) {
  ap = clamp(ap, 0, 1);
  if (ap < 0.14) return 10 * easeOut(ap / 0.14);
  if (ap < 0.30) return 10 + 16 * ((ap - 0.14) / 0.16);
  if (ap < 0.80) return 26 + 10 * smooth((ap - 0.30) / 0.5);
  if (ap < 0.86) return 36;
  return 36 + 4 * ((ap - 0.86) / 0.14);
}
// strike curve of the same cycle: +1 at the hit, 0 while ready, down to -1 at the top of the wind-up, a short pause there, then a fast snap up to +1
export function strikeK(ap) {
  ap = clamp(ap, 0, 1);
  if (ap < 0.14) { const t = 1 - ap / 0.14; return t * t; }
  if (ap < 0.30) return 0;
  if (ap < 0.80) return -smooth((ap - 0.30) / 0.5);
  if (ap < 0.86) return -1;
  const t = (ap - 0.86) / 0.14;
  return -1 + 2 * t * t;
}

// Work clips: chop and mine (32 frames: 0..8 recoil, 9..20 static, 21..29 wind-up, 29..32 strike), build (24 frames: 0..6 recoil, 7..15 static, 16..22 wind-up, 22..24 strike).
// One work cycle u = 0..1 (WORK seconds): ready, slow wind-up, a pause at the top, the strike, a short hit-stop on the impact, the tool comes back.
export const WORK_SHAPE = { 8: { n: 32, ready: 8, a0: 21, top: 29 }, 9: { n: 32, ready: 8, a0: 21, top: 29 }, 11: { n: 24, ready: 6, a0: 16, top: 22 } };
export const WORK_T = { windStart: 0.1, windEnd: 0.56, pauseEnd: 0.62, strikeEnd: 0.7, stopEnd: 0.74, recoilEnd: 0.9 };
export const WORK_IMPACT = { 8: WORK_T.strikeEnd, 9: WORK_T.strikeEnd, 10: 28 / 32, 11: WORK_T.strikeEnd }; // cycle phase of the hit (farm: the lowest point of the bend)
// clip frame (0..n; n = frame 0 again) of the work cycle; the farm clip is a smooth loop and plays as it is
export function workFrame(code, u) {
  const S = WORK_SHAPE[code];
  u = frac(u);
  if (!S) return u * 32;
  const T = WORK_T;
  if (u < T.windStart) return S.ready;
  if (u < T.windEnd) return S.a0 + (S.top - S.a0) * smooth((u - T.windStart) / (T.windEnd - T.windStart));
  if (u < T.pauseEnd) return S.top;
  if (u < T.strikeEnd) { const t = (u - T.pauseEnd) / (T.strikeEnd - T.pauseEnd); return S.top + (S.n - S.top) * t; }
  if (u < T.stopEnd) return S.n;
  if (u < T.recoilEnd) return S.ready * easeOut((u - T.stopEnd) / (T.recoilEnd - T.stopEnd));
  return S.ready;
}
// strike curve of the work cycle (same convention as strikeK): -1 at the top of the wind-up, +1 at the impact
export function workK(code, u) {
  u = frac(u);
  const T = WORK_T;
  if (!WORK_SHAPE[code]) return 0;
  if (u < T.windStart) return 0;
  if (u < T.windEnd) return -smooth((u - T.windStart) / (T.windEnd - T.windStart));
  if (u < T.pauseEnd) return -1;
  if (u < T.strikeEnd) { const t = (u - T.pauseEnd) / (T.strikeEnd - T.pauseEnd); return -1 + 2 * t * t; }
  if (u < T.stopEnd) return 1;
  if (u < T.recoilEnd) return 1 - smooth((u - T.stopEnd) / (T.recoilEnd - T.stopEnd));
  return 0;
}
// body of a working villager from the cycle phase: lean (rad, forward), lunge (tiles), y (tiles); the clip phase `ct` is frame / n
const WORK_BODY = { 8: [0.34, 0.14, 0.16, 0.06], 9: [0.3, 0.12, 0.12, 0.05], 11: [0.22, 0.08, 0.08, 0.02] }; // lean forward, lean back, lunge forward, lunge back
export function workPose(code, u, out, pick) {
  const S = WORK_SHAPE[code];
  u = frac(u);
  if (!S && pick) { // forage at a bush: the baked `gather` clip bends the whole body itself (pelvis, knees, back), so the body only steps up to the bush a little
    out.ct = u; out.k = 0; out.lean = 0.03; out.lunge = 0.07; out.y = 0;
    return out;
  }
  if (!S) { // farm / forage: bend down to the plant and straighten up again, the hands follow the baked clip
    const b = 0.5 + 0.5 * Math.cos(TAU * (u - WORK_IMPACT[10])); // 1 at the bottom of the bend
    out.ct = u; out.k = 0; out.lean = 0.22 + 0.5 * b; out.lunge = 0.1 * b; out.y = -0.05 * b;
    return out;
  }
  const k = workK(code, u), kh = Math.max(k, 0), kw = Math.max(-k, 0), B = WORK_BODY[code];
  out.ct = workFrame(code, u) / S.n; out.k = k;
  out.lean = B[0] * kh - B[1] * kw; out.lunge = B[2] * kh - B[3] * kw; out.y = 0.045 * kw - 0.02 * kh;
  return out;
}
// the moment of the hit inside a cycle counter: returns the cycle index while the phase is in the short window after the hit, else -1
export function impactWindow(code, u, w) { const d = frac(u) - WORK_IMPACT[code]; return d >= 0 && d < 0.12 ? Math.floor(w) : -1; }

// hit flinch: a short recoil after a unit lost hit points. age in seconds since the hit; returns 0..1 (0 = no flinch)
export const FLINCH_S = 0.32;
export function flinchK(age) {
  if (!(age >= 0) || age >= FLINCH_S) return 0;
  const a = age < 0.04 ? 0.5 + 0.5 * (age / 0.04) : Math.exp(-(age - 0.04) / 0.1); // the kick starts at once (half strength in the frame of the hit)
  return a * (1 - smooth((age - 0.2) / (FLINCH_S - 0.2)));
}
export const FLASH_S = 0.1;
export const flashK = (age) => (age >= 0 && age < FLASH_S ? 1 - age / FLASH_S : 0); // white-hot flash of the body right after the hit (youth-safe: no red)

// What app.mjs hands to stepUnit about one unit (everything but the callbacks); a function of its own so that a test goes through the same lines as the renderer.
// X.rigged = drawn by the baked clips (work, melee, flinch motion of this file); X.rig = on-screen scale of a rigged rider for the gait (0 for every other unit). The two must not be mixed up.
export function bindUnit(X, name, def, x, z, dtTicks, tgt, rigged, riderScale) {
  X.def = def; X.name = name; X.x = x; X.z = z; X.dtTicks = dtTicks; X.tgt = tgt;
  X.rigged = !!rigged;
  X.rig = rigged && GAITS[name] ? riderScale() : 0;
  return X;
}

// st: persistent per-unit state; c/p: current/previous snapshot tuple; a: interpolation 0..1; X: context from app.mjs
// returns `out` (reused): y, lean, roll, lunge (forward, tiles), sy, ang, ph, amp, act, ap, ct (clip phase of the rig, -1 = use ap), pick (1 = a work-10 worker foraging at a bush: the rig plays `gather` instead of `farm`), wb (action clip blend 0..1), carry (0..1 visible share of the carried goods), impact (work code in the frame of a tool hit, else 0), flinch/flash (0..1 after a hit point loss), back (stand-off of the body, tiles, backwards along the facing: ring, bar and hit effects follow the body), hl/hg/hr (lean, lunge, roll of the flinch; already part of lean/lunge/roll for non-rig units)
// X.rigged = the unit is drawn by the baked clips (render/units3d.mjs): work and melee then get the re-timed cycle, a stronger body motion and the impact signal for the tool tip effect (X.rig is something else: the on-screen scale of a rigged rider, see below)
// A rigged rider (X.rig = its scale on screen, set by app.mjs) runs the gait model of render/gait.mjs instead of the single stride above:
// out.rg = 1, out.pw / out.pr = phase of the walk / run clip (cycles), out.gx = cross-fade to the run clip (0..1). The dust puffs fall on the hoof beats.
// radius of the body on the ground (tiles) used to keep a striking unit out of its victim; a victim that is a unit counts as infantry, a building by half its size
const BODY_R = { infantry: 0.45, worker: 0.4, ranged: 0.4, support: 0.4, sapper: 0.4, cavalry: 0.95, siege: 0.9 };
// How a rigged unit's body sits on its spot (app.mjs): while a clip plays (ct >= 0) the whole stepUnit motion; otherwise only the stand-off and the fading strike motion (they ease out, so the body does not snap when the fight or the work ends) and the flinch
export function rigBody(P, o) { const act = P.ct >= 0; o.lg = (act ? P.lunge : P.fl - P.back) + P.hg; o.lean = (act ? P.lean : P.fn) + P.hl; o.y = act ? P.y : 0; return o; }
export function bodyR(def) { return BODY_R[def.cls === 'beast' ? 'cavalry' : def.cls] || BODY_R.infantry; } // body radius on the ground; app.mjs gives it for a victim in X.tgt[4]
const BACK_MAX = 0.3, BACK_MAX_CAV = 0.6, BACK_K = 7; // largest stand-off of a body (tiles) and the rate (1/s) of the two-stage ease that brings it in and out
const STAND_MARGIN = 0.2; // clear distance (tiles) kept between the bodies of two fighters, for shield and weapon arm
const MELEE_CLIP = { 1: 1, 2: 1, 5: 1 }; // acts that play the 40-frame thrust / slash / rider attack clip, hit at frame 0
const WP = { ct: 0, k: 0, lean: 0, lunge: 0, y: 0 };
export function stepUnit(st, c, p, a, dt, time, X, out) {
  const def = X.def, x = X.x, z = X.z;
  const cl = CLS[X.name] || CLS[def.cls] || CLS.infantry;
  if (st.px === undefined) { st.px = x; st.pz = z; st.ph = st.seed; st.mv = 0; st.dsum = 0; st.cdMax = 0; st.cdPrev = c[9]; st.hp = c[5]; st.hurtT = -1e9; }
  const dist = Math.hypot(x - st.px, z - st.pz);
  st.px = x; st.pz = z;
  const mvx = p ? c[3] - p[3] : 0, mvz = p ? c[4] - p[4] : 0;
  const moving = mvx * mvx + mvz * mvz > 0.0009;
  st.mv += ((moving ? 1 : 0) - st.mv) * (1 - Math.exp(-dt * (moving ? 10 : 7)));
  const gm = X.rig && GAITS[X.name] ? st.g || (st.g = newState(c[0])) : null;
  if (dist > 0 && !gm) st.ph += Math.min(dist / cl.stride * TAU, 1.0);
  if (gm) {
    if (st.gc !== c) { // a new snapshot: the gait follows the speed of the last tick (the sound director of audio-core.mjs does the same)
      st.gc = c;
      const sp = p ? Math.hypot(c[3] - p[3], c[4] - p[4]) * TICK_HZ / X.dtTicks : 0;
      gm.gait = pickGait(X.name, sp, X.rig, gm.gait);
      if (st.gx === undefined) st.gx = gm.gait;
    }
    const cyc = advance(gm, X.name, X.rig, dist);
    st.ph += cyc * (gm.gait === GALLOP ? 1 : 2) * TAU; // the body bounce follows the hooves: one bound per gallop cycle, one per diagonal pair of the trot
    const bl = dt / BLEND_S;
    st.gx = clamp(st.gx + clamp(gm.gait - st.gx, -bl, bl), 0, 1);
    if (moving) beatsIn(gm.gait, gm.from, cyc, (f, loud, puff) => { if (puff) X.onStep(cl, st.mv * loud); });
  } else if (moving) { st.dsum += dist; if (st.dsum > cl.dust) { st.dsum = 0; X.onStep(cl, st.mv); } }
  if (c[9] > st.cdPrev) st.cdMax = c[9];
  st.cdMax = Math.max(st.cdMax, c[9]);
  st.cdPrev = c[9];
  if (c[5] < st.hp - 0.01) st.hurtT = time + 0.1 * Math.min(X.dtTicks || 1, 2); // hit points dropped since the last snapshot: the unit flinches when the blow lands = the end of this snapshot interval (the attacker's strike frame)
  st.hp = c[5];
  if (time < st.hurtT - 0.3) st.hurtT = -1e9; // the clock restarted (replay, chunk render)

  const aType = actOf(X.name, def), isCav = def.cls === 'cavalry' || def.cls === 'beast', rig = !!X.rigged;
  let act = isCav ? 5 : 0, ap = 0.3, tx = null, tz = null, ct = -1, wk = null, fight = false;
  out.impact = 0; out.pick = 0;
  if (c[6] === 4 && X.tgt && !moving) {
    fight = true; act = aType; tx = X.tgt[0]; tz = X.tgt[1];
    if (X.dtTicks <= 2 && st.cdMax > 0) {
      const c9 = c[9], p9 = p ? p[9] : c9;
      const cdEff = c9 > p9 ? p9 * (1 - a) : p9 + (c9 - p9) * a;
      ap = clamp(1 - cdEff / st.cdMax, 0, 1);
    } else ap = ((time * 0.8 + st.seed * 0.17) % 1 + 1) % 1; // fast-forward: free-running cycle
    // the hit lands when the cooldown restarts (the end of the interpolation from the previous snapshot). A renderer that never draws a frame in the last 15 % of that interval (30 fps video against 10 ticks/s) fires it in the first frame of the next one instead: no hit effect is lost
    const restart = c[9] > (p ? p[9] : 0);
    if (restart) { if (a >= 0.85 && st.hitFor !== c) { st.hitFor = c; X.onHit(act, tx, tz); } else if (st.hitFor !== c) st.hitPend = c; }
    else if (st.hitPend && st.hitFor !== st.hitPend) { st.hitFor = st.hitPend; st.hitPend = null; X.onHit(act, tx, tz); }
    if (rig && MELEE_CLIP[act]) ct = attackFrame(ap) / ATTACK_FRAMES;
  } else if ((c[6] === 2 || c[6] === 3) && !moving && def.cls === 'worker') {
    const g = X.work(); // {code, tx, tz} or null
    if (g) {
      act = g.code; tx = g.tx; tz = g.tz;
      const cyc = time / WORK[g.code] + st.seed * 0.13, idx = Math.floor(cyc);
      ap = frac(cyc);
      if (rig) {
        wk = workPose(g.code, ap, WP, g.pick); ct = wk.ct; out.pick = g.pick && g.code === 10 ? 1 : 0;
        if (impactWindow(g.code, ap, idx) >= 0 && st.workFor !== idx) { st.workFor = idx; if (g.code !== 10) out.impact = g.code; } // the tool hits now: app.mjs puts the effect at the tool tip
      } else if (g.code !== 10 && ap < 0.04 && st.workFor !== idx) { st.workFor = idx; X.onWork(g.code, tx, tz); }
    }
  }
  if (!fight) st.hitPend = null; // a pending hit of a target that is gone (or a unit that stopped fighting) must not fire at the next fight
  // facing
  let want = st.ang;
  if (moving) want = Math.atan2(mvx, mvz);
  else if (tx !== null) { const ddx = tx - x, ddz = tz - z; if (ddx * ddx + ddz * ddz > 0.04) want = Math.atan2(ddx, ddz); }
  let da = want - st.ang; da = Math.atan2(Math.sin(da), Math.cos(da));
  st.ang += da * (1 - Math.exp(-dt * cl.turn));
  // a worker with a tool in both hands does not carry anything: fade the goods out, and in again when he walks on. Clip blend: from the walk/idle pose into the action clip
  const clipAct = ct >= 0;
  st.cv = (st.cv ?? 1) + ((WORK_ACTS.has(act) ? 0 : 1) - (st.cv ?? 1)) * (1 - Math.exp(-dt * 14));
  st.wb = (st.wb ?? 0) + ((clipAct ? 1 : 0) - (st.wb ?? 0)) * (1 - Math.exp(-dt * 12));

  const k = clipAct && !wk && MELEE_CLIP[act] ? strikeK(ap) : kcur(ap), kw = Math.max(-k, 0), kh = Math.max(k, 0);
  const mv = st.mv, ph = st.ph;
  let y = 0, lean = 0, roll = 0, lunge = 0, sy = 1;
  switch (act) {
    case 1: if (rig) { lunge = 0.28 * kh - 0.1 * kw; lean = 0.2 * kh - 0.06 * kw; } else { lunge = 0.22 * kh - 0.08 * kw; lean = 0.25 * kh - 0.05 * kw; } break;
    case 2: if (rig) { lunge = 0.2 * kh - 0.07 * kw; lean = 0.26 * kh - 0.1 * kw; } else { lunge = 0.12 * kh; lean = 0.45 * kh - 0.25 * kw; } break;
    case 3: lunge = -0.07 * kh; lean = -0.06 * kh; break;
    case 4: lunge = 0.1 * kh; lean = 0.4 * kh - 0.2 * kw; break;
    case 5: if (c[6] === 4 && !moving) { if (rig) { lunge = 0.32 * kh - 0.12 * kw; lean = 0.16 * kh - 0.06 * kw; } else { lunge = 0.3 * kh - 0.12 * kw; lean = 0.12 * kh - 0.05 * kw; } } break;
    case 6: lunge = 0.16 * kh - 0.1 * kw; break;
    case 7: lunge = -0.08 * kh; lean = -0.05 * kh; y = 0.03 * kh; break;
    case 12: lunge = -0.1 * kh; y = 0.02 * kh; break;
    case 13: lean = 0.55; break; // crouched over the charge
    case 8: case 9: case 11: if (wk) { lean = wk.lean; lunge = wk.lunge; y = wk.y; } else if (act === 11) lean = 0.25 + 0.1 * Math.sin(ap * TAU * 2); else lean = 0.5 * kh - 0.15 * kw; break;
    case 10: if (wk) { lean = wk.lean; lunge = wk.lunge; y = wk.y; } else lean = 0.55 + 0.12 * Math.sin(ap * TAU); break;
    default: break;
  }
  // melee: the sim lets two fighters stop 0.74 tiles apart (range 1), less than their bodies are wide. The drawn body stands back along its facing to a clear distance
  // (X.tgt[3]: the victim strikes back and steps back as well, X.tgt[4]: its radius). The step is eased with the renderer's clock in two stages (no jump when a fight starts or ends),
  // limited (cavalry 0.6 tiles) and cut short before it would leave the walkable ground (X.free)
  let rA = 0, rB = 0, mutual = 0, share = 1, backT = 0;
  if (fight) {
    rA = bodyR(def); rB = X.tgt[2] > 0 ? X.tgt[2] / 2 : (X.tgt[4] || BODY_R.infantry);
    const d = Math.hypot(tx - x, tz - z); mutual = X.tgt[3] ? 1 : 0; share = mutual ? 0.5 : 1;
    backT = Math.min(Math.max(0, rA + rB + STAND_MARGIN - d) * share, isCav ? BACK_MAX_CAV : BACK_MAX);
    if (backT > 0 && X.free) {
      const sb = Math.sin(st.ang), cb = Math.cos(st.ang);
      while (backT > 0.02 && !(X.free(x - sb * backT, z - cb * backT) && X.free(x - sb * backT * 0.5, z - cb * backT * 0.5))) backT *= 0.5;
      if (backT <= 0.02) backT = 0;
    }
  }
  if (st.back === undefined || time < st.backT - 0.3 || time - st.backT > 0.5) st.back = st.back1 = backT, st.fw = 0; // first frame, a clock that went back (replay, chunk render) or a long pause: at the target
  else { const e = 1 - Math.exp(-dt * BACK_K); st.back1 += (backT - st.back1) * e; st.back += (st.back1 - st.back) * e; }
  st.backT = time;
  if (fight) { // the lunge only uses the room that is left between the bodies, a lean gets smaller with it
    const d = Math.hypot(tx - x, tz - z), room = Math.max(0, d + st.back * (1 + mutual) - rA - rB) * share;
    if (lunge > room) lunge = room;
    if (lean > 0) lean *= 0.55 + 0.45 * clamp(room / 0.3, 0, 1);
  }
  let fl = 0, fn = 0; // the strike motion of the last fight frame dies away in 0.25 s when the fight ends (no snap back); fl / fn: the part that is left
  if (fight) { st.sl = lunge; st.sn = lean; st.fw = 1; }
  else if (st.fw > 0.001) { st.fw *= Math.exp(-dt * 12); fl = st.sl * st.fw; fn = st.sn * st.fw; lunge += fl; lean += fn; }
  out.fl = fl; out.fn = fn;
  lunge -= st.back;
  if (mv > 0.01) {
    if (isCav) { y += Math.max(0, Math.sin(ph + 0.3)) * cl.bob * mv; lean += cl.lean * mv + Math.sin(ph + 0.6) * 0.07 * mv; roll += Math.sin(ph) * cl.roll * mv; }
    else { y += Math.abs(Math.sin(ph)) * cl.bob * mv; lean += cl.lean * mv; roll += Math.sin(ph) * cl.roll * mv; }
  }
  if (mv < 0.5 && act === (isCav ? 5 : 0)) { sy = 1 + Math.sin(time * 2 + st.seed) * 0.012; roll += Math.sin(time * 0.9 + st.seed) * 0.015 * (1 - mv); }
  // hit flinch: knocked back a little, a short shake, a flash of the body; for the rigs app.mjs adds hl/hg/hr to the body motion itself
  const hage = time - st.hurtT, hk = flinchK(hage), hs = Math.sin(hage * 52) * hk;
  out.flinch = hk; out.flash = flashK(hage);
  out.hl = -0.2 * hk; out.hg = -0.09 * hk; out.hr = 0.07 * hs;
  if (!rig) { lean += out.hl; lunge += out.hg; roll += out.hr; sy *= 1 - 0.05 * hk; }
  out.ct = ct; out.wb = st.wb; out.carry = st.cv;
  out.y = y; out.lean = lean; out.roll = roll; out.lunge = lunge; out.sy = sy; out.ang = st.ang; out.back = st.back;
  out.ph = ph; out.amp = cl.amp * mv; out.act = act; out.ap = ap;
  out.rg = gm ? 1 : 0;
  if (gm) { out.pw = gm.pw; out.pr = gm.pr; out.gx = st.gx; }
  return out;
}

// death: fall, lie, sink and shrink. d = {cls, dir (+-1), age}. Returns false when finished.
export const DEATH_S = { infantry: 2.2, cavalry: 2.5, siege: 2.1 };
// A rigged unit that dies keeps the body motion of its last live frame (stand-off, strike lunge, flinch lean) and lets it go over DEATH_CARRY_S seconds, so the fall starts from the pose it was drawn in
export const DEATH_CARRY_S = 0.25;
export function deathCarry(age) { return 1 - smooth(age / DEATH_CARRY_S); }
export function deathPose(d, age, out) {
  const cls = d.cls === 'cavalry' ? 'cavalry' : d.cls === 'siege' ? 'siege' : 'infantry';
  const dur = DEATH_S[cls];
  if (age >= dur) return false;
  out.y = 0; out.lean = 0; out.roll = 0; out.lunge = 0; out.sy = 1; out.scale = 1; out.act = 0; out.amp = 0;
  if (cls === 'infantry') {
    const tf = clamp(age / 0.38, 0, 1), e = tf * tf;
    out.lean = -e * 1.5 * (d.dir > 0 ? 1 : 0.9); out.roll = Math.sin(tf * Math.PI) * 0.2 * d.dir; out.lunge = -0.35 * (1 - (1 - tf) * (1 - tf)); out.y = 0.1 * e;
    out.y -= smooth((age - 1.3) / 0.8) * 0.3;
    out.scale = 1 - smooth((age - 1.8) / 0.4);
  } else if (cls === 'cavalry') {
    const tf = clamp(age / 0.5, 0, 1), e = tf * tf * (3 - 2 * tf);
    out.roll = 1.5 * e * d.dir; out.lunge = 0.5 * (1 - (1 - tf) * (1 - tf)); out.y = 0.18 * Math.sin(tf * Math.PI) + 0.12 * e;
    out.y -= smooth((age - 1.4) / 0.9) * 0.45;
    out.scale = 1 - smooth((age - 2.0) / 0.5);
  } else {
    const tf = smooth(age / 0.9);
    out.sy = 1 - 0.5 * tf; out.roll = 0.2 * d.dir * tf; out.lean = -0.1 * tf; out.y = -0.35 * smooth((age - 0.6) / 1.1);
    out.scale = 1 - smooth((age - 1.7) / 0.4);
  }
  return true;
}
