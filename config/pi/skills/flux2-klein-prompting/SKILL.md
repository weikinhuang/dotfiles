---
name: flux2-klein-prompting
disable-model-invocation: true
description:
  Prompting rules for the Black Forest Labs **FLUX.2 [klein]** text-to-image / image-edit model. Use when the user asks
  to generate / draw / render / edit an image on a FLUX.2 workflow (`flux2-t2i`, `flux2-t2i-fast`, `flux2-edit`,
  `flux2-edit-fast`, `flux2-edit-multi`). FLUX.2 is a natural-language model with an LLM text encoder - write
  descriptive prose, not booru tags, and mind the CFG-vs-negative caveat below.
---

# FLUX.2 [klein] Prompting

[FLUX.2 [klein]](https://huggingface.co/black-forest-labs/FLUX.2-klein) is Black Forest Labs' open-weight,
size-distilled member of the FLUX.2 family. It is a rectified-flow diffusion transformer steered by a **large
language-model text encoder (Qwen3)**, which is what gives it strong prompt adherence: it reads long, structured,
natural-language descriptions and follows compositional and spatial instructions far better than a tag-based model. It
also renders **legible text** in the image and supports **multi-reference image editing**. Write the `prompt` and
`negative` you pass to the `generate_image` tool per the rules below to drive FLUX.2 well on the first call.

The single most important rule: **FLUX.2 wants natural language, not tags.** Write the prompt as you would describe a
photograph or illustration to a person - complete clauses, concrete nouns, explicit spatial relationships. Comma-spammed
booru tags (`1girl, solo, long hair, masterpiece`) underuse the model and produce flat, generic output. There is no
quality-tag prefix, no score tags, and no `@artist` syntax; describe the style in words instead (`shot on 35mm film`,
`a watercolour illustration`, `in the style of a 1950s travel poster`).

**Safe default when unsure:** use the `flux2-t2i-fast` workflow, write `prompt` as 2-4 descriptive sentences (subject,
setting, lighting, style), and pass nothing else - leave `width` / `height` / `steps` / `cfg` / `seed` unset and do not
pass `negative` (it does nothing on the fast graph). Only depart from this default when the request needs editing
(`flux2-edit*`), a specific size, or negative-prompt control (`flux2-t2i`). The rest of this guide is how to do better
than the default when the request calls for it.

## The `generate_image` call

| Arg                | For FLUX.2 [klein]                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `prompt`           | Required. A descriptive natural-language paragraph (or several). No quality/safety prefix needed.            |
| `negative`         | Optional. **Only has an effect at CFG > 1** - see the caveat below. Skip it on the `*-fast` (CFG 1) graphs.  |
| `workflow`         | Pick the right FLUX.2 workflow (see the matrix below). Omit only if it is the configured `defaultWorkflow`.  |
| `width` / `height` | Text-to-image only; ~1 MP total is the sweet spot (e.g. 1024x1024, 1216x832). Edit graphs follow the source. |
| `steps`            | Base graphs ~20; distilled `*-fast` graphs 4. Leave the workflow default unless quality is lacking.          |
| `cfg`              | Base graphs ~4-5; distilled `*-fast` graphs 1. See the CFG-vs-negative caveat.                               |
| `seed`             | Omit for a fresh random image; pass a prior seed to reproduce or vary one.                                   |
| `inputImages`      | Edit graphs only - the reference image(s) to edit. See [Editing](#editing-and-reference-images).             |
| `count`            | Batch size.                                                                                                  |

You set the entire `prompt` string; it replaces the workflow's baked text. Omitted args keep the workflow's baked-in
values, so you do not need to pass `steps` / `cfg` - the graph already ships the right pair for its variant.

### Which workflow

| Workflow           | Use it for                                              | Steps / CFG | Reference images |
| ------------------ | ------------------------------------------------------- | ----------- | ---------------- |
| `flux2-t2i-fast`   | Interactive text-to-image (the practical default)       | 4 / 1       | none             |
| `flux2-t2i`        | Text-to-image when you want negative-prompt control     | ~20 / ~5    | none             |
| `flux2-edit-fast`  | Instruction-edit one image (interactive default)        | 4 / 1       | 1                |
| `flux2-edit`       | Instruction-edit one image with negative-prompt control | ~20 / ~5    | 1                |
| `flux2-edit-multi` | Combine / compose from two reference images             | ~20 / ~5    | 2                |

Reach for a `*-fast` variant by default - it is several times quicker per render. Step up to the base (`flux2-t2i` /
`flux2-edit`) only when you actually need the negative prompt or higher-CFG adherence, because that costs ~5x the steps.

## CFG and the negative prompt

FLUX.2's negative prompt is **classifier-free guidance**, so it only influences the image when `cfg > 1`:

- On the **base graphs** (`flux2-t2i`, `flux2-edit`, `flux2-edit-multi`, CFG ~5) the `negative` arg works normally - it
  steers the image away from what you list.
- On the **distilled `*-fast` graphs** (CFG 1) classifier-free guidance is off, so the `negative` arg is **effectively
  ignored**. Do not lean on it there; bake exclusions into the positive prompt instead ("a clean, empty desk" rather
  than relying on `negative: clutter`).

When you genuinely need to suppress something, either switch to a base graph and use `negative`, or phrase the absence
positively in the prompt.

## Positive prompt recipe

Write a coherent description, not a tag list. A strong FLUX.2 prompt usually moves through these beats (in roughly this
order, as prose - not as labelled fields):

1. **Subject + action** - who/what and what they are doing.
   `A weathered lighthouse keeper climbs a spiral staircase, lantern in hand.`
2. **Appearance detail** - concrete, depictable attributes: clothing, materials, age, expression, colours.
3. **Setting + composition** - where it is, and where things sit in the frame. FLUX.2 honours explicit spatial language:
   `in the foreground`, `centred`, `to the left`, `seen from below`, `a wide establishing shot`.
4. **Lighting + atmosphere** - `golden-hour backlight`, `soft overcast light`, `volumetric fog`, `harsh noon sun`.
5. **Style + medium** - `35mm film photograph`, `oil painting`, `cinematic still`, `flat vector illustration`,
   `architectural render`. Name an era, film stock, or art movement rather than an artist tag.
6. **Any text to render** - put the literal characters in quotes (see [Rendering text](#rendering-text-in-the-image)).

Be specific and generous with detail - FLUX.2's LLM encoder rewards a paragraph far more than a plain SDXL model does.
Two to five sentences is a healthy range for a rich scene. You do not need filler quality words (`masterpiece`,
`best quality`, `8k`); spend those tokens on concrete description instead.

## Expanding a terse user request

When the user asks for something short like "draw a cat in a hat" or "make me a cyberpunk city", do **not** pass that
string through. Expand it into prose before calling `generate_image`:

1. **Anchor the subject** in one clause, then add 3-5 concrete, depictable details (materials, colour, age, expression).
2. **Place it** - name the setting and the composition/camera (`a low-angle wide shot`, `centred portrait`,
   `overhead flat-lay`). Pick one clear framing.
3. **Light it** - one phrase on lighting and mood.
4. **Style it** - one phrase on medium / era / look. Match the user's vibe; ask only if a load-bearing detail is
   genuinely ambiguous (e.g. "a dragon - Western or Eastern?").
5. **Assemble as prose**, not commas. Aim for 2-4 sentences.

Sketch: `a cyberpunk city` becomes

```text
A rain-slicked cyberpunk street at night, crowded with neon signage in pink and cyan reflecting off the wet asphalt.
Steam rises from a noodle stall in the foreground where a lone figure in a translucent raincoat waits. Shot as a
cinematic wide-angle still, shallow depth of field, moody volumetric haze.
```

If the user wants to iterate, pass the prior `seed` back and tweak the wording rather than restarting from scratch.

## When the user supplies their own prompt

If the user hands you a finished descriptive prompt, **preserve their wording and intent** - do not paraphrase it into
tags or strip detail. You may append a short clarifying clause for composition or lighting if something load-bearing is
missing, but keep their voice. If they hand you a _tag list_ and want FLUX.2 output, translate it into prose (the model
reads prose far better than commas) while keeping every concept they listed.

## Rendering text in the image

FLUX.2 can render short, legible text. Put the exact string in quotes and say where it goes:

```text
A vintage enamel shop sign reading "FRESH COFFEE" in bold cream lettering on a dark green background, mounted above a
café door.
```

Keep rendered text short (a word, a phrase, a short sign) - long paragraphs degrade. State the wording, the style of the
lettering, and its placement.

## Editing and reference images

The edit workflows take their output size and base content from the reference image, so they expose neither
`width`/`height` nor `denoise` - you control the result entirely through the `prompt` and the reference(s).

- **`flux2-edit` / `flux2-edit-fast`** - one reference via `inputImages: ["~/in.png"]`. The `prompt` is an **edit
  instruction**: describe the change, not the whole scene.
  `Change the car's colour to matte black and add rain on the windshield.` Keep everything you do not mention implicitly
  unchanged.
- **`flux2-edit-multi`** - two references via `inputImages: ["ref1.png", "ref2.png"]`. Use it to combine elements
  (`Place the character from the first image into the room from the second image, matching its lighting.`). Output size
  follows the first reference.

You can also reuse a prior render as the edit input with the tool's `refine` arg (point it at a generation id and set
`workflow` to an edit variant) instead of passing `inputImages`.

## Generation settings

| Setting    | Value                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Resolution | Target ~1 MP (text-to-image): 1024x1024 square, 1216x832 landscape, 832x1216 portrait. Edit follows source. |
| Steps      | Base graphs ~20; distilled `*-fast` graphs 4.                                                               |
| CFG        | Base graphs ~4-5; distilled `*-fast` graphs 1 (no negative-prompt effect at 1).                             |
| Seed       | Omit for fresh; reuse to reproduce or to vary by tweaking the prompt.                                       |

Steps/CFG live baked in each workflow graph, so the usual move is to **pick the right workflow** (fast vs base) rather
than to override `steps`/`cfg` per call.

## Prompt enhancement (`enhance`)

The `generate_image` tool has an opt-in **`enhance`** option that routes your prompt through a separate model before the
render to rewrite it into the target workflow's native protocol. For FLUX.2 that means turning a terse phrase or a loose
tag list into the kind of rich, descriptive paragraph this guide describes, folding in composition / lighting / style
detail the bare prompt lacked.

- **It is opt-in.** Pass `enhance: true` on the call (or a workflow/config default turns it on). When off, your `prompt`
  is sent verbatim.
- **Use it when** the incoming prompt is thin (a few words, or a comma list) and you want a one-shot upgrade to full
  prose without hand-expanding it yourself. When you have already written a careful descriptive prompt, leave `enhance`
  off - it only adds latency and risks drifting from your intent.
- **Scene continuity.** Pass the `context` arg alongside `enhance` to hand the enhancer background to honour (character
  facts, ongoing scene, wardrobe) without depicting it literally. It is ignored when `enhance` is off.
- **Negative.** The enhancer builds on whatever baseline `negative` you pass and returns a refined one - but remember
  the CFG caveat: on a `*-fast` (CFG 1) graph the resulting negative still has no effect.

## If you are enhancing a prompt rather than rendering

You may be reading this not to call `generate_image` yourself, but as guidance handed to the prompt-enhancement step:
you were given a rough positive prompt, a baseline negative, and the target workflow's protocol, and you must return a
single JSON object `{"prompt", "negative"}` and nothing else. In that role:

- **Act only on the prompt-writing rules above** - prose over tags ([positive recipe](#positive-prompt-recipe)), the
  [terse-request expansion](#expanding-a-terse-user-request), [text rendering](#rendering-text-in-the-image), and the
  [CFG-vs-negative caveat](#cfg-and-the-negative-prompt). The workflow matrix, tool-arg tables, and worked examples do
  not apply - you do not pick a workflow or call any tool.
- **Translate and enrich, do not reinvent.** Keep the incoming subject and intent; turn a terse phrase or a comma-tag
  list into a rich descriptive paragraph in FLUX.2's natural-language style.
- **Always add detail - even to an already-rich prompt.** Do not just echo back a positive that arrives as a full
  paragraph. FLUX.2 rewards more concrete, depictable specifics, so layer in what the prompt leaves unstated: lighting
  and atmosphere, materials and textures, palette, setting depth, camera framing and lens, expression and mood, medium
  or era. The enhanced positive should always be richer than what you were handed, as long as the additions stay
  faithful to the stated subject and do not contradict it.
- **Mine any background context you were given** (a scene/continuity note, recent conversation) for that extra detail,
  and fold it in as FLUX.2-native prose. Treat it as source material to pick depictable specifics from, not a checklist
  to dump and not a subject that overrides the explicit prompt; ignore chatter with no visual bearing.
- **Build on the baseline negative** rather than discarding it. You cannot know whether a base or `*-fast` graph will
  render, so return a sensible negative regardless - but do not over-invest in it, since at CFG 1 it has no effect.

## Worked examples

These illustrate the _shape_ of a finished prompt - adapt them to the actual request, do not reuse them verbatim. Pass
the `prompt` (and `negative`) value as a single string.

Text-to-image (`workflow: flux2-t2i-fast`):

```text
prompt: A close-up portrait of an elderly fisherman with a weathered, sun-creased face and a thick white beard, wearing a yellow oilskin coat beaded with rain. He gazes off-frame with a quiet, resolute expression. Soft overcast daylight, shallow depth of field, the blurred grey of a harbour behind him. Shot on 85mm film, muted colour palette.
```

Text-to-image with negative control (`workflow: flux2-t2i`, CFG ~5):

```text
prompt:   A serene Japanese rock garden at dawn, raked gravel in concentric rings around three mossy stones, a single maple in autumn red at the edge. Soft directional morning light casting long shadows. Minimalist, tranquil, high detail.
negative: people, footprints, clutter, harsh shadows, oversaturated colours
```

Single-image edit (`workflow: flux2-edit-fast`, `inputImages: ["~/room.png"]`) - the `prompt` is the edit instruction:

```text
prompt: Replace the daytime view through the window with a starry night sky and a full moon, and dim the room's lighting to a warm lamp glow. Keep the furniture and layout unchanged.
```

## Anti-patterns

- **Booru / tag spam.** `1girl, solo, long hair, detailed, masterpiece, 8k` underuses FLUX.2. Write a sentence:
  `A young woman with long hair, rendered in fine detail.` Translate any handed-in tag list into prose.
- **Quality-word filler.** `masterpiece, best quality, ultra-detailed, 8k, award-winning` does little here - those
  tokens are better spent on concrete subject, lighting, and style description.
- **Leaning on `negative` at CFG 1.** On a `*-fast` graph the negative prompt is ignored. Either switch to a base graph
  or phrase the exclusion positively in the prompt.
- **Artist tags.** There is no `@artist` / `artist:name` syntax. Name a medium, era, or movement in words instead
  (`in the style of a 1960s screen-printed poster`).
- **Over-long rendered text.** FLUX.2 renders a word or short phrase well, not a paragraph - do not promise a wall of
  legible text on a sign.
- **Describing the whole scene in an edit prompt.** For `flux2-edit*`, give the _change_ as an instruction;
  re-describing the entire image can cause the model to regenerate parts you wanted kept.
- **Cranking steps/CFG instead of switching graphs.** The steps/CFG split is baked per workflow; pick fast vs base
  rather than hand-tuning a `*-fast` graph up to base-graph values.
