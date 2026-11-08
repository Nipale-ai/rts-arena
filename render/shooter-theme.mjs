// Theme table of the shooters (R3 + R4): which projectile, muzzle flash, hit effect and sounds a shooter type gets from the theme.
// One table for the archer slot and for the buildings that shoot arrows too (tower, town centre, castle): the same slots, the same code, classic until a theme names them.
// Pure data, no DOM, no THREE, no Math.random, no clock: render/app.mjs (picture) and render/audio-core.mjs (sound, also the offline mix) read it.
// Without a theme (or a theme without these slots) every lookup is null = classic: arrow mesh, classic sparks, bow and arrow sounds, nothing else changes.
//
// Slots (THEME-VERTRAG.md 3.3, read through getThemeSlot; the base is units.<type> or buildings.<type>):
//   <base>.projectile  { shape: 'bolt', color, glow?, length, width, trail?: { color, size } }   glowing bolt mesh with a trail (shape 'mesh' + mesh: a delivered glb, drawn by render/theme/shot-fx.mjs; the bolt while the file is not loaded)
//   <base>.muzzle      { fx: 'flash'|'sparks'|'puff'|'sprite', color, size, life_s?, anchor? }    effect where the shot leaves (anchor: the node of the model, render/theme/shot-theme.mjs muzzleWorld; the shot origin when the model has none)
//   <base>.hit         { fx, color, size, life_s? }                                              effect where the shot lands, or (a melee type: units.spearman, swordsman ...) where the blow lands
//   <base>.sound.shot  / .sound.hit   a delivered sound file (url or path), or a clip id of render/assets/audio/manifest.json (test themes)
//   units.<type>.model / .tint / .clips.shoot are read by render/units3d.mjs (applyTheme).
import { getThemeSlot } from './theme/theme-loader.mjs';
import { extendProfile, extendTable } from './theme/shot-theme.mjs'; // package C6: the mesh file and the muzzle anchor in the profile, the melee types in the table

// every shooter type that has a slot today (a theme may name others; get() works for any name)
export const SHOOTERS = { units: ['archer', 'skirmisher'], buildings: ['town_center', 'tower', 'castle'] };
// a theme sound plays with the settings of this classic clip (bus, priority, cooldown, distance); the files are the theme's
export const SOUND_TEMPLATE = { shot: 'bow_shot', hit: 'arrow_hit_flesh' };

