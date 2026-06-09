# Avatar sprite assets + generation tooling

This directory holds the `avatar` pi extension's character-agnostic sprite-generation tooling and its committed kaomoji
sets. The extension runtime lives elsewhere: the shell is [`../extensions/avatar.ts`](../extensions/avatar.ts), its deep
doc is [`../extensions/avatar.md`](../extensions/avatar.md), and its pure logic + types are under
[`../../../lib/node/pi/avatar/`](../../../lib/node/pi/avatar/). See the root [AGENTS.md](../../../AGENTS.md) for
repo-wide rules; this file documents only what is specific to avatar assets.

## Why this exists

The avatar is a reactive TUI pixel-art bust that animates with the agent's activity and shows LLM-triggered emotions.
Each visual state is a short sequence of pixel-art frames. Rather than hand-draw hundreds of frames, the tooling here
renders generation prompts from a single manifest, slices the resulting sheets into the per-state frame files the
extension loads, and previews them. You bring a character + reference images; everything character-specific stays
device-local.

## Layout

| Path                                                     | What it is                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`tools/sprite-manifest.ts`](./tools/sprite-manifest.ts) | Single source of truth: state groups, grid, target size, chroma, frame hints |
| [`tools/print-prompts.ts`](./tools/print-prompts.ts)     | Renders ready-to-paste generation prompts from the manifest                  |
| [`tools/slice-sheets.ts`](./tools/slice-sheets.ts)       | Slices generated sheets into `<state>/<frame>.png` (uses ImageMagick)        |
| [`tools/contact-sheet.ts`](./tools/contact-sheet.ts)     | Builds a self-contained HTML preview of a sliced set                         |
| [`tools/PROMPTS.md`](./tools/PROMPTS.md)                 | The end-to-end generation workflow (start here to actually generate art)     |
| [`emotes/ascii/ascii.yaml`](./emotes/ascii/ascii.yaml)   | Shared default kaomoji set (committed; the always-present base layer)        |
| [`emotes/mature/ascii.yaml`](./emotes/mature/ascii.yaml) | Generic opt-in kaomoji overlay (committed)                                   |
| [`config.example.json`](./config.example.json)           | Example avatar config                                                        |

The tools are plain TypeScript; Node 24 runs them directly (`node <script>.ts`), no build step.

## Two trigger paths (know which you are touching)

- **Activity states** (`hi, idle, wait, think, talk, read, write, tool, debug, plan, fetch, success, failure, compact`)
  are auto-driven from pi lifecycle / tool events. Adding or changing one needs code in
  [`../../../lib/node/pi/avatar/types.ts`](../../../lib/node/pi/avatar/types.ts) (`ACTIVITY_STATES`),
  [`state.ts`](../../../lib/node/pi/avatar/state.ts), and [`../extensions/avatar.ts`](../extensions/avatar.ts).
- **Emotions** are every other state name. They are auto-classified, auto-advertised to the model, and triggered inline
  with `[emote:NAME]`. They need NO per-name code - just a manifest entry and/or a kaomoji key and/or a sprite dir.

## Generation backends

- **Hosted (current):** render prompts -> paste into an image web UI or API (OpenAI image / Firefly / Flux) -> download
  grid sheets -> slice -> preview. Full steps in [`tools/PROMPTS.md`](./tools/PROMPTS.md).
- **Local ComfyUI (planned):** a standalone `gen-comfyui.ts` that drives a self-hosted ComfyUI directly with an
  edit-from-canonical consistency strategy and an A/B/C model-comparison harness. When added, it ships next to the other
  `tools/` scripts and is documented in [`tools/PROMPTS.md`](./tools/PROMPTS.md).

## Using the tooling (quickstart)

```bash
# 1. print prompts for a group (identity blurb + reference images are device-local under avatar-ref/)
node config/pi/avatar/tools/print-prompts.ts --group activities --identity-file avatar-ref/identity.txt
# 2. generate the sheets in an image UI, save as avatar-ref/sheets/<group>.<sheet>.png
# 3. slice into the set the extension scans (~/.pi/agent/avatar/emotes/<set>)
node config/pi/avatar/tools/slice-sheets.ts --set <set> --in avatar-ref/sheets
node config/pi/avatar/tools/slice-sheets.ts --set <set> --check
# 4. eyeball it
node config/pi/avatar/tools/contact-sheet.ts --set <set> --out avatar-ref/contact.html
```

## Conventions / boundaries

- **The manifest is the source of truth.** Add a state to a group's `states` + `poses` (+ `frames` for >2 frames) and a
  kaomoji key; prompts, sheet packing, and slicing all follow automatically. Keep the manifest name, kaomoji key, sprite
  dir, and `[emote:NAME]` marker identical (hyphens allowed).
- **Suggestive / mature groups** must carry the SFW guard: add the group to `GROUP_GUARDS` in
  [`tools/prompt-lib.ts`](./tools/prompt-lib.ts) (head-and-shoulders, fully clothed, expression-driven only).
- **Committed vs device-local.** Only tooling + generic kaomoji (`ascii`, `mature`) are committed. Generated sheets,
  sliced sets (`~/.pi/agent/avatar/emotes/<set>`), reference images, identity blurb, and any character-specific overlay
  (e.g. an `exusiai` set) are device-local and never committed. Per the `.gitignore` here, `emotes/**/*.png`,
  `emotes/default/`, and `emotes/**/emotes.json` are ignored.
- **Kaomoji overlays layer** (shared default -> base set -> `overlays[]`, last wins). Document any user-facing config
  knob in [`../extensions/avatar.md`](../extensions/avatar.md).
- **Gates after edits:** `npm run tsc`, `npx oxlint`, `npx vitest run` for any TypeScript under `tools/` or
  `lib/node/pi/avatar/`; format markdown with `npx oxfmt`.

## References

- [`tools/PROMPTS.md`](./tools/PROMPTS.md) - the generation workflow.
- [`../extensions/avatar.md`](../extensions/avatar.md) - extension behavior, config keys, sets, overlays.
- [`../../../lib/node/pi/avatar/`](../../../lib/node/pi/avatar/) - pure logic (config, emotes, state, types) + tests.
