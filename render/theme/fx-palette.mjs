// The colours of the particle effects, as the renderer always used them (code package 2). Pure data: no imports, no THREE, no DOM, no random numbers.
// render/fx.mjs reads `this.pal.<key>` where it used to have the literal; a theme (effects.palette.<key>, render/theme/fx-theme.mjs) may answer with its own colour.
// Every value below is the literal that stood in render/fx.mjs or render/app.mjs: without a theme (or for a key the theme does not name) the picture is the same bits as before.
//   key              was                                       where it is used
export const FX_PALETTE_DEFAULTS = Object.freeze({
  dust: 0xb9aa88,          // Fx.dust default; the faint dust under the sparks of a themed hit (boltHit)
  cloud: 0xa89a7c,         // Fx.cloud default colour
  impact_dust: 0x9b8c6c,   // catapult stone lands: the shock cloud
  collapse_dust: 0xa89c7e, // Fx.collapse: the dust wall
  collapse_dust2: 0xa09478, // app.mjs: the dust that rises from a falling building
  done_dust: 0xb8aa8a,     // app.mjs: the cloud when a building is finished
  shard_stone: 0x8f959f,   // Fx.impact and Fx.blast: stone splinters
  shard_earth: 0x6b5238,   // Fx.impact and Fx.blast: earth and timber splinters
  rubble_wood: 0x8a7355,   // Fx.collapse rubble; app.mjs: ram chips, finale chips
  rubble_stone: 0x9aa1ab,  // Fx.collapse rubble; app.mjs: chips off a wall
  rubble_timber: 0xb98a55, // app.mjs: chips of work and construction
  blast_flash: 0xfff2c8,   // Fx.blast: the white-hot flash
  blast_fire: 0xff7a1c,    // Fx.blast: fire ball, colour 1
  blast_fire2: 0xffc13a,   // Fx.blast: fire ball, colour 2
  blast_smoke: 0x4a4743,   // Fx.blast: the dark cloud
  smoke_dark: 0x2f3236,    // Fx.smoke when dark (> 0.5)
  smoke_light: 0x6a6e75,   // Fx.smoke when light
  chimney: 0xd5d8dc,       // Fx.chimney
  trail_big: 0x8d9097,     // Fx.trail: the smoke trail of a stone or shell
  trail_small: 0xf0ece0,   // Fx.trail: the dust of an arrow
  flame: 0xff8a24,         // Fx.flame, colour 1
  flame2: 0xffc13a,        // Fx.flame, colour 2
  ember: 0xffb040,         // Fx.flame: the rising ember
  flash: 0xfff0c0,         // Fx.flash and Fx.sparks: the default flash
  spark: 0xfff0b0,         // Fx.sparks, colour 1
  spark2: 0xffc060,        // Fx.sparks, colour 2
  siege_flash: 0xffc060,   // app.mjs: the flash above the mortar
  heal: 0x6bff9a,          // Fx.heal
});
