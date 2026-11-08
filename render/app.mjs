// Spectator client: Three.js scene, interpolation between sim snapshots, camera director, minimap.
import * as THREE from './vendor/three.module.js';
import { unitModel, buildingModel, nodeModel, scaffoldModel, markerModel, SMOKE } from './models.mjs';
import * as ANIM from './anim.mjs'; // ANIM+FX: unit rigs, building/tree/water motion
import { Fx } from './fx.mjs'; // ANIM+FX: particles
import { buildTerrain, buildTrees, buildDeco, heightAt } from './terrain.mjs'; // TERRAIN hook: heightAt
import { Hud } from './hud.mjs';
import { God } from './god.mjs'; // God mode panel
import { GodWorld } from './godworld.mjs'; // God mode in the 3D world: storms, treasure chests
import { makeMarkers, shownMarkers } from './markers.mjs'; // intent markers: arrows, labels, ghosts, task icons
import { createPost } from './post.mjs';
import { biomeOf } from './biomes.mjs'; // map types: palette, ground, sky tint
import { WorldFx } from './world-fx.mjs'; // weather, speech bubbles, fish, caravans (the living world)
import { Banners } from './banners.mjs'; // creator banners: flags, hanging banners, pennants, banner bearers
// CAMERA (cinema rig): shared with the broadcast director, see render/cinema.mjs
import { Cinema, cluster, overviewBox } from './cinema.mjs';
import { FIN, planFinale, finaleShot } from './finale.mjs'; // FINALE: when the match is decided the loser's buildings fall one after the other
import * as TERRAIN from './terrain.mjs';
// 3D ASSETS (art-v2 glb models); ?models=classic keeps the procedural models. See render/assets/models/MAP.json
import { Pack, USE_3D, loadGround } from './assets3d.mjs';
import { themedStaticUnit, STATIC_RIDERS } from './theme/nature-theme.mjs'; // theme: its own model for the neutral caravan (nature.objects.caravan); classic = the table entry of MAP.json units
import { Units3D, USE_UNITS3D, rigState, rigRemember, unitMul } from './units3d.mjs';
import { variant, variantsOn, NEUTRAL } from './variants.mjs';
import { GAITS } from './gait.mjs'; // rigged riders: gait, hoof beats
import { CamShake } from './camshake.mjs';
import { buildForest, buildFarForest, buildFarTrees } from './forest.mjs';
import { buildNodes, buildDeco3D } from './props3d.mjs';
import { Shots, shotKind, launchHeight, ARROW, STONE, SHELL, BOLT } from './shots.mjs'; // projectiles on ballistic arcs
import { arrowGeometry, shellGeometry, boltGeometry } from './shot-geo.mjs';
import { resolveFxTheme } from './theme/fx-theme.mjs'; // code package 2: the effect colours of the theme (palette, sapper fuse and blast); classic = the old literals
import { ShooterTable } from './shooter-theme.mjs'; // theme hooks of the shooters: bolt, muzzle flash, hit sparks, sounds (R3 + R4)
import { ShotFx } from './theme/shot-fx.mjs'; // theme hooks, the rest (C6): mesh projectile, muzzle flash at the anchor, hit of a melee blow (the rules: render/theme/shot-theme.mjs)
import { soundThemeOf } from './theme/sound-theme.mjs'; // theme sounds of the whole game: event table, death / place / complete / collapse of a type (C3)
import { themeById } from './theme/placeholder-themes.mjs'; // the test themes of the hooks (?theme=arc-gunner-placeholder); a real theme comes from the loader through pack3d.theme (?theme=<id>-vN)
import { Bld3D } from './buildings3d.mjs';
import { FOG_TINT, FOG_ALPHA, FOG_ALPHA_BROADCAST } from './fog-look.mjs'; // the look of the fog of war (the broadcast legend reads the same numbers)
import { Shrines } from './shrines.mjs'; // relic shrines (content 2)
import { AudioEngine } from './audio.mjs'; // SOUND: live sound engine (starts after a click)
import { mountAudioUI } from './audio-ui.mjs';
import { ViewerPerf, GpuTimer, mountPerfUI, loadQuality, saveQuality, targetFps, shouldDraw, nextDraw, dropStale, readout, ownerColorCache } from './perf.mjs'; // low-power viewer (live and replay)

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const params = new URLSearchParams(location.search);
// Broadcast mode (render/broadcast.html): no network, no animation loop; the frame-exact renderer drives everything.
const BC = !!window.__BROADCAST;
const NO_HUD = { init() {}, update() {}, events() {}, over() {}, tickFeed() {} };
let bcProjEl = 0; // game seconds since the current snapshot (broadcast mode)
let unitClock = 0; // the sim tick (fractional) that the units are drawn at in this frame; thrown javelins follow it, so they leave the hand with the throw animation
const javs = new Map(); // thrown javelins of skirmishers: one record per throw (see renderJavelins)
const UNIT_SCALE = 1.5;
const STRESS = +params.get('stress') || 0; // ANIM dev tool
const CAP = 700;
const LANCE_OFF_L = new THREE.Matrix4().makeTranslation(-0.3, 0.22, 0.12), LANCE_OFF_H = new THREE.Matrix4().makeTranslation(-0.3, 0.04, 0.06), tmpM = new THREE.Matrix4();
const RIG_K = 1.15; // rigged unit models (0.8 tile villager) vs the procedural figures: same visual size
const RES_COLORS = [0, 0xff7a6b, 0xc99a5b, 0xaab4c3, 0xf5c453];

// ---------------- renderer / scene ----------------
const OFF = new Set((new URLSearchParams(location.search).get('off') || '').split(',')); // dev: ?off=ground,trees,nodes,deco,bld,units switches single 3D parts off
let packFailed = null; // set when the 3D pack does not load: the broadcast page then refuses to render (render/broadcast.mjs setup)
const packLoaded = USE_3D ? await new Pack().init().catch((e) => { packFailed = String((e && e.message) || e); console.warn('3D asset pack not available, using classic models', e); return null; }) : null;
const pack3d = OFF.has('pack') ? null : packLoaded;
// the theme of the match: a test theme of the hooks (?theme=arc-gunner-placeholder), else the one the pack loader read (?theme=<id>-vN). undefined = classic: every theme hook below is skipped and the picture stays as it was
const THEME = themeById(params.get('theme')) || (pack3d && pack3d.theme && !pack3d.theme.isClassic ? pack3d.theme : undefined);
const SHOOTERS = new ShooterTable(THEME);
const SHOTFX = new ShotFx(SHOOTERS);
const FXT = resolveFxTheme(THEME); // { themed, pal, fuse, blast }; without a theme (or without `effects`) the palette is the old literals and fuse / blast are null
const canvas = $('#view');
// Low-power viewer: only for the live and replay page (not broadcast, not ?capture). The final pass is a full-screen quad, so canvas MSAA is wasted there.
const PERF_ON = !BC && !params.has('capture');
const store = () => { try { return window.localStorage; } catch { return null; } }; // storage may be blocked
const perf = PERF_ON ? new ViewerPerf({ mode: params.has('quality') ? 'high' : (loadQuality(store())?.mode || 'auto'), deviceDpr: window.devicePixelRatio || 1 }) : null; // ?quality= is the escape hatch: today's look (pixel ratio 2, no lowpower), the stored choice stays
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !PERF_ON || params.get('quality') === 'off', powerPreference: 'high-performance', preserveDrawingBuffer: params.has('capture') });
renderer.setPixelRatio(perf ? perf.dpr : Math.min(window.devicePixelRatio || 1, params.has('capture') ? 1 : 2));
// ---- LIGHT + POST HOOK (render/post.mjs owns renderer tone mapping, scene sky/fog, lights, shadow fitting and the post chain) ----
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 1, 900);
if (pack3d) pack3d.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
const post = createPost({ renderer, scene, camera, preset: params.get('quality') || (BC ? 'broadcast' : 'live') });
const sun = post.sun;
// ---- /LIGHT + POST HOOK ----

const hud = BC ? NO_HUD : new Hud({
  onSpeed: (x) => fetch(x === 'pause' ? '/api/pause' : `/api/speed?x=${x}`),
  onMinimap: (u, v) => { if (!G) return; cam.mode = 'free'; cam.tx = u * G.size; cam.tz = v * G.size; },
});

const god = BC ? null : new God({
  pick: (cx, cy) => pick(cx, cy),
  setFog: (p) => setFog(p),
  onSpeed: (x) => fetch(x === 'pause' ? '/api/pause' : `/api/speed?x=${x}`),
});
let godWorld = null;
let shrines = null;
let worldFx = null; // weather, bubbles, fish (render/world-fx.mjs)
const audio = BC ? null : new AudioEngine(); // SOUND
if (audio) mountAudioUI(audio, $('#sound'));
// QUALITY toggle (#perf, key L): Auto = frame cap + adaptive pixel ratio + lowpower CSS, High = pixel ratio 2 fixed. Shift+L: fps readout. See render/perf.mjs.
let perfUI = null;
function setDpr(d) { if (renderer.getPixelRatio() !== d) { renderer.setPixelRatio(d); resize(); } }
if (perf) {
  document.body.classList.toggle('lowpower', perf.lowpower);
  perfUI = mountPerfUI($('#perf'), {
    mode: perf.mode, fps: !!loadQuality(store())?.fps,
    onChange: (ui) => {
      const changed = ui.mode !== perf.mode;
      if (changed) { perf.setMode(ui.mode); document.body.classList.toggle('lowpower', perf.lowpower); setDpr(perf.dpr); }
      saveQuality(store(), { mode: changed || !params.has('quality') ? ui.mode : (loadQuality(store())?.mode || 'auto'), fps: ui.fps }); // with ?quality= a switch of the fps readout must not store the forced mode
    },
  });
}

// ---------------- state ----------------
let G = null; // init message + derived data
let cur = null, prev = null, curRecv = 0, gap = 100;
let curUnits = new Map(), prevUnits = new Map();
let gameSpeed = 1;
let markers = null;
// Smooth unit motion: positions are interpolated on a render clock measured in sim ticks (dispT), that runs a little behind the newest
// snapshot (a buffer of about 1.5 ticks) and is gently steered toward it. Snapshot arrival jitter and repeated snapshots never show as stutter.
const hist = [];
let dispT = null;
const world = { bld3d: null, nodes3d: null, deco3d: null, ground: null, units: {}, ring: null, carry: null, hpBg: null, hpFg: null, buildings: new Map(), nodes: new Map(), trees: null, proj: null, fx: null };
const ustate = new Map(); // per unit anim state
const teamMats = [];
const bMats = { body: null, team: [] }; // ANIM: building materials with sail/flag/forge motion
let fog = null; // {tex, data, p}
let fogOn = false;
// what the other side owns and cannot be seen is hidden once the veil is this far in (on the way out it comes back at once, while the veil is still dark): nothing pops out in the open
const FOG_HIDE_AT = 0.85;
let lastMk = [], marksOff = false; // markers of the last snapshot, and the wish of the broadcast page to show none
const applyMarkers = () => { if (markers && !params.has('nomarkers')) markers.set(shownMarkers(lastMk, fogOn && fog ? fog.p : 0, marksOff)); };
const dummy = new THREE.Object3D();
const tmpC = new THREE.Color();
// colour of an owner: one cached Color per player in the viewer, instead of parsing '#rrggbb' for every unit in every frame (the broadcast keeps the parse)
let ownerCol = null; // per owner, lazy: owner 0 (the wolves) is G.players[-1], which a .map() would drop
const pcol = (owner) => BC ? tmpC.set(G.players[owner - 1].color) : (ownerCol || (ownerCol = ownerColorCache(G.players, (c) => new THREE.Color(c))))(owner);
const qStamp = () => BC ? 0 : performance.now(); // when a death or javelin was queued (0 in the frame-exact broadcast: no wall clock there)

const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 });
const mkTeamMat = (hex) => new THREE.MeshStandardMaterial({ color: hex, vertexColors: true, roughness: 0.65, metalness: 0.05 });

