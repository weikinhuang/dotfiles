/**
 * Shared external-editor round-trip for extension-owned editors
 * (scratchpad note bodies, questionnaire free-text answers). pi's built-in
 * `ExtensionEditorComponent` already binds `app.editor.external` (Ctrl+G by
 * default) to dump the buffer to a temp file and reopen `$VISUAL`/`$EDITOR`,
 * but extensions that mount their OWN `Editor` via `ctx.ui.custom` don't get
 * that for free. This module gives them the same affordance with a single
 * check + call from their key router, mirroring pi's implementation in
 * `modes/interactive/components/extension-editor.ts` so the UX matches.
 *
 * The command-resolution policy ({@link resolveExternalEditorCommand}) is
 * pure and unit-tested under `tests/lib/node/pi/ext/`. The temp-file +
 * spawn + `tui.stop()`/`tui.start()` round-trip ({@link openInExternalEditor})
 * is the impure, pi-coupled glue and is not unit-tested (it shells out to a
 * real editor); keeping it here, beside the other `ext/` UI helpers, is what
 * keeps scratchpad and questionnaire thin and free of duplication.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { KeybindingsManager } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';

/** App keybinding id that opens the external editor (default Ctrl+G). */
export const EXTERNAL_EDITOR_BINDING = 'app.editor.external';

/**
 * Resolve the editor command, mirroring pi's precedence: an explicit
 * override first, then `$VISUAL`, then `$EDITOR`, then a platform default
 * (`notepad` on Windows, `nano` elsewhere). Pure: every input is passed in
 * so the policy is unit-testable without touching `process.env`. Blank /
 * whitespace-only values are skipped so an exported-but-empty `EDITOR` does
 * not win over a real `VISUAL`.
 */
export function resolveExternalEditorCommand(
  opts: { explicit?: string; visual?: string; editor?: string; platform?: NodeJS.Platform } = {},
): string {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;
  const visual = opts.visual?.trim();
  if (visual) return visual;
  const editor = opts.editor?.trim();
  if (editor) return editor;
  return (opts.platform ?? process.platform) === 'win32' ? 'notepad' : 'nano';
}

/** True when `data` matches the app's external-editor keybinding. */
export function isExternalEditorKey(data: string, kb: KeybindingsManager | undefined): boolean {
  return kb?.matches(data, EXTERNAL_EDITOR_BINDING) ?? false;
}

/**
 * Title-case a key-chord id for hint text (`ctrl+g` -> `Ctrl+G`). Defaults
 * to `Ctrl+G` (the binding's default) when no key is bound, so a hint never
 * renders empty. Callers pass `kb.getKeys(EXTERNAL_EDITOR_BINDING)[0]` so the
 * hint reflects the user's actual binding rather than a hardcoded chord.
 */
export function formatKeyChord(keyId: string | undefined): string {
  if (!keyId) return 'Ctrl+G';
  return keyId
    .split('+')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('+');
}

export interface ExternalEditorDeps {
  /** The TUI to suspend (`stop`) while the external editor owns the terminal. */
  tui: TUI;
  /** Current buffer contents to seed the temp file with. */
  getText: () => string;
  /** Apply the edited contents back into the in-process editor on clean exit. */
  setText: (text: string) => void;
  /** Explicit editor command; falls back to `$VISUAL` / `$EDITOR` / platform default. */
  command?: string;
  /** Temp-file extension (no dot), default `md` so the editor syntax-highlights prose. */
  ext?: string;
}

/**
 * Dump the current buffer to a temp file, suspend the TUI, open the resolved
 * external editor, and on a clean (exit 0) read the file back via
 * {@link ExternalEditorDeps.setText}. Cancels (non-zero exit or spawn error)
 * leave the buffer untouched. Always cleans up the temp file, restarts the
 * TUI, and forces a full re-render (the external editor used the alternate
 * screen). Returns `true` when the buffer was replaced.
 *
 * Synchronous key routers should fire this and forget (`void`), then refresh
 * on resolution - it awaits an external process and cannot block the router.
 */
export async function openInExternalEditor(deps: ExternalEditorDeps): Promise<boolean> {
  const command = resolveExternalEditorCommand({
    explicit: deps.command,
    visual: process.env.VISUAL,
    editor: process.env.EDITOR,
  });
  const tmpFile = path.join(os.tmpdir(), `pi-ext-editor-${Date.now()}.${deps.ext ?? 'md'}`);
  let changed = false;
  try {
    fs.writeFileSync(tmpFile, deps.getText(), 'utf-8');
    deps.tui.stop();

    const [bin, ...args] = command.split(' ');
    process.stdout.write(`Launching external editor: ${command}\nPi will resume when the editor exits.\n`);

    // Do not use spawnSync: on Windows a synchronous child can keep libuv's
    // console read active after tui.stop() and race the editor for stdin
    // (see pi's extension-editor.ts for the same note).
    const status = await new Promise<number | null>((resolve) => {
      const child = spawn(bin ?? '', [...args, tmpFile], { stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code));
    });

    if (status === 0) {
      deps.setText(fs.readFileSync(tmpFile, 'utf-8').replace(/\n$/, ''));
      changed = true;
    }
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Best-effort cleanup.
    }
    deps.tui.start();
    deps.tui.requestRender(true);
  }
  return changed;
}
