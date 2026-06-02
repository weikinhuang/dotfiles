/**
 * USAGE text for the `/waveform` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const WAVEFORM_USAGE = [
  'Usage: /waveform [scroll|spectrum|tokenrate|off|reset]',
  '',
  'Show the current indicator (no args) or set the streaming working indicator.',
  '`reset` restores the pi default.',
].join('\n');
