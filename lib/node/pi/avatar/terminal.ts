/**
 * Pure terminal -> image-protocol detection for the `avatar` extension.
 *
 * Minimal scope: direct kitty graphics + direct iTerm2 inline images +
 * sixel (Windows Terminal >= 1.22), ASCII otherwise. Inside tmux / screen
 * auto-detect returns ASCII as a safety net (outer-terminal env markers
 * are typically scrubbed across panes, and image escapes get dropped
 * without explicit user configuration). Users with `allow-passthrough on`
 * configured can still force an image protocol via the `render` config
 * key or `PI_AVATAR_RENDER`; {@link resolveProtocol} honours the override
 * and the renderer wraps the payload in tmux's DCS passthrough envelope.
 */

import { isInTmux } from './tmux.ts';
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
 * Returns `ascii` inside a multiplexer (auto-detect is conservative; users
 * opt in to image-protocol passthrough via the `render` override) and for
 * any terminal we can't positively identify as kitty- or iTerm2-capable.
 */
export function detectProtocol(env: TerminalEnv): Protocol {
  if (isInTmux(env)) return 'ascii';

  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();

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
 * `halfblock` / `ascii`) wins; `auto` (or anything else) defers to
 * {@link detectProtocol}. `halfblock` is opt-in only: auto-detection never
 * picks it.
 */
export function resolveProtocol(override: string, env: TerminalEnv): Protocol {
  if (
    override === 'kitty' ||
    override === 'iterm2' ||
    override === 'sixel' ||
    override === 'halfblock' ||
    override === 'ascii'
  ) {
    return override;
  }
  return detectProtocol(env);
}
