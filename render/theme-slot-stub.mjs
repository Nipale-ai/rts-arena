// The read interface of the renderer hooks (R3 + R4) and the test themes for them.
//
// getThemeSlot(theme, 'units.archer.projectile') -> the value of that slot, or undefined (= classic for this slot).
// It was a local stub while render/theme/theme-loader.mjs (R2a) was built in parallel; the loader has landed, so this module now re-exports its function (the one line the
// TODO of the stub asked for). The loader reads a loaded Theme (resolved slots, a placeholder file counts as missing) and also a plain object, nested or flat. Every hook
// (render/shooter-theme.mjs, render/units3d.mjs, render/app.mjs) imports getThemeSlot from here, so there is still exactly one place to change.
export { getThemeSlot } from './theme/theme-loader.mjs';

// ---------------------------------------------------------------------------------------------------------------------------
// Test themes, NOT real themes (a real one is a folder render/assets/themes/<id>-vN with a theme.json, loaded by the loader and picked with ?theme=<id>-vN).
// `?theme=arc-gunner-placeholder` (page) and `--theme arc-gunner-placeholder` (tools) pick one of these. They exist for two things the contract does not have yet:
//   - `tint` (units.<type>.tint): the classic archer rig in another colour, so the model hook can be shown before a real model exists. Not a contract key, a real theme.json cannot carry it.
//   - sounds by CLIP ID of render/assets/audio/manifest.json instead of a delivered file (stand-ins until the theme brings its two samples).
// Shapes of projectile, muzzle, hit and clips are the ones of THEME-VERTRAG.md section 3.3.
export const PLACEHOLDER_THEMES = {
  'arc-gunner-placeholder': {
    id: 'arc-gunner-placeholder',
    note: 'hook test only: classic archer rig in a tint, bolt, muzzle flash, hit sparks, stand-in sounds (not the dustmoon-v1 art)',
    units: {
      archer: {
        tint: '#7fe9dd',
        projectile: { shape: 'bolt', color: '#7ff3e0', glow: '#2fd6c0', length: 0.9, width: 0.09, trail: { color: '#2fd6c0', size: 0.2 } },
        muzzle: { fx: 'sparks', color: '#9ff7ea', size: 0.45, life_s: 0.12 },
        hit: { fx: 'sparks', color: '#7ff3e0', size: 0.4, life_s: 0.3 },
        sound: { shot: 'javelin_throw', hit: 'arrow_hit_stone' },
      },
    },
  },
};

// the test theme of ?theme=<id>, or undefined (anything else is for the loader)
export const themeById = (id) => (typeof id === 'string' && Object.hasOwn(PLACEHOLDER_THEMES, id) ? PLACEHOLDER_THEMES[id] : undefined);
