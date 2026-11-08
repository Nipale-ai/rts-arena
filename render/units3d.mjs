// Rigged 3D units (art-v2 models): GPU skinning from baked skin-matrix textures, one InstancedMesh per (unit model, LOD, body|team).
// tools/rig/build-units.mjs bakes every clip of tools/rig/clips.mjs into a half-float texture per unit (rows = frames, 3 texels per bone = 3x4 matrix).
// Per instance: iA = (row of frame f0, row of frame f1, blend f0->f1, weight of the second clip), iB = same for the idle clip (the walk -> idle blend).
// No CPU skinning and no per-bone uniforms: the vertex shader reads at most 4 bones x 2 frames (x 2 clips while blending) per vertex.
// Animation time only comes from the caller (sim tick / shared shader time), so broadcast renders stay frame-exact.
// `?models=classic` and `?units=classic` keep the procedural figures of models.mjs.
import * as THREE from './vendor/three.module.js';
import { hash01 } from './anim.mjs';
import { getThemeSlot } from './theme/theme-loader.mjs'; // the read interface of the theme loader
import { tipOf, tuneOf, anchorOf } from './theme/rig-data.mjs'; // tip, muzzle_anchor, lift, floor of a registry entry (a body of a theme carries them, the classic bodies use the tables below)
import { parseColor } from './shooter-theme.mjs';

export const USE_UNITS3D = typeof location === 'undefined' ? true : (() => { const q = new URLSearchParams(location.search); return q.get('models') !== 'classic' && q.get('units') !== 'classic'; })();
const BASE = 'assets/models/units/';
const CAP = 700;
const UNIT_LIFT = 0.3; // emissive share of the unit atlas (see the body material)
// per-model brightness lift on top of that, for atlases with large near-black areas (renderer only, no repaint / rebake of the atlas):
//   lift = emissive share of the atlas (replaces UNIT_LIFT), floor = share of white added to the albedo of the body (black helmet, chain mail, blade become dark steel; wear detection looks at the unlifted colour)
// (the classic bodies only: a body of a theme names `lift` and `floor` in its registry entry, tools/rig/units.d, and they win over this table)
const UNIT_TUNE = { schwertkaempfer: { lift: 0.45, floor: 0.075 } };
const FORCE_LOD = typeof location === 'undefined' ? -1 : +(new URLSearchParams(location.search).get('riglod') ?? -1); // dev: ?riglod=0|1|2 forces one LOD
// video only (tools/render-story.mjs --team-tint N puts teamtint=N into the page address): the body of a rigged unit is pushed towards the hue of its team colour by this share (N 0..1; gain = lerp(1, colour / luma(colour), N), so the brightness stays), so a team
// can be told apart on bodies of nearly the same colour as the ground (Dustmoon: orange-brown units on ochre sand). Without the parameter: 0, no instance colour on the body, nothing changes.
const TEAM_TINT = typeof location === 'undefined' ? 0 : Math.max(0, Math.min(1, +(new URLSearchParams(location.search).get('teamtint') ?? 0) || 0));
const _tc = new THREE.Color();
const _tg = [1, 1, 1];
// the gain of the body colour for the tint k (0..1): lerp(1, colour / luma(colour), k); k = 0 is exactly 1, the brightness of a grey body stays
export function teamGain(c, k, o = [1, 1, 1]) {
  const lu = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b || 1;
  o[0] = 1 + k * (c.r / lu - 1); o[1] = 1 + k * (c.g / lu - 1); o[2] = 1 + k * (c.b / lu - 1);
  return o;
}
// a blue team colour (blue the largest channel) gets a stronger push than the others: in close shots the bodies of the blue team read as the colour of the ground and the jackets, with blue only at the ring (Dustmoon, P10 check 05.11.)
const TEAM_TINT_BLUE = 1.6;
export const teamTintOf = (c, k) => Math.min(0.95, k * (c.b > c.r && c.b > c.g ? TEAM_TINT_BLUE : 1));
const JAV_GONE = 0.6; // share of the throw clip (from the release) in which the skirmisher has no javelin in the hand (anim.mjs: the same 0.6 for the procedural figure)
// the held javelin at the release (frame 0 of the throw clip), rest pose of the plaenkler model (tools/rig/units.json: hand_R and the tool capsule): grip point, butt and tip of the shaft
const JAV_REST = { grip: [-0.28, 0.49, 0.10], butt: [-0.41, 0.52, 0.01], tip: [0.14, 0.43, 0.475] };
const LOD_DIST = [26, 52]; // camera distance (tiles) where LOD1 / LOD2 start; hysteresis 8 %

// game unit -> rigged model keys; `role` selects the body for workers (what they are doing / last did)
export const UNIT_MODELS = {
  worker: { roles: { 0: 'bauer', 8: 'holzfaeller', 9: 'bergarbeiter', 11: 'baumeister' } },
  spearman: { roles: { 0: 'speer' } },
  swordsman: { roles: { 0: 'schwertkaempfer' } },
  archer: { roles: { 0: 'bogenschuetze' } },
  skirmisher: { roles: { 0: 'plaenkler' } },
  light_cavalry: { roles: { 0: 'reiter' } },
  heavy_cavalry: { roles: { 0: 'schwere-reiterei' } },
  scout: { roles: { 0: 'kundschafter' }, mul: 1.4 }, // mul: the generated scout is far smaller than the other riders; scaled up in the game
  healer: { roles: { 0: 'heiler' } },
  sapper: { roles: { 0: 'pionier' } },
  bulwark: { roles: { 0: 'schildwall' } },
};

