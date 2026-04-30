/**
 * Pure state types + reducer for the scratchpad extension.
 *
 * No pi imports so this module can be unit-tested under `vitest`
 * without the pi runtime.
 *
 * The scratchpad is the unstructured counterpart to the todo extension:
 * where `todo` holds a typed plan, the scratchpad holds free-form working
 * notes — decisions the model made, file paths it keeps losing, test
 * commands it wants to re-run, TODOs the user asked about in passing.
 *
 * State persistence mirrors `todo-reducer.ts`:
 *   - Each successful tool call emits the full post-action state as
 *     `toolResult.details` AND a mirrored `customType: 'scratchpad-state'`
 *     session entry.
 *   - The reducer walks the branch newest-to-oldest and picks the first
 *     valid snapshot.
 *   - Both sources are accepted interchangeably, so /fork, /tree, and
 *     /compact all keep working without special cases.
 *
 * Each note carries an optional `heading` so the model can organize longer
 * notebooks (e.g. "test commands", "decisions", "open questions"). When
 * headings are absent the notes render as a flat bulleted list.
 */

export interface ScratchNote {
  id: number;
  /**
   * Optional short label rendered as a bold heading in the injected
   * prompt block. Heading is *descriptive*, not a key — duplicate
   * headings are allowed and group naturally when rendered.
   */
  heading?: string;
  body: string;
}

export interface ScratchpadState {
  notes: ScratchNote[];
  nextId: number;
}

/** Stable identifiers referenced from both the extension and its tests. */
export const SCRATCHPAD_TOOL_NAME = 'scratchpad';
export const SCRATCHPAD_CUSTOM_TYPE = 'scratchpad-state';

/**
 * Minimal, duck-typed shape of a pi session entry. Same convention as
 * `todo-reducer.ts`: only the fields we touch, so tests don't have to
 * fabricate a whole SessionManager.
 */
export interface BranchEntry {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: {
    readonly role?: string;
    readonly toolName?: string;
    readonly details?: unknown;
  };
}

export function emptyState(): ScratchpadState {
  return { notes: [], nextId: 1 };
}

export function cloneState(s: ScratchpadState): ScratchpadState {
  return { notes: s.notes.map((n) => ({ ...n })), nextId: s.nextId };
}

/**
 * Structural check that `value` is a serialized `ScratchpadState`.
 * Lenient enough to accept state produced by older versions, strict
 * enough that junk in `details` / `data` doesn't get picked up.
 */
export function isScratchpadStateShape(value: unknown): value is ScratchpadState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.nextId !== 'number' || !Number.isFinite(v.nextId)) return false;
  if (!Array.isArray(v.notes)) return false;
  for (const raw of v.notes) {
    if (!raw || typeof raw !== 'object') return false;
    const n = raw as Record<string, unknown>;
    if (typeof n.id !== 'number' || !Number.isFinite(n.id)) return false;
    if (typeof n.body !== 'string') return false;
    if (n.heading !== undefined && typeof n.heading !== 'string') return false;
  }
  return true;
}

/**
 * Extract a `ScratchpadState` from a single branch entry, or `null` if
 * the entry isn't one of ours (or is malformed).
 */
export function stateFromEntry(entry: BranchEntry): ScratchpadState | null {
  if (entry.type === 'custom' && entry.customType === SCRATCHPAD_CUSTOM_TYPE) {
    return isScratchpadStateShape(entry.data) ? cloneState(entry.data) : null;
  }
  if (
    entry.type === 'message' &&
    entry.message?.role === 'toolResult' &&
    entry.message.toolName === SCRATCHPAD_TOOL_NAME
  ) {
    return isScratchpadStateShape(entry.message.details) ? cloneState(entry.message.details) : null;
  }
  return null;
}

/**
 * Walk `branch` from newest to oldest and return the first valid state
 * snapshot found. Returns `emptyState()` if none exists.
 */
export function reduceBranch(branch: readonly BranchEntry[]): ScratchpadState {
  for (let i = branch.length - 1; i >= 0; i--) {
    const s = stateFromEntry(branch[i]);
    if (s) return s;
  }
  return emptyState();
}

// ──────────────────────────────────────────────────────────────────────
// Action handlers — pure (state, args) -> result. The tool's execute()
// just dispatches to these, then mirrors the resulting state.
// ──────────────────────────────────────────────────────────────────────

export interface ActionSuccess {
  ok: true;
  state: ScratchpadState;
  summary: string;
}
export interface ActionError {
  ok: false;
  error: string;
}
export type ActionResult = ActionSuccess | ActionError;

function findNote(state: ScratchpadState, id: number): ScratchNote | undefined {
  return state.notes.find((n) => n.id === id);
}

function trimOrUndefined(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Human-readable plaintext dump of the full state. Used as the `content`
 * text returned by every action so the LLM sees the post-action notebook
 * even without the renderer.
 */
export function formatText(state: ScratchpadState): string {
  if (state.notes.length === 0) return '(scratchpad is empty)';
  return state.notes.map((n) => (n.heading ? `#${n.id} [${n.heading}] ${n.body}` : `#${n.id} ${n.body}`)).join('\n');
}

export function actList(state: ScratchpadState): ActionResult {
  return { ok: true, state: cloneState(state), summary: formatText(state) };
}

export function actAppend(state: ScratchpadState, body: string | undefined, heading: string | undefined): ActionResult {
  const trimmedBody = trimOrUndefined(body);
  if (!trimmedBody) return { ok: false, error: 'append requires a non-empty `body`' };
  const next = cloneState(state);
  const note: ScratchNote = { id: next.nextId++, body: trimmedBody };
  const h = trimOrUndefined(heading);
  if (h) note.heading = h;
  next.notes.push(note);
  const label = h ? `[${h}] ` : '';
  return { ok: true, state: next, summary: `Added #${note.id}: ${label}${trimmedBody.slice(0, 80)}` };
}

export function actUpdate(
  state: ScratchpadState,
  id: number | undefined,
  body: string | undefined,
  heading: string | undefined,
): ActionResult {
  if (id === undefined) return { ok: false, error: 'update requires `id`' };
  if (body === undefined && heading === undefined) {
    return { ok: false, error: 'update requires `body` and/or `heading`' };
  }
  const next = cloneState(state);
  const note = findNote(next, id);
  if (!note) return { ok: false, error: `#${id} not found` };
  if (body !== undefined) {
    const trimmedBody = trimOrUndefined(body);
    if (!trimmedBody) return { ok: false, error: 'update with empty `body` — use `remove` to delete the note' };
    note.body = trimmedBody;
  }
  if (heading !== undefined) {
    const h = trimOrUndefined(heading);
    if (h) note.heading = h;
    else delete note.heading;
  }
  return { ok: true, state: next, summary: `Updated #${id}` };
}

export function actRemove(state: ScratchpadState, id: number | undefined): ActionResult {
  if (id === undefined) return { ok: false, error: 'remove requires `id`' };
  const idx = state.notes.findIndex((n) => n.id === id);
  if (idx === -1) return { ok: false, error: `#${id} not found` };
  const next = cloneState(state);
  const [removed] = next.notes.splice(idx, 1);
  return {
    ok: true,
    state: next,
    summary: `Removed #${id}: ${removed ? removed.body.slice(0, 80) : ''}`,
  };
}

export function actClear(state: ScratchpadState): ActionResult {
  const count = state.notes.length;
  return {
    ok: true,
    state: emptyState(),
    summary: count > 0 ? `Cleared ${count} note(s)` : 'Scratchpad was already empty',
  };
}
