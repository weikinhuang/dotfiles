/**
 * Cross-session prompt history for the input editor.
 *
 * Pi's built-in editor already supports arrow-up to scroll through
 * prompts you've submitted in the current session. Claude Code goes
 * further: arrow-up cycles through prompts from prior sessions in
 * the same project too, and Ctrl+R opens a fzf-style reverse search.
 * This extension closes both gaps.
 *
 *   - On every `session_start`, walks `ctx.sessionManager.getSessionDir()`
 *     and pre-populates the editor's `addToHistory` ring with prior
 *     prompts in chronological order, capped at the editor's 100-entry
 *     internal cap. Arrow-up just works across sessions.
 *
 *   - When the editor has focus, Ctrl+R opens a `ReverseSearchOverlay`
 *     (defined below). Typing fuzzy-matches across the deduplicated
 *     project history; enter inserts the chosen prompt into the editor.
 *
 * Cross session, NEVER cross project: pi already buckets sessions per
 * cwd into `~/.pi/agent/sessions/<slug>/`, so just listing that one
 * directory gives us "this project only" for free.
 *
 * Composition: if another extension (e.g. a vim-modal editor) has
 * already installed an editor factory, we wrap it - call its factory
 * to produce the inner editor, then layer history pre-population on
 * top. Ctrl+R is only intercepted when WE own the editor (i.e. no
 * foreign factory exists), since we can't subclass an arbitrary
 * Component returned by a foreign factory without monkey-patching.
 *
 * Environment:
 *   PI_CROSS_SESSION_HISTORY_DISABLED=1            skip the extension entirely
 *   PI_CROSS_SESSION_HISTORY_MAX_PROMPTS=N         arrow-up history cap (default 100)
 *   PI_CROSS_SESSION_HISTORY_MAX_FILES=N           max session files scanned (default 100)
 *   PI_CROSS_SESSION_HISTORY_SEARCH_SIZE=N         reverse-search pool size (default 5000)
 *   PI_CROSS_SESSION_HISTORY_DEBUG=1               ctx.ui.notify debug events
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionUIContext,
  type KeybindingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type EditorComponent,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  type EditorTheme,
} from '@earendil-works/pi-tui';

// `EditorFactory` is declared in pi-coding-agent's extension types but isn't
// re-exported from the package entry point, so we mirror the signature here.
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

import {
  dedupKeepMostRecent,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PROMPTS,
  loadCrossSessionHistory,
} from '../../../lib/node/pi/cross-session-history.ts';
import { fuzzyMatch } from '../../../lib/node/pi/fuzzy-match.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';

const DEFAULT_SEARCH_SIZE = 5000;
const FACTORY_TAG = Symbol.for('pi-cross-session-history-factory');

// ──────────────────────────────────────────────────────────────────────
// Reverse-search overlay (Ctrl+R popup)
// ──────────────────────────────────────────────────────────────────────

interface ScoredItem {
  prompt: string;
  score: number;
  /** Indices into the first line of `prompt` of matched chars. */
  indices: number[];
}

/**
 * Reverse-search overlay component. Owns its filter state, rendering,
 * and key dispatch; the host extension just wires `onAccept` /
 * `onCancel` to the `done` callback returned by `ctx.ui.custom`.
 */
class ReverseSearchOverlay implements Component, Focusable {
  private readonly input = new Input();
  private readonly theme: Theme;
  private readonly prompts: readonly string[];
  private readonly maxVisible: number;

  private items: ScoredItem[] = [];
  private selectedIdx = 0;
  /** Index into `items` of the topmost row currently visible. */
  private scrollOffset = 0;

  private cachedWidth?: number;
  private cachedLines?: string[];

  /** Internal focused state - mirrored onto Input for IME cursor positioning. */
  private innerFocused = false;

  onAccept?: (prompt: string) => void;
  onCancel?: () => void;

  constructor(theme: Theme, prompts: readonly string[], maxVisible = 10) {
    this.theme = theme;
    this.prompts = prompts;
    this.maxVisible = maxVisible;
    this.recompute();
  }

