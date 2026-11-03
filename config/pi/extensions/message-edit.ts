/** Reversible, branch-local text overlays with a searchable /context-edit browser. */
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { applyDirectives } from '../../../lib/node/pi/context-edit/apply.ts';
import { completeCandidatesOrVerbs } from '../../../lib/node/pi/context-edit/complete.ts';
import {
  addEdit,
  clearDirectives,
  cloneState,
  type ContextEditState,
  removeDirective,
} from '../../../lib/node/pi/context-edit/directive.ts';
import {
  buildMessageEditItems,
  filterMessageEditItems,
  type MessageEditItem,
  parseEditId,
} from '../../../lib/node/pi/context-edit/messages.ts';
import { type LooseMessage, targetsEqual } from '../../../lib/node/pi/context-edit/target.ts';
import { CONTEXT_EDIT_USAGE } from '../../../lib/node/pi/context-edit/usage.ts';
import { createContextEditRuntime } from '../../../lib/node/pi/ext/context-edit-runtime.ts';
import {
  MessageEditOverlay,
  type MessageEditOverlayOptions,
  type MessageEditResult,
} from '../../../lib/node/pi/ext/message-edit-overlay.ts';
import { showModal } from '../../../lib/node/pi/ext/show-modal.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { collapseWhitespace, truncate } from '../../../lib/node/pi/shared.ts';

const CUSTOM_TYPE = 'message-edit-state';

