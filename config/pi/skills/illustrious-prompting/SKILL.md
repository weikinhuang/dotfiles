---
name: illustrious-prompting
disable-model-invocation: true
description:
  Prompting rules for the OnomaAI **Illustrious-XL** SDXL anime / illustration model. Use when the user asks to generate
  / draw / render an anime / illustration image on an Illustrious-XL workflow (v0.1, v1.0, or a near-vanilla finetune).
  Illustrious takes plain Danbooru tags + natural language - no `score_N` quality tags and no `@`-prefixed artist tags.
  Do not use for photorealism.
---

# Illustrious-XL Prompting

[Illustrious-XL](https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.0) is OnomaAI's SDXL-based anime /
illustration model, trained on the Danbooru2023 dataset. Write the `prompt` and `negative` you pass to the
`generate_image` tool per the rules below to drive Illustrious-XL well on the first call. The rules here are specific to
Illustrious-XL v0.1 / v1.0 and near-vanilla finetunes.

Illustrious supports **Danbooru-style tags, natural-language captions, and mixes of the two**. Per the v1.0 model card,
it "combines advanced natural language processing with concise Danbooru tag-based prompts" - all three styles work.

**Safe default when unsure:** lead the `prompt` with `masterpiece, best quality,`, then describe the subject in roughly
8-15 lowercase Danbooru tags (or 2+ sentences of prose) covering subject, outfit, scene, lighting, and exactly one
framing tag; always pass the recommended `negative` from the [negative recipe](#negative-prompt-recipe). Illustrious has
no style baked in, so terse prompts come out bland - spend the detail. Everything below is how to do better than this
default when the request calls for it.

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

Illustrious accepts Danbooru artist tags directly (e.g. `wlop`, `as109`) - no `@` or `artist:` prefix; write the bare
tag. Artist effect varies by how well the artist is represented in Danbooru2023.

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

**Do not use** `score_9, score_8, score_7_up, source_anime` - those score tags have no documented effect on stock
Illustrious; use `masterpiece, best quality` instead. **Do not use** an `@` prefix on artist tags - write the bare
Danbooru tag.

## Generation settings

| Setting    | Value                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Resolution | 512x512 to 1536x1536. Defaults: 1024x1024 square, 832x1216 portrait, 1216x832 landscape.              |
| Steps      | 20-28.                                                                                                |
| CFG        | 5-7.5. Tag-heavy prompt -> push toward 7; natural-language prompt -> stay near 5.                     |
| Sampler    | `Euler a` is the model card's recommendation. `DPM++ 2M Karras` is a common workflow swap for detail. |

Sampler/scheduler live in the workflow file, not the tool args - only mention a sampler when asking the user to retune
the workflow.

## Prompt enhancement (`enhance`)

The `generate_image` tool has an opt-in **`enhance`** option that routes your prompt through a separate model before the
render to rewrite it into Illustrious's native protocol - the quality-tag-led Danbooru tag list (or tags-plus-prose)
this guide describes.

- **It is opt-in.** Pass `enhance: true` on the call (or a workflow/config default turns it on). When off, your `prompt`
  is sent as-is.
- **Use it when** the incoming prompt is thin (a few words) and you want a one-shot upgrade to a full tagged prompt.
  When you have already built a careful tagged prompt, leave `enhance` off - it only adds latency and risks drifting
  from your intent.
- **Scene continuity.** Pass the `context` arg alongside `enhance` to hand the enhancer background to honour (character
  facts, ongoing scene, wardrobe) without depicting it literally. It is ignored when `enhance` is off.
- **Negative.** The enhancer builds on whatever baseline `negative` you pass and returns a refined one - it should keep
  the recommended cleanup terms (see the [negative recipe](#negative-prompt-recipe)).

## If you are enhancing a prompt rather than rendering

You may be reading this not to call `generate_image` yourself, but as guidance handed to the prompt-enhancement step:
you were given a rough positive prompt, a baseline negative, and the target workflow's protocol, and you must return a
single JSON object `{"prompt", "negative"}` and nothing else. In that role:

- **Act only on the prompt-writing rules above** - lead with `masterpiece, best quality,`, follow the
  [positive recipe](#positive-prompt-recipe) and [tag order](#tag-order), and build the negative from the
  [negative recipe](#negative-prompt-recipe). The generation-settings and tool-arg tables do not apply - you do not pick
  a workflow or call any tool.
- **Translate and enrich, do not reinvent.** Keep the incoming subject and intent; lead with the quality tags and turn
  loose phrasing into lowercase Danbooru tags (or a tags-plus-prose mix). Escape literal parentheses (`\(` `\)`) and use
  the bare artist tag, no `@`.
- **Always add detail - even to an already-tagged prompt.** Illustrious has no baked-in style, so push toward roughly
  8-15 substantive items: infer subject count (`1girl` / `1boy` / `1other`, `solo`), then layer in appearance, exactly
  one framing tag, scene, lighting, and palette that the prompt leaves unstated, staying faithful to the stated subject.
- **Mine any background context you were given** (a scene/continuity note, recent conversation) for that extra detail
  and fold it in as depictable tags. Treat it as source material to pick from, not a checklist to dump and not a subject
  that overrides the explicit prompt; ignore chatter with no visual bearing.
- **Build on the baseline negative** (start from the recommended negative), and add `nsfw, explicit` for SFW work since
  Illustrious controls safety through the negative.

## Worked examples

These illustrate the _shape_ of a finished prompt - adapt them to the actual request, do not reuse them verbatim. Pass
the `prompt` (and `negative`) value as a single string.

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
- **Score tags.** `score_9, score_8_up, source_anime` do nothing reliable on stock Illustrious; use
  `masterpiece, best quality` instead.
- **`@`-prefixed artists.** Write the bare Danbooru tag `wlop`, not `@wlop`.
- **Multiple framing tags.** `cowboy shot, close-up, full body` confuses composition - pick ONE per the model card.
- **Dropping the negative.** Always pass one; it is the primary cleanup lever for hands, artifacts, and unwanted styles.
- **Pushing CFG past 8.** Burns colors and crisps edges into noise. Stay 5-7.5.
