# THEME-DELIVERY: how words, files and rigs get into a theme (package C7)

Three tools, all new, none of them touches the game code or the sim. Many agents deliver to `dustmoon-v1` at the same time (names, models, sounds, rig keys, ground);
nobody edits `theme.json` by hand any more and nobody bakes into `UNITS.json` at the same time as another.

| Tool | Job |
|---|---|
| `tools/theme-assemble.mjs` | builds `theme.json` from the fragments in the theme folder (`parts/`), the same bytes for the same fragments |
| `tools/theme-deliver.mjs` | copies delivered files into the theme folder, turns the work note `PROVENANCE.json` into the six provenance fields and the sha256, writes them as a fragment |
| `tools/rig/bake-batch.mjs` | bakes several rigged units one after the other (`build-units.mjs --only`), merges `UNITS.json` key by key, proves the classic files did not move |

Order of work for a delivery: `theme-deliver --dry-run`, `theme-deliver`, `theme-assemble`, `node tools/theme-check.mjs <theme>`.
Nothing here deletes a file. Every tool refuses before it writes when something is wrong, and says what.

## 1. Fragments and theme-assemble

A fragment is a JSON file anywhere below `render/assets/themes/<id>-vN/parts/` (names with a leading dot are skipped). It is a PARTIAL `theme.json`: the same keys, only the part you own.
One agent, one file; names suggested (the tool does not care):

| Fragment | Content |
|---|---|
| `base.json` | `schema`, `id`, `version`, `name`, `description`, `fallback`, `status`, `legal` |
| `units/<sim id>.json`, `buildings/<sim id>.json` | `{ "units": { "archer": { "name": ..., "model": { "file": ..., "rig": "dustmoon_archer" } } } }` (one slot, or a piece of it) |
| `techs.json`, `ground.json`, `nature.json`, `light.json`, `event_sounds.json` | the world slots and the tech words (or `nature/trees.json` ... pieces of them) |
| `assets/<delivery>.json` | the manifest entries of one delivery (theme-deliver writes it) |

Merge rule: objects merge key by key. A value (string, number, list, `null`) that two fragments give to the same path must be the same one, else it is a CONFLICT
that names both files and the path, and nothing is written. The fragments are taken in file name order (code unit order), so the message is always the same.
One exception, only in `assets`: a `final` entry replaces a `placeholder` entry of the same file (a delivery fulfils the promise). Two different `final` entries are a conflict:
a final file is never edited (THEME-VERTRAG.md section 2), a change is a new theme version.

Output: keys in one canonical order (top level as `TOP_KEYS` of the schema, slot fields as the contract lists them, `assets` and all id lists in code unit order), two-space JSON,
objects that fit into 160 characters on one line, one line per asset, a newline at the end. The theme hash (first 16 hex digits of the sha256 of the bytes) is then a function of the content only.

```
node tools/theme-assemble.mjs dustmoon-v1              write theme.json (refused on: conflicts, schema errors, keys that the old file has and no fragment has)
node tools/theme-assemble.mjs dustmoon-v1 --dry-run    everything but the write
node tools/theme-assemble.mjs dustmoon-v1 --check      exit 1 when theme.json is not what the fragments give (CI, before a merge)
node tools/theme-assemble.mjs dustmoon-v1 --strict     the release gate of theme-check on the result (placeholders and an unverified name check are errors)
                                          --force      write even with schema errors        --allow-drop   let keys of the old theme.json go
```
Exit code 0 = done, 1 = refused or out of date, 2 = usage error. The checks are the schema's (`validateTheme`, sim ids, tech ids, event ids, clip names); the files themselves are `theme-check`'s.

One time, from a hand-written `theme.json`: `node tools/theme-assemble.mjs dustmoon-v1 --split` writes `base.json`, `assets/initial.json`, `units/<id>.json`, `buildings/<id>.json`, `techs.json` ...
and first proves that the fragments give back exactly the same theme. After the first assemble only the order of the `assets` lines differs from the hand-written file.

### The folder: `parts/` or `.parts/`
`theme-check` (C0) lists every file of the theme folder that is not in `assets`, but skips paths with a dot. So today `parts/*.json` makes `node tools/theme-check.mjs <theme>` fail with
`file is not listed in assets`. Three ways out:
1. `.parts/` instead of `parts/` (`--split --hidden`, or rename the folder). The tools use `parts/` when it exists, else `.parts/`; both at once is an error. Nothing else to do.
2. Teach `theme-check` to skip `parts/`: in `tools/theme-check.mjs` the line `const files = new Set(walk(dir).filter((f) => f !== 'theme.json' && ...` gets `&& !f.startsWith('parts/')`.
   The patch is `PAKET-C7-optional-theme-check-parts.diff` (kept outside this package, because the package only adds files).
3. Keep the fragments outside the theme folder and name the folder every time (`--parts <dir>` of theme-assemble and theme-deliver).

Shipped in this package: no fragments folder in `dustmoon-v1`, `theme.json` is unchanged, `theme-check dustmoon-v1` exits 0.

## 2. Deliveries and theme-deliver

