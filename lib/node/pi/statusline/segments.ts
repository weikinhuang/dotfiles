/**
 * Pure display-string builders for the statusline footer.
 *
 * Extracted from `config/pi/extensions/statusline.ts` so the palette,
 * the ANSI/OSC8 wrappers, the sandbox badge, and the cwd file:// URL are
 * unit-testable (golden-output) without the pi runtime. The footer
 * render loop in the shell stays there; only the leaf string builders
 * live here.
 *
 * Colors are hard-coded 256-color ANSI codes matching the dotfiles PS1 /
 * `config/claude/statusline-command.sh` palette. They intentionally
 * bypass pi's theme so the statusline looks identical across themes and
 * matches the interactive shell prompt.
 */

import { type SandboxMode } from '../session-flags.ts';

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';

export const PALETTE = {
  grey: '\x1b[38;5;244m',
  user: '\x1b[38;5;197m',
  host: '\x1b[38;5;208m',
  dir: '\x1b[38;5;142m',
  git: '\x1b[38;5;135m',
  worktree: '\x1b[38;5;173m',
  context: '\x1b[38;5;35m',
  token: '\x1b[38;5;245m',
  sessionToken: '\x1b[38;5;179m',
  subagent: '\x1b[38;5;73m',
  tool: '\x1b[38;5;214m',
  cost: '\x1b[38;5;108m',
  sessionId: '\x1b[38;5;244m',
  model: '\x1b[38;5;33m',
  persona: '\x1b[38;5;141m',
  sandbox: '\x1b[38;5;72m',
  sandboxWarn: '\x1b[38;5;172m',
  sandboxOff: '\x1b[38;5;160m',
} as const;

export const paint = (code: string, text: string): string => `${code}${text}${RESET}`;

/**
 * Wrap text in an OSC 8 hyperlink escape sequence.
 * Mirrors print_osc8_link() in statusline-command.sh.
 */
export const osc8 = (url: string, text: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

/**
 * Render the sandbox badge for line 1 of the statusline. Returns
 * `null` when the sandbox is effectively off (extension not loaded,
 * pre-init, or session bypass) so we don't add a leading space for
 * a nothing-segment.
 *
 * The trailing space after the shield emoji is intentional: some
 * terminals render the VS16-presented \ud83d\udee1\ufe0f glyph wide enough that
 * the next column collides with whatever follows.
 *
 *   wrapped       \ud83d\udee1\ufe0f<sp>             (deps OK + initialized)
 *   identity      \ud83d\udee1\ufe0f<sp>?            (degraded - missing deps / unsupported)
 *   bypassed      (hidden)              (/sandbox-disable session bypass)
 *   env-disabled  \ud83d\udee1\ufe0f<sp>\u00b7off         (PI_SANDBOX_DISABLED=1)
 *
 * `bypassed` previously rendered \ud83d\udee1\u0336 with a combining strikethrough,
 * but that produces broken glyphs on terminals that can't combine
 * U+0336 onto an emoji. Since `bypassed` means "sandbox is off for
 * this session", we just hide the badge - same as the `off` case.
 *
 * Color palette:
 *   wrapped       PALETTE.sandbox     (calm green)
 *   identity      PALETTE.sandboxWarn (amber - degraded; note that most
 *                                      terminals don't apply foreground
 *                                      colors to emoji, so only the `?`
 *                                      suffix actually picks up the tint)
 *   env-disabled  PALETTE.sandboxOff  (red)
 */
export function renderSandboxBadge(mode: SandboxMode): string | null {
  switch (mode) {
    case 'wrapped':
      return paint(PALETTE.sandbox, '\u{1F6E1}\uFE0F ');
    case 'identity':
      return paint(PALETTE.sandboxWarn, '\u{1F6E1}\uFE0F ?');
    case 'env-disabled':
      return paint(PALETTE.sandboxOff, '\u{1F6E1}\uFE0F \u00b7off');
    case 'bypassed':
    case 'off':
    default:
      return null;
  }
}

/**
 * Build a file:// URL for the cwd. Returns null when hyperlinks are disabled,
 * when we're on a remote SSH session (where file:// won't resolve on the
 * viewer's machine), or when cwd is empty. WSL paths are translated to the
 * host's filesystem view so clicks open in the Windows shell.
 *
 * `env` is injectable for tests; it defaults to `process.env` so the shell
 * call site is unchanged.
 */
export function cwdFileUrl(
  cwd: string,
  hyperlinksEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!hyperlinksEnabled || !cwd) return null;

  const wslDistro = env.WSL_DISTRO_NAME;
  if (wslDistro) {
    const mntMatch = /^\/mnt\/([a-z])(\/.*)?$/.exec(cwd);
    if (mntMatch) {
      const drive = mntMatch[1].toUpperCase();
      const rest = mntMatch[2] ?? '';
      return `file:///${drive}:${rest}`;
    }
    return `file://wsl.localhost/${wslDistro}${cwd}`;
  }

  // Skip hyperlinks when the terminal is attached to a remote session - the
  // local viewer can't resolve file:// paths on the remote host.
  if (env.SSH_CLIENT || env.SSH_TTY || env.SSH_CONNECTION) return null;

  return `file://${cwd}`;
}
