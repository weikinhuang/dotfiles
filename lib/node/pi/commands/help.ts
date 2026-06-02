/**
 * Shared helper for the uniform slash-command `--help` convention.
 *
 * Every `pi.registerCommand` handler guards its top with
 * `if (isHelpArg(args)) { ctx.ui.notify(USAGE, 'info'); return; }` so a
 * user can discover any command's usage the same way -- `help`,
 * `--help`, `-h`, or `?`.
 *
 * Pure module -- no `@earendil-works/*` imports -- so it stays
 * unit-testable under vitest without the pi runtime.
 */

/**
 * Return true when `args` is one of the recognised help tokens
 * (case-insensitive, whitespace-trimmed): `help`, `--help`, `-h`, `?`.
 *
 * The check is exact: only the bare token counts. `/cmd help me` is a
 * real argument list, not a help request, so it falls through to the
 * command's own logic.
 */
export function isHelpArg(args: string | undefined): boolean {
  const a = (args ?? '').trim().toLowerCase();
  return a === 'help' || a === '--help' || a === '-h' || a === '?';
}
