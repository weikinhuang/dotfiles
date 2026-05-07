/**
 * Pure helpers for config/pi/extensions/bash-permissions.ts.
 *
 * This module intentionally has zero dependencies on @earendil-works/pi-coding-agent
 * so it can be imported and unit-tested under `vitest` without any
 * TypeScript toolchain or pi runtime.
 */

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
// splitCompound — heredoc- and quote-aware command splitter
// ──────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a heredoc opener starting at `command[start]` where `command[start..start+1]`
 * is the literal `<<`. Returns the parsed delimiter info and the index just past
 * the opener, or null if this is a here-string (`<<<`) or the delimiter can't be
 * statically determined (e.g. `<<$VAR`). When null, the caller treats `<<` as
 * ordinary text and keeps scanning.
 */
function parseHeredocOpener(
  command: string,
  start: number,
): { delim: string; stripTabs: boolean; nextIndex: number } | null {
  // `<<<` is a here-string, not a heredoc.
  if (command[start + 2] === '<') return null;

  let k = start + 2;
  let stripTabs = false;
  if (command[k] === '-') {
    stripTabs = true;
    k++;
  }
  // Bash allows whitespace: `<< EOF`.
  while (command[k] === ' ' || command[k] === '\t') k++;

  // Delimiter: 'word', "word", or bare identifier. `<<$VAR` and other expansions
  // aren't statically resolvable — bail out and let the caller keep scanning.
  const q = command[k];
  if (q === "'" || q === '"') {
    const end = command.indexOf(q, k + 1);
    if (end === -1) return null;
    const delim = command.slice(k + 1, end);
    return delim ? { delim, stripTabs, nextIndex: end + 1 } : null;
  }

  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(k));
  if (!m) return null;
  return { delim: m[0], stripTabs, nextIndex: k + m[0].length };
}

/**
 * Locate the closing delimiter line of a heredoc whose body starts at
 * `fromIndex`. The trailing `\n` (or EOF) is deliberately kept OUT of
 * the closer match via a lookahead so the outer scanner still sees it
 * and can split on it if needed.
 *
 * Returns the body length and closer length on success, or a sentinel
 * `{ bodyLen: rest.length, closerLen: 0 }` when the heredoc is
 * unclosed — in that case the caller should absorb the rest of the
 * command as body.
 */
function findHeredocCloser(
  command: string,
  fromIndex: number,
  stripTabs: boolean,
  delim: string,
): { bodyLen: number; closerLen: number } {
  const closer = new RegExp(`\\n${stripTabs ? '\\t*' : ''}${escapeRegex(delim)}(?=\\n|$)`);
  const rest = command.slice(fromIndex);
  const m = closer.exec(rest);
  if (!m) return { bodyLen: rest.length, closerLen: 0 };
  return { bodyLen: m.index, closerLen: m[0].length };
}

/**
 * Split a compound command on top-level `&&`, `||`, `;`, and unquoted newlines.
 *
 * Heredoc bodies (`<<EOF ... EOF`, `<<'END' ... END`, `<<-EOF ... EOF`) are
 * treated as opaque — no splitting occurs between the `<<` marker and the line
 * matching the closing delimiter. This prevents splitting what is actually
 * script content for another language (Python, Node, SQL, …) on newlines.
 *
 * Pipes (`|`) are intentionally left intact. Quoting/escaping is handled
 * simplistically (single/double quotes, backslash escapes) — good enough to
 * stop trivial evasion without reimplementing a shell parser. Here-strings
 * (`<<<`) and unresolvable heredoc delimiters (`<<$VAR`) fall through to
 * normal scanning.
 */