// ---------------- camera ----------------
const cam = { tx: 64, ty: 0, tz: 64, dist: 190, az: -Math.PI / 4, pol: 0.95, mode: 'auto', baseAz: -Math.PI / 4 };
const camS = { tx: 64, ty: 0, tz: 64, dist: 190, az: -Math.PI / 4, pol: 0.95 };
// CAMERA: both rigs share the ground-clearance clamp. rigSafe is the broadcast/manual one, autoRig drives the spectator auto camera.
let rigSafe = null, autoRig = null;
const VAR_ON = variantsOn(params);
const vOf = (id) => (VAR_ON ? variant(id) : NEUTRAL);
const riderScale = (name, id) => UNIT_SCALE * 0.95 * RIG_K * unitMul(name) * vOf(id).s; // size of a rigged rider on screen (the same numbers as its instance matrix below); the hoof sounds use it too
const shake = new CamShake(); // SHAKE: big collapses shake the camera (render/camshake.mjs); ?shake=0 switches it off
shake.on = params.get('shake') !== '0';
let shakeT = 0; // output time of the current frame (live: wall clock, broadcast: animT), set before applyCamera
function applyCamera(dt, snap) {
  const k = snap ? 1 : 1 - Math.exp(-dt * 2.4);
  for (const key of ['tx', 'ty', 'tz', 'dist', 'az', 'pol']) camS[key] += (cam[key] - camS[key]) * k;
  const o = rigSafe ? rigSafe.safe(camS) : camS; // never below the terrain, never pointing outside the map
  const sp = Math.sin(o.pol), cp = Math.cos(o.pol);
  const sk = shake.offset(shakeT, o.tx, o.tz, o.dist);
  camera.position.set(o.tx + o.dist * sp * Math.sin(o.az) + sk.x, o.ty + o.dist * cp + sk.y, o.tz + o.dist * sp * Math.cos(o.az) + sk.z);
  camera.lookAt(o.tx + sk.x * 0.35, o.ty + sk.y * 0.35, o.tz + sk.z * 0.35);
  post.cam = o; // LIGHT+POST: shadow fitting and tilt-shift focus read the final camera state (render/post.mjs)
}
function fitDist(w, d) {
  const vf = (camera.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  return Math.max(w / (2 * Math.tan(hf / 2)), (d * Math.sin(cam.pol) + 6) / (2 * Math.tan(vf / 2)));
}
// CAMERA: live auto camera (C). Battle = low-angle sweep around the fight, >= 8x or quiet = high overview, tier-up = short
// medium shot on the town centre, destroyed town centre = push-in then rising pull-back. Same rig as the broadcast.
const autoSt = { fightUntil: 0, fight: null, tier: null, fall: null, wasAuto: false, quietT: 0 };

function camEvents(s) {
  if (BC || !G) return;
  const now = performance.now() / 1000;
  for (const e of s.ev || []) if (e.k === 'tier' && e.tier >= 2) {
    const st = G.starts[e.p - 1];
    if (st) autoSt.tier = { x: st.tx, z: st.ty, t0: now, key: `t${e.p}-${e.tier}` };
  }
  for (const d of s.dead) if (d[0] === 2 && d[2] === 'town_center') autoSt.fall = { x: d[3] + d[5] / 2, z: d[4] + d[5] / 2, t0: now, key: `f${d[3]}-${d[4]}` };
}
function director(dt) {
  if (cam.mode !== 'auto' || !cur) { autoSt.wasAuto = false; return; }
  const now = performance.now() / 1000;
  if (!autoRig) autoRig = new Cinema({ size: G.size, aspect: camera.aspect, heightAt: TERRAIN.heightAt, fov: camera.fov });
  autoRig.aspect = camera.aspect;
  if (!autoSt.wasAuto) { Object.assign(autoRig.s, camS); for (const k in autoRig.v) autoRig.v[k] = 0; autoRig.init = true; autoSt.wasAuto = true; }
  const A = autoSt;
  let shot = null;
  if (finale && finaleE !== null) shot = finaleShot(finale, finaleE);
  else if (A.fall && now - A.fall.t0 < 8) {
    const e = now - A.fall.t0;
    shot = { kind: 'collapse', key: A.fall.key, x: A.fall.x, z: A.fall.z, push: 0.7 + e * 0.15, pull: (e - 2) / 4.5 };
  } else {
    const pts = [];
    for (const u of cur.units) if (u[6] === 4) pts.push([u[3], u[4]]);
    const cl = pts.length >= 3 ? cluster(pts) : null;
    if (cl) { A.fight = { x: cl.x, z: cl.z, r: cl.r }; A.fightUntil = now + 3; } // hold the fight shot through short pauses
    if (A.fight && now < A.fightUntil) shot = { kind: 'battle', key: 'fight', ...A.fight };
    else if (A.tier && now - A.tier.t0 < 3.4) shot = { kind: 'tier', key: A.tier.key, x: A.tier.x, z: A.tier.z };
    else if ((cur.speed || 1) >= 8) shot = { kind: 'overview', key: 'ov', ...overviewBox(cur, G.starts) };
    else {
      // quiet at low speed: overview, base 1, overview, last base ...
      const k = Math.floor(now / 7) % 4, st = G.starts[k === 1 ? 0 : G.starts.length - 1];
      shot = k % 2 === 0 ? { kind: 'overview', key: `ov${k}`, ...overviewBox(cur, G.starts) } : { kind: 'base', key: `base${k}`, x: st.tx, z: st.ty };
    }
  }
  const c = autoRig.update(Math.min(dt, 0.1), shot, now);
  Object.assign(camS, c); Object.assign(cam, c); // the rig already glides, so the extra smoothing is bypassed
}

// input
let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; drag = { x: e.clientX, y: e.clientY, btn: e.button, shift: e.shiftKey }; canvas.setPointerCapture(e.pointerId); });
let downAt = null;
canvas.addEventListener('pointerup', (e) => {
  // God mode tool armed: a click (not a drag) on the map acts
  if (god && god.armed && downAt && e.button === 0 && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) god.mapClick(pick(e.clientX, e.clientY));
  drag = null; downAt = null;
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  cam.mode = 'free';
  if (drag.btn === 2 || drag.shift) {
    cam.az = clamp(cam.az - dx * 0.005, cam.baseAz - 1.2, cam.baseAz + 1.2);
    cam.pol = clamp(cam.pol - dy * 0.004, 0.55, 1.15);
  } else {
    const s = camS.dist * 0.0018, ca = Math.cos(cam.az), sa = Math.sin(cam.az);
    cam.tx -= (dx * ca + dy * sa * 1.4) * s; cam.tz -= (-dx * sa + dy * ca * 1.4) * s;
    clampTarget();
  }
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.mode = 'free'; cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 22, 260); }, { passive: false });
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return; // typing in the God panel
  if (god && e.key.toLowerCase() !== 'g' && god.key(e)) { e.preventDefault(); return; } // panel hotkeys win over camera keys while it is open
  keys.add(e.key.toLowerCase());
  const k = e.key.toLowerCase();
  if (k === 'g' && god) god.toggle();
  else if (k === 'escape' && god) god.disarm();
  else if (k === ' ') { e.preventDefault(); fetch('/api/pause'); }
  else if (k === 'c') cam.mode = 'auto';
  else if (k === 'h') $('#hud').classList.toggle('hidden');
  else if (k === 'm' && audio) audio.toggleMute();
  else if (k === 'l' && perfUI && !e.metaKey && !e.ctrlKey) perfUI.toggle(e.shiftKey);
  else if (k === 'f') toggleFog();
  else if (k === 's') { renderer.shadowMap.enabled = !renderer.shadowMap.enabled; scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); }
  else if ('1234'.includes(k) && k) fetch(`/api/speed?x=${[1, 2, 4, 8][+k - 1]}`);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear()); // a keyup is lost on Cmd+key or alt-tab; a stuck key would keep the idle cap off
function clampTarget() { if (!G) return; cam.tx = clamp(cam.tx, 0, G.size); cam.tz = clamp(cam.tz, 0, G.size); }
function keyPan(dt) {
  let mx = 0, mz = 0, rot = 0;
  if (keys.has('w') || keys.has('arrowup')) mz -= 1;
  if (keys.has('s') && !keys.has('control')) mz += 0;
  if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
  if (keys.has('d') || keys.has('arrowright')) mx += 1;
  if (keys.has('arrowdown')) mz += 1;
  if (keys.has('q')) rot -= 1;
  if (keys.has('e')) rot += 1;
  if (mx || mz || rot) {
    cam.mode = 'free';
    const s = camS.dist * dt * 0.7, ca = Math.cos(cam.az), sa = Math.sin(cam.az);
    cam.tx += (mx * ca + mz * sa) * s; cam.tz += (-mx * sa + mz * ca) * s;
    cam.az = clamp(cam.az + rot * dt * 0.9, cam.baseAz - 1.2, cam.baseAz + 1.2);
    clampTarget();
  }
}

function resize() {
  const w = BC ? canvas.clientWidth : window.innerWidth, h = BC ? canvas.clientHeight : window.innerHeight;
  renderer.setSize(w, h, false);
  post.resize(); // LIGHT+POST
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------- world construction ----------------
function instanced(geo, mat, cap, shadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, cap);
  m.count = 0;
  m.frustumCulled = false;
  m.castShadow = shadow;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return m;
}

