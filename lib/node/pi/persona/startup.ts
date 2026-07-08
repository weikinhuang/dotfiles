/**
 * Pure startup-selection logic for the persona extension.
 *
 * Extracted from `config/pi/extensions/persona.ts`'s `session_start`
 * handler so the "which persona (if any) do we activate on launch?"
 * decision and the session-restore lookup are unit-testable without the
 * pi runtime. The shell keeps the actual activation (`applyPersona`) and
 * the flag/env plumbing; it passes the cleaned inputs here.
 */

/**
 * A `custom` session entry as read by the restore lookup. `data` is
 * `unknown` so pi's `CustomEntry<unknown>[]` assigns without a cast; the
 * name field is narrowed structurally inside the lookup.
 */
export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/**
 * Find the last-recorded persona name from the session's custom entries
 * (written by the extension on activate/clear). Returns the restored
 * name, `null` when it was explicitly cleared or never set. Mirrors the
 * reverse-scan the shell used inline.
 */
export function findRestoredPersonaName(entries: readonly SessionEntryLike[], customType: string): string | null {
  const restored = [...entries].reverse().find((e) => e.type === 'custom' && e.customType === customType);
  const data = restored?.data as { name?: string | null } | undefined;
  return data?.name ?? null;
}

export interface StartupSelectionInput {
  /** `--persona <name>` flag value (already emptied to undefined by the shell). */
  flagName?: string;
  /** Session-restored persona name; `null`/non-string is ignored. */
  restoredName?: string | null;
  /** `PI_PERSONA_DEFAULT` (already emptied to undefined by the shell). */
  envDefault?: string;
}

/**
 * Resolve the persona to auto-activate at session start.
 *
 * Precedence: `--persona` flag > session-restored name > env default.
 * A non-string (e.g. an explicit `null` clear) restored value is
 * skipped so a cleared session does not fall through to the env default
 * incorrectly - it simply drops to the env default like "no restore".
 */
export function selectStartupPersona(input: StartupSelectionInput): string | undefined {
  const restored = typeof input.restoredName === 'string' ? input.restoredName : undefined;
  return input.flagName ?? restored ?? input.envDefault;
}
