---
name: minimax-h3-prompting
disable-model-invocation: true
description:
  Prompting rules for the open-weight **MiniMax H3** audio-video model on the comfyui `minimax-h3-fl2va-t2i` (still
  image), `minimax-h3-ref2va-edit` (reference still / edit), and `minimax-h3-ref2va-spectrum` (reference video with
  native audio) workflows. Use when the user asks to generate an image, edit an image, or make a video on a MiniMax H3
  workflow. H3 reads structured English (official field layout, `<Picture N>` labels, `(S1)` speaker IDs, `<d>` dialogue
  tags); there is no negative prompt, so write exclusions as positive descriptions.
---

# MiniMax H3 Prompting

[MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) is MiniMax's open-weight omni-modal generator: a 33B
single-stream transformer with a Qwen3-VL-32B text encoder that jointly generates video and 32 kHz stereo audio at 24
fps. It ships as two checkpoints with different prompt dialects:

- **FL2VA** (first/last frame): text-to-video plus optional first and/or last frame. In this setup it drives the
  `minimax-h3-fl2va-t2i` **still image** workflow.
- **Ref2VA** (omni-reference): up to 9 images, 3 videos, and 3 audio clips addressed by label. It drives both the
  `minimax-h3-ref2va-edit` still workflow and the `minimax-h3-ref2va-spectrum` **video** workflow.

Three rules matter most:

- **English descriptions, not tags.** Describe what is visible (and, for video, audible) in playback order. Keep
  dialogue, lyrics, and on-screen text verbatim in their original language.
- **Name every reference by its label.** `<Picture 1>`, `<Video 1>`, `<Audio 1>` are 1-based and follow the order of
  `inputImages`, `inputVideos`, `inputAudios`. Say what each reference contributes (identity, first frame, voice).
- **No negative prompt; say what you want instead.** The graphs run CFG 1 through `BasicGuider`. Writing
  `no text, no signs` adds text: in testing it produced _more_ lettering than describing plain, unmarked surfaces.