function buildWorld(init) {
  G = init;
  G.players[-1] = { name: 'The wolves', color: '#9aa0a8', model: '', hw: '' }; // owner 0 = wild units of a God mode event
  G.type = {};
  const rows = init.terrain;
  world.ground = pack3d && !OFF.has('ground') ? loadGround(pack3d, pack3d.maxAniso, init.mapType) : null;
  const bio = biomeOf(init.mapType, THEME); G.bio = bio; // THEME: the ground and light slots of the theme colour the biome (render/theme/ground-theme.mjs); undefined = classic, the same object as before
  const t = buildTerrain(init.size, rows, { seed: init.seed, nodes: init.nodes, starts: init.starts, ground: world.ground, biome: bio }); // TERRAIN hook
  world.walk = { rows, size: init.size, occ: t.occ };
  scene.add(t.mesh, t.water);
  G.tmesh = t;
  // apron: ground around the map block (same tone as the grass, fogged into the haze), so overview and pull-back never show a dark edge
  {
    const n = init.size, R = 1400, sh = new THREE.Shape();
    sh.moveTo(-R, -(n + R)); sh.lineTo(n + R, -(n + R)); sh.lineTo(n + R, R); sh.lineTo(-R, R); sh.closePath();
    const hole = new THREE.Path();
    hole.moveTo(0, -n); hole.lineTo(0, 0); hole.lineTo(n, 0); hole.lineTo(n, -n); hole.closePath();
    sh.holes.push(hole);
    const ap = new THREE.Mesh(new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x86a554, roughness: 1, metalness: 0 }));
    ap.position.y = -0.1; ap.receiveShadow = true; ap.userData.noAO = true;
    post.setBiome(bio);
    t.nearTrees = !!pack3d && !OFF.has('trees');
    if (!post.setFarField(init.size, init.seed | 0, t)) scene.add(ap); // LIGHT+POST: rolling far-field hills (render/post.mjs) replace the flat apron
  }
  ANIM.animateWater(t.water); // ANIM: vertex waves, glints, lapping foam
  if (pack3d) {
    const none = { update() {}, set() {}, remove() {}, ready: Promise.resolve() };
    world.trees = OFF.has('trees') ? { ...none, remove() {} } : buildForest(scene, pack3d, init.size, rows, init.seed | 0, init.mapType || 'meadow', { dust: (x, y, z, s) => { if (fx && fx.load < 0.85) fx.dust(x, y, z, s, 1.3); } }); // dust puff where a felled tree lands
    for (const i of init.fells || []) { treeGone.add(i); if (world.trees.remove) world.trees.remove(i); } // cut before this viewer joined: stumps at once
    world.farTrees = !OFF.has('trees') && post.farHeight ? buildFarForest(scene, pack3d, init.size, init.seed | 0, init.mapType || 'meadow', post.farHeight, 50, world.trees.placed || []) : null;
    world.farTrees2 = !OFF.has('trees') && post.farHeight ? buildFarTrees(scene, pack3d, init.size, init.seed | 0, init.mapType || 'meadow', post.farHeight, [...(world.trees.placed || []), ...(world.farTrees?.placed || [])], post.LOOK.sunDir) : null;
    world.nodes3d = OFF.has('nodes') ? none : buildNodes(scene, pack3d, init.nodes, { rows, size: init.size, dust: (x, y, z, s) => { if (fx && fx.load < 0.85) fx.dust(x, y, z, s, 1.3); }, cry: (id, x, z) => { if (audio) audio.cry('death_animal', x, z, id); } });
    world.herd = world.nodes3d.herd || null; // living deer (render/herd.mjs)
    world.deco3d = OFF.has('deco') ? none : buildDeco3D(scene, pack3d, init.size, rows, init.starts, t, bio);
    if (world.herd) world.herd.setBlockers([...(world.deco3d.blockers || []), ...(world.trees.placed || []).map((q) => ({ x: q[0], z: q[1], r: 0.3 }))], t.occ); // the deer keep clear of rocks, bushes, trees and buildings
    world.nodeMax = new Map(init.nodes.map((n) => [n[0], n[6] || n[5]])); // n[6]: the full amount (n[5] is what is left when this viewer joins late)
  } else {
    world.trees = buildTrees(init.size, rows);
    scene.add(world.trees.trunk, world.trees.leaves);
    // ANIM: trees and grass sway in the wind (deco: tufts, flowers, bushes get their own material copy)
    ANIM.swayMaterial(world.trees.trunk.material, 0.5); ANIM.swayMaterial(world.trees.leaves.material, 1.0);
  }
  // 3D pack: bushes and boulders come from the models (props3d); tufts, flower dots and pebbles stay procedural
  buildDeco(init.size, rows, pack3d ? (pack3d.map.deco.bush.length ? ['bush', 'rock'] : ['rock']) : []).forEach((d) => { const k = d.userData.kind; if (k === 'tuft' || k === 'flower' || k === 'bush') d.material = ANIM.swayMaterial(d.material, k === 'tuft' ? 1.6 : k === 'flower' ? 1.2 : 0.5, true); scene.add(d); });
  if (pack3d) {
    world.bld3d = OFF.has('bld') ? null : new Bld3D(pack3d, init.players.map((p) => p.color));
    if (world.bld3d) world.bld3d.crossfade = BC;
    world.modelsReady = Promise.all([world.ground && world.ground.ready, world.trees.ready, world.farTrees ? world.farTrees.ready : null, world.farTrees2 ? world.farTrees2.ready : null, world.nodes3d.ready, world.deco3d.ready, (OFF.has('preload') ? null : pack3d.loadAll(BC ? pack3d.allBuildingIds() : Object.keys(pack3d.map.buildings).map((n) => pack3d.buildingVariant(n, 1))))]);
  }
  init.players.forEach((p) => teamMats.push(mkTeamMat(new THREE.Color(p.color))));
  // unit instanced meshes
  // ANIM: rigged unit materials (vertex-shader legs, arms, weapons per instance attribute iAnim) + building materials
  bMats.body = ANIM.buildingMaterial(bodyMat); bMats.team = teamMats.map((tm) => ANIM.buildingMaterial(tm));
  const unitDepth = ANIM.unitDepthMaterial();
  init.units.forEach((name, idx) => {
    const m = unitModel(name);
    const anim = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    m.body.setAttribute('iAnim', anim); m.team.setAttribute('iAnim', anim);
    const body = instanced(m.body, ANIM.unitMaterial(bodyMat), CAP), team = instanced(m.team, ANIM.unitMaterial(teamMats[0]), CAP);
    team.material.color.set(0xffffff);
    team.material.vertexColors = true;
    body.customDepthMaterial = team.customDepthMaterial = unitDepth;
    scene.add(body, team);
    world.units[idx] = { name, body, team, list: [], anim };
    // 3D pack: siege units without leg animation use the new static models (wheels stay still; the attack motion is a stronger body lunge)
    const sg00 = pack3d && !OFF.has('units') && pack3d.map.units && pack3d.map.units[name];
    let ts = pack3d && !OFF.has('units') ? themedStaticUnit(pack3d, name, sg00 || (STATIC_RIDERS.includes(name) ? { lunge: 1, lean: 1 } : null)) : null;
    if (ts && !sg00) (world.staticRiders ||= new Set()).add(name); // a theme rider as one rigid model: no rig for it
    const sg0 = sg00 || (ts ? ts.sg : null); // theme: the caravan with the model of the theme (null = classic: the table entry below, as always)
    if (sg0) (world.siegeReady ||= []).push((ts ? ts.pack.load(ts.sg.model).then((m) => m || ((ts = null), pack3d.load(sg0.model))) : pack3d.load(sg0.model)).then((mdl) => { // (a theme file that does not load: the classic entry)
      const sg = ts ? ts.sg : sg0;
      if (!mdl) { world.siegeFailed = (world.siegeFailed ? world.siegeFailed + ',' : '') + name; return; } // the procedural figure of this siege unit would stay
      const bp = mdl.parts.find((q) => !q.team), tp = mdl.parts.find((q) => q.team);
      const g = world.units[idx];
      if (sg.rotY && !bp.geo.userData.rotated) { bp.geo.rotateY(sg.rotY); if (tp) tp.geo.rotateY(sg.rotY); bp.geo.userData.rotated = true; } // ships and the caravan: the model's bow / horse points along +x (or -x), rotY turns it to +z
      const sk = ts ? ts.fit() : sg.scale; // theme model: fitted to the length of the classic model (render/theme/nature-theme.mjs STATIC_UNIT_FOOT)
      if (sk && !bp.geo.userData.scaled) { bp.geo.scale(sk, sk, sk); if (tp) tp.geo.scale(sk, sk, sk); bp.geo.userData.scaled = true; } // ships: drawn at a smaller scale than the art file
      g.body.geometry = bp.geo; g.body.material = ANIM.unitMaterial(bp.mat);
      if (tp) { g.team.geometry = tp.geo; g.team.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0.05 }); }
      else g.team.visible = false; // a model without a team part (the catapult): the procedural team piece (the bucket on the arm) would float next to it as a coloured box, so draw nothing (no geometry clone: its uuid would draw from Math.random and shift the particle stream of the classic stills)
      g.lunge = sg.lunge || 1; g.lean = sg.lean || 1;
    }));
  });
  // rigged 3D units (render/units3d.mjs): skinned instanced meshes; units without a model keep the procedural figure above
  if (pack3d && USE_UNITS3D && !OFF.has('rig')) {
    const u3 = new Units3D(scene);
    if (world.staticRiders) u3.noRig = world.staticRiders; // riders of the theme drawn as one model (nature.objects): not rigged
    world.u3Ready = u3.init().then(() => { u3.applyTheme(THEME); return Promise.all(init.units.filter((n) => u3.has(n)).map((n) => u3.loadUnit(n))); }).then(() => { world.u3 = u3; }).catch((e) => { world.u3Failed = String((e && e.message) || e); console.warn('rigged units not available, classic figures stay', e); }); // u3Failed: the broadcast page refuses to render with the old figures (render/broadcast.mjs setup)
  }
  // creator banners (cosmetic): atlas + cloth + poles; bearers borrow the swordsman rig
  world.banners = new Banners(scene, init, { renderer, heightAt });
  world.bearerIdx = init.units.indexOf('swordsman');
  // ANIM: resource node lookup for the workers' gather poses
  for (const [id, res, tx, ty, size] of init.nodes) for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) nodeGrid.set((ty + j) * init.size + tx + i, { id, res, size, cx: tx + size / 2, cz: ty + size / 2 });
  world.ring = instanced(new THREE.RingGeometry(0.34, 0.46, 20).rotateX(-Math.PI / 2).translate(0, 0.04, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }), 1400, false);
  world.ring.renderOrder = 2;
  world.carry = instanced(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshStandardMaterial({ roughness: 0.7 }), CAP);
  // carried goods (art-v2 models 199-202, MAP.json `carry`): the worker holds the real sack / logs / ore / stones in front of the chest; the cube stays as the fallback
  world.carryM = {};
  if (pack3d && pack3d.map.carry && !OFF.has('carry')) for (const [res, id] of Object.entries(pack3d.map.carry)) {
    pack3d.load(id).then((mdl) => {
      if (!mdl) return;
      const meshes = mdl.parts.map((p) => { const mm = instanced(p.geo, p.mat ? ANIM.unitMaterial(p.mat) : new THREE.MeshStandardMaterial({ color: 0xe6dcc8, roughness: 0.8 }), CAP); mm.receiveShadow = false; scene.add(mm); return mm; });
      world.carryM[res] = { meshes, n: 0 };
    });
  }
  const bar = new THREE.PlaneGeometry(1, 1);
  world.hpBg = instanced(bar, new THREE.MeshBasicMaterial({ color: 0x05070a, transparent: true, opacity: 0.8, depthTest: false }), 1400, false);
  world.hpFg = instanced(bar, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false }), 1400, false);
  world.hpBg.renderOrder = 10; world.hpFg.renderOrder = 11;
  world.proj = instanced(arrowGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x222222 }), 400, false);
  world.proj.userData.bloom = true; // LIGHT+POST: arrows and bolts glow
  if (SHOOTERS.hasProjectile) { // theme: the glowing bolt mesh (only built when a theme has a projectile slot)
    world.projT = instanced(boltGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }), 400, false);
    world.projT.userData.bloom = true;
    scene.add(world.projT);
  }
  SHOTFX.build(world, scene, pack3d && pack3d.loader); // theme: loads the projectile meshes (shape 'mesh'); a file that is missing or fails = the bolt above
  world.shell = instanced(shellGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.15, flatShading: true }), 120, true); // stones, mortar shells, cannon balls
  // thrown javelins of the skirmishers (renderJavelins): shaft + leaf head, colours of the javelin in the hand of the model, origin = the grip point
  world.jav = {
    shaft: instanced(new THREE.CylinderGeometry(0.02, 0.028, 1.28, 6).rotateX(Math.PI / 2).translate(0, 0, 0.36), new THREE.MeshStandardMaterial({ color: 0x8a5a2e, roughness: 0.8 }), 160, false),
    head: instanced(new THREE.ConeGeometry(0.075, 0.34, 4).rotateX(Math.PI / 2).scale(1, 0.35, 1).translate(0, 0, 1.17), new THREE.MeshStandardMaterial({ color: 0xaeb4bd, roughness: 0.45, metalness: 0.5 }), 160, false),
  };
  scene.add(world.ring, world.carry, world.hpBg, world.hpFg, world.proj, world.shell, world.jav.shaft, world.jav.head);
  // resource nodes
  const kinds = {};
  for (const [id, res, tx, ty, size, amt] of init.nodes) {
    if (!kinds[res]) kinds[res] = [];
    kinds[res].push({ id, tx, ty, size, amt });
  }
  for (const [res, list] of Object.entries(kinds)) {
    if (pack3d) break; // the 3D pack draws the nodes (props3d.buildNodes)
    const m = nodeModel(res, 2);
    const accentMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: res === 'gold' ? 0.25 : 0.8, metalness: res === 'gold' ? 0.6 : 0, color: res === 'gold' ? 0xf5c453 : 0xffffff, emissive: res === 'gold' ? 0x4a3300 : 0x000000 });
    const body = new THREE.InstancedMesh(m.body, bodyMat, list.length), acc = new THREE.InstancedMesh(m.accent, accentMat, list.length);
    body.castShadow = acc.castShadow = true;
    list.forEach((n, i) => {
      dummy.position.set(n.tx + n.size / 2, heightAt(n.tx + n.size / 2, n.ty + n.size / 2), n.ty + n.size / 2); // TERRAIN hook: seat on ground
      dummy.rotation.set(0, ((n.id * 97) % 628) / 100, 0);
      const s = res === 'berries' || res === 'herd' ? 1 : 1.1;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix); acc.setMatrixAt(i, dummy.matrix);
      n.i = i; n.base = dummy.matrix.clone(); n.max = n.amt;
      world.nodes.set(n.id, { n, body, acc });
    });
    scene.add(body, acc);
  }
  // minimap base
  buildMinimapBase();
  hud.init(init);
  if (god) god.init(init);
  godWorld = new GodWorld({ THREE, scene, hAt: heightAt });
  shrines = pack3d ? new Shrines(scene, pack3d, (t) => init.players.find((q) => q.team === t)?.color ?? '#ffffff', heightAt) : null;
  // camera start
  rigSafe = new Cinema({ size: init.size, aspect: 1, heightAt: TERRAIN.heightAt }); // CAMERA: ground clearance
  cam.baseAz = cam.az = camS.az = -Math.PI / 4;
  camS.tx = cam.tx = init.size / 2; camS.tz = cam.tz = init.size / 2;
  camS.dist = cam.dist = 190;
  worldFx = new WorldFx({ scene, camera, post, init, heightAt, bc: BC, theme: pack3d && pack3d.theme }); // theme: weather colours (classic theme or no pack: the classic looks)
  worldFx.onStrike = (strong, n) => { if (audio) audio.thunder(strong, n); }; // SOUND: thunder after the flash
}

// ---------------- minimap ----------------
let miniBase = null;
const mini = BC ? null : $('#minimap'), mctx = mini ? mini.getContext('2d') : null;
function buildMinimapBase() {
  const n = G.size, c = document.createElement('canvas');
  c.width = c.height = 200;
  const x = c.getContext('2d');
  const colors = { '.': '#3e6f38', f: '#24512b', '~': '#1d4e70', '#': '#6b7383' };
  const s = 200 / n;
  for (let y = 0; y < n; y++) for (let i = 0; i < n; i++) { const [r, g, b] = G.tmesh.miniRGB(i, y); x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(i * s, y * s, s + 0.6, s + 0.6); } // TERRAIN hook: shaded minimap colours
  for (const nd of G.nodes) { x.fillStyle = nd[1] === 'gold' ? '#f5c453' : nd[1] === 'stone' ? '#cfd5df' : nd[1] === 'berries' ? '#e0476a' : '#d8b98a'; x.fillRect(nd[2] * s, nd[3] * s, 2.6, 2.6); }
  miniBase = c;
}
const ray = new THREE.Raycaster(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
function drawMinimap() {
  if (!mini || !miniBase || !cur) return;
  const s = 200 / G.size;
  mctx.drawImage(miniBase, 0, 0);
  if (fogOn && fog) mctx.drawImage(fog.mini, 0, 0, 200, 200);
  for (const b of cur.buildings) { mctx.fillStyle = G.players[b[1] - 1].color; mctx.fillRect(b[3] * s - 1, b[4] * s - 1, G.buildingDefs[G.buildings[b[2]]].size * s + 2, G.buildingDefs[G.buildings[b[2]]].size * s + 2); }
  for (const u of cur.units) { if (fogHidden(u)) continue; mctx.fillStyle = G.players[u[1] - 1].color; mctx.fillRect(u[3] * s - 1, u[4] * s - 1, 2.4, 2.4); }
  // camera footprint
  mctx.strokeStyle = 'rgba(255,255,255,0.9)'; mctx.lineWidth = 1.2; mctx.beginPath();
  let ok = true;
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([x, y], i) => {
    ray.setFromCamera({ x, y }, camera);
    if (!ray.ray.intersectPlane(groundPlane, hit)) { ok = false; return; }
    const px = clamp(hit.x, -400, G.size + 400) * s, py = clamp(hit.z, -400, G.size + 400) * s;
    if (i === 0) mctx.moveTo(px, py); else mctx.lineTo(px, py);
  });
  if (ok) { mctx.closePath(); mctx.stroke(); }
}

