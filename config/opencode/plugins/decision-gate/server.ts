/**
 * Decision-model gate for opencode shell permissions, the opencode side of
 * the pi `bash-permissions` decision-model layer. See ./README.md.
 *
 * Layering: opencode's own rules resolve first (an explicit allow or deny
 * always stands). When a `shell` request resolves to `ask`, the shared
 * System One shell gate may answer `allow`; when it abstains, or is not
 * configured, the ask goes ahead exactly as before.
 *
 * Logic lives in lib/node/decision-model/ (shared with pi) and
 * lib/node/opencode/decision-gate.ts.
 */

import { appendFileSync } from 'node:fs';

import { Plugin } from '@opencode/plugin';

import { createShellDecider } from '../../../../lib/node/decision-model/shell-gate.ts';
import {
  AskTracker,
  askKey,
  CommandStash,
  replyOutcome,
  resolveDecisionGateConfig,
  shellGateInputFor,
} from '../../../../lib/node/opencode/decision-gate.ts';
import { opencodeConfigDir } from '../../../../lib/node/opencode/secret-redactor.ts';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: 'dotfiles.decision-gate',
  async setup(ctx) {
    const config = resolveDecisionGateConfig(ctx.options, process.env, opencodeConfigDir(process.env));
    if (!config.enabled) return;
    const trace = (line: string): void => {
      if (!config.trace) return;
      try {
        appendFileSync(config.trace, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // tracing is best-effort
      }
    };

    const decider = createShellDecider({
      harness: 'opencode',
      configPath: config.configPath,
      defaultLogPath: config.defaultLogPath,
      warn: (message) => {
        console.warn(`[decision-gate] ${message}`);
        trace(`warn ${message}`);
      },
    });
    trace(`config ${decider.status()}`);
    const asks = new AskTracker();
    const stash = new CommandStash();

    // Shell permission runs after `tool.execute.before`, so the full command line is known by then;
    // the permission event itself only carries the parsed sub-commands.
    const toolRegistration = await ctx.tool.hook('execute.before', (event) => {
      if (event.tool === 'shell') stash.record(event.sessionID, event.input);
    });

    const registration = await ctx.permission.hook('evaluate', async (event) => {
      if (event.action !== 'shell') return;
      const input = shellGateInputFor(event, ctx.location.directory, stash.find(event.sessionID, event.resources));
      if (!input) return;
      try {
        const verdict = await decider.evaluate(input);
        trace(
          `evaluate session=${event.sessionID} parts=${event.resources.length} full=${input.command !== event.resources.join('\n')} ` +
            `meta=${Object.keys(event.metadata ?? {}).join(',')} verdict=${verdict.verdict} ${verdict.reason ?? ''}`,
        );
        if (verdict.verdict === 'allow') event.effect = 'allow';
        else if (verdict.id) asks.abstained(askKey(event.sessionID, event.action, event.resources), verdict.id);
      } catch (err) {
        // The gate never throws by design; if it does, leave the ask untouched.
        trace(`evaluate-error ${errorText(err)}`);
      }
    });

    // Pair abstained decisions with the user's reply for the decision log.
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ['permission.asked', 'permission.replied'],
        signal: controller.signal,
      })) {
        if (event.type === 'permission.asked') {
          const { sessionID, action, resources, id } = event.data;
          asks.asked(askKey(sessionID, action, resources), id);
        } else {
          const outcome = replyOutcome(event.data.reply);
          if (outcome) decider.settle(asks.replied(event.data.requestID), outcome, event.data.reply);
        }
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) trace(`subscribe-error ${errorText(err)}`);
    });

    return async () => {
      controller.abort();
      await Promise.all([registration.dispose(), toolRegistration.dispose()]);
    };
  },
});
