/**
 * Pretty-print + grouping helpers for the todo extension.
 *
 * Split out of `todo-reducer.ts` so the reducer file is just state +
 * branch reduction + action helpers. The renderers live here and are
 * unit-testable independently. Same pi-free contract as the reducer.
 */

import { type Todo, type TodoState, type TodoStatus } from './todo-reducer.ts';

function statusMark(s: TodoStatus): string {
  switch (s) {
    case 'completed':
      return 'x';
    case 'in_progress':
      return '*';
    case 'review':
      return '?';
    case 'blocked':
      return '!';
    case 'cancelled':
      return '-';
    case 'pending':
      return ' ';
  }
}

/**
 * Glyph rendered next to each todo in TUI / overlay output. Kept here
 * (alongside the plaintext `statusMark` used by `formatText`) so the
 * extension shell and the overlay share one source of truth for the
 * symbol set.
 */
export function statusGlyph(s: TodoStatus): string {
  switch (s) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '→';
    case 'review':
      return '⋯';
    case 'blocked':
      return '⛔';
    case 'cancelled':
      return '⊘';
    case 'pending':
      return '○';
  }
}

/**
 * Default `<from> → <to>` glyph pair for an action's status transition.
 * `renderCall` runs before `execute` and only has the tool args, so the
 * "from" side is a sensible per-action default rather than the actual
 * previous status (the inline card is a hint, not an audit trail).
 *
 * Returns `null` for actions that don't model a single-item status
 * transition (`add`, `list`, `clear`).
 */
export function transitionGlyphs(action: string): { from: string; to: string } | null {
  switch (action) {
    case 'start':
      return { from: '○', to: '→' };
    case 'review':
      return { from: '→', to: '⋯' };
    case 'complete':
      return { from: '⋯', to: '✓' };
    case 'block':
      return { from: '○', to: '⛔' };
    case 'cancel':
      return { from: '○', to: '⊘' };
    case 'reopen':
      return { from: '✓', to: '○' };
    default:
      return null;
  }
}

/**
 * Bucket the state's todos into the six status groups in the fixed
 * display order used by the overlay and grouped `renderResult`. Each
 * bucket preserves the original todo order from `state.todos`.
 */
export interface TodoGroups {
  in_progress: Todo[];
  review: Todo[];
  pending: Todo[];
  blocked: Todo[];
  cancelled: Todo[];
  completed: Todo[];
}

export function groupTodos(state: TodoState): TodoGroups {
  const groups: TodoGroups = {
    in_progress: [],
    review: [],
    pending: [],
    blocked: [],
    cancelled: [],
    completed: [],
  };
  for (const t of state.todos) groups[t.status].push({ ...t });
  return groups;
}

export interface FormatProgressOptions {
  /** Total cells in the bar. Default 8. Floored to 1. */
  width?: number;
}

export interface FormatProgressResult {
  /** `▰` filled + `▱` empty train, exactly `width` cells. */
  bar: string;
  /** Integer percentage 0-100; 0 when state is empty. */
  pct: number;
  /** Count-chip line; non-zero buckets only, joined by ` · `. */
  summary: string;
}

/**
 * Pure formatter for the overlay / renderResult progress chip line.
 * `pct` is `completed / total` (cancelled items count in the
 * denominator: they were planned, then closed out without being done).
 * The summary chip line surfaces every non-zero non-completed bucket
 * so closed-but-not-done items stay visible.
 */
export function formatTodoProgress(state: TodoState, opts: FormatProgressOptions = {}): FormatProgressResult {
  const width = Math.max(1, Math.floor(opts.width ?? 8));
  const total = state.todos.length;
  const counts = {
    pending: 0,
    in_progress: 0,
    review: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const t of state.todos) counts[t.status]++;
  const pct = total === 0 ? 0 : Math.round((counts.completed / total) * 100);
  // Round-half-up via Math.round for the bar so the cell count tracks
  // the percentage chip; the 30%/8-cell case in plans/pi-todo-overlay.md
  // mock shows 3 cells (ceil of 2.4) but we lock to Math.round so 0%
  // stays at 0 cells and 100% stays at `width` cells.
  const filled = total === 0 ? 0 : Math.min(width, Math.max(0, Math.round((counts.completed / total) * width)));
  const bar = '▰'.repeat(filled) + '▱'.repeat(width - filled);
  const chips: string[] = [];
  if (counts.in_progress) chips.push(`${counts.in_progress} active`);
  if (counts.review) chips.push(`${counts.review} review`);
  if (counts.pending) chips.push(`${counts.pending} pending`);
  if (counts.blocked) chips.push(`${counts.blocked} blocked`);
  if (counts.cancelled) chips.push(`${counts.cancelled} cancelled`);
  return { bar, pct, summary: chips.join(' · ') };
}

/**
 * Human-readable plaintext dump of the full state. Used as the `content`
 * text returned by every action so the LLM sees the post-action list
 * even without the renderer.
 */
export function formatText(state: TodoState): string {
  if (state.todos.length === 0) return 'No todos';
  return state.todos
    .map((t) => `[${statusMark(t.status)}] #${t.id} ${t.text}${t.note ? ` - ${t.note}` : ''}`)
    .join('\n');
}