// ---------------- fog of war (optional spectator toggle) ----------------
function toggleFog() { setFog(fogOn ? 0 : 1); }
// spectator view only: p = 0 everything visible, p = n the fog of player n (the players themselves are not affected)
function setFog(p) {
  fogOn = p > 0;
  fetch(`/api/fog?p=${p}`);
  if (fog) fog.mesh.visible = fogOn;
}
// map click -> { tile, unitId, buildingId } (ground point under the cursor, nearest unit in screen space)
const _pv = new THREE.Vector3();
function pick(cx, cy) {
  if (!G) return null;
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera({ x: ((cx - r.left) / r.width) * 2 - 1, y: -((cy - r.top) / r.height) * 2 + 1 }, camera);
  let y = 0;
  const p = new THREE.Vector3();
  for (let i = 0; i < 3; i++) {
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p)) return null;
    y = heightAt(p.x, p.z);
  }
  const tile = [clamp(Math.floor(p.x), 0, G.size - 1), clamp(Math.floor(p.z), 0, G.size - 1)];
  let unitId = 0, bd = 30 * 30;
  for (const [id, u] of curUnits) {
    if (fogHidden(u)) continue;
    _pv.set(u[3], heightAt(u[3], u[4]) + 0.8, u[4]).project(camera);
    const sx = (_pv.x * 0.5 + 0.5) * r.width + r.left, sy = (-_pv.y * 0.5 + 0.5) * r.height + r.top;
    const d = (sx - cx) ** 2 + (sy - cy) ** 2;
    if (_pv.z < 1 && d < bd) { bd = d; unitId = id; }
  }
  let buildingId = 0;
  if (cur) for (const b of cur.buildings) {
    const sz = G.buildingDefs[G.buildings[b[2]]].size;
    if (p.x >= b[3] && p.x < b[3] + sz && p.z >= b[4] && p.z < b[4] + sz) { buildingId = b[0]; break; }
  }
  return { tile, unitId, buildingId };
}
function applyFog(msg) {
  const n = G.size;
  const raw = Uint8Array.from(atob(msg.d), (c) => c.charCodeAt(0));
  if (!fog) {
    const data = new Uint8Array(n * n * 4);
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    // broadcast: the dark tint is an sRGB colour. Read as linear it came out as a light grey-blue, and the unknown ground showed through at about 60 % of its brightness
    if (BC) tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(n, n).rotateX(-Math.PI / 2).translate(n / 2, 3.6, n / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.renderOrder = 5;
    scene.add(mesh);
    const mc = document.createElement('canvas'); mc.width = mc.height = n;
    fog = { tex, data, mesh, vis: raw, mini: mc, p: msg.p };
  }
  fog.vis = raw; fog.p = msg.p;
  const d = fog.data, FA = BC ? FOG_ALPHA_BROADCAST : FOG_ALPHA;
  for (let i = 0; i < raw.length; i++) {
    const o = ((n - 1 - Math.floor(i / n)) * n + (i % n)) * 4; // texture rows run bottom-up
    d[o] = FOG_TINT[0]; d[o + 1] = FOG_TINT[1]; d[o + 2] = FOG_TINT[2]; d[o + 3] = raw[i] === 2 ? FA.visible : raw[i] === 1 ? FA.seen : FA.unknown;
  }
  fog.tex.needsUpdate = true;
  const mx = fog.mini.getContext('2d'), im = mx.createImageData(G.size, G.size);
  for (let i = 0; i < raw.length; i++) { im.data[i * 4] = 6; im.data[i * 4 + 1] = 9; im.data[i * 4 + 2] = 14; im.data[i * 4 + 3] = raw[i] === 2 ? 0 : raw[i] === 1 ? 110 : 220; }
  mx.putImageData(im, 0, 0);
  fog.mesh.visible = fogOn;
}
function fogHidden(u) {
  if (!fogOn || !fog || u[1] === fog.p) return false;
  return fog.vis[Math.floor(u[4]) * G.size + Math.floor(u[3])] !== 2;
}
// broadcast: a building of the other side on ground this player has never seen is not drawn. The veil lies low, so a roof or a flag that is taller than it
// stood out of the dark and showed where the enemy base is. Ground seen before keeps its buildings (the player remembers them).
function fogBldHidden(o) {
  if (!BC || !fogOn || !fog || o.owner === fog.p) return false;
  return fog.vis[Math.floor(o.ty + o.size / 2) * G.size + Math.floor(o.tx + o.size / 2)] === 0;
}

// ---------------- particles ----------------
// ANIM+FX: render/fx.mjs (soft puffs, additive glows, solid debris)
function makeFx() { const f = new Fx(scene, camera, 3200); f.groundAt = heightAt; f.pal = FXT.pal; f.soft = BC; return f; } // soft: in a video the larger shards are dust clods, not cubes (render/fx.mjs shards)
let fx = null;

// ---------------- buildings ----------------
let FORCE_TIER = +params.get('tier') || 0; // dev: ?tier=1..3 shows every building at that tier
const ownerTier = (owner) => FORCE_TIER || (cur && cur.players && cur.players[owner - 1] ? cur.players[owner - 1].tier : 1) || 1;
// walls and gates run along x unless they only have neighbours in z
let wallTiles = new Set();
function wallOrient(o) {
  if (o.name !== 'wall' && o.name !== 'gate') return 0;
  const n = G.size, w = (x, y) => wallTiles.has(y * n + x);
  const ax = w(o.tx - 1, o.ty) || w(o.tx + 1, o.ty), az = w(o.tx, o.ty - 1) || w(o.tx, o.ty + 1);
  return az && !ax ? 1 : 0;
}
function ensureBuilding(b) {
  let o = world.buildings.get(b[0]);
  if (o) return o;
  const name = G.buildings[b[2]], size = G.buildingDefs[name].size;
  const m = buildingModel(name, size);
  const grp = new THREE.Group();
  const body = new THREE.Mesh(m.body, bMats.body), team = new THREE.Mesh(m.team, bMats.team[b[1] - 1]);
  body.castShadow = team.castShadow = true; body.receiveShadow = team.receiveShadow = true;
  grp.add(body, team);
  if (world.bld3d) { body.visible = team.visible = true; }
  grp.position.set(b[3] + size / 2, heightAt(b[3] + size / 2, b[4] + size / 2), b[4] + size / 2); // TERRAIN hook: plateau height
  if (name === 'wall' || name === 'gate' || name === 'farm') grp.rotation.y = 0;
  scene.add(grp);
  m.body.computeBoundingBox(); m.team.computeBoundingBox();
  const h = Math.max(m.body.boundingBox.max.y, m.team.boundingBox.max.y, 0.6); // ANIM: building height for scaffold/flames/sinking
  o = { grp, size, name, owner: b[1], tx: b[3], ty: b[4], smoke: 0, hp: 100, h, pg: b[6] >= 100 ? 1 : 0.12 + 0.88 * (b[6] / 100), acc: Math.random(), accS: 0, accF: 0, prog: b[6], scaf: null, classic: [body, team] };
  world.buildings.set(b[0], o);
  if (world.bld3d) world.bld3d.update(o, ownerTier(b[1]), 100, wallOrient(o));
  return o;
}

// ---------------- snapshots ----------------
const evQueue = [];
let lastSnapAt = performance.now(); // viewer: when the last snapshot came in (idle detection of the frame cap)
function onSnap(s) {
  const now = performance.now();
  lastSnapAt = now;
  if (world.herd) world.herd.sync(s.t); // deer: a jump in game time (a cut, a parallel render chunk) starts their baseline again
  if (world.trees.sync) world.trees.sync(s.t); // trees: the fells of such a snapshot are stumps at once
  if (worldFx) worldFx.snap(s); // before the same-tick shortcut: chat lines arrive once
  const gseq = (x) => (x && x.god && x.god.feed.length ? x.god.feed[x.god.feed.length - 1].seq : 0);
  if (!BC && cur && s.t === cur.t && G && gseq(s) === gseq(cur)) { // same tick again (the server sends every 50 ms): only flags and HUD change
    cur.paused = s.paused; cur.speed = s.speed; gameSpeed = s.speed;
    hud.update(s);
    if (god) god.update(s, hud);
    if (s.over && !G.overShown) overSeen(s.over);
    return;
  }
  prev = cur; cur = s;
  if (audio) audio.onSnap(s); // SOUND: sounds from the snapshot stream (read only)
  if (prev) gap = clamp(now - curRecv, 25, 500);
  curRecv = now;
  prevUnits = curUnits;
  curUnits = new Map();
  for (const u of s.units) curUnits.set(u[0], u);
  // ANIM dev tool: ?stress=N shows every unit N times (jittered copies) to measure the frame rate with many units
  if (STRESS > 1) for (const u of s.units) for (let j = 1; j < STRESS; j++) { const cp = u.slice(); cp[0] = u[0] + 100000 * j; cp[3] += Math.sin(j * 2.4) * 1.5 + j * 0.1; cp[4] += Math.cos(j * 1.7) * 1.5; curUnits.set(cp[0], cp); }
  if (!BC) { hist.push({ t: s.t, units: curUnits }); while (hist.length > 10) hist.shift(); }
  // ANIM+FX: vanished units start their death animation; vanished projectiles have landed
  for (const [id, u] of prevUnits) if (!curUnits.has(id)) startDeath(id, u);
  if (fx && fx.load < 0.7) for (const [id, u] of curUnits) { // healed units: a green sparkle (hit points went up)
    const pu = prevUnits.get(id);
    if (pu && u[5] > pu[5] && !fogHidden(u)) fx.heal(u[3], hAt(u[3], u[4]) + 0.9, u[4]);
  }
  if (javOn()) for (const q of s.proj) { // thrown javelins: the sim projectile stays in the snapshot, the flying javelin is drawn by renderJavelins from the hand
    if (!isJav(q)) continue;
    const fireT = s.t - q[9] + 1, key = q[8] + ':' + fireT; // the snapshot after the firing tick already shows the shot one tick old
    const r = javs.get(key);
    if (r) { r.tx = q[2]; r.tz = q[3]; } else javs.set(key, { qAt: qStamp(), sid: q[8], fireT, spd: q[5] / 100, fx: q[0], fz: q[1], tx: q[2], tz: q[3], h: null, d0: null, n: 0 });
  }
  if (prev && fx) {
    const left = new Map();
    for (const q of s.proj) { const k = q[2] + ',' + q[3] + ',' + q[6]; left.set(k, (left.get(k) || 0) + 1); }
    for (const q of prev.proj) {
      const k = q[2] + ',' + q[3] + ',' + q[6], n = left.get(k) || 0;
      if (n > 0) left.set(k, n - 1);
      else if (q[6] === 1) { // slow heavy shells (mortar) get a fiery blast
        const th = shooterTheme(q, bIndex); // theme: the `hit` of the catapult / mortar slot comes on top of the landing (code package 2); without it the landing is the old call
        if (th && th.hit) fx.splashHit(q[2], q[3], q[5] <= 650, th.hit, ANIM.seq(q[8], s.t));
        else fx.impact(q[2], q[3], true, q[5] <= 650);
      }
      else if (!(javOn() && isJav(q))) { // (a javelin makes its own sparks where it lands)
        const th = shooterTheme(q, bIndex); // theme: sparks in its colours (bIndex still holds the buildings of the snapshot before, with the shooter)
        if (th && th.hit) fx.boltHit(q[2], hAt(q[2], q[3]) + 0.9, q[3], th.hit, ANIM.seq(q[8], s.t));
        else {
          fx.sparks(q[2], hAt(q[2], q[3]) + 0.9, q[3], 2, 1.5);
          fx.dust(q[2], hAt(q[2], q[3]) + 0.5, q[3], 0.35, 0.8);
        }
      }
    }
  }
  bIndex = new Map(s.buildings.map((b) => [b[0], b]));
  if (world.trees.cover) world.trees.cover(s.buildings.map((b) => [b[3], b[4], G.buildingDefs[G.buildings[b[2]]].size])); // stumps under buildings are not drawn
  wallTiles = new Set();
  for (const b of s.buildings) { const nm = G.buildings[b[2]]; if (nm === 'wall' || nm === 'gate') wallTiles.add(b[4] * G.size + b[3]); }
  farmList = [];
  for (const b of s.buildings) if (G.buildings[b[2]] === 'farm') { const sz = G.buildingDefs.farm.size; farmList.push([b[3] + sz / 2, b[4] + sz / 2, sz]); }
  gameSpeed = s.speed;
  camEvents(s); // CAMERA
  // deaths -> effects
  for (const d of s.dead) {
    const [kind, owner, type, x, y, size] = d;
    const color = G.players[owner - 1]?.color || '#ffffff';
    if (kind === 1) {
      if (BC) fx.softSparks(x, hAt(x, y) + 0.5, y, color, 6, 2.0, 0.3); else fx.shards(x, hAt(x, y) + 0.5, y, color, 6, 2.0, 0.11); // team-coloured shards (video: soft sparks, no cubes); the body falls (startDeath)
      fx.dust(x, hAt(x, y), y, 0.45, 1.3);
    } else if (kind === 2) {
      const cx = x + size / 2, cz = y + size / 2;
      fx.shards(cx, hAt(cx, cz) + 1.0, cz, color, 16, 4, 0.2, 1.1); // team-coloured banner scraps; sink + dust happen in the collapse (startCollapse)
      for (const [bid, o] of world.buildings) if (o.tx === x && o.ty === y) { startCollapse(bid, o, cx, cz); break; } // dead entries carry no id: match by tile
    }
  }
  // TERRAIN hook: flatten ground under new buildings, update worn paths (before ensureBuilding)
  G.tmesh.syncBuildings(s.buildings.map((b) => ({ id: b[0], owner: b[1], name: G.buildings[b[2]], tx: b[3], ty: b[4], size: G.buildingDefs[G.buildings[b[2]]].size })));
  // buildings
  const seen = new Set();
  for (const b of s.buildings) {
    seen.add(b[0]);
    const o = ensureBuilding(b);
    if (o.prog < 100 && b[6] >= 100) o.doneFlag = true; // ANIM: completion pop + dust
    o.hp = b[5]; o.prog = b[6]; o.q = b[7];
  }
  for (const [id, o] of world.buildings) if (!seen.has(id)) { scene.remove(o.grp); if (o.scaf) scene.remove(o.scaf); world.buildings.delete(id); }
  // nodes / trees
  if (s.ng) for (const id of s.ng) { nodeGone.add(id); if (world.nodes3d) world.nodes3d.remove(id); const n = world.nodes.get(id); if (n) { n.body.setMatrixAt(n.n.i, ZERO); n.acc.setMatrixAt(n.n.i, ZERO); n.body.instanceMatrix.needsUpdate = n.acc.instanceMatrix.needsUpdate = true; } }
  if (s.tg) for (const i of s.tg) { treeGone.add(i); world.trees.remove(i); }
  if (s.na) for (const [id, amt] of s.na) {
    if (world.nodes3d) { world.nodes3d.set(id, amt / (world.nodeMax.get(id) || amt || 1)); continue; }
    const n = world.nodes.get(id);
    if (!n) continue;
    const f = clamp(amt / n.n.max, 0.35, 1);
    dummy.matrix.copy(n.n.base).scale(new THREE.Vector3(1, 0.4 + 0.6 * f, 1));
    n.body.setMatrixAt(n.n.i, dummy.matrix); n.acc.setMatrixAt(n.n.i, dummy.matrix);
    n.body.instanceMatrix.needsUpdate = n.acc.instanceMatrix.needsUpdate = true;
  }
  if (s.fog) applyFog(s.fog);
  if (s.mk) { lastMk = s.mk; applyMarkers(); }
  hud.update(s);
  hud.events(s);
  if (godWorld) godWorld.update(s.god);
  if (shrines && s.vic) shrines.update(s.vic);
  if (god) god.update(s, hud);
  if (s.over && !G.overShown) overSeen(s.over);
}
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// ---------------- per-frame rendering of units ----------------
const camQ = new THREE.Quaternion();
let barN = 0;
function pushBar(x, y, z, w, hpPct) {
  if (barN >= 1400) return;
  dummy.position.set(x, y, z); dummy.quaternion.copy(camQ); dummy.scale.set(w + 0.05, 0.11, 1); dummy.updateMatrix();
  world.hpBg.setMatrixAt(barN, dummy.matrix);
  const f = clamp(hpPct / 100, 0.02, 1);
  dummy.position.set(x, y, z).addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(camQ), -(w * (1 - f)) / 2);
  dummy.scale.set(w * f, 0.07, 1); dummy.updateMatrix();
  world.hpFg.setMatrixAt(barN, dummy.matrix);
  world.hpFg.setColorAt(barN, tmpC.setHSL(0.33 * f, 0.85, 0.5));
  barN++;
}
// ANIM+FX: unit rigs, deaths, building life (scaffold, smoke, fire, collapse) and projectile trails; see render/anim.mjs and render/fx.mjs.
const VT = new THREE.Vector3();
const POSE = {}, DPOSE = {};
const shots = new Shots((x, z) => heightAt(x, z)); // flight paths of the projectiles
// theme profile (render/shooter-theme.mjs) of the shooter of projectile row q: a unit type (q[7] >= 0) or a building (q[8] = its id, looked up in `bld`, a Map id -> snapshot row); null = classic
const shooterTheme = (q, bld) => {
  if (!SHOOTERS.themed) return null;
  if (q[7] >= 0) return SHOOTERS.get(false, world.units[q[7]]?.name || '');
  const b = bld.get(q[8]);
  return b ? SHOOTERS.get(true, G.buildings[b[2]]) : null;
};
const deaths = [], collapsing = []; // unit death animations, falling buildings
const treeGone = new Set(), nodeGone = new Set();
let bIndex = new Map(), farmList = [], nodeGrid = new Map(), trailTick = 0;
const smoothS = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const hAt = (x, z) => heightAt(x, z);
const WX = { def: null, name: '', x: 0, z: 0, dtTicks: 1, tgt: null, free: null };
// walkable ground for the stand-off of fighters: land tile ('.') without a building (the same data the deer use)
WX.free = (x, z) => { const w = world.walk; if (!w) return true; const tx = Math.floor(x), tz = Math.floor(z); return tx >= 0 && tz >= 0 && tx < w.size && tz < w.size && w.rows[tz][tx] === '.' && !w.occ[tz * w.size + tx]; };
const cu = { x: 0, z: 0, st: null, c: null, time: 0 };
const scafMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
// construction marker (page parameter scaffold=marker): pylons plus translucent hazard-stripe panels, no rails; the group is scaled in y with the construction progress like the scaffold
let hazMat = null;
function markerGroup(size) {
  if (!hazMat) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(255,176,40,0.14)'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(255,176,40,0.62)';
    for (let i = -64; i < 96; i += 32) { g.beginPath(); g.moveTo(i, 64); g.lineTo(i + 16, 64); g.lineTo(i + 80, 0); g.lineTo(i + 64, 0); g.closePath(); g.fill(); }
    const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
    hazMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  }
  const grp = new THREE.Group(), h = size * 0.5 + 0.12, L = size + 0.24;
  const posts = new THREE.Mesh(markerModel(size), scafMat); posts.castShadow = true; grp.add(posts);
  for (const [px, pz, ry] of [[0, -h, 0], [0, h, 0], [-h, 0, Math.PI / 2], [h, 0, Math.PI / 2]]) {
    const pg = new THREE.PlaneGeometry(L, 0.6); pg.translate(0, 0.3, 0);
    const uv = pg.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * L / 1.1, uv.getY(k));
    const m = new THREE.Mesh(pg, hazMat); m.position.set(px, 0, pz); m.rotation.y = ry; m.renderOrder = 5; grp.add(m);
  }
  return grp;
}

