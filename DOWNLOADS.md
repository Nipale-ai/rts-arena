# Optional asset packs

This repository contains code, tests, configs and the vendored three.js only. It ships **no** 3D models, textures, music, sound effects or voices.
The game runs without any of them: without the model pack it draws its procedural models (`?models=classic` is the default look when the pack is missing), and without the sound set it is silent.

The packs below are made for the original project. They are **not published yet**; this file records what they are and under which terms they may be used, so that a published pack comes with the right notice.
Each pack goes into the folder named in its row; no other setup is needed.

| Pack | Goes into | What | Terms (one line, with source and date) |
|---|---|---|---|
| Model pack "art-v2" | `render/assets/models/` | building, tree, deco, resource and unit models (`.glb`, `.anim`, textures) | Origin not recorded in this repository: **TO VERIFY** before it is published (checked 05.11.2026). |
| Example theme "dustmoon" (v1, v2) | `render/assets/themes/dustmoon-v2/` | a re-skin: names, models, ground, light, sounds | v2 buildings were made with Hunyuan3D 2.1. Tencent Hunyuan 3D 2.1 Community License: the licence territory excludes the EU, the UK and South Korea (section 1(l)), more than 1 million monthly active users need a separate licence, and outputs must not be used to improve other AI models (section 5(b)). Source: https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE, read 05.11.2026. The origin of the v1 models is not recorded: **TO VERIFY**. |
| Sound set | `render/assets/audio/` | sound effects, ambience, music (OGG/Opus) and `manifest.json` | Effects: MOSS-SoundEffect, Apache-2.0 per its Hugging Face model card (https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect, 05.11.2026). Music: ACE-Step 1.5, MIT (https://github.com/ace-step/ACE-Step-1.5, 05.11.2026). Whether a model licence covers its output is **TO VERIFY**. |
| Caster voices | `RTS_VOICES_DIR` (`caster_a/`, `caster_b/`) | reference clips for the commentary voices | Made with Fish Audio Drama 3 under the Fish Audio Community License: free commercial use only while annual revenue is below USD 500,000, "Built with Fish Audio" attribution, no hosted service (https://huggingface.co/fishaudio/drama-3/blob/main/LICENSE, 05.11.2026). Check the terms of the voice you clone. |

If you build your own packs, the formats are defined by the loaders in the source: `render/assets3d.mjs` (models, `MAP.json`), `render/audio.mjs` (`manifest.json`) and `render/theme/` (themes).
Tests that need a pack are not part of this copy. Run `npm test` after installing a pack to see what the pack changes.
