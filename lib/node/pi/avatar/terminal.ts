/**
 * Pure terminal -> image-protocol detection for the `avatar` extension.
 *
 * Minimal scope: direct kitty graphics + direct iTerm2 inline images +
 * sixel (Windows Terminal >= 1.22), ASCII otherwise. tmux / screen force
 * ASCII because image passthrough is not implemented yet (future work).
 */

import type { Protocol } from './types.ts';

/** The subset of `process.env` the detector reads. */
export interface TerminalEnv {
  TMUX?: string;
  TERM?: string;
  TERM_PROGRAM?: string;
  KITTY_WINDOW_ID?: string;
  GHOSTTY_RESOURCES_DIR?: string;
  WEZTERM_PANE?: string;
  ITERM_SESSION_ID?: string;
  /** Windows Terminal sets this on every session; it speaks sixel as of 1.22. */
  WT_SESSION?: string;
}

/**
 * Detect the best image protocol for the current terminal from `env`.
 * Returns `ascii` inside a multiplexer (no passthrough yet) and for any
 * terminal we can't positively identify as kitty- or iTerm2-capable.
 */
export function detectProtocol(env: TerminalEnv): Protocol {
  const term = (env.TERM ?? '').toLowerCase();

  // No tmux/screen passthrough yet -> text fallback inside multiplexers.
  if ((env.TMUX ?? '').length > 0 || term.startsWith('tmux') || term.startsWith('screen')) {
    return 'ascii';
  }

  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();

  if (
    (env.KITTY_WINDOW_ID ?? '').length > 0 ||
    (env.GHOSTTY_RESOURCES_DIR ?? '').length > 0 ||
    termProgram === 'kitty' ||
    termProgram === 'ghostty' ||
    term.includes('ghostty')
  ) {
    return 'kitty';
  }

  if (
    (env.ITERM_SESSION_ID ?? '').length > 0 ||
    (env.WEZTERM_PANE ?? '').length > 0 ||
    termProgram === 'iterm.app' ||
    termProgram === 'wezterm'
  ) {
    return 'iterm2';
  }

  // Windows Terminal speaks neither kitty nor iTerm2, but ships sixel as of 1.22.
  if ((env.WT_SESSION ?? '').length > 0) {
    return 'sixel';
  }

  return 'ascii';
}

/**
 * Resolve the protocol from a config/env `override` falling back to
 * auto-detection. A concrete override (`kitty` / `iterm2` / `sixel` /
 * `ascii`) wins; `auto` (or anything else) defers to {@link detectProtocol}.
 */
export function resolveProtocol(override: string, env: TerminalEnv): Protocol {
  if (override === 'kitty' || override === 'iterm2' || override === 'sixel' || override === 'ascii') {
    return override;
  }
  return detectProtocol(env);
}
