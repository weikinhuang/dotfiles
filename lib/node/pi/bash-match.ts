/**
 * Bash permission rule engine - the policy layer that sits on top of
 * `./bash-parse.ts`. Pi-runtime-free; testable under vitest.
 *
 * Responsibilities:
 *   - Load + match `RuleFile` allow/deny patterns against a single
 *     sub-command (exact / `prefix*` / regex grammar).
 *   - Hardcoded denylist of unambiguous footguns that no user rule can
 *     override.
 *   - Always-prompt list (sudo / doas / …) that auto mode can't
 *     bypass.
 *   - `decideSubcommand` - the precedence ladder that turns a single
 *     sub-command + a stack of rule layers into an allow / block /
 *     prompt verdict.
 *
 * The shell-string parsing primitives (`splitCompound`,
 * `maskQuotedRegions`, `stripControlFlowKeyword`,
 * `extractCommandSubstitutions`, `allSubcommands`, `commandTokens`,
 * `twoTokenPattern`) live in `./bash-parse.ts`. This module re-exports
 * them at the bottom so existing call sites importing from
 * `bash-match` keep working unchanged.
 */

import {
  allSubcommands,
  commandTokens,
  extractCommandSubstitutions,
  maskQuotedRegions,
  splitCompound,
  stripControlFlowKeyword,
  twoTokenPattern,
} from './bash-parse.ts';

// ──────────────────────────────────────────────────────────────────────
// Rule types
// ──────────────────────────────────────────────────────────────────────

export type Scope = 'project' | 'user' | 'session';

export interface RuleFile {
  allow?: string[];
  deny?: string[];
}

export interface LoadedRules {
  allow: string[];
  deny: string[];
}

export interface MatchResult {
  kind: 'allow' | 'deny';
  pattern: string;
  scope: Scope;
}

// ──────────────────────────────────────────────────────────────────────
// matchesPattern - exact / prefix* / regex
// ──────────────────────────────────────────────────────────────────────

/**
 * Warn once per unique bad regex pattern so typos in the JSON config
 * are discoverable without spamming the log on every tool call.
 */
const warnedBadPatterns = new Set<string>();

/**
 * Try to parse `pattern` as a regex rule. Returns a compiled RegExp on
 * success, null if `pattern` doesn't use regex syntax, or `false` if
 * it looks like regex syntax but the body doesn't compile (the caller
 * then treats it as "never matches" rather than silently falling back
 * to an exact-string match that would surprise the user).
 */
export function tryCompileRegexRule(pattern: string): RegExp | null | false {
  // `re:<source>` - explicit, unambiguous, no flags.
  if (pattern.startsWith('re:')) {
    try {
      return new RegExp(pattern.slice(3));
    } catch (e) {
      if (!warnedBadPatterns.has(pattern)) {
        warnedBadPatterns.add(pattern);
        console.warn(`[bash-permissions] invalid regex rule ${JSON.stringify(pattern)}: ${String(e)}`);
      }
      return false;
    }
  }

  // `/source/flags` - only when the trailing portion after the LAST
  // `/` consists solely of JS regex flag chars. This keeps
  // absolute-path commands like "/usr/bin/true" as plain exact
  // strings.
  if (pattern.length >= 2 && pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    if (lastSlash > 0) {
      const flags = pattern.slice(lastSlash + 1);
      if (/^[gimsuy]*$/.test(flags)) {
        try {
          return new RegExp(pattern.slice(1, lastSlash), flags);
        } catch (e) {
          if (!warnedBadPatterns.has(pattern)) {
            warnedBadPatterns.add(pattern);
            console.warn(`[bash-permissions] invalid regex rule ${JSON.stringify(pattern)}: ${String(e)}`);
          }
          return false;
        }
      }
    }
  }

  return null;
}

export function matchesPattern(command: string, pattern: string): boolean {
  const regex = tryCompileRegexRule(pattern);
  if (regex === false) return false; // bad regex - never match
  if (regex) return regex.test(command);

  if (pattern.endsWith('*')) {
    // Token-aware prefix match: `git log*` matches `git log` and `git
    // log -1` but NOT `git logfoo`. Matches Claude Code's `Bash(git
    // log:*)` semantics.
    const prefix = pattern.slice(0, -1).trimEnd();
    if (command === prefix) return true;
    if (command.length <= prefix.length) return false;
    if (!command.startsWith(prefix)) return false;
    const next = command.charAt(prefix.length);
    return next === ' ' || next === '\t';
  }
  return command === pattern;
}

