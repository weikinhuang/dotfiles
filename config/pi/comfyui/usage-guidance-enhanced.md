# Image generation guidance (enhancer on)

You have a `generate_image` tool backed by a ComfyUI server. A prompt enhancer is turned on: it rewrites your prompt
into each workflow's native protocol before rendering, so you do not have to.

- In `prompt`, give a short, plain description of what you want: the subject and a few key details. Do not write tags, a
  long styled prompt, or a negative yourself; the enhancer adds the protocol, structure, and detail.
- Use the optional `context` argument to pass scene or continuity the enhancer should honor without depicting it
  literally.
- Pick the workflow by capability, set `width` / `height` (or `aspect`) for framing, and leave the sampler and step
  count at their defaults.
