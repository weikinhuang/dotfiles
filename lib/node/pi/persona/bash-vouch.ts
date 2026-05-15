/**
 * Cross-extension vouch helper: decide whether the active persona's
 * `bashAllow` (and absence of a matching `bashDeny`) is enough to let
 * a bash sub-command past the `bash-permissions` gate without prompting
 * or denying for "unknown command".
 *
 * Mirrors the existing writeRoots vouch in `protected-paths.ts`: a
 * persona that ships e.g. `bashAllow: ['ai-fetch-web *']` means the
 * user-author of the persona file has already endorsed that command
 * for this persona's runs. With this helper, that endorsement extends
 * to bash-permissions itself, so the persona Just Works in `pi -p` /
 * non-UI mode without forcing the user to also widen their persistent
 * `~/.pi/bash-permissions.json` allowlist.
 *
 * Pattern semantics match `evaluateBashPolicy` in `bash-policy.ts`
 * (the matcher persona.ts uses for its own `tool_call` enforcement) so
 * a vouched command is exactly one that the persona's own bashAllow
 * would have allowed had bash-permissions waved it through. Concretely:
 *
 *   - Empty `bashAllow` → no vouch (persona has no opinion).
 *   - `bashAllow` matches → vouch (persona's `bashAllow` wins over its
 *     own `bashDeny` on overlap, mirroring `evaluateBashPolicy`).
 *   - `bashAllow` non-empty but no match → no vouch.
 *
 * The vouch is *session-scoped only* — it does NOT mutate any
 * `bash-permissions.json` file on disk. When the persona is cleared
 * (or another persona activates), the vouch goes away.
 */

import { matchBashPattern } from './bash-policy.ts';
import  { type ActivePersonaSnapshot } from './active.ts';

export interface PersonaVouchOptions {
  command: string;
  active: ActivePersonaSnapshot | undefined;
}

export interface PersonaVouchResult {
  /** True when the active persona's bashAllow vouches for `command`. */
  vouched: boolean;
  /** Persona name (for diagnostic strings); undefined when no vouch. */
  personaName?: string;
  /** Matched allow pattern (for diagnostic strings); undefined when no vouch. */
  matchedPattern?: string;
}

/**
 * Pattern-match `command` against the active persona's bashAllow /
 * bashDeny. Returns a vouch result the bash-permissions gate can use
 * to skip the unknown-command prompt / deny.
 */
export function personaVouchBash(opts: PersonaVouchOptions): PersonaVouchResult {
  const { command, active } = opts;
  if (!active) return { vouched: false };
  if (active.bashAllow.length === 0) return { vouched: false };

  // Find the specific allow pattern that matched so we can surface it
  // in diagnostic strings (helpful for `--mode json` traces and the
  // optional notify-on-vouch path). Persona's own `bashDeny` is
  // intentionally NOT consulted here — `evaluateBashPolicy` lets
  // `bashAllow` win on overlap, so the vouch must too.
  for (const pat of active.bashAllow) {
    if (matchBashPattern(command, [pat])) {
      return { vouched: true, personaName: active.name, matchedPattern: pat };
    }
  }
  return { vouched: false };
}
