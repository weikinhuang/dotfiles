---
name: noobai-vpred-prompting
description:
  Prompting rules for the Laxhar Labs **NoobAI-XL v-prediction** anime / illustration model. Use when the user asks to
  generate / draw / render an anime image on a NoobAI v-pred workflow. NoobAI uses `artist:name` syntax and is
  e621-trained (requires anti-furry negatives); the v-prediction variant has stricter sampler and CFG constraints than
  the eps variant - do not conflate them.
---

# NoobAI-XL V-Pred Prompting

[NoobAI-XL V-Pred](https://huggingface.co/Laxhar/noobai-XL-Vpred-1.0) is Laxhar Labs' Illustrious-XL fine-tune on
Danbooru + e621 (NebulaeWis's `e621-2024-webp-4Mpixel`), running in **v-prediction** mode. This skill teaches how to
drive it from `generate_image`. The v-pred constraints are non-negotiable - the model card opens with "THIS MODEL WORKS
DIFFERENT FROM EPS MODELS!" Rules below do not apply to the eps variant, plain Illustrious (see
[[illustrious-prompting]]), Pony, or Anima (see [[anima-prompting]]).

NoobAI supports Danbooru and e621 tag namespaces plus natural-language captions. Because of the e621 training, you
**must** add anti-furry tags to the negative when you want pure anime output.

## The `generate_image` call

| Arg                | For NoobAI-XL v-pred                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required. Lead with the prefix below; then the caption order.                                           |
| `negative`         | Required. Start from the recommended negative below - it includes anti-furry tags.                      |
| `workflow`         | Use the NoobAI v-pred workflow; the scheduler / sampler in it must be Euler + v_prediction + zsnr.      |
| `width` / `height` | Total area ~1024x1024. Best: 768x1344, **832x1216**, 896x1152, 1024x1024, 1152x896, 1216x832, 1344x768. |
| `steps`            | 28-35.                                                                                                  |
| `cfg`              | 4-5. **Do not push past 5** - v-pred burns at high CFG.                                                 |
| `seed`             | Omit for a fresh random image; pass a prior seed to reproduce or vary.                                  |

Do not pass `inputImage` unless the workflow is a NoobAI img2img variant.

## Positive prompt recipe

1. **Required prefix:** `masterpiece, best quality, newest, absurdres, highres, safe,`
   - `newest` is a period tag for 2021-2024 art - swap it (see [Date tags](#date-tags)) if you want an older look.
   - Drop `safe` only if the user explicitly wants `sensitive` / `nsfw`; mirror the change in the negative.
2. **Caption order:**
   `<1girl/1boy/1other/...>, <character>, <series>, <artists>, <special tags>, <general tags>, <other tags>`.
3. **Artists use `artist:name` syntax**, comma-joined: `artist:john_kafka, artist:nixeu, artist:quasarcake`. Multi-word
   artist names keep the underscore (`john_kafka`). Do **not** use Anima's `@` prefix here.
4. **Lowercase tags, spaces over underscores** in general tags; multi-word Danbooru proper nouns may keep underscores.
5. **Escape literal parentheses** with backslash: `arlecchino \(genshin impact\)`, `horror \(theme\)`.
6. **Name then describe characters.** Multiple characters -> describe each separately to avoid conflation.
7. **Be specific.** Like Illustrious, NoobAI has no aggressive aesthetic baked in - short prompts come out bland.
8. **Optional aesthetic boost:** add `very awa` to the positive prompt (top 5% waifu-scorer aesthetic) when you want
   maximum polish; pair with `worst aesthetic` in the negative.

## Negative prompt recipe

Start from the model card's recommendation and adjust:

```text
nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands,
mammal, anthro, furry, ambiguous form, feral, semi-anthro
```

The `mammal, anthro, furry, ambiguous form, feral, semi-anthro` block is what keeps the e621 training from leaking into
pure anime output - keep it unless the user actually wants furry/anthro art.

Add situational terms:

- `worst aesthetic` when you used `very awa` in the positive.
- `text, watermark, multiple views, extra digits, jpeg artifacts` for cleanup.
- Drop `nsfw` if the user wants sensitive/explicit (and remove `safe` from the positive).

## Tag reference

### Quality tags

| Percentile      | Tag              |
| --------------- | ---------------- |
| > 95th          | `masterpiece`    |
| > 85th, <= 95th | `best quality`   |
| > 60th, <= 85th | `good quality`   |
| > 30th, <= 60th | `normal quality` |
| <= 30th         | `worst quality`  |

### Aesthetic tags

| Tag               | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `very awa`        | Top 5% waifu-scorer aesthetic - boost when you want polish |
| `worst aesthetic` | Bottom 5% - keep in the negative when using `very awa`     |

### Date tags

| Period tag | Year range | When to use                               |
| ---------- | ---------- | ----------------------------------------- |
| `old`      | 2005-2010  | Vintage 2000s anime look                  |
| `early`    | 2011-2014  | Earlier 2010s style                       |
| `mid`      | 2014-2017  | Mid-2010s style                           |
| `recent`   | 2018-2020  | Late-2010s / early-2020s style            |
| `newest`   | 2021-2024  | Modern look - **the recommended default** |

For a specific year, use `year 2023`, `year 2024`, etc.

### Safety tags

| Tag         | When                                           |
| ----------- | ---------------------------------------------- |
| `safe`      | Default - keep in the positive prefix          |
| `sensitive` | Suggestive but not explicit                    |
| `nsfw`      | Explicit - drop from negative, add to positive |
| `explicit`  | Most explicit                                  |

## Generation settings

| Setting    | Value (per the model card)                                                              |
| ---------- | --------------------------------------------------------------------------------------- |
| Resolution | ~1024x1024 area. Best: 832x1216 portrait, 1024x1024 square, 1216x832 landscape.         |
| Steps      | 28-35.                                                                                  |
| CFG        | **4-5 only**. Higher burns the image.                                                   |
| Sampler    | **Euler** only. Other samplers produce broken output per the README.                    |
| Scheduler  | v_prediction with `rescale_betas_zero_snr=True` (or `sgm_uniform` + `zsnr` in ComfyUI). |

Sampler / scheduler are workflow-level - if generations look mushy, the workflow likely isn't configured for v-pred.
Tell the user to verify the workflow file has Euler + v_prediction + zsnr before retrying.

If outputs are oversaturated, the Civitai page recommends a **CFG-Rescale** node at `0.2` to tame v-pred contrast. That
is a workflow-level addition - mention it when the user reports burned-looking renders.

## Worked examples

Standard portrait:

```text
prompt:   masterpiece, best quality, newest, absurdres, highres, safe, very awa,
          1girl, solo, fern \(sousou no frieren\), sousou no frieren, artist:wlop,
          long purple hair, purple eyes, black coat, holding staff, magical sparks,
          forest clearing at dusk, cinematic lighting, soft glow, looking at viewer
negative: nsfw, worst quality, worst aesthetic, old, early, low quality, lowres, signature,
          username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form,
          feral, semi-anthro, text, watermark
```

Multi-artist style mix:

```text
prompt:   masterpiece, best quality, newest, absurdres, highres, safe,
          artist:john_kafka, artist:nixeu, artist:quasarcake,
          1girl, chromatic aberration, film grain, horror \(theme\), limited palette,
          x-shaped pupils, high contrast, cold colors, black theme, gritty, graphite \(medium\)
negative: nsfw, worst quality, old, early, low quality, lowres, signature, username, logo,
          bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro
```

The wrapped lines above are a single comma/space-joined string each - pass them as one line in the tool args.

## Anti-patterns

- **Treating v-pred like eps.** CFG 7, DPM++ 2M Karras, no zsnr -> mushy, washed-out, or noise-laden output. Verify the
  workflow before blaming the prompt.
- **CFG above 5.** Specific to v-pred: extra CFG does not improve fidelity, it burns colors.
- **Wrong sampler.** Per the README, only Euler works properly. DPM++, UniPC, Heun all degrade output.
- **Skipping the anti-furry block.** Without `mammal, anthro, furry, ambiguous form, feral, semi-anthro` in the
  negative, e621 features leak into anime prompts (snouts, fur textures, paw pads).
- **Anima `@artist` syntax.** Wrong here - use `artist:name` instead.
- **Three-word prompts.** Same as Illustrious - NoobAI has no aggressive aesthetic tuning, so terse prompts come out
  bland. Always include quality prefix + caption-order tags.
- **Dropping `safe` without `nsfw` in the positive.** Output drifts toward suggestive by default; either keep the
  `safe`/`nsfw negative` pairing, or explicitly opt in with `sensitive` / `nsfw` / `explicit` in the positive.
- **Year + period both pointing different eras.** Don't write `year 2023, old` - pick one.