function itemLabel(item: MessageEditItem): string {
  return `${item.id} ${item.role}${item.editId !== undefined ? ` [edited #${item.editId}]` : ''}${item.stale ? ' [stale]' : ''}: ${truncate(collapseWhitespace(item.text), 100)}`;
}

export default function messageEditExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_MESSAGE_EDIT_DISABLED)) return;

  let sortPref: 'order' | 'size' = 'order';
  let lastCtx: ExtensionContext | undefined;
  let generation = 0;
  let cache: { leaf: string | null; state: ContextEditState; items: MessageEditItem[] } | undefined;
  // The shared runtime owns branch recovery and context projection. This command
  // derives its browser/completions from the session, never the pre-reply snapshot.
  const rt = createContextEditRuntime({ pi, customType: CUSTOM_TYPE, candidatesFrom: () => [] });

  const itemsFor = (ctx: ExtensionContext): MessageEditItem[] => {
    const leaf = ctx.sessionManager.getLeafId();
    const state = rt.getState();
    if (cache?.leaf === leaf && cache.state === state) return cache.items;
    const built = buildSessionContext(ctx.sessionManager.getEntries(), leaf);
    const items = buildMessageEditItems(built.messages as unknown as LooseMessage[], state, sortPref);
    cache = { leaf, state, items };
    return items;
  };

  const rebuild = (ctx: ExtensionContext): void => {
    generation++;
    lastCtx = ctx;
    cache = undefined;
    rt.rebuildFromSession(ctx);
  };
  pi.on('session_start', (_event, ctx) => rebuild(ctx));
  pi.on('session_tree', (_event, ctx) => rebuild(ctx));
  pi.on('session_compact', (_event, ctx) => rebuild(ctx));
  pi.on('session_shutdown', () => {
    generation++;
    lastCtx = undefined;
    cache = undefined;
  });

  pi.on('context', (event) => {
    const messages = rt.readContextMessages(event);
    if (!messages) return undefined;
    const result = applyDirectives(messages, rt.getState().directives);
    return rt.finishContext(result.messages, result.applied);
  });

  // Publish only after append succeeds. A failed save/restore leaves both the
  // prior overlay and the user's draft intact, rather than reporting success.
  const commit = (next: ContextEditState, message: string): MessageEditResult => {
    try {
      pi.appendEntry(CUSTOM_TYPE, cloneState(next));
      rt.setState(next);
      cache = undefined;
      return { ok: true, message };
    } catch (error) {
      return { ok: false, message: `Not saved: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const restore = (id: number): MessageEditResult => {
    if (!rt.getState().directives.some((d) => d.kind === 'edit' && d.id === id)) {
      return { ok: false, message: `Edit #${id} not found.` };
    }
    const result = removeDirective(rt.getState(), id);
    return result.ok
      ? commit(result.state, `Restored #${id}. Original text applies to future model requests.`)
      : { ok: false, message: result.error };
  };

  const openBrowser = async (ctx: ExtensionContext, options: MessageEditOverlayOptions): Promise<void> => {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Editing needs an interactive terminal UI.', 'warning');
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify('Wait for the current response to finish before editing context.', 'warning');
      return;
    }
    const openedGeneration = generation;
    const check = (): boolean => openedGeneration === generation;
    await showModal<void>(
      ctx.ui,
      (tui, theme, kb, done) =>
        new MessageEditOverlay(
          {
            getItems: () => (check() ? itemsFor(ctx) : []),
            save: (item, text) => {
              if (!check()) return { ok: false, message: 'Session or branch changed. Close and reopen /context-edit.' };
              const current = itemsFor(ctx).find((candidate) => candidate.key === item.key && !candidate.stale);
              if (!current || current.text !== item.text)
                return { ok: false, message: 'Message changed. Cancel and reopen the editor.' };
              const result = addEdit(rt.getState(), current.target, text, 'steering', Date.now());
              if (!result.ok) return { ok: false, message: result.error };
              const id = result.state.directives.find(
                (d) => d.kind === 'edit' && targetsEqual(d.target, current.target),
              )!.id;
              const durability = ctx.sessionManager.getSessionFile() ? '' : ' This session is not disk-backed.';
              return commit(
                result.state,
                `Saved ${current.id}${id !== undefined ? ` as edit #${id}` : ''}. Future context only.${durability} Undo: /context-edit restore ${id}`,
              );
            },
            restore: (id) =>
              check() ? restore(id) : { ok: false, message: 'Session or branch changed. Reopen /context-edit.' },
          },
          theme,
          tui,
          kb,
          done,
          options,
        ),
    );
  };

  pi.registerCommand('context-edit', {
    description: 'Browse, edit, compare, and restore message text without losing later turns',
    getArgumentCompletions: (prefix) => {
      let items: MessageEditItem[] = [];
      try {
        if (lastCtx) items = itemsFor(lastCtx);
      } catch {
        // Completion must not interrupt typing. The command surfaces errors.
      }
      const verbs = {
        list: { description: 'Browse active edits' },
        sort: { description: 'List by message order or size', args: () => [{ label: 'order' }, { label: 'size' }] },
        restore: {
          description: 'Restore an edit by #id',
          args: () =>
            items
              .filter((item) => item.editId !== undefined)
              .map((item) => ({ label: String(item.editId), description: itemLabel(item) })),
        },
        clear: { description: 'Restore all edits' },
      };
      if (prefix.includes(' ') && !(prefix.split(/\s+/)[0] in verbs)) {
        const matches = filterMessageEditItems(items, prefix).filter((item) => !item.stale);
        return matches.length
          ? matches.map((item) => ({ value: item.id, label: item.id, description: itemLabel(item) }))
          : null;
      }
      return completeCandidatesOrVerbs(
        prefix,
        items
          .filter((item) => !item.stale)
          .map((item) => ({ id: item.id, description: itemLabel(item), search: `${item.text}\n${item.original}` })),
        verbs,
      );
    },
    handler: async (args, ctx) => {
      lastCtx = ctx;
      if (isHelpArg(args)) {
        ctx.ui.notify(CONTEXT_EDIT_USAGE, 'info');
        return;
      }
      const raw = args.trim();
      const [verb, ...rest] = raw.split(/\s+/);
      const tail = rest.join(' ');
      const notify = (result: MessageEditResult): void => ctx.ui.notify(result.message, result.ok ? 'info' : 'error');
      try {
        if (verb === 'restore') {
          const id = parseEditId(tail);
          if (id === null)
            ctx.ui.notify('Use /context-edit restore <id> or <#id>, with a positive integer.', 'warning');
          else notify(restore(id));
          return;
        }
        if (verb === 'clear') {
          if (tail) {
            ctx.ui.notify('Usage: /context-edit clear', 'warning');
            return;
          }
          const result = clearDirectives(rt.getState(), 'edit');
          if (result.ok)
            notify(commit(result.state, `${result.summary}. Original text applies to future model requests.`));
          return;
        }
        if (verb === 'sort') {
          if (!tail) ctx.ui.notify(`Listing order: ${sortPref}. Use /context-edit sort order|size.`, 'info');
          else if (tail !== 'order' && tail !== 'size') ctx.ui.notify('sort takes "size" or "order".', 'warning');
          else {
            sortPref = tail;
            cache = undefined;
            ctx.ui.notify(`Listing order: ${sortPref}.`, 'info');
          }
          return;
        }
        if (verb === 'list' && tail) {
          ctx.ui.notify('Usage: /context-edit list', 'warning');
          return;
        }
        const items = itemsFor(ctx);
        if (ctx.mode !== 'tui') {
          if (raw === '' || verb === 'list') {
            const shown = verb === 'list' ? items.filter((item) => item.editId !== undefined) : items;
            ctx.ui.notify(
              shown.length ? shown.map(itemLabel).join('\n') : 'No matching messages or active edits.',
              'info',
            );
          } else ctx.ui.notify('Editing needs an interactive terminal UI.', 'warning');
          return;
        }
        if (raw === '' || verb === 'list') {
          await openBrowser(ctx, { editedOnly: verb === 'list' });
        } else {
          const direct = items.find((item) => item.id === raw && !item.stale);
          if (/^msg\d+$/.test(raw) && !direct) {
            ctx.ui.notify(`Unknown message "${raw}". Run /context-edit to browse.`, 'warning');
            return;
          }
          await openBrowser(ctx, direct ? { editKey: direct.key } : { query: raw });
        }
      } catch (error) {
        ctx.ui.notify(`Context edit failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    },
  });
}
