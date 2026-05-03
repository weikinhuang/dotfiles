/**
 * Titlebar spinner for pi.
 *
 * Terminal title is always `<indicator> - <cwd basename>`, where
 * `<indicator>` is an animated braille frame while an agent turn is
 * running and a static `π` glyph while pi is idle. This mirrors the
 * behaviour of most coding-tool TUIs (Claude Code, Aider) so the tab
 * is glanceable in tiled window managers / tmux.
 *
 * Forked from examples/extensions/titlebar-spinner.ts with two changes:
 *   1. Idle title shows `π - <cwd>` instead of dropping the indicator.
 *   2. Session name is deliberately omitted — for most of this user's
 *      sessions it's noise, and the cwd basename is the more reliable
 *      "which project am I in" signal.
 *
 * Limitations:
 *   - cwd is re-read on each tick while the spinner runs, but pi does not
 *     emit a cwd-change event, so when idle the title only refreshes on
 *     the next agent_start / agent_end boundary. Good enough — the cwd
 *     rarely changes mid-session and the statusline footer always shows
 *     the live value.
 *
 * Environment:
 *   PI_TITLEBAR_SPINNER_DISABLED=1   leave pi's default title untouched
 */

import { basename } from 'node:path';

import { type ExtensionAPI, type ExtensionContext } from '@mariozechner/pi-coding-agent';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const IDLE_GLYPH = 'π';
const FRAME_INTERVAL_MS = 80;

function idleTitle(): string {
  return `${IDLE_GLYPH} - ${basename(process.cwd())}`;
}

export default function extension(pi: ExtensionAPI): void {
  if (process.env.PI_TITLEBAR_SPINNER_DISABLED === '1') return;

  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;

  function stopAnimation(ctx: ExtensionContext): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    frameIndex = 0;
    ctx.ui.setTitle(idleTitle());
  }

  function startAnimation(ctx: ExtensionContext): void {
    // Clear any stale timer before installing a new one — belt-and-braces
    // in case agent_end didn't fire (e.g. a future pi bug or reload-runtime).
    if (timer) clearInterval(timer);
    frameIndex = 0;
    timer = setInterval(() => {
      const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
      ctx.ui.setTitle(`${frame} - ${basename(process.cwd())}`);
      frameIndex++;
    }, FRAME_INTERVAL_MS);
  }

  pi.on('session_start', async (_event, ctx) => {
    // Seed the idle title immediately so the tab shows `π - <cwd>` before
    // the first turn, not whatever the shell set on launch.
    ctx.ui.setTitle(idleTitle());
  });

  pi.on('agent_start', async (_event, ctx) => {
    startAnimation(ctx);
  });

  pi.on('agent_end', async (_event, ctx) => {
    stopAnimation(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    stopAnimation(ctx);
  });
}
