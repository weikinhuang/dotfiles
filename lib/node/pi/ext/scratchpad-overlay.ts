/**
 * `ScratchpadOverlay` - the interactive `/scratchpad` overlay component for the
 * scratchpad extension (config/pi/extensions/scratchpad.ts): a scrollable,
 * grouped note list with inline body/heading editors and an add mode.
 *
 * Lives under `ext/` because it imports `@earendil-works/pi-tui` (`Editor`,
 * `Input`, `Key`, `matchesKey`, `truncateToWidth`, the `TUI`) plus the `Theme`
 * / `KeybindingsManager` from `pi-coding-agent` - the home for pi-coupled UI
 * glue extracted to shrink the extension shell. The viewport windowing math is
 * shared with the other overlays via [`overlay-window.ts`](./overlay-window.ts);
 * the pure note reducer / prompt rendering lives in the pi-free
 * `../scratchpad-reducer.ts` and `../scratchpad-prompt.ts`.
 *
 * `ScratchpadOverlayDeps` is exported because the extension builds the
 * persistence-backed callbacks (running the reducer + mirroring via
 * `pi.appendEntry`) before handing them to the overlay.
 */

import { type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Editor,
  type EditorTheme,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
} from '@earendil-works/pi-tui';

import { assembleWindowedBody, overlayViewportRows } from './overlay-window.ts';
import { wrapPlain } from '../context-usage/format.ts';
import {
  EXTERNAL_EDITOR_BINDING,
  formatKeyChord,
  isExternalEditorKey,
  openInExternalEditor,
} from './external-editor.ts';
import { groupByHeading } from '../scratchpad-prompt.ts';
import { type ScratchNote, type ScratchpadState } from '../scratchpad-reducer.ts';
import { formatHeaderRule } from '../tui-rule.ts';

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

/**
 * State mutations the overlay drives back into the extension. Each runs the
 * matching reducer action, updates the in-memory `state`, and mirrors it via
 * `pi.appendEntry` - the same persistence path the `scratchpad` tool uses, so
 * overlay edits survive `/compact` and travel with the branch.
 */
export interface ScratchpadOverlayDeps {
  getState: () => ScratchpadState;
  remove: (id: number) => void;
  updateBody: (id: number, body: string) => void;
  /** Empty string clears the heading. */
  updateHeading: (id: number, heading: string) => void;
  /** Returns the new note's id, or undefined if the append was rejected. */
  append: (body: string) => number | undefined;
}

type OverlayMode = 'list' | 'body' | 'heading' | 'add';

export class ScratchpadOverlay implements Component {
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
   * compositor inflate the screen buffer and scroll/flicker). Delegates the
   * shared header/footer/indicator assembly to `assembleWindowedBody`; the
   * overlay only tracks the resulting window state for its scroll-follow
   * navigation (selRange / winStart / winEnd / maxScrollTop / contentRows).
   */
  private windowBody(
    header: string[],
    body: string[],
    footer: string[],
    width: number,
    selStart: number | undefined,
    selEnd: number | undefined,
  ): string[] {
    this.selRange = selStart !== undefined && selEnd !== undefined ? { start: selStart, end: selEnd } : undefined;

    // Re-anchor on the selected note only when the selection just changed;
    // otherwise leave `scrollTop` where the user free-scrolled it (so a note
    // taller than the region can be scrolled through without snapping back).
    const win = assembleWindowedBody({
      header,
      body,
      footer,
      width,
      viewportRows: overlayViewportRows(this.tui.terminal.rows),
      scrollTop: this.scrollTop,
      theme: this.theme,
      keepStart: this.pendingSnap ? selStart : undefined,
      keepEnd: this.pendingSnap ? selEnd : undefined,
    });
    this.scrollTop = win.scrollTop;
    this.winStart = win.winStart;
    this.winEnd = win.winEnd;
    this.maxScrollTop = win.maxScrollTop;
    this.lastContentRows = win.contentRows;
    this.pendingSnap = false;
    return win.lines;
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
