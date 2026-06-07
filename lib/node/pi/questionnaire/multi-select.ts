/**
 * Pure selection-state helpers for the reusable MultiSelectList component
 * (lib/node/pi/ext/multi-select-list.ts) and the questionnaire extension.
 *
 * No pi-tui / pi runtime imports: the checkbox working-set math, cursor
 * clamping, and digit-jump mapping live here so they can be unit-tested
 * directly, while the component owns the pi-tui rendering and the
 * questionnaire owns the surrounding tab / notes / preview flow.
 */

/** Clamp a cursor index into `[0, count - 1]`; returns 0 for an empty list. */
export function clampCursor(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index > count - 1) return count - 1;
  return index;
}

/**
 * Map a 1-based digit key (`1`-`9`) to a 0-based cursor index, clamped to the
 * last row. Returns `null` when `digit` is outside `1`-`9` or the list is
 * empty, so callers can leave the cursor untouched.
 */
export function digitToCursor(digit: number, count: number): number | null {
  if (count <= 0) return null;
  if (!Number.isInteger(digit) || digit < 1 || digit > 9) return null;
  return Math.min(digit - 1, count - 1);
}

/** Outcome of a {@link toggleSelection} call. */
export type ToggleResult = 'added' | 'removed' | 'blocked';

/**
 * Toggle membership of `index` in `set`, honoring `maxSelect`. Mutates `set`
 * and returns `'added'` / `'removed'`, or `'blocked'` when adding a new index
 * would exceed `maxSelect` (the set is left unchanged in that case).
 */
export function toggleSelection(set: Set<number>, index: number, maxSelect?: number): ToggleResult {
  if (set.has(index)) {
    set.delete(index);
    return 'removed';
  }
  if (maxSelect !== undefined && set.size >= maxSelect) {
    return 'blocked';
  }
  set.add(index);
  return 'added';
}

/** True when a working set of size `size` satisfies `minSelect` (default 0). */
export function meetsMinSelect(size: number, minSelect?: number): boolean {
  return size >= (minSelect ?? 0);
}

/** Ascending-sorted copy of a selection set. */
export function sortedSelection(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b);
}
