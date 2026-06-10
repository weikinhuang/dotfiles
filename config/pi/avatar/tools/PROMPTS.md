# Avatar sprite-set generation

A character-agnostic workflow for producing a pixel-art PNG sprite set for the
[avatar extension](../../extensions/avatar.md) using either a hosted web image UI or a self-hosted ComfyUI backend. You
bring a character and reference images; the tooling here renders the prompts and slices the generated sheets into the
per-state frame files the extension loads. Both backends are anchored to one approved "hero" bust for cross-state and
cross-group consistency (see [Local ComfyUI backend](#local-comfyui-backend-hero-anchored-abc) below).

Everything character-specific (reference images, your identity blurb, the generated art) stays device-local and is
gitignored; only the tooling is committed.

## Pieces

| File                                             | Role                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [`sprite-manifest.ts`](./sprite-manifest.ts)     | Source of truth: state groups, grid, target size, chroma, frame hints                 |
| [`prompt-lib.ts`](./prompt-lib.ts)               | Shared prompt builders: `cellPrompt` / `buildPrompt`, guards, `HERO_CLAUSE`           |
| [`print-prompts.ts`](./print-prompts.ts)         | Renders ready-to-paste sheet (`--sheet`), cell (`--cell`), hero, or reference prompts |
| [`workflow-registry.ts`](./workflow-registry.ts) | Loads/validates `avatar-ref/workflows.json` (per-model ComfyUI graph mapping)         |
| [`gen-comfyui.ts`](./gen-comfyui.ts)             | Drives a self-hosted ComfyUI directly (hero bootstrap, edit-from-canonical)           |
| [`compare-sheet.ts`](./compare-sheet.ts)         | A/B/C HTML page comparing per-model outputs under `avatar-ref/gen/<model>/`           |
| [`assemble-sheets.ts`](./assemble-sheets.ts)     | Montages a winning model's per-cell PNGs back into sliceable grid sheets              |
| [`slice-sheets.ts`](./slice-sheets.ts)           | Slices generated sheets into `<state>/<frame>.png` (uses `magick`)                    |
| [`contact-sheet.ts`](./contact-sheet.ts)         | Builds a self-contained HTML preview of a sliced set to eyeball                       |

All are plain TypeScript; Node 24 runs them directly (`node <script>.ts`), no build step.

## How it works

Each state has an ordered list of frames; the extension cycles through whatever exists. Most states have 2 frames (a
base + a blink/beat), but states that animate more - `talk` (mouth shapes), `read`/`write`/`tool` (motion), and lively
emotions like `laugh`, `cry`, `panic`, `celebrate` - declare 3-4. See `frames` in
[`sprite-manifest.ts`](./sprite-manifest.ts).

Frames are generated as themed grid "sheets" (4x3 = 12 cells) on a flat `#00FF00` background. Per group, every
`(state, frame)` cell is flattened in state-then-frame order and packed densely into sequentially named sheets `1`, `2`,
… of 12 cells each (every sheet full except the last). The slicer finds the real cell boundaries from the green gutters
between cells (a gutter is green across the full width/height; the character breaks that up), crops each cell's exact
interior between those grid lines, keys out the green and the registration border, and writes it to
`<state>/<frame>.png` in reading order. Cropping every cell to the same detected boundaries keeps a state's frames
registered (head/halo locked, only arms/mouth/props move) and the same size across sheets. A sheet that can't
self-detect (e.g. an entirely blank edge row that merges into the margin) reuses another sheet's grid from the same
group, so slice a group's sheets together. Each frame is force-fit to one shared canvas with no inset or padding, so the
box contents fill the frame exactly. Blank cells are skipped, partial sets are fine, so generate in batches.

Groups: `activities`, `positive`, `affection`, `negative`, `shock`, `lowenergy`, `reactions`, `social`, `devotion`,
`workflow`, `sultry`, `insight`, `composure`, `bonding`, `closeness`, `antics`, `desire`, `intensity`, `intimacy`. State
names match the kaomoji keys in [`../emotes/ascii/ascii.yaml`](../emotes/ascii/ascii.yaml) (the `desire` / `intensity` /
`intimacy` groups match the opt-in [`mature`](../emotes/mature/ascii.yaml) overlay).

## Steps

### 1. Prep reference images (one-time)

Downscale/convert your art to upload-friendly copies, e.g. with ImageMagick:

```bash
mkdir -p avatar-ref/web
for f in avatar-ref/*.png; do
  clean=$(basename "$f" .png | tr 'A-Z' 'a-z' | tr -d '#')
  magick "$f" -resize '1024x1024>' -background white -alpha remove -quality 85 "avatar-ref/web/${clean}.jpg"
done
```

### 2. Write an identity blurb

Put a one-line description of your character in a local (gitignored) file - hair, eyes, outfit, vibe

- and tell the model to match the attached references:

```bash
echo 'Exusiai: short dark-crimson hair, red eyes, white halo ring, white+black red-accent ANGEL hoodie, cheerful sniper; match the attached reference images' > avatar-ref/identity.txt
```

Optionally build cleaner identity references first (each takes the original art as input, sits on a plain background,
and is never sliced). A clean turnaround makes a far better attachment than scattered original art, and the cascade is
_original art → turnaround → hero bust → sheets_:

```bash
node config/pi/avatar/tools/print-prompts.ts --turnaround --identity-file avatar-ref/identity.txt           # bust, 4 angles
node config/pi/avatar/tools/print-prompts.ts --full-body --identity-file avatar-ref/identity.txt            # head-to-toe figure
node config/pi/avatar/tools/print-prompts.ts --full-body-turnaround --identity-file avatar-ref/identity.txt # full figure, 4 angles
```

The same flags work on `gen-comfyui.ts` for the local backend (writes `avatar-ref/gen/<model>/<kind>.<seed>.png`). When
generating sheets in a multi-attachment web UI, attach the **hero bust first** (it anchors crop/style/framing) and add a
turnaround as a supplemental angle reference; drop the original art at that point.

### 3. Print and paste a prompt

Each group is a run of densely packed sheets named `1`, `2`, … (every sheet full except the last). Generate them in the
same chat/session so the character stays consistent, attaching the approved hero bust (and 1-3 images from
`avatar-ref/web/`):

```bash
node config/pi/avatar/tools/print-prompts.ts --group activities --sheet 1 --identity-file avatar-ref/identity.txt
node config/pi/avatar/tools/print-prompts.ts --group activities --sheet 2 --identity-file avatar-ref/identity.txt
# or print every sheet for a group (or omit --group for everything):
node config/pi/avatar/tools/print-prompts.ts --group activities --identity-file avatar-ref/identity.txt
# per-cell prompts instead of grid sheets (for single-image generators/APIs):
node config/pi/avatar/tools/print-prompts.ts --cell --group activities --identity-file avatar-ref/identity.txt
```

### 4. Download the sheets

Save each generated image as `<group>.<sheet>.png` into a sheets folder, e.g. `avatar-ref/sheets/activities.1.png`,
`avatar-ref/sheets/activities.2.png` (and `.3.png` if the group needs a third sheet).

### 5. Slice into the set

Slicing defaults to the path the extension scans, `~/.pi/agent/avatar/emotes/<set>` (honoring `PI_CODING_AGENT_DIR`):

```bash
node config/pi/avatar/tools/slice-sheets.ts --set exusiai --in avatar-ref/sheets
node config/pi/avatar/tools/slice-sheets.ts --set exusiai --check
```

### 6. Preview in a browser (optional)

Build a self-contained HTML page (frames embedded as base64) that shows every state's animated ping-pong preview plus
its individual frames, grouped by manifest group, with have/expected frame counts - handy for spotting registration or
scaling drift before wiring it up:

```bash
node config/pi/avatar/tools/contact-sheet.ts --set exusiai --out avatar-ref/contact.html
# one group only, or link to files instead of embedding:
node config/pi/avatar/tools/contact-sheet.ts --set exusiai --group sultry --out /tmp/sultry.html
```

### 7. Wire it up and test

Point the avatar at the set in your user config `~/.pi/agent/avatar.json` (not committed), then test in a kitty / iTerm2
terminal (`/avatar on`, drive activity, trigger `[emote:NAME]`):

```json
{ "emotes": [{ "model": "*", "emote-set": "exusiai" }] }
```

## Local ComfyUI backend (HERO-anchored, A/B/C)

The hosted flow above pastes prompts into a web UI. The local flow drives a self-hosted ComfyUI directly and adds an
_edit-from-canonical_ consistency strategy: one approved "hero" bust is the universal anchor every other sprite is
matched against (no character LoRA needed). The same hero serves both backends via the shared `HERO_CLAUSE` in
[`prompt-lib.ts`](./prompt-lib.ts).

Prereqs (all device-local / gitignored under `avatar-ref/`):

- A running ComfyUI reachable at `PI_COMFYUI_URL` (default `http://127.0.0.1:8188`).
- Models downloaded with `avatar-ref/download-models.sh`, the `ComfyUI-GGUF` (city96) and `ComfyUI_IPAdapter_plus`
  (cubiq) custom nodes installed, and the `PLACEHOLDER-*` names filled into each `avatar-ref/*.api.json` graph. The
  download script lists the exact model files + their ComfyUI subdirs, and each graph file documents its own wiring.
- A per-model registry at `avatar-ref/workflows.json` mapping each graph's `role` (`generate` | `edit`) and input nodes,
  validated by [`workflow-registry.ts`](./workflow-registry.ts).

Sanity check: `node config/pi/avatar/tools/gen-comfyui.ts --ping`.

1. **Bootstrap the hero.** Render one neutral front-facing bust and approve it as the identity + style anchor:

   ```bash
   # edit-role models (kontext / qwen-edit): bootstrap from your original character art
   node config/pi/avatar/tools/gen-comfyui.ts --workflow kontext --hero --canonical avatar-ref/char-art.png
   # generate-role models (anima / chroma / sdxl): txt2img
   node config/pi/avatar/tools/gen-comfyui.ts --workflow anima --hero
   ```

   Candidates land at `avatar-ref/gen/<model>/hero.<seed>.png`. Pick the best one and copy it to
   `avatar-ref/canonical.png`.

2. **A/B/C the models.** Generate a few states across candidate models, then eyeball identity/style/quality:

   ```bash
   node config/pi/avatar/tools/gen-comfyui.ts --workflow kontext --workflow qwen-edit \
     --canonical avatar-ref/canonical.png --group activities --limit 4
   node config/pi/avatar/tools/compare-sheet.ts --out avatar-ref/compare.html
   ```

   Each model writes per-cell PNGs to `avatar-ref/gen/<model>/<state>.<frame>.png`; `compare-sheet.ts` renders one row
   per `(state, frame)` x one column per model. `gen-comfyui.ts --dry-run` prints the cell prompts without generating.

3. **Full re-gen with the winner.** Generate every group against `canonical.png`, montage back into grid sheets, then
   slice exactly like the hosted flow (`assemble-sheets.ts` writes standard CHROMA-gutter sheets so the slicer is
   unchanged):

   ```bash
   node config/pi/avatar/tools/gen-comfyui.ts --workflow <winner> --canonical avatar-ref/canonical.png
   node config/pi/avatar/tools/assemble-sheets.ts --model <winner>   # -> avatar-ref/sheets/<group>.<sheet>.png
   node config/pi/avatar/tools/slice-sheets.ts --set <set> --in avatar-ref/sheets
   node config/pi/avatar/tools/slice-sheets.ts --set <set> --check
   ```

Edit-role workflows chain frames: per-state frame 0 is an edit of the hero; frames 1..N are edits of that state's
frame 0. Generate-role workflows fall back to per-cell txt2img with a stable per-state seed (weaker identity). Slicing
writes under `~/.pi`, so run those steps outside the sandbox / with full permissions.

## Tips

- A gpt-image-1-backed UI follows the reference images and grid instructions best. If a UI ignores the flat background,
  ask explicitly for "solid pure-green background, no scenery".
- The prompt asks for a thin cyan (`BORDER`) rectangle around every cell, all identical and evenly spaced, with a clear
  green margin between the art and the border. It keeps the model drawing each sprite at the same size and position and
  stops sprites bleeding into each other (detection itself reads the green gutters, not the border). The slicer keys the
  border out (`AVATAR_BORDER_FUZZ`, default `40%`) along with the green, so it never reaches the final frames. Image UIs
  desaturate the border (often to a near-green teal on sparse sheets), so `BORDER` must stay far from the character's
  palette - cyan for warm characters (red/orange/pink), magenta or orange for cool ones; change it in
  `sprite-manifest.ts` and lower the fuzz if it ever clips a character tone.
- Keying uses `AVATAR_CHROMA_FUZZ` (default `20%`) plus a 1px alpha erode to kill the green fringe AI UIs leave on soft
  edges. Raise the fuzz (`AVATAR_CHROMA_FUZZ=28% node ...`) if green still bleeds, or set `AVATAR_DEFRINGE=0` to keep
  every edge pixel (e.g. for very thin sprite details).
- Slicing finds the grid lines from the green gutters, crops each cell's exact interior, and force-fits it to one shared
  canvas, so a state's frames stay registered (head/halo locked, only arms/mouth/props move) and the same size across
  sheets. A sheet that can't self-detect (a fully blank edge row merges into the margin) reuses another sheet's grid
  from the same group; if no sheet in a group detects, it falls back to an even split (and prints a note). Set
  `AVATAR_SLICE=grid` to force the even split everywhere, `AVATAR_GUTTER_FRAC` (default `0.015`) to tune how empty a
  band must be to count as a gutter, or `AVATAR_DETECT_FUZZ` (default `28%`) to widen the green key used for detection.
- Sheets are independent and partial sets are fine: a state renders from whatever frames exist (frame 0 alone = no
  blink/cycle), so you can generate a subset of sheets and fill the rest in later. `--check` shows `have/expected`
  frames per state.
- Adjust frame lists, `TARGET_PX`, `GRID`, `CHROMA`, `BORDER`, or pose hints in `sprite-manifest.ts`; the prompts, sheet
  packing, and slicing all follow automatically.
