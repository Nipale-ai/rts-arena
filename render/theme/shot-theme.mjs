// Shooter layer, the rest of it (package C6): what render/shooter-theme.mjs, render/audio-core.mjs and render/app.mjs call for
//   1. the mesh projectile   projectile.shape 'mesh': the file of the glb travels with the profile (loading and drawing: render/theme/shot-fx.mjs)
//   2. the muzzle anchor     muzzle.anchor: where on the model the flash sits. muzzleWorld() is the one place the rig fit (R3) fills in
//   3. the blow of a melee attacker   units.<melee type>.hit (effect) and units.<melee type>.sound.hit (sound): so far only a landing projectile had a hit
// Pure data and small functions: no DOM, no THREE, no Math.random, no clock. A seeded effect takes the generator `rand` of its caller (render/anim.mjs seq).
// Without a theme, or with a theme that names none of this, every function returns "classic" (null, false, or the input as it was): the picture and the sound triggers do not change.
import { MUZZLE_ANCHORS } from './theme-schema.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- 1. mesh projectile -------------------------------------------------------------------------------------------------------------------------------------
// a url or a path of a .glb without a way out of its folder (the same rule as a sound file in shooter-theme.mjs). A loaded Theme gives an absolute url (Theme.fileUrl).
const MESH_FILE = /^(?:https?:|file:|\/|[a-z0-9_\-.]+\/)[^\s]*\.glb$/i;
export function meshUrlOf(v) {
  return typeof v === 'string' && v.length <= 400 && MESH_FILE.test(v) && !v.includes('..') ? v : null;
}

// ---- 2. muzzle anchor ---------------------------------------------------------------------------------------------------------------------------------------
// the anchor a muzzle slot names ('tool_tip', 'hand' or 'muzzle_anchor', THEME-VERTRAG.md 3.3), else null = the shot origin
export const anchorOf = (mz) => (isObj(mz) && MUZZLE_ANCHORS.includes(mz.anchor) ? mz.anchor : null);

// STUB (package C6): the world position { x, y, z } of the muzzle anchor of a drawn shooter, or null = the model has none (yet).
// `unit` = the render state of the shooter (render/app.mjs `ustate.get(id)`), `anchor` = the name the theme asks for.
// R3 (rig: clip shoot_rifle, the node muzzle_anchor in UNITS.json) fills this in: it computes the point in the unit loop of render/app.mjs next to `u3.javelinRelease` / `u3.toolTip`
// (from the baked skin matrices and the instance matrix, as those two do) and keeps it on the render state. Until then no unit has the field and the flash sits where it always sat.
export function muzzleWorld(unit, anchor) {
  const m = unit && unit.muzzle; // (`anchor` is not used by the stub: the rig fit decides which node it keeps here)
  return m && Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z) ? m : null;
}

// The muzzle flash of a themed shot in the first frame it shows. P = the pose of the shot (render/shots.mjs: ox, oz, y0 = where it leaves), th = profile of the shooter
// (render/shooter-theme.mjs), unit = render state of the shooter or null (a building), (ux, uz) = horizontal direction of the shot, rand = seeded generator.
// The flash sits at the anchor of the drawn model when it has one, else half a tile in front of the shot origin: the arguments of fx.muzzle are then exactly the ones it always got.
export function muzzleFlash(fx, P, th, unit, ux, uz, rand, worldOf = muzzleWorld) {
  const a = unit && th.anchor ? worldOf(unit, th.anchor) : null;
  if (a) fx.muzzle(a.x, a.y, a.z, ux, uz, th.muzzle, rand);
  else fx.muzzle(P.ox + ux * 0.5, P.y0, P.oz + uz * 0.5, ux, uz, th.muzzle, rand);
}

// ---- profile and table (called by render/shooter-theme.mjs) ---------------------------------------------------------------------------------------------------
// resolveShooter() calls this with the profile it built and the raw projectile and muzzle slots: a mesh projectile carries its file, the profile carries the muzzle anchor.
// A bolt keeps the shape it had (no `mesh` key): the tests and the pictures of the bolt do not move.
export function extendProfile(P, pr, mz) {
  if (P.projectile && P.projectile.shape === 'mesh') {
    const url = meshUrlOf(isObj(pr) ? pr.mesh : undefined);
    if (url) P.projectile.mesh = url; // no usable file: the profile stays a 'mesh' without one, and the game draws the bolt
  }
  P.anchor = anchorOf(mz);
  return P;
}