  // Focusable - propagate to embedded Input.
  get focused(): boolean {
    return this.innerFocused;
  }
  set focused(value: boolean) {
    this.innerFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl('p'))) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl('n')) || matchesKey(data, Key.ctrl('r'))) {
      // Ctrl+R inside the overlay = "next match" (bash-style cycle).
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.moveSelection(-this.maxVisible);
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.moveSelection(this.maxVisible);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const sel = this.items[this.selectedIdx];
      if (sel) this.onAccept?.(sel.prompt);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.onCancel?.();
      return;
    }

    // Forward to Input for character entry / cursor motion / word delete.
    const before = this.input.getValue();
    this.input.handleInput(data);
    const after = this.input.getValue();
    if (before !== after) this.recompute();
    else this.invalidate();
  }

  private moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    let next = this.selectedIdx + delta;
    if (next < 0) next = 0;
    if (next > this.items.length - 1) next = this.items.length - 1;
    this.selectedIdx = next;
    if (this.selectedIdx < this.scrollOffset) {
      this.scrollOffset = this.selectedIdx;
    } else if (this.selectedIdx >= this.scrollOffset + this.maxVisible) {
      this.scrollOffset = this.selectedIdx - this.maxVisible + 1;
    }
    this.invalidate();
  }

  private recompute(): void {
    const query = this.input.getValue();
    if (query.length === 0) {
      // No query: show every prompt in the order the caller provided
      // (most-recent-first per the dedup helper).
      this.items = this.prompts.map((prompt) => ({ prompt, score: 0, indices: [] }));
    } else {
      const scored: ScoredItem[] = [];
      for (const prompt of this.prompts) {
        // Match against the first line - that's also what we render, and
        // multi-line prompts shouldn't match on text the user can't see.
        const firstLine = prompt.split('\n')[0] ?? '';
        const m = fuzzyMatch(query, firstLine);
        if (m === null) continue;
        scored.push({ prompt, score: m.score, indices: m.indices });
      }
      // Higher score wins; Array.prototype.sort is stable, so equal-score
      // ties resolve in input order (most-recent-first).
      scored.sort((a, b) => b.score - a.score);
      this.items = scored;
    }
    this.selectedIdx = 0;
    this.scrollOffset = 0;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const total = this.prompts.length;
    const matchCount = this.items.length;
    const title = this.input.getValue().length === 0 ? `${total} prompts` : `${matchCount} of ${total} match`;
    lines.push(this.borderLine(width, ` Reverse search • ${title} `));

    const queryPrefix = '❯ ';
    // Both chars are BMP (no surrogate pairs), so `.length` matches visual width.
    const innerWidth = Math.max(1, width - queryPrefix.length);
    const inputLines = this.input.render(innerWidth);
    const inputBody = inputLines[0] ?? '';
    lines.push(truncateToWidth(this.theme.fg('accent', queryPrefix) + inputBody, width));

    if (this.items.length === 0 && this.input.getValue().length > 0) {
      lines.push(truncateToWidth(this.theme.fg('muted', '  no matches'), width));
      for (let i = 1; i < this.maxVisible; i++) lines.push('');
    } else {
      const visible = this.items.slice(this.scrollOffset, this.scrollOffset + this.maxVisible);
      for (let i = 0; i < this.maxVisible; i++) {
        const item = visible[i];
        if (item === undefined) {
          lines.push('');
          continue;
        }
        const absoluteIdx = this.scrollOffset + i;
        lines.push(this.matchLine(item, absoluteIdx === this.selectedIdx, width));
      }
    }

    lines.push(truncateToWidth(this.theme.fg('dim', '  ↑↓ select  enter insert  esc cancel  ctrl+r next'), width));
    lines.push(this.borderLine(width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private borderLine(width: number, label?: string): string {
    if (label === undefined) return this.theme.fg('borderAccent', '─'.repeat(width));
    if (label.length + 4 > width) return this.theme.fg('borderAccent', '─'.repeat(width));
    const left = '── ';
    const right = ' ';
    const remaining = width - left.length - label.length - right.length;
    const dashes = '─'.repeat(Math.max(0, remaining));
    return (
      this.theme.fg('borderAccent', left) +
      this.theme.fg('accent', label) +
      this.theme.fg('borderAccent', right + dashes)
    );
  }

  private matchLine(item: ScoredItem, isSelected: boolean, width: number): string {
    const firstLine = item.prompt.split('\n')[0] ?? '';
    const indexSet = new Set(item.indices.filter((i) => i < firstLine.length));
    const prefixRaw = isSelected ? '> ' : '  ';
    const prefix = isSelected ? this.theme.fg('accent', prefixRaw) : prefixRaw;

    // Group consecutive matched/unmatched chars into runs to keep ANSI
    // output compact.
    let styled = '';
    let curMatched = false;
    let curRun = '';
    for (let i = 0; i < firstLine.length; i++) {
      const matched = indexSet.has(i);
      if (i === 0) curMatched = matched;
      else if (matched !== curMatched) {
        styled += curMatched ? this.theme.fg('accent', curRun) : curRun;
        curRun = '';
        curMatched = matched;
      }
      curRun += firstLine[i];
    }
    if (curRun.length > 0) styled += curMatched ? this.theme.fg('accent', curRun) : curRun;

    return truncateToWidth(prefix + styled, width);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Editor wrapper - intercepts Ctrl+R when WE own the editor
// ──────────────────────────────────────────────────────────────────────

class HistoryEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly onCtrlR: () => void,
    initialHistory: readonly string[],
  ) {
    super(tui, theme, keybindings);
    for (const prompt of initialHistory) this.addToHistory(prompt);
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('r'))) {
      this.onCtrlR();
      return;
    }
    super.handleInput(data);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Extension entrypoint
// ──────────────────────────────────────────────────────────────────────

interface EditorWithHistory {
  addToHistory(text: string): void;
}

function hasAddToHistory(value: unknown): value is EditorWithHistory {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { addToHistory?: unknown }).addToHistory === 'function'
  );
}

