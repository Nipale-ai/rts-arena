# Credits

Third-party code and generated images that ship with this repository, with their source and licence. Everything here is taken from files in the repository. Where the repository does not record where something came from, the entry says **provenance to verify** and gives no guess.

## Code

| What | Where | Licence | Notes |
|---|---|---|---|
| three.js r170 | `render/vendor/three.module.js` | MIT, Copyright 2010-2024 three.js authors | Licence text: `render/vendor/three.LICENSE`. Revision from the file (`REVISION = '170'`). https://threejs.org/ |
| three.js add-ons: `GLTFLoader`, `BufferGeometryUtils`, `EffectComposer`, `MaskPass`, `Pass`, `RenderPass`, `ShaderPass`, `OutputPass`, `UnrealBloomPass`, `GTAOPass`, and the shaders `CopyShader`, `GTAOShader`, `LuminosityHighPassShader`, `OutputShader`, `PoissonDenoiseShader` | `render/vendor/jsm/` | MIT (part of the three.js repository) | The files carry no version header. They are expected to match r170: **version to verify**. Their headers cite papers and articles (ambient occlusion, bloom, denoising); those references are in the files. |
| SimplexNoise (three.js add-on) | `render/vendor/jsm/math/SimplexNoise.js` | MIT (part of the three.js repository) | "Ported from Stefan Gustavson's java implementation" (paper: http://staffwww.itn.liu.se/~stegu/simplexnoise/simplexnoise.pdf), with 4D noise added by Sean McCullough. Both credits are kept as in the file. |

The rest of the code (`sim/`, `agents/`, `server/`, `render/` outside `render/vendor/`, `ui/`, `tools/`, `test/`) is part of this project and under the licence in `LICENSE`. There are no npm dependencies.

## Sound, music, 3D models, textures

None of these ship with this repository. The optional packs, their contents and their terms are listed in [DOWNLOADS.md](DOWNLOADS.md).

## Creator banners

`configs/creators.json` and `render/assets/creators/` contain three generic banners (flat colours with a neutral shape), made for this repository. They contain no third-party artwork.

## Optional tools that are not shipped

- Caster voices (`tools/video-voices.mjs`) can use a local text-to-speech server such as Fish Audio Drama 3. No model or voice sample ships with this repository. The licence of the model and of any voice reference you use is yours to check.
- `ffmpeg`, Google Chrome and `puppeteer-core` are used by the video tools and are not part of this repository.

## Fonts

The pages use system font stacks (`Inter`, `JetBrains Mono` and the system fonts as fallbacks). No font files ship with this repository.