// size factor of a rigged model (game unit name / model key)
export const unitMul = (name) => UNIT_MODELS[name]?.mul || Object.values(UNIT_MODELS).find((m) => m.mul && Object.values(m.roles).includes(name))?.mul || 1;

const SKIN_GLSL = /* glsl */`
attribute vec4 aJ; attribute vec4 aW; attribute vec4 iA; attribute vec4 iB; attribute vec4 iW;
uniform highp sampler2D tAnim;
vec4 sk0, sk1, sk2;
void skinCompute(){
  sk0 = vec4(0.0); sk1 = vec4(0.0); sk2 = vec4(0.0);
  int a0 = int(iA.x + 0.5), a1 = int(iA.y + 0.5), b0 = int(iB.x + 0.5), b1 = int(iB.y + 0.5);
  for (int i = 0; i < 4; i++) {
    float w = aW[i];
    if (w <= 0.0) continue;
    int c = int(aJ[i] + 0.5) * 3;
    vec4 p0 = mix(texelFetch(tAnim, ivec2(c, a0), 0), texelFetch(tAnim, ivec2(c, a1), 0), iA.z);
    vec4 p1 = mix(texelFetch(tAnim, ivec2(c + 1, a0), 0), texelFetch(tAnim, ivec2(c + 1, a1), 0), iA.z);
    vec4 p2 = mix(texelFetch(tAnim, ivec2(c + 2, a0), 0), texelFetch(tAnim, ivec2(c + 2, a1), 0), iA.z);
    if (iA.w > 0.001) {
      vec4 q0 = mix(texelFetch(tAnim, ivec2(c, b0), 0), texelFetch(tAnim, ivec2(c, b1), 0), iB.z);
      vec4 q1 = mix(texelFetch(tAnim, ivec2(c + 1, b0), 0), texelFetch(tAnim, ivec2(c + 1, b1), 0), iB.z);
      vec4 q2 = mix(texelFetch(tAnim, ivec2(c + 2, b0), 0), texelFetch(tAnim, ivec2(c + 2, b1), 0), iB.z);
      p0 = mix(p0, q0, iA.w); p1 = mix(p1, q1, iA.w); p2 = mix(p2, q2, iA.w);
    }
    sk0 += p0 * w; sk1 += p1 * w; sk2 += p2 * w;
  }
}
vec3 skinPos(vec3 p){ vec4 q = vec4(p, 1.0); return vec3(dot(sk0, q), dot(sk1, q), dot(sk2, q)); }
vec3 skinNrm(vec3 n){ return vec3(dot(sk0.xyz, n), dot(sk1.xyz, n), dot(sk2.xyz, n)); }
// the javelin in the right hand of the skirmisher is part of the baked body: while the throw clip has released it (first part of the clip) it is folded into the fist,
// a new one grows out of the hand while the arm winds up. Shaft and head = what lies on the grip axis of the rest pose outside the fist (the head vertices of the decimated LODs
// are bound to other bones, so inside the throw clip these vertices follow hand_R alone, like a tool should).
uniform vec4 uJav; // x: 1 = this model throws, y: first row of the throw clip, z: its frame count, w: share of the clip without a javelin in the hand
void skinBone(int bone){
  int a0 = int(iA.x + 0.5), a1 = int(iA.y + 0.5), c = bone * 3;
  sk0 = mix(texelFetch(tAnim, ivec2(c, a0), 0), texelFetch(tAnim, ivec2(c, a1), 0), iA.z);
  sk1 = mix(texelFetch(tAnim, ivec2(c + 1, a0), 0), texelFetch(tAnim, ivec2(c + 1, a1), 0), iA.z);
  sk2 = mix(texelFetch(tAnim, ivec2(c + 2, a0), 0), texelFetch(tAnim, ivec2(c + 2, a1), 0), iA.z);
}
vec3 javHide(vec3 p){
  if (uJav.x < 0.5 || iA.w > 0.001) return p;
  float r = iA.x - uJav.y;
  if (r < -0.5 || r > uJav.z - 0.5) return p;
  float w = 0.0; for (int q = 0; q < 4; q++) if (abs(aJ[q] - 11.0) < 0.5) w += aW[q];
  vec3 ab = vec3(0.64, -0.11, 0.58), q0 = p - vec3(-0.45, 0.53, 0.0);
  float t = dot(q0, ab) / dot(ab, ab), rad = length(q0 - ab * t);
  if ((w > 0.1 && (t < 0.14 || t > 0.38)) || (t > 0.4 && t < 1.2 && rad < 0.09)) {
    skinBone(11);
    float have = smoothstep(uJav.w - 0.02, uJav.w + 0.1, r / uJav.z); // 0 right after the release, a new javelin comes into the hand while the arm winds up
    return mix(vec3(-0.28, 0.49, 0.10), p, have);
  }
  return p;
}
`;
// wear of the body material: dirt (low on the body), patches and holes (random spots in a 3D grid, model space); iW = (dirt, holes, seed, tone)
const WEAR_VERT = `
varying vec4 vW; varying vec3 vLp; varying float vRW; uniform float uRiderFrom;`;
const WEAR_FRAG = `
varying vec4 vW; varying vec3 vLp; varying float vRW; uniform float uHeadY; uniform float uFloor;
float wh(vec3 c){ return fract(sin(dot(c, vec3(127.1, 311.7, 74.7)) + vW.z * 91.7) * 43758.5453); }
float wnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wh(i), wh(i + vec3(1,0,0)), f.x), mix(wh(i + vec3(0,1,0)), wh(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(wh(i + vec3(0,0,1)), wh(i + vec3(1,0,1)), f.x), mix(wh(i + vec3(0,1,1)), wh(i + vec3(1,1,1)), f.x), f.y), f.z); }
float wspots(vec3 p, float rad){ vec3 c = floor(p), f = fract(p); float d = 9.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(float(x), float(y), float(z)); vec3 cc = c + o;
    vec3 ctr = o + vec3(wh(cc + 1.3), wh(cc + 2.7), wh(cc + 4.1)); d = min(d, length(f - ctr)); }
  return 1.0 - smoothstep(rad * 0.8, rad, d); }`;