// thrown javelins: shown from the hand of a rigged skirmisher; every other projectile stays as it was
const javOn = () => !!(world.jav && world.u3 && world.u3.has('skirmisher'));
const isJav = (q) => q[7] !== undefined && q[7] >= 0 && world.units[q[7]]?.name === 'skirmisher';
const JAV_SPEED = 1.25; // the flying javelin is a little quicker than the sim shot: the hit effects of a snapshot come about one tick before the sim impact
const _vrf = {}; // the variation of a unit with the white-hot flash of a hit added to its tone
function flashVr(vr, f) { _vrf.dirt = vr.dirt; _vrf.holes = vr.holes; _vrf.seed = vr.seed; _vrf.s = vr.s; _vrf.tone = vr.tone * (1 + 1.1 * f); return _vrf; }
const _rb = { lg: 0, lean: 0, y: 0 };
const _jd = new THREE.Vector3(), _jt = new THREE.Vector3(), _tip = new THREE.Vector3(), _hip = new THREE.Vector3();
function renderJavelins() {
  const J = world.jav;
  let n = 0;
  if (J && cur && javOn()) {
    for (const [key, r] of javs) {
      const st = ustate.get(r.sid), age = (unitClock - r.fireT) / 10;
      if (age < 1 / 60 && st && st.jav && st.jav.ok) { // until the release the grip point follows the unit (facing, position)
        if (!r.h) { r.h = new THREE.Vector3(); r.d0 = new THREE.Vector3(); }
        r.h.copy(st.jav.grip); r.d0.copy(st.jav.dir);
      }
      if (age < 0) continue;
      if (!r.h) { // the shooter was never drawn: leave from chest height
        r.h = new THREE.Vector3(r.fx, hAt(r.fx, r.fz) + 1.1, r.fz); r.d0 = new THREE.Vector3(r.tx - r.fx, 0, r.tz - r.fz).normalize();
      }
      const dx = r.tx - r.h.x, dz = r.tz - r.h.z, D = Math.hypot(dx, dz) || 0.01;
      const Dend = Math.max(0.6, D - 0.9); // the grip stops where the head reaches the target
      const dist = r.spd * JAV_SPEED * age;
      if (dist >= Dend || age > 4) { if (dist >= Dend && age < 4 && fx) fx.sparks(r.tx, hAt(r.tx, r.tz) + 0.8, r.tz, 2, 1.5); javs.delete(key); continue; }
      const s = dist / Dend, yT = hAt(r.tx, r.tz) + 0.95, arc = 0.1 * Dend + 0.1;
      const x = r.h.x + (dx / D) * Dend * s, z = r.h.z + (dz / D) * Dend * s, y = r.h.y + (yT - r.h.y) * s + arc * 4 * s * (1 - s);
      _jt.set((dx / D) * Dend, yT - r.h.y + arc * 4 * (1 - 2 * s), (dz / D) * Dend).normalize(); // tangent of the flight path
      const bl = smoothS(age / 0.12); // leaves the hand along the shaft as it was held, turns into the flight direction
      _jd.copy(r.d0).lerp(_jt, bl).normalize();
      dummy.position.set(x, y, z); dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0);
      dummy.lookAt(x + _jd.x, y + _jd.y, z + _jd.z); dummy.updateMatrix();
      J.shaft.setMatrixAt(n, dummy.matrix); J.head.setMatrixAt(n, dummy.matrix);
      if (fx && fx.load < 0.8 && (trailTick + n) % 3 === 0 && age > 0.03) fx.trail(x, y, z, false);
      if (++n >= 160) break;
    }
  } else if (javs.size) javs.clear();
  if (J) { J.shaft.count = J.head.count = n; J.shaft.instanceMatrix.needsUpdate = J.head.instanceMatrix.needsUpdate = true; }
}

// Work of a gathering worker from the snapshot row: c[10] = 0 (not at work: on the way, carrying goods back, waiting) or 1 + kind (wood, berries, herd, farm, stone, gold), c[11], c[12] = middle of the node.
// Without this the nearest forest tile, bush, ore or field to the worker was taken, which is a different one whenever a field stands next to a bush, and for a tile whose tree is not drawn.
// The result of one worker is kept while its row says the same, so a frame allocates nothing.
const WORK_OF = [null, 8, 10, 10, 10, 9, 9]; // work code by row kind: wood chops, bush, herd and field use the field work pose (the rig plays `gather` for the bush), stone and gold mine
function workFromSim(c) {
  const k = c[10];
  if (!k) return null;
  const st = cu.st, w = st.gkS;
  if (w && w.k === k && w.tx === c[11] && w.tz === c[12]) return w.g;
  const g = { code: WORK_OF[k], tx: c[11], tz: c[12], pick: k === 2 }; // pick: picking at a bush (the rig plays `gather`; a herd keeps the field pose)
  st.gkS = { k, tx: c[11], tz: c[12], g };
  return g;
}
function findWork(c, x, z) {
  if (!cur) return null;
  if (c[6] === 3) { // building: the nearest unfinished building
    let best = null, bd = 3.2;
    for (const b of cur.buildings) {
      if (b[6] >= 100) continue;
      const sz = G.buildingDefs[G.buildings[b[2]]].size, cx = b[3] + sz / 2, cz = b[4] + sz / 2, d = Math.hypot(cx - x, cz - z) - sz / 2;
      if (d < bd) { bd = d; best = { code: 11, tx: cx, tz: cz }; }
    }
    return best;
  }
  if (c[10] !== undefined) return workFromSim(c); // the sim says what the worker works on (server/spectate.mjs workOf): nothing to guess from the map
  let best = null, bd = 2.0;
  const n = G.size, tx0 = Math.floor(x), tz0 = Math.floor(z);
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
    const tx = tx0 + i, tz = tz0 + j;
    if (tx < 0 || tz < 0 || tx >= n || tz >= n) continue;
    if (G.terrain[tz][tx] === 'f' && !treeGone.has(tz * n + tx)) {
      const d = Math.hypot(tx + 0.5 - x, tz + 0.5 - z) - 0.5;
      if (d < bd) { bd = d; best = { code: 8, tx: tx + 0.5, tz: tz + 0.5 }; }
    }
    const nd = nodeGrid.get(tz * n + tx);
    if (nd && !nodeGone.has(nd.id)) {
      const d = Math.hypot(nd.cx - x, nd.cz - z) - nd.size / 2;
      if (d < bd) { bd = d; const ore = nd.res === 'stone' || nd.res === 'gold'; best = { code: ore ? 9 : 10, tx: nd.cx, tz: nd.cz, pick: nd.res === 'berries' }; } // pick: picking at a bush (the rig plays `gather`; a herd keeps the field pose)
    }
  }
  for (const f of farmList) {
    const d = Math.max(Math.abs(f[0] - x), Math.abs(f[1] - z)) - f[2] / 2;
    if (d < bd) { bd = d; best = { code: 10, tx: f[0], tz: f[1] }; }
  }
  return best;
}
const WORKX = {
  onStep(cl, mv) {
    if (fx.load > 0.85) return;
    fx.dust(cu.x - Math.sin(cu.st.ang) * 0.12, hAt(cu.x, cu.z), cu.z - Math.cos(cu.st.ang) * 0.12, cl.dsz, 0.6 + 0.4 * mv);
  },
  onHit(act, tx, tz) {
    const t = WX.tgt;
    if (!t) return;
    const gy = hAt(tx, tz), sz = t[2];
    if (act === 7) { // catapult releases
      const a = cu.st.ang, ux = hAt(cu.x, cu.z);
      fx.smoke(cu.x + Math.sin(a) * 1.2, ux + 1.9, cu.z + Math.cos(a) * 1.2, 0.5, 0.3, 1.2);
      fx.dust(cu.x, ux, cu.z, 0.5, 1.2);
      return;
    }
    if (act === 12) { // mortar fires: flash and a dark puff above the muzzle
      const a = cu.st.ang, ux = hAt(cu.x, cu.z);
      fx.flash(cu.x + Math.sin(a) * 0.9, ux + 1.9, cu.z + Math.cos(a) * 0.9, 0.9, FXT.pal.siege_flash);
      fx.smoke(cu.x + Math.sin(a) * 0.9, ux + 1.9, cu.z + Math.cos(a) * 0.9, 0.6, 0.8, 1.6);
      fx.dust(cu.x, ux, cu.z, 0.6, 1.3);
      return;
    }
    if (act === 13) { // sapper lights the fuse (theme: effects.sapper.fuse names its colours and size)
      const F = FXT.fuse;
      if (F) fx.sparks(cu.x, hAt(cu.x, cu.z) + 1.0, cu.z - 0.2, 4, 1.4, F.spark, F.spark2, F.flash, F.size);
      else fx.sparks(cu.x, hAt(cu.x, cu.z) + 1.0, cu.z - 0.2, 4, 1.4);
      return;
    }
    if (act === 3) return; // arrows: the effect happens where the projectile lands
    if (SHOTFX.meleeHit(fx, WX.name, act, cu, tx, tz, sz, ustate.get(cu.c[7]), gy, ANIM.seq(cu.c[0], cur ? cur.t : 0))) return; // theme: the `hit` effect of this melee type takes the place of the contact flash (on a wall it comes on top of the chips)
    if (sz > 0) { // a building: chips fly from the wall facing the attacker
      const dx = cu.x - tx, dz = cu.z - tz, d = Math.hypot(dx, dz) || 1;
      const px = tx + (dx / d) * sz * 0.5, pz = tz + (dz / d) * sz * 0.5;
      if (act === 6) { fx.chips(px, gy + 0.8, pz, FXT.pal.rubble_wood, 7, 2.6, 0.12); fx.dust(px, gy, pz, 0.6, 1.5); }
      else fx.chips(px, gy + 0.8, pz, FXT.pal.rubble_stone, 3, 1.8, 0.07);
    } else { // a unit: flash, sparks and dust where the weapon meets the body (chest height, on the side of the attacker); seeded by attacker id and snapshot tick
      const vs = ustate.get(cu.c[7]), ab = cu.st.back || 0, vb = vs && vs.back || 0; // both bodies stand back a little: the effect is where the drawn bodies meet
      const ax = cu.x - Math.sin(cu.st.ang) * ab, az = cu.z - Math.cos(cu.st.ang) * ab, vx = vs ? tx - Math.sin(vs.ang) * vb : tx, vz = vs ? tz - Math.cos(vs.ang) * vb : tz;
      const dx = vx - ax, dz = vz - az, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
      fx.contact(vx - ux * 0.4, gy + 1.0, vz - uz * 0.4, ux, uz, ANIM.seq(cu.c[0], cur ? cur.t : 0), act === 2 || act === 5 || act === 6);
    }
  },
  work() {
    const st = cu.st;
    if (cu.c[10] === undefined && st.gkT !== undefined && Math.abs(cu.time - st.gkT) < 0.4 && st.gkAct === cu.c[6]) return st.gk; // (a row with the work of the sim is never cached by time)
    st.gkT = cu.time; st.gkAct = cu.c[6]; st.gk = findWork(cu.c, cu.x, cu.z);
    return st.gk;
  },
  onWork(code, tx, tz) {
    const gy = hAt(tx, tz);
    if (code === 8) fx.chips(tx, gy + 0.9, tz, FXT.pal.rubble_timber, 3, 1.6, 0.06);
    else if (code === 9) fx.sparks((cu.x + tx) / 2, gy + 0.7, (cu.z + tz) / 2, 3, 2.0);
    else if (code === 11) fx.chips(tx, gy + 0.8, tz, FXT.pal.rubble_timber, 2, 1.4, 0.05);
  },
};
Object.assign(WX, WORKX);
// trees react to the axe: the woodcutter at work on a tile (every frame) and every axe hit (once per swing) are passed on to render/chopped.mjs
const _work = WX.work, _onWork = WX.onWork;
WX.work = function () { const g = _work.call(this); if (g && g.code === 8 && world.trees.see) world.trees.see(g.tx, g.tz, cu.x, cu.z, cu.time); return g; };
WX.onWork = function (code, tx, tz) { _onWork.call(this, code, tx, tz); if (code === 8 && world.trees.hit) world.trees.hit(tx, tz, cu.time, cu.x, cu.z); };

