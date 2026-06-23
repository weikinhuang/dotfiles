---
name: chenkin-noob-xl-prompting
disable-model-invocation: true
description:
  Prompting rules for **Chenkin Noob XL (CKXL)**, a NoobAI-XL-1.1 *eps* fine-tune. Use when the user asks to generate /
  draw / render an anime image on a CKXL workflow (v0.2, v0.5, or near-vanilla finetune). CKXL is eps (not v-pred) and
  uses `artist:name` syntax with anti-furry negatives; it adds CKXL-specific quality tags (`aesthetic`, `excellent`).
---

# Chenkin Noob XL Prompting

[Chenkin Noob XL (CKXL)](https://civitai.com/models/2167995/chenkin-noob-xl-ckxl) is a Chenkin fine-tune of
`Laxhar/noobai-XL-1.1` (an **eps**-prediction SDXL anime model), trained on ~12M images (9M anime + 2.17M game/Western
designs, Danbooru through Jan 2026). It uses a Danbooru + e621 tag namespace with `artist:name` syntax, and adds a
CKXL-specific aesthetic/quality vocabulary (`Aesthetic`, `Excellent`, `High Resolution`, `Medium Resolution`). Write the
`prompt` and `negative` you pass to the `generate_image` tool per the rules below to drive it well on the first call.

CKXL is **eps-prediction**, not v-pred - it wants the eps sampler / CFG settings below (Euler a, CFG 5-6, no zsnr), not
v-pred constraints.

**Safe default when unsure:** use the CKXL workflow; lead the `prompt` with
`masterpiece, best quality, newest, high resolution, aesthetic, excellent, year 2026,`, add roughly 8-15 caption-order
tags for the subject, and always pass the recommended `negative` below **including its anti-furry block**. CKXL has no
aggressive default style, so terse prompts come out bland - spend the detail. Everything below is how to do better than
this default when the request calls for it.

## The `generate_image` call

| Arg                | For CKXL                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required. Lead with the CKXL prefix below; then the caption order.                                      |
| `negative`         | Required. Start from the recommended negative below - keep the anti-furry block.                        |
| `workflow`         | Use the CKXL workflow (or an eps-prediction workflow with the CKXL checkpoint pointed at by it).        |
| `width` / `height` | Total area ~1024x1024. Best: 768x1344, **832x1216**, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768. |
| `steps`            | 25-30.                                                                                                  |
| `cfg`              | 5-6. Higher oversaturates; stay <= 6.                                                                   |
| `seed`             | Omit for a fresh random image; pass a prior seed to reproduce or vary.                                  |

Do not pass `inputImage` unless the workflow is a CKXL img2img variant.

## Positive prompt recipe

1. **Required prefix** (v0.5 recommendation):
   `masterpiece, best quality, newest, high resolution, aesthetic, excellent, year 2026,`
   - For older-looking output, swap `year 2026` for an earlier year (`year 2023`) or a period tag (see
     [Date tags](#date-tags)).
   - `aesthetic, excellent, high resolution` are CKXL-specific quality tags - keep them. Drop them only if you want a
     deliberately less-polished look.
2. **Caption order:**
   `<1girl/1boy/1other/...>, <character>, <series>, <artists>, <special tags>, <general tags>, <other tags>`
3. **Artists use `artist:name` syntax**, comma-joined: `artist:wlop, artist:as109`. Multi-word artist names keep
   underscores (`artist:john_kafka`). Do **not** use an `@` prefix.
4. **Lowercase tags, spaces over underscores** in general tags; multi-word Danbooru proper nouns may keep underscores.
5. **Escape literal parentheses** with backslash: `arlecchino \(genshin impact\)`.
6. **Name then describe characters.** With multiple characters, describe each separately to avoid conflation.
7. **Be specific.** CKXL has no aggressive default style, so terse prompts come out bland.

## Negative prompt recipe

Start from the model card's v0.5 recommendation and add the anti-furry block:

```text
nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands,
mammal, anthro, furry, ambiguous form, feral, semi-anthro, e621
```

The v0.5 card itself drops the `mammal, anthro, furry...` block, but CKXL is built on a checkpoint trained on e621, so
keep it unless the user actually wants furry/anthro art. The v0.2 card's `e621, Furry` shorthand goes in the same role.

Add situational terms:

- `text, watermark, multiple views, extra digits, jpeg artifacts` for cleanup.
- Drop `nsfw` if the user wants sensitive/explicit output.

## Tag reference

### CKXL quality vocabulary

| Tag                 | Meaning                                                   |
| ------------------- | --------------------------------------------------------- |
| `masterpiece`       | Top 5% quality percentile - keep in the prefix            |
| `best quality`      | Top 15% quality percentile - keep in the prefix           |
| `aesthetic`         | CKXL top-100k Danbooru aesthetic - keep in the prefix     |
| `excellent`         | CKXL top-1M liked Danbooru - keep in the prefix           |
| `high resolution`   | CKXL >= 2048 px source - default for the prefix           |
| `medium resolution` | CKXL 1024-2048 px source - lower-resolution training look |

### Date tags

| Period tag | Year range | When to use                                      |
| ---------- | ---------- | ------------------------------------------------ |
| `newest`   | 2022-2025  | CKXL's recommended modern look - **the default** |
| `recent`   | 2018-2020  | Late-2010s / early-2020s style                   |
| `mid`      | 2014-2017  | Mid-2010s style                                  |
| `early`    | 2011-2014  | Earlier 2010s style                              |
| `old`      | 2005-2010  | Vintage 2000s anime                              |

For a specific year, use `year 2024`, `year 2025`, `year 2026` etc. CKXL's training data runs through Jan 2026, so
`year 2026` is in-range.

## Generation settings

| Setting    | Value (per the model card)                                                              |
| ---------- | --------------------------------------------------------------------------------------- |
| Resolution | ~1024x1024 area. Best: 832x1216 portrait, 1024x1024 square, 1216x832 landscape.         |
| Steps      | 25-30.                                                                                  |
| CFG        | 5-6. Higher oversaturates.                                                              |
| Sampler    | `Euler a` (the eps-line default - **not** plain Euler, which is the v-pred constraint). |

Sampler / scheduler live in the workflow file. CKXL is eps-prediction - if the workflow is configured for v-pred (zsnr,
`v_prediction`), generations will look mushy. Verify the workflow before retrying.

## Prompt enhancement (`enhance`)

The `generate_image` tool has an opt-in **`enhance`** option that routes your prompt through a separate model before the
render to rewrite it into CKXL's native protocol - the prefixed, caption-ordered Danbooru / e621 tag list this guide
describes.

- **It is opt-in.** Pass `enhance: true` on the call (or a workflow/config default turns it on). When off, your `prompt`
  is sent as-is.
- **Use it when** the incoming prompt is thin (a few words) and you want a one-shot upgrade to a full tagged prompt.
  When you have already built a careful tagged prompt, leave `enhance` off - it only adds latency and risks drifting
  from your intent.
- **Scene continuity.** Pass the `context` arg alongside `enhance` to hand the enhancer background to honour (character
  facts, ongoing scene, wardrobe) without depicting it literally. It is ignored when `enhance` is off.
- **Negative.** The enhancer builds on whatever baseline `negative` you pass and returns a refined one - it must keep
  the anti-furry block (see the [negative recipe](#negative-prompt-recipe)).

## If you are enhancing a prompt rather than rendering

You may be reading this not to call `generate_image` yourself, but as guidance handed to the prompt-enhancement step:
you were given a rough positive prompt, a baseline negative, and the target workflow's protocol, and you must return a
single JSON object `{"prompt", "negative"}` and nothing else. In that role:

- **Act only on the prompt-writing rules above** - the required prefix and caption order in the
  [positive recipe](#positive-prompt-recipe) and the [negative recipe](#negative-prompt-recipe). The generation-settings
  and tool-arg tables do not apply - you do not pick a workflow or call any tool.
- **Translate and enrich, do not reinvent.** Keep the incoming subject and intent; lead with
  `masterpiece, best quality, newest, high resolution, aesthetic, excellent, year 2026,` (keep the CKXL quality tags),
  write artists as comma-joined `artist:name` (no `@`), use lowercase tags, and escape literal parentheses (`\(` `\)`).
- **Always add detail - even to an already-tagged prompt.** CKXL has no aggressive default style, so push toward roughly
  8-15 caption-order items: subject count (`1girl` / `1boy` / `1other`), character / series, appearance, pose, scene,
  and lighting that the prompt leaves unstated, staying faithful to the stated subject.
- **Mine any background context you were given** (a scene/continuity note, recent conversation) for that extra detail
  and fold it in as depictable tags. Treat it as source material to pick from, not a checklist to dump and not a subject
  that overrides the explicit prompt; ignore chatter with no visual bearing.
- **Build on the baseline negative** and **always keep the anti-furry block**
  (`mammal, anthro, furry, ambiguous form, feral, semi-anthro, e621`) unless the user actually wants furry / anthro art.

## Worked examples

These illustrate the _shape_ of a finished prompt - adapt them to the actual request, do not reuse them verbatim. Pass
the `prompt` (and `negative`) value as a single string.

Standard portrait:

```text
prompt:   masterpiece, best quality, newest, high resolution, aesthetic, excellent, year 2026,
          1girl, solo, fern \(sousou no frieren\), sousou no frieren, artist:wlop,
          long purple hair, purple eyes, black coat, holding staff, magical sparks,
          forest clearing at dusk, cinematic lighting, soft glow, looking at viewer
negative: nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands,
          mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro, e621,
          text, watermark
```

Multi-artist style mix:

```text
prompt:   masterpiece, best quality, newest, high resolution, aesthetic, excellent, year 2025,
          artist:wlop, artist:as109,
          1girl, solo, chromatic aberration, film grain, horror \(theme\), limited palette,
          x-shaped pupils, high contrast, cold colors, black theme, gritty
negative: nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands,
          mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro, e621
```

The wrapped lines above are a single comma/space-joined string each - pass them as one line in the tool args.

## Anti-patterns

- **Treating CKXL like a v-pred model.** CFG 4 + Euler + zsnr underperforms here - CKXL is eps and wants CFG 5-6 + Euler
  a + no zsnr.
- **Dropping CKXL's quality tags.** `aesthetic, excellent, high resolution` are this fine-tune's main aesthetic lever -
  removing them defeats the point of this fine-tune.
- **Skipping the anti-furry block.** Even though v0.5's card omits it, CKXL is built on an e621-trained checkpoint -
  without the block, e621 features leak into anime prompts.
- **`@`-prefixed artists.** Wrong here - use `artist:name` instead.
- **Pushing CFG past 6.** Oversaturates the image on the eps line; CKXL is no exception.
- **Three-word prompts.** CKXL has no aggressive default style, so terse prompts come out bland. Always include the full
  prefix + caption-order tags.
- **Wrong year tag.** `year 2027` is out of CKXL's training range (training data cutoff is Jan 2026); the tag will be
  treated as unknown.
- **Square-bracket weighting.** ComfyUI weights with parentheses - `(tag:1.3)` to strengthen, `(tag:0.8)` to weaken.
  A1111-style square brackets do not de-emphasize here: `[tag]` parses as `([tag]:1)` (literal brackets at weight 1).
  Use `(tag:0.8)` to weaken instead.