const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
// '#rrggbb', '#rgb', '0xrrggbb' or a number -> 0xrrggbb; anything else -> null
export function parseColor(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^(?:#|0x)([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return parseInt(h, 16);
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
// a bare colour is a short form of { color }
const asObj = (v) => obj(v) || (parseColor(v) !== null ? { color: v } : v === true ? {} : null);

const DEFAULT_BOLT = 0x9fe8ff, FX = ['flash', 'sparks', 'puff', 'sprite'];
function projectileOf(v) {
  const o = asObj(v);
  if (!o) return null;
  const color = parseColor(o.color) ?? DEFAULT_BOLT, glow = parseColor(o.glow) ?? color, tr = obj(o.trail);
  return { shape: o.shape === 'mesh' ? 'mesh' : 'bolt', color, glow, length: num(o.length, 0.45, 0.1, 1.2), width: num(o.width, 0.05, 0.01, 0.3), trail: tr ? { color: parseColor(tr.color) ?? glow, size: num(tr.size, 0.08, 0.02, 1) } : null };
}
function effectOf(v, fallbackColor, size, life) {
  const o = asObj(v);
  if (!o) return null;
  const e = { fx: FX.includes(o.fx) ? (o.fx === 'sprite' ? 'flash' : o.fx) : 'flash', color: parseColor(o.color) ?? fallbackColor ?? 0xfff0c0, size: num(o.size, size, 0.05, 3), life: num(o.life_s, life, 0.03, 2) }; // ('sprite' needs a texture: drawn as a flash)
  const core = parseColor(o.core), spark = parseColor(o.spark); // code package 2: the hot centre of a muzzle flash, the bright third of the sparks of a hit; only present when the theme names them (else white, as before)
  if (core !== null) e.core = core;
  if (spark !== null) e.spark = spark;
  return e;
}
// a sound value: a clip id of the manifest, or a file (url or path). Returns { id, file } or null; a file gets its own trigger id
function soundOf(v, tag) {
  if (typeof v !== 'string' || !v || v.length > 400) return null;
  if (/^[a-z0-9_]{1,48}$/.test(v)) return { id: v, file: null };
  if (/^(?:https?:|file:|\/|[a-z0-9_\-.]+\/)[^\s]*\.ogg$/i.test(v) && !v.includes('..')) return { id: `theme_${tag}`, file: v };
  return null;
}

// profile of one shooter type from a theme: { projectile, muzzle, hit, shotSound, hitSound, files } (each null when the theme has no such slot), or null when there is none at all.
// shotSound / hitSound = trigger ids; files = { id: file } for the sounds that are files (they need an event, see ShooterTable.soundEvents)
export function resolveShooter(theme, isBuilding, name) {
  if (!theme || typeof name !== 'string' || !name) return null;
  const base = (isBuilding ? 'buildings.' : 'units.') + name, tag = (isBuilding ? 'b_' : 'u_') + name;
  const pr = getThemeSlot(theme, base + '.projectile'), mz = getThemeSlot(theme, base + '.muzzle'), ht = getThemeSlot(theme, base + '.hit');
  const sh = soundOf(getThemeSlot(theme, base + '.sound.shot'), tag + '_shot'), hi = soundOf(getThemeSlot(theme, base + '.sound.hit'), tag + '_hit');
  const projectile = projectileOf(pr), glow = projectile ? projectile.glow : null;
  const P = { projectile, muzzle: effectOf(mz, glow, 0.35, 0.1), hit: effectOf(ht, glow, 0.3, 0.25), shotSound: sh ? sh.id : null, hitSound: hi ? hi.id : null, files: {} };
  if (sh && sh.file) P.files[sh.id] = sh.file;
  if (hi && hi.file) P.files[hi.id] = hi.file;
  extendProfile(P, pr, mz); // C6: projectile.mesh (shape 'mesh') and muzzle.anchor
  return P.projectile || P.muzzle || P.hit || P.shotSound || P.hitSound ? P : null;
}

// the table for one theme: get(isBuilding, name) is memoised (called for every projectile in every frame)
export class ShooterTable {
  constructor(theme) {
    this.theme = theme || null;
    this.u = new Map(); this.b = new Map();
    this.themed = false; // true when at least one shooter type has a profile
    this.hasProjectile = false; // true when a bolt mesh is needed
    this.files = {}; // trigger id -> sound file, of every shooter with a file sound
    if (this.theme) for (const [isB, list] of [[false, SHOOTERS.units], [true, SHOOTERS.buildings]]) for (const n of list) {
      const p = this.get(isB, n);
      if (p) { this.themed = true; if (p.projectile) this.hasProjectile = true; Object.assign(this.files, p.files); }
    }
    extendTable(this); // C6: the melee types (hit effect, hit sound) count too
  }
  get(isBuilding, name) {
    if (!this.theme) return null;
    const m = isBuilding ? this.b : this.u;
    let p = m.get(name);
    if (p === undefined) { p = resolveShooter(this.theme, isBuilding, name); m.set(name, p); }
    return p;
  }
  // The sound events of the file sounds, made from the manifest events `events` (id -> event): same bus, priority, cooldown and distance as the classic clip (SOUND_TEMPLATE), the theme's file.
  // A caller (render/audio.mjs, tools/audio-mix.mjs) adds them to its event table; a trigger whose id is missing there falls back to its `alt` (the classic clip).
  soundEvents(events) {
    const out = {};
    for (const [id, file] of Object.entries(this.files)) {
      const tpl = events[id.endsWith('_hit') ? SOUND_TEMPLATE.hit : SOUND_TEMPLATE.shot];
      if (tpl) out[id] = { ...tpl, files: [file], level_rms_db: [tpl.level_rms_db?.[0] ?? -19], source: { generator: 'theme', file }, licence: 'theme file' };
    }
    return out;
  }
}