const WEAR_APPLY = `
vec3 wp = vLp * 9.0; vec3 wq = wp + 0.9 * vec3(wnoise(wp * 1.7), wnoise(wp * 1.7 + 9.0), wnoise(wp * 1.7 + 19.0)); // ragged edges
vec3 wBase = diffuseColor.rgb; float wLum = dot(wBase, vec3(0.3, 0.59, 0.11));
// cloth only: no wear on skin (orange, saturated, bright in sRGB) and not on the head of foot units
vec3 wS = pow(max(wBase, vec3(0.0)), vec3(0.4545));
float wMx = max(wS.r, max(wS.g, wS.b)), wMn = min(wS.r, min(wS.g, wS.b)), wSat = (wMx - wMn) / max(wMx, 0.001);
float wHue = 60.0 * (wS.g - wS.b) / max(wMx - wMn, 0.001);
float skin = step(wS.r, wMx) * step(wS.b, wS.g) * smoothstep(5.0, 10.0, wHue) * (1.0 - smoothstep(34.0, 42.0, wHue)) * smoothstep(0.24, 0.3, wSat) * (1.0 - smoothstep(0.62, 0.7, wSat)) * smoothstep(0.5, 0.6, wMx);
float metal = (1.0 - smoothstep(0.04, 0.08, wSat)) * (1.0 - smoothstep(0.7, 0.8, wMx)); // grey metal: no wear
float cloth = smoothstep(0.45, 0.65, vRW) * (1.0 - skin) * (1.0 - metal) * (1.0 - smoothstep(uHeadY - 0.03, uHeadY, vLp.y));
float wDark = 1.0 - smoothstep(0.12, 0.4, wLum); // dark cloth: wear shows lighter, light cloth: wear shows darker
float ground = 1.0 - smoothstep(0.0, 0.55, vLp.y);
float dirtM = clamp(vW.x * (ground + 0.15 * wnoise(wp * 0.7)) * (0.55 + 0.9 * wnoise(wp * 1.3)), 0.0, 1.0);
vec3 wC = wBase; float wM = 0.0;
vec3 dirtC = mix(vec3(0.14, 0.10, 0.06), vec3(0.26, 0.2, 0.14), wDark) * (0.75 + 0.5 * wnoise(wp * 3.0));
wC = mix(wC, dirtC, dirtM * 0.65); wM = dirtM * 0.65;
if (vW.y > 0.0) {
  float pat = wspots(wq * 0.36 + 5.0, 0.26 + 0.2 * vW.y);
  float bleach = step(0.5, fract(vW.z * 13.7));
  vec3 stainC = mix(vec3(0.08, 0.055, 0.035), vec3(0.4, 0.32, 0.22), wDark) * (0.8 + 0.4 * wnoise(wp * 5.0));
  vec3 fadeC = vec3(wLum) * 0.8 + vec3(0.3, 0.28, 0.24);
  wC = mix(wC, mix(stainC, fadeC, bleach), pat * 0.9); wM = max(wM, pat * 0.9);
  float hole = wspots(wq * 0.5 + 17.0, 0.14 + 0.1 * vW.y);
  float rim = wspots(wq * 0.5 + 17.0, 0.22 + 0.12 * vW.y);
  wC = mix(wC, wC * mix(0.45, 1.4, wDark), rim * 0.8); wM = max(wM, rim * 0.8);
  wC = mix(wC, mix(vec3(0.02, 0.015, 0.012), vec3(0.45, 0.35, 0.25), wDark), hole); wM = max(wM, hole);
}
wC = mix(wBase, wC, cloth); wM *= cloth;
diffuseColor.rgb = (wC + uFloor * (1.0 - wC)) * vW.w;`;
const WEAR_EMISSIVE = `
totalEmissiveRadiance = mix(totalEmissiveRadiance, diffuseColor.rgb * 0.3, wM) * vW.w;
#ifdef USE_INSTANCING_COLOR
totalEmissiveRadiance *= vColor.rgb;
#endif`;
function patch(mat, key, tAnim, headY = 99, riderFrom = 0, jav = null, floor = 0) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tAnim = { value: tAnim };
    sh.uniforms.uJav = { value: jav ? new THREE.Vector4(1, jav.start, jav.n, JAV_GONE) : new THREE.Vector4(0, 0, 1, 0) };
    sh.uniforms.uHeadY = { value: headY }; sh.uniforms.uRiderFrom = { value: riderFrom }; sh.uniforms.uFloor = { value: floor };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_GLSL)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nskinCompute();\nobjectNormal = skinNrm(objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef SKIN_DEPTH\nskinCompute();\n#endif\nvW = iW; vLp = position; vRW = 0.0; float wHand = 0.0; for (int q = 0; q < 4; q++) { if (aJ[q] > uRiderFrom - 0.5) vRW += aW[q]; if (uRiderFrom < 0.5 && (abs(aJ[q] - 8.0) < 0.5 || abs(aJ[q] - 11.0) < 0.5)) wHand += aW[q]; } if (wHand > 0.5) vRW = 0.0; // wear only on the bones of the rider (not the horse) and not on what a foot unit holds (shield, bow, tools: mostly on hand_L = 8 or hand_R = 11)\ntransformed = skinPos(javHide(transformed));')
      .replace('void main() {', WEAR_VERT + '\nvoid main() {');
    if (key === 'body') sh.fragmentShader = sh.fragmentShader.replace('void main() {', WEAR_FRAG + '\nvoid main() {').replace('#include <map_fragment>', '#include <map_fragment>\n' + WEAR_APPLY).replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + WEAR_EMISSIVE);
  };
  mat.customProgramCacheKey = () => 'unit3d' + key;
  return mat;
}
function depthMat(tAnim, jav = null) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.defines = { SKIN_DEPTH: 1 };
  return patch(m, 'depth', tAnim, 99, 0, jav);
}

