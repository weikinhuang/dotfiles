/**
 * Message-edit extension for pi - edit a user or assistant message in
 * place for steering (OpenWebUI-style), WITHOUT dropping downstream
 * turns.
 *
 * One of three extensions on the shared context-edit core
 * (`lib/node/pi/context-edit/`); siblings are `context-trim` (remove
 * bulky content) and `tool-collapse` (collapse a tool call+result). See
 * `context-trim.md` for the shared non-destructive overlay model: the
 * original message stays in the session `.jsonl`, the edit is reapplied
 * each turn in the `context` hook, and it is reconstructed from a
 * persisted `custom` entry on `session_start`, so edits survive `/reload`
 * and exit -> resume. `restore` brings the original back.
 *
 * This is the honest, reversible form of OpenWebUI message editing:
 * because pi's session is append-only, we cannot rewrite history without
 * branching (which deletes everything downstream). An overlay edit keeps
 * every later turn intact - exactly what you want when steering a long
 * conversation. The trade-off is that an edited message stays edited
 * across reload/resume (persistent steering, not a one-shot), and only
 * assistant `text` is editable (not `thinking`).
 *
 * Affordances:
 *
 *   1. `/context-edit` (no args) lists editable user/assistant messages
 *      with a snippet and a handle (msg2).
 *   2. `/context-edit <handle>` opens an editor prefilled with the
 *      message's current text; on submit the edit is stored and applied
 *      from the next turn.
 *   3. `/context-edit list` shows active edits; `restore <#id>` / `clear`
 *      undo them.
 *
 * Pure logic lives under `lib/node/pi/context-edit/`. This file holds
 * only the pi-coupled glue.
 *
 * Environment:
 *   PI_MESSAGE_EDIT_DISABLED=1   skip the extension entirely
 */

import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { applyDirectives } from '../../../lib/node/pi/context-edit/apply.ts';
import { completeCandidatesOrVerbs, type CompletionCandidate } from '../../../lib/node/pi/context-edit/complete.ts';
import {
  addEdit,
  clearDirectives,
  type ContextEditState,
  cloneState,
  emptyState,
  reduceBranch,
  removeDirective,
} from '../../../lib/node/pi/context-edit/directive.ts';
import { type Candidate, candidateLabel, enumerate } from '../../../lib/node/pi/context-edit/enumerate.ts';
import { type LooseMessage, resolveTarget, type Target, toParts } from '../../../lib/node/pi/context-edit/target.ts';
import { CONTEXT_EDIT_USAGE } from '../../../lib/node/pi/context-edit/usage.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

const CUSTOM_TYPE = 'message-edit-state';

/** Concatenate the text parts of a message into one editable string. */
function messageText(messages: readonly LooseMessage[], target: Target): string | null {
  const hit = resolveTarget(messages, target);
  if (!hit) return null;
  const parts = toParts(messages[hit.messageIndex].content);
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type === 'text' && typeof (p as { text?: unknown }).text === 'string') {
      texts.push((p as { text: string }).text);
    }
  }
  return texts.join('\n');
}

