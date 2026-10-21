/**
 * Shell selection for `bg_bash start` plus a heuristic warning for
 * bash-only syntax run under `/bin/sh`.
 *
 * `/bin/sh` is dash on Debian / Ubuntu and POSIX-mode bash 3.2 on macOS, so
 * bash-isms like `${PIPESTATUS[0]}`, `[[ ... ]]`, `<(...)` or arrays fail
 * (dash: "Bad substitution") or silently misbehave depending on the host.
 * The `shell` option (`'sh'` default, `'bash'` opt-in) picks the
 * interpreter; when a command stays on `sh` but looks bash-only, the start
 * result carries a warning so the model can re-run it with
 * `shell: "bash"` instead of trusting a wrong result.
 *
 * The detector is a deliberately small regex heuristic over the raw command
 * string: it can fire on text inside quotes (e.g. `rg 'PIPESTATUS'`), which
 * only costs a harmless note, and it never blocks anything.
 *
 * No pi imports - unit-tested under vitest.
 */

import { type BgBashShell } from './config.ts';

interface Feature {
  name: string;
  re: RegExp;
}

const BASH_ONLY_FEATURES: readonly Feature[] = [
  { name: 'PIPESTATUS', re: /\bPIPESTATUS\b/ },
  { name: '[[ ]]', re: /(?:^|[\s;&|(!])\[\[(?:\s|$)/ },
  { name: 'process substitution', re: /(?<![<>\w])[<>]\(/ },
  {
    name: 'arrays',
    re: /(?<![-\w])[A-Za-z_]\w*=\(|\$\{[A-Za-z_]\w*\[|\b(?:declare|local|typeset)\s+-[A-Za-z]*[aA]\b/,
  },
  { name: '&> redirection', re: /&>/ },
  { name: '|& pipe', re: /\|&/ },
  { name: "$'...' quoting", re: /\$'/ },
  { name: 'brace range', re: /\{\w+\.\.\w+\}/ },
  { name: 'source', re: /(?:^|[;&|]\s*|\n\s*)source\s/ },
  { name: 'shopt', re: /\bshopt\b/ },
];

/** Names of bash-only constructs that appear in `command` (may be empty). */
export function detectBashOnlySyntax(command: string): string[] {
  return BASH_ONLY_FEATURES.filter((f) => f.re.test(command)).map((f) => f.name);
}

/**
 * Warning line for a `start` result, or `undefined` when the command runs
 * under bash or shows no bash-only syntax.
 */
export function bashOnlySyntaxWarning(command: string, shell: BgBashShell): string | undefined {
  if (shell === 'bash') return undefined;
  const found = detectBashOnlySyntax(command);
  if (found.length === 0) return undefined;
  return (
    `Warning: the command looks bash-only (${found.join(', ')}) but runs under /bin/sh ` +
    '(dash on Debian/Ubuntu, POSIX-mode bash on macOS). Restart it with shell: "bash" if it misbehaves.'
  );
}

/** Executable + argv for spawning `command` under `shell`. */
export function shellSpawnArgs(shell: BgBashShell, command: string): { file: string; args: string[] } {
  return shell === 'bash' ? { file: 'bash', args: ['-c', command] } : { file: '/bin/sh', args: ['-c', command] };
}