export class Units3D {
  constructor(scene, teamColors) {
    this.scene = scene; this.teamColors = teamColors;
    this.reg = null; this.models = new Map(); // key -> { lods: [{ body, team }], ... }
    this.tex = new Map();
    this.ready = null;
    this.stats = { tris: 0 };
  }
  async init() {
    this.reg = await (await fetch(BASE + 'UNITS.json')).json();
    return this;
  }
  // (the three lookups read `this.themeRoles` directly, not through a helper: tests call roleKey on a plain stub object)
  has(name) { return !(this.noRig && this.noRig.has(name)) && !!UNIT_MODELS[name] && !!this.reg && !!this.reg.units[(this.themeRoles?.[name] || UNIT_MODELS[name].roles)[0]]; }
  keys(name) { return Object.values(this.themeRoles?.[name] || UNIT_MODELS[name].roles).filter((k) => this.reg.units[k]); }
  roleKey(name, role) { const r = this.themeRoles?.[name] || UNIT_MODELS[name].roles; return this.reg.units[r[role]] ? r[role] : r[0]; }
  // Theme hook (R3): per unit type the theme may name another rigged model (units.<type>.model = a key of UNITS.json, or { rig: <key> }; a glb alone is not enough, the rig fit of R5 makes the
  // baked files), another action clip (units.<type>.clips.shoot, a clip of the rig family) and, for the hook test only, a tint (units.<type>.tint: the same model in another colour, a key that a real
  // theme.json cannot carry). Call after init() and before loadUnit(). Nothing set = nothing changes.
  // A tinted copy is a second entry of the registry (`<key>~<hex>`, file = the base key): it loads the same files into its own meshes with its own material.
  applyTheme(theme) {
    if (!theme || !this.reg) return this;
    this.themeRoles = {}; this.themeClips = {}; this.themeActions = new Set();
    for (const name of Object.keys(UNIT_MODELS)) {
      const m = getThemeSlot(theme, `units.${name}.model`), model = typeof m === 'string' ? m : m && typeof m.rig === 'string' ? m.rig : null;
      const tint = parseColor(getThemeSlot(theme, `units.${name}.tint`)), shoot = getThemeSlot(theme, `units.${name}.clips.shoot`);
      if (m !== undefined && model === null && tint === null) console.warn(`theme: unit ${name} has a model slot without a rig key (model.rig), the classic figure stays (the rig fit is package R5)`);
      else if (model !== null && !this.reg.units[model]) console.warn(`theme: unit ${name} names the rig "${model}", which is not in the registry (not baked yet, package R5), the classic figure stays`);
      const roles = {};
      for (const [role, key] of Object.entries(UNIT_MODELS[name].roles)) {
        let k = role === '0' && model !== null && this.reg.units[model] ? model : key;
        if (tint !== null && this.reg.units[k]) {
          const tk = `${k}~${tint.toString(16).padStart(6, '0')}`;
          if (!this.reg.units[tk]) this.reg.units[tk] = { ...this.reg.units[k], file: this.reg.units[k].file || k, tint };
          k = tk;
        }
        roles[role] = k;
      }
      if (Object.entries(roles).some(([r, k]) => k !== UNIT_MODELS[name].roles[r])) this.themeRoles[name] = roles;
      const info = this.reg.units[(this.themeRoles[name] || UNIT_MODELS[name].roles)[0]], clips = info && this.reg.families[info.family]?.clips;
      if (typeof shoot === 'string' && clips && clips[shoot]) { this.themeClips[name] = { shoot }; this.themeActions.add(shoot); }
      else if (shoot !== undefined) console.warn(`theme: the rig of unit ${name} has no clip "${shoot}" (not baked yet), the classic shoot clip stays`);
    }
    return this;
  }
  // loads all models of a game unit (resolves when every LOD is ready)
  loadUnit(name) { return Promise.all(this.keys(name).map((k) => this.loadModel(k))); }
  loadModel(key) {
    if (this.models.has(key)) return this.models.get(key).promise;
    const info = this.reg.units[key], M = { key, info, lods: [], promise: null }, fk = info.file || key; // fk: the files of the model (a themed tint copy shares the files of its base key)
    this.models.set(key, M);
    M.promise = (async () => {
      const [animBuf, map] = await Promise.all([fetch(BASE + fk + '.anim').then((r) => r.arrayBuffer()), new Promise((res, rej) => new THREE.TextureLoader().load(BASE + fk + '.jpg', res, undefined, rej))]);
      map.colorSpace = THREE.SRGBColorSpace; map.flipY = false; map.anisotropy = 4;
      const tAnim = new THREE.DataTexture(M.anim = new Uint16Array(animBuf), this.reg.families[info.family].bones * 3, this.reg.families[info.family].rows, THREE.RGBAFormat, THREE.HalfFloatType);
      tAnim.minFilter = tAnim.magFilter = THREE.NearestFilter; tAnim.generateMipmaps = false; tAnim.needsUpdate = true;
      M.tAnim = tAnim;
      // the atlases bake dark (shadowed, AO mixed in): a little of the texture is added as emissive so that dark armour and cloth keep their colour in shade and in broadcast lighting
      const thr = fk === 'plaenkler' ? this.reg.families[info.family].clips.throw : null, jav = thr ? { start: thr.start, n: thr.n } : null; // the skirmisher throws its held javelin
      const tune = tuneOf(info, UNIT_TUNE[fk], UNIT_LIFT); // registry entry first (a body of a theme), then the classic table
      const body = patch(new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: tune.lift }), 'body', tAnim, /reiter|reiterei|kundschafter/.test(fk) ? 99 : 0.84 * info.H, info.family === 'rider' ? 14 : 0, jav, tune.floor);
      if (info.tint !== undefined) { body.color.setHex(info.tint); body.emissive.setHex(info.tint); } // theme tint (units.<type>.tint): colour and the emissive share of the atlas are multiplied by it
      const team = patch(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0 }), 'team', tAnim);
      M.depth = depthMat(tAnim, jav); M.fam = this.reg.families[info.family];
      for (let lod = 0; lod < info.lods.length; lod++) {
        const L = info.lods[lod], buf = await (await fetch(`${BASE}${fk}_${lod}.bin`)).arrayBuffer();
        const n = L.verts, nt = L.body + L.team;
        let o = 0;
        const pos = new Float32Array(buf, o, n * 3); o += n * 12;
        const nrm8 = new Int8Array(buf, o, n * 4); o += n * 4;
        const uv = new Uint16Array(buf, o, n * 2); o += n * 4;
        const sj = new Uint8Array(buf, o, n * 4); o += n * 4;
        const sw = new Uint8Array(buf, o, n * 4); o += n * 4;
        const idx = new Uint16Array(buf, o, nt * 3);
        const nrm = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { nrm[i * 3] = nrm8[i * 4] / 127; nrm[i * 3 + 1] = nrm8[i * 4 + 1] / 127; nrm[i * 3 + 2] = nrm8[i * 4 + 2] / 127; }
        const attrs = {
          position: new THREE.BufferAttribute(pos, 3), normal: new THREE.BufferAttribute(nrm, 3), uv: new THREE.BufferAttribute(uv, 2, true),
          aJ: new THREE.BufferAttribute(sj, 4, false), aW: new THREE.BufferAttribute(sw, 4, true),
          iA: new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage),
          iB: new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage),
          iW: new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage),
        };
        const mk = (i0, i1, mat) => {
          const g = new THREE.BufferGeometry();
          for (const k in attrs) g.setAttribute(k, attrs[k]);
          g.setIndex(new THREE.BufferAttribute(idx.slice(i0 * 3, i1 * 3), 1));
          const m = new THREE.InstancedMesh(g, mat, CAP);
          m.count = 0; m.frustumCulled = false; m.castShadow = true;
          m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          m.customDepthMaterial = M.depth;
          this.scene.add(m);
          return m;
        };
        const bodyM = mk(0, L.body, body);
        if (TEAM_TINT > 0) bodyM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
        M.lods.push({ body: bodyM, team: L.team ? mk(L.body, nt, team) : null, tris: nt, n: 0, prevN: 0, iA: attrs.iA, iB: attrs.iB, iW: attrs.iW });
      }
    })();
    return M.promise;
  }
  // ---- per frame ----
  begin() { for (const M of this.models.values()) for (const l of M.lods) l.n = 0; this.stats.tris = 0; }
  lodFor(st, dist) {
    if (FORCE_LOD >= 0) return FORCE_LOD;
    let l = st.lod3 ?? 0;
    const h = 0.08;
    if (l === 0 && dist > LOD_DIST[0] * (1 + h)) l = 1;
    else if (l === 1 && dist < LOD_DIST[0] * (1 - h)) l = 0;
    if (l === 1 && dist > LOD_DIST[1] * (1 + h)) l = 2;
    else if (l === 2 && dist < LOD_DIST[1] * (1 - h)) l = 1;
    st.lod3 = l;
    return l;
  }
  // a: { clip, t (0..1 phase), idleW (weight of the idle clip), idleT }; matrix: instance matrix; color: owner colour
  push(key, lod, matrix, color, A, vr) {
    const M = this.models.get(key);
    if (!M || !M.lods.length) return false;
    const L = M.lods[Math.min(lod, M.lods.length - 1)];
    const i = L.n;
    if (i >= CAP) return false;
    L.n++;
    L.body.setMatrixAt(i, matrix);
    const w = L.iW.array; w[i * 4] = vr ? vr.dirt : 0; w[i * 4 + 1] = vr ? vr.holes : 0; w[i * 4 + 2] = vr ? vr.seed : 0; w[i * 4 + 3] = vr ? vr.tone : 1;
    if (L.team) { L.team.setMatrixAt(i, matrix); L.team.setColorAt(i, color); }
    if (TEAM_TINT > 0) { teamGain(color, teamTintOf(color, TEAM_TINT), _tg); L.body.setColorAt(i, _tc.setRGB(_tg[0], _tg[1], _tg[2])); }
    this.fill(L.iA.array, L.iB.array, i, A, M.fam.clips);
    this.stats.tris += L.tris;
    return true;
  }
  fill(a, b, i, A, clips) {
    const o = clipRows(A, clips, _rows);
    a[i * 4] = o[0]; a[i * 4 + 1] = o[1]; a[i * 4 + 2] = o[2]; a[i * 4 + 3] = o[3];
    b[i * 4] = o[4]; b[i * 4 + 1] = o[5]; b[i * 4 + 2] = o[6]; b[i * 4 + 3] = 0;
  }
  end() {
    for (const M of this.models.values()) for (const l of M.lods) {
      const n = l.n, upto = Math.max(n, l.prevN);
      l.prevN = n;
      l.body.visible = n > 0; if (l.team) l.team.visible = n > 0; // empty meshes cost a draw setup in every pass
      if (!upto) continue; // nothing drawn now or last frame: no upload at all
      // upload only the used part of every per-instance buffer (three r170 update ranges)
      const part = (attr, per) => { attr.clearUpdateRanges(); attr.addUpdateRange(0, Math.max(1, n) * per); attr.needsUpdate = true; };
      part(l.iA, 4); part(l.iB, 4); part(l.iW, 4);
      for (const m of [l.body, l.team]) {
        if (!m) continue;
        m.count = n;
        part(m.instanceMatrix, 16);
        if (m.instanceColor) part(m.instanceColor, 3);
      }
    }
  }
}

