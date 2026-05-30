/**
 * tmux DCS passthrough helpers for the `avatar` extension.
 *
 * tmux multiplexes a single outer terminal across many panes, intercepting
 * escape sequences for its own state-tracking. Sequences it doesn't
 * understand (kitty graphics APC, iTerm2 OSC 1337, sixel DCS) get dropped
 * unless the user opts into DCS passthrough: wrap the payload in
 * `\x1bPtmux;<doubled-inner-escapes>\x1b\\` and tmux strips the envelope
 * and forwards the unwrapped payload to the outer terminal verbatim.
 *
 * Requires `set -g allow-passthrough on` in tmux (>= 3.3). Only the image
 * payload itself gets wrapped: CSI cursor controls (`\x1b[nA` etc.) and
 * DEC private save/restore (`\x1b7`/`\x1b8`) are tmux-native and must NOT
 * be wrapped or tmux's own cursor tracking breaks.
 *
 * Pure module - unit-testable, no pi imports.
 */

const ESC = '\x1b';

/** The subset of `process.env` the tmux detector reads. */
export interface TmuxEnv {
  TMUX?: string;
  TERM?: string;
}

/**
 * Is the current process running inside tmux or GNU screen? Mirrors the
 * check in {@link import('./terminal.ts').detectProtocol} so the renderer
 * and the detector agree on what counts as "in a multiplexer".
 */
export function isInTmux(env: TmuxEnv): boolean {
  if ((env.TMUX ?? '').length > 0) return true;
  const term = (env.TERM ?? '').toLowerCase();
  return term.startsWith('tmux') || term.startsWith('screen');
}

/**
 * Wrap `sequence` in tmux's DCS passthrough envelope:
 * `\x1bPtmux;<sequence-with-doubled-ESCs>\x1b\\`. Every `\x1b` inside the
 * sequence is replaced with `\x1b\x1b` so tmux's own DCS parser doesn't
 * terminate on the first inner `\x1b\\`.
 *
 * The wrapper itself uses two raw `\x1b`s (the leading `\x1bP` and the
 * trailing `\x1b\\`) that tmux consumes; only the inner content reaches
 * the outer terminal, with the doubled escapes halved back.
 *
 * Convenient side-effect for pi-tui's `isImageLine()`: it does a substring
 * `includes('\x1b_G')` / `includes('\x1b]1337;File=')` check, and the
 * doubled-ESC encoding preserves those substrings (`\x1b\x1b_G` still
 * contains `\x1b_G`), so wrapped kitty / iTerm2 lines are still exempted
 * from the width guard. Wrapped sixel lines do not contain either marker
 * and still need the separate `SIXEL_IMAGE_LINE_MARKER` prepended.
 */
export function wrapForTmux(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ESC}\\`;
}
