/**
 * Desktop notification on turn completion for pi.
 *
 * Mirrors Claude Code's "the agent is waiting for you" OS notification: when
 * an agent loop ends after running long enough that you've probably tabbed
 * away (default 30s, PI_NOTIFY_MIN_SECONDS) - or whenever it ends in an error
 * / abort regardless of duration - it fires a native desktop notification
 * whose body is the first line of pi's final reply.
 *
 * Platform detection is delegated to the repo's `quick-toast` bin script
 * (darwin / linux / wsl variants, all on $PATH), so this stays a thin trigger
 * with zero per-OS escape-sequence logic. Override the binary with
 * PI_NOTIFY_COMMAND if you want a different notifier; it is invoked as
 * `<command> <title> <body>`.
 *
 * Alongside the lifecycle notification it registers a model-callable `notify`
 * tool (pi's analog of Claude Code's `PushNotification`) so the agent can
 * reach you mid-turn - flagging a blocking decision or a milestone in a
 * long-running task. When the tool fires during a turn, the lifecycle
 * notification for that same turn is suppressed to avoid a double ping.
 *
 * Environment:
 *   PI_NOTIFY_DISABLED=1         skip the extension entirely (lifecycle + tool)
 *   PI_NOTIFY_TOOL_DISABLED=1    keep lifecycle notifications, drop the `notify` tool
 *   PI_NOTIFY_MIN_SECONDS=<n>    min successful-turn duration to notify (default 30)
 *   PI_NOTIFY_COMMAND=<cmd>      notifier binary (default: quick-toast)
 *   PI_NOTIFY_TITLE_PREFIX=<s>   title prefix before the project name (default: pi)
 *   PI_NOTIFY_VERBOSE=1          ctx.ui.notify every decision
 *   PI_NOTIFY_TRACE=<path>       append one line per decision to <path>
 *                                (useful in -p / RPC modes where notify is a no-op)
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import {
  buildNotification,
  buildToolNotification,
  resolveNotifyConfig,
  shouldNotify,
  summarizeTurn,
} from '../../../lib/node/pi/notify/desktop.ts';

const NotifyParams = Type.Object({
  message: Type.String({
    description: 'The notification body the user will see. One short, specific line is best.',
  }),
  title: Type.Optional(
    Type.String({
      description: 'Optional short heading. Defaults to the project name.',
    }),
  ),
});

function fireNotification(command: string, title: string, body: string, trace: (line: string) => void): void {
  try {
    const child = spawn(command, [title, body], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      trace(`spawn-error ${err instanceof Error ? err.message : String(err)}`);
    });
    child.unref();
  } catch (err) {
    trace(`spawn-throw ${err instanceof Error ? err.message : String(err)}`);
  }
}

export default function extension(pi: ExtensionAPI): void {
  const config = resolveNotifyConfig(process.env);
  if (config.disabled) return;

  let turnStart: number | null = null;
  let toolFiredThisTurn = false;

  function trace(line: string): void {
    if (!config.trace) return;
    try {
      appendFileSync(config.trace, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // tracing is best-effort; never let it break a turn
    }
  }

  pi.on('agent_start', async () => {
    turnStart = Date.now();
    toolFiredThisTurn = false;
  });

  pi.on('agent_end', async (event, ctx) => {
    const elapsedMs = turnStart === null ? 0 : Date.now() - turnStart;
    turnStart = null;

    // The model already pinged the user this turn via the tool; don't double up.
    if (toolFiredThisTurn) {
      trace(`skip tool-fired-this-turn elapsed=${elapsedMs}ms`);
      toolFiredThisTurn = false;
      return;
    }

    const messages = (event as { messages?: readonly unknown[] }).messages ?? [];
    const summary = summarizeTurn(messages);

    if (!shouldNotify({ elapsedMs, minSeconds: config.minSeconds, errored: summary.errored })) {
      trace(`skip elapsed=${elapsedMs}ms errored=${summary.errored}`);
      return;
    }

    const { title, body } = buildNotification({ summary, cwd: process.cwd(), titlePrefix: config.titlePrefix });
    trace(
      `notify elapsed=${elapsedMs}ms errored=${summary.errored} title=${JSON.stringify(title)} body=${JSON.stringify(body)}`,
    );
    if (config.verbose) ctx.ui.notify(`notify: ${title} - ${body}`, 'info');
    fireNotification(config.command, title, body, trace);
  });

  if (config.toolDisabled) return;

  pi.registerTool({
    name: 'notify',
    label: 'Notify',
    description:
      'Send the user a desktop notification. Use sparingly - only when you have likely been left unattended and need a decision to continue, or to flag a milestone in a long-running task. Routine progress belongs in your normal reply, not here.',
    promptSnippet:
      'Ping the user with a desktop notification when you are blocked on a decision or hit a milestone in a long task.',
    parameters: NotifyParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const message = params.message.trim();
      if (!message) {
        return {
          content: [{ type: 'text', text: 'Error: message must not be empty.' }],
          details: undefined,
          isError: true,
        };
      }
      const { title, body } = buildToolNotification({
        message,
        title: params.title,
        cwd: process.cwd(),
        titlePrefix: config.titlePrefix,
      });
      trace(`tool title=${JSON.stringify(title)} body=${JSON.stringify(body)}`);
      if (config.verbose) ctx.ui.notify(`notify(tool): ${title} - ${body}`, 'info');
      fireNotification(config.command, title, body, trace);
      toolFiredThisTurn = true;
      return { content: [{ type: 'text', text: `Notified the user: ${title} - ${body}` }], details: undefined };
    },
  });
}
