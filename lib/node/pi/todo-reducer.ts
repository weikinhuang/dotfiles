/**
 * Pure state types + reducer for the todo extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The reducer's job is to reconstruct todo state from the branch of session
 * entries on session_start / session_tree. Because each tool call emits the
 * full post-action state as both `toolResult.details` AND a mirrored custom
 * entry (`customType: 'todo-state'`), we don't need to replay an action log
 * — we just find the LAST valid snapshot on the branch and use it. That's
 * O(n) with a reverse scan and naturally correct across /fork, /tree, and
 * /compact.
 *
 * The custom-entry mirror exists purely for compaction resilience: pi's
 * `/compact` can summarize old tool-result messages away, but the mirrored
 * custom entry travels alongside and survives. Both shapes are accepted
 * interchangeably.
 *
 * Action handlers (actAdd / actStart / actComplete / …) are pure functions
 * returning either a new state + summary string, or a typed error. They
 * encode the state-transition invariants — especially "at most one todo
 * may be in_progress at a time" — so weaker models trained by `plan-first`
 * get hard feedback instead of silent drift.
 */

import {
  type ActionError,
  type ActionResult as GenericActionResult,
  type ActionSuccess as GenericActionSuccess,
  type BranchEntry as GenericBranchEntry,
  findLatestStateInBranch,
  stateFromEntryGeneric,
} from './branch-state.ts';

export type TodoStatus = 'pending' | 'in_progress' | 'review' | 'completed' | 'blocked';

export interface Todo {
  id: number;
  text: string;
  status: TodoStatus;
  note?: string;
}

export interface TodoState {
  todos: Todo[];
  nextId: number;
}

/** Stable identifiers referenced from both the extension and its tests. */
export const TODO_TOOL_NAME = 'todo';
export const TODO_CUSTOM_TYPE = 'todo-state';

/** Re-exported from `branch-state.ts` so callers (and tests) have a single import path per reducer module. */
export type BranchEntry = GenericBranchEntry;

export function emptyState(): TodoState {
  return { todos: [], nextId: 1 };
}

export function cloneState(s: TodoState): TodoState {
  return { todos: s.todos.map((t) => ({ ...t })), nextId: s.nextId };
}

/**
 * Structural check that `value` is a serialized `TodoState`. Lenient
 * enough to accept state produced by older versions, strict enough that
 * junk in `details` / `data` doesn't accidentally get picked up as state.
 */
export function isTodoStateShape(value: unknown): value is TodoState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.nextId !== 'number' || !Number.isFinite(v.nextId)) return false;
  if (!Array.isArray(v.todos)) return false;
  for (const raw of v.todos) {
    if (!raw || typeof raw !== 'object') return false;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== 'number' || !Number.isFinite(t.id)) return false;
    if (typeof t.text !== 'string') return false;
    if (
      t.status !== 'pending' &&
      t.status !== 'in_progress' &&
      t.status !== 'review' &&
      t.status !== 'completed' &&
      t.status !== 'blocked'
    ) {
      return false;
    }
    if (t.note !== undefined && typeof t.note !== 'string') return false;
  }
  return true;
}

/**
 * Extract a `TodoState` from a single branch entry, or `null` if the
 * entry isn't one of ours (or is malformed).
 */
export function stateFromEntry(entry: BranchEntry): TodoState | null {
  return stateFromEntryGeneric(entry, TODO_TOOL_NAME, TODO_CUSTOM_TYPE, isTodoStateShape, cloneState);
}

/**
 * Walk `branch` from newest to oldest and return the first valid state
 * snapshot found. Returns `emptyState()` if none exists.
 */
export function reduceBranch(branch: readonly BranchEntry[]): TodoState {
  return (
    findLatestStateInBranch(branch, TODO_TOOL_NAME, TODO_CUSTOM_TYPE, isTodoStateShape, cloneState) ?? emptyState()
  );
}

// ──────────────────────────────────────────────────────────────────────
// Action handlers — pure (state, args) -> result. The tool's execute()
// just dispatches to these, then mirrors the resulting state.
// ──────────────────────────────────────────────────────────────────────

export type ActionSuccess = GenericActionSuccess<TodoState>;
export type { ActionError };
export type ActionResult = GenericActionResult<TodoState>;

function findTodo(state: TodoState, id: number): Todo | undefined {
  return state.todos.find((t) => t.id === id);
}
function findActive(state: TodoState): Todo | undefined {
  return state.todos.find((t) => t.status === 'in_progress');
}

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
    case 'pending':
      return ' ';
  }
}

/**
 * Human-readable plaintext dump of the full state. Used as the `content`
 * text returned by every action so the LLM sees the post-action list
 * even without the renderer.
 */
export function formatText(state: TodoState): string {
  if (state.todos.length === 0) return 'No todos';
  return state.todos
    .map((t) => `[${statusMark(t.status)}] #${t.id} ${t.text}${t.note ? ` — ${t.note}` : ''}`)
    .join('\n');
}

export function actList(state: TodoState): ActionResult {
  return { ok: true, state: cloneState(state), summary: formatText(state) };
}

