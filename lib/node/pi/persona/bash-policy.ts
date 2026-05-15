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
 * Resolution order (allow wins over deny on overlap, allow-list mode
 * still applies when allow is non-empty):
 *
 *   1. Empty allow + empty deny       → allow (mode has no opinion).
 *   2. `bashAllow` matches             → allow (carves out of any deny).
 *   3. `bashDeny` matches              → block.
 *   4. `bashAllow` non-empty, no match → block (allow-list mode).
 *   5. Otherwise                       → allow.
 *
 * The intuition: `bashAllow: ["rg *"], bashDeny: ["*"]` means "deny
 * everything, but carve out rg" — rg is allowed, everything else is
 * blocked by either the allow-list (rule 4) or the explicit deny
 * (rule 3, when allow is empty). Rule 4 specifically means a non-empty
 * `bashAllow` is still restrictive: a command with no allow match and
 * no deny match is still blocked, because declaring `bashAllow` at all
 * is a positive assertion of “ONLY these commands”.
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
  personaName: string;
}

/**
 * Resolve a per-mode bash decision. Order:
 *
 *   1. Empty allow + empty deny       → `allow` (mode has no opinion).
 *   2. `bashAllow` matches             → `allow` (carves out of any deny).
 *   3. `bashDeny` matches              → `block` with the deny-rule reason.
 *   4. `bashAllow` non-empty, no match → `block` with the allow-list reason.
 *   5. Otherwise                       → `allow`.
 *
 * Both lists may be present; allow wins on overlap so a persona can
 * write `bashAllow: ["rg *"], bashDeny: ["*"]` to mean “deny
 * everything except rg”.
 */
export function evaluateBashPolicy(opts: BashPolicyOptions): BashPolicyDecision {
  const { command, bashAllow, bashDeny, personaName } = opts;

  if (bashAllow.length > 0 && matchBashPattern(command, bashAllow)) {
    return { kind: 'allow' };
  }

  if (bashDeny.length > 0 && matchBashPattern(command, bashDeny)) {
    return {
      kind: 'block',
      reason: `persona "${personaName}" denies bash command (matched bashDeny)`,
    };
  }

  if (bashAllow.length > 0) {
    return {
      kind: 'block',
      reason: `persona "${personaName}" allows only: ${bashAllow.join(', ')}`,
    };
  }

  return { kind: 'allow' };
}
