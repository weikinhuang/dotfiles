/**
 * Scratchpad extension for pi - unstructured working notes that survive
 * compaction and travel with the session branch.
 *
 * Companion to the `todo` extension. Where `todo` holds a typed plan
 * (pending / in_progress / review / completed / blocked), `scratchpad`
 * holds free-form notes the model benefits from carrying turn to turn:
 *
 *   - decisions made earlier in the session ("we chose approach B")
 *   - file paths it keeps rediscovering ("secrets live in config/env/*")
 *   - test / lint commands it keeps re-deriving ("./dev/test-bats-docker.sh -q")
 *   - answers the user gave to clarifying questions
 *   - TODOs noticed in passing that don't belong in the structured plan
 *
 * Affordances mirror `todo.ts`:
 *
 *   1. Tool exposing CRUD actions over the note set (`append`, `update`,
 *      `remove`, `clear`, `list`).
 *
 *   2. Active-notes auto-injection (`context` hook). The current notebook
 *      is rendered under a `## Working Notes` header with a soft
 *      character cap and spliced as an ephemeral `<system-reminder
 *      id="scratchpad">` into the last user/toolResult turn (not the
 *      system prompt). This is a big weak-model affordance: the model
 *      doesn't have to remember to call `list` - the state is always in
 *      front of it - while the system-prompt prefix stays byte-stable so
 *      the provider's prompt cache survives note edits. Pi's `context`
 *      output is never persisted, so nothing accumulates and an empty
 *      notebook injects nothing.
 *
 *   3. Compaction resilience. Each successful tool call mirrors the
 *      post-action state to a `customType: 'scratchpad-state'` session
 *      entry in addition to `toolResult.details`. Pi's `/compact` can
 *      summarize tool-result messages away; the custom entry travels with
 *      the branch so the reducer can still reconstruct the notebook on
 *      `session_start` / `session_tree`.
 *
 *   4. Branch awareness. State is reconstructed from the branch by
 *      `reduceBranch` in `./lib/scratchpad-reducer.ts`, so `/fork`,
 *      `/tree`, and `/clone` automatically show the correct notes for
 *      that point in history. No external files, no cross-branch leakage.
 *
 * Pure logic (state transitions, prompt rendering) lives in
 * `./lib/scratchpad-reducer.ts` and `./lib/scratchpad-prompt.ts` so it
 * can be unit-tested under `vitest`. This file holds only
 * the pi-coupled glue.
 *
 * Environment:
 *   PI_SCRATCHPAD_DISABLED=1            skip the extension entirely
 *   PI_SCRATCHPAD_DISABLE_AUTOINJECT=1  tool still works but skip the
 *                                       active-notes `context`-hook block
 *   PI_SCRATCHPAD_MAX_INJECTED_CHARS=N  soft cap on the injected block
 *                                       (default 2000)
 */

