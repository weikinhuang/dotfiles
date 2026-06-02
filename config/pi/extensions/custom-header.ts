/**
 * Single-line header for pi - replaces the default mascot + multi-line
 * keybinding hints with one compact strip:
 *
 *     π pi · escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
 *
 * Rationale: the mascot is cute but eats 8 lines above every new session.
 * On tiled terminals / split panes that's the difference between seeing the
 * first LLM response on screen or having to scroll. A single dim line keeps
 * the discoverability hints without the vertical cost.
 *
 * Uses `ctx.ui.setHeader()` from the extension API; falls back to pi's
 * built-in header when disabled or via the `/header builtin` command.
 *
 * Environment:
 *   PI_CUSTOM_HEADER_DISABLED=1   restore pi's built-in header
 */

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { HEADER_USAGE } from '../../../lib/node/pi/custom-header/usage.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

/**
 * Hint segments shown after the `π pi` brand. Split into `{key, desc}` so
 * we can mirror pi's built-in two-tone palette:
 *   key   → theme.fg('dim',   …)
 *   desc  → theme.fg('muted', …)
 *
 * Same shape as the `rawKeyHint(key, desc)` calls pi uses internally in
 * interactive-mode.js (see the `compactInstructions` block) so the custom
 * header is visually indistinguishable from a hand-rolled pi default.
 *
 * The bindings themselves are hardcoded rather than read from pi's
 * KeybindingsManager on purpose - this header is deliberately static and
 * the user has already committed to vanilla keybinds.
 */
const HINTS: readonly { key: string; desc: string }[] = [
  { key: 'esc', desc: 'interrupt' },
  { key: 'ctrl+c/ctrl+d', desc: 'clear/exit' },
  { key: '/', desc: 'commands' },
  { key: '!', desc: 'bash' },
  { key: 'ctrl+o', desc: 'more' },
];

/** Which header is currently mounted, for the bare `/header` status print. */
type HeaderSource = 'custom' | 'builtin';
let currentSource: HeaderSource = 'custom';

/** Install the compact single-line header strip via `ctx.ui.setHeader`. */
function installCustomHeader(ctx: ExtensionContext): void {
  ctx.ui.setHeader((_tui, theme) => {
    // Match pi's own logo treatment: bold + accent fg.
    const brand = theme.bold(theme.fg('accent', 'π pi'));
    const sep = theme.fg('muted', ' · ');
    // key in dim, description in muted - same split as rawKeyHint() in
    // pi's interactive-mode.js compactInstructions.
    const hints = HINTS.map(({ key, desc }) => `${theme.fg('dim', key)} ${theme.fg('muted', desc)}`).join(sep);
    // Precompute the static string - nothing depends on `width` besides
    // the truncation, so rebuilding per render() call would just burn CPU.
    const line = `${brand}${sep}${hints}`;
    return {
      render(width: number): string[] {
        return [truncateToWidth(line, width)];
      },
      invalidate(): void {
        // no-op: the line is static once composed
      },
    };
  });
  currentSource = 'custom';
}

export default function extension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CUSTOM_HEADER_DISABLED)) return;

  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    installCustomHeader(ctx);
  });

  pi.registerCommand('header', {
    description: 'Switch the session header source (builtin or custom)',
    getArgumentCompletions: (prefix) => {
      const arg = prefix.trim();
      const out: { value: string; label: string; description: string }[] = [];
      if (arg === '' || 'builtin'.startsWith(arg)) {
        out.push({
          value: 'builtin',
          label: 'builtin',
          description: "Restore pi's default mascot + keybinding-hints header",
        });
      }
      if (arg === '' || 'custom'.startsWith(arg)) {
        out.push({ value: 'custom', label: 'custom', description: 'Install the compact single-line header strip' });
      }
      return out.length > 0 ? out : null;
    },
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(HEADER_USAGE, 'info');
        return;
      }
      const verb = (args ?? '').trim().toLowerCase();
      if (verb === '') {
        ctx.ui.notify(`Header source: ${currentSource}`, 'info');
        return;
      }
      if (verb === 'builtin') {
        ctx.ui.setHeader(undefined);
        currentSource = 'builtin';
        ctx.ui.notify('Built-in header restored', 'info');
        return;
      }
      if (verb === 'custom') {
        installCustomHeader(ctx);
        ctx.ui.notify('Custom header installed', 'info');
        return;
      }
      ctx.ui.notify(HEADER_USAGE, 'warning');
    },
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // Release the mounted header so the closure capturing the outgoing
    // ctx/theme isn't left installed across a /reload. The next
    // session_start re-installs a fresh one; on a real exit this just
    // hands the header strip back to pi's built-in renderer.
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setHeader(undefined);
    } catch {
      // best-effort: shutdown must never throw.
    }
  });
}
