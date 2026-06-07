/**
 * Interactive "uncheck the keeper" multi-select prompt for the agent
 * drop / collapse tools (`drop_image`, `collapse_output`). Shared by both
 * extensions, so it lives under `lib/node/pi/ext/` (the home for pi-coupled
 * UI glue) rather than the pure `lib/node/pi/` tree.
 *
 * It mounts the reusable {@link MultiSelectList} component (Section R) via
 * `ctx.ui.custom` with every row pre-checked: a checked row WILL be
 * dropped, so the human unchecks the one item they want to keep before
 * confirming. Returns the indices left checked (the final drop set), or
 * `undefined` when the human cancels (Esc) - the caller then treats the
 * whole action as denied.
 *
 * The selection math + rendering live in the pure
 * `MultiSelectList`; this module owns only the key handling and the
 * `ctx.ui.custom` lifecycle.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

import { type MultiSelectItem, MultiSelectList } from './multi-select-list.ts';

export interface MultiSelectPromptOptions {
  /** Dialog heading lines (rendered above the checkbox list). */
  title: string;
  /** The rows to choose among. */
  items: MultiSelectItem[];
  /**
   * Indices checked when the dialog opens. Defaults to ALL rows checked
   * (uncheck-the-keeper semantics). Pass an explicit list to override.
   */
  initialSelected?: Iterable<number>;
}

function digitFromKey(data: string): number | null {
  if (data.length === 1 && data >= '1' && data <= '9') return data.charCodeAt(0) - 48;
  return null;
}

/**
 * Mount the checkbox picker and resolve to the indices left CHECKED (the
 * drop set), or `undefined` when cancelled. In a non-interactive context
 * (`ctx.hasUI` false) there is no dialog to mount, so this returns
 * `undefined` and the caller falls back to its env default.
 */
export async function promptMultiSelect(
  ctx: ExtensionContext,
  options: MultiSelectPromptOptions,
): Promise<number[] | undefined> {
  if (!ctx.hasUI) return undefined;
  const initial = options.initialSelected ?? options.items.map((_, i) => i);

  return ctx.ui.custom<number[] | undefined>((tui, theme, _kb, done) => {
    const list = new MultiSelectList(options.items, { initialSelected: initial });
    let cached: string[] | undefined;

    const refresh = (): void => {
      cached = undefined;
      tui.requestRender();
    };

    const titleLines = options.title.split('\n');

    return {
      render(width: number): string[] {
        if (cached) return cached;
        const lines: string[] = [];
        for (const t of titleLines) lines.push(truncateToWidth(theme.fg('text', t), width));
        lines.push('');
        lines.push(...list.render({ width, theme }));
        lines.push('');
        lines.push(
          truncateToWidth(
            theme.fg('dim', ' ↑↓ navigate · 1-9 jump · Space toggle · Enter confirm · Esc cancel'),
            width,
          ),
        );
        cached = lines;
        return lines;
      },
      invalidate(): void {
        cached = undefined;
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
          done(undefined);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          done(list.selectedIndices());
          return;
        }
        if (matchesKey(data, Key.up)) {
          list.moveUp();
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          list.moveDown();
          refresh();
          return;
        }
        if (matchesKey(data, Key.space)) {
          list.toggleAtCursor();
          refresh();
          return;
        }
        const digit = digitFromKey(data);
        if (digit !== null && list.jumpToDigit(digit)) {
          refresh();
        }
      },
    };
  });
}
