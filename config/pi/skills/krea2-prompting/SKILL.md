---
name: krea2-prompting
disable-model-invocation: true
description:
  Prompting rules for the open-weight **Krea 2 Turbo** text-to-image model on the comfyui `krea2` / `krea2-2gpu`
  workflows. Use when the user asks to generate / draw / render an image on a Krea 2 workflow. Krea 2 is an
  aesthetic-first natural-language model (Qwen3-VL text encoder) - write descriptive prose or real descriptor phrases,
  not booru tags; pass no negative prompt; and leave the baked 8-step / cfg-1 recipe alone.
---

# Krea 2 Turbo Prompting

[Krea 2](https://huggingface.co/Comfy-Org/Krea-2) is Krea's open-weight, from-scratch 12B diffusion transformer (Qwen
Image VAE + a **Qwen3-VL language-model text encoder**). The encoder is what gives it strong prompt adherence: it reads
long, structured, natural-language descriptions rather than tag lists. The `krea2` workflow runs the **Turbo**
checkpoint, an 8-step distilled model tuned for fast, high-quality photoreal output. Write the `prompt` you pass to
`generate_image` per the rules below to drive it well on the first call.

Two rules matter most:

- **Natural language, not tags.** Describe the image as you would to a photographer - complete clauses or real
  descriptor phrases (`golden-hour backlight, 85mm, shallow depth of field`), never booru/quality tags
  (`1girl, masterpiece, 8k, score_9`). There is no quality prefix, no `@artist` syntax, no score tags.
- **Aesthetic-first: trust it, prompt less.** Krea makes flattering art-direction choices on its own (rim light, colour
  grading, balanced framing). A short prompt yields variety; add structure only when you need control.

**Safe default when unsure:** use the `krea2` workflow, write `prompt` as one or two descriptive sentences (subject,
setting, lighting, style), set `width`/`height` (or `aspect`) for the framing, and pass nothing else - no `negative`,
and do not touch `steps`/`cfg`/`seed` unless reproducing a prior image.

## The `generate_image` call