import { StringEnum } from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Editor,
  type EditorTheme,
  Input,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type TUI,
} from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { applyContextReminder, type ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import { wrapPlain } from '../../../lib/node/pi/context-usage/format.ts';
import {
  EXTERNAL_EDITOR_BINDING,
  formatKeyChord,
  isExternalEditorKey,
  openInExternalEditor,
} from '../../../lib/node/pi/ext/external-editor.ts';
import { formatWorkingNotes, groupByHeading } from '../../../lib/node/pi/scratchpad-prompt.ts';
import { computeScrollWindow } from '../../../lib/node/pi/scroll-window.ts';
import { enterModalUi, exitModalUi, resetModalUi } from '../../../lib/node/pi/ui-activity.ts';
import { formatHeaderRule } from '../../../lib/node/pi/tui-rule.ts';
import { SCRATCHPAD_USAGE } from '../../../lib/node/pi/scratchpad/usage.ts';
import {
  actAppend,
  actClear,
  actList,
  actRemove,
  actUpdate,
  type ActionResult,
  type BranchEntry,
  cloneState,
  emptyState,
  formatText,
  reduceBranch,
  SCRATCHPAD_CUSTOM_TYPE,
  type ScratchNote,
  type ScratchpadState,
} from '../../../lib/node/pi/scratchpad-reducer.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';
import { envTruthy, parseClampedPositiveInt } from '../../../lib/node/pi/parse-env.ts';

const MAX_INJECTED_CHARS_DEFAULT = 2000;

const ScratchpadParams = Type.Object({
  action: StringEnum(['list', 'append', 'update', 'remove', 'clear'] as const),
  body: Type.Optional(
    Type.String({
      description:
        'Note body (for action "append"; optional for "update" - include to change the note text). Free-form markdown, one note per call.',
    }),
  ),
  heading: Type.Optional(
    Type.String({
      description:
        'Optional short heading grouping related notes in the injected block (e.g. "decisions", "test commands", "open questions"). Omit for ungrouped notes.',
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description: 'Note ID (for actions "update" and "remove"). See the ids in the last `list` / injected block.',
    }),
  ),
});

interface ScratchpadDetails extends ScratchpadState {
  action: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function renderNoteLine(n: ScratchNote, theme: Theme): string {
  const id = theme.fg('accent', `#${n.id}`);
  const heading = n.heading ? theme.fg('muted', ` [${n.heading}]`) : '';
  const body = theme.fg('text', truncate(n.body, 160));
  return `  • ${id}${heading} ${body}`;
}

/** Item render used inside the `/scratchpad` overlay. The heading is the
 * section label, so each line carries only `> #id body` (the `>` marker is
 * shown on the selected note, a space otherwise); long / multi-line bodies
 * word-wrap with continuation lines aligned under the body. */
function renderOverlayNoteLines(
  n: ScratchNote,
  theme: Theme,
  idPad: number,
  width: number,
  selected: boolean,
): string[] {
  const marker = selected ? theme.fg('accent', '>') : ' ';
  const idStr = `#${n.id}`.padEnd(idPad);
  const id = selected ? theme.fg('accent', theme.bold(idStr)) : theme.fg('accent', idStr);
  const prefix = `  ${marker} ${id} `;
  // Visible indent of `prefix`: 2 (item indent) + 1 (marker) + 1 (space) + idPad + 1 (space).
  const indentWidth = 5 + idPad;
  const bodyWidth = Math.max(8, width - indentWidth);
  const wrapped = wrapPlain(n.body, bodyWidth);
  if (wrapped.length === 0) return [prefix];
  const cont = ' '.repeat(indentWidth);
  return wrapped.map((line, i) =>
    i === 0 ? `${prefix}${theme.fg('text', line)}` : `${cont}${theme.fg('text', line)}`,
  );
}

// ──────────────────────────────────────────────────────────────────────
// /scratchpad overlay
// ──────────────────────────────────────────────────────────────────────

/**
 * State mutations the overlay drives back into the extension. Each runs the
 * matching reducer action, updates the in-memory `state`, and mirrors it via
 * `pi.appendEntry` - the same persistence path the `scratchpad` tool uses, so
 * overlay edits survive `/compact` and travel with the branch.
 */
interface ScratchpadOverlayDeps {
  getState: () => ScratchpadState;
  remove: (id: number) => void;
  updateBody: (id: number, body: string) => void;
  /** Empty string clears the heading. */
  updateHeading: (id: number, heading: string) => void;
  /** Returns the new note's id, or undefined if the append was rejected. */
  append: (body: string) => number | undefined;
}

type OverlayMode = 'list' | 'body' | 'heading' | 'add';

/**
 * Rows kept clear above + below the overlay so it never touches the terminal
 * edges, and the smallest height we'll ever render into. Both feed the
 * `maxHeight` backstop passed to `ctx.ui.custom` and the internal windowing,
 * so the two agree on the row budget.
 */
const OVERLAY_VERTICAL_MARGIN = 2;
const MIN_OVERLAY_ROWS = 6;

/** Row budget the overlay renders into for the current terminal height. */
function overlayViewportRows(tui: TUI): number {
  return Math.max(MIN_OVERLAY_ROWS, tui.terminal.rows - OVERLAY_VERTICAL_MARGIN);
}

class ScratchpadOverlay implements Component {
  private readonly deps: ScratchpadOverlayDeps;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly kb: KeybindingsManager | undefined;
  private readonly onClose: () => void;
  /** Multi-line editor for note bodies (`e`) and new notes (`a`). */
  private readonly editor: Editor;
  /** Single-line input for the heading (`h`). */
  private readonly input: Input;

  private mode: OverlayMode = 'list';
  /** Selection index into the flattened (grouped) display order. */
  private sel = 0;
  /** Note being edited in `body` / `heading` mode (null in `add`). */
  private editingId: number | null = null;
  /** First visible body-line index in list mode (viewport scroll offset). */
  private scrollTop = 0;
  /** When true, the next render re-anchors the window on the selected note
   * (set on selection change); when false the window is free-scrolled and
   * `scrollTop` is preserved as-is (scrolling within a tall note). */
  private pendingSnap = true;
  /** Selected note's `[start, end)` body-line range from the last render. */
  private selRange: { start: number; end: number } | undefined;
  /** Visible body-line window `[winStart, winEnd)` from the last render. */
  private winStart = 0;
  private winEnd = 0;
  /** Largest valid `scrollTop` from the last render. */
  private maxScrollTop = 0;
  /** Per-note `[start, end)` body-line ranges from the last list render, in
   * ordered-note order; drives page-sized selection jumps. */
  private noteLineRanges: { start: number; end: number }[] = [];
  /** Visible content rows in the scroll region from the last list render. */
  private lastContentRows = 1;
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];

  constructor(
    deps: ScratchpadOverlayDeps,
    theme: Theme,
    tui: TUI,
    kb: KeybindingsManager | undefined,
    onClose: () => void,
  ) {
    this.deps = deps;
    this.theme = theme;
    this.tui = tui;
    this.kb = kb;
    this.onClose = onClose;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg('accent', s),
      selectList: {
        selectedPrefix: (t) => theme.fg('accent', t),
        selectedText: (t) => theme.fg('accent', t),
        description: (t) => theme.fg('muted', t),
        scrollInfo: (t) => theme.fg('dim', t),
        noMatch: (t) => theme.fg('warning', t),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (value) => this.onEditorSubmit(value);
    this.input = new Input();
    this.input.onSubmit = (value) => this.onHeadingSubmit(value);
  }

  // ── Input ───────────────────────────────────────────────────────────
  handleInput(data: string): void {
    if (this.mode !== 'list') {
      // Editing: Escape cancels without persisting; everything else flows
      // into the active widget, which fires onSubmit on Enter.
      if (matchesKey(data, Key.escape)) {
        this.exitToList();
        return;
      }
      // Multi-line body/add editor: hand off to $VISUAL/$EDITOR on the
      // external-editor key. Fire-and-forget (the round-trip awaits a real
      // process); the editor's text is replaced in place and we refresh.
      if (this.mode !== 'heading' && isExternalEditorKey(data, this.kb)) {
        void openInExternalEditor({
          tui: this.tui,
          getText: () => this.editor.getText(),
          setText: (text) => this.editor.setText(text),
        }).then(() => this.refresh());
        return;
      }
      if (this.mode === 'heading') this.input.handleInput(data);
      else this.editor.handleInput(data);
      this.refresh();
      return;
    }

    // List mode: navigation + edit commands.
    if (matchesKey(data, Key.escape) || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, 'ctrl+p') || data === 'k') this.navigateUp(1, 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, 'ctrl+n') || data === 'j') this.navigateDown(1, 1);
    else if (matchesKey(data, Key.pageUp) || matchesKey(data, 'ctrl+b'))
      this.navigateUp(this.lastContentRows, this.notesPerPage());
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, 'ctrl+f'))
      this.navigateDown(this.lastContentRows, this.notesPerPage());
    else if (matchesKey(data, Key.home) || data === 'g') this.moveTo(0);
    else if (matchesKey(data, Key.end) || data === 'G') this.moveTo(Number.MAX_SAFE_INTEGER);
    else if (data === 'a') this.openAdd();
    else if (data === 'e') this.openBody();
    else if (data === 'h') this.openHeading();
    else if (data === 'd') this.deleteSelected();
    else return;
    this.refresh();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  // ── Submit handlers ───────────────────────────────────────────────────
  private onEditorSubmit(value: string): void {
    const v = value.trim();
    if (this.mode === 'add') {
      if (v) {
        const id = this.deps.append(v);
        if (id !== undefined) this.selectId(id);
      }
    } else if (this.mode === 'body' && this.editingId !== null && v) {
      // Empty body is rejected by the reducer; ignore it here so a stray
      // submit doesn't blow away the note (use `d` to delete instead).
      this.deps.updateBody(this.editingId, v);
    }
    this.exitToList();
  }

  private onHeadingSubmit(value: string): void {
    // Trimmed-empty clears the heading; the reducer handles both.
    if (this.editingId !== null) this.deps.updateHeading(this.editingId, value.trim());
    this.exitToList();
  }

  // ── Mode transitions ──────────────────────────────────────────────────
  private openAdd(): void {
    this.mode = 'add';
    this.editingId = null;
    this.editor.setText('');
    this.editor.focused = true;
  }

  private openBody(): void {
    const note = this.currentNote();
    if (!note) return;
    this.mode = 'body';
    this.editingId = note.id;
    this.editor.setText(note.body);
    this.editor.focused = true;
  }

  private openHeading(): void {
    const note = this.currentNote();
    if (!note) return;
    this.mode = 'heading';
    this.editingId = note.id;
    this.input.setValue(note.heading ?? '');
    this.input.focused = true;
  }

  private exitToList(): void {
    this.mode = 'list';
    this.editingId = null;
    this.editor.setText('');
    this.editor.focused = false;
    this.input.setValue('');
    this.input.focused = false;
    this.clampSel();
    this.refresh();
  }

  private deleteSelected(): void {
    const note = this.currentNote();
    if (!note) return;
    this.deps.remove(note.id);
    this.clampSel();
  }

  // ── Selection helpers ─────────────────────────────────────────────────
  /** Notes in grouped display order (matches the rendered list). */
  private orderedNotes(): ScratchNote[] {
    return groupByHeading(this.deps.getState().notes).flatMap(([, notes]) => notes);
  }

  private currentNote(): ScratchNote | undefined {
    const ordered = this.orderedNotes();
    if (ordered.length === 0) return undefined;
    return ordered[Math.min(this.sel, ordered.length - 1)];
  }

  private move(delta: number): void {
    const n = this.orderedNotes().length;
    if (n === 0) return;
    const next = Math.max(0, Math.min(n - 1, this.sel + delta));
    if (next !== this.sel) {
      this.sel = next;
      this.pendingSnap = true;
    }
  }

  /** Jump the selection to an absolute index (clamped); used by g/G/Home/End. */
  private moveTo(index: number): void {
    const n = this.orderedNotes().length;
    if (n === 0) return;
    const next = Math.max(0, Math.min(n - 1, index));
    if (next !== this.sel) {
      this.sel = next;
      this.pendingSnap = true;
    }
  }

  /**
   * Down/PageDown: when the selected note is taller than the visible region
   * and part of it is still below the fold, scroll the viewport down by
   * `scrollStep` lines (staying on the same note); otherwise advance the
   * selection by `moveDelta` notes. This lets a single tall note be scrolled
   * through instead of being truncated with an unreachable `↓ N more`.
   */
  private navigateDown(scrollStep: number, moveDelta: number): void {
    const r = this.selRange;
    if (r && r.end - r.start > this.lastContentRows && this.winEnd < r.end) {
      this.scrollTop = Math.min(this.maxScrollTop, this.scrollTop + Math.max(1, scrollStep));
    } else {
      this.move(moveDelta);
    }
  }

  /** Up/PageUp: mirror of navigateDown - scroll within a tall note before
   * moving to the previous note. */
  private navigateUp(scrollStep: number, moveDelta: number): void {
    const r = this.selRange;
    if (r && r.end - r.start > this.lastContentRows && this.winStart > r.start) {
      this.scrollTop = Math.max(0, this.scrollTop - Math.max(1, scrollStep));
    } else {
      this.move(-moveDelta);
    }
  }

  /**
   * How many notes to advance on PageUp/PageDown: the count of notes whose
   * line spans fill the visible content region starting at the current
   * selection, so a page scroll lands the current bottom note near the top.
   */
  private notesPerPage(): number {
    const ranges = this.noteLineRanges;
    if (ranges.length === 0) return 1;
    const rows = Math.max(1, this.lastContentRows);
    let used = 0;
    let count = 0;
    for (let i = Math.min(this.sel, ranges.length - 1); i < ranges.length; i++) {
      const height = ranges[i].end - ranges[i].start;
      if (count > 0 && used + height > rows) break;
      used += height;
      count++;
    }
    return Math.max(1, count);
  }

  private clampSel(): void {
    const n = this.orderedNotes().length;
    this.sel = n === 0 ? 0 : Math.min(this.sel, n - 1);
    // Re-anchor the window on the (possibly moved) selection after an edit,
    // add, or delete.
    this.pendingSnap = true;
  }

  private selectId(id: number): void {
    const idx = this.orderedNotes().findIndex((n) => n.id === id);
    if (idx >= 0) this.sel = idx;
  }

  // ── Render ────────────────────────────────────────────────────────────
  render(width: number): string[] {
    // Only the static list view is cacheable; the editor/input view changes
    // on every keystroke, so it rebuilds each render. List output also
    // depends on terminal height (the scroll window), so the cache keys on
    // both width and rows.
    const rows = this.tui.terminal.rows;
    if (this.mode === 'list' && this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) {
      return this.cachedLines;
    }
    const lines = this.mode === 'list' ? this.renderList(width) : this.renderEditor(width);
    if (this.mode === 'list') {
      this.cachedWidth = width;
      this.cachedRows = rows;
      this.cachedLines = lines;
    }
    return lines;
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const state = this.deps.getState();

    // Pinned header: blank, rule, blank.
    const total = state.notes.length;
    const chip = total > 0 ? `${total} note${total === 1 ? '' : 's'}` : undefined;
    const header: string[] = ['', truncateToWidth(formatHeaderRule('Scratchpad', chip, width, th), width), ''];

    // Pinned footer: blank, hint, blank.
    const hint = total === 0 ? 'a add · Esc close' : '↑/↓ move · e body · h heading · a add · d delete · Esc close';
    const footer: string[] = ['', truncateToWidth(`  ${th.fg('dim', hint)}`, width), ''];

    // Scrollable body. Track the selected note's line range (for scroll
    // follow) and every note's range (for page-sized jumps).
    const body: string[] = [];
    this.noteLineRanges = [];
    let selStart: number | undefined;
    let selEnd: number | undefined;

    if (total === 0) {
      body.push(truncateToWidth(`  ${th.fg('dim', 'Scratchpad is empty. Press a to add a note.')}`, width));
    } else {
      const idPad = Math.max(...state.notes.map((n) => String(n.id).length)) + 1; // include '#'
      const ordered = this.orderedNotes();
      const selId = ordered[Math.min(this.sel, ordered.length - 1)]?.id;
      let firstSection = true;
      for (const [heading, notes] of groupByHeading(state.notes)) {
        if (!firstSection) body.push('');
        firstSection = false;
        const headingLine = body.length;
        body.push(truncateToWidth(`  ${th.fg('muted', heading || 'Notes')}`, width));
        let firstInSection = true;
        for (const n of notes) {
          const start = body.length;
          for (const row of renderOverlayNoteLines(n, th, idPad, width, n.id === selId)) {
            body.push(truncateToWidth(row, width));
          }
          this.noteLineRanges.push({ start, end: body.length });
          if (n.id === selId) {
            // Anchor the first note of a section on its heading line so
            // jumping to it keeps the section label in view (no spurious
            // "↑ more" above the top note).
            selStart = firstInSection ? headingLine : start;
            selEnd = body.length;
          }
          firstInSection = false;
        }
      }
    }

    return this.windowBody(header, body, footer, width, selStart, selEnd);
  }

  /**
   * Compose the pinned header/footer around a scrolled slice of `body` so the
   * overlay never exceeds the terminal height (which would make pi's overlay
   * compositor inflate the screen buffer and scroll/flicker). When the body
   * fits, it's rendered whole; otherwise one row top + bottom is reserved for
   * `↑/↓ N more` indicators so total height stays constant across scrolling.
   */
  private windowBody(
    header: string[],
    body: string[],
    footer: string[],
    width: number,
    selStart: number | undefined,
    selEnd: number | undefined,
  ): string[] {
    const th = this.theme;
    const viewportRows = overlayViewportRows(this.tui);
    const regionRows = viewportRows - header.length - footer.length;

    this.selRange = selStart !== undefined && selEnd !== undefined ? { start: selStart, end: selEnd } : undefined;

    // Everything fits (or no room to scroll): render the whole body.
    if (regionRows <= 0 || body.length <= regionRows) {
      this.scrollTop = 0;
      this.lastContentRows = Math.max(1, regionRows);
      this.maxScrollTop = 0;
      this.winStart = 0;
      this.winEnd = body.length;
      this.pendingSnap = false;
      return [...header, ...body, ...footer];
    }

    // Reserve indicator rows so the height is stable regardless of offset.
    const contentRows = Math.max(1, regionRows - 2);
    this.lastContentRows = contentRows;
    this.maxScrollTop = Math.max(0, body.length - contentRows);
    // Re-anchor on the selected note only when the selection just changed;
    // otherwise leave `scrollTop` where the user free-scrolled it (so a note
    // taller than the region can be scrolled through without snapping back).
    const win = computeScrollWindow({
      total: body.length,
      rows: contentRows,
      scrollTop: this.scrollTop,
      keepStart: this.pendingSnap ? selStart : undefined,
      keepEnd: this.pendingSnap ? selEnd : undefined,
    });
    this.scrollTop = win.scrollTop;
    this.winStart = win.start;
    this.winEnd = win.end;
    this.pendingSnap = false;

    const topIndicator =
      win.hiddenAbove > 0 ? truncateToWidth(`  ${th.fg('dim', `↑ ${win.hiddenAbove} more`)}`, width) : '';
    const bottomIndicator =
      win.hiddenBelow > 0 ? truncateToWidth(`  ${th.fg('dim', `↓ ${win.hiddenBelow} more`)}`, width) : '';

    return [...header, topIndicator, ...body.slice(win.start, win.end), bottomIndicator, ...footer];
  }

  private renderEditor(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [''];

    let chip: string;
    let label: string;
    if (this.mode === 'add') {
      chip = 'new note';
      label = 'New note body:';
    } else if (this.mode === 'body') {
      chip = `editing #${this.editingId}`;
      label = 'Body:';
    } else {
      chip = `heading for #${this.editingId}`;
      label = 'Heading (leave empty to clear):';
    }
    lines.push(truncateToWidth(formatHeaderRule('Scratchpad', chip, width, th), width));
    lines.push('');
    lines.push(truncateToWidth(`  ${th.fg('muted', label)}`, width));
    lines.push('');

    const widget = this.mode === 'heading' ? this.input : this.editor;
    for (const line of widget.render(width - 2)) lines.push(line);

    lines.push('');
    const hint =
      this.mode === 'heading'
        ? 'Enter to save · Esc to cancel'
        : `Enter to save · Shift+Enter for newline · ${formatKeyChord(this.kb?.getKeys(EXTERNAL_EDITOR_BINDING)[0])} external editor · Esc to cancel`;
    lines.push(truncateToWidth(`  ${th.fg('dim', hint)}`, width));
    lines.push('');
    return lines;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function scratchpadExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_SCRATCHPAD_DISABLED)) return;

  const autoInjectEnabled = process.env.PI_SCRATCHPAD_DISABLE_AUTOINJECT !== '1';
  const maxInjectedChars = parseClampedPositiveInt(
    process.env.PI_SCRATCHPAD_MAX_INJECTED_CHARS,
    MAX_INJECTED_CHARS_DEFAULT,
    200,
  );

  // In-memory mirror of the current branch's state. Reconstructed from
  // the session on session_start / session_tree and updated in place on
  // each successful tool call.
  let state: ScratchpadState = emptyState();

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch() as unknown as readonly BranchEntry[];
    state = reduceBranch(branch);
  };

  pi.on('session_start', (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  // Clear the modal-UI signal on shutdown / reload so a notebook that was open
  // when the session ended (or was `/reload`ed) doesn't leave the flag stuck,
  // which would freeze the avatar animation forever. Idempotent, never throws.
  pi.on('session_shutdown', () => {
    resetModalUi();
  });

  // ── Active-notes auto-injection into every turn (via the `context` hook) ──
  // Splice the working notes as an ephemeral <system-reminder> into the
  // last user/toolResult turn. Pi's `context` output builds only the
  // outgoing payload and is never persisted, so the system prompt stays
  // byte-stable (prompt cache survives note edits) and nothing accumulates.
  // An empty notebook injects nothing. See lib/node/pi/context-reminder.ts.
  if (autoInjectEnabled) {
    pi.on('context', (event) => {
      const block = formatWorkingNotes(state, { maxChars: maxInjectedChars });
      if (!block) return undefined;
      const messages = applyContextReminder(event.messages as unknown as ReminderMessage[], {
        id: 'scratchpad',
        body: block,
      });
      return { messages: messages as unknown as typeof event.messages };
    });
  }

  // ── Tool registration ───────────────────────────────────────────────
  pi.registerTool({
    name: 'scratchpad',
    label: 'Scratchpad',
    description:
      'Persistent free-form notes that survive compaction and follow the session branch. Use for decisions, file paths, test commands, and any other carry-over state that is NOT a todo. Actions: list, append (body [, heading]), update (id [, body] [, heading]), remove (id), clear.',
    promptSnippet:
      'Carry decisions, paths, test commands, and other unstructured working state across turns so they survive compaction.',
    promptGuidelines: [
      'Use `scratchpad` (action `append`) to record any detail you want to remember next turn: chosen approach, flaky test names, environment paths, user answers. Prefer short, factual notes over long narrative.',
      'Call `scratchpad` action `update` or `remove` when a note becomes outdated - stale notes are worse than no notes.',
      'Do NOT duplicate the `todo` plan in the scratchpad. Use `todo` for action items that still need doing; use `scratchpad` for context and references.',
    ],
    parameters: ScratchpadParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let result: ActionResult;
      switch (params.action) {
        case 'list':
          result = actList(state);
          break;
        case 'append':
          result = actAppend(state, params.body, params.heading);
          break;
        case 'update':
          result = actUpdate(state, params.id, params.body, params.heading);
          break;
        case 'remove':
          result = actRemove(state, params.id);
          break;
        case 'clear':
          result = actClear(state);
          break;
      }

      if (result.ok) {
        state = result.state;
        // Mirror to a custom session entry. Compaction can summarize
        // away old tool-result messages; the custom entry travels with
        // the branch and keeps the notebook reconstructable.
        try {
          pi.appendEntry(SCRATCHPAD_CUSTOM_TYPE, cloneState(state));
        } catch {
          // Never let bookkeeping break the tool call.
        }
        const details: ScratchpadDetails = { ...cloneState(state), action: params.action };
        const contentText = params.action === 'list' ? formatText(state) : `${result.summary}\n\n${formatText(state)}`;
        return { content: [{ type: 'text', text: contentText }], details };
      }

      const details: ScratchpadDetails = { ...cloneState(state), action: params.action, error: result.error };
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }],
        details,
        isError: true,
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg('toolTitle', theme.bold('scratchpad ')) + theme.fg('muted', args.action);
      if (args.id !== undefined) text += ` ${theme.fg('accent', `#${args.id}`)}`;
      if (args.heading) text += ` ${theme.fg('dim', `[${truncate(args.heading, 40)}]`)}`;
      if (args.body) text += ` ${theme.fg('dim', `"${truncate(args.body, 60)}"`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = (result.details ?? {}) as Partial<ScratchpadDetails>;
      if (details.error) {
        return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);
      }
      const notes = details.notes ?? [];
      if (notes.length === 0) {
        return new Text(theme.fg('dim', '(scratchpad is empty)'), 0, 0);
      }
      const display = expanded ? notes : notes.slice(0, 6);
      const parts: string[] = [theme.fg('muted', `${notes.length} note(s)`)];
      for (const n of display) parts.push(renderNoteLine(n, theme));
      if (!expanded && notes.length > display.length) {
        parts.push(theme.fg('dim', `  … ${notes.length - display.length} more`));
      }
      return new Text(parts.join('\n'), 0, 0);
    },
  });

  // ── /scratchpad command ─────────────────────────────────────────────
  pi.registerCommand('scratchpad', {
    description: 'Show the scratchpad (no args or `list`) or `preview` the working-notes block injected next turn',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        list: { description: 'Show the scratchpad' },
        preview: { description: 'Preview the working-notes block injected next turn' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SCRATCHPAD_USAGE, 'info');
        return;
      }
      const sub = (args ?? '').trim().toLowerCase();
      if (sub === '' || sub === 'list') {
        if (!ctx.hasUI) {
          ctx.ui.notify(formatText(state), 'info');
          return;
        }
        // Persist an overlay edit the same way the tool's execute() does:
        // adopt the post-action state and mirror it to a session entry.
        const persist = (result: ActionResult): void => {
          if (!result.ok) return;
          state = result.state;
          try {
            pi.appendEntry(SCRATCHPAD_CUSTOM_TYPE, cloneState(state));
          } catch {
            // Never let bookkeeping break an overlay edit.
          }
        };
        const deps: ScratchpadOverlayDeps = {
          getState: () => state,
          remove: (id) => persist(actRemove(state, id)),
          updateBody: (id, body) => persist(actUpdate(state, id, body, undefined)),
          updateHeading: (id, heading) => persist(actUpdate(state, id, undefined, heading)),
          append: (body) => {
            const result = actAppend(state, body, undefined);
            if (!result.ok) return undefined;
            const newId = state.nextId; // id assigned == nextId before the append increments it
            persist(result);
            return newId;
          },
        };
        // Capture the overlay's TUI so the maxHeight backstop can track the
        // live terminal height (the factory runs before the first layout).
        let overlayTui: TUI | undefined;
        // Signal that a modal custom-UI component is on screen so animator
        // extensions (the avatar) pause. This component is mounted inline in
        // the editor container (not `overlay: true`), so `TUI.hasOverlay()`
        // stays false for it - the shared flag is how the avatar learns the
        // notebook is up. See lib/node/pi/ui-activity.ts.
        enterModalUi();
        try {
          await ctx.ui.custom<void>(
            (tui, theme, kb, done) => {
              overlayTui = tui;
              return new ScratchpadOverlay(deps, theme, tui, kb, () => done());
            },
            {
              // maxHeight only takes effect if this is mounted as a real
              // overlay (`overlay: true` -> showOverlay); today it's an inline
              // editor component, so this is inert but harmless - the actual
              // height bounding is the internal windowing in windowBody(). Kept
              // as a correct backstop in case this becomes a true overlay.
              overlayOptions: () => ({
                maxHeight: overlayTui ? overlayViewportRows(overlayTui) : MIN_OVERLAY_ROWS,
              }),
            },
          );
        } finally {
          exitModalUi();
        }
        return;
      }
      if (sub === 'preview') {
        if (!autoInjectEnabled) {
          ctx.ui.notify(
            'Scratchpad auto-injection is disabled (PI_SCRATCHPAD_DISABLE_AUTOINJECT=1). ' +
              'Nothing would be injected next turn.\n\n' +
              `Current notebook (${state.notes.length} note(s)):\n${formatText(state)}`,
            'info',
          );
          return;
        }
        const block = formatWorkingNotes(state, { maxChars: maxInjectedChars });
        if (!block) {
          ctx.ui.notify('(scratchpad is empty - nothing would be injected into the next turn)', 'info');
          return;
        }
        ctx.ui.notify(
          `Injected into the next turn (cap ${maxInjectedChars} chars, rendered ${block.length}):\n\n${block}`,
          'info',
        );
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${sub}. Usage: /scratchpad [list|preview]`, 'warning');
    },
  });
}
