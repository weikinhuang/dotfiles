/**
 * Single-line header for pi — replaces the default mascot + multi-line
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
 * built-in header when disabled or via the `/builtin-header` command.
 *
 * Environment:
 *   PI_CUSTOM_HEADER_DISABLED=1   restore pi's built-in header
 */

import { type ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { truncateToWidth } from '@mariozechner/pi-tui';

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
 * KeybindingsManager on purpose — this header is deliberately static and
 * the user has already committed to vanilla keybinds.
 */
const HINTS: readonly { key: string; desc: string }[] = [
  { key: 'esc', desc: 'interrupt' },
  { key: 'ctrl+c/ctrl+d', desc: 'clear/exit' },
  { key: '/', desc: 'commands' },
  { key: '!', desc: 'bash' },
  { key: 'ctrl+o', desc: 'more' },
];

export default function extension(pi: ExtensionAPI): void {
  if (process.env.PI_CUSTOM_HEADER_DISABLED === '1') return;

  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setHeader((_tui, theme) => {
      // Match pi's own logo treatment: bold + accent fg.
      const brand = theme.bold(theme.fg('accent', 'π pi'));
      const sep = theme.fg('muted', ' · ');
      // key in dim, description in muted — same split as rawKeyHint() in
      // pi's interactive-mode.js compactInstructions.
      const hints = HINTS.map(({ key, desc }) => `${theme.fg('dim', key)} ${theme.fg('muted', desc)}`).join(sep);
      // Precompute the static string — nothing depends on `width` besides
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
  });

  pi.registerCommand('builtin-header', {
    description: "Restore pi's default mascot + keybinding-hints header",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify('Built-in header restored', 'info');
    },
  });
}