function startDeath(id, u) {
  const st = ustate.get(id);
  ustate.delete(id);
  if (fogHidden(u) || !fx) return;
  if (world.units[u[2]].name === 'sapper' && u[9] > 0 && u[9] <= 6) { if (FXT.blast) fx.blast(u[3], u[4], FXT.blast.size, FXT.blast); else fx.blast(u[3], u[4], 1.0); } // the charge went off (fuse almost burnt down at the last snapshot)
  const def = G.unitDefs[world.units[u[2]].name];
  const ld = st && st.ld; // rigged: the pose of the last drawn frame, the fall starts from it
  deaths.push({ qAt: qStamp(), id, type: u[2], owner: u[1], x: ld ? ld.x : u[3], z: ld ? ld.z : u[4], ang: ld ? ld.ang : st ? st.ang : 0, role: st ? st.role : 0, cls: def.cls, dir: id % 2 ? 1 : -1, t0: null, ld: ld ? Object.assign({}, ld) : null });
}
function startCollapse(id, o, cx, cz, fin = false) {
  world.buildings.delete(id);
  if (o.scaf) { scene.remove(o.scaf); o.scaf = null; }
  collapsing.push({ o, cx, cz, gy: o.grp.position.y, t0: null, dir: id % 2 ? 1 : -1, acc: 0, fin });
}

// FINALE: the match is decided, so every building the loser still has falls, one after the other: a wave out from the middle of
// each base. Planned from the snapshot that carries `over` (live, replay, late joiner); the delays come from a hash of the building
// id (no Math.random) and the clock is the render time, so broadcast frames stay exact. ?finale=0 switches it off.
const FINALE_ON = params.get('finale') !== '0';
let finale = null, finaleE = null; // the plan (render/finale.mjs); seconds since it started (render clock)
// the end banner waits for the fall of the loser's base
function overSeen(o) {
  if (!G.finaleTried) { G.finaleTried = true; finale = FINALE_ON ? planFinale({ buildings: world.buildings, over: o, teamOf: (owner) => G.players[owner - 1]?.team }) : null; }
  if (finale) return;
  G.overShown = true; hud.over(o);
}
function setInst(grp, i, ph, amp, act, ap) { const A = grp.anim.array; A[i * 4] = ph; A[i * 4 + 1] = amp; A[i * 4 + 2] = act; A[i * 4 + 3] = ap; }

function updateBuilding(o, b, time, dt) {
  const prog = b[6], done = prog >= 100, hp = b[5];
  const swapped = world.bld3d ? world.bld3d.update(o, ownerTier(o.owner), hp, wallOrient(o)) : false;
  const cx = b[3] + o.size / 2, cz = b[4] + o.size / 2, gy = hAt(cx, cz);
  // video: a building that gets the look of a higher tier does not pop from one frame to the next: dust rises, the old look shrinks away, the new one grows into place
  if (BC) { const tn = ownerTier(o.owner); if (swapped && o.vTier !== undefined && tn > o.vTier && done && !fogBldHidden(o)) o.tierT = time; if (swapped || o.vTier === undefined) o.vTier = tn; } // (vTier: the tier of the look that stands; the first look is made at creation, not here)
  if (o.tierT === time && o.tierT !== o.tierDone) {
    o.tierDone = o.tierT;
    fx.cloud(cx, gy, cz, o.size * 0.7, 16 + o.size * 6, FXT.pal.done_dust, 0.8, 1.1 + o.size * 0.3);
    fx.chips(cx, gy + 0.8, cz, FXT.pal.rubble_timber, 10, 3.0, 0.09);
  }
  if (o.prev) {
    if (o.prevT == null) o.prevT = time;
    const u = (time - o.prevT) / 0.5;
    if (u >= 1) { o.grp.remove(o.prev); o.prev = null; } else { const s0 = (o.prev.userData.s0 ??= o.prev.scale.x); o.prev.scale.setScalar(s0 * (1 - u * u)); }
  }
  const target = done ? 1 : 0.12 + 0.88 * (prog / 100);
  o.pg += (target - o.pg) * (1 - Math.exp(-dt * 9));
  let sy = o.pg;
  if (o.doneFlag) {
    o.doneFlag = false; o.popT = time;
    fx.cloud(cx, gy, cz, o.size * 0.5, 7 + o.size * 2, FXT.pal.done_dust, 0.4, 0.6 + o.size * 0.15);
    fx.chips(cx, gy + 0.8, cz, FXT.pal.rubble_timber, 8, 2.8, 0.09);
  }
  if (o.popT !== undefined) { const t = (time - o.popT) / 0.55; if (t < 1) sy *= 1 + 0.07 * Math.sin(t * Math.PI) * (1 - t); }
  let sxz = 0.95 + 0.05 * clamp((o.pg - 0.12) / 0.88, 0, 1);
  if (o.tierT !== undefined) { // the new look grows into place over 0.9 s while dust trickles around it
    const t = (time - o.tierT) / 0.9;
    if (t >= 0 && t < 1) { const e = 1 - (1 - t) * (1 - t) * (1 - t); sy *= 0.72 + 0.28 * e; sxz *= 0.9 + 0.1 * e; if (fx.load < 0.8 && !fogBldHidden(o) && Math.random() < 0.5) fx.dust(cx + (Math.random() - 0.5) * o.size, gy, cz + (Math.random() - 0.5) * o.size, 0.5, 1.2); }
  }
  o.grp.position.y = gy;
  o.grp.scale.set(sxz, sy, sxz);
  const unseen = fogBldHidden(o); // fog view of the other side: not drawn, no smoke, no bar
  o.grp.visible = !unseen;
  if (o.spin && done) o.spin.rotation.z = -(time * 0.55 + o.tx * 0.7); // 3D pack: mill sails turn
  // scaffold rises with the walls and works while it stands
  if (!done && o.size >= 2) {
    if (!o.scaf) {
      if (params.get('scaffold') === 'marker') o.scaf = markerGroup(o.size);
      else { o.scaf = new THREE.Mesh(scaffoldModel(o.size, params.get('scaffold') === 'steel'), scafMat); o.scaf.castShadow = true; }
      o.scaf.position.set(cx, gy, cz); scene.add(o.scaf);
    }
    o.scaf.position.y = gy;
    o.scaf.visible = !unseen;
    o.scaf.scale.y = Math.max(0.25, o.h * sy * 1.15 + 0.1);
    o.acc += dt * (1.6 + o.size * 0.5);
    while (o.acc >= 1) {
      o.acc -= 1;
      if (fx.load < 0.8 && !unseen) {
        const px = cx + (Math.random() - 0.5) * o.size * 1.2, pz = cz + (Math.random() - 0.5) * o.size * 1.2;
        fx.dust(px, gy, pz, 0.3, 1);
        if (Math.random() < 0.3) fx.chips(px, gy + 0.3 + o.h * sy * 0.6, pz, FXT.pal.rubble_timber, 1, 1.2, 0.05);
      }
    }
  } else if (o.scaf) { scene.remove(o.scaf); o.scaf = null; }
  if (done && fx.load < 0.85 && !unseen) {
    const sm = o.inner ? o.model && pack3d.ov(o.model.id).smoke : SMOKE[o.name];
    if (sm && hp > 40) {
      o.acc += dt * (o.name === 'town_center' ? 2.4 : o.name === 'blacksmith' ? 3.4 : 1.8);
      o.acc = Math.min(o.acc, 3);
      while (o.acc >= 1) {
        o.acc -= 1;
        if (o.name === 'blacksmith') fx.smoke(cx + sm[0], gy + sm[1], cz + sm[2], 0.35, 0.55, 2.2);
        else fx.chimney(cx + sm[0], gy + sm[1], cz + sm[2], o.name === 'town_center' ? 1.35 : 1);
      }
    }
    // damage: smoke, then flames licking the roof
    if (hp < 62) {
      const sev = clamp((62 - hp) / 60, 0, 1);
      o.accS += dt * (1.5 + 7 * sev);
      while (o.accS >= 1) {
        o.accS -= 1;
        fx.smoke(cx + (Math.random() - 0.5) * o.size * 0.6, gy + o.h * (0.7 + Math.random() * 0.3), cz + (Math.random() - 0.5) * o.size * 0.6, 0.4 + o.size * 0.08, sev > 0.5 ? 0.85 : 0.3, 1.8);
      }
      if (hp < 45) {
        o.accF += dt * (4 + 22 * sev);
        while (o.accF >= 1) {
          o.accF -= 1;
          fx.flame(cx + (Math.random() - 0.5) * o.size * 0.7, gy + o.h * (0.35 + Math.random() * 0.6), cz + (Math.random() - 0.5) * o.size * 0.7, 0.42 + o.size * 0.09);
        }
      }
    }
  }
  if (!unseen && (hp < 90 || prog < 100)) pushBar(cx, gy + 1.2 + o.size * 0.7, cz, 0.9 + o.size * 0.3, prog < 100 ? prog : hp);
}

