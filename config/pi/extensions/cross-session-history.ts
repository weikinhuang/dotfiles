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
 *   - When the editor has focus, Ctrl+R refreshes project history and opens
 *     a full-text `ReverseSearchOverlay` with a multiline preview, opener
 *     indicators, and reversible continuation filtering. Enter inserts only.
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
} from '@earendil-works/pi-coding-agent';
import { type EditorComponent, Key, matchesKey, type TUI, type EditorTheme } from '@earendil-works/pi-tui';

// `EditorFactory` is declared in pi-coding-agent's extension types but isn't
// re-exported from the package entry point, so we mirror the signature here.
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PROMPTS,
  loadCrossSessionHistory,
  loadCrossSessionHistoryItems,
  type PromptHistoryEntry,
} from '../../../lib/node/pi/cross-session-history.ts';
import { dedupHistoryEntries } from '../../../lib/node/pi/cross-session-history-search.ts';
import { ReverseSearchOverlay } from '../../../lib/node/pi/ext/cross-session-history-overlay.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';

const DEFAULT_SEARCH_SIZE = 5000;
const FACTORY_TAG = Symbol.for('pi-cross-session-history-factory');

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
  let refreshSearchHistory: (() => PromptHistoryEntry[]) | undefined;
  let foreignFactory: EditorFactory | undefined;
  let activeUi: ExtensionUIContext | undefined;
  let searchOpen = false;
  let generation = 0;

  const openReverseSearch = (): void => {
    const ui = activeUi;
    if (!ui || !refreshSearchHistory || searchOpen) return;
    let searchHistory: PromptHistoryEntry[];
    try {
      searchHistory = refreshSearchHistory();
    } catch {
      ui.notify('Unable to load project history.', 'warning');
      return;
    }
    if (searchHistory.length === 0) {
      ui.notify('No prior prompts in this project yet.', 'info');
      return;
    }
    searchOpen = true;
    const openedGeneration = generation;
    void ui
      .custom<string | null>(
        (_tui, theme, _kb, done) => {
          const overlay = new ReverseSearchOverlay(theme, searchHistory, _tui);
          overlay.onAccept = (prompt) => done(prompt);
          overlay.onCancel = () => done(null);
          return overlay;
        },
        { overlay: true },
      )
      .then((result) => {
        if (result !== null && openedGeneration === generation) ui.setEditorText(result);
      })
      .catch(() => {
        if (openedGeneration === generation) ui.notify('History search could not be opened.', 'warning');
      })
      .finally(() => {
        if (openedGeneration === generation) searchOpen = false;
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

  pi.on('session_start', (event, ctx) => {
    activeUi = ctx.ui;
    generation++;
    searchOpen = false;
    // Read the current manager on every opening, not a startup snapshot. This
    // includes prompts submitted since startup without waiting for a reload.
    refreshSearchHistory = () =>
      dedupHistoryEntries(
        loadCrossSessionHistoryItems({
          sessionDir: ctx.sessionManager.getSessionDir(),
          excludeFile: ctx.sessionManager.getSessionFile(),
          currentEntries: ctx.sessionManager.getEntries(),
          maxPrompts: searchSize,
          maxFiles,
        }),
      );

    try {
      const sessionDir = ctx.sessionManager.getSessionDir();
      const excludeFile = ctx.sessionManager.getSessionFile();

      const currentEntries = ctx.sessionManager.getEntries();
      // Startup renders active messages AFTER installing the editor; switches
      // and reloads render BEFORE it. Only the latter need explicit reseeding.
      editorHistory = loadCrossSessionHistory({
        sessionDir,
        excludeFile,
        currentEntries: event.reason === 'startup' ? undefined : currentEntries,
        maxPrompts,
        maxFiles,
      });
    } catch {
      editorHistory = [];
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
        `cross-session-history: ${editorHistory.length} editor / ${refreshSearchHistory().length} search prompts`,
        'info',
      );
    }
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // Hand the editor back to whatever was installed before us (the
    // foreign factory, or pi's default) so our factory - which closes
    // over `activeUi` / the prompt caches - isn't left mounted across a
    // /reload. Drop captured state and invalidate pending selections; the
    // next session_start reinstalls editor history and its search loader.
    if (ctx.hasUI) {
      try {
        ctx.ui.setEditorComponent(foreignFactory);
      } catch {
        // best-effort: shutdown must never throw.
      }
    }
    generation++;
    searchOpen = false;
    activeUi = undefined;
    editorHistory = [];
    refreshSearchHistory = undefined;
    foreignFactory = undefined;
  });
}
