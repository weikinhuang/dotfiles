/**
 * USAGE text for the `/comfyui` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const COMFYUI_USAGE = [
  'Usage: /comfyui [workflows|jobs|gallery [id]|refine <gX>|models]',
  '',
  'Show ComfyUI status (no args), validate configured workflows (`workflows`),',
  'list background generations (`jobs`), list recorded generations (`gallery`)',
  "or show one generation's full prompt + negative (`gallery <id>`),",
  'auto-refine a recorded generation through the vision critic loop (`refine <gX>`),',
  "or list the server's installed models (`models`).",
].join('\n');
