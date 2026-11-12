/**
 * TUI part of context-edit: the `/context-edit` picker. One dialog lists
 * collapsible tool output and droppable images (heaviest first) next to
 * the active edits; picking a candidate edits it, picking an active edit
 * restores it, and `ctrl+r` restores everything. Data and mutations go
 * through the server part over RPC (./rpc.ts). Also surfaces the model
 * tools' permission prompts and edits as toasts.
 */

import { Plugin } from '@opencode/plugin/tui';
import { formatCompactBytes } from '../../../../lib/node/pi/shared/bytes.ts';

import {
  CONTEXT_EDIT_PERMISSION,
  directiveRowText,
  parseListOutput,
  parseResultMessage,
} from '../../../../lib/node/opencode/context-edit.ts';
import { ContextEditRpc } from './rpc.ts';

type Choice = { type: 'apply'; key: string } | { type: 'restore'; id: number };

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message;
  return String(err);
}

export default Plugin.define({
  id: 'dotfiles.context-edit.tui',
  setup(context) {
    type Location = ReturnType<typeof context.data.location.default>;
    type Client = ReturnType<typeof context.client.rpc<typeof ContextEditRpc>>;
    const location = (): Location => context.location ?? context.data.location.default();
    // Resolve the client per call; it is replaced when the TUI reconnects.
    const rpc = (): Client => context.client.rpc(ContextEditRpc);
    const toast = (message: string, variant: 'info' | 'success' | 'error' = 'info', duration?: number): void => {
      context.ui.toast.show({ title: 'context-edit', message, variant, duration });
    };
    const currentSession = (): string | undefined => {
      const route = context.ui.router.current();
      return route.type === 'session' ? route.sessionID : undefined;
    };

    const restoreAll = async (sessionID: string): Promise<void> => {
      const out = await rpc().restore({ sessionID }, { location: location() });
      toast(parseResultMessage(out), 'success');
    };

    const open = async (): Promise<void> => {
      const sessionID = currentSession();
      if (!sessionID) {
        toast('Open a session first.', 'error');
        return;
      }
      const list = parseListOutput(await rpc().list({ sessionID }, { location: location() }));
      if (list.candidates.length === 0 && list.directives.length === 0) {
        toast('Nothing to edit: no large tool output or images in context.');
        return;
      }
      const choice = await context.ui.dialog.select<Choice>({
        title: 'Context edit (overlay; history is untouched)',
        placeholder: 'Filter',
        options: [
          ...list.directives.map((d) => ({
            title: directiveRowText(d),
            value: { type: 'restore', id: d.id } as Choice,
            category: 'Active edits (select to restore)',
          })),
          ...list.candidates.map((c) => ({
            title: c.label,
            value: { type: 'apply', key: c.key } as Choice,
            description: formatCompactBytes(c.bytes),
            category: c.kind === 'collapse' ? 'Collapse tool output' : 'Drop image',
          })),
        ],
        actions:
          list.directives.length > 0
            ? [
                {
                  bind: 'ctrl+r',
                  title: 'Restore all',
                  selection: 'none',
                  onTrigger: () => {
                    context.ui.dialog.clear();
                    restoreAll(sessionID).catch((err: unknown) => toast(errorText(err), 'error'));
                  },
                },
              ]
            : [],
      });
      if (!choice) return;
      const out =
        choice.type === 'apply'
          ? await rpc().apply({ sessionID, keys: [choice.key] }, { location: location() })
          : await rpc().restore({ sessionID, ids: [choice.id] }, { location: location() });
      toast(parseResultMessage(out), 'success');
    };

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'dotfiles.context-edit.open',
          title: 'Context edit: collapse output, drop images, restore',
          group: 'Context',
          palette: true,
          slash: { name: 'context-edit' },
          run: () => open().catch((err: unknown) => toast(errorText(err), 'error')),
        },
      ],
    }));

    // opencode's prompt for a custom action shows only "Call tool context_edit"; show what would change.
    const stopPermission = context.data.on('permission.asked', (event) => {
      if (event.data.action !== CONTEXT_EDIT_PERMISSION) return;
      const summary: unknown = event.data.metadata?.summary;
      if (typeof summary === 'string') toast(summary, 'info', 15_000);
    });
    const stopChanged = rpc().events.on('changed', (event) => {
      if (event.data.source === 'tool' && typeof event.data.message === 'string') toast(event.data.message, 'success');
    });

    return () => {
      stopPermission();
      stopChanged();
    };
  },
});