// 3D pack: LOD + culling of the instanced trees, nodes and decoration (camera must be up to date)
function updateScatter() {
  if (!pack3d || !world.trees) return;
  world.trees.update(camera); if (world.farTrees) world.farTrees.update(camera); if (world.farTrees2) world.farTrees2.update(camera); world.nodes3d.update(camera); world.deco3d.update(camera);
}
// healer pose: a wounded unit of the same owner within `r` tiles (visual only, from the snapshot)
function woundedNear(C, c, r) {
  for (const o of C.values()) if (o !== c && o[1] === c[1] && o[5] < 99 && (o[3] - c[3]) ** 2 + (o[4] - c[4]) ** 2 < r * r && world.units[o[2]].name !== 'healer' && G.unitDefs[world.units[o[2]].name].cls !== 'siege') return true;
  return false;
}
function renderUnits(now, dt, animT) {
  let a = !cur ? 1 : cur.paused ? 1 : clamp((now - curRecv) / gap, 0, 1.0);
  let P = prevUnits, C = curUnits, dtT = prev && cur ? Math.max(1, cur.t - prev.t) : 1;
  if (!BC && hist.length) {
    const last = hist[hist.length - 1], before = hist.length > 1 ? hist[hist.length - 2] : last;
    const lag = cur && cur.paused ? 0 : clamp(1.25 * (last.t - before.t), 1.5, 40);
    if (dispT === null || dispT > last.t || dispT < hist[0].t - 50) dispT = Math.max(hist[0].t, last.t - lag);
    if (cur && !cur.paused) dispT += dt * 10 * (cur.speed || 1);
    dispT += (last.t - lag - dispT) * Math.min(1, dt * 3); // soft steering toward the target delay
    dispT = clamp(dispT, hist[0].t, last.t);
    let i1 = hist.length - 1;
    while (i1 > 0 && hist[i1 - 1].t >= dispT) i1--;
    const s1 = hist[i1], s0 = hist[Math.max(0, i1 - 1)];
    P = s0.units; C = s1.units;
    a = s1.t === s0.t ? 1 : clamp((dispT - s0.t) / (s1.t - s0.t), 0, 1);
    dtT = Math.max(1, s1.t - s0.t);
  }
  unitClock = !cur ? 0 : !BC && hist.length ? dispT : (prev ? prev.t : cur.t) + a * (cur.t - (prev ? prev.t : cur.t));
  for (const k in world.units) world.units[k].list.length = 0;
  const u3 = world.u3 || null;
  if (u3) u3.begin();
  let ringN = 0, carryN = 0;
  for (const k in world.carryM) world.carryM[k].n = 0;
  barN = 0;
  const time = animT ?? now / 1000;
  ANIM.U.uTime.value = time;
  cu.time = time;
  const HERD = world.herd, herdT = animT ?? (performance.timeOrigin + now) / 1000 - 1.7e9; // deer: the wall clock (every viewer sees the same deer), broadcast: output time
  if (HERD) HERD.begin();
  trailTick++;
  const dtTicks = dtT;
  const BN = world.banners && world.banners.enabled ? world.banners : null, mil = [];
  if (BN) BN.begin();
  for (const [id, c] of C) {
    if (fogHidden(c)) continue;
    const p = P.get(id);
    const x = p ? p[3] + (c[3] - p[3]) * a : c[3], z = p ? p[4] + (c[4] - p[4]) * a : c[4];
    let st = ustate.get(id);
    if (!st) { st = { ang: G.players[c[1] - 1] && c[1] === 1 ? 0.8 : -2.3, seed: (id * 0.37) % 6.28 }; ustate.set(id, st); }
    const grp = world.units[c[2]];
    const def = G.unitDefs[grp.name];
    const cav = def.cls === 'cavalry', siege = def.cls === 'siege';
    // attack target (unit or building) for facing and hit effects
    WX.tgt = null;
    if (c[6] === 4 && c[7]) {
      const tu = C.get(c[7]);
      if (tu) WX.tgt = [tu[3], tu[4], 0, tu[6] === 4 && tu[7] === c[0] ? 1 : 0, ANIM.bodyR(G.unitDefs[world.units[tu[2]].name])]; // [3]: the victim strikes back, [4]: its body radius
      else { const tb = bIndex.get(c[7]); if (tb) { const sz = G.buildingDefs[G.buildings[tb[2]]].size; WX.tgt = [tb[3] + sz / 2, tb[4] + sz / 2, sz]; } }
    }
    ANIM.bindUnit(WX, grp.name, def, x, z, dtTicks, WX.tgt, !!(u3 && u3.has(grp.name)), () => riderScale(grp.name, c[0])); // rigged: baked clips (work, melee, flinch motion); WX.rig: rigged rider, its scale on screen for the gait (render/gait.mjs)
    cu.x = x; cu.z = z; cu.st = st; cu.c = c;
    ANIM.stepUnit(st, c, p, a, dt, time, WX, POSE);
    if (HERD) HERD.see(x, z, c[6] === 2 && st.gkT !== undefined && time - st.gkT < 0.5 ? 2 : 0, st.gk); // deer notice units; a worker at work on a deer starts the hunt
    if (grp.lunge) { POSE.lunge *= grp.lunge; POSE.lean *= grp.lean; } // 3D pack: static siege models
    const rigged = !!(u3 && u3.has(grp.name)), off = rigged ? (POSE.ct >= 0 || POSE.flinch > 0 || POSE.back > 1e-4 ? ANIM.rigBody(POSE, _rb).lg : 0) : POSE.lunge; // the drawn body offset along the facing (stand-off, strike lunge, flinch): ring, bar and the lance pennant follow it
    const s = UNIT_SCALE * (cav ? 0.95 : 1);
    const naval = def.cls === 'naval';
    if (naval) { POSE.amp = 0; POSE.act = 0; POSE.lean = Math.sin(time * 1.3 + st.seed) * 0.03; POSE.roll = Math.sin(time * 1.7 + st.seed * 2) * 0.04; }
    const gy = naval ? -0.36 + 0.02 + Math.sin(time * 1.5 + st.seed) * 0.03 : hAt(x, z); // ships ride the water surface
    const sa = Math.sin(POSE.ang), ca = Math.cos(POSE.ang);
    dummy.position.set(x + sa * POSE.lunge, gy + POSE.y, z + ca * POSE.lunge);
    dummy.rotation.set(POSE.lean, POSE.ang, POSE.roll, 'YXZ');
    dummy.scale.set(s, s * POSE.sy, s);
    dummy.updateMatrix();
    if (BN && naval) { // the creator's banner hangs from the yard in front of the sail (no creator: plain team-colour sail)
      const top = gy + ({ fishing_boat: 1.3, war_boat: 1.45, transport: 1.55 }[grp.name] || 1.3);
      BN.cloth_(c[1], 1, 1, x, top, z, -Math.PI / 4, 0.72, 0.98, 0.06, ((c[0] * 2654435761) >>> 0) / 4294967296);
    }
    if (BN) { // creator banners: lance pennants on cavalry, army groups for the bearers
      if (cav && !(grp.name === 'scout' && u3 && u3.has('scout'))) {
        if (u3 && u3.has(grp.name)) { // rigged horse: the creator pennant sits at the tip of the new lance (offset from the spot banners.mjs expects)
          dummy.position.set(x + sa * off, gy, z + ca * off); dummy.rotation.set(0, POSE.ang, 0); dummy.scale.setScalar(s * RIG_K); dummy.updateMatrix();
          BN.lance(tmpM.copy(dummy.matrix).multiply(grp.name === 'heavy_cavalry' ? LANCE_OFF_H : LANCE_OFF_L), c[1], id, grp.name === 'heavy_cavalry');
        } else BN.lance(dummy.matrix, c[1], id, grp.name === 'heavy_cavalry');
      }
      if (def.cls !== 'worker' && def.cls !== 'siege' && c[1] > 0) mil.push([c[1], x, z]);
    }
    const i = grp.list.length;
    if (u3 && u3.has(grp.name)) { // rigged 3D unit: skinned instance, animation from the clip tables (render/units3d.mjs)
      const RS = rigState(grp.name, st, POSE, c, time, u3, c[6] === 4 && !!WX.tgt, grp.name === 'healer' && POSE.amp < 0.05 && woundedNear(C, c, 4)), ld = rigRemember(st, RS); // ld: what a death would start from
      const vr = vOf(c[0]), sc = s * RIG_K * unitMul(grp.name) * vr.s;
      if (POSE.ct >= 0 || POSE.flinch > 0 || POSE.back > 1e-4) { // work, melee, flinch and the stand-off of a fighter: the baked clip is re-timed in stepUnit, the body leans and lunges on top (about the hips, the feet stay where the unit stands)
        const RB = ANIM.rigBody(POSE, _rb);
        dummy.position.set(x + sa * RB.lg, gy + RB.y, z + ca * RB.lg); dummy.rotation.set(RB.lean, POSE.ang, POSE.hr, 'YXZ');
        _hip.set(0, 0.42 * sc, 0); dummy.position.add(_hip); _hip.applyEuler(dummy.rotation); dummy.position.sub(_hip);
        ld.lg = RB.lg; ld.lean = RB.lean; ld.roll = POSE.hr; ld.y = RB.y;
      } else { dummy.position.set(x, gy, z); dummy.rotation.set(0, POSE.ang, 0); ld.lg = 0; ld.lean = 0; ld.roll = 0; ld.y = 0; }
      ld.x = x; ld.z = z; ld.ang = POSE.ang;
      dummy.scale.setScalar(sc); dummy.updateMatrix();
      u3.push(RS.key, u3.lodFor(st, camera.position.distanceTo(dummy.position)), dummy.matrix, pcol(c[1]), RS, POSE.flash > 0 ? flashVr(vr, POSE.flash) : vr);
      if (POSE.impact === 8 && world.trees.hit) { const wk = WX.work(); if (wk && wk.code === 8) world.trees.hit(wk.tx, wk.tz, cu.time, cu.x, cu.z); } // rigged woodcutters do not call onWork any more: the axe hit of the tree is this impact (animT only)
      if (POSE.impact && fx && fx.load < 0.9) { // a work tool hits: chips / sparks / dust at the tool tip, from the baked skin matrices of this very frame; seeded by unit id and work cycle (no Math.random)
        if (!u3.toolTip(RS.key, RS.clip, RS.t, dummy.matrix, _tip)) _tip.set(x + sa * 0.5, gy + 0.4, z + ca * 0.5);
        fx.workFx(POSE.impact, _tip.x, _tip.y, _tip.z, sa, ca, ANIM.seq(c[0], st.workFor));
      }
      if (grp.name === 'skirmisher') u3.javelinRelease(RS.key, dummy.matrix, st.jav || (st.jav = { grip: new THREE.Vector3(), dir: new THREE.Vector3(), ok: false })); // where the javelin leaves the hand
    } else if (i < CAP) {
      grp.body.setMatrixAt(i, dummy.matrix); grp.team.setMatrixAt(i, dummy.matrix);
      grp.team.setColorAt(i, pcol(c[1]));
      setInst(grp, i, POSE.ph, POSE.amp, POSE.act, POSE.ap);
      grp.list.push(1);
    }
    if (ringN < 1400) {
      dummy.rotation.set(0, 0, 0); dummy.position.set(x + sa * off, gy, z + ca * off); dummy.scale.setScalar(cav || siege ? 1.5 : 1.15); dummy.updateMatrix();
      world.ring.setMatrixAt(ringN, dummy.matrix); world.ring.setColorAt(ringN, pcol(c[1])); ringN++;
    }
    const cv = POSE.carry; // goods fade out while the worker holds a tool in both hands (chop, mine, build, farm)
    const cm = c[8] && cv > 0.04 && u3 && u3.has(grp.name) ? world.carryM[c[8]] : null;
    if (cm && cm.n < CAP) { // the real goods model in the hands (rigged workers)
      dummy.rotation.set(0, POSE.ang, 0); dummy.position.set(x + sa * 0.3, gy + 0.78 + POSE.y, z + ca * 0.3); dummy.scale.setScalar(s * RIG_K * 0.78 * cv); dummy.updateMatrix();
      for (const mm of cm.meshes) mm.setMatrixAt(cm.n, dummy.matrix);
      cm.n++;
    } else if (c[8] && cv > 0.04 && !(u3 && u3.has(grp.name) && world.carryM[c[8]]) && carryN < CAP) {
      dummy.rotation.set(0, POSE.ang, 0); dummy.position.set(x - sa * 0.22, gy + 0.62 + POSE.y, z - ca * 0.22); dummy.scale.setScalar(cv); dummy.updateMatrix();
      world.carry.setMatrixAt(carryN, dummy.matrix); world.carry.setColorAt(carryN, tmpC.set(RES_COLORS[c[8]])); carryN++;
    }
    if (c[5] < 97) pushBar(x + sa * off, gy + (cav ? 1.55 : siege ? 1.6 : 1.3), z + ca * off, siege ? 0.9 : 0.7, c[5]);
  }
  if (HERD) HERD.update(herdT, dt, camera);
  if (world.trees.frame) world.trees.frame(time); // trees: wobble at the axe hits, falling trees, stumps
  // dying units: fall, lie, sink (same instanced meshes, relaxed pose)
  for (let di = deaths.length - 1; di >= 0; di--) {
    const d = deaths[di];
    if (d.t0 === null) d.t0 = time;
    if (time < d.t0) d.t0 = time;
    const grp = world.units[d.type], i = grp.list.length;
    if (!ANIM.deathPose(d, time - d.t0, DPOSE)) { deaths.splice(di, 1); continue; }
    if (u3 && u3.has(grp.name)) { // rigged: the fall is a clip, the CPU part only sinks and shrinks the body
      const age = time - d.t0, sink = smoothS((age - 1.3) / 0.8) * 0.3, fade = 1 - smoothS((age - 1.8) / 0.4), RS = u3.deathState(grp.name, d, age);
      const sc = UNIT_SCALE * RIG_K * unitMul(grp.name) * fade * vOf(d.id).s, L = d.ld, w = L ? ANIM.deathCarry(age) : 0, dsa = Math.sin(d.ang), dca = Math.cos(d.ang), dgy = hAt(d.x, d.z) - sink;
      if (w > 1e-3) { // the body motion of the last live frame (stand-off, lunge, flinch) fades out instead of snapping upright
        dummy.position.set(d.x + dsa * L.lg * w, dgy + L.y * w, d.z + dca * L.lg * w); dummy.rotation.set(L.lean * w, d.ang, L.roll * w, 'YXZ');
        _hip.set(0, 0.42 * sc, 0); dummy.position.add(_hip); _hip.applyEuler(dummy.rotation); dummy.position.sub(_hip);
      } else { dummy.position.set(d.x, dgy, d.z); dummy.rotation.set(0, d.ang, 0); }
      dummy.scale.setScalar(sc); dummy.updateMatrix();
      u3.push(RS.key, 0, dummy.matrix, pcol(d.owner), RS, vOf(d.id));
      continue;
    }
    if (i >= CAP) continue;
    const s = UNIT_SCALE * (d.cls === 'cavalry' ? 0.95 : 1) * DPOSE.scale;
    const sa = Math.sin(d.ang), ca = Math.cos(d.ang), gy = hAt(d.x, d.z);
    dummy.position.set(d.x + sa * DPOSE.lunge, gy + DPOSE.y, d.z + ca * DPOSE.lunge);
    dummy.rotation.set(DPOSE.lean, d.ang, DPOSE.roll, 'YXZ');
    dummy.scale.set(s, s * DPOSE.sy, s);
    dummy.updateMatrix();
    grp.body.setMatrixAt(i, dummy.matrix); grp.team.setMatrixAt(i, dummy.matrix);
    grp.team.setColorAt(i, pcol(d.owner));
    setInst(grp, i, 0, 0, d.cls === 'cavalry' ? 5 : 0, 0.3);
    grp.list.push(1);
  }
  if (BN) { // banner bearers: visual only, follow the centre of an army group and walk with the anim rig
    const grp = world.units[world.bearerIdx];
    for (const b of BN.updateBearers(mil, G.starts, Math.max(dt, 1e-3))) {
      if (grp.list.length >= CAP || (fogOn && fogHidden([0, b.owner, 0, b.x, b.z]))) continue;
      const fade = 1 - smoothS(b.lost / 0.7), gy = hAt(b.x, b.z), s = UNIT_SCALE * fade, i = grp.list.length;
      if (u3 && u3.has('swordsman')) { // rigged bearer: walking swordsman (the banner itself is drawn by banners.mjs)
        dummy.position.set(b.x, gy, b.z); dummy.rotation.set(0, b.ang, 0); dummy.scale.setScalar(s * RIG_K); dummy.updateMatrix();
        const RS = u3.bearerState(b.ph, b.mv, time);
        u3.push(RS.key, 0, dummy.matrix, pcol(b.owner), RS);
        BN.bearerBanner(b, gy, UNIT_SCALE, fade);
        continue;
      }
      dummy.position.set(b.x, gy + Math.abs(Math.sin(b.ph)) * 0.06 * b.mv, b.z);
      dummy.rotation.set(0.06 * b.mv, b.ang, Math.sin(b.ph) * 0.06 * b.mv, 'YXZ');
      dummy.scale.set(s, s, s); dummy.updateMatrix();
      grp.body.setMatrixAt(i, dummy.matrix); grp.team.setMatrixAt(i, dummy.matrix);
      grp.team.setColorAt(i, pcol(b.owner));
      setInst(grp, i, b.ph, 0.8 * b.mv, 0, 0.3);
      grp.list.push(1);
      BN.bearerBanner(b, gy, UNIT_SCALE, fade);
    }
  }
  if (u3) u3.end();
  for (const k in world.units) {
    const g = world.units[k], n = g.list.length;
    g.body.count = g.team.count = n;
    g.body.instanceMatrix.needsUpdate = g.team.instanceMatrix.needsUpdate = true;
    g.anim.needsUpdate = true;
    if (g.team.instanceColor) g.team.instanceColor.needsUpdate = true;
  }
  world.ring.count = ringN; world.ring.instanceMatrix.needsUpdate = true; if (world.ring.instanceColor) world.ring.instanceColor.needsUpdate = true;
  for (const k in world.carryM) { const cm = world.carryM[k]; for (const mm of cm.meshes) { mm.count = cm.n; mm.instanceMatrix.needsUpdate = true; } }
  world.carry.count = carryN; world.carry.instanceMatrix.needsUpdate = true; if (world.carry.instanceColor) world.carry.instanceColor.needsUpdate = true;
  // buildings: growth + scaffold, chimney smoke, fire, hp bars
  if (cur) for (const b of cur.buildings) {
    const o = world.buildings.get(b[0]);
    if (o) updateBuilding(o, b, time, dt);
  }
  // finale: start the falls that are due, then the banner
  if (finale) {
    if (finale.t0 === null || time < finale.t0) finale.t0 = time;
    finaleE = time - finale.t0;
    while (finale.next < finale.items.length && finale.items[finale.next].at <= finaleE) {
      const it = finale.items[finale.next++];
      if (world.buildings.get(it.id) === it.o) startCollapse(it.id, it.o, it.cx, it.cz, true);
    }
    if (!BC && !G.overShown && finaleE >= finale.end + FIN.tail) { G.overShown = true; hud.over(finale.over); }
  }
  // falling buildings: shake, sink into the ground, dust
  for (let ci = collapsing.length - 1; ci >= 0; ci--) {
    const k = collapsing[ci], o = k.o;
    if (k.t0 === null) {
      k.t0 = time;
      if (k.fin && o.size <= 1) { fx.dust(k.cx, k.gy, k.cz, 1.0, 1.6); fx.chips(k.cx, k.gy + 0.5, k.cz, FXT.pal.rubble_wood, 5, 2.5, 0.12); } // finale: walls and the like get a light puff
      else fx.collapse(k.cx, k.cz, o.size, k.gy);
      if (!k.fin || o.size >= 3) shake.hit(k.cx, k.cz, k.fin ? o.size * 0.7 : o.size, time); // a finale does not pile up shakes
      if (k.fin && audio) audio.collapseAt(o.name, k.cx, k.cz, o.size, o.owner, o.tx * 977 + o.ty);
    }
    if (time < k.t0) k.t0 = time;
    const age = time - k.t0, T = 2.4;
    if (age > T) { scene.remove(o.grp); collapsing.splice(ci, 1); continue; }
    const wob = age < 0.9 ? Math.sin(age * 58) * 0.05 * (1 - age / 0.9) : 0; // the building itself wobbles (not the camera shake)
    o.grp.position.set(k.cx + wob, k.gy - smoothS((age - 0.1) / 2.1) * (o.h * 1.08 + 0.2), k.cz + wob * 0.7);
    o.grp.scale.set(1 + 0.04 * smoothS(age / 1.2), 1 - 0.3 * smoothS(age / 1.6), 1 + 0.04 * smoothS(age / 1.2));
    o.grp.rotation.z = 0.07 * k.dir * smoothS(age / 1.3);
    k.acc += dt * (age < 1.4 ? 14 : 0);
    while (k.acc >= 1) { k.acc -= 1; fx.dust(k.cx + (Math.random() - 0.5) * o.size, k.gy, k.cz + (Math.random() - 0.5) * o.size, 0.6, 1.4, FXT.pal.collapse_dust2); }
  }
  if (BN) { for (const o of world.buildings.values()) if (!fogBldHidden(o)) BN.building(o, false); for (const k of collapsing) BN.building(k.o, true); BN.end(); }
  world.hpBg.count = world.hpFg.count = barN;
  world.hpBg.instanceMatrix.needsUpdate = world.hpFg.instanceMatrix.needsUpdate = true;
  if (world.hpFg.instanceColor) world.hpFg.instanceColor.needsUpdate = true;
  // projectiles: extrapolate toward the target between snapshots (the sim decides when they land) and lift them on a ballistic arc (render/shots.mjs);
  // arrows leave a thin trail, stones a smoke trail
  let pn = 0, sn = 0, bn = 0; // bn: theme bolts
  if (cur) {
    const el = BC ? bcProjEl : Math.max(0, (now - curRecv) / 1000) * (cur.paused ? 0 : cur.speed);
    const jv = javOn();
    shots.begin();
    for (const q of cur.proj) {
      if (pn + sn + bn >= 520) break;
      if (jv && isJav(q)) continue; // drawn from the hand by renderJavelins
      const shooter = q[7] >= 0 ? world.units[q[7]]?.name || '' : '';
      const th = shooterTheme(q, bIndex), bolt = !!(th && th.projectile && q[6] !== 1 && world.projT); // theme: this shooter fires a glowing bolt instead of an arrow
      const tsp = !!(th && th.projectile && q[6] === 1); // theme (code package 2): a catapult stone / mortar shell in the colour and size of the theme's projectile slot, with its trail; the round tumbling shape and the arc stay
      const kind = bolt ? BOLT : shotKind(q, shooter);
      const P = shots.pose(q, cur.t, el, kind, launchHeight(shooter, q[7] >= 0 ? 0 : world.buildings.get(q[8])?.h));
      if (th && th.muzzle && P.fresh && q[9] <= 2 && fx.load < 0.9) { // theme: muzzle flash in the frame where the shot first shows (not for a shot that is already on its way)
        const hl = Math.hypot(P.dx, P.dz) || 1, ux = P.dx / hl, uz = P.dz / hl;
        SHOTFX.muzzle(fx, P, th, q[7] >= 0 ? ustate.get(q[8]) : null, ux, uz, ANIM.seq(P.seed, 41)); // at the muzzle anchor of the drawn shooter when the model has one, else where it always was (render/theme/shot-theme.mjs)
      }
      dummy.position.set(P.x, P.y, P.z);
      dummy.scale.set(1, 1, 1);
      dummy.lookAt(P.x + P.dx, P.y + P.dy, P.z + P.dz);
      if (bolt && th.projectile.mesh && SHOTFX.mesh(th.projectile, dummy, P, fx)) continue; // theme: a delivered mesh instead of the bolt (halo and trail included); false = not loaded or unusable, the bolt below
      if (bolt) { // glowing bolt in the colour of the theme, with a halo and a trail of lights
        const pj = th.projectile;
        dummy.scale.set(pj.width, pj.width, pj.length);
        dummy.updateMatrix();
        world.projT.setMatrixAt(bn, dummy.matrix);
        world.projT.setColorAt(bn, tmpC.set(pj.color));
        bn++;
        if (fx.load < 0.8) {
          fx.boltTrail(P.x, P.y, P.z, pj.glow, 0.07, 0.3 + pj.width * 4); // the halo (a light that lives one frame or two)
          if (pj.trail && P.adv > 0.3) fx.boltTrail(P.x - P.dx * 0.4, P.y - P.dy * 0.4, P.z - P.dz * 0.4, pj.trail.color, 0.24, pj.trail.size * 2.5);
        }
        continue;
      }
      if (kind === ARROW) {
        dummy.rotateZ((P.seed >>> 8) % 628 / 100); // fletching turned a little differently per arrow
        dummy.updateMatrix();
        world.proj.setMatrixAt(pn, dummy.matrix);
        world.proj.setColorAt(pn, tmpC.set(0xffffff));
        pn++;
      } else { // stones tumble, shells and balls are round
        const big = kind === STONE;
        dummy.rotation.set(time * 3.1 + (P.seed & 63) * 0.1, time * 2.3 + (P.seed >>> 6 & 63) * 0.1, 0);
        const sz = tsp ? th.projectile.length : big ? 0.6 : kind === SHELL ? 0.42 : 0.34;
        dummy.scale.set(sz, big ? sz * 0.85 : sz, sz);
        dummy.updateMatrix();
        world.shell.setMatrixAt(sn, dummy.matrix);
        world.shell.setColorAt(sn, tmpC.set(tsp ? th.projectile.color : big ? 0x8a8f98 : 0x33363d));
        sn++;
      }
      if (fx.load < 0.8 && (trailTick + pn + sn) % (kind === ARROW ? 2 : 3) === 0 && P.adv > 0.3) fx.trail(P.x, P.y, P.z, kind !== ARROW);
      if (tsp && th.projectile.trail && fx.load < 0.8 && P.adv > 0.3) fx.boltTrail(P.x - P.dx * 0.4, P.y - P.dy * 0.4, P.z - P.dz * 0.4, th.projectile.trail.color, 0.24, th.projectile.trail.size * 2.5); // theme: the spark trail of the shell
    }
    shots.end();
  }
  world.proj.count = pn; world.proj.instanceMatrix.needsUpdate = true; if (world.proj.instanceColor) world.proj.instanceColor.needsUpdate = true;
  world.shell.count = sn; world.shell.instanceMatrix.needsUpdate = true; if (world.shell.instanceColor) world.shell.instanceColor.needsUpdate = true;
  if (world.projT) { world.projT.count = bn; world.projT.instanceMatrix.needsUpdate = true; if (world.projT.instanceColor) world.projT.instanceColor.needsUpdate = true; }
  SHOTFX.flush(); // theme: the counts of the mesh projectiles
  renderJavelins();
}