export function actAdd(state: TodoState, text: string | undefined, items: string[] | undefined): ActionResult {
  const texts: string[] = [];
  if (typeof text === 'string' && text.trim()) texts.push(text.trim());
  if (Array.isArray(items)) {
    for (const it of items) {
      if (typeof it === 'string' && it.trim()) texts.push(it.trim());
    }
  }
  if (texts.length === 0) return { ok: false, error: 'add requires `text` or a non-empty `items` array' };

  const next = cloneState(state);
  const added: Todo[] = [];
  for (const t of texts) {
    const todo: Todo = { id: next.nextId++, text: t, status: 'pending' };
    next.todos.push(todo);
    added.push(todo);
  }
  const summary =
    added.length === 1
      ? `Added #${added[0].id}: ${added[0].text}`
      : `Added ${added.length} todos (${added.map((a) => `#${a.id}`).join(', ')})`;
  return { ok: true, state: next, summary };
}

export function actStart(state: TodoState, id: number | undefined): ActionResult {
  if (id === undefined) return { ok: false, error: 'start requires `id`' };
  const next = cloneState(state);
  const todo = findTodo(next, id);
  if (!todo) return { ok: false, error: `#${id} not found` };
  if (todo.status === 'in_progress') return { ok: true, state: next, summary: `#${id} already in_progress` };
  // Serial-focus invariant. Weak models benefit from the hard stop.
  const active = findActive(next);
  if (active && active.id !== id) {
    return {
      ok: false,
      error: `#${active.id} is already in_progress ("${active.text}"). Complete, block, or reopen it first.`,
    };
  }
  todo.status = 'in_progress';
  delete todo.note;
  return { ok: true, state: next, summary: `Started #${id}: ${todo.text}` };
}

export function actComplete(state: TodoState, id: number | undefined, note: string | undefined): ActionResult {
  if (id === undefined) return { ok: false, error: 'complete requires `id`' };
  const next = cloneState(state);
  const todo = findTodo(next, id);
  if (!todo) return { ok: false, error: `#${id} not found` };
  // Completing directly from in_progress requires a note describing what
  // verified the outcome — that's the guardrail against premature "done"
  // claims. Going through `review` first acts as the verification parking
  // step, so completing from review (or any other state) keeps the note
  // optional.
  if (todo.status === 'in_progress' && !note?.trim()) {
    return {
      ok: false,
      error:
        'complete from in_progress requires `note` describing what verified the outcome. Alternatively, move the item to `review` first (action "review") and complete from there.',
    };
  }
  todo.status = 'completed';
  if (note?.trim()) todo.note = note.trim();
  else delete todo.note;
  return { ok: true, state: next, summary: `Completed #${id}: ${todo.text}` };
}

export function actBlock(state: TodoState, id: number | undefined, note: string | undefined): ActionResult {
  if (id === undefined) return { ok: false, error: 'block requires `id`' };
  if (!note?.trim()) return { ok: false, error: 'block requires `note` (reason the task is blocked)' };
  const next = cloneState(state);
  const todo = findTodo(next, id);
  if (!todo) return { ok: false, error: `#${id} not found` };
  todo.status = 'blocked';
  todo.note = note.trim();
  return { ok: true, state: next, summary: `Blocked #${id}: ${todo.text} — ${todo.note}` };
}

/**
 * Move an item into the `review` column: work is done, verification is
 * pending. Only `in_progress` items can enter review — weaker models try
 * to "review" unstarted items otherwise, which defeats the purpose.
 *
 * WIP=1 on review (independent of WIP=1 on in_progress): you can have
 * one item being worked on and one awaiting verification simultaneously,
 * which matches kanban conventions, but you can't pile multiple items
 * into review without resolving them.
 */
export function actReview(state: TodoState, id: number | undefined, note: string | undefined): ActionResult {
  if (id === undefined) return { ok: false, error: 'review requires `id`' };
  const next = cloneState(state);
  const todo = findTodo(next, id);
  if (!todo) return { ok: false, error: `#${id} not found` };
  if (todo.status === 'review') {
    // Idempotent: allow updating the note on an already-review item.
    if (note?.trim()) todo.note = note.trim();
    else delete todo.note;
    return { ok: true, state: next, summary: `#${id} already in review` };
  }
  if (todo.status !== 'in_progress') {
    return {
      ok: false,
      error: `#${id} is ${todo.status}; only in_progress items can move to review. Use action "start" first.`,
    };
  }
  const inReview = next.todos.find((t) => t.status === 'review');
  if (inReview && inReview.id !== id) {
    return {
      ok: false,
      error: `#${inReview.id} is already in review ("${inReview.text}"). Complete, reopen, or block it before moving another item to review.`,
    };
  }
  todo.status = 'review';
  if (note?.trim()) todo.note = note.trim();
  else delete todo.note;
  return { ok: true, state: next, summary: `Moved #${id} to review: ${todo.text}` };
}

export function actReopen(state: TodoState, id: number | undefined): ActionResult {
  if (id === undefined) return { ok: false, error: 'reopen requires `id`' };
  const next = cloneState(state);
  const todo = findTodo(next, id);
  if (!todo) return { ok: false, error: `#${id} not found` };
  todo.status = 'pending';
  delete todo.note;
  return { ok: true, state: next, summary: `Reopened #${id}: ${todo.text}` };
}

export function actClear(state: TodoState): ActionResult {
  const count = state.todos.length;
  return {
    ok: true,
    state: emptyState(),
    summary: count > 0 ? `Cleared ${count} todos` : 'Nothing to clear',
  };
}