// the texture rows one instance reads: [row f0, row f1, blend f0 -> f1, weight of the second clip, row g0, row g1, blend g0 -> g1] (the vertex shader mixes clip 1 at f with clip 2 at g by that weight)
const _rows = [0, 0, 0, 0, 0, 0, 0];
export function clipRows(A, clips, o) {
  const idle = clips.idle, c = clips[A.clip] || idle;
  const mc = A.mix ? clips[A.mix] || idle : idle, mt = A.mix ? A.mixT : A.idleT; // the second clip of the blend: the idle clip, or (rider gait change, clip change) the other clip
  const f = c.loop ? (A.t - Math.floor(A.t)) * c.n : Math.min(1, Math.max(0, A.t)) * (c.n - 1);
  let f0 = Math.floor(f); const fr = f - f0;
  const f1 = c.loop ? (f0 + 1) % c.n : Math.min(f0 + 1, c.n - 1);
  if (f0 >= c.n) f0 = c.n - 1;
  const g = mc.loop === false ? Math.min(1, Math.max(0, mt)) * (mc.n - 1) : (mt - Math.floor(mt)) * mc.n, g0 = Math.floor(g);
  o[0] = c.start + f0; o[1] = c.start + f1; o[2] = fr; o[3] = A.idleW || 0;
  o[4] = mc.start + g0; o[5] = mc.start + (mc.loop === false ? Math.min(g0 + 1, mc.n - 1) : (g0 + 1) % mc.n); o[6] = g - g0;
  return o;
}
// half float -> float
function h2f(h) { const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1; return e === 0 ? s * 5.960464477539063e-8 * m : e === 31 ? (m ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024); }
const _jp = new THREE.Vector3(), _jb = new THREE.Vector3();
// the thrown javelin of a skirmisher at the moment of the release, in world space: `out.grip` = the point in the hand, `out.dir` = direction of the shaft (butt -> tip).
// Read from the baked skin matrices (frame 0 of the throw clip), so it always matches the animation. m = instance matrix of the unit. Returns false while the model is not loaded.
Units3D.prototype.javelinRelease = function (key, m, out) {
  const M = this.models.get(key);
  if (!M || !M.anim || !M.fam) return false;
  if (!M.jrel) {
    const c = M.fam.clips.throw;
    if (!c) return false;
    const W = M.fam.bones * 3, base = (c.start * W + 11 * 3) * 4, a = M.anim;
    const at = (p, v) => { for (let r = 0; r < 3; r++) { const o = base + r * 4; v[r] = h2f(a[o]) * p[0] + h2f(a[o + 1]) * p[1] + h2f(a[o + 2]) * p[2] + h2f(a[o + 3]); } return v; }; // hand_R (bone 11) matrix of row 0 of the clip
    M.jrel = { grip: at(JAV_REST.grip, [0, 0, 0]), butt: at(JAV_REST.butt, [0, 0, 0]), tip: at(JAV_REST.tip, [0, 0, 0]) };
  }
  const R = M.jrel;
  out.grip.fromArray(R.grip).applyMatrix4(m);
  _jp.fromArray(R.tip).applyMatrix4(m); _jb.fromArray(R.butt).applyMatrix4(m);
  out.dir.copy(_jp).sub(_jb).normalize();
  out.ok = true;
  return true;
};