// ---------------- loop ----------------
let lastT = performance.now(), frames = 0, fpsT = 0, fps = 0;
// Viewer frame cap (render/perf.mjs): 60 fps (30 when paused, game over or no snapshot for 2 s). A skipped tick leaves lastT alone, so dt builds up (clamped to 0.1 below).
let lastDraw = performance.now(), lastMini = 0, tgtFps = 60;
const gpuT = perf ? new GpuTimer(renderer.getContext()) : null;
function frame(now) {
  let t0 = 0;
  if (perf) {
    tgtFps = targetFps({ paused: !!(cur && cur.paused), over: !!(G && G.overShown), idleMs: now - lastSnapAt, active: !!drag || keys.size > 0 });
    if (!shouldDraw(now, lastDraw, tgtFps)) { requestAnimationFrame(frame); return; }
    lastDraw = nextDraw(now, lastDraw, tgtFps);
    t0 = performance.now();
  }
  const interval = now - lastT, dt = Math.min(0.1, interval / 1000);
  lastT = now;
  frames++; fpsT += dt;
  if (fpsT > 1) {
    fps = frames / fpsT; frames = fpsT = 0; window.__fps = fps;
    if (perfUI) perfUI.setReadout(readout(fps, renderer.getPixelRatio(), perf.mode) + (gpuT.ok && gpuT.ms ? ` · gpu ${gpuT.ms.toFixed(1)} ms` : ''));
  }
  if (G) {
    keyPan(dt);
    director(dt);
    shakeT = now / 1000;
    applyCamera(dt, params.has('snapcam') && !window.__camSettled);
    if (audio) { audio.setView(camS); audio.frame(dt); } // SOUND: listener = camera target
    camera.updateMatrixWorld();
    camQ.copy(camera.quaternion);
    updateScatter();
    renderUnits(now, dt);
    if (markers) markers.frame(dt, now / 1000);
    fx.update(dt);
    if (godWorld) godWorld.frame(dt, now / 1000);
    if (worldFx) worldFx.update(now / 1000, dt, camS);
    G.tmesh.water.material.opacity = 0.58 + Math.sin(now / 1400) * 0.04;
    hud.tickFeed();
    if (perf ? shouldDraw(now, lastMini, 10) : frames % 3 === 0) { if (perf) lastMini = nextDraw(now, lastMini, 10); drawMinimap(); } // viewer: at most 10 Hz
    if (gpuT) gpuT.begin();
    post.render(); // LIGHT+POST (was renderer.render)
    if (gpuT) gpuT.end();
    if (perf) { // adaptive pixel ratio: the cost of this frame is the CPU time (or the GPU time, when the browser has a timer query), or the whole interval when a vsync was missed
      const nd = perf.frame(now, Math.max(performance.now() - t0, gpuT.poll()), interval, tgtFps);
      if (nd !== null) setDpr(nd);
    }
  }
  requestAnimationFrame(frame);
}
// hidden tab: the browser stops rAF but the event stream stays open, so deaths and javelins pile up unseen; when the tab shows again the old ones are dropped (not played all at once)
if (perf) document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const n = performance.now();
  dropStale(deaths, n, undefined, (e) => e.t0 === null); dropStale(javs, n, undefined, (e) => e.h === null);
  lastDraw = n; perf.ctl.reset(n, 1000);
});

// ---------------- broadcast hooks ----------------
if (BC) {
  window.__bcHooks = {
    init(m) { if (!G) { buildWorld(m); fx = makeFx(); markers = makeMarkers({ THREE, scene, hAt: heightAt, color: (o) => G.players[o - 1]?.color || '#ffffff' }); } return { size: G.size }; },
    snap(s) { onSnap(s); curRecv = 0; gap = 1000; },
    // one frame: alpha = position between the last two snapshots, animT = output time (s), dt = frame time (s)
    render(alpha, animT, dt, c) {
      // the broadcast director sends heights above the ground and an optional lens (fov); the ground is added here
      Object.assign(cam, { tx: c.tx, ty: (c.ty || 0) + heightAt(c.tx, c.tz), tz: c.tz, dist: c.dist, az: c.az, pol: c.pol, mode: 'free' });
      if (c.fov && Math.abs(camera.fov - c.fov) > 1e-6) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
      shakeT = animT;
      applyCamera(0, true);
      camera.updateMatrixWorld();
      camQ.copy(camera.quaternion);
      bcProjEl = alpha * 0.1;
      updateScatter();
      renderUnits(alpha * 1000, dt, animT);
      if (markers) markers.frame(dt, animT);
      fx.update(dt);
      if (godWorld) godWorld.frame(dt, animT);
      if (worldFx) worldFx.update(animT, dt, camS);
      G.tmesh.water.material.opacity = 0.58 + Math.sin((animT * 1000) / 1400) * 0.04;
      post.render(); // LIGHT+POST (was renderer.render)
    },
    // fog of war view of player p (0 = off), a = 0..1 fade; units outside that player's vision are hidden once the fog is more than half in
    fog(msg) { applyFog(msg); },
    fogView(p, a) { fogOn = p > 0 && a >= FOG_HIDE_AT; if (fog) { fog.p = p || fog.p; fog.mesh.material.opacity = a; fog.mesh.visible = p > 0 && a > 0.01; } applyMarkers(); },
    marksView(off) { marksOff = !!off; applyMarkers(); },
    markerText(on) { if (markers) markers.textOff(!on); },
    markerLabels() { return markers ? markers.labels() : []; },
    // world points -> normalized screen position of the view (0..1, y down) for the highlights of the story cut; h = height above the ground in tiles
    project(pts) { camera.updateMatrixWorld(); const v = new THREE.Vector3(); return pts.map((q) => { v.set(q.x, heightAt(q.x, q.z) + (q.h || 0), q.z).project(camera); return [v.x * 0.5 + 0.5, 0.5 - v.y * 0.5, v.z]; }); },
    resize,
    get ready() { return Promise.all([world.banners ? world.banners.ready : null, world.modelsReady, world.u3Ready, ...(world.siegeReady || [])]); },
    get current() { return cur; },
  };
}

// ---------------- network ----------------
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'init') {
      if (!G) { buildWorld(m); fx = makeFx(); markers = makeMarkers({ THREE, scene, hAt: heightAt, color: (o) => G.players[o - 1]?.color || '#ffffff' }); if (audio) audio.attach(m, { riderScale, shooters: SHOOTERS.themed ? SHOOTERS : null, sounds: soundThemeOf(THEME) }); }
    } else if (m.type === 'snap' && G) onSnap(m);
  };
  es.onerror = () => { /* the browser reconnects by itself */ };
}
if (!BC) {
  connect();
  requestAnimationFrame(frame);
}
window.__rts = { get packFailed() { return packFailed; }, get bubbleBoxes() { return worldFx ? worldFx.bubbleBoxes() : []; }, set forceTier(v) { FORCE_TIER = v; }, pack: pack3d, world, cam, camS, camera, renderer, post, get snap() { return cur; }, get finale() { return finale && { e: finaleE, n: finale.items.length, next: finale.next, end: finale.end, groups: finale.groups.length, falling: collapsing.length }; }, get G() { return G; }, get banners() { return world.banners; }, get fps() { return fps; }, audio };
