// Test themes of the renderer hooks. NOT real themes.
//
// A real theme is a folder render/assets/themes/<id>-vN with a theme.json: render/theme/theme-loader.mjs loads it, `?theme=<id>-vN` picks it, and the hooks read it with
// getThemeSlot (render/theme/theme-loader.mjs). This file holds the one built-in test theme that works without any file. It exists for two things the contract does not have (yet):
//   - `tint` (units.<type>.tint): the classic archer rig in another colour, so the model hook can be shown before a real model exists. It is not a contract key, a real theme.json cannot carry it.
//   - sounds by CLIP ID of render/assets/audio/manifest.json instead of a delivered file (stand-ins until the theme brings its two samples).
// `?theme=arc-gunner-placeholder` (page) and `--theme arc-gunner-placeholder` (tools) pick it. The shapes of projectile, muzzle, hit and clips are the ones of THEME-VERTRAG.md section 3.3.
// It has no names (units.<type>.name): the words of a theme come from theme.json or from the lexicon of render/theme/display-name.mjs, never from here.
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
