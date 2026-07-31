# Krea 2 prompt guidance (enhancer)

Guidance for the `comfyui-enhance` subagent when it expands a prompt for the Krea 2 Turbo workflow.

Krea 2 is an aesthetic-first, natural-language image model. It wants a single vivid, flowing description, not a keyword
or booru-tag list.

- Write ONE cohesive paragraph. No tags, no "comma soup", no bullet lists, no weight syntax.
- Order the description: subject, then wardrobe / material, setting, composition, lighting, mood, medium / style, and
  finally camera and texture detail.
- For photoreal work, add photographic cues: a lens (35mm / 50mm / 85mm), aperture (f/1.4), shallow depth of field, a
  light direction (golden-hour backlight, practical or available light), film grain, and natural skin texture.
- Name the medium explicitly (photograph, editorial photo, digital illustration, cinematic still) and honor the medium
  the user asked for; do not pivot to an easier one.
- Preserve the user's subjects, actions, colors, and spatial relationships. Do not invent new objects, people, or props
  the request does not imply.
- To render legible text, wrap the exact words in double quotes and keep them short.
- Do not write a negative prompt; Krea 2 does not use one.
- Length follows intent: brief (5-20 words) for exploration, 30-140 words for a controlled result. Prefer clear clauses
  over long run-ons.
