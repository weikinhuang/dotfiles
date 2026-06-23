---
name: anima-prompting
disable-model-invocation: true
description:
  Prompting rules for the CircleStone Labs **Anima** anime / illustration model. Use when the user asks to generate /
  draw / render an anime / illustration / non-photoreal image on an Anima workflow. Anima uses score tags and an
  `@artist` prefix syntax; it is for anime / illustration, not photorealism.
---

# Anima Prompting

[Anima](https://huggingface.co/circlestone-labs/Anima) is a 2B anime / illustration text-to-image model (CircleStone
Labs + Comfy Org), built on NVIDIA Cosmos with a qwen-text-encoder LLM adapter that has outsized influence on the
generated image. Write the `prompt` and `negative` you pass to the `generate_image` tool per the rules below to drive
Anima well on the first call. The score tags, `@artist` rule, and qwen-text-encoder behavior below are specific to
Anima.

Anima is trained on **Danbooru-style tags of the Gelbooru flavor, natural-language captions, and mixes of the two**
(anime training data cuts off September 2025). All three work; pick whichever fits the request and always lead with
quality + safety tags. The LLM adapter is what makes detailed prompts pay off here far more than on a plain SDXL model -
terse prompts waste the model's strongest feature.

**Safe default when unsure:** use the `anima` workflow, begin the `prompt` with
`masterpiece, best quality, score_7, safe,`, describe the subject in roughly 12-25 lowercase tags (or 2+ sentences of
prose), and always pass the recommended `negative` from the [negative recipe](#negative-prompt-recipe). Short prompts
make Anima bland or unsafe, so spend the detail. Everything below is how to do better than this default when the request
calls for it.

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
   natural language aim for >=2 sentences. For tag style aim for >=8 substantive tags after the prefix. The model card
   warns explicitly: "The model may generate undesired content, especially if the prompt is short or lacking details."
5. **Name then describe characters.**
   `Fern from Sousou no Frieren, with long purple hair and purple eyes, wearing a black coat...` - especially with
   multiple characters, describe each one's appearance or the model conflates them.
6. **Artists need `@`:** write `@artist name` (the `@` is mandatory; without it the style barely registers). You may put
   quality/artist tags at the start of a natural-language prompt too. An `@artist` tag also **locks a consistent style
   across seeds** - pin one when you want the same house look from image to image (verified: same `@artist` holds the
   style steady across different seeds).

### Tag order (tag-style prompts)

```text
[quality / meta / year / safety] [1girl / 1boy / 1other] [character] [series] [@artist] [general tags]
```

Order only matters between sections; within a section tags are free-order. You do not need every relevant tag - the
model was trained with tag dropout.

## Expanding a terse user request

When the user asks for something short like "draw a cat girl" or "make me a witch", do **not** pass that string through.
Expand it before calling `generate_image`:

1. **Prefix:** add `masterpiece, best quality, score_7, safe,`.
2. **Subject count + type:** infer `1girl` / `1boy` / `1other`, plus `solo` if a single character.
3. **Character / series:** only if the user named one (`Frieren from Sousou no Frieren`); otherwise skip.
4. **Appearance:** invent 3-5 concrete details - hair color + length, eye color, outfit, distinctive accessory. Match
   the user's vibe; ask only if their wording is genuinely ambiguous about a load-bearing detail (e.g. "anime girl in a
   kimono - red or blue?").
5. **Pose / framing:** 1-2 tags - `looking at viewer`, `standing`, `upper body`, `cowboy shot`. Pick ONE framing tag.
6. **Setting:** 2-4 tags or a clause - `sunlit library, tall window, dust motes`, or
   `simple background, white background` for a clean character shot.
7. **Lighting + palette:** 1-3 tags - `soft lighting`, `cinematic lighting`, `warm palette`, `muted colors`.
8. **Era (optional):** add `year 2025` or `newest` for a modern look; skip for timeless.
9. **Artist (optional):** only if the user named one - prepend `@` (e.g. `@some artist`).
10. **Negative:** always pass the recommended negative; add `extra fingers, text, watermark` for cleaner output.

The goal is roughly 12-25 substantive items in the positive prompt. If the user wants to iterate, pass the prior `seed`
back to vary by tweaking tags rather than restarting.

## When the user supplies tags directly

If the user hands you a tag list (or a tag list mixed with wildcards) instead of a terse English request, switch modes:

1. **Preserve every user-supplied tag verbatim.** Do not paraphrase, deduplicate, reorder across sections, or "improve"
   their wording.
2. **Prepend the prefix if missing.** Add `masterpiece, best quality, score_7, safe,` only if the user did not already
   include quality / safety tags.
3. **Add spatial / positional words only.** Insert framing words like `in the center of the frame`, `foreground`,
   `background`, `in front of`, `surrounded by`, `on either side` to disambiguate where elements sit. Do not add
   weather, lighting, palette, or outfit details the user did not ask for.
4. **Preserve dynamic-prompt wildcards exactly.** `{A|B}`, `{A,|B,|C}`, `{1-3$$ A|B|C}`, and `{A,B}_noun` are
   wildcard-extension syntax (ComfyUI Impact-Pack, sd-dynamic-prompts) - they expand at generation time, not in your
   prompt. Pass them through unchanged: never rewrite `{standing|sitting}` as `"standing or sitting"`, never pick one
   branch, never delete a branch.
5. **Append a one-sentence natural-language clause** describing spatial relationships - Anima's qwen adapter benefits
   from prose, so a single closing sentence on top of the tag list usually improves coherence without adding
   embellishment.

```text
prompt:   masterpiece, best quality, score_7, safe, 1girl, {standing|sitting}, classroom, desk, {morning|evening},
          a young female student positioned in the center of the classroom in front of the desk, with the
          {morning|evening} lighting implied by the scene
negative: worst quality, low quality, score_1, score_2, score_3, artist name
```

Concatenate the tag list and the natural-language clause into one `prompt` string (comma- or period-joined) - the tool
takes a single string, and Anima reads mixed input fine.

## Negative prompt recipe

Start from the official recommendation and add situational terms:

```text
worst quality, low quality, score_1, score_2, score_3, artist name
```

- Add `jpeg artifacts, blurry, lowres` to clean up artifacts.
- Add the specific thing you don't want (e.g. `multiple views, text, watermark, extra fingers`).
- **Do not put a rating word (`safe`, `sensitive`, `nsfw`, `explicit`) in the negative.** Safety is carried by the
  rating tag in the _positive_ prefix, not by negating it here, and putting `nsfw` in the negative actively fights the
  positive the moment the scene is `sensitive` or higher. Keep the negative rating-free; every example below does. (On a
  `safe` shot, on a workflow that does **not** auto-scrub the negative, you _may_ reinforce with `nsfw` here - but never
  above `safe`. When in doubt, leave it out and let the positive rating tag do the work.)

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

| Setting    | Value                                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolution | 512x512 to 1536x1536; 1024x1024 default.                                                                                                                                                                                                            |
| Steps      | 30-50.                                                                                                                                                                                                                                              |
| CFG        | 4-5.                                                                                                                                                                                                                                                |
| Sampler    | `er_sde` is the neutral default; `euler_a` for softer lines; `dpmpp_2m_sde_gpu` for more variety.                                                                                                                                                   |
| Scheduler  | Workflow default (`simple`) is a good neutral pick. Valid options vary by install (commonly `simple`, `normal`, `karras`, `beta`, `kl_optimal`). NOTE: `beta57` is a custom-node scheduler and is NOT on a stock ComfyUI - do not assume it exists. |

Sampler/scheduler live in the workflow file, not the tool args - mention a sampler only if asking the user to retune the
workflow.

## Prompt enhancement (`enhance`)

The `generate_image` tool has an opt-in **`enhance`** option that routes your prompt through a separate model before the
render to rewrite it into Anima's native protocol - the score/safety-prefixed tag list this guide describes.

- **It is opt-in.** Pass `enhance: true` on the call (or a workflow/config default turns it on). When off, your `prompt`
  is sent as-is.
- **Use it when** the incoming prompt is thin (a few words) and you want a one-shot upgrade to a full tagged prompt.
  When you have already built a careful tagged prompt, leave `enhance` off - it only adds latency and risks drifting
  from your intent.
- **Scene continuity.** Pass the `context` arg alongside `enhance` to hand the enhancer background to honour (character
  facts, ongoing scene, wardrobe) without depicting it literally. It is ignored when `enhance` is off.
- **Negative.** The enhancer builds on whatever baseline `negative` you pass and returns a refined one - it should keep
  rating words out of the negative (see the [negative recipe](#negative-prompt-recipe)).

## If you are enhancing a prompt rather than rendering

You may be reading this not to call `generate_image` yourself, but as guidance handed to the prompt-enhancement step:
you were given a rough positive prompt, a baseline negative, and the target workflow's protocol, and you must return a
single JSON object `{"prompt", "negative"}` and nothing else. In that role:

- **Act only on the prompt-writing rules above** - the score/safety prefix, the
  [positive recipe](#positive-prompt-recipe) and [tag order](#tag-order-tag-style-prompts), the
  [terse-request expansion](#expanding-a-terse-user-request), and the [negative recipe](#negative-prompt-recipe). The
  generation-settings and tool-arg tables do not apply - you do not pick a workflow or call any tool.
- **Translate and enrich, do not reinvent.** Keep the incoming subject and intent; lead with
  `masterpiece, best quality, score_7, safe,` and turn loose phrasing into lowercase Gelbooru-style tags (or a
  tags-plus-prose mix). Preserve any dynamic-prompt wildcards (`{A|B}`) unchanged.
- **Always add detail - even to an already-tagged prompt.** Anima produces bland or unsafe output from short prompts, so
  push toward roughly 12-25 substantive items: infer subject count (`1girl` / `1boy` / `1other`, `solo`), then layer in
  appearance, one framing tag, setting, and lighting / palette that the prompt leaves unstated, staying faithful to the
  stated subject.
- **Mine any background context you were given** (a scene/continuity note, recent conversation) for that extra detail
  and fold it in as depictable tags. Treat it as source material to pick from, not a checklist to dump and not a subject
  that overrides the explicit prompt; ignore chatter with no visual bearing.
- **Build on the baseline negative** (start from `worst quality, low quality, score_1, score_2, score_3, artist name`),
  and keep rating words (`safe` / `sensitive` / `nsfw` / `explicit`) out of it.

## Worked examples

These illustrate the _shape_ of a finished prompt - adapt them to the actual request, do not reuse them verbatim.

Tag-style:

```text
prompt:   masterpiece, best quality, score_7, safe, 1girl, solo, long hair, brown eyes, santa costume,
          fur-trimmed gloves, holding gift box, looking at viewer, simple background, white background, @some artist
negative: worst quality, low quality, score_1, score_2, score_3, artist name, jpeg artifacts
```

Natural-language:

```text
prompt:   masterpiece, best quality, score_7, safe. A young anime witch with short silver hair and green eyes
          stands in a sunlit library, wearing a wide-brimmed black hat and a deep blue robe. She holds an open
          spellbook that glows faintly, and dust motes drift in the light from a tall window behind her.
negative: worst quality, low quality, score_1, score_2, score_3, artist name, blurry
```

The wrapped lines above are a single comma/space-joined string each - pass them as one line in the tool args.

## Anti-patterns

- **Asking for realism / photos.** Anima is anime/illustration only and will not do realism - redirect or set
  expectations instead of fighting it.
- **Heavy environment prose on a single-character shot.** A long multi-sentence paragraph describing the _room/scene_
  dilutes the character tags and visibly degrades character detail. Keep prose to a short clause (one sentence) for pose
  / light / spatial framing and describe the character with tags. Character-focused prose is fine; a wall of scenery
  prose is not. (Verified by A/B at a fixed seed.)
- **Dropping the setting entirely.** If neither a tag nor the prose names the location, Anima defaults to a plain white
  background. Name the setting somewhere if you want one.
- **Three-word prompts.** `a cat girl` underuses the model and risks plain or unsafe output. Run it through the
  [expansion algorithm](#expanding-a-terse-user-request) - target ~12-25 substantive items. As a sketch, `a cat girl`
  becomes:

  ```text
  masterpiece, best quality, score_7, safe, 1girl, solo, cat ears, cat tail, short brown hair, green eyes,
  casual hoodie, sitting cross-legged, looking at viewer, simple background, soft lighting, newest
  ```

- **Underscores in tags.** `brown_hair` is wrong; write `brown hair`. Only `score_7` keeps the underscore.
- **SDXL-level weights.** `(chibi:1.2)` barely moves Anima; use `(chibi:2)`.
- **Forgetting `@` on an artist.** `some artist` ~= no effect; `@some artist` applies the style.
- **Expanding wildcards.** `{standing|sitting}` is dynamic-prompt syntax that resolves at generation time. Rewriting it
  as `"standing or sitting"`, picking one branch, or deleting it are all wrong - pass the literal `{...|...}` token
  through unchanged.
- **Paraphrasing user-supplied tags.** When the user gives you a tag list, do not "improve" it - preserve their tags
  verbatim and only add spatial framing words. See
  [When the user supplies tags directly](#when-the-user-supplies-tags-directly).
- **Long text in the image.** Anima renders a single word or short phrase at best - do not promise a paragraph on a
  sign.
- **Dropping the `negative` arg.** Always pass one; it is the main lever for quality and safety.
