/**
 * Interactive "uncheck the keeper" multi-select prompt for the agent
 * drop / collapse tools (`drop_image`, `collapse_output`). Shared by both
 * extensions, so it lives under `lib/node/pi/ext/` (the home for pi-coupled
 * UI glue) rather than the pure `lib/node/pi/` tree.
 *
 * It mounts the reusable {@link MultiSelectList} component (Section R) via
 * `showModal` with every row pre-checked: a checked row WILL be
 * dropped, so the human unchecks the one item they want to keep before
 * confirming. Returns the indices left checked (the final drop set), or
 * `undefined` when the human cancels (Esc) - the caller then treats the
 * whole action as denied.
 *
 * The selection math + rendering live in the pure
 * `MultiSelectList`; this module owns only the key handling and the
 * modal lifecycle and bounded viewport.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import { type MultiSelectItem, MultiSelectList } from './multi-select-list.ts';
import { assembleWindowedBody, overlayViewportRows } from './overlay-window.ts';
import { showModal } from './show-modal.ts';

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

  return showModal<number[] | undefined>(ctx.ui, (tui, theme, _kb, done) => {
    const list = new MultiSelectList(options.items, { initialSelected: initial });
    let cached: string[] | undefined;
    let cachedWidth = 0;
    let cachedRows = 0;
    let scrollTop = 0;

    const refresh = (): void => {
      cached = undefined;
      tui.requestRender();
    };

    const titleLines = options.title.split('\n');

    return {
      render(width: number): string[] {
        const terminalRows = tui.terminal.rows;
        width = Math.max(1, width);
        if (cached && cachedWidth === width && cachedRows === terminalRows) return cached;
        const header = titleLines.map((t) => truncateToWidth(theme.fg('text', t), width));
        header.push('');
        const body: string[] = [];
        let keepStart = 0;
        let keepEnd = 0;
        for (let i = 0; i < list.length; i++) {
          const start = body.length;
          // Render without truncation first so descriptions and labels reflow
          // into actual terminal rows before computing the cursor's range.
          const rows = list.renderRow(i, { width: Number.MAX_SAFE_INTEGER, theme, highlighted: i === list.cursor });
          for (const row of rows) body.push(...wrapTextWithAnsi(row, width));
          if (i === list.cursor) {
            keepStart = start;
            keepEnd = body.length;
          }
        }
        const footer = [
          '',
          truncateToWidth(
            theme.fg('dim', ' ↑↓ navigate · 1-9 jump · Space toggle · Enter confirm · Esc cancel'),
            width,
          ),
        ];
        const window = assembleWindowedBody({
          header,
          body,
          footer,
          width,
          viewportRows: overlayViewportRows(terminalRows),
          scrollTop,
          theme,
          keepStart,
          keepEnd,
        });
        scrollTop = window.scrollTop;
        cachedWidth = width;
        cachedRows = terminalRows;
        cached = window.lines;
        return cached;
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
