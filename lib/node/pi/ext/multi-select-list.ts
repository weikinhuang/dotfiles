/**
 * Reusable multi-select (checkbox) picker component for pi extensions.
 *
 * Lives under `lib/node/pi/ext/` rather than the pure `lib/node/pi/` tree
 * because it imports `@earendil-works/pi-tui` (`truncateToWidth`) - the
 * directory is the home for shared pi-coupled UI glue. The pure selection
 * math (working-set toggling, cursor clamping, digit-jump mapping) lives in
 * the pi-free `lib/node/pi/questionnaire/multi-select.ts` so it can be
 * unit-tested without a TUI.
 *
 * The component bundles the three pieces the questionnaire extension used to
 * inline:
 *
 *   1. a checkbox working-set with `minSelect` / `maxSelect` enforcement,
 *   2. cursor navigation + `1`-`9` digit jump, and
 *   3. `[x]` / `[ ]` row rendering.
 *
 * It holds no cross-extension state: every consumer constructs its own
 * instance, so two extensions (each on its own jiti instance) mounting the
 * same picker never share a working set.
 *
 * Standalone consumers (e.g. a "drop these items" tool) can drive the
 * component's own `cursor` via `moveUp` / `moveDown` / `jumpToDigit` and
 * render the whole list with `render`. Hosts that own a larger, heterogeneous
 * row list (the questionnaire interleaves `Type something.` + `Next` rows)
 * keep their own cursor and render individual checkbox rows with `renderRow`.
 */

import { truncateToWidth } from '@earendil-works/pi-tui';

import {
  clampCursor,
  digitToCursor,
  meetsMinSelect,
  sortedSelection,
  toggleSelection,
  type ToggleResult,
} from '../questionnaire/multi-select.ts';

export type { ToggleResult };

/** A single checkbox row. */
export interface MultiSelectItem {
  label: string;
  /** Optional muted sub-line rendered below the label. */
  description?: string;
}

export interface MultiSelectListConfig {
  /** Minimum boxes that must be checked before the list "commits". */
  minSelect?: number;
  /** Maximum boxes that may be checked; further additions are blocked. */
  maxSelect?: number;
  /** Indices checked when the component is constructed. */
  initialSelected?: Iterable<number>;
}

/**
 * Minimal theme surface the component needs. Structurally satisfied by pi's
 * `Theme` (its `fg(color, text)` method), so callers pass the theme straight
 * through without an adapter; using a structural type keeps the component
 * free of a `@earendil-works/pi-coding-agent` import.
 */
export interface MultiSelectThemeLike {
  fg(color: string, text: string): string;
}

export interface MultiSelectRenderStyle {
  /** Theme color token for the highlighted row. Default `'accent'`. */
  selectedColor?: string;
  /** Theme color token for non-highlighted rows. Default `'text'`. */
  unselectedColor?: string;
  /** Theme color token for the description sub-line. Default `'muted'`. */
  descriptionColor?: string;
  /** Prefix drawn before the highlighted row (themed `selectedColor`). Default `'❯ '`. */
  cursorPrefix?: string;
  /** Prefix drawn before non-highlighted rows. Default `'  '`. */
  blankPrefix?: string;
}

export interface MultiSelectRenderRowOptions extends MultiSelectRenderStyle {
  width: number;
  highlighted: boolean;
  theme: MultiSelectThemeLike;
}

export interface MultiSelectRenderOptions extends MultiSelectRenderStyle {
  width: number;
  theme: MultiSelectThemeLike;
  /**
   * Index of the highlighted row. Defaults to the component's own `cursor`;
   * pass an explicit value (or `-1` for none) when the host owns the cursor.
   */
  highlight?: number;
}

const DEFAULT_STYLE = {
  selectedColor: 'accent',
  unselectedColor: 'text',
  descriptionColor: 'muted',
  cursorPrefix: '❯ ',
  blankPrefix: '  ',
} as const;

export class MultiSelectList {
  /** Self-managed cursor for standalone mounts; hosts may ignore it. */
  cursor = 0;

  private readonly selected = new Set<number>();

  constructor(
    readonly items: readonly MultiSelectItem[],
    private readonly config: MultiSelectListConfig = {},
  ) {
    if (config.initialSelected) {
      for (const i of config.initialSelected) {
        if (i >= 0 && i < items.length) this.selected.add(i);
      }
    }
  }

  /** Number of checkbox rows. */
  get length(): number {
    return this.items.length;
  }

  // ─── Working set ──────────────────────────────────────────────────────

  isSelected(index: number): boolean {
    return this.selected.has(index);
  }

  /** Ascending-sorted selected indices (0-based). */
  selectedIndices(): number[] {
    return sortedSelection(this.selected);
  }

  selectedCount(): number {
    return this.selected.size;
  }

  /** True once at least `minSelect` boxes are checked. */
  meetsMinSelect(): boolean {
    return meetsMinSelect(this.selected.size, this.config.minSelect);
  }

  /** Toggle the checkbox at `index`, honoring `maxSelect`. */
  toggle(index: number): ToggleResult {
    return toggleSelection(this.selected, index, this.config.maxSelect);
  }

  /** Toggle the checkbox under the component's own cursor. */
  toggleAtCursor(): ToggleResult {
    return this.toggle(this.cursor);
  }

  // ─── Cursor (standalone consumers) ────────────────────────────────────

  moveUp(): void {
    this.cursor = clampCursor(this.cursor - 1, this.items.length);
  }

  moveDown(): void {
    this.cursor = clampCursor(this.cursor + 1, this.items.length);
  }

  /**
   * Jump the cursor to the row for a 1-based `digit` key. Returns `true` when
   * the cursor moved, `false` when the digit was out of range / list empty.
   */
  jumpToDigit(digit: number): boolean {
    const next = digitToCursor(digit, this.items.length);
    if (next === null) return false;
    this.cursor = next;
    return true;
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  /** Render a single checkbox row (+ optional description line). */
  renderRow(index: number, opts: MultiSelectRenderRowOptions): string[] {
    const item = this.items[index];
    if (!item) return [];
    const selectedColor = opts.selectedColor ?? DEFAULT_STYLE.selectedColor;
    const unselectedColor = opts.unselectedColor ?? DEFAULT_STYLE.unselectedColor;
    const descriptionColor = opts.descriptionColor ?? DEFAULT_STYLE.descriptionColor;
    const cursorPrefix = opts.cursorPrefix ?? DEFAULT_STYLE.cursorPrefix;
    const blankPrefix = opts.blankPrefix ?? DEFAULT_STYLE.blankPrefix;

    const prefix = opts.highlighted ? opts.theme.fg(selectedColor, cursorPrefix) : blankPrefix;
    const color = opts.highlighted ? selectedColor : unselectedColor;
    const checked = this.selected.has(index) ? 'x' : ' ';
    const labelText = `${index + 1}. [${checked}] ${item.label}`;

    const lines = [truncateToWidth(prefix + opts.theme.fg(color, labelText), opts.width)];
    if (item.description) {
      lines.push(truncateToWidth(`     ${opts.theme.fg(descriptionColor, item.description)}`, opts.width));
    }
    return lines;
  }

  /** Render every checkbox row, highlighting `highlight` (default `cursor`). */
  render(opts: MultiSelectRenderOptions): string[] {
    const highlight = opts.highlight ?? this.cursor;
    const out: string[] = [];
    for (let i = 0; i < this.items.length; i++) {
      out.push(...this.renderRow(i, { ...opts, highlighted: i === highlight }));
    }
    return out;
  }
}
