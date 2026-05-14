/**
 * Per-mode bash policy: layers a `bashAllow` / `bashDeny` decision on
 * top of whatever `config/pi/extensions/bash-permissions.ts` already
 * resolved for the call. Pure module — no pi imports — so the matcher
 * + decision tree are unit-tested directly under vitest.
 *
 * Pattern semantics (kept deliberately small; richer glob support is
 * a v2 follow-up if a shipped mode legitimately needs it):
 *
 *   - `"*"`            — wildcard, matches any command.
 *   - `"foo"`          — exact head-token match (`cmd.trim().split(/\s+/)[0]` === `"foo"`).
 *   - `"foo *"`        — head-token equals everything before the first `*`, trimmed.
 *
 * Modes only **tighten**: `bash-permissions.ts` runs first; if it
 * already denied the call, this helper never sees it. When a mode
 * declares both lists, deny wins on overlap (deny is checked first).
 */

const HEAD_TOKEN_RE = /\s+/;

/**
 * Match a bash command against one allow/deny pattern list. Exposed
 * for tests; callers should generally drive `evaluateBashPolicy`
 * instead.
 */
export function matchBashPattern(command: string, patterns: readonly string[]): boolean {
  const head = command.trim().split(HEAD_TOKEN_RE)[0] ?? '';
  for (const pat of patterns) {
    if (pat === '*') return true;
    const star = pat.indexOf('*');
    if (star === -1) {
      if (head === pat) return true;
    } else {
      const prefix = pat.slice(0, star).replace(/\s+$/, '');
      if (prefix === '' || head === prefix) return true;
    }
  }
  return false;
}

export type BashPolicyDecision = { kind: 'allow' } | { kind: 'block'; reason: string };

export interface BashPolicyOptions {
  command: string;
  bashAllow: readonly string[];
  bashDeny: readonly string[];
  /** Used to compose human-readable reason strings. */
  modeName: string;
}

/**
 * Resolve a per-mode bash decision. Order:
 *
 *   1. Empty deny + empty allow → `allow` (mode has no opinion).
 *   2. `bashDeny` matches → `block` with the deny-rule reason.
 *   3. `bashAllow` is non-empty AND no entry matches → `block` with
 *      the allow-list reason.
 *   4. Otherwise → `allow`.
 *
 * Both lists may be present; rule 2 wins on overlap.
 */
export function evaluateBashPolicy(opts: BashPolicyOptions): BashPolicyDecision {
  const { command, bashAllow, bashDeny, modeName } = opts;

  if (bashDeny.length > 0 && matchBashPattern(command, bashDeny)) {
    return {
      kind: 'block',
      reason: `mode "${modeName}" denies bash command (matched bashDeny)`,
    };
  }

  if (bashAllow.length > 0 && !matchBashPattern(command, bashAllow)) {
    return {
      kind: 'block',
      reason: `mode "${modeName}" allows only: ${bashAllow.join(', ')}`,
    };
  }

  return { kind: 'allow' };
}
