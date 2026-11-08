// Map types as the renderer sees them: terrain palette, ground textures, sky and haze tint, far-field colours. The sim only tells the map type
// (init.mapType); the look is a pure function of it. `meadow` is the original look, untouched (every value of the other types is an override).
import { themedBiome } from './theme/ground-theme.mjs'; // the colours of a theme's `ground` and `light` slots, laid over a biome (package C5A)
const col = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

const dim = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((x) => x * f)])); // a darker copy of a palette

export const BIOMES = {
  meadow: { id: 'meadow' },

  forest: {
    id: 'forest',
    pal: { grassA: col(0x1d4a28), grassB: col(0x28592e), grassC: col(0x3b6d34), grassD: col(0x4f7a37), forest: col(0x143620), forestB: col(0x2b3220), dirt: col(0x6f5438), dirtB: col(0x5b432e) },
    haze: { color: 0x9fb2a0, k: 0.32 }, sky: { zenith: 0x2a5aa0, mid: 0x6f9fd0 },
    sun: 0.92, far: { grass: 0x2f6a38, dry: 0x5b7a3e, forest: 0x1f4a2b, rock: 0x6c6c5c },
    deco: { fern: 2.6, bush: 1.8, flowers: 0.4 },
  },

  desert: {
    id: 'desert',
    pal: dim({
      grassA: col(0xc9ab6a), grassB: col(0xd5b878), grassC: col(0xe0c78a), grassD: col(0xd0b476), forest: col(0x66763a), forestB: col(0x806f3a),
      sand: col(0xe3cf95), sandWet: col(0xa8946a), sandDry: col(0xecdca4), seabedDeep: col(0x1e4a58), dirt: col(0xa9784a), dirtB: col(0x8f6540), soil: col(0x7a5636),
      rockA: col(0x9b6a4a), rockB: col(0xc08e5e), rockWarm: col(0xa87a52),
    }, 0.74),
    tex: { grass_a: 'sand', grass_b: 'sand', grass_c: 'mud' },
    haze: { color: 0xe6cfa0, k: 0.55 }, sky: { zenith: 0x3e78c4, mid: 0xa5c4dc }, sun: 0.95, noFarTrees: true,
    far: { grass: 0xa8905a, dry: 0xb89f68, forest: 0x7a7a3a, rock: 0x9a6c48 },
    deco: { cactus: 0.016, dune: 0.012, dryTuft: 0.05, bush: 0, fern: 0, flowers: 0 },
  },

  winter: {
    id: 'winter',
    pal: dim({
      grassA: col(0xdfe7ef), grassB: col(0xe8eff6), grassC: col(0xf1f6fb), grassD: col(0xd2dde8), forest: col(0x7f8d98), forestB: col(0x6b7882),
      sand: col(0xc4cfda), sandWet: col(0x8ea3b8), sandDry: col(0xd6dfe8), seabedDeep: col(0x1d3b55), dirt: col(0x8a7f78), dirtB: col(0x756b66), soil: col(0x6d625c),
      rockA: col(0x59626f), rockB: col(0x8e9aa8), rockWarm: col(0x7a7f88),
    }, 0.9),
    tex: { grass_a: 'snow', grass_b: 'snow', grass_c: 'snow' },
    haze: { color: 0xc9d6e4, k: 0.5 }, sky: { zenith: 0x5a85b8, mid: 0xb4cde2 }, sun: 0.85,
    far: { grass: 0xdde6ee, dry: 0xcdd9e6, forest: 0x8a99a4, rock: 0x8c97a5 },
    deco: { snow: 0.045, bush: 0.3, fern: 0, flowers: 0 },
  },

  coast: {
    id: 'coast',
    pal: { sand: col(0xe0d19b), sandDry: col(0xe9dca8), sandWet: col(0x9a8e66) },
    haze: { color: 0xd4dfe0, k: 0.25 }, sky: { zenith: 0x1f5db8, mid: 0x74b0ee }, sun: 1.0,
    far: { grass: 0x58934a, dry: 0x8ca152, forest: 0x2f6a3d, rock: 0x7b7968 },
    deco: { reed: 0.4, wreck: 0.004, bush: 0.7 },
  },
};

// The biome of a map type. With a theme (a loaded Theme) the colours of its ground and light slots are laid over it (render/theme/ground-theme.mjs); without a theme, or with
// one that has neither slot, the result is the very object of BIOMES, so the classic look stays as it was.
export const biomeOf = (type, theme) => { const base = BIOMES[type] || BIOMES.meadow; return theme ? themedBiome(base, theme) : base; };
