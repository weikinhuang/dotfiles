/**
 * Pure argument-completion spec for the `/schedules` command, importable
 * by both the extension shell (for `getArgumentCompletions`) and its
 * command-surface spec (so the completion can be asserted without the pi
 * runtime). Built over the shared `completeSubverbs` helper.
 *
 * `/schedules` is a subverb command: `cancel <id>`, `clear [scope|all]`,
 * `on <id>`, `off <id>`. The id-taking verbs complete against the live
 * schedule list (label = id, description = its trigger); `clear`
 * completes the fixed scope set plus `all`.
 *
 * No pi imports.
 */

import { type ArgCandidate, type SubverbSpec } from '../commands/complete.ts';
import { describeTrigger, type Schedule, SCHEDULE_SCOPES } from './schedule.ts';

/** The `/schedules` subverbs, in menu order. */
export const SCHEDULES_SUBVERBS = ['cancel', 'clear', 'on', 'off'] as const;

/**
 * Build the {@link SubverbSpec} for `/schedules` completion from the live
 * merged schedule list. The `cancel` / `on` / `off` verbs complete
 * against the schedule ids; `clear` completes the scope set plus `all`.
 */
export function buildSchedulesCompletionSpec(schedules: readonly Schedule[]): SubverbSpec {
  const idArgs = (): ArgCandidate[] => schedules.map((s) => ({ label: s.id, description: describeTrigger(s.trigger) }));
  return {
    cancel: { description: 'Remove one schedule', args: idArgs },
    clear: { description: 'Remove a whole scope', args: [...SCHEDULE_SCOPES, 'all'] },
    on: { description: 'Enable a schedule', args: idArgs },
    off: { description: 'Disable a schedule', args: idArgs },
  };
}
