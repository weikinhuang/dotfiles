/**
 * Desktop notifications for opencode, ported from the pi `notify` extension
 * (config/pi/extensions/notify.ts). See ./README.md.
 *
 * - `notify` tool (direct, not codemode, no permission gate): the model pings
 *   the user mid-turn.
 * - Lifecycle: when a root-session execution ends, notify on error / abort,
 *   or on success after `minSeconds`; skipped when the tool already fired.
 *
 * Delivery shells out to the repo's `quick-toast` bin script, detached and
 * fire-and-forget. Logic lives in lib/node/opencode/notify.ts.
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { Plugin } from '@opencode/plugin';

import {
  buildNotifyToolCall,
  createTurnTracker,
  decideTurnNotification,
  NOTIFY_TOOL_DESCRIPTION,
  NOTIFY_TOOL_INPUT_SCHEMA,
  resolveOpencodeNotifyConfig,
  type TurnOutcome,
} from '../../../../lib/node/opencode/notify.ts';
import { cacheParentLookup, resolveRootSessionID } from '../../../../lib/node/opencode/session-tree.ts';
import { type NotificationContent } from '../../../../lib/node/pi/notify/desktop.ts';

const EVENT_TYPES = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.text.ended',
  'session.deleted',
] as const;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: 'dotfiles.notify',
  async setup(ctx) {
    const config = resolveOpencodeNotifyConfig(ctx.options, process.env);
    if (!config.enabled) return;

    const cwd = ctx.location.directory;
    const tracker = createTurnTracker();
    const parentOf = cacheParentLookup(async (sessionID) => (await ctx.session.get({ sessionID })).parentID);

    const trace = (line: string): void => {
      if (!config.trace) return;
      try {
        appendFileSync(config.trace, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // tracing is best-effort
      }
    };

    const fire = ({ title, body }: NotificationContent): void => {
      try {
        const child = spawn(config.command, [title, body], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => trace(`spawn-error ${errorText(err)}`));
        child.unref();
      } catch (err) {
        trace(`spawn-throw ${errorText(err)}`);
      }
    };

    if (config.tool) {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: 'notify',
          description: NOTIFY_TOOL_DESCRIPTION,
          input: NOTIFY_TOOL_INPUT_SCHEMA,
          options: { codemode: false },
          execute: async (input, context) => {
            const call = buildNotifyToolCall(input, cwd, config.titlePrefix);
            if (!call.ok) throw new Error(call.error);
            const { title, body } = call.content;
            trace(`tool session=${context.sessionID} title=${JSON.stringify(title)} body=${JSON.stringify(body)}`);
            fire(call.content);
            // Suppress the lifecycle ping of the user-facing (root) turn, even when a subagent called the tool.
            const root = await resolveRootSessionID(context.sessionID, parentOf).catch(() => context.sessionID);
            tracker.markToolFired(root);
            return { content: `Notified the user: ${title} - ${body}` };
          },
        });
      });
    }

    if (!config.lifecycle) return;

    const finish = async (sessionID: string, outcome: TurnOutcome): Promise<void> => {
      const result = tracker.finish(sessionID);
      if (result.duplicate) return;
      let isRoot = true;
      try {
        isRoot = (await parentOf(sessionID)) === undefined;
      } catch (err) {
        trace(`lookup-error session=${sessionID} ${errorText(err)}`);
      }
      const decision = decideTurnNotification({
        state: result.state,
        outcome,
        isRoot,
        now: Date.now(),
        minSeconds: config.minSeconds,
        cwd,
        titlePrefix: config.titlePrefix,
      });
      if (!decision.notify) {
        trace(
          `skip session=${sessionID} outcome=${outcome.kind} reason=${decision.reason} elapsed=${decision.elapsedMs}ms`,
        );
        return;
      }
      trace(
        `notify session=${sessionID} outcome=${outcome.kind} elapsed=${decision.elapsedMs}ms title=${JSON.stringify(decision.title)} body=${JSON.stringify(decision.body)}`,
      );
      fire(decision);
    };

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: [...EVENT_TYPES], signal: controller.signal })) {
        const { sessionID } = event.data;
        switch (event.type) {
          case 'session.execution.started':
            tracker.start(sessionID, Date.now());
            break;
          case 'session.text.ended':
            tracker.text(sessionID, event.data.text);
            break;
          case 'session.execution.succeeded':
            await finish(sessionID, { kind: 'succeeded' });
            break;
          case 'session.execution.failed':
            await finish(sessionID, { kind: 'failed', message: event.data.error.message });
            break;
          case 'session.execution.interrupted':
            await finish(sessionID, { kind: 'interrupted', reason: event.data.reason });
            break;
          case 'session.deleted':
            tracker.forget(sessionID);
            break;
        }
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) trace(`subscribe-error ${errorText(err)}`);
    });

    return () => controller.abort();
  },
});