// Unit types that strike in melee (sim/data.mjs: melee or siege damage at range 1). Their `hit` slot is drawn where the blow lands. A theme may name any of them.
export const MELEE_UNITS = ['worker', 'spearman', 'swordsman', 'light_cavalry', 'heavy_cavalry', 'scout', 'ram', 'bulwark'];
const MELEE_SET = new Set(MELEE_UNITS);
// the acts of render/anim.mjs whose blow lands on its victim: 1 thrust, 2 slash, 5 rider attack, 6 ram. (3 shoot, 4 throw, 7 catapult, 12 mortar and 13 charge have their own effect.)
export const MELEE_ACTS = new Set([1, 2, 5, 6]);

// The constructor of ShooterTable calls this last: a theme that names only a melee type (a hit effect, a hit sound) makes the table `themed`, and the sound files of those types are known to it.
export function extendTable(t) {
  if (!t.theme) return;
  for (const n of MELEE_UNITS) {
    const p = t.get(false, n);
    if (p) { t.themed = true; Object.assign(t.files, p.files); }
  }
  // code package 2: the ship and the siege weapons count too (a theme that names only a catapult stone or a ship's ball still makes the table themed, and needs the bolt mesh for the ship)
  for (const n of SIEGE_UNITS) {
    const p = t.get(false, n);
    if (p) { t.themed = true; if (p.projectile) t.hasProjectile = true; Object.assign(t.files, p.files); }
  }
}
// Unit types with a splash or cannon shot that are not in SHOOTERS: war_boat (a ball), catapult (a stone), mortar (a shell). A theme may name a projectile, muzzle and hit for them (render/app.mjs reads the slots through ShooterTable.get)
export const SIEGE_UNITS = ['war_boat', 'catapult', 'mortar'];

// ---- 3. the blow of a melee attacker ----------------------------------------------------------------------------------------------------------------------------
// The `hit` effect of a melee attacker at the moment its blow lands (render/app.mjs, the onHit of the unit loop). p = profile of the attacker type (ShooterTable.get), act = its act,
// cu = the unit that strikes ({ x, z, st: { ang, back } }), (tx, tz) = the target, sz = its size in tiles (0 = a unit), victim = render state of a victim that is a unit, gy = ground height at the target.
// Returns true when the effect takes the place of the classic contact flash (a blow on a unit). A blow on a building draws the effect on the wall facing the attacker and returns false:
// the chips that fly from the wall stay. The places are those of the classic effects (the flash and the chips), so the theme lands where the old look landed.
export function meleeHit(fx, p, act, cu, tx, tz, sz, victim, gy, rand) {
  if (!p || !p.hit || !MELEE_ACTS.has(act)) return false;
  if (sz > 0) {
    const dx = cu.x - tx, dz = cu.z - tz, d = Math.hypot(dx, dz) || 1;
    fx.boltHit(tx + (dx / d) * sz * 0.5, gy + 0.8, tz + (dz / d) * sz * 0.5, p.hit, rand);
    return false;
  }
  const ab = cu.st.back || 0, vb = (victim && victim.back) || 0; // both bodies stand back a little: the effect is where the drawn bodies meet
  const ax = cu.x - Math.sin(cu.st.ang) * ab, az = cu.z - Math.cos(cu.st.ang) * ab;
  const vx = victim ? tx - Math.sin(victim.ang) * vb : tx, vz = victim ? tz - Math.cos(victim.ang) * vb : tz;
  const dx = vx - ax, dz = vz - az, d = Math.hypot(dx, dz) || 1;
  fx.boltHit(vx - (dx / d) * 0.4, gy + 1.0, vz - (dz / d) * 0.4, p.hit, rand);
  return true;
}

// The sound triggers a melee swing makes in render/audio-core.mjs (every classic id of a blow). A themed hit sound takes their place, the classic id stays as the fallback (`alt`).
const MELEE_SOUNDS = new Set(['hit_sword_flesh', 'hit_sword_shield', 'hit_sword_armour', 'hit_sword_clash', 'hit_spear', 'building_hit_stone', 'building_hit_wood', 'ram_thud_wood', 'ram_thud_stone', 'hunt_hit']);
// The director calls this after it has pushed the triggers of one swing of a unit of type `type` (out[from..] are the new ones). shooters = the ShooterTable of the theme.
// A theme that gives the type no hit sound leaves the triggers as they are. The trigger keeps its place, owner, entity, tick and volume: only the id changes.
export function themeMelee(shooters, type, out, from) {
  if (!MELEE_SET.has(type)) return;
  const p = shooters.get(false, type);
  if (!p || !p.hitSound) return;
  for (let i = from; i < out.length; i++) if (MELEE_SOUNDS.has(out[i].id)) out[i] = { ...out[i], id: p.hitSound, alt: out[i].id };
}
