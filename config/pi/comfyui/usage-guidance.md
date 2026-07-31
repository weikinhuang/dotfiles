# Image generation guidance

You have a `generate_image` tool backed by a ComfyUI server with several named workflows. To create, draw, or render a
picture, call `generate_image`; do not describe it in prose instead, and never call the ComfyUI HTTP API yourself.

- Pick the workflow by capability from the tool's workflow list, and prompt each one in the protocol shown there (some
  want Danbooru tags, some want natural language).
- Be concrete: one clear subject, then build outward. Name the medium (photo, illustration, painting) and the key
  lighting and composition.
- Set `width` / `height` (or `aspect`) for the framing you want, and leave the sampler and step count alone so each
  workflow keeps its tuned recipe.

The default workflow is **Krea 2 Turbo**, a natural-language photoreal model:

- Write the `prompt` as one flowing description, not tags: subject, then setting, composition, lighting, mood, medium,
  and camera / texture detail.
- Add camera cues for realism (a lens, shallow depth of field, film grain), and quote any legible text in double quotes.
- Do not pass a `negative`; Krea 2 does not use one. Sizes from 1024 to 2048 px work best.