// A point that is fixed in a bone of the rest pose, in world space, read from the baked skin matrices exactly like the javelin above: the point rides on the skin matrix of its bone and moves with the clip.
// anchor = { bone, p } (p in model space), `clip` + `t` as in rigState (t = clip phase 0..1), m = instance matrix. Returns false while the model is not loaded, the clip is not in its family or there is no anchor.
const _tt = new THREE.Vector3();
function anchorWorld(M, anchor, clip, t, m, out) {
  if (!M || !M.anim || !M.fam || !anchor) return false;
  const c = M.fam.clips[clip];
  if (!c) return false;
  const W = M.fam.bones * 3, a = M.anim, tip = anchor.p;
  const f = c.loop ? (t - Math.floor(t)) * c.n : Math.min(1, Math.max(0, t)) * (c.n - 1);
  const f0 = Math.floor(f) % c.n, f1 = c.loop ? (f0 + 1) % c.n : Math.min(f0 + 1, c.n - 1), fr = f - Math.floor(f);
  const at = (frame, r) => { const o = ((c.start + frame) * W + anchor.bone * 3) * 4 + r * 4; return h2f(a[o]) * tip[0] + h2f(a[o + 1]) * tip[1] + h2f(a[o + 2]) * tip[2] + h2f(a[o + 3]); };
  _tt.set(at(f0, 0) * (1 - fr) + at(f1, 0) * fr, at(f0, 1) * (1 - fr) + at(f1, 1) * fr, at(f0, 2) * (1 - fr) + at(f1, 2) * fr).applyMatrix4(m);
  out.copy(_tt);
  return true;
}
// Tool tip of a worker or fighter in world space: the tip point is fixed in the hand bone (11 of the human rig) and moves with the clip. A body of a theme names its tip in its registry entry
// (`tip`, from tools/rig/units.d); the classic bodies use TOOL_TIP. Returns false while the model is not loaded or the role has no tool.
export const TOOL_TIP = { // rest-pose tip of the tool in model space (all tools sit in hand bone 11)
  holzfaeller: [-0.163, 0.320, 0.358], bergarbeiter: [-0.219, 0.280, 0.225], baumeister: [-0.309, 0.300, 0.191],
  bauer: [-0.191, 0.260, 0.502], schwertkaempfer: [-0.009, 0.302, 0.343], speer: [-0.17, 1.023, 0.30], plaenkler: [0.124, 0.416, 0.466],
};
const TOOL_BONE = 11;
Units3D.prototype.toolTip = function (key, clip, t, m, out) {
  const M = this.models.get(key);
  return anchorWorld(M, tipOf(M && M.info, key, TOOL_TIP, TOOL_BONE), clip, t, m, out);
};
// Where a shot leaves the weapon (muzzle flash, start of the bolt) in world space: the `muzzle_anchor` of the registry entry (tools/rig/units.d), moved by the clip like the tool tip.
// Same arguments as toolTip. Returns false when the body has no muzzle anchor (the classic bodies have none): the caller keeps the shot origin it has.
Units3D.prototype.muzzleAnchor = function (key, clip, t, m, out) {
  const M = this.models.get(key);
  return anchorWorld(M, anchorOf(M && M.info && M.info.muzzle_anchor), clip, t, m, out);
};

