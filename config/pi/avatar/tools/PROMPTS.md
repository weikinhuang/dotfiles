# Avatar sprite-set generation

A character-agnostic workflow for producing a pixel-art PNG sprite set for the
[avatar extension](../../extensions/avatar.md) using any web image UI. You bring a character and reference images; the
tooling here renders the prompts and slices the generated sheets into the per-state frame files the extension loads.

Everything character-specific (reference images, your identity blurb, the generated art) stays device-local and is
gitignored; only the tooling is committed.

## Pieces

| File                                         | Role                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [`sprite-manifest.ts`](./sprite-manifest.ts) | Source of truth: state groups, grid, target size, chroma, frame hints |
| [`print-prompts.ts`](./print-prompts.ts)     | Renders ready-to-paste prompts from the manifest                      |
| [`slice-sheets.ts`](./slice-sheets.ts)       | Slices generated sheets into `<state>/<frame>.png` (uses `magick`)    |

All three are plain TypeScript; Node 24 runs them directly (`node <script>.ts`), no build step.

## How it works

Each state has an ordered list of frames; the extension cycles through whatever exists. Most states have 2 frames (a
base + a blink/beat), but states that animate more - `talk` (mouth shapes), `read`/`write`/`tool` (motion), and lively
emotions like `laugh`, `cry`, `panic`, `celebrate` - declare 3-4. See `frames` in
[`sprite-manifest.ts`](./sprite-manifest.ts).

Frames are generated as themed grid "sheets" (4x3 = 12 cells) on a flat `#00FF00` background. Per group, sheet `a` holds
frame 0 of every state, sheet `b` holds frame 1, and any extra frames pack densely onto `x1` (and `x2`, ... if needed).
The slicer finds the real cell boundaries from the green gutters between cells (a gutter is green across the full
width/height; the character breaks that up), crops each cell's exact interior between those grid lines, keys out the
green and the registration border, and writes it to `<state>/<frame>.png` in reading order. Cropping every cell to the
same detected boundaries keeps a state's frames registered (head/halo locked, only arms/mouth/props move) and the same
size across `a`/`b`/`x1`. A sheet that can't self-detect (e.g. an entirely blank edge row that merges into the margin)
reuses another sheet's grid from the same group, so slice a group's sheets together. Each frame is force-fit to one
shared canvas with no inset or padding, so the box contents fill the frame exactly. Blank cells are skipped, partial
sets are fine, so generate in batches.

Groups: `activities`, `positive`, `affection`, `negative`, `shock`, `lowenergy`. State names match the kaomoji keys in
[`../emotes/ascii/ascii.yaml`](../emotes/ascii/ascii.yaml).

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

### 3. Print and paste a prompt

Each group has sheets `a` (frame 0), `b` (frame 1), and `x1` (extra animation frames). Generate them in the same
chat/session so the character stays consistent, attaching 1-3 images from `avatar-ref/web/`:

```bash
node config/pi/avatar/tools/print-prompts.ts --group activities --sheet a --identity-file avatar-ref/identity.txt
node config/pi/avatar/tools/print-prompts.ts --group activities --sheet b --identity-file avatar-ref/identity.txt
node config/pi/avatar/tools/print-prompts.ts --group activities --sheet x1 --identity-file avatar-ref/identity.txt
# or print every sheet for a group (or omit --group for everything):
node config/pi/avatar/tools/print-prompts.ts --group activities --identity-file avatar-ref/identity.txt
```

### 4. Download the sheets

Save each generated image as `<group>.<sheet>.png` into a sheets folder, e.g. `avatar-ref/sheets/activities.a.png`,
`avatar-ref/sheets/activities.b.png`, and `avatar-ref/sheets/activities.x1.png`.

### 5. Slice into the set

Slicing defaults to the path the extension scans, `~/.pi/agent/avatar/emotes/<set>` (honoring `PI_CODING_AGENT_DIR`):

```bash
node config/pi/avatar/tools/slice-sheets.ts --set exusiai --in avatar-ref/sheets
node config/pi/avatar/tools/slice-sheets.ts --set exusiai --check
```

### 6. Wire it up and test

Point the avatar at the set in your user config `~/.pi/agent/avatar.json` (not committed), then test in a kitty / iTerm2
terminal (`/avatar on`, drive activity, trigger `[emote:NAME]`):

```json
{ "emotes": [{ "model": "*", "emote-set": "exusiai" }] }
```

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
  `a`/`b`/`x1`. A sheet that can't self-detect (a fully blank edge row merges into the margin) reuses another sheet's
  grid from the same group; if no sheet in a group detects, it falls back to an even split (and prints a note). Set
  `AVATAR_SLICE=grid` to force the even split everywhere, `AVATAR_GUTTER_FRAC` (default `0.015`) to tune how empty a
  band must be to count as a gutter, or `AVATAR_DETECT_FUZZ` (default `28%`) to widen the green key used for detection.
- Sheets are independent: a state still renders with only its `a` frame (no blink/cycle), so you can skip `b`/`x1` for a
  quick partial set and fill them in later. `--check` shows `have/expected` frames per state.
- Adjust frame lists, `TARGET_PX`, `GRID`, `CHROMA`, `BORDER`, or pose hints in `sprite-manifest.ts`; the prompts, sheet
  packing, and slicing all follow automatically.
