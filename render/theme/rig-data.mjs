// Renderer data of a rigged body: what an entry of render/assets/models/units/UNITS.json may carry beside its files (package R3). tools/rig/render-data.mjs writes it from tools/rig/units.d.
//   tip            { bone, p }  the point of the tool or weapon that hits or works, in the rest pose (metres of the unit frame), in the skin matrix of bone `bone` (index in the family)
//   muzzle_anchor  { bone, p }  the point where a shot leaves the weapon, same frame
//   lift           number       share of the atlas that is added as emissive light
//   floor          number       share of white added to the albedo of the body
// The 14 classic bodies carry none of these; units3d.mjs keeps its own tables for them (TOOL_TIP, UNIT_TUNE) and asks the registry first, so a body of a theme needs no edit of units3d.mjs.

const num = (v) => typeof v === 'number' && Number.isFinite(v);

// a registry anchor { bone, p } -> the same object when it is well formed, else null (a hand-edited registry never breaks a frame, the anchor is simply not there)
export function anchorOf(v) {
  if (!v || typeof v !== 'object' || !Number.isInteger(v.bone) || v.bone < 0) return null;
  if (!Array.isArray(v.p) || v.p.length !== 3 || !v.p.every(num)) return null;
  return v;
}

// the tool tip of a body: its registry entry first, else the classic table `tips` (key -> [x, y, z], all classic tools sit in `classicBone`)
export function tipOf(info, key, tips, classicBone) {
  return anchorOf(info && info.tip) || (tips && tips[key] ? { bone: classicBone, p: tips[key] } : null);
}

// { lift, floor } of a body: its registry entry first, then the classic table entry `table` ({ lift?, floor? } or undefined), then the defaults
export function tuneOf(info, table, defLift) {
  const pick = (name, def) => (info && num(info[name]) ? info[name] : table && num(table[name]) ? table[name] : def);
  return { lift: pick('lift', defLift), floor: pick('floor', 0) };
}
