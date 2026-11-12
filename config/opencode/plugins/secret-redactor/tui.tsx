/**
 * TUI part of the secret-redactor plugin: a `/secret-redactor` slash and
 * palette command that lists the secrets redacted in the current session
 * (label + handle + state, never the value) and reveals a selected one to
 * the model after a confirmation. Talks to the server part over ./rpc.ts.
 */

import { Plugin } from '@opencode/plugin/tui';

import { parseSecretRedactorStatus } from '../../../../lib/node/opencode/secret-redactor.ts';
import { SecretRedactorRpc } from './rpc.ts';

const TITLE = 'secret-redactor';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: 'dotfiles.secret-redactor.tui',
  setup(context) {
    const toast = (message: string, variant: 'info' | 'success' | 'error' = 'info'): void => {
      context.ui.toast.show({ title: TITLE, message, variant });
    };

    const show = async (): Promise<void> => {
      const route = context.ui.router.current();
      if (route.type !== 'session') {
        toast('Open a session first.');
        return;
      }
      const { sessionID } = route;
      const location = context.data.session.get(sessionID)?.location ?? context.location;
      const rpc = context.client.rpc(SecretRedactorRpc);
      let status: ReturnType<typeof parseSecretRedactorStatus>;
      try {
        status = parseSecretRedactorStatus(await rpc.status({ sessionID }, { location }));
      } catch (err) {
        toast(`Server part unavailable: ${errorText(err)}`, 'error');
        return;
      }
      if (status.secrets.length === 0) {
        await context.ui.dialog.alert({
          title: TITLE,
          message: `No secrets redacted in this session.\n${status.summary}`,
        });
        return;
      }
      const handle = await context.ui.dialog.select({
        title: 'Redacted secrets (Enter reveals)',
        placeholder: status.summary,
        options: status.secrets.map((s) => ({
          title: `${s.label}#${s.handle}`,
          value: s.handle,
          description: s.state,
          disabled: s.state === 'revealed',
        })),
      });
      const secret = status.secrets.find((s) => s.handle === handle);
      if (!secret) return;
      const confirmed = await context.ui.dialog.confirm({
        title: 'Reveal this secret to the model?',
        message: `[${secret.label}#${secret.handle}] will be sent to the provider in future requests of this session.`,
        label: { confirm: 'Reveal', cancel: 'Cancel' },
      });
      if (!confirmed) return;
      try {
        await rpc.reveal({ sessionID, handle: secret.handle }, { location });
        toast(`Revealed [${secret.label}#${secret.handle}]; it is no longer redacted in this session.`, 'success');
      } catch (err) {
        toast(`Reveal failed: ${errorText(err)}`, 'error');
      }
    };

    // `global`: the default `base` mode is not active inside a session, so the command would never be reachable.
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'dotfiles.secret-redactor.status',
          title: 'Secret redactor: list / reveal secrets',
          group: 'Secret redactor',
          palette: true,
          slash: { name: 'secret-redactor', aliases: ['unredact'] },
          run: () => {
            void show();
          },
        },
      ],
    }));
  },
});