A delivery is a folder with the files and one `PROVENANCE.json`, the work note (ASSET-AUFTRAG-ARC-GUNNER.md section 6.3, step S12b):
```json
{ "defaults": { "generator": "Hunyuan3D", "model_version": "2.1", "licence_note": "Tencent Hunyuan 3D 2.1 Community License (to verify)",
                "credits": "3D mesh and texture: Hunyuan3D 2.1 (Tencent), seed 42, modified (decimated, re-baked, rigged)" },
  "files": [ { "file": "models/archer.glb", "source": "work/arc-gunner.glb", "prompt_file": "prompt-A.txt", "seed": 42, "reference": "A2.png", "job_id": "..." },
             { "file": "audio/archer_shot.ogg", "generator": "make-theme-sounds.mjs", "model_version": null, "prompt": "laser shot: sine sweep plus noise burst, 0.4 s", "seed": null,
               "licence_note": "own code", "credits": "Sound: own code" } ] }
```
A bare list of records works too. `file` is the target path inside the theme folder; `source` (default: the same path inside the delivery) is the file when it has another name.

| Work note | Six fields of the contract |
|---|---|
| `generator` + `model_version` | `generator` ("Hunyuan3D" + "2.1" = "Hunyuan3D 2.1"; nothing twice; `null` cancels a default) |
| `prompt`, or the text of `prompt_file` (for sounds made by code: the recipe) | `prompt` (not both) |
| `seed` (the key must be there; `null` only for hand-made work and code) | `seed` |
| `licence_note` (or `license`) | `license` |
| `credits` | `credits` |
| the file | `sha256` (`status` is `final`; `kind` comes from folder and extension) |
| `reference`, `settings`, `date`, `job_id`, `modified_by`, anything else | stays in the work note |

```
node tools/theme-deliver.mjs dustmoon-v1 <delivery folder> --dry-run      plan and check, write nothing
node tools/theme-deliver.mjs dustmoon-v1 <delivery folder> [--assemble]    copy, write parts/assets/<folder name>.json (--name to choose, --parts <dir>), assemble
```
All or nothing: every record is checked first (six fields there, path rules of the schema, the file exists and is a real glb / PNG / JPEG / Opus Ogg, no file twice, fragment name free);
nothing is copied when one is wrong. Files are copied (never moved), with an sha256 check after the copy, and never over another file: other bytes under a name that is `final` in the theme
are refused (a final file is never edited); the same bytes again are "unchanged"; a final entry whose file is missing is restored. The theme needs fragments (`--split` first).
Triangle budgets, sizes, anchors, LOD order: that is `theme-check`, run it next.

## 3. Baking and bake-batch

`build-units.mjs` writes `UNITS.json` whole at the end of every run. Two bakes at once lose each other's entry. `bake-batch.mjs` is the safe way:
```
node tools/rig/bake-batch.mjs 90-dustmoon-a 91-dustmoon-b [--dry-run]     units.json folders or registry keys, one bake after the other
node tools/rig/bake-batch.mjs --missing                                   every unit of units.json that has no entry in UNITS.json yet
        --rebake (a key that is baked already)   --keep-going   --anim-only (clips only)   --log <dir>   --timeout <s>   -- <more options for build-units>
```
Before: sources and LOD glbs there (warning for missing LODs), a best-effort lock per output folder (a file with the pid in the temp folder, rewritten, never deleted), a copy of `UNITS.json` as
`UNITS.json.vor-bake-<date>` and the sha256 of every file, both in the log folder (default `<temp>/bake-batch-<date>`, not in the game folder). After every unit: entry, files and LODs are there, no clip table of a
known family changed (a new family such as `human_x` is allowed), no other entry changed. At the end: `UNITS.json` is merged key by key (old entries in their order, then the baked ones; written only when the file
on disk is not already that; when nothing was baked, or a clip table or the file itself broke, it is put back byte for byte as it was before), and every file that does not belong to a baked key has the sha256 it had (a changed classic file is a problem, a new unknown file a warning).
Exit code 0 = all baked and all checks passed, 1 = a bake or a check failed, 2 = usage error. Log folder: report, snapshots, one log per unit.

Measured 03.11.2026 (`--anim-only 1`, current tree, Node 22.22.3, all 14 classic bodies): the re-bake reproduces `UNITS.json` byte for byte and the 3 rider `.anim` files byte for byte. Each of the 11 human `.anim` files
differs in 6 of its 117 936 half floats, all six are +0 against -0 (3 frames, `farm` frame 13, `gather` frames 7 and 23; the values are equal); Node 26.3.1 gives a different file for the 3 human bodies tried as well. So never prove
"the classic files did not move" by re-baking them and `cmp`: bake only new keys, and let bake-batch compare the sha256 of everything else.

## 4. Not covered
Wiring a delivered model into a slot (`units.<id>.model`, `lods`, `tiers`): write that fragment by hand (the file names are fixed by the contract: `<id>.glb`, `<id>_lod1.glb` ...). The rig fit (`units.json` entries,
`units.d/`, `--out`) belongs to package R1. Lexicon text and the name check: N1 and C1.