function isOurFactory(value: EditorFactory | undefined): boolean {
  if (typeof value !== 'function') return false;
  return (value as unknown as Record<symbol, unknown>)[FACTORY_TAG] === true;
}

export default function crossSessionHistory(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CROSS_SESSION_HISTORY_DISABLED)) return;

  const maxPrompts = parsePositiveInt(process.env.PI_CROSS_SESSION_HISTORY_MAX_PROMPTS, DEFAULT_MAX_PROMPTS);
  const maxFiles = parsePositiveInt(process.env.PI_CROSS_SESSION_HISTORY_MAX_FILES, DEFAULT_MAX_FILES);
  const searchSize = parsePositiveInt(process.env.PI_CROSS_SESSION_HISTORY_SEARCH_SIZE, DEFAULT_SEARCH_SIZE);
  const debug = envTruthy(process.env.PI_CROSS_SESSION_HISTORY_DEBUG);

  // Mutable state refreshed each session_start; closures below read these.
  let editorHistory: string[] = [];
  let searchHistory: string[] = [];
  let foreignFactory: EditorFactory | undefined;
  let activeUi: ExtensionUIContext | undefined;

  const openReverseSearch = (): void => {
    const ui = activeUi;
    if (!ui) return;
    if (searchHistory.length === 0) {
      ui.notify('No prior prompts in this project yet.', 'info');
      return;
    }
    void ui
      .custom<string | null>(
        (_tui, theme, _kb, done) => {
          const overlay = new ReverseSearchOverlay(theme, searchHistory);
          overlay.onAccept = (prompt) => done(prompt);
          overlay.onCancel = () => done(null);
          return overlay;
        },
        { overlay: true },
      )
      .then((result) => {
        if (result !== null) {
          ui.setEditorText(result);
        }
      });
  };

  const ourFactory: EditorFactory = (tui, theme, keybindings) => {
    if (foreignFactory) {
      // Compose: delegate to the foreign factory, layer history on top.
      // No Ctrl+R intercept on this path - the foreign editor owns key
      // dispatch and we don't subclass it.
      const inner = foreignFactory(tui, theme, keybindings);
      if (hasAddToHistory(inner)) {
        for (const prompt of editorHistory) inner.addToHistory(prompt);
      }
      return inner;
    }
    return new HistoryEditor(tui, theme, keybindings, openReverseSearch, editorHistory);
  };
  (ourFactory as unknown as Record<symbol, unknown>)[FACTORY_TAG] = true;

  pi.on('session_start', (_event, ctx) => {
    activeUi = ctx.ui;

    try {
      const sessionDir = ctx.sessionManager.getSessionDir();
      const excludeFile = ctx.sessionManager.getSessionFile();

      // Editor's arrow-up history (capped, chronological).
      editorHistory = loadCrossSessionHistory({
        sessionDir,
        excludeFile,
        maxPrompts,
        maxFiles,
      });

      // Reverse-search pool (wider, deduped, most-recent-first).
      const wide = loadCrossSessionHistory({
        sessionDir,
        excludeFile,
        maxPrompts: searchSize,
        maxFiles,
      });
      searchHistory = dedupKeepMostRecent(wide);
    } catch {
      editorHistory = [];
      searchHistory = [];
    }

    const existing = ctx.ui.getEditorComponent();
    if (existing === undefined) {
      foreignFactory = undefined;
    } else if (!isOurFactory(existing)) {
      foreignFactory = existing;
    }
    // If `existing === ourFactory`, leave foreignFactory as is.

    ctx.ui.setEditorComponent(ourFactory);

    if (debug) {
      ctx.ui.notify(
        `cross-session-history: ${editorHistory.length} editor / ${searchHistory.length} search prompts`,
        'info',
      );
    }
  });
}
