/**
 * USAGE text for the `/context` command. Pure string module so the
 * extension shell and the `--help` path share one source of truth.
 */
export const CONTEXT_USAGE_USAGE = [
  'Usage: /context',
  '',
  'Open an interactive, drill-down breakdown of context-window usage:',
  'system prompt (decomposed), tool schemas, and the conversation',
  '(by role and by tool), plus free space.',
  '',
  'Keys: ↑/↓ select · ⏎ drill in · ← / esc back · c compact · r refresh',
  '      · t reconciliation panel · e export report · q close',
  '',
  'In non-interactive (print / RPC) modes the same breakdown is printed',
  'as a flat markdown report instead of the overlay.',
].join('\n');
