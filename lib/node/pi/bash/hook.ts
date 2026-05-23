/**
 * Tiny pi-free helpers for the `pi.on('tool_call', …)` handlers that
 * gate the `bash` tool.
 *
 * Every bash-hook extension (`bash-permissions`, `persona`, `sandbox`,
 * `bash-exit-watchdog`, …) starts the same way:
 *
 *   if (event.toolName !== 'bash') return undefined;
 *   const rawCmd = (event.input as { command?: unknown } | undefined)?.command;
 *   const command = typeof rawCmd === 'string' ? rawCmd : '';
 *   if (!command.trim()) return undefined;
 *
 * Centralising the extraction keeps the type cast in one place (`event`
 * is loosely typed in pi's SDK and each extension repeated the same
 * `as { command?: unknown }` cast inline) and lets the four bash-hook
 * security gates share a single helper without each one re-inventing
 * the parse.
 *
 * `event` is typed structurally so this module stays out of
 * `@earendil-works/*` import territory; callers pass the full
 * `ToolCallEvent` and the helper narrows to `event.input.command`.
 */

/**
 * Read the `command` string out of a `tool_call` event payload.
 * Returns `undefined` when the input is missing, non-string, or empty
 * after trimming - the four conditions every bash-hook extension was
 * already short-circuiting on.
 *
 * Returns the **untrimmed** original on success: bash hooks need the
 * verbatim command for transcript / re-entry stash purposes, only the
 * non-empty check is what callers want trimming for.
 */
export function extractBashCommand(event: { toolName: string; input?: unknown }): string | undefined {
  if (event.toolName !== 'bash') return undefined;
  const raw = (event.input as { command?: unknown } | undefined)?.command;
  if (typeof raw !== 'string') return undefined;
  if (!raw.trim()) return undefined;
  return raw;
}
