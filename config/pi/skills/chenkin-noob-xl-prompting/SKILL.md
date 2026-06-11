---
name: chenkin-noob-xl-prompting
disable-model-invocation: true
description:
  Prompting rules for **Chenkin Noob XL (CKXL)**, a NoobAI-XL-1.1 *eps* fine-tune. Use when the user asks to generate /
  draw / render an anime image on a CKXL workflow (v0.2, v0.5, or near-vanilla finetune). CKXL is eps (not v-pred) and
  inherits NoobAI's `artist:name` syntax and anti-furry negative conventions; do not conflate with the NoobAI v-pred
  skill.
---

# Chenkin Noob XL Prompting

[Chenkin Noob XL (CKXL)](https://civitai.com/models/2167995/chenkin-noob-xl-ckxl) is a Chenkin fine-tune of
`Laxhar/noobai-XL-1.1` (the **eps** branch of NoobAI-XL), trained on ~12M images (9M anime + 2.17M game/Western designs,
Danbooru through Jan 2026). It inherits NoobAI's tag namespace - Danbooru + e621 + `artist:name` syntax - and adds a
CKXL-specific aesthetic/quality vocabulary (`Aesthetic`, `Excellent`, `High Resolution`, `Medium Resolution`). This
skill teaches how to drive it from `generate_image`. Rules below do not apply to NoobAI v-pred (see
[[noobai-vpred-prompting]]), plain Illustrious (see [[illustrious-prompting]]), or Anima (see [[anima-prompting]]).

CKXL is **eps-prediction**, not v-pred - the sampler / CFG constraints from the v-pred skill do not apply here.

## The `generate_image` call

| Arg                | For CKXL                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required. Lead with the CKXL prefix below; then the caption order.                                      |
| `negative`         | Required. Start from the recommended negative below - keep the NoobAI anti-furry block.                 |
| `workflow`         | Use the CKXL workflow (or a NoobAI-eps workflow with the CKXL checkpoint pointed at by it).             |
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
2. **Caption order** (inherited from NoobAI):
   `<1girl/1boy/1other/...>, <character>, <series>, <artists>, <special tags>, <general tags>, <other tags>`
3. **Artists use `artist:name` syntax**, comma-joined: `artist:wlop, artist:as109`. Multi-word artist names keep
   underscores (`artist:john_kafka`). Do **not** use Anima's `@` prefix.
4. **Lowercase tags, spaces over underscores** in general tags; multi-word Danbooru proper nouns may keep underscores.
5. **Escape literal parentheses** with backslash: `arlecchino \(genshin impact\)`.
6. **Name then describe characters.** With multiple characters, describe each separately to avoid conflation.
7. **Be specific.** Same as Illustrious / NoobAI - terse prompts come out bland.

## Negative prompt recipe

Start from the model card's v0.5 recommendation and add the anti-furry block from NoobAI:

```text
nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands,
mammal, anthro, furry, ambiguous form, feral, semi-anthro, e621
```

The v0.5 card itself drops the `mammal, anthro, furry...` block, but CKXL is built on NoobAI-1.1 which was trained on
e621, so keep it unless the user actually wants furry/anthro art. The v0.2 card's `e621, Furry` shorthand goes in the
same role.

Add situational terms:

- `text, watermark, multiple views, extra digits, jpeg artifacts` for cleanup.
- Drop `nsfw` if the user wants sensitive/explicit output.

## Tag reference

### CKXL quality vocabulary

| Tag                 | Meaning                                                   |
| ------------------- | --------------------------------------------------------- |
| `masterpiece`       | NoobAI top 5% quality - keep in the prefix                |
| `best quality`      | NoobAI top 15% quality - keep in the prefix               |
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

Sampler / scheduler live in the workflow file. CKXL inherits NoobAI's eps prediction type - if the workflow is
configured for v-pred (zsnr, `v_prediction`), generations will look mushy. Verify the workflow before retrying.

## Worked examples

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

- **Treating CKXL like v-pred NoobAI.** CFG 4 + Euler + zsnr underperforms here - CKXL is eps and wants CFG 5-6 + Euler
  a + no zsnr.
- **Dropping CKXL's quality tags.** `aesthetic, excellent, high resolution` are this fine-tune's main aesthetic lever -
  removing them defeats the point of using CKXL over base NoobAI.
- **Skipping the anti-furry block.** Even though v0.5's card omits it, CKXL inherits NoobAI-1.1 which is trained on
  e621 - without the block, e621 features leak into anime prompts.
- **Anima `@artist` syntax.** Wrong here - use `artist:name` instead.
- **Pushing CFG past 6.** Oversaturates the image on the eps line; CKXL is no exception.
- **Three-word prompts.** Same as the NoobAI / Illustrious family - CKXL has no aggressive default style, so terse
  prompts come out bland. Always include the full prefix + caption-order tags.
- **Wrong year tag.** `year 2027` is out of CKXL's training range (training data cutoff is Jan 2026); the tag will be
  treated as unknown.
