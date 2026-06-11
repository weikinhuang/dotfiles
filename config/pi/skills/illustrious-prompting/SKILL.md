---
name: illustrious-prompting
disable-model-invocation: true
description:
  Prompting rules for the OnomaAI **Illustrious-XL** SDXL anime / illustration model. Use when the user asks to generate
  / draw / render an anime / illustration image on an Illustrious-XL workflow (v0.1, v1.0, or a near-vanilla finetune).
  Illustrious takes plain Danbooru tags + natural language - no Pony score tags, no Anima `@artist` prefix. Do not use
  for photorealism.
---

# Illustrious-XL Prompting

[Illustrious-XL](https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.0) is OnomaAI's SDXL-based anime /
illustration model, trained on the Danbooru2023 dataset. This skill teaches how to write the `prompt` and `negative` you
pass to the [`generate_image`](../../extensions/comfyui.md) tool so a small chat model drives it well on the first call.
It is specific to Illustrious-XL (v0.1 / v1.0 and near-vanilla finetunes) - the rules below do not apply to NoobAI (see
[[noobai-vpred-prompting]]), Pony, or Anima (see [[anima-prompting]]).

Illustrious supports **Danbooru-style tags, natural-language captions, and mixes of the two**. Per the v1.0 model card,
it "combines advanced natural language processing with concise Danbooru tag-based prompts" - all three styles work.

## The `generate_image` call

| Arg                | For Illustrious-XL                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required. Lead with quality tags; then subject; then descriptive tags. No `score_N`, no `@artist`.          |
| `negative`         | Always pass one. Start from the recommended negative below.                                                 |
| `workflow`         | Use the Illustrious workflow when configured; omit only if it is `defaultWorkflow`.                         |
| `width` / `height` | Native 1536x1536. Safe defaults 1024x1024 or 832x1216 portrait. Range 512x512-1536x1536; 1248x1824 is fine. |
| `steps`            | 20-28. Leave the workflow default unless quality is lacking.                                                |
| `cfg`              | 5-7.5. Push to 7 only for tag-heavy prompts; lower for natural-language ones.                               |
| `seed`             | Omit for a fresh random image; pass a prior seed to reproduce or vary.                                      |

Do not pass `inputImage` unless the workflow is an Illustrious img2img variant.

## Positive prompt recipe

1. **Lead with quality tags:** `masterpiece, best quality,` (optional: `highres, absurdres,` for higher fidelity bias).
2. **Then the subject** as tags, natural language, or a mix. Lowercase, comma-separated.
3. **Spaces over underscores** in general tags (`brown hair`, not `brown_hair`). Multi-word proper nouns from Danbooru
   may keep their underscores (`hatsune_miku`) and both forms usually work - prefer spaces when unsure.
4. **Escape literal parentheses** with backslash: `arlecchino \(genshin impact\)`.
5. **Name then describe characters.** With multiple characters, describe each one's hair / eyes / outfit or the model
   conflates them.
6. **Be specific.** Illustrious has no default style baked in - short or vague prompts give bland output. Name the
   scene, lighting, palette, framing.
7. **Pick one framing tag**, not three. `cowboy shot, close-up, full body` conflict; the model card warns against
   overusing them.

### Tag order

```text
[quality / meta tags] [1girl / 1boy / 1other] [character] [series] [general tags: pose, outfit, scene, lighting, palette]
```

Order matters between sections; within a section tags are free-order. Tag dropout during training means you do not need
every relevant tag.

### Artist styles

Illustrious accepts Danbooru artist tags directly (e.g. `wlop`, `as109`) - no `@` prefix required (that is an Anima
rule, not an Illustrious one). Artist effect varies by how well the artist is represented in Danbooru2023.

## Negative prompt recipe

Start from the model card's recommendation and add situational terms:

```text
worst quality, comic, multiple views, bad quality, low quality, lowres, displeasing, very displeasing,
bad anatomy, bad hands, scan artifacts, monochrome, greyscale, signature, twitter username,
jpeg artifacts, 2koma, 4koma, guro, extra digits, fewer digits
```

- Add `nsfw, explicit` for SFW work (Illustrious has no `safe` positive-prompt convention; control with the negative).
- Add the specific thing you don't want (`text, watermark, multiple views, deformed`).
- Drop `monochrome, greyscale` if you actually want monochrome.

## Tag reference

| Group          | Values                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Quality        | `masterpiece`, `best quality`, `good quality`, `normal quality`, `low quality`, `worst quality` |
| Meta           | `highres`, `absurdres`, `official art`, `scan`, `jpeg artifacts` (usually negative)             |
| Framing        | `portrait`, `upper body`, `cowboy shot`, `full body`, `close-up` - pick ONE                     |
| Lighting       | `rim lighting`, `backlighting`, `cinematic lighting`, `soft lighting`, `dramatic lighting`      |
| Palette / mood | `muted colors`, `vibrant`, `low contrast`, `high contrast`, `black theme`, `pastel colors`      |

**Do not use** `score_9, score_8, score_7_up, source_anime` - those are Pony conventions and have no documented effect
on stock Illustrious. **Do not use** the `@artist` prefix - that is Anima-specific.

## Generation settings

| Setting    | Value                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Resolution | 512x512 to 1536x1536. Defaults: 1024x1024 square, 832x1216 portrait, 1216x832 landscape.              |
| Steps      | 20-28.                                                                                                |
| CFG        | 5-7.5. Tag-heavy prompt -> push toward 7; natural-language prompt -> stay near 5.                     |
| Sampler    | `Euler a` is the model card's recommendation. `DPM++ 2M Karras` is a common workflow swap for detail. |

Sampler/scheduler live in the workflow file, not the tool args - only mention a sampler when asking the user to retune
the workflow.

## Worked examples

Tag-style:

```text
prompt:   masterpiece, best quality, highres, 1girl, solo, long silver hair, green eyes, witch hat, deep blue robe,
          standing, holding spellbook, glowing magic, sunlit library, dust motes, window backlight, soft lighting,
          looking at viewer, detailed background
negative: worst quality, low quality, lowres, bad anatomy, bad hands, jpeg artifacts, signature, watermark,
          extra digits, multiple views, nsfw
```

Natural-language:

```text
prompt:   masterpiece, best quality. A young anime witch with short silver hair and green eyes stands in a sunlit
          library, wearing a wide-brimmed black hat and a deep blue robe. She holds an open spellbook that glows
          faintly, and dust motes drift in the light from a tall window behind her. Soft warm palette, cinematic
          lighting.
negative: worst quality, low quality, lowres, bad anatomy, bad hands, blurry, jpeg artifacts, watermark, nsfw
```

The wrapped lines above are a single comma/space-joined string each - pass them as one line in the tool args.

## Anti-patterns

- **Photorealism prompts.** Illustrious is anime/illustration; redirect rather than fight it. For realism, suggest a
  different checkpoint.
- **Three-word prompts.** `a cat girl` underuses the model - Illustrious has no default style, so you get bland output.
  Add quality tags + 6-12 descriptors covering pose, outfit, scene, lighting.
- **Pony score tags.** `score_9, score_8_up, source_anime` do nothing reliable on stock Illustrious; they belong to Pony
  Diffusion derivatives. Use `masterpiece, best quality` instead.
- **Anima `@artist` syntax.** `@wlop` is an Anima convention; on Illustrious write the bare tag `wlop`.
- **Multiple framing tags.** `cowboy shot, close-up, full body` confuses composition - pick ONE per the model card.
- **Dropping the negative.** Always pass one; it is the primary cleanup lever for hands, artifacts, and unwanted styles.
- **Pushing CFG past 8.** Burns colors and crisps edges into noise. Stay 5-7.5.
