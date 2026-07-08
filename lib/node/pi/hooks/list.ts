/**
 * Pure formatter for the `/hooks` command output.
 *
 * Renders the merged hook config grouped by source (session / project
 * / user) and event, mirroring `/bash-permissions`'s listing. Pure so
 * the extension shell only computes the source paths and hands the
 * merged map in.
 */

import type { Hook, HookEvent, HookScope } from './config.ts';

export interface HookListSource {
  /** Layer this block lists. */
  scope: HookScope;
  /** Human-readable location (`(in-memory)`, a config path). */
  where: string;
}

/**
 * Build the `/hooks` listing text from the merged per-event map and the
 * ordered source blocks. `events` fixes the display order of events
 * within each source block. Returns a single newline-joined string.
 */
export function formatHooksList(
  merged: Record<HookEvent, Hook[]>,
  sources: readonly HookListSource[],
  events: readonly HookEvent[],
): string {
  const lines: string[] = [];
  for (const src of sources) {
    lines.push(`[${src.scope}] ${src.where}`);
    let any = false;
    for (const event of events) {
      const inScope = merged[event].filter((h) => h.scope === src.scope);
      if (inScope.length === 0) continue;
      any = true;
      lines.push(`  ${event}:`);
      for (const h of inScope) {
        const match = h.matcher ? ` matcher=${JSON.stringify(h.matcher)}` : '';
        const timeout = h.timeout ? ` timeout=${h.timeout}ms` : '';
        const sandboxed = h.sandboxed ? ' sandboxed' : '';
        lines.push(`    ${h.command}${match}${timeout}${sandboxed}`);
      }
    }
    if (!any) lines.push('  (empty)');
  }
  return lines.join('\n');
}