// ---- per-unit animation state from the pose logic of anim.mjs (POSE: ph walk phase [rad], amp, act, ap action phase) ----
const TAU = Math.PI * 2;
const ACT_CLIP = { 1: 'thrust', 2: 'slash', 3: 'shoot', 4: 'throw', 8: 'chop', 9: 'mine', 10: 'farm', 11: 'build', 13: 'plant' };
const WALK_AMP = { worker: 0.75, light_cavalry: 0.95, heavy_cavalry: 0.95 };
const OUT = { key: '', clip: 'idle', t: 0, idleW: 0, idleT: 0, mix: null, mixT: 0 }; // mix: second clip of the blend instead of idle (null = idle)
// When an action clip ends (fight over, work stopped, unit dies) the pose does not jump to the next clip: the last pose of the action clip stays in clip slot 1 and the new clip fades in over it in XF_S seconds.
// The follow-through of a swing is up to 2.9 rad away from the idle pose; the shader blends matrices linearly, which turns the limb fast around the middle of the blend, so the weight follows xfK (an even turn).
export const XF_S = 0.25;
const sstep = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
// weight of the new clip at share s (0..1) of the blend time: the weight of a normalised lerp that equals a slerp for a turn of XF_TURN rad
const XF_TURN = 2.4;
export const xfK = (s) => { s = sstep(s); const a = Math.sin(s * XF_TURN), b = Math.sin((1 - s) * XF_TURN); return a / (a + b); };
const ACTION_CLIP = new Set(['attack', 'thrust', 'slash', 'shoot', 'throw', 'chop', 'mine', 'farm', 'gather', 'build', 'plant', 'heal']);
export function rigState(name, st, POSE, c, time, u3, atk, healing) {
  const O = rigPick(name, st, POSE, c, time, u3, atk, healing), x = st.xf || (st.xf = { on: false, clip: '', t: 0, t0: 0, pc: '', pt: 0, pk: '', pT: -1e9 });
  const fresh = time >= x.pT && time - x.pT < 0.5; // the last frame drawn is just before this one
  if (fresh && x.pc !== O.clip && (ACTION_CLIP.has(x.pc) || u3.themeActions?.has(x.pc)) && x.pk === O.key && !x.on) { x.on = true; x.clip = x.pc; x.t = x.pt; x.t0 = time; }
  x.pc = O.clip; x.pt = O.t; x.pk = O.key; x.pT = time;
  if (x.on) {
    const age = time - x.t0;
    if (age < 0 || age >= XF_S || !fresh) x.on = false;
    else { // slot 1: the finished clip, slot 2: what the unit does now
      const nc = O.clip, nt = O.t;
      O.clip = x.clip; O.t = x.t; O.mix = nc; O.mixT = nt; O.idleW = xfK(age / XF_S);
    }
  }
  return O;
}
// what a dying unit's blend starts from: the last clip pose drawn (st.ld, see app.mjs)
export function rigRemember(st, RS) {
  const L = st.ld || (st.ld = { key: '', clip: 'idle', t: 0, idleT: 0, idleW: 0, mix: null, mixT: 0, x: 0, z: 0, ang: 0, lg: 0, lean: 0, roll: 0, y: 0 });
  L.key = RS.key; L.clip = RS.clip; L.t = RS.t; L.idleT = RS.idleT; L.idleW = RS.idleW; L.mix = RS.mix; L.mixT = RS.mixT;
  return L;
}
export function rigPick(name, st, POSE, c, time, u3, atk, healing) { // the clip of the moment, without the blend
  const act = POSE.act;
  if (name === 'worker') {
    if (act === 8 || act === 9 || act === 11) st.role = act; else if (act === 10) st.role = 0; else if (c && c[6] === 3) st.role = 11;
  }
  OUT.key = u3.roleKey(name, st.role || 0); OUT.mix = null;
  const seed = st.seed || 0, idleT = time / 3.2 + seed * 0.37;
  OUT.idleT = idleT;
  if (healing && POSE.amp < 0.05) { OUT.clip = 'heal'; OUT.t = time / 1.6 + seed * 0.21; OUT.idleW = 0; return OUT; }
  // POSE.ct = the re-timed clip phase of stepUnit (work and melee), POSE.wb = share of the action clip against the idle pose while it blends in. Without a re-timed phase (ct < 0: archer, skirmisher, ...) the clip runs on the action phase and is not blended with idle (wb only follows ct)
  const ct = POSE.ct >= 0 ? POSE.ct : POSE.ap, iw = POSE.ct >= 0 && POSE.wb !== undefined ? 1 - POSE.wb : 0;
  if (act === 5 && atk && POSE.amp < 0.05) { OUT.clip = 'attack'; OUT.t = ct; OUT.idleW = iw; return OUT; }
  if (ACT_CLIP[act] && (act !== 10 || POSE.amp < 0.05)) { OUT.clip = act === 10 && POSE.pick ? 'gather' : u3.themeClips?.[name]?.[ACT_CLIP[act]] || ACT_CLIP[act]; OUT.t = ct; OUT.idleW = iw; return OUT; } // (a theme may name another clip, units.<type>.clip.shoot)
  const amp = POSE.amp, full = WALK_AMP[name] || 0.8;
  if (amp > 0.03 && POSE.rg) { // rider: walk and run clip each on its own stride (render/gait.mjs), cross-fade while the gait changes
    const gx = POSE.gx, idleW = Math.max(0, 1 - amp / (full * 0.85));
    if (gx > 0.999) { OUT.clip = 'run'; OUT.t = POSE.pr; OUT.idleW = idleW; }
    else if (gx < 0.001) { OUT.clip = 'walk'; OUT.t = POSE.pw; OUT.idleW = idleW; }
    else { OUT.clip = 'walk'; OUT.t = POSE.pw; OUT.mix = 'run'; OUT.mixT = POSE.pr; OUT.idleW = gx; }
    return OUT;
  }
  if (amp > 0.03) { OUT.clip = (c && c[8] && name === 'worker') || name === 'sapper' ? 'carry' : 'walk'; /* the sapper hugs its charge */ OUT.t = POSE.ph / TAU; OUT.idleW = Math.max(0, 1 - amp / (full * 0.85)); return OUT; }
  OUT.clip = 'idle'; OUT.t = idleT; OUT.idleW = 0;
  return OUT;
}
// Which fall a dying unit plays. A rider alternates death / death_r by the side of the kill (d.dir); a human has three falls (on the back, onto the chest, onto the knees)
// picked from a hash of the unit id: the same unit falls the same way in every run and in every chunk of a broadcast render, no random numbers.
export const HUMAN_DEATHS = ['death', 'death_f', 'death_k'];
export function deathClip(reg, key, d) {
  const fam = reg.units[key].family, clips = reg.families[fam].clips;
  if (fam === 'rider') return d.dir < 0 && clips.death_r ? 'death_r' : 'death';
  const have = HUMAN_DEATHS.filter((n) => clips[n]);
  return have[Math.floor(hash01(d.id | 0, 0x5d3) * have.length)];
}
Units3D.prototype.deathState = function (name, d, age) {
  OUT.key = this.roleKey(name, d.role || 0); OUT.mix = null;
  const dc = deathClip(this.reg, OUT.key, d), L = d.ld;
  OUT.clip = dc; OUT.t = Math.min(1, age / 0.9); OUT.idleW = 0; OUT.idleT = 0;
  if (L && L.key === OUT.key && age >= 0 && age < XF_S) { // the clip pose of the last live frame (the clip with more weight) fades into the fall
    const hi = L.idleW > 0.5, c1 = L.mix ? (hi ? L.mix : L.clip) : (hi ? 'idle' : L.clip), t1 = L.mix ? (hi ? L.mixT : L.t) : (hi ? L.idleT : L.t);
    OUT.clip = c1; OUT.t = t1; OUT.mix = dc; OUT.mixT = Math.min(1, age / 0.9); OUT.idleW = xfK(age / XF_S);
  }
  return OUT;
};
Units3D.prototype.bearerState = function (ph, mv, time) {
  OUT.key = this.roleKey('swordsman', 0); OUT.mix = null;
  const idleT = time / 3.2;
  OUT.idleT = idleT;
  if (mv > 0.03) { OUT.clip = 'walk'; OUT.t = ph / TAU; OUT.idleW = Math.max(0, 1 - mv / 0.85); } else { OUT.clip = 'idle'; OUT.t = idleT; OUT.idleW = 0; }
  return OUT;
};
