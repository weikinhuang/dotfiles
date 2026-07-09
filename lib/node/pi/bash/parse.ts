/**
 * Bash command parsing - shell-string-level utilities used to figure
 * out "what would bash actually execute here". Pi-runtime-free.
 *
 * Lives separately from `bash-match.ts` (the rule engine on top) so the
 * parsing pieces can be reused by other gates without dragging the
 * rule-engine surface along. `bash-match.ts` re-exports everything here
 * so existing call sites that import from `bash-match` keep working
 * unchanged - new callers should import from this module directly when
 * they only need parsing.
 *
 * Defence-in-depth, not bulletproof shell parsing: a sufficiently
 * adversarial string (e.g. unbalanced backticks, exotic heredoc forms)
 * may evade the scanner. Matches here result in extra prompt / block
 * decisions, never in weaker checks - failure modes are fail-closed.
 */

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a heredoc opener starting at `command[start]` where
 * `command[start..start+1]` is the literal `<<`. Returns the parsed
 * delimiter info and the index just past the opener, or null if this
 * is a here-string (`<<<`) or the delimiter can't be statically
 * determined (e.g. `<<$VAR`). When null, the caller treats `<<` as
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

  // Delimiter: 'word', "word", or bare identifier. `<<$VAR` and other
  // expansions aren't statically resolvable - bail out and let the
  // caller keep scanning.
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
 * unclosed - in that case the caller should absorb the rest of the
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
 * Find the index of the `close` that balances the `open` at `openIdx`,
 * respecting single / double quotes and backslash escapes within the
 * enclosed region. Returns -1 if unbalanced.
 *
 * `openIdx` must point at the opening `open` character; scanning
 * starts one past it with depth=1.
 */
