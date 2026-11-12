/**
 * TUI half of cost-guard: shows the server's warnings as toasts and a
 * `cost:warning` / `cost:critical` contribution in the prompt footer status
 * row. State arrives over the `dotfiles.cost-guard` RPC (`update` events,
 * `status` method on first render of a session). See ./README.md.
 */

import { Plugin } from '@opencode/plugin/tui';
import type { RGBA } from '@opentui/core';
import { createSignal, Show } from 'solid-js';

import {
  type GuardLevel,
  parseStatusOutput,
  parseUpdateEvent,
  statusLabel,
} from '../../../../lib/node/opencode/cost-guard.ts';
import { CostGuardRpc } from './rpc.ts';

const TOAST_MS = 10_000;

export default Plugin.define({
  id: 'dotfiles.cost-guard',
  setup(context) {
    const rpc = context.client.rpc(CostGuardRpc);
    const [levels, setLevels] = createSignal<Readonly<Record<string, GuardLevel>>>({});
    const requested = new Set<string>();
    const setLevel = (root: string, level: GuardLevel): void => {
      setLevels((current) => ({ ...current, [root]: level }));
    };

    const stop = rpc.events.on('update', (event) => {
      const update = parseUpdateEvent(event.data);
      if (!update) return;
      requested.add(update.sessionID);
      setLevel(update.sessionID, update.status);
      if (update.message) {
        context.ui.toast.show({
          title: 'Cost guard',
          message: update.message,
          variant: update.variant ?? 'warning',
          duration: TOAST_MS,
          sessionID: update.sessionID,
        });
      }
    });

    // Fetch state once per root the first time its prompt renders (e.g. after reopening a session).
    const request = (root: string): void => {
      if (requested.has(root)) return;
      requested.add(root);
      const directory =
        context.data.session.get(root)?.location.directory ??
        (context.location ?? context.data.location.default()).directory;
      rpc
        .status({ sessionID: root }, { location: { directory } })
        .then((output) => {
          const status = parseStatusOutput(output);
          if (status?.known) setLevel(status.sessionID, status.status);
        })
        .catch(() => requested.delete(root));
    };

    const disposeSlot = context.ui.slot({
      append: 'prompt.footer.status',
      render: (input) => {
        const label = (): string | undefined => {
          if (!input.sessionID) return undefined;
          const root = context.data.session.root(input.sessionID);
          request(root);
          return statusLabel(levels()[root]);
        };
        const color = (): RGBA =>
          levels()[context.data.session.root(input.sessionID ?? '')] === 'critical'
            ? context.theme.text.feedback.error.base
            : context.theme.text.feedback.warning.base;
        return (
          <Show when={label()}>
            {(text) => (
              <box flexShrink={0}>
                <text fg={color()}>{text()}</text>
              </box>
            )}
          </Show>
        );
      },
    });

    return () => {
      stop();
      disposeSlot();
    };
  },
});