**Safe default when unsure:** pick the workflow by job (still, edit, video), copy the matching
[template](#fill-in-templates) below, fill the brackets, and pass only `prompt`, `workflow`, the media inputs, and size
/ duration. Leave `steps` and `seed` alone. Then call the `generate_image` tool yourself: when the user asked for media,
printing the call as JSON for them does not render anything.

## The `generate_image` call

| Arg                | For MiniMax H3                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `prompt`           | Required. English prose or the official field layout (see below). No tags.                                    |
| `workflow`         | `minimax-h3-fl2va-t2i`, `minimax-h3-ref2va-edit`, or `minimax-h3-ref2va-spectrum`.                            |
| `width` / `height` | Multiples of 32. Native canvas is a 768 px short edge (`768x768`, `1344x768`, `768x1344`, `1024x768`).        |
| `inputImages`      | Edit: 1-9 (required). Video: 0-9. Becomes `<Picture 1>` ... in order. Not accepted by `fl2va-t2i`.            |
| `inputVideos`      | Video workflow only, 0-3 clips of 2-15 s; each clip's soundtrack is paired automatically.                     |
| `inputAudios`      | Video workflow only, 0-3 standalone clips of 2-15 s. Max 12 media files in total.                             |
| `duration`         | Video only, seconds, snapped _up_ to the 24 fps `17k+5` grid: `0.9` -> 22 frames, `1` -> 39, `5` -> 124.      |
| `background`       | Off for stills and <=1 s clips. `true` for longer videos: foreground calls abort after 180 s (`timeoutMs`).   |
| `refImageSize`     | `match` (default, fast) or `max` (2048 px refs, stronger identity, several times slower).                     |
| `seed`             | Omit for a fresh result; reuse a seed to A/B a prompt change.                                                 |
| `steps`            | Leave at the baked 20. Raise to ~25 only when a reference drifts or fine detail swims; never pass `negative`. |

### Which workflow

| Workflow                     | Checkpoint | Output             | Use it for                                                                         |
| ---------------------------- | ---------- | ------------------ | ---------------------------------------------------------------------------------- |
| `minimax-h3-fl2va-t2i`       | FL2VA      | 1 still image      | Text-to-image. Photoreal, illustration, anime; short quoted signs render well.     |
| `minimax-h3-ref2va-edit`     | Ref2VA     | 1 still image      | Edit a picture, or put a referenced character / object into a new scene.           |
| `minimax-h3-ref2va-spectrum` | Ref2VA     | MP4 + stereo + PNG | Video with native audio, from text alone or from image / video / audio references. |

Stills take about 35-40 s at 768x768. Video cost scales with frames x pixels plus reference tokens: a 3-4.5 s clip at
608x352 renders in about 2 minutes on an idle server, close to the 180 s foreground cap, and any queued job ahead of it
pushes it over. Smoke-test at `512x512` and `duration: 0.9` before a real 4-15 s render (the model's trained range).
Submit anything longer with `background: true`, then `image_jobs` `collect`; do not retry a timed-out video in the
foreground, since each attempt is cancelled at the same cap. Ref2VA is reference-guided regeneration, not mask
inpainting: unmentioned details can drift, so list what to preserve.

## Base dialect (FL2VA: T2VA / I2VA / FL2VA / L2VA)

The official layout is three fields, in this order, separated by blank lines:

```text
integrated_multimodal_description: [Shot 1] <style>, <shot size / composition>, <subject>, <setting>, <action>, <camera>.

overall_soundscape: <1-4 sentences of ambience and physical sounds, or N/A for total silence>

non_diegetic_music: <1-3 sentences of score: instruments, tempo, dynamics; or N/A>
```

- Open `[Shot 1]` with the style (`Live-action, cinematic`, `2D-animated`, `3D CG`, `claymation`, `watercolor`,
  `vintage film`) and the opening composition.
- Keyframe modes prepend one fixed alignment line plus a blank line. These are for an FL2VA _video_ graph with
  `first_frame` / `last_frame` inputs, which this setup does not ship; on the Ref2VA video workflow use
  [keyframe completion](#ref2va-dialect-full-reference) instead. The official lines are:

```text
I2VA:  For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
FL2VA: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
```

For FL2VA describe the _path_ between the frames (first state, intermediate motion, last state), usually as one shot.

**For the still workflow** (`fl2va-t2i`), plain prose and the three-field layout gave near-identical results on the same
seed, and field names never rendered as text. Use whichever is easier; prose is shorter. Treat it as a single frame:
describe one moment, not motion over time.

## Ref2VA dialect (full reference)

Six sections, in this order. Labels keep one meaning across every section:

```text
subject_definitions:
<Subject 1> is the [person / object / place] in <Picture 1>, with [key visible features].

summary:
[task type] One short paragraph: what the target shows and what each reference contributes.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - [what is kept].

detailed_description:
The target video is in a [style] style with [lighting / palette].
[Shot 1] [composition, subjects with labels, setting, action, camera, sound events, dialogue]

overall_soundscape: [ambience and physical sounds]

non_diegetic_music: [score, or N/A]
```

- **`<Subject N>`** is reusable content (a person, pet, product, place, outfit, style). One subject can come from
  several assets:
  `<Subject 1> is the woman whose appearance comes from <Picture 1> and whose walk comes from <Video 1>.`
- **`<Picture N>` on its own line** only when the image is a concrete frame:
  `<Picture 1> is the first frame of [Shot 1]`, a keyframe, a last frame, or a labelled character / storyboard sheet.
- **Task types** for `summary`, joined with `+`: `reference generation` (identity / style / scene guidance),
  `keyframe completion` (an image is an actual frame), `video editing`, `video continuation`, `audio reuse`,
  `audio reference`.
- **Retention markers:** visuals use `fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference`;
  audio uses `fully_copy`, `partially_copy`, `reference`, `weak_reference`.
- **Length:** for real videos MiniMax recommends 350-500 words of `detailed_description`. For stills and 1 s smoke
  tests, 60-150 words is enough.

**For the still edit workflow** (`ref2va-edit`) a short instruction is enough for a local change and was validated:

```text
Edit <Picture 1>. Change only [the thing] to [new state]. Preserve [person / face / pose / props / background /
lighting / camera angle / framing]. A realistic single still photograph.
```

Use the six-section layout when the reference must be re-staged (same character, new scene): that was validated too,
keeping face, beard, cap, and jacket while moving the subject indoors.

## Shared writing rules

**Shots and timing (video).** `[Shot 1]` has no timestamp. Later shots start with a strictly increasing cut time inside
the duration: `[Shot 2] At 00:03.500, the camera cuts to ...`. One shot per ~3-5 s at most; a sub-2 s clip is one shot.

**Camera.** Write movement as a natural clause: type + optional amplitude + optional speed.

- **Types:** push in / pull out, zoom in / out, pan left / right, truck left / right, tilt up / down, pedestal up /
  down, arc shot, tracking shot, static shot, shake slightly / strongly, POV, roll clockwise / counterclockwise.
- **Modifiers (optional):** `with small amplitude`, `with large amplitude`, `at slow speed`, `at fast speed`.

Example: `The camera pushes in with small amplitude at slow speed toward the letter in her hands.`

**Dialogue.** Give each voice a stable ID at first speech, with a short voice description outside the tag; only the
language tag and the exact words go inside `<d>`:

```text
The elderly fisherman with a low, gravelly voice (S1) says: <d>[English] Morning.</d>
The two children (S1,S2) shout together, <d>[English] Wait for us!</d>
The man (S1) says in an off-screen voiceover: <d>[English] I still remember that road.</d> while his lips remain completely closed.
```

With a voice reference, bind it in `subject_definitions`
(`<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`), mark it `<Audio 1>: reference - ...` in
`retention_analysis`, and write `<Subject 1> (S1) says ...` in the shot. The workflow needs at least one image or video
alongside any audio. Measured behaviour (pitch and waveform checks on 3 s clips):

- **New words carry the timbre.** A woman's voice clip moved another woman's pitch from 180 Hz to 254 Hz (clip: 242 Hz)
  without copying the waveform.
- **The reference's own words copy the clip.** Asking for the same sentence the clip already says reproduced the clip
  almost sample for sample (correlation 0.98), even when marked `reference`. That is the way to reuse a line; mark it
  `fully_copy` or `partially_copy`.
- **An implausible voice is ignored.** The same young woman's clip on an elderly bearded man left him with a male voice.
  Pick references that fit the on-screen speaker.

Keep lines short enough to fit the duration.

**On-screen text.** Put visible text in double quotes, verbatim and in its original language, and say where it is:
`a hand-painted wooden sign nailed to the post reads "BAIT"`. Short words render well; spoken words go in `<d>`, never
in quotes.

**Sound fields.** `overall_soundscape` is ambience plus physical sounds (rain, footsteps, fabric, impacts), never
dialogue. `non_diegetic_music` is score only the audience hears: name instruments, tempo, and dynamics, not moods. Use
`N/A` deliberately; leaving the fields out can bring back unrequested speech or music.

**Exclusions.** State the wanted positive state: `the walls are bare white plaster`, `the road is empty`. Do not even
name a text-bearing object you want blank: `the overhead sign is completely blank` still came back lettered, while
`the fascia above the window is a plain unpainted wooden board` came back clean. Keep the subject recognisable through
objects instead of words (loaves on shelves behind the glass, not a bakery sign). In Ref2VA, scope what to keep through
`retention_analysis` instead of listing what to avoid.

## Expanding a terse user request

Do not pass `a fox in the snow` straight through. Expand it:

1. **Pick the workflow** by job: still, edit, or video.
2. **Anchor the subject** with concrete, visible details (age, clothing, colours, materials).
3. **Place and frame it:** setting, shot size, camera angle; for video, one camera move.
4. **Light and style it:** name the medium first (`Live-action, cinematic`, `2D-animated`).
5. **Video only:** add the action beats in order, any dialogue in `<d>`, then both sound fields.
6. **References:** if you can view images, look at each one first. Label each input, spell out the concrete features to
   keep (`white beard, grey flat cap, yellow hooded raincoat`, not `his seafaring attire`), and say what it contributes.

If the user already wrote an H3-format prompt, keep it and fix only label, field-order, or timing errors. Never alter
quoted text or `<d>` lines.

## Fill-in templates

Copy one, replace every `[...]`, and delete nothing else. These match the validated renders.

Still image (`minimax-h3-fl2va-t2i`, no inputs):

```text
[Style: Live-action, cinematic / 2D-animated / watercolor], a [shot size] of [subject with clothing, colours,
materials], [action or pose] in [setting]. [Light direction and quality, time of day]. [Background details]. [Optional:
A sign / label reads "[EXACT TEXT]".] [Camera / texture cues: eye-level, shallow depth of field, natural skin texture].
```

Edit (`minimax-h3-ref2va-edit`, `inputImages: [source]`):

```text
Edit <Picture 1>. Change only [target] to [new state]. Preserve [everything else, listed]. A realistic single still
photograph.
```

Character in a new scene (`minimax-h3-ref2va-edit`, `inputImages: [character]`):

```text
subject_definitions:
<Subject 1> is the [person] in <Picture 1>, with [features read off the image: hair, beard, glasses, each garment and colour].

summary:
[reference generation] A new still image shows <Subject 1> [new action] in [new setting].

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - [face, hair, clothing] are retained.

detailed_description:
The target image is a [style] photograph.
[Shot 1] A [shot size] frames <Subject 1> [action] in [setting]. [Lighting]. [Background]. [Expression].

overall_soundscape: [one ambient sound]

non_diegetic_music: N/A
```

Animate a picture (`minimax-h3-ref2va-spectrum`, `inputImages: [first frame]`, `duration`):

```text
subject_definitions:
<Picture 1> is the first frame of [Shot 1], showing [what the image shows].

summary:
[keyframe completion] The target video begins from <Picture 1> and [what happens].

retention_analysis:
<Picture 1> ([Shot 1] first frame): fully_preserved - [subjects, clothing, setting, lighting] are retained.

detailed_description:
The target video is a [style] shot with [lighting].
[Shot 1] The shot begins from <Picture 1>. The camera [move or holds a static shot] as [action beats in order]. [The
[voice description] (S1) says: <d>[Language] [exact line]</d>]

overall_soundscape: [ambience and action sounds]

non_diegetic_music: [instruments, tempo, dynamics, or N/A]
```

Text-only video (`minimax-h3-ref2va-spectrum`, no inputs, `background: true` past ~1 s). Validated at 4.4 s: the cut
landed exactly on its timestamp. With no references, write `N/A` in the two reference sections and put speaker IDs only
in `detailed_description`:

```text
subject_definitions:
N/A

summary:
[reference generation] [One sentence: who, where, what happens across the shots.]

retention_analysis:
N/A

detailed_description:
The target video is in a [style] style with [lighting / palette].
[Shot 1] A [shot size] frames [character with age, hair, clothing] in [setting]. The camera [move]. [Action]. The
[character] with a [pitch, timbre, pace] voice (S1) says: <d>[Language] [exact line]</d>
[Shot 2] At 00:0[S].[mmm], the camera cuts to [new framing] as [action].

overall_soundscape: [ambience and action sounds]

non_diegetic_music: [instruments, tempo, dynamics, or N/A]
```

## Anti-patterns

- **Negated lists.** `no text, no watermark, no people` names the unwanted things and invites them. Describe the clean
  positive state, and call would-be signs, posters, or labels plain boards, panels, or fabric.
- **Booru tags or quality spam.** `1girl, masterpiece, 8k` is not H3's dialect. Write sentences.
- **Labels without files.** `<Picture 1>` in the prompt does nothing unless the file is in `inputImages`; every
  `ref2va-edit` call needs at least one.
- **Unlabelled or misnumbered references.** Labels are 1-based per media type in input order. A third image is
  `<Picture 3>`, even if it is the only character.
- **Images on `fl2va-t2i`.** It takes no `inputImages`; use `ref2va-edit` for anything with a reference.
- **Edits without a preserve list.** Ref2VA regenerates the frame; say what must stay the same.
- **Timing that does not fit.** Cut times past the duration, or a paragraph of dialogue in a 2 s clip.
- **Dialogue in quotes or on-screen text in `<d>`.** Quotes are printed text; `<d>` is speech.
- **Overriding `steps` downward or passing `negative` / `cfg`.** The graphs are tuned at 20 steps, CFG 1, with no
  negative branch.
