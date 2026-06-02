/**
 * USAGE text for the `/comfyui` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const COMFYUI_USAGE = [
  'Usage: /comfyui [workflows|jobs]',
  '',
  'Show ComfyUI status (no args), validate configured workflows (`workflows`),',
  'or list background generations (`jobs`).',
].join('\n');
