// The effect colours of a theme (code package 2): effects.palette, effects.sapper.fuse, effects.sapper.blast (THEME-VERTRAG.md, render/theme/theme-schema.mjs validateEffects).
// resolveFxTheme(theme) -> { themed, pal, fuse, blast }
//   pal    every colour of render/theme/fx-palette.mjs: the theme's, else the classic literal (a plain object, frozen)
//   fuse   the sapper's lit fuse { flash, spark, spark2, size } or null = classic (the call is then exactly the old one)
//   blast  the sapper's explosion { flash, fire, fire2, size } or null = classic
// Without a theme, or a theme without `effects`, the answer is CLASSIC_FX: pal = the defaults, fuse = blast = null, themed = false.
// Pure data and small functions: no DOM, no THREE, no Math.random, no clock.
import { getThemeSlot } from './theme-loader.mjs';
import { FX_PALETTE_DEFAULTS } from './fx-palette.mjs';
import { EFFECT_PALETTE_KEYS } from './theme-schema.mjs';

export const CLASSIC_FX = Object.freeze({ themed: false, pal: FX_PALETTE_DEFAULTS, fuse: null, blast: null });

// '#rrggbb' (or a number) -> 0xrrggbb, else null
function colorOf(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  return m ? parseInt(m[1], 16) : null;
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function resolveFxTheme(theme) {
  if (!theme) return CLASSIC_FX;
  const palette = getThemeSlot(theme, 'effects.palette'), sapper = getThemeSlot(theme, 'effects.sapper');
  if (!isObj(palette) && !isObj(sapper)) return CLASSIC_FX;
  const pal = { ...FX_PALETTE_DEFAULTS };
  if (isObj(palette)) for (const k of EFFECT_PALETTE_KEYS) { const c = colorOf(palette[k]); if (c !== null) pal[k] = c; }
  const fo = isObj(sapper) && isObj(sapper.fuse) ? sapper.fuse : null, bo = isObj(sapper) && isObj(sapper.blast) ? sapper.blast : null;
  const fuse = fo ? { flash: colorOf(fo.flash) ?? pal.flash, spark: colorOf(fo.spark) ?? pal.spark, spark2: colorOf(fo.spark2) ?? pal.spark2, size: num(fo.size, 0.42, 0.1, 3) } : null;
  const blast = bo ? { flash: colorOf(bo.flash) ?? pal.blast_flash, fire: colorOf(bo.fire) ?? pal.blast_fire, fire2: colorOf(bo.fire2) ?? pal.blast_fire2, size: num(bo.size, 1, 0.1, 3) } : null;
  return Object.freeze({ themed: true, pal: Object.freeze(pal), fuse, blast });
}
