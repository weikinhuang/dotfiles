# Avatar sprite assets + generation tooling

This directory holds the `avatar` pi extension's character-agnostic sprite-generation tooling and its committed kaomoji
sets. The extension runtime lives elsewhere: the shell is [`../extensions/avatar.ts`](../extensions/avatar.ts), its deep
doc is [`../extensions/avatar.md`](../extensions/avatar.md), and its pure logic + types are under
[`../../../lib/node/pi/avatar/`](../../../lib/node/pi/avatar/). The avatar is a reactive TUI pixel-art bust; the tooling
here renders generation prompts from a single manifest, slices the resulting sheets into per-state frame files, and
previews them. You bring a character + reference images; everything character-specific stays device-local. Tools are
plain TypeScript run directly by Node 24 (no build step). See the root [AGENTS.md](../../../AGENTS.md) for repo rules.

## Commands

```bash
# 1. print prompts for a tier (identity blurb + reference images are device-local under avatar-ref/)
node config/pi/avatar/tools/print-prompts.ts --tier standard --identity-file avatar-ref/identity.txt
# 2. generate the sheets in an image UI, save as avatar-ref/sheets/<tier>.<n>.png
# 3. slice into the set the extension scans (~/.pi/agent/avatar/emotes/<set>)
node config/pi/avatar/tools/slice-sheets.ts --set <set> --in avatar-ref/sheets
node config/pi/avatar/tools/slice-sheets.ts --set <set> --check
# 4. eyeball it
node config/pi/avatar/tools/contact-sheet.ts --set <set> --out avatar-ref/contact.html
```

## Directory map

| Path                                                         | Purpose                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [`tools/sprite-manifest.ts`](./tools/sprite-manifest.ts)     | Single source of truth: state groups, grid, target size, chroma, frame hints            |
| [`tools/prompt-lib.ts`](./tools/prompt-lib.ts)               | Shared prompt builders, SFW guards, `HERO_CLAUSE`, `heroPrompt`, `cellPrompt`           |
| [`tools/print-prompts.ts`](./tools/print-prompts.ts)         | Renders sheet / cell / hero generation prompts from the manifest                        |
| [`tools/gen-sprite-doc.ts`](./tools/gen-sprite-doc.ts)       | Renders the full paste-into-a-web-UI sprite-prompt doc (preamble + fenced sheets)       |
| [`tools/workflow-registry.ts`](./tools/workflow-registry.ts) | Loads + validates the device-local `avatar-ref/workflows.json` graph map                |
| [`tools/gen-comfyui.ts`](./tools/gen-comfyui.ts)             | Drives a self-hosted ComfyUI directly (hero bootstrap, edit-from-canonical)             |
| [`tools/compare-sheet.ts`](./tools/compare-sheet.ts)         | A/B/C HTML page comparing per-model `avatar-ref/gen/<model>/` outputs                   |
| [`tools/assemble-sheets.ts`](./tools/assemble-sheets.ts)     | Montages a winning model's per-cell PNGs back into sliceable grid sheets                |
| [`tools/slice-sheets.ts`](./tools/slice-sheets.ts)           | Slices generated sheets into `<state>/<frame>.png` (uses ImageMagick)                   |
| [`tools/contact-sheet.ts`](./tools/contact-sheet.ts)         | Builds a self-contained HTML preview of a sliced set                                    |
| [`tools/PROMPTS.md`](./tools/PROMPTS.md)                     | The end-to-end generation workflow (start here to actually generate art)                |
| [`emotes/`](./emotes/)                                       | Committed generic kaomoji: `ascii/` shared default base layer, `mature/` opt-in overlay |
| [`config.example.json`](./config.example.json)               | Example avatar config                                                                   |

## Key patterns

### Two trigger paths (know which you are touching)

- **Activity states** (`hi, idle, wait, think, talk, read, write, tool, debug, plan, fetch, success, failure, compact`)
  are auto-driven from pi lifecycle / tool events. Adding or changing one needs code in
  [`../../../lib/node/pi/avatar/types.ts`](../../../lib/node/pi/avatar/types.ts) (`ACTIVITY_STATES`),
  [`state.ts`](../../../lib/node/pi/avatar/state.ts), and [`../extensions/avatar.ts`](../extensions/avatar.ts).
- **Emotions** are every other state name. They are auto-classified, auto-advertised to the model, and triggered inline
  with `[emote:NAME]`. They need NO per-name code - just a manifest entry and/or a kaomoji key and/or a sprite dir.

### Manifest + kaomoji conventions

- **The manifest is the source of truth.** Add a state to a group's `states` + `poses` (+ `frames` for >2 frames) and a
  kaomoji key; prompts, sheet packing, and slicing all follow. Sheets are partitioned by **tier** (`standard` /
  `suggestive` / `mature`) and packed whole-emote-block (`<tier>.<n>`) so frames never split across a sheet; append new
  emotes to the END of a tier so only its tail sheet re-generates. Keep the manifest name, kaomoji key, sprite dir, and
  `[emote:NAME]` marker identical (hyphens allowed).
- **Suggestive / mature groups** must carry the SFW guard: set the group's `tier` to `suggestive`/`mature` (guards sheet
  prompts) AND add it to `GROUP_GUARDS` in [`tools/prompt-lib.ts`](./tools/prompt-lib.ts) (guards per-cell prompts).
- **Kaomoji overlays layer** (shared default -> base set -> `overlays[]`, last wins); document user-facing config knobs
  in [`../extensions/avatar.md`](../extensions/avatar.md).

## Boundaries

**Always**: run `npm run tsc`, `npx oxlint`, `npx vitest run` after TypeScript edits under `tools/` or
`lib/node/pi/avatar/`; format markdown with `npx oxfmt`.

**Ask first**: changing what counts as committed vs device-local; adding a new generation backend.

**Never**: commit generated sheets, sliced sets (`~/.pi/agent/avatar/emotes/<set>`), reference images, identity blurbs,
or character-specific overlays - only tooling + generic kaomoji (`ascii`, `mature`) are committed (see the `.gitignore`
here).

## References

- [`tools/PROMPTS.md`](./tools/PROMPTS.md) - the generation workflow (hosted + local-ComfyUI backends).
- [`../extensions/avatar.md`](../extensions/avatar.md) - extension behavior, config keys, sets, overlays.
