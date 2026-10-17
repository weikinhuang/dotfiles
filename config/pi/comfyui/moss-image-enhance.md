# MOSS-Image prompt guidance (enhancer)

Guidance for the `comfyui-enhance` subagent when it expands a prompt for the MOSS-Image workflows (`moss-image`,
`moss-image-fast`, `moss-image-reference`, and the `moss-image-base*` variants).

MOSS-Image is a 5B DiT with a Qwen3.5-9B text encoder (up to 4K prompt tokens), trained on long, detailed English
recaptions. Its strengths are accurate in-image text, layout, and long prompts, in both photoreal and illustrated
styles. It uses real classifier-free guidance, so the negative prompt matters.

- Write detailed English prose: subjects and actions first, then setting, composition and framing, colors, lighting,
  medium and art style. A long paragraph (60-250 words) is better than a short one; long prompts do not hurt.
- Describe only what is visible. Do not invent new people, objects, or props the request does not imply, and never
  describe watermarks, signatures, or UI chrome.
- Name the medium explicitly (photograph, film still, flat vector poster, watercolor, anime illustration) and keep the
  one the user asked for. For photoreal work add camera cues: lens, aperture, depth of field, light direction, film
  grain, natural skin texture.
- Text in the image is a core feature. Put the exact words in double quotes, preserve their original language and
  spelling (do not translate or paraphrase), and use real line breaks inside the quotes where the lines should wrap.
  Describe the typography: position, alignment, size hierarchy, font style, color, and the surface the text is on.
- Keep each text block short and readable. Spell out what goes on each line rather than leaving wrapping to the model.
- Tag sequences also work, mainly for anime styles. Order them: quality, score, meta, year, character, series, artist,
  general tags (for example `best quality, highres, hatsune miku, vocaloid, @artist name, 1girl, blue hair`). Prefer
  prose unless the user wrote tags.
- If the prompt is a JSON layout (`summary` / `items` / `bbox`, `bbox_coord_space: abs_centralized`,
  `bbox_format: yxyx`), return it unchanged apart from enriching the `caption` strings. Do not move boxes or rewrite
  quoted `text`; coordinates are tied to the render's width and height.
- Negative prompt: short comma-separated tags. Start from `worst quality, bad anatomy, watermark, jpeg artifact` and add
  only exclusions specific to the request (for example `blurry text, misspelled text` for text-heavy images). Keep any
  rating tokens where they arrived; do not add new ones.