| Arg                | For Krea 2 Turbo                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required. A natural-language description (flowing prose or comma-joined real descriptor phrases). No tags. |
| `workflow`         | `krea2` or `krea2-2gpu` (see below). Omit if `krea2` is the configured `defaultWorkflow`.                  |
| `width` / `height` | ~1-4 MP: `1024x1024` square, `1216x832` landscape, `832x1216` portrait, up to `2048` on the long side.     |
| `aspect`           | Preset (`16:9`, `portrait`, `square`, …) as an alternative to explicit `width`/`height`.                   |
| `seed`             | Omit for a fresh image; pass a prior seed to reproduce or to vary by tweaking the prompt.                  |
| `count`            | Batch size.                                                                                                |
| `enhance`          | Opt-in prompt rewrite before rendering (see [enhancement](#prompt-enhancement-enhance)).                   |

Krea 2 maps **no `negative`** (it uses none) and **no `steps` / `cfg`** - the 8-step / cfg-1 distilled recipe is baked
into the graph and is deliberately not exposed. Do not try to raise steps or cfg; it breaks the distilled model. Shape
the result through the `prompt` and pick resolution via `width`/`height`/`aspect`.

### Which workflow

| Workflow     | Use it for                                                                         | GPUs                      |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------- |
| `krea2`      | The default - whole pipeline on one GPU.                                           | 1                         |
| `krea2-2gpu` | Same output, but text encoder + VAE run on a second GPU to free VRAM on the first. | 2 (+ multi-GPU node pack) |

Pick `krea2` unless the host has two cards and you specifically want the split; the images are identical.

## Positive prompt recipe

Write a coherent description, moving through these beats in roughly this order (as prose or descriptor phrases, not
labelled fields):

1. **Subject + action** - who/what and what they are doing. `A weathered fisherman mends a net on a wooden dock.`
2. **Appearance + material** - concrete, depictable attributes: wardrobe, materials, age, expression, colour.
3. **Setting + composition** - where it is and how it is framed. Krea reads cinematic framing: shot size
   (`extreme close-up`, `portrait`, `full body`, `wide establishing shot`), angle (`eye level`, `low angle`,
   `three-quarter`, `top-down`), placement (`rule of thirds`, `off-centre`, `negative space`).
4. **Lighting** - do the heavy lifting here. Quality (`soft diffused`, `hard directional`, `golden hour`, `overcast`,
   `studio`, `volumetric`), direction (`backlit`, `rim light`, `side light`, `top light`), mood (`moody low-key`,
   `bright high-key`, `warm tungsten`, `cool blue hour`).
5. **Mood + atmosphere** - one phrase on the feeling.
6. **Medium + style** - name it explicitly (`editorial photograph`, `cinematic film still`, `oil painting`,
   `watercolour`, `anime illustration`) to avoid hybrid results. Name an era or film stock rather than an artist.
7. **Camera + texture detail** - lens (`35mm`, `85mm`), aperture (`f/1.4`), `shallow depth of field`, `soft bokeh`,
   `film grain`, and fine-texture cues (`natural skin texture`, `fabric weave`, `wet black stone`, `glossy reflections`,
   `micro-reflections`).

You do not need every beat. Krea's aesthetic sense fills gaps; spend words on the specifics that matter for this image.

## How much to write

Match length to intent:

- **Explore (5-20 words):** a short prompt for variety - let the model's aesthetic drive.
- **Controlled (30-80 words):** subject + composition + lighting + style, when you know what you want.
- **Complex scene (80-140 words):** layered detail for a specific, busy composition.

Prefer clear clauses over one long run-on. Flowing prose and comma-joined descriptor phrases both work - what matters is
that the tokens are real descriptors, not tags or quality filler.

## Rendering text in the image

Krea 2 renders short, legible text. Put the exact string in double quotes and keep it short - a word or a short sign
renders cleanly, long paragraphs degrade:

```text
A vintage enamel shop sign reading "FRESH COFFEE" in cream lettering on a dark green background, mounted above a cafe door.
```

State the wording, the lettering style, and where it sits.

## No negative prompt

Krea 2 does not use a negative prompt - the graph zeroes the negative conditioning out. Do not pass `negative`; phrase
exclusions positively in the positive prompt instead (`a clean, empty desk` rather than leaning on `negative: clutter`).

## Expanding a terse user request

When the user asks for something short like "a fox in the snow", do **not** pass that string through - expand it into a
Krea 2 description first:

1. **Anchor the subject** in one clause, then add a few concrete, depictable details.
2. **Place + frame it** - setting and one composition/camera choice.
3. **Light it** - one phrase on light and mood.
4. **Name the medium** - photograph, cinematic still, illustration.
5. **Assemble as one or two sentences**, not a comma dump.

Sketch: `a fox in the snow` becomes

```text
A red fox trotting across fresh snow at dawn, soft backlight catching the mist of its breath, shallow depth of field,
muted blue-grey winter palette, editorial wildlife photograph.
```

If the user hands you a finished descriptive prompt, preserve their wording and intent - lightly polish rather than
rewrite. If they hand you a tag list, translate it into descriptive language while keeping every concept.

## Prompt enhancement (`enhance`)

The `generate_image` tool has an opt-in **`enhance`** option that routes your prompt through a separate model before the
render, rewriting a thin prompt into the rich Krea-2 description this guide covers.

- **Opt-in.** Pass `enhance: true` (or a workflow/config default turns it on). When off, your `prompt` is sent verbatim.
- **Use it when** the incoming prompt is a few words or a loose list. When you have already written a careful
  description, leave it off - it only adds latency and can drift from your intent.
- **Scene continuity.** Pass the `context` arg alongside `enhance` to hand the enhancer background to honour (character
  facts, ongoing scene) without depicting it literally. Ignored when `enhance` is off.

## If you are enhancing a prompt rather than rendering

You may be reading this not to call `generate_image`, but as guidance handed to the prompt-enhancement step: you were
given a rough prompt and must return the single enhanced positive string and nothing else. In that role:

- **Act only on the prompt-writing rules above** - the [positive recipe](#positive-prompt-recipe), the
  [terse-request expansion](#expanding-a-terse-user-request), and [text rendering](#rendering-text-in-the-image). The
  workflow tables and tool args do not apply; you do not pick a workflow or call a tool.
- **Translate and enrich, do not reinvent.** Preserve the subjects, actions, colours, and spatial relationships you were
  given; do not add new objects, people, or props the request does not imply. Honour the medium the user asked for
  (photo, illustration, painting) rather than pivoting to an easier one.
- **Write one cohesive description** in Krea's natural-language style - no tags, no bullets, no negative prompt.
- **Layer in depictable specifics** the prompt leaves unstated (lighting, materials, palette, framing, lens, mood), and
  fold in any background context you were given as source material - but keep it faithful to the stated subject.
- **Respect the human form** - treat people with dignity and assume clothing.

## Worked examples

These show the _shape_ of a finished prompt; adapt them to the request rather than reusing them. The first two are
validated Krea 2 Turbo renders.

Photoreal portrait (`workflow: krea2`):

```text
A cinematic golden-hour portrait of a weathered fisherman on a wooden dock, shot on 85mm f/1.4, soft warm rim light, shallow depth of field, visible film grain, natural skin texture, editorial photograph.
```

Product / still life (`workflow: krea2`):

```text
A close-up product shot of a vintage brass compass on weathered nautical charts, dramatic side lighting, shallow depth of field, fine metal and paper texture, editorial photograph.
```

Reusable skeletons:

```text
Portrait:  [shot size] portrait of [subject] in [wardrobe], [setting], [lighting], [lens feel], [colour grade]
Cinematic: A cinematic film still of [scene], [time of day], [lighting], [atmosphere], [colour grade]
Product:   [style] product shot of [object] on [surface], [lighting direction], [detail cues]
```

## Anti-patterns

- **Booru / quality-tag spam.** `1girl, solo, masterpiece, 8k, score_9` underuses Krea 2 and flattens the output. Write
  descriptors or prose instead; translate any handed-in tag list.
- **Artist / score tags.** There is no `@artist`, `artist:name`, or score-tag syntax. Name a medium, era, or movement in
  words.
- **Passing a `negative`.** It is zeroed out and does nothing. Phrase the exclusion positively in the prompt.
- **Overriding `steps` / `cfg`.** The 8-step / cfg-1 distilled recipe is baked; raising either breaks the model. Change
  the look through the prompt, not the sampler.
- **Over-long rendered text.** Krea renders a word or short sign well, not a paragraph. Keep quoted text short.
- **Expecting cloud-only features.** The open-weight Turbo has no `creativity` dial, moodboards, or style-reference
  images - those belong to Krea's hosted API. Local style shifts come from LoRAs, not those knobs.
