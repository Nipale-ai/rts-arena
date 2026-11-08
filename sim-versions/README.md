# Sim versions: every saved replay stays playable

A replay is seed + command log. It only reproduces the match with the exact sim it was recorded with. So the sim is versioned and old versions are kept.

## Design

- **Version id** = `sim-` + 12 hex of sha256 over all files in `sim/` (sorted names + bytes, line endings normalised). Rules presets and unit data live in `sim/`, so they are in the hash. `sim/` itself is not touched: the code is in `sim-versions/lib.mjs`.
- **Snapshot** `sim-versions/<id>/sim/*.mjs` = the exact files, plus `meta.json` (date, commits) and `golden/*.jsonl` (scripted matches recorded with that sim; each must re-simulate bit-exactly with it).
- **Stamp**: every new recording writes `sim_version` into its start line (`server/live-match.mjs`, `server/spectate.mjs`, `tools/run-match.mjs`) and into `data/matches/<id>.json` (`server/arena.mjs`). Old replays get the sidecar `sim-version.json` from `tools/sim-backfill.mjs`; their `log.jsonl` is never edited.
- **Loading**: `loadSim(id)` returns a bundle (`Game`, `observe`, `UNITS`, `BUILDINGS`, `feedOf`, ...). The current id loads `sim/`, any other id its snapshot (hash checked first). Loading is synchronous (`require(esm)`), so constructors stay synchronous. Missing modules of old versions (intent, standing, presets) get neutral stand-ins; `adaptGame` adds `godFeed`/`proj` defaults.
- **Consumers** that run a replay use `rep.sim` / `simForReplay`: `server/replay-verify.mjs`, `tools/lib/replay.mjs` (so `tools/events.mjs`, `render-broadcast.mjs`, `audio-mix.mjs`, `casters.mjs`, `cam-report.mjs`, `bc-determinism.mjs`), and `Match` in `server/spectate.mjs` (arena replay pages, broadcast renderer). An unstamped replay is refused with a pointer to the backfill tool; the loader never guesses.

Why a content hash plus full copies (not git SHAs, not "only the current sim"): a git SHA does not exist for working-tree states, depends on the repo being present, and several agents change `sim/` in parallel on different branches; a hash is the same wherever the files are. Full copies cost about 240 KB per version and need no build step, no git, no migration code. Snapshots have no registry file, so parallel branches never conflict on one.

## Workflow

- Changed `sim/` (any byte)? `node tools/sim-freeze.mjs`, commit `sim-versions/<new id>/`. The test `test/sim-version.test.mjs` and `node tools/sim-check.mjs` fail until you do. After merging two branches that both changed `sim/`, the merged state is a new version: freeze again.
- Recorders freeze the current files automatically (without goldens) so a stamp never points at nothing; `sim-freeze` adds the goldens.
- Old versions from git history: `node tools/sim-freeze.mjs --history` (all branches).
- Stamp old replays: `node tools/sim-backfill.mjs --replays <dir> [--data <dir>] [--dry]` (tries versions newest first until every recorded state hash and the result hash verify).
- Check everything: `node tools/sim-check.mjs [--replays <dir>]`.
- Never edit files under `sim-versions/<id>/sim/`; the test detects it.

## Limits

- Replays recorded with a working-tree state that was never committed cannot be matched; they are listed as unmatched by the backfill.
- Goldens use the current scripted bots on old sims, so old goldens are short and may play poorly; they only prove determinism, not rule coverage.
- Determinism across Node versions and CPUs is only as good as the sim's integer math; the goldens are the alarm for it.
