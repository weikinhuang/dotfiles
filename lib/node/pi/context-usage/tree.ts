/**
 * Pure navigation state for the `/context` drill-down. Operates on the
 * `CategoryNode` treemap from `estimate.ts`. No pi imports.
 *
 * `path` holds the child indices drilled into from the root; `sel` is the
 * highlighted child index at the current node. Entering a node with children
 * pushes the current `sel` onto `path`; going back pops it and restores `sel`
 * to where you drilled from.
 */

import type { CategoryNode } from './types.ts';

export interface NavState {
  path: number[];
  sel: number;
}

export function initNav(): NavState {
  return { path: [], sel: 0 };
}

/** Walk from root following `path`; returns the node at that path (or root). */
export function resolveNode(root: CategoryNode, path: readonly number[]): CategoryNode {
  let node = root;
  for (const idx of path) {
    const next = node.children?.[idx];
    if (!next) break;
    node = next;
  }
  return node;
}

export function currentNode(root: CategoryNode, state: NavState): CategoryNode {
  return resolveNode(root, state.path);
}

export function currentChildren(root: CategoryNode, state: NavState): CategoryNode[] {
  return currentNode(root, state).children ?? [];
}

export function atRoot(state: NavState): boolean {
  return state.path.length === 0;
}

/** Clamp-move the selection by `delta`. */
export function move(state: NavState, delta: number, childCount: number): NavState {
  if (childCount <= 0) return { ...state, sel: 0 };
  const sel = Math.max(0, Math.min(childCount - 1, state.sel + delta));
  return { ...state, sel };
}

/** Set selection to an absolute index (clamped). */
export function select(state: NavState, index: number, childCount: number): NavState {
  if (childCount <= 0) return { ...state, sel: 0 };
  return { ...state, sel: Math.max(0, Math.min(childCount - 1, index)) };
}

/**
 * Drill into the selected child if it has children. Returns the same state
 * (unchanged) for leaves, so the caller can treat a no-op enter as "nothing
 * to drill".
 */
export function enter(root: CategoryNode, state: NavState): NavState {
  const node = currentNode(root, state);
  const child = node.children?.[state.sel];
  if (child?.children && child.children.length > 0) {
    return { path: [...state.path, state.sel], sel: 0 };
  }
  return state;
}

/**
 * Pop one level. Returns the same state at the root (caller closes the
 * overlay on a no-op back at root).
 */
export function back(state: NavState): NavState {
  if (state.path.length === 0) return state;
  const lastIdx = state.path[state.path.length - 1];
  return { path: state.path.slice(0, -1), sel: lastIdx };
}

/** Labels from root's children down to (but excluding) the current node. */
export function breadcrumbLabels(root: CategoryNode, path: readonly number[]): string[] {
  const labels: string[] = [];
  let node = root;
  for (const idx of path) {
    const next = node.children?.[idx];
    if (!next) break;
    labels.push(next.label);
    node = next;
  }
  return labels;
}
