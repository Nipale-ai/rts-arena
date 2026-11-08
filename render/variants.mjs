// Cosmetic unit variants: a fixed look per unit id (size, body tone, dirt, patches and holes). Render only, the sim never sees it.
// The unit shader (units3d.mjs) turns dirt/holes/seed/tone into the wear of the body material.
export const variantsOn = (params) => params.get("variants") !== "0";
const h = (id, k) => { let x = (Math.imul(id + 1, 2654435761) ^ Math.imul(k + 7, 0x85ebca6b)) >>> 0; x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0; x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0; return ((x ^ (x >>> 15)) >>> 0) / 4294967296; };
export function variant(id) {
  const holes = h(id, 4);
  return { s: 0.95 + 0.1 * h(id, 1), tone: 0.92 + 0.16 * h(id, 2), dirt: 0.15 + 0.85 * h(id, 3), holes: holes < 0.2 ? 0 : 0.5 + 0.5 * (holes - 0.2) / 0.8, seed: h(id, 5) };
}
export const NEUTRAL = { s: 1, tone: 1, dirt: 0, holes: 0, seed: 0 };