export default function messageEditExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_MESSAGE_EDIT_DISABLED)) return;

  let state: ContextEditState = emptyState();
  let lastContextMessages: LooseMessage[] | null = null;
  // Listing / completion order for the editable-message picker. Editing
  // for steering reads naturally in conversation order, so default to
  // `order`; `/context-edit sort size` switches to heaviest-first.
  let sortPref: 'order' | 'size' = 'order';
  // Candidate handles for the Tab-completion menu (getArgumentCompletions
  // receives no ctx), refreshed from the context hook and after commands.
  let completionCandidates: CompletionCandidate[] = [];

  const rebuildFromSession = (ctx: ExtensionContext): void => {
    state = reduceBranch(ctx.sessionManager.getBranch() as never, CUSTOM_TYPE);
  };

  pi.on('session_start', (_event, ctx) => rebuildFromSession(ctx));
  pi.on('session_tree', (_event, ctx) => rebuildFromSession(ctx));

  // Only user/assistant message candidates are editable.
  const candidatesFrom = (messages: readonly LooseMessage[]): Candidate[] =>
    enumerate(messages, { minTextBytes: 1, sort: sortPref }).filter((c) => c.kind === 'message');

  const refreshCompletion = (cands: readonly Candidate[]): void => {
    completionCandidates = cands.map((c) => ({ id: c.id, description: candidateLabel(c) }));
  };

  pi.on('context', (event) => {
    const messages = (event as unknown as { messages?: LooseMessage[] }).messages;
    if (!Array.isArray(messages)) return undefined;
    lastContextMessages = messages;
    let out = messages;
    let applied = 0;
    if (state.directives.length > 0) {
      const result = applyDirectives(messages, state.directives);
      lastContextMessages = result.messages;
      out = result.messages;
      applied = result.applied;
    }
    refreshCompletion(candidatesFrom(out));
    return applied > 0 ? { messages: out as never } : undefined;
  });

  const currentMessages = (ctx: ExtensionContext): LooseMessage[] => {
    // Build fresh from the session every call so the newest assistant turn
    // is editable. The `context`-hook snapshot (`lastContextMessages`) is
    // built BEFORE the reply it produces, so it always lags one assistant
    // message behind - relying on it here is what hid the latest reply from
    // the edit list. Active edits are reapplied so the editor prefill shows
    // the current (already-steered) text, not the original.
    try {
      const built = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
      const msgs = (built.messages as unknown as LooseMessage[]) ?? [];
      return state.directives.length > 0 ? (applyDirectives(msgs, state.directives).messages) : msgs;
    } catch {
      return lastContextMessages ?? [];
    }
  };

  const editCandidates = (ctx: ExtensionContext): Candidate[] => {
    const cands = candidatesFrom(currentMessages(ctx));
    refreshCompletion(cands);
    return cands;
  };

  const persist = (): void => {
    try {
      pi.appendEntry(CUSTOM_TYPE, cloneState(state));
    } catch {
      // Never let bookkeeping break the command.
    }
    lastContextMessages = null;
  };

  const listCandidates = (ctx: ExtensionContext): string => {
    const cands = editCandidates(ctx);
    if (cands.length === 0) return 'No editable messages in the current context.';
    const lines = cands.map((c) => `  ${c.id}  ${candidateLabel(c)}`);
    return [
      `Editable messages (${sortPref} order):`,
      ...lines,
      '',
      'Edit with: /context-edit <id>   ·   reorder: /context-edit sort size|order',
    ].join('\n');
  };

  const listActive = (): string => {
    const edits = state.directives.filter((d) => d.kind === 'edit');
    if (edits.length === 0) return 'No active edits.';
    return ['Active edits:', ...edits.map((d) => `  #${d.id}  ${d.reason ?? '(steering)'}`)].join('\n');
  };

  pi.registerCommand('context-edit', {
    description: 'Edit a user/assistant message in place (overlay, reversible) for steering',
    getArgumentCompletions: (prefix) =>
      completeCandidatesOrVerbs(prefix, completionCandidates, {
        list: { description: 'Show active edits' },
        sort: {
          description: 'List by message order or size',
          args: () => [{ label: 'order' }, { label: 'size' }],
        },
        restore: {
          description: 'Undo an edit by #id',
          args: () => state.directives.filter((d) => d.kind === 'edit').map((d) => ({ label: String(d.id) })),
        },
        clear: { description: 'Undo all edits' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(CONTEXT_EDIT_USAGE, 'info');
        return;
      }
      const raw = (args ?? '').trim();
      if (raw === '') {
        ctx.ui.notify(listCandidates(ctx), 'info');
        return;
      }

      const [verb, ...rest] = raw.split(/\s+/);
      const tail = rest.join(' ');

      if (verb === 'list') {
        ctx.ui.notify(listActive(), 'info');
        return;
      }
      if (verb === 'sort') {
        const choice = tail.trim().toLowerCase();
        if (choice === '') {
          ctx.ui.notify(`Listing order: ${sortPref} (change with /context-edit sort size|order)`, 'info');
          return;
        }
        if (choice !== 'size' && choice !== 'order') {
          ctx.ui.notify('sort takes "size" or "order" (e.g. /context-edit sort order)', 'warning');
          return;
        }
        sortPref = choice;
        ctx.ui.notify(listCandidates(ctx), 'info');
        return;
      }
      if (verb === 'clear') {
        const r = clearDirectives(state, 'edit');
        if (r.ok) {
          state = r.state;
          persist();
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }
      if (verb === 'restore') {
        const id = Number.parseInt(tail, 10);
        if (!Number.isFinite(id)) {
          ctx.ui.notify('restore needs a numeric #id (see /context-edit list)', 'warning');
          return;
        }
        const r = removeDirective(state, id);
        if (r.ok) {
          state = r.state;
          persist();
        }
        ctx.ui.notify(r.ok ? r.summary : r.error, r.ok ? 'info' : 'warning');
        return;
      }

      // Treat the first token as a candidate handle and open the editor.
      const messages = currentMessages(ctx);
      const cand = editCandidates(ctx).find((c) => c.id === verb);
      if (!cand?.target) {
        ctx.ui.notify(`Unknown message "${verb}". Run /context-edit to list handles.`, 'warning');
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify('Editing needs an interactive UI.', 'warning');
        return;
      }
      const original = messageText(messages, cand.target) ?? '';
      const edited = await ctx.ui.editor(`Edit ${cand.role} message`, original);
      if (edited === undefined) {
        ctx.ui.notify('Edit cancelled.', 'info');
        return;
      }
      if (edited === original) {
        ctx.ui.notify('No change.', 'info');
        return;
      }
      const r = addEdit(state, cand.target, edited, 'steering', Date.now());
      if (r.ok) {
        state = r.state;
        persist();
        ctx.ui.notify(`${r.summary} (${cand.role} message overlaid; original kept in session)`, 'info');
      } else {
        ctx.ui.notify(r.error, 'warning');
      }
    },
  });
}