export function splitCompound(command: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let escape = false;

  let i = 0;
  while (i < command.length) {
    const ch = command[i];

    if (escape) {
      buf += ch;
      escape = false;
      i++;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      buf += ch;
      escape = true;
      i++;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      buf += ch;
      quote = ch;
      i++;
      continue;
    }

    // Heredoc detection: `<<[-]DELIM` outside quotes.
    if (ch === '<' && command[i + 1] === '<') {
      // Here-string `<<<` is NOT a heredoc — consume all three `<` so the
      // outer loop doesn't re-enter heredoc detection at i+1 and mis-parse
      // the following word as a delimiter.
      if (command[i + 2] === '<') {
        buf += command.slice(i, i + 3);
        i += 3;
        continue;
      }
      const hd = parseHeredocOpener(command, i);
      if (hd) {
        // Append the opener literal (e.g. `<<EOF` or `<<-'END'`) to buf.
        buf += command.slice(i, hd.nextIndex);
        i = hd.nextIndex;

        const { bodyLen, closerLen } = findHeredocCloser(command, i, hd.stripTabs, hd.delim);
        buf += command.slice(i, i + bodyLen + closerLen);
        i += bodyLen + closerLen;
        continue;
      }
      // Unresolvable delimiter (e.g. `<<$VAR`) — fall through to normal scanning.
    }

    const rest2 = command.slice(i, i + 2);
    if (rest2 === '&&' || rest2 === '||') {
      parts.push(buf.trim());
      buf = '';
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      parts.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

// ──────────────────────────────────────────────────────────────────────
// matchesPattern — exact / prefix* / regex
// ──────────────────────────────────────────────────────────────────────

/**
 * Warn once per unique bad regex pattern so typos in the JSON config are
 * discoverable without spamming the log on every tool call.
 */
const warnedBadPatterns = new Set<string>();

/**
 * Try to parse `pattern` as a regex rule. Returns a compiled RegExp on
 * success, null if `pattern` doesn't use regex syntax, or `false` if it
 * looks like regex syntax but the body doesn't compile (the caller then
 * treats it as "never matches" rather than silently falling back to an
 * exact-string match that would surprise the user).
 */
export function tryCompileRegexRule(pattern: string): RegExp | null | false {
  // `re:<source>` — explicit, unambiguous, no flags.
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

  // `/source/flags` — only when the trailing portion after the LAST `/`
  // consists solely of JS regex flag chars. This keeps absolute-path
  // commands like "/usr/bin/true" as plain exact strings.
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
  if (regex === false) return false; // bad regex — never match
  if (regex) return regex.test(command);

  if (pattern.endsWith('*')) {
    // Token-aware prefix match: `git log*` matches `git log` and `git log -1`
    // but NOT `git logfoo`. Matches Claude Code's `Bash(git log:*)` semantics.
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
// Hardcoded denylist — unambiguous footguns that should never auto-run
// ──────────────────────────────────────────────────────────────────────

/**
 * These patterns block even if the user has a broad allow rule above
 * them. Kept short and precise to minimize false positives. Disable with
 * PI_BASH_PERMISSIONS_NO_HARDCODED_DENY=1 if you really know what you're
 * doing.
 */
export const HARDCODED_DENY: { pattern: RegExp; reason: string }[] = [
  // rm -r (any flag order/combo containing r/R, or --recursive) targeting
  // /, ~, ~/, $HOME, or /* as the only remaining argument.
  {
    pattern: /^\s*rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s+-[^\s]+)*\s+(?:\/|\/\*|~|~\/|\$HOME\/?)\s*$/,
    reason: 'rm -r targeting /, ~, or $HOME',
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

/**
 * Replace the interior of every quoted substring in `command` with NUL
 * bytes, leaving the quote characters themselves in place. Used to prevent
 * hardcoded-denylist regexes from matching dangerous keywords that appear
 * only inside string literals — for example a `mkfs` or `rm -rf /` mentioned
 * in a `git commit -m "..."` message body, an `echo "..."`, or a heredoc.
 *
 * Quote handling:
 *   - Single quotes (`'...'`): contents are literal; no escapes honored.
 *   - Double quotes (`"..."`): backslash escapes the next char.
 *   - Heredoc bodies (`<<EOF ... EOF`, `<<'END' ... END`, `<<-EOF ... EOF`):
 *     body content is masked; the opener (`<<EOF`) and closing delimiter
 *     line (`\nEOF`) are preserved verbatim. Here-strings (`<<<`) are
 *     NOT masked — they behave like normal args.
 *   - Outside quotes: backslash also escapes the next char (e.g. `\\n`
 *     line continuation).
 *
 * NUL is chosen as the mask byte because it is neither a word char, a
 * whitespace char, nor a shell operator, so `\b`, `\s`, `|`, `;`, `>`,
 * etc. never accidentally match against masked content. Quote characters
 * and character offsets are preserved so positional regex anchors (`^`,
 * `$`) still align with the original command.
 *
 * Trade-off: `rm -rf "/"` (target quoted) will NOT be caught by the
 * hardcoded denylist — the target is masked. This is intentional. Bash
 * evaluates `rm -rf "/"` the same as `rm -rf /`, so a truly malicious
 * command would just drop the quotes; gaining false-positive resistance
 * on legitimate `echo "..."` / commit-message cases is the better
 * trade. Users who need stronger guarantees should add explicit deny
 * rules.
 */
export function maskQuotedRegions(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  let escape = false;

  let i = 0;
  while (i < command.length) {
    const ch = command[i];

    if (escape) {
      // Previous char was a backslash. Emit this char masked if we're
      // inside any quote, literal if we're unquoted.
      out += quote ? '\0' : ch;
      escape = false;
      i++;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      // Backslash starts an escape sequence everywhere except inside
      // single quotes. Mask the backslash itself iff it's inside a
      // double-quoted region; leave it literal if unquoted (so line
      // continuations stay visible to downstream passes).
      out += quote === '"' ? '\0' : ch;
      escape = true;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        out += ch;
        quote = null;
      } else {
        out += '\0';
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      out += ch;
      quote = ch;
      i++;
      continue;
    }

    // Heredoc detection: `<<[-]DELIM` outside quotes. Mask the body;
    // preserve the opener and closing-delimiter line literally so
    // positional anchors in downstream regexes still align.
    if (ch === '<' && command[i + 1] === '<') {
      // `<<<` here-string: not a heredoc. Emit the three `<` literally
      // and continue scanning so we don't re-enter heredoc detection at
      // i+1 and mis-parse the following word as a delimiter.
      if (command[i + 2] === '<') {
        out += command.slice(i, i + 3);
        i += 3;
        continue;
      }
      const hd = parseHeredocOpener(command, i);
      if (hd) {
        out += command.slice(i, hd.nextIndex);
        i = hd.nextIndex;

        const { bodyLen, closerLen } = findHeredocCloser(command, i, hd.stripTabs, hd.delim);
        out += '\0'.repeat(bodyLen);
        out += command.slice(i + bodyLen, i + bodyLen + closerLen);
        i += bodyLen + closerLen;
        continue;
      }
      // Unresolvable delimiter (e.g. `<<$VAR`) — fall through to normal scanning.
    }

    out += ch;
    i++;
  }
  return out;
}

export function checkHardcodedDeny(command: string): string | null {
  if (process.env.PI_BASH_PERMISSIONS_NO_HARDCODED_DENY === '1') return null;
  const masked = maskQuotedRegions(command);
  for (const { pattern, reason } of HARDCODED_DENY) {
    if (pattern.test(masked)) return reason;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Always-prompt list — never auto-allowed, even in `/bash-auto` mode
// ──────────────────────────────────────────────────────────────────

/**
 * Patterns that always require explicit user approval — auto mode never
 * bypasses them. Unlike {@link HARDCODED_DENY}, matches here are not
 * blocks: an explicit project/user/session allow rule still wins, so a
 * user who knows what they're doing can `/bash-allow "sudo apt-get
 * install -y -qq build-essential"` and have it auto-run. What this list
 * prevents is a blanket `/bash-auto on` silently escalating privileges.
 *
 * Scope: the commands below all run the rest of the command line as a
 * different (usually root) user. That's exactly the case where a human
 * should confirm — the tool's usual safety rails (project rules, allow
 * lists scoped by prefix) assume non-root semantics.
 *
 * Disable with PI_BASH_PERMISSIONS_NO_ALWAYS_PROMPT=1.
 */
export const ALWAYS_PROMPT: { pattern: RegExp; reason: string }[] = [
  // Privilege escalation wrappers. `\b` tolerates flags: `sudo -n -E foo`,
  // `sudo --preserve-env=FOO foo`, etc., all match.
  { pattern: /^\s*sudo\b/, reason: 'sudo (privilege escalation)' },
  { pattern: /^\s*doas\b/, reason: 'doas (privilege escalation)' },
  { pattern: /^\s*run0\b/, reason: 'run0 (privilege escalation)' },
  { pattern: /^\s*pkexec\b/, reason: 'pkexec (privilege escalation)' },
  { pattern: /^\s*gosu\b/, reason: 'gosu (privilege drop/elevation)' },
  { pattern: /^\s*su\b/, reason: 'su (switch user)' },
];

/**
 * Return the reason when `command` matches any ALWAYS_PROMPT entry, or
 * null otherwise. Quoted regions are masked (via {@link maskQuotedRegions})
 * so an `echo "run sudo later"` message body is not misidentified as an
 * actual sudo invocation.
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
   * deny, and always-prompt are NEVER overridable by this flag —
   * that's the whole point of the "except for risky actions" carve-out.
   */
  auto?: boolean;
}

/**
 * Decide what to do with a single sub-command, applying rules in this
 * order of precedence (earlier rules always win):
 *
 *   1. Hardcoded denylist (never overridable).
 *   2. Explicit user/project/session deny rules (never overridable).
 *   3. Explicit user/project/session allow rules.
 *   4. Always-prompt list (sudo / doas / …): forces a prompt even when
 *      `auto` is set. Bypassed by an explicit allow rule above.
 *   5. Auto-allow (if enabled).
 *   6. Fall through to a prompt.
 *
 * When a prompt is required because of (4), the returned decision's
 * `reason` contains the always-prompt match reason so the caller can
 * surface "⚡ auto mode cannot skip this" in the approval dialog.
 *
 * Pure function — no UI side effects. Callers collect decisions across
 * sub-commands and surface prompts / blocks to the user as appropriate.
 */
export function decideSubcommand(
  sub: string,
  layers: { scope: Scope; rules: LoadedRules }[],
  options: BashDecideOptions = {},
): BashDecision {
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
// Command-token helpers (used by the approval dialog to suggest rules)
// ──────────────────────────────────────────────────────────────────────

/**
 * Split a command into whitespace tokens, stopping at shell operators.
 * Returns only the leading "program + args" portion (before `|`, `>`, etc.).
 */
export function commandTokens(command: string): string[] {
  const head = command.trimStart().split(/[|&;<>()]/)[0] ?? '';
  return head.split(/\s+/).filter(Boolean);
}

/**
 * Suggest a `<tok1> <tok2>*` prefix rule for `command`, or null when the
 * second token is a flag / shell operator / missing. Used by the
 * approval dialog to offer a narrower alternative than `<tok1>*`.
 */
export function twoTokenPattern(command: string): string | null {
  const tokens = commandTokens(command);
  const usable = tokens.length >= 2 && !tokens[1].startsWith('-');
  return usable ? `${tokens[0]} ${tokens[1]}*` : null;
}

// Command-token helpers (used by the approval dialog to suggest rules)
