/**
 * TUI part of the memory plugin: a `/memory` slash and palette command
 * that picks a view (list, preview, dir, stale) and shows the server
 * part's report for the current session. Talks to the server over ./rpc.ts.
 */

import { Plugin } from '@opencode/plugin/tui';

import { type MemoryReportView } from '../../../../lib/node/opencode/memory.ts';
import { MemoryRpc } from './rpc.ts';

const TITLE = 'memory';

const VIEWS: readonly { value: MemoryReportView; title: string; description: string }[] = [
  { value: 'list', title: 'List', description: 'Global, project, and session memories' },
  { value: 'preview', title: 'Preview', description: 'What the next prompt delivers to the model' },
  { value: 'dir', title: 'Dir', description: 'Store root, scope dirs, project slug' },
  { value: 'stale', title: 'Stale', description: 'Project memories past staleDays' },
];

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') return err.message;
  return String(err);
}

function reportText(out: unknown): string {
  const text = (out as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : '(no report)';
}

export default Plugin.define({
  id: 'dotfiles.memory.tui',
  setup(context) {
    const toast = (message: string, variant: 'info' | 'error' = 'info'): void => {
      context.ui.toast.show({ title: TITLE, message, variant });
    };

    const open = async (): Promise<void> => {
      const route = context.ui.router.current();
      if (route.type !== 'session') {
        toast('Open a session first.', 'error');
        return;
      }
      const { sessionID } = route;
      const view = await context.ui.dialog.select<MemoryReportView>({
        title: 'Memory',
        placeholder: 'View',
        options: VIEWS.map((v) => ({ title: v.title, value: v.value, description: v.description })),
      });
      if (!view) return;
      const location = context.data.session.get(sessionID)?.location ?? context.location;
      let text: string;
      try {
        text = reportText(await context.client.rpc(MemoryRpc).report({ sessionID, view }, { location }));
      } catch (err) {
        toast(`Server part unavailable: ${errorText(err)}`, 'error');
        return;
      }
      await context.ui.dialog.alert({ title: `Memory: ${view}`, message: text });
    };

    // `global`: the default `base` mode is not active inside a session, so the command would never be reachable.
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'dotfiles.memory.open',
          title: 'Memory: list / preview / dir / stale',
          group: 'Memory',
          palette: true,
          slash: { name: 'memory' },
          run: () => {
            void open();
          },
        },
      ],
    }));
  },
});
