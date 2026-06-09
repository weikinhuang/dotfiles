/**
 * Pure grid math for the `/context` treemap. Given an ordered list of child
 * token sizes and the capacity the grid represents, assign each of the
 * `rows * cols` cells to a child (a colored `⛁`), the single used/free
 * boundary cell (`⛀`), or free space (`⛶`).
 *
 * Re-scoping is the caller's job: at the root, `capacity` is the whole
 * context window (so the tail is free); when drilled into a node, the caller
 * passes `capacity = node.tokens` (== Σ children) so the grid fills entirely.
 *
 * No pi imports.
 */

export interface GridCell {
  kind: 'used' | 'partial' | 'free';
  /** Index into the children array for `used` / `partial`; null for `free`. */
  childIndex: number | null;
}

export interface GridDims {
  rows: number;
  cols: number;
}

export const DEFAULT_GRID: GridDims = { rows: 10, cols: 10 };

/**
 * Build the flat cell array (row-major, length `rows*cols`).
 *
 * Algorithm: each cell `i` spans the token interval
 * `[i*tpc, (i+1)*tpc)` where `tpc = capacity / cellCount`. `used` is the sum
 * of child tokens (clamped to capacity). A cell is:
 *   - `free`    when its whole span sits at/after `used`,
 *   - `partial` when its span straddles the `used` boundary,
 *   - `used`    otherwise; its `childIndex` is the child whose cumulative
 *               token range contains the cell midpoint.
 *
 * Children that round to zero cells simply paint nothing - they still belong
 * in the legend (caller keeps them); the grid is a visual approximation.
 */
export function buildGrid(childTokens: readonly number[], capacity: number, dims: GridDims = DEFAULT_GRID): GridCell[] {
  const cellCount = Math.max(0, dims.rows * dims.cols);
  const cells: GridCell[] = [];
  if (cellCount === 0) return cells;

  const safeCapacity = capacity > 0 && Number.isFinite(capacity) ? capacity : 0;
  const tpc = safeCapacity > 0 ? safeCapacity / cellCount : 0;

  // Cumulative child boundaries for midpoint lookup.
  const bounds: number[] = [0];
  let used = 0;
  for (const t of childTokens) {
    used += Math.max(0, t);
    bounds.push(used);
  }
  if (safeCapacity > 0) used = Math.min(used, safeCapacity);

  const childAt = (token: number): number | null => {
    if (childTokens.length === 0) return null;
    for (let k = 0; k < childTokens.length; k++) {
      if (token < bounds[k + 1]) return k;
    }
    return childTokens.length - 1;
  };

  for (let i = 0; i < cellCount; i++) {
    if (tpc === 0) {
      cells.push({ kind: 'free', childIndex: null });
      continue;
    }
    const start = i * tpc;
    const end = (i + 1) * tpc;
    if (start >= used) {
      cells.push({ kind: 'free', childIndex: null });
    } else if (end > used) {
      // straddles the used/free boundary
      cells.push({ kind: 'partial', childIndex: childAt(Math.min(start, used - 1e-9)) });
    } else {
      const mid = start + tpc / 2;
      cells.push({ kind: 'used', childIndex: childAt(mid) });
    }
  }
  return cells;
}

/** Split a flat cell array into rows for rendering. */
export function chunkRows(cells: readonly GridCell[], cols: number): GridCell[][] {
  const rows: GridCell[][] = [];
  for (let i = 0; i < cells.length; i += cols) {
    rows.push(cells.slice(i, i + cols));
  }
  return rows;
}
