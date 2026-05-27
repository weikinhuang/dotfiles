/**
 * Cross-session prompt history for the input editor.
 *
 * Pi's built-in editor already supports arrow-up to scroll through
 * prompts you've submitted in the current session. Claude Code goes
 * further: arrow-up cycles through prompts from prior sessions in
 * the same project too. This extension closes the gap.
 *
 * On every `session_start`, we walk the project's session bucket
 * (`ctx.sessionManager.getSessionDir()`) - the same dir pi uses to
 * persist this project's `.jsonl` session files - and pull out every
 * user prompt from prior sessions in chronological order. We then
 * register an editor factory via `ctx.ui.setEditorComponent` that
 * pre-populates the new editor's history ring (`editor.addToHistory`)
 * with those prompts before pi binds it to input.
 *
 * Cross session, NOT cross project: pi already buckets sessions per
 * cwd into `~/.pi/agent/sessions/<slug>/`, so just listing that one
 * directory gives us "this project only" for free.
 *
 * Composition: if another extension (e.g. a vim-modal editor) has
 * already installed an editor factory, we wrap it - call its factory
 * to produce the inner editor, then call `addToHistory` on the
 * resulting instance if it exposes one. A symbol marker on our own
 * factory keeps `/reload` from chain-wrapping ourselves.
 *
 * Environment:
 *   PI_CROSS_SESSION_HISTORY_DISABLED=1            skip the extension entirely
 *   PI_CROSS_SESSION_HISTORY_MAX_PROMPTS=N         cap (default 100, editor itself caps at 100)
 *   PI_CROSS_SESSION_HISTORY_MAX_FILES=N           max session files scanned (default 100)
 *   PI_CROSS_SESSION_HISTORY_DEBUG=1               ctx.ui.notify how many prompts were loaded
 */

import { CustomEditor, type EditorFactory, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PROMPTS,
  loadCrossSessionHistory,
} from '../../../lib/node/pi/cross-session-history.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';

const FACTORY_TAG = Symbol.for('pi-cross-session-history-factory');

/**
 * Minimal duck-type for the bits of `pi-tui`'s `Editor` we need.
 * Avoids importing from `@earendil-works/pi-tui` (which the runtime
 * resolves via the global pi install, not this repo's tsconfig).
 */
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
  const debug = envTruthy(process.env.PI_CROSS_SESSION_HISTORY_DEBUG);

  // Mutable history slot; refreshed each session_start. The factory
  // (which pi may invoke at any later moment) reads from this slot,
  // so each fresh editor always reflects the latest snapshot.
  let cachedPrompts: string[] = [];

  // The foreign factory we should delegate to, if any. Captured the
  // first time we see a non-ours factory installed; cleared back to
  // undefined the moment getEditorComponent() returns undefined again.
  let foreignFactory: EditorFactory | undefined;

  const ourFactory: EditorFactory = (tui, theme, keybindings) => {
    const inner = foreignFactory ? foreignFactory(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
    if (hasAddToHistory(inner)) {
      for (const prompt of cachedPrompts) {
        inner.addToHistory(prompt);
      }
    }
    return inner;
  };
  (ourFactory as unknown as Record<symbol, unknown>)[FACTORY_TAG] = true;

  pi.on('session_start', (_event, ctx) => {
    try {
      const sessionDir = ctx.sessionManager.getSessionDir();
      const excludeFile = ctx.sessionManager.getSessionFile();
      cachedPrompts = loadCrossSessionHistory({
        sessionDir,
        excludeFile,
        maxPrompts,
        maxFiles,
      });
    } catch {
      cachedPrompts = [];
    }

    const existing = ctx.ui.getEditorComponent();
    if (existing === undefined) {
      foreignFactory = undefined;
    } else if (!isOurFactory(existing)) {
      // Foreign factory (e.g. modal-editor extension) - capture it so
      // we delegate to it for the editor instance, then layer history
      // on top.
      foreignFactory = existing;
    }
    // If `existing === ourFactory`, leave foreignFactory as is - we're
    // simply being re-run after /reload or session resume.

    ctx.ui.setEditorComponent(ourFactory);

    if (debug) {
      ctx.ui.notify(`cross-session-history: loaded ${cachedPrompts.length} prompts`, 'info');
    }
  });
}
