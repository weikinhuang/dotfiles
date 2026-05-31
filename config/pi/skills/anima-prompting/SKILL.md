---
name: anima-prompting
description:
  'WHAT: How to write positive and negative prompts - and pick steps / cfg / sampler / resolution - for the CircleStone
  Labs **Anima** anime / illustration model when calling the `generate_image` tool: Danbooru-tag + natural-language
  craft, the `masterpiece, best quality, score_7, safe` prefix, the `@artist` rule, tag order, and a matching negative.
  WHEN: The user asks you to generate, draw, or render an anime / illustration / character / non-photoreal image through
  `generate_image` and the active workflow is Anima (anima-base diffusion model + qwen text encoder). DO-NOT: Use it for
  photorealism (Anima is not a realism model); emit three-word prompts (short prompts produce plain or undesired/unsafe
  output - add detail + safety tags); use underscores in tags except `score_N`; use SDXL-level prompt weights (Anima
  needs higher, e.g. `(chibi:2)`); omit the `@` before an artist name (the effect is near-zero without it); rely on long
  text rendering.'
---

# Anima Prompting

[Anima](https://huggingface.co/circlestone-labs/Anima) is a 2B anime / illustration text-to-image model (CircleStone
Labs + Comfy Org). This skill teaches how to write the `prompt` and `negative` you pass to the
[`generate_image`](../../extensions/comfyui.md) tool so a small chat model drives it well on the first call. It is
specific to Anima - the score tags, `@artist` rule, and qwen-text-encoder behavior below do not apply to a plain SD /
SDXL workflow.

Anima is trained on **Danbooru-style tags, natural-language captions, and mixes of the two**. All three work; pick
whichever fits the request and always lead with quality + safety tags.

## The `generate_image` call

| Arg                | For Anima                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required. The full positive prompt **including** the `masterpiece, best quality, score_7, safe` prefix. |
| `negative`         | Always pass one. Start from the recommended negative below.                                             |
| `workflow`         | Use `anima` when that workflow is configured; omit only if it is the `defaultWorkflow`.                 |
| `width` / `height` | 512-1536; default 1024x1024. Use portrait (e.g. 832x1216) for a single standing character.              |
| `steps`            | 30-50. Leave the workflow default (30) unless quality is lacking.                                       |
| `cfg`              | 4-5. Higher burns the image; do not push past ~5.                                                       |
| `seed`             | Omit for a fresh random image; pass a prior seed to reproduce or vary one.                              |

You set the entire `prompt` string - it replaces the workflow's baked text, so the quality/safety prefix must be in your
prompt every time. Do not pass `inputImage` (Anima here is text-to-image only).

## Positive prompt recipe

1. **Lead with the prefix:** `masterpiece, best quality, score_7, safe,`
2. **Then the subject**, as tags, natural language, or a mix.
3. **Lowercase tags, spaces not underscores** - the only underscored tags are score tags (`score_7`). Prefer the
   Gelbooru spelling when a tag differs between boorus.
4. **Be specific.** Anima's base style is plain; short prompts give bland or unexpected (sometimes unsafe) output. For
   natural language aim for >=2 sentences.
5. **Name then describe characters.**
   `Fern from Sousou no Frieren, with long purple hair and purple eyes, wearing a black coat...` - especially with
   multiple characters, describe each one's appearance or the model conflates them.
6. **Artists need `@`:** write `@artist name` (the `@` is mandatory; without it the style barely registers). You may put
   quality/artist tags at the start of a natural-language prompt too.

### Tag order (tag-style prompts)

```text
[quality / meta / year / safety] [1girl / 1boy / 1other] [character] [series] [@artist] [general tags]
```

Order only matters between sections; within a section tags are free-order. You do not need every relevant tag - the
model was trained with tag dropout.

## Negative prompt recipe

Start from the official recommendation and add situational terms:

```text
worst quality, low quality, score_1, score_2, score_3, artist name
```

- Add `jpeg artifacts, blurry, lowres` to clean up artifacts.
- Add `nsfw, explicit, sensitive` to hold the image safe (pair with `safe` in the positive).
- Add the specific thing you don't want (e.g. `multiple views, text, watermark, extra fingers`).

## Tag reference

| Group           | Values                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Quality (human) | `masterpiece`, `best quality`, `good quality`, `normal quality`, `low quality`, `worst quality` |
| Quality (Pony)  | `score_9` ... `score_1` (use human, Pony, both, or neither - all work)                          |
| Safety          | `safe`, `sensitive`, `nsfw`, `explicit`                                                         |
| Meta            | `highres`, `absurdres`, `anime screenshot`, `official art`, `jpeg artifacts`                    |
| Time            | `year 2025` (specific) or period: `newest`, `recent`, `mid`, `early`, `old`                     |
| Weighting       | Works, but heavier than SDXL: `(chibi:2)`, not `(chibi:1.2)`                                    |

## Generation settings

| Setting    | Value                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Resolution | 512x512 to 1536x1536; 1024x1024 default.                                                          |
| Steps      | 30-50.                                                                                            |
| CFG        | 4-5.                                                                                              |
| Sampler    | `er_sde` is the neutral default; `euler_a` for softer lines; `dpmpp_2m_sde_gpu` for more variety. |

Sampler/scheduler live in the workflow file, not the tool args - mention a sampler only if asking the user to retune the
workflow.

## Worked examples

Tag-style:

```text
prompt:   masterpiece, best quality, score_7, safe, 1girl, solo, long hair, brown eyes, santa costume,
          fur-trimmed gloves, holding gift box, looking at viewer, simple background, white background, @nnn yryr
negative: worst quality, low quality, score_1, score_2, score_3, artist name, jpeg artifacts, nsfw
```

Natural-language:

```text
prompt:   masterpiece, best quality, score_7, safe. A young anime witch with short silver hair and green eyes
          stands in a sunlit library, wearing a wide-brimmed black hat and a deep blue robe. She holds an open
          spellbook that glows faintly, and dust motes drift in the light from a tall window behind her.
negative: worst quality, low quality, score_1, score_2, score_3, artist name, blurry, nsfw, explicit
```

The wrapped lines above are a single comma/space-joined string each - pass them as one line in the tool args.

## Anti-patterns

- **Asking for realism / photos.** Anima is anime/illustration only and will not do realism - redirect or set
  expectations instead of fighting it.
- **Three-word prompts.** `a cat girl` underuses the model and risks plain or unsafe output. Add quality + safety tags
  and concrete details.
- **Underscores in tags.** `brown_hair` is wrong; write `brown hair`. Only `score_7` keeps the underscore.
- **SDXL-level weights.** `(chibi:1.2)` barely moves Anima; use `(chibi:2)`.
- **Forgetting `@` on an artist.** `nnn yryr` ~= no effect; `@nnn yryr` applies the style.
- **Long text in the image.** Anima renders a single word or short phrase at best - do not promise a paragraph on a
  sign.
- **Dropping the `negative` arg.** Always pass one; it is the main lever for quality and safety.