export function matchOne(command: string, layers: { scope: Scope; rules: LoadedRules }[]): MatchResult | null {
  // Deny wins across every layer.
  for (const layer of layers) {
    for (const pattern of layer.rules.deny) {
      if (matchesPattern(command, pattern)) {
        return { kind: 'deny', pattern, scope: layer.scope };
      }
    }
  }
  for (const layer of layers) {
    for (const pattern of layer.rules.allow) {
      if (matchesPattern(command, pattern)) {
        return { kind: 'allow', pattern, scope: layer.scope };
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Hardcoded denylist - unambiguous footguns that should never auto-run
// ──────────────────────────────────────────────────────────────────────

/**
 * These patterns block even if the user has a broad allow rule above
 * them. Kept short and precise to minimize false positives. Disable
 * with PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1 if you really know what
 * you're doing.
 */
export const HARDCODED_DENY: { pattern: RegExp; reason: string }[] = [
  // rm -r (any flag order/combo containing r/R, or --recursive)
  // targeting a catastrophic or traversal-style location: `/`, `/*`,
  // `~`, `~/`, `$HOME`, `.`, `./`, `./*`, `.*` (globs to `.` + `..`),
  // any `..`-prefixed path (`..`, `../`, `../foo`, `../../bar`, …), or
  // a bare `*`-glob (`*`, `**`, `*/`, `**/`) as the ONLY remaining
  // argument. A leading `..` always traverses outside cwd so we block
  // the whole family. Bare-`*` is blocked only when it IS the target -
  // `rm -rf *.log` / `rm -rf build/*` / `rm -rf *foo*` stay allowed
  // because they pin a narrower set. A trailing `# comment` is
  // tolerated so `rm -rf / # haha` doesn't slip past the tail anchor -
  // bash would execute the `rm` and then ignore the comment.
  //
  // Known limitations: multi-target forms (`rm -rf * .*`, `rm -rf /
  // foo`) aren't caught; each individual target would have to be the
  // lone arg for the regex to fire.
  {
    pattern:
      /^\s*rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s+-[^\s]+)*\s+(?:\/|\/\*|~|~\/|\$HOME\/?|\.\/\*|\.\/|\.\*|\.|\.\.(?:\/.*)?|\*+\/?)(?:\s+#.*)?\s*$/,
    reason: 'rm -r targeting /, ~, $HOME, ., a ..-traversal path, or bare `*`',
  },
  // Classic fork bomb: :(){ :|:& };:
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
    reason: 'fork bomb',
  },
  // dd writing to a raw block device.
  {
    pattern: /\bdd\b[^|;]*\bof\s*=\s*\/dev\/(?:sd|nvme|hd|disk|mmcblk|vd)/,
    reason: 'dd to raw disk device',
  },
  // mkfs / mkfs.ext4 / mkfs.xfs / …
  {
    pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/,
    reason: 'mkfs (filesystem format)',
  },
  // Pipe a network download straight into a shell (classic curl | sh).
  {
    pattern: /\b(?:curl|wget|fetch)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z|k|a)?sh(?=\s|$|[;|&<>])/,
    reason: 'pipe network download to shell',
  },
  // Redirect to a raw block device (>/dev/sda, etc.).
  {
    pattern: /(?:^|[\s;|&])>\s*\/dev\/(?:sd|nvme|hd|disk|mmcblk|vd)[a-z0-9]*\b/,
    reason: 'redirect to raw disk device',
  },
];

export function checkHardcodedDeny(command: string): string | null {
  if (process.env.PI_BASH_PERMISSIONS_NO_HARDCODED_DENY === '1') return null;
  const masked = maskQuotedRegions(command);
  for (const { pattern, reason } of HARDCODED_DENY) {
    if (pattern.test(masked)) return reason;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Always-prompt list - never auto-allowed, even in `/bash-auto` mode
// ──────────────────────────────────────────────────────────────────

/**
 * Patterns that always require explicit user approval - auto mode
 * never bypasses them. Unlike {@link HARDCODED_DENY}, matches here are
 * not blocks: an explicit project/user/session allow rule still wins,
 * so a user who knows what they're doing can `/bash-allow "sudo
 * apt-get install -y -qq build-essential"` and have it auto-run. What
 * this list prevents is a blanket `/bash-auto on` silently escalating
 * privileges.
 *
 * Scope: the commands below all run the rest of the command line as a
 * different (usually root) user. That's exactly the case where a
 * human should confirm - the tool's usual safety rails (project
 * rules, allow lists scoped by prefix) assume non-root semantics.
 *
 * Disable with PI_BASH_PERMISSIONS_NO_ALWAYS_PROMPT=1.
 */
export const ALWAYS_PROMPT: { pattern: RegExp; reason: string }[] = [
  // Privilege escalation wrappers. `\b` tolerates flags: `sudo -n -E
  // foo`, `sudo --preserve-env=FOO foo`, etc., all match.
  { pattern: /^\s*sudo\b/, reason: 'sudo (privilege escalation)' },
  { pattern: /^\s*doas\b/, reason: 'doas (privilege escalation)' },
  { pattern: /^\s*run0\b/, reason: 'run0 (privilege escalation)' },
  { pattern: /^\s*pkexec\b/, reason: 'pkexec (privilege escalation)' },
  { pattern: /^\s*gosu\b/, reason: 'gosu (privilege drop/elevation)' },
  { pattern: /^\s*su\b/, reason: 'su (switch user)' },
];

/**
 * Return the reason when `command` matches any ALWAYS_PROMPT entry,
 * or null otherwise. Quoted regions are masked (via
 * {@link maskQuotedRegions}) so an `echo "run sudo later"` message
 * body is not misidentified as an actual sudo invocation.
 */
export function checkAlwaysPrompt(command: string): string | null {
  if (process.env.PI_BASH_PERMISSIONS_NO_ALWAYS_PROMPT === '1') return null;
  const masked = maskQuotedRegions(command);
  for (const { pattern, reason } of ALWAYS_PROMPT) {
    if (pattern.test(masked)) return reason;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Sub-command decision (combines hardcoded deny + user rules + auto mode)
// ──────────────────────────────────────────────────────────────────────

export type BashDecision = { kind: 'allow' } | { kind: 'block'; reason: string } | { kind: 'prompt'; reason?: string };

export interface BashDecideOptions {
  /**
   * Auto-allow any sub-command that got past the hardcoded denylist,
   * explicit user/project/session deny rules, and the always-prompt
   * list. Used by the `/bash-auto` toggle. Hardcoded deny, explicit
   * deny, and always-prompt are NEVER overridable by this flag -
   * that's the whole point of the "except for risky actions"
   * carve-out.
   */
  auto?: boolean;
}

/**
 * Decide what to do with a single sub-command, applying rules in this
 * order of precedence (earlier rules always win):
 *
 *   0. Bare bash comment (`# ...`): treated as an allow, because bash
 *      evaluates it as a no-op. Comes before the hardcoded denylist
 *      so that `splitCompound` artefacts like `['echo hi', '# note']`
 *      don't block the whole compound on the harmless second half.
 *   0.5. Control-flow keyword strip:
 *      `if`/`elif`/`then`/`else`/`while`/`until`/`do`/`!` prefixes
 *      are peeled off, and standalone closers
 *      (`fi`/`done`/`esac`/`in`) short-circuit to allow. Ensures
 *      that `then rm -rf /` (a `splitCompound` artefact of `if …;
 *      then rm …; fi`) gets checked as `rm -rf /` and trips the
 *      hardcoded denylist.
 *   1. Hardcoded denylist (never overridable).
 *   2. Explicit user/project/session deny rules (never overridable).
 *   3. Explicit user/project/session allow rules.
 *   4. Always-prompt list (sudo / doas / …): forces a prompt even
 *      when `auto` is set. Bypassed by an explicit allow rule above.
 *   5. Auto-allow (if enabled).
 *   6. Fall through to a prompt.
 *
 * When a prompt is required because of (4), the returned decision's
 * `reason` contains the always-prompt match reason so the caller can
 * surface "⚡ auto mode cannot skip this" in the approval dialog.
 *
 * Pure function - no UI side effects. Callers collect decisions
 * across sub-commands and surface prompts / blocks to the user as
 * appropriate.
 */
export function decideSubcommand(
  sub: string,
  layers: { scope: Scope; rules: LoadedRules }[],
  options: BashDecideOptions = {},
): BashDecision {
  // 0. Bash comment - first non-whitespace char is `#`, so the whole
  //    sub-command evaluates to nothing. Short-circuit before the
  //    hardcoded denylist so patterns that aren't tail-anchored can't
  //    incidentally match the comment body.
  if (sub.trimStart().startsWith('#')) return { kind: 'allow' };

  // 0.5. Control-flow keyword strip. `then rm -rf /` becomes `rm -rf
  //      /` before the denylist sees it; `fi` / `done` / `esac`
  //      disappear.
  const effective = stripControlFlowKeyword(sub);
  if (effective === null) return { kind: 'allow' };
  sub = effective;

  // 1. Hardcoded deny.
  const hd = checkHardcodedDeny(sub);
  if (hd) return { kind: 'block', reason: `built-in denylist (${hd})` };

  // 2. Explicit deny rules.
  const m = matchOne(sub, layers);
  if (m?.kind === 'deny') {
    return { kind: 'block', reason: `${m.scope} deny rule: "${m.pattern}"` };
  }

  // 3. Explicit allow rules.
  if (m?.kind === 'allow') return { kind: 'allow' };

  // 4. Always-prompt list. Forces a prompt even when `auto` is on so
  //    sudo / doas / su can't be silently auto-approved.
  const alwaysPromptReason = checkAlwaysPrompt(sub);
  if (alwaysPromptReason) return { kind: 'prompt', reason: alwaysPromptReason };

  // 5. Auto-allow.
  if (options.auto) return { kind: 'allow' };

  // 6. Prompt.
  return { kind: 'prompt' };
}

// ──────────────────────────────────────────────────────────────────────
// Re-exports for backwards compatibility - parsing primitives moved to
// ./bash-parse.ts but every existing call site imports them from this
// module. New callers should prefer the focused import path.
// ──────────────────────────────────────────────────────────────────────

export {
  allSubcommands,
  commandTokens,
  extractCommandSubstitutions,
  maskQuotedRegions,
  splitCompound,
  stripControlFlowKeyword,
  twoTokenPattern,
};