function findMatchingClose(s: string, openIdx: number, endIdx: number, open: string, close: string): number {
  let depth = 1;
  let i = openIdx + 1;
  let inSingle = false;
  let inDouble = false;
  while (i < endIdx) {
    const c = s[i];
    if (!inSingle && c === '\\' && i + 1 < endIdx) {
      i += 2;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (inSingle || inDouble) {
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// ──────────────────────────────────────────────────────────────────────
// Top-level splitting
// ──────────────────────────────────────────────────────────────────────

/**
 * Split `command` at every top-level position where `separatorLen`
 * reports a separator, sharing one quote / escape / heredoc-aware
 * scanner. `separatorLen(command, i)` returns the length of the
 * separator starting at unquoted index `i`, or 0 when `i` is not a
 * split point. Quoted regions, backslash escapes, and heredoc bodies
 * are never consulted for separators.
 *
 * Heredoc bodies (`<<EOF ... EOF`, `<<'END' ... END`, `<<-EOF ... EOF`)
 * are treated as opaque so script content for another language
 * (Python, Node, SQL, …) is not split on its own operators.
 * Here-strings (`<<<`) and unresolvable heredoc delimiters (`<<$VAR`)
 * fall through to normal scanning.
 */
function splitTopLevel(command: string, separatorLen: (command: string, i: number) => number): string[] {
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
      // Here-string `<<<` is NOT a heredoc - consume all three `<` so
      // the outer loop doesn't re-enter heredoc detection at i+1 and
      // mis-parse the following word as a delimiter.
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
      // Unresolvable delimiter (e.g. `<<$VAR`) - fall through to
      // normal scanning.
    }

    const sepLen = separatorLen(command, i);
    if (sepLen > 0) {
      parts.push(buf.trim());
      buf = '';
      i += sepLen;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.filter(Boolean);
}

/**
 * Split a compound command on top-level `&&`, `||`, `;`, and unquoted
 * newlines. Pipes (`|`) are deliberately left intact here - the
 * approval gate splits those separately via {@link splitPipeline} so
 * pipe-crossing hardcoded-deny patterns (`curl … | sh`) can still match
 * the whole command. Quoting/escaping is handled simplistically
 * (single/double quotes, backslash escapes) - good enough to stop
 * trivial evasion without reimplementing a shell parser.
 */
export function splitCompound(command: string): string[] {
  return splitTopLevel(command, (cmd, i) => {
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') return 2;
    const ch = cmd[i];
    if (ch === ';' || ch === '\n') return 1;
    return 0;
  });
}

/**
 * Split a command on top-level pipe operators (`|`, `||`, `|&`) into
 * its pipeline stages, so a destructive right-hand stage like
 * `true | rm -rf /` is checked on its own rather than hidden behind an
 * innocuous leading stage. Same quote / heredoc awareness as
 * {@link splitCompound}. Returns `[command]` (trimmed) when there is no
 * pipe. `||` is treated as a boundary too - harmless for the
 * deny-expansion use case and avoids a stray empty stage.
 */
export function splitPipeline(command: string): string[] {
  const stages = splitTopLevel(command, (cmd, i) => {
    if (cmd[i] !== '|') return 0;
    // `||` (logical or) and `|&` (pipe both streams) are two chars;
    // a bare `|` is one. All act as a stage boundary here.
    if (cmd[i + 1] === '|' || cmd[i + 1] === '&') return 2;
    return 1;
  });
  return stages.length > 0 ? stages : [command.trim()].filter(Boolean);
}

// ──────────────────────────────────────────────────────────────────────
// Command-wrapper peeling (bash -c, env, sudo, nohup, …)
// ──────────────────────────────────────────────────────────────────────

// Shell interpreters whose `-c <payload>` argument is the command that
// actually runs. Matches bare names and absolute paths: `sh`, `bash`,
// `/bin/sh`, `/usr/bin/zsh`, `dash`, `ksh`, `ash`.
const SHELL_INTERPRETER_RE = /^(?:.*\/)?(?:ba|da|k|a|z)?sh$/;

// Launcher wrappers whose trailing arguments are themselves a command:
// `env FOO=1 rm …`, `sudo rm …`, `nohup rm …`, `xargs rm …`, etc. Each
// runs the rest of the argv as a program, so the payload must still face
// the hardcoded denylist.
const COMMAND_WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'setsid',
  'nice',
  'ionice',
  'stdbuf',
  'time',
  'timeout',
  'xargs',
  'sudo',
  'doas',
  'run0',
  'pkexec',
  'gosu',
  'su',
]);

/**
 * Whitespace-tokenize `command` with the same quote / escape rules as
 * the rest of this module, returning UNQUOTED token values. Used only
 * for wrapper peeling, where we need `bash -c 'rm -rf /'` to yield the
 * token `rm -rf /` (quotes stripped) so the inner command is visible to
 * the denylist. Not a full shell tokenizer - operators are kept as part
 * of adjacent tokens, which is fine because callers re-split on pipes /
 * compounds separately.
 */
function shellTokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (const ch of command) {
    if (escape) {
      cur += ch;
      has = true;
      escape = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escape = true;
      has = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (has) {
        tokens.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

/**
 * If `command` starts with a launcher/interpreter wrapper, return the
 * inner command it would run (so `bash -c 'rm -rf /'` -> `rm -rf /`,
 * `env FOO=1 rm -rf /` -> `rm -rf /`). Returns `null` when there is no
 * recognised wrapper. Best-effort and deliberately liberal: an
 * over-eager peel only ever produces an EXTRA hardcoded-deny check on a
 * command that is almost never a real footgun, so false positives are
 * negligible while the bypass is closed.
 */
export function peelCommandWrapper(command: string): string | null {
  const tokens = shellTokenize(command);
  if (tokens.length === 0) return null;

  let i = 0;
  let consumed = false;
  while (i < tokens.length) {
    const tok = tokens[i];

    // Interpreter `-c <payload>`: the payload token is the command.
    if (SHELL_INTERPRETER_RE.test(tok)) {
      for (let j = i + 1; j < tokens.length; j++) {
        const flag = tokens[j];
        if (/^-[a-z]*c$/.test(flag)) return tokens[j + 1] ?? null;
        if (flag.startsWith('-')) continue;
        break; // e.g. `bash script.sh` - not a `-c` payload.
      }
      return null;
    }

    if (tok === 'env') {
      i++;
      // Skip env's own flags and `VAR=value` assignments.
      while (i < tokens.length && (tokens[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
      consumed = true;
      continue;
    }

    if (COMMAND_WRAPPERS.has(tok)) {
      i++;
      // Skip the wrapper's own flags (`nice -n`, `stdbuf -oL`, …).
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      // A few take a leading numeric/duration operand.
      if ((tok === 'timeout' || tok === 'nice' || tok === 'ionice') && i < tokens.length && /^[0-9]/.test(tokens[i])) {
        i++;
      }
      consumed = true;
      continue;
    }

    break;
  }

  if (consumed && i < tokens.length) return tokens.slice(i).join(' ');
  return null;
}

/**
 * Every command string the hardcoded-deny / always-prompt checks should
 * be run against for `command`: the command itself (so pipe-crossing
 * patterns like `curl … | sh` still match), each pipeline stage (so
 * `true | rm -rf /` is inspected), and any wrapper-peeled inner command
 * (so `bash -c 'rm -rf /'` / `env rm -rf /` are inspected), recursively
 * up to a bounded depth. Deduped, order-stable.
 */
export function expandForSafetyCheck(command: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };

  add(command);
  const queue = [...splitPipeline(command)];
  let depth = 0;
  while (queue.length > 0 && depth < 64) {
    depth++;
    const stage = queue.shift();
    if (stage === undefined) break;
    add(stage);
    const inner = peelCommandWrapper(stage);
    if (inner) {
      for (const s of splitPipeline(inner)) {
        if (!seen.has(s.trim())) queue.push(s);
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Quote-region masking
// ──────────────────────────────────────────────────────────────────────

/**
 * Replace the interior of every quoted substring in `command` with NUL
 * bytes, leaving the quote characters themselves in place. Used to
 * prevent hardcoded-denylist regexes from matching dangerous keywords
 * that appear only inside string literals - for example a `mkfs` or
 * `rm -rf /` mentioned in a `git commit -m "..."` message body, an
 * `echo "..."`, or a heredoc.
 *
 * Quote handling:
 *   - Single quotes (`'...'`): contents are literal; no escapes honored.
 *   - Double quotes (`"..."`): backslash escapes the next char.
 *   - Heredoc bodies (`<<EOF ... EOF`, `<<'END' ... END`, `<<-EOF ... EOF`):
 *     body content is masked; the opener (`<<EOF`) and closing
 *     delimiter line (`\nEOF`) are preserved verbatim. Here-strings
 *     (`<<<`) are NOT masked - they behave like normal args.
 *   - Outside quotes: backslash also escapes the next char (e.g. `\\n`
 *     line continuation).
 *
 * NUL is chosen as the mask byte because it is neither a word char, a
 * whitespace char, nor a shell operator, so `\b`, `\s`, `|`, `;`, `>`,
 * etc. never accidentally match against masked content. Quote
 * characters and character offsets are preserved so positional regex
 * anchors (`^`, `$`) still align with the original command.
 *
 * Trade-off: `rm -rf "/"` (target quoted) will NOT be caught by the
 * hardcoded denylist - the target is masked. This is intentional. Bash
 * evaluates `rm -rf "/"` the same as `rm -rf /`, so a truly malicious
 * command would just drop the quotes; gaining false-positive
 * resistance on legitimate `echo "..."` / commit-message cases is the
 * better trade. Users who need stronger guarantees should add explicit
 * deny rules.
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
      // and continue scanning so we don't re-enter heredoc detection
      // at i+1 and mis-parse the following word as a delimiter.
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
      // Unresolvable delimiter (e.g. `<<$VAR`) - fall through to
      // normal scanning.
    }

    out += ch;
    i++;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Control-flow normalization
// ──────────────────────────────────────────────────────────────────────

/**
 * Strip leading bash control-flow syntax from a sub-command so the
 * approval gate evaluates what bash will actually execute, not the
 * syntactic wrapper around it.
 *
 * `splitCompound` cuts on `&&` / `||` / `;` / newlines, so a compound
 * like `if [[ -f foo ]]; then rm -rf /; fi` surfaces as three subs:
 * `['if [[ -f foo ]]', 'then rm -rf /', 'fi']`. Without normalization,
 * `then rm -rf /` would sail past the hardcoded denylist (whose regex
 * anchors to `^\s*rm\s+…`, not `^\s*then\s+rm\s+…`). We strip the
 * leading keyword so the inner command gets the full gate.
 *
 * Returns:
 *   - `null`  if the sub is pure syntax and nothing is executed
 *             (`fi`, `done`, `esac`, `in`, or a bare keyword like `if`).
 *   - string  the effective command after stripping (may equal input
 *             if no leading syntax was found).
 *
 * Keywords stripped iteratively so `then ! rm -rf /` unwinds to
 * `rm -rf /`. Deliberately NOT stripped: `for` / `select` / `case` -
 * their positional args aren't executable commands, so they're left
 * for a `for*` / `select*` / `case*` allow rule to admit. `!` is
 * treated as a strippable modifier (bash's negation reserved word)
 * because it appears in `if ! cmd` / `while ! cmd` idioms and the
 * thing after it is what actually runs.
 */
export function stripControlFlowKeyword(sub: string): string | null {
  const STANDALONE = new Set(['fi', 'done', 'esac', 'in']);
  const STRIP = ['if', 'elif', 'then', 'else', 'while', 'until', 'do', '!'];

  let current = sub.trim();
  while (current.length > 0) {
    if (STANDALONE.has(current)) return null;
    let stripped = false;
    for (const kw of STRIP) {
      if (current === kw) return null;
      if (current.startsWith(`${kw} `) || current.startsWith(`${kw}\t`)) {
        current = current.slice(kw.length).trimStart();
        stripped = true;
        break;
      }
    }
    if (!stripped) return current;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Command-substitution extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Return every sub-command hidden inside command-substitution or
 * process-substitution contexts in `cmd`. Complements
 * {@link splitCompound}, which only handles top-level `&&` / `||` /
 * `;` / newline separators.
 *
 * Recognises:
 *   - `$(cmd)`       command substitution
 *   - `` `cmd` ``    legacy command substitution
 *   - `<(cmd)`       process substitution (input)
 *   - `>(cmd)`       process substitution (output)
 *
 * Quoting / escape rules match bash:
 *   - `'...'`                literal - contents are NOT extracted
 *   - `"..."`                substitution still active - contents ARE
 *                            extracted
 *   - `\$(cmd)` / `` \` ``  escaped - not a substitution
 *   - `${var}`               parameter expansion - ignored (starts
 *                            with `${`, not `$(`)
 *   - `$((expr))`            arithmetic expansion - skipped, not a
 *                            command
 *
 * Nested substitutions are walked recursively. Extracted bodies are
 * then passed through {@link splitCompound} so `$(a && b)` surfaces
 * `a` and `b` independently.
 */
export function extractCommandSubstitutions(cmd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (body: string): void => {
    for (const part of splitCompound(body)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  };

  const scan = (s: string): void => {
    const len = s.length;
    let i = 0;
    let inSingle = false;
    let inDouble = false;

    while (i < len) {
      const ch = s[i];

      // Backslash escape outside single quotes consumes the next char.
      if (!inSingle && ch === '\\' && i + 1 < len) {
        i += 2;
        continue;
      }

      if (!inDouble && ch === "'") {
        inSingle = !inSingle;
        i++;
        continue;
      }

      if (!inSingle && ch === '"') {
        inDouble = !inDouble;
        i++;
        continue;
      }

      if (inSingle) {
        i++;
        continue;
      }

      // `$((...))` arithmetic expansion - not a command itself, but a
      // real `$(cmd)` / backtick can appear nested inside the
      // expression (e.g. `$(( x + $(y) ))`), so recursively scan the
      // interior.
      if (ch === '$' && s[i + 1] === '(' && s[i + 2] === '(') {
        let depth = 2;
        let j = i + 3;
        while (j < len && depth > 0) {
          const c = s[j];
          if (c === '\\' && j + 1 < len) {
            j += 2;
            continue;
          }
          if (c === '(') depth++;
          else if (c === ')') depth--;
          j++;
        }
        // j is now one past the closing `))` (or at EOF if unbalanced).
        if (j - 2 > i + 3) scan(s.slice(i + 3, j - 2));
        i = j;
        continue;
      }

      // `$(cmd)` command substitution.
      if (ch === '$' && s[i + 1] === '(') {
        const end = findMatchingClose(s, i + 1, len, '(', ')');
        if (end >= 0) {
          const body = s.slice(i + 2, end);
          push(body);
          scan(body);
          i = end + 1;
          continue;
        }
      }

      // `<(cmd)` / `>(cmd)` process substitution. Require the
      // preceding char be whitespace, `=`, or start-of-string so we
      // don't misread a redirect like `2>(log)` - actually bash does
      // accept `2>(log)` as process substitution, so just match any
      // `<(` / `>(`.
      if ((ch === '<' || ch === '>') && s[i + 1] === '(') {
        const end = findMatchingClose(s, i + 1, len, '(', ')');
        if (end >= 0) {
          const body = s.slice(i + 2, end);
          push(body);
          scan(body);
          i = end + 1;
          continue;
        }
      }

      // `` `cmd` `` backtick substitution. Find closing unescaped
      // backtick.
      if (ch === '`') {
        let j = i + 1;
        while (j < len) {
          if (s[j] === '\\' && j + 1 < len) {
            j += 2;
            continue;
          }
          if (s[j] === '`') break;
          j++;
        }
        if (j < len) {
          const body = s.slice(i + 1, j);
          push(body);
          scan(body);
          i = j + 1;
          continue;
        }
      }

      i++;
    }
  };

  scan(cmd);
  return out;
}

/**
 * All sub-commands the permissions gate must clear for `cmd` to run:
 * the union of {@link splitCompound} (top-level `&&` / `||` / `;` /
 * newline splits) and {@link extractCommandSubstitutions} (hidden
 * inside `$(…)`, backticks, and process substitutions). Each returned
 * string is one independently-checkable sub-command.
 */
export function allSubcommands(cmd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of splitCompound(cmd)) {
    const trimmed = s.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  for (const s of extractCommandSubstitutions(cmd)) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Command-token helpers (used by the approval dialog to suggest rules)
// ──────────────────────────────────────────────────────────────────────

/**
 * Split a command into whitespace tokens, stopping at shell operators.
 * Returns only the leading "program + args" portion (before `|`, `>`,
 * etc.).
 */
export function commandTokens(command: string): string[] {
  const head = command.trimStart().split(/[|&;<>()]/)[0] ?? '';
  return head.split(/\s+/).filter(Boolean);
}

/**
 * Suggest a `<tok1> <tok2>*` prefix rule for `command`, or null when
 * the second token is a flag / shell operator / missing. Used by the
 * approval dialog to offer a narrower alternative than `<tok1>*`.
 */
export function twoTokenPattern(command: string): string | null {
  const tokens = commandTokens(command);
  const usable = tokens.length >= 2 && !tokens[1].startsWith('-');
  return usable ? `${tokens[0]} ${tokens[1]}*` : null;
}
