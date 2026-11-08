// Ground and light of a theme (package C5A of the reskin): the terrain colours, the water colours, the sky, the haze and the far field of a match, read from the
// `ground` and `light` slots of theme.json (THEME-VERTRAG.md sections 3.6 and 3.8). Colours and numbers only: no texture, no model, no new file.
//
//   themedBiome(base, theme, mapType)   the biome of render/biomes.mjs with the colours of the theme laid over it (the very `base` object when the theme says nothing)
//   waterLook(biome, classic)           the three water colours and the opacity render/terrain.mjs builds its water from (the very `classic` object without a theme)
//
// A biome is what the renderer already reads (render/biomes.mjs): `pal` (terrain vertex colours, arrays [r, g, b] of 0..1, like col()), `sky` { zenith, mid },
// `haze` { color, k }, `sun` (a multiple of the sun), `far` { grass, dry, forest, rock } (hex numbers). This module adds one key, `water` { deep, shallow, foam, opacity }.
// So the hooks stay where they were: render/terrain.mjs reads `pal` and now `water`, render/post.mjs setBiome() reads sky, haze, sun and far. Nothing else changes.
//
// What is hooked here, and what is not (the schema knows more than this package builds):
//   ground.palette (16 colours), ground.water (3 colours + opacity)       hooked
//   light.sky, light.haze, light.sun.intensity, light.far                  hooked
//   `maps.<map type>`                                                      hooked (the loader merges it: theme.world(name, mapType))
//   PAL.skirt                                                              named in the schema, read by nothing (the skirt is a darker copy of the edge colours)
//   ground.textures                                                        NOT here (loadGround, package C5B)
//   light.weather                                                          NOT here (render/world-fx.mjs, package C5B)
//   light.sun.color, light.fill, light.exposure                            NOT hooked: they are constants of LOOK in render/post.mjs, no theme can reach them yet
//
// About the numbers in a theme: ground.palette are vertex colours exactly like PAL in render/terrain.mjs. The terrain hands them to the shader as they are (read as linear light), so the picture
// shows them lighter and less saturated than the hex suggests (classic grassB #387637 shows as about (139, 166, 125); dustmoon-v1 grassC #8b6a2c as about (185, 148, 106)). Sky, haze and far
// colours are different: THREE.Color reads them as ordinary sRGB hex. The dustmoon-v1 values were set with a light model fitted to the classic pictures (reskin package C5A) and are working values.
//
// Classic stays byte-equal: no theme, the classic theme, or a theme without `ground` and `light` return the very same object they were given, so every
// consumer sees the same numbers as before. Pure: no THREE, no DOM, no clock, no random numbers; a loaded Theme (theme.world()) is the only thing it reads.

const HEX = /^#[0-9a-fA-F]{6}$/;
const hexInt = (s) => (typeof s === 'string' && HEX.test(s) ? parseInt(s.slice(1), 16) : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// the same arithmetic as col() in render/terrain.mjs and render/biomes.mjs: a hex colour as [r, g, b] of 0..1 (the terrain reads its vertex colours as they are)
export const colorArray = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const WATER_COLORS = ['deep', 'shallow', 'foam']; // THEME-VERTRAG.md 3.6 (WATER_KEYS of the schema)
const WATER_OPACITY = [0.2, 1]; // the range of the schema

// the resolved slot of a loaded Theme ('ground' or 'light', refined for the map type), or null = classic. Anything that is not a loaded theme says nothing.
function slotOf(theme, name, mapType) {
  if (!theme || typeof theme !== 'object' || theme.isClassic || typeof theme.world !== 'function') return null;
  return theme.world(name, mapType) || null;
}

// { zenith: 0x..., mid: 0x... } from a table of '#rrggbb' strings: only the colours the table has, as hex numbers (what render/post.mjs setBiome() reads)
function hexTable(table, keys) {
  const out = {};
  for (const k of keys) { const h = hexInt(table?.[k]); if (h !== null) out[k] = h; }
  return out;
}

// base: a biome of render/biomes.mjs; theme: a loaded Theme (or anything else = classic); mapType: the map type the biome is of (default: the id of the biome)
export function themedBiome(base, theme, mapType = base && base.id) {
  const g = slotOf(theme, 'ground', mapType), l = slotOf(theme, 'light', mapType);
  if (!g && !l) return base;
  const out = { ...base };
  let changed = false;

  // ground.palette: the colours the terrain mixes its vertex colours from. The theme's colour wins; a name it does not give keeps the colour of the map type.
  if (g?.palette) {
    const pal = {};
    for (const [k, v] of Object.entries(g.palette)) { const h = hexInt(v); if (h !== null) pal[k] = colorArray(h); }
    if (Object.keys(pal).length) { out.pal = { ...(base.pal || {}), ...pal }; changed = true; }
  }

  // ground.water: deep, shallow and foam as arrays like the palette, opacity as a number; only what the theme says (waterLook fills the rest)
  if (g?.water) {
    const water = {};
    for (const k of WATER_COLORS) { const h = hexInt(g.water[k]); if (h !== null) water[k] = colorArray(h); }
    if (isNum(g.water.opacity) && g.water.opacity >= WATER_OPACITY[0] && g.water.opacity <= WATER_OPACITY[1]) water.opacity = g.water.opacity;
    if (Object.keys(water).length) { out.water = water; changed = true; }
  }

  // light.sky: the dome colours. A colour the theme leaves out stays as it is (render/post.mjs keeps its own value for a colour the biome does not set).
  const sky = hexTable(l?.sky, ['zenith', 'mid']);
  if (Object.keys(sky).length) { out.sky = { ...(base.sky || {}), ...sky }; changed = true; }

  // light.haze: the colour of the distance fog and k, how much of it replaces the sky colour at the horizon. k is always a number (post.mjs reads it unchecked): the theme's,
  // else the one of the map type, else 0 (the classic meadow has no haze override).
  const hazeColor = hexInt(l?.haze?.color), hazeK = isNum(l?.haze?.k) ? l.haze.k : null;
  if (hazeColor !== null || hazeK !== null) {
    const color = hazeColor ?? base.haze?.color;
    out.haze = { ...(color !== undefined ? { color } : {}), k: hazeK ?? base.haze?.k ?? 0 };
    changed = true;
  }

  // light.sun.intensity: a multiple of the sun of the map type (post.mjs: `b.sun ?? 1`)
  if (isNum(l?.sun?.intensity)) { out.sun = (base.sun ?? 1) * l.sun.intensity; changed = true; }

  // light.far: the ground beyond the map edge
  const far = hexTable(l?.far, ['grass', 'dry', 'forest', 'rock']);
  if (Object.keys(far).length) { out.far = { ...(base.far || {}), ...far }; changed = true; }

  return changed ? out : base;
}

// classic: { deep, shallow, foam, opacity } as render/terrain.mjs has them. Returns the object it was given unless the biome carries a themed water.
export function waterLook(biome, classic) {
  const w = biome && biome.water;
  return w ? { ...classic, ...w } : classic;
}
