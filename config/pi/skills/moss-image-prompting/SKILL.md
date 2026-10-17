---
name: moss-image-prompting
disable-model-invocation: true
description:
  Prompting rules for the OpenMOSS **MOSS-Image** text-to-image model on the comfyui `moss-image`, `moss-image-fast`,
  `moss-image-reference` (SFT checkpoint) and `moss-image-base*` workflows. Use when the user asks to generate / draw /
  render an image on a MOSS-Image workflow, especially posters, signage, or anything with legible in-image text.
  MOSS-Image is a long-prompt natural-language model (Qwen3.5-9B text encoder) with real CFG - write detailed English
  prose, quote exact text, pass a short tag negative, and keep the tuned sampler recipe.
---

# MOSS-Image Prompting

[MOSS-Image](https://github.com/OpenMOSS/MOSS-Image) is OpenMOSS's open-weight 5B single-stream diffusion transformer
with a **Qwen3.5-9B language-model text encoder** (prompts up to 4K tokens) and the FLUX.2 VAE. It was trained on long,
detailed English recaptions that spell out composition, lighting, style, and every visible piece of text with its
layout. That is what it is best at: **accurate in-image text, structured layouts, and long, specific prompts**, in both
photoreal and illustrated styles. Write the `prompt` and `negative` you pass to `generate_image` per the rules below to
drive it well on the first call.

Three rules matter most:

- **Detailed English prose, not tags.** Describe the image the way a careful captioner would - subjects, actions,
  setting, composition, colours, lighting, medium. Long prompts help; this model rewards specificity more than most.
- **Quote every piece of text exactly.** Put the literal words in double quotes, keep their original language, use real
  line breaks where lines should wrap, and describe where and how the text sits.
- **It uses real CFG, so the negative matters.** Pass a short tag negative such as
  `worst quality, bad anatomy, watermark, jpeg artifact`.

**Safe default when unsure:** use the `moss-image` workflow, write `prompt` as a descriptive English paragraph (subject,
setting, lighting, medium, any quoted text), pass `negative: "worst quality, bad anatomy, watermark, jpeg artifact"`,
set `width`/`height` (or `aspect`) for the framing, and leave `steps`/`cfg` alone.

## The `generate_image` call

| Arg                | For MOSS-Image                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `prompt`           | Required. A detailed English description; quoted text with real line breaks; or a JSON layout (see below).   |
| `negative`         | Short comma-separated tags. Default `worst quality, bad anatomy, watermark, jpeg artifact`.                  |
| `workflow`         | `moss-image` (default choice), `moss-image-fast`, `moss-image-reference`, or a `moss-image-base*` variant.   |
| `width` / `height` | Multiples of 16. Best at 1 / 1.5 / 2 MP (`1024x1024`, `1216x832`, `832x1216`, `1456x1456`); 0.25-4 MP works. |
| `aspect`           | Preset (`16:9`, `portrait`, `square`, …) as an alternative to explicit `width`/`height`.                     |
| `seed`             | Omit for a fresh image; pass a prior seed to reproduce or to vary by tweaking the prompt.                    |
| `cfg`              | Leave at the baked `3` for long prompts. For a short prompt you may raise it toward `4.5`-`5`.               |
| `steps`            | Leave at the workflow's baked value; pick a different workflow for speed instead.                            |
| `count`            | Batch size. Each image costs the full render time; batch only when asked.                                    |
| `enhance`          | Opt-in prompt rewrite before rendering (see [enhancement](#prompt-enhancement-enhance)).                     |

### Which workflow

All six run the diffusion model on GPU 0 and the text encoder + VAE on GPU 1, at CFG 3, shift 5, with uncond layer-skip
guidance at layer 22. Times are for 1024x1024 on the res-nyc1 2x RTX 2000 Ada host.

| Workflow                    | Checkpoint | Sampler / steps      | ~Time | Use it for                                                                  |
| --------------------------- | ---------- | -------------------- | ----- | --------------------------------------------------------------------------- |
| `moss-image`                | SFT        | `res_multistep` / 30 | 86 s  | The default. Matches the official 50-step detail in 40% less time.          |
| `moss-image-fast`           | SFT        | `res_multistep` / 20 | 57 s  | Drafts and iteration. Text and composition hold; fine texture is softer.    |
| `moss-image-reference`      | SFT        | `euler` / 50         | 145 s | The official OpenMOSS recipe, for A/B comparisons.                          |
| `moss-image-base`           | Base       | `res_multistep` / 30 | 90 s  | More natural photographic skin and truer art styles; cosplay / real people. |
| `moss-image-base-fast`      | Base       | `res_multistep` / 20 | 57 s  | Fast Base drafts.                                                           |
| `moss-image-base-reference` | Base       | `euler` / 50         | 142 s | Official recipe on Base.                                                    |

Pick `moss-image` unless the user asks for speed (`moss-image-fast`), the official recipe (`moss-image-reference`), or a
Base look. SFT is more polished and organizes text and layout best, but on short character or cosplay prompts it can
lean toward airbrushed, doll-like faces, stock flourishes (glowing shards, halos), and invented badge or costume text.
Base keeps more natural photographic skin and stays truer to a requested art style; switch to it when realism matters.
Do not lower `steps` below 20: at 14 steps the composition itself changes.

## Positive prompt recipe

Write one or more coherent paragraphs moving through these beats, as prose rather than labelled fields:

1. **Subject + action** - who/what and what they are doing. `An elderly fisherman mends a net on a wooden dock.`
2. **Appearance + material** - wardrobe, materials, age, expression, colours, textures.
3. **Setting + composition** - where it is and how it is framed: shot size, angle, placement, foreground/background.
4. **Lighting + palette** - light quality and direction, time of day, colour palette, mood.
5. **Medium + style** - name it explicitly: `35mm film photograph`, `flat screen-printed travel poster`,
   `watercolor illustration`, `anime key visual`, `3D render`.
6. **Text, if any** - the exact quoted words plus their typography and placement (see
   [Rendering text](#rendering-text-in-the-image)).
7. **Camera / texture detail for photoreal** - lens, aperture, depth of field, film grain, natural skin texture.

English works best; Chinese and other languages are supported. Describe only what should be visible.

## How much to write

- **Explore (20-40 words):** subject, setting, medium. Raise `cfg` toward 4.5 if a short prompt comes out loose.
- **Controlled (60-150 words):** the full recipe above. This is the sweet spot for most requests.
- **Dense / text-heavy (150-400+ words):** posters, infographics, whiteboards, multi-panel layouts. Long prompts do not
  degrade this model; the official examples run several hundred characters of quoted text.

## Rendering text in the image

This is MOSS-Image's headline feature, and it rewards precision:

- Put the **exact string in double quotes**. Do not paraphrase, translate, romanize, or "fix" the user's wording.
- Use **real line breaks** inside the quotes where lines should break; the model otherwise wraps on its own and may not
  wrap where you want.
- Describe the **typography**: position (`centered at the top`, `on the sticky note`), alignment, size hierarchy
  (`large bold title`, `smaller subtitle below`), font style (`handwritten marker`, `condensed sans-serif`, `serif`),
  colour, and the surface it is on.
- Several separate text blocks are fine; give each its own quote and placement.

```text
A vintage screen-printed travel poster in flat muted colours: a red pagoda and maple trees before a pale sun over
layered blue mountains. At the top, large bold cream uppercase letters read "KYOTO". Below the art, smaller dark teal
text reads "AUTUMN LANTERN FESTIVAL", and on the next line in red "November 3 - 9, 2026". Subtle paper grain texture.
```

Handwriting at small sizes is the weakest case: expect occasional single-letter slips (`loaf` -> `leaf`). Make the text
surface larger in the frame, or keep each line short, when exact spelling matters.

## Layout prompts (JSON, experimental)

For precise placement, the prompt can be a JSON layout instead of prose. Coordinates are **absolute pixels relative to
the canvas centre** (`abs_centralized`, x right / y down) in `[y_min, x_min, y_max, x_max]` order (`yxyx`), so they must
match the `width`/`height` you render at. On a 1024x1024 canvas each axis runs from -512 to +512.

```json
{
  "summary": {
    "meta": ["poster"],
    "canvas": "single",
    "caption": "A minimalist travel poster with a cream background, a blue mountain illustration, and the title EXPLORE at the top."
  },
  "items": [
    {
      "label": "text",
      "caption": "Large dark-blue uppercase title centered at the top.",
      "text": "EXPLORE",
      "bbox": [-416, -384, -288, 384]
    },
    {
      "label": "object",
      "caption": "A flat blue mountain illustration in the lower center.",
      "bbox": [-192, -288, 384, 288]
    }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

Pass the JSON string as `prompt` with matching `width`/`height`. To convert top-left pixel coordinates, subtract
`width/2` from x and `height/2` from y. Prefer prose unless the user needs exact positions.

## Tag-style prompts

Tag sequences also work, mainly for anime. Order them quality -> score -> meta -> year -> character -> series -> artist
-> general, for example `best quality, highres, hatsune miku, vocaloid, @foo bar, 1girl, blue hair`. Prose usually gives
better composition; use tags when the user hands you tags or asks for a booru-style result.

## Negative prompt recipe

MOSS-Image runs real CFG (3 by default), so the negative steers the output. Keep it short and tag-shaped:

```text
worst quality, bad anatomy, watermark, jpeg artifact
```

Add only exclusions specific to the request (`blurry text, misspelled text` for text-heavy work, `extra fingers` for
hands in focus). Do not paste long negative lists; they compete with the positive. Keep any rating token on the side the
user put it on.

## Expanding a terse user request

When the user asks for something short like "a coffee shop sign", do **not** pass that string through - expand it:

1. **Anchor the subject** and add concrete, depictable details (materials, colours, condition).
2. **Place + frame it** - setting and one composition choice.
3. **Light it** - one phrase on light and mood.
4. **Name the medium.**
5. **Spell out any text** in quotes with its typography and placement; invent short, plausible wording only when the
   user implies text but gives none (a shop sign needs a name), and keep it short.

Sketch: `a coffee shop sign` becomes

```text
A close-up photograph of a hand-painted wooden sign hanging above a small corner coffee shop on a quiet street. The sign
reads "MORNING RITUAL" in cream serif capitals, with a smaller line below reading "coffee & pastries since 1987". Warm
early-morning side light, soft shadows, slightly weathered green paint, shallow depth of field, 50mm lens.
```

If the user hands you a finished descriptive prompt, preserve their wording and intent and lightly polish. If they hand
you tags, either keep them in the tag order above or translate them into prose while keeping every concept.

## Prompt enhancement (`enhance`)

The `generate_image` tool has an opt-in **`enhance`** option that routes the prompt through a separate model before the
render, rewriting a thin prompt into the detailed MOSS-Image description this guide covers. The example config turns it
on by default for the MOSS-Image workflows (per-workflow `enhance: true` with
[`moss-image-enhance.md`](../../comfyui/moss-image-enhance.md) as guidance).

- **Use it when** the incoming prompt is a few words or a loose list. When you have already written a careful
  description or a JSON layout, pass `enhance: false` - it only adds latency and can drift from your exact text.
- **Scene continuity.** Pass the `context` arg alongside `enhance` to hand the enhancer background to honour without
  depicting it literally.

## If you are enhancing a prompt rather than rendering

You may be reading this as guidance for the prompt-enhancement step: you were given a rough prompt and a baseline
negative and must return a single JSON object `{"prompt", "negative"}`. In that role:

- **Act only on the prompt-writing rules above** - the [positive recipe](#positive-prompt-recipe),
  [text rendering](#rendering-text-in-the-image), [terse expansion](#expanding-a-terse-user-request), and the
  [negative recipe](#negative-prompt-recipe). The workflow table and tool args do not apply.
- **Translate and enrich, do not reinvent.** Keep subjects, actions, colours, and spatial relationships; do not add new
  people, objects, or props the request does not imply. Honour the requested medium.
- **Never alter quoted text.** Keep it verbatim, in its original language, with its line breaks.
- **Pass JSON layouts through** unchanged apart from enriching `caption` strings; do not move any `bbox`.
- **Return a short tag negative** built on the baseline, defaulting to
  `worst quality, bad anatomy, watermark, jpeg artifact`.

## Worked examples

These show the _shape_ of a finished prompt; adapt rather than reuse. Both were rendered on Base and SFT at 1024x1024.

Text in a photoreal scene:

```text
A wide view of a refrigerator beside a kitchen counter with a fruit bowl. A small sticky note on the refrigerator door
is handwritten in English:
"Remember to buy milk and eggs!
Two cartons of milk, a dozen eggs.
Grab a loaf of bread too."
```

Photoreal portrait:

```text
Candid 35mm film photograph of an elderly fisherman with a weathered face and a grey wool cap, mending a net on a
wooden dock at golden hour, shallow depth of field, natural skin texture.
```

Reusable skeletons:

```text
Poster:   A [style] poster in [palette]: [main art]. At the top, [size/weight/colour] letters read "[TITLE]". Below,
          [smaller style] text reads "[SUBTITLE]", and on the next line "[DETAIL]". [texture/finish].
Signage:  A [shot] photograph of a [material] sign on [surface] reading "[TEXT]" in [font/colour], [lighting], [lens].
Portrait: [shot size] [medium] of [subject] in [wardrobe], [action], [setting], [lighting], [lens], [texture cues].
```

## Anti-patterns

- **Paraphrasing or translating the user's text.** The model renders exactly what is quoted; changed wording is a failed
  render.
- **Leaving text unquoted or unplaced.** `a poster that says kyoto autumn festival` gives the model no line structure or
  hierarchy. Quote each block and say where it goes.
- **Very short prompts at CFG 3.** They come out generic. Expand the prompt, or raise `cfg` toward 4.5.
- **Huge negative lists.** A few targeted tags beat a pasted 40-tag negative.
- **Overriding `steps` for speed.** Switch to `moss-image-fast` instead. Below 20 steps the composition shifts.
- **Ignoring the Base option for realism.** If SFT output looks airbrushed or invents detail, use the matching
  `moss-image-base*` workflow rather than piling on negative tags.
- **JSON layouts at the wrong size.** Coordinates are absolute pixels; a layout written for 1024x1024 breaks at
  1216x832.
