/**
 * Secret redaction for opencode, ported from the pi `secret-redactor`
 * extension (config/pi/extensions/secret-redactor.ts). See ./README.md.
 *
 * - Every model request (`context`, `compaction`, `generate`, `title`
 *   session hooks) is redacted in its outgoing copy only; persisted history
 *   keeps the real values.
 * - A tool call whose input references a placeholder is rehydrated in
 *   `tool.execute.before` after a `secret_unredact` permission check, so
 *   opencode's native ask / allow-always / config rules apply.
 * - The TUI part (`./tui.tsx`) lists and reveals secrets over `./rpc.ts`.
 *
 * Logic lives in lib/node/opencode/secret-redactor*.ts and the shared
 * detectors in lib/node/pi/secret-redactor/.
 */

import { appendFileSync } from 'node:fs';

import { Plugin } from '@opencode/plugin';

import {
  buildUnredactPermission,
  describeRedactorConfig,
  opencodeConfigDir,
  parseSecretRedactorRpcInput,
  REQUEST_HOOK_KINDS,
  resolveSecretRedactorConfig,
  secretRedactorConfigFiles,
  SecretRedactorEngine,
  secretRef,
  UNREDACT_ACTION,
  UNREDACT_DENIED_MESSAGE,
  unredactAskRuleIndex,
} from '../../../../lib/node/opencode/secret-redactor.ts';
import { cacheParentLookup, resolveRootSessionID } from '../../../../lib/node/opencode/session-tree.ts';
import { SecretRedactorRpc } from './rpc.ts';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: 'dotfiles.secret-redactor',
  async setup(ctx) {
    const files = secretRedactorConfigFiles(opencodeConfigDir(process.env), [
      ctx.location.project.directory,
      ctx.location.directory,
    ]);
    const config = resolveSecretRedactorConfig(ctx.options, process.env, files);
    if (!config.enabled) return;

    const append = (path: string | undefined, line: string): void => {
      if (!path) return;
      try {
        appendFileSync(path, `${line}\n`);
      } catch {
        // diagnostics are best-effort
      }
    };
    const trace = (line: string): void => append(config.trace, `${new Date().toISOString()} ${line}`);

    for (const w of config.warnings) {
      console.warn(`[secret-redactor] ${w.path}: ${w.error}`);
      trace(`config-warning ${w.path}: ${w.error}`);
    }
    trace(`config ${describeRedactorConfig(config)} files=${config.files.join(',')}`);

    const engine = new SecretRedactorEngine(config.redactor);
    // Reveals and seen handles are scoped to the root session, so subagents share the parent's view.
    const parentOf = cacheParentLookup(async (sessionID) => (await ctx.session.get({ sessionID })).parentID);
    const scopeOf = (sessionID: string): Promise<string> =>
      resolveRootSessionID(sessionID, parentOf).catch(() => sessionID);

    // A hook covers one request kind; register every kind so compaction summaries and titles are redacted too.
    const redactHook = (kind: (typeof REQUEST_HOOK_KINDS)[number]): Promise<unknown> =>
      ctx.session.hook(kind, async (event) => {
        const scopeID = await scopeOf(event.sessionID);
        const { changed, hits } = engine.redactRequest(scopeID, event);
        if (hits.length > 0) {
          trace(
            `redact kind=${kind} session=${event.sessionID} scope=${scopeID} entries=${changed} ` +
              `secrets=${hits.map(secretRef).join(',')}`,
          );
        }
        if (config.dump) {
          append(
            config.dump,
            JSON.stringify({ kind, sessionID: event.sessionID, system: event.system, messages: event.messages }),
          );
        }
      });
    await Promise.all(REQUEST_HOOK_KINDS.map(redactHook));

    if (config.rehydrate) {
      // opencode's base policy allows unknown actions; make secret_unredact ask unless a rule says otherwise.
      await ctx.agent.transform((editor) => {
        for (const agent of editor.list()) {
          editor.update(agent.id, (draft) => {
            const at = unredactAskRuleIndex(draft.permissions);
            if (at !== undefined)
              draft.permissions.splice(at, 0, { action: UNREDACT_ACTION, resource: '*', effect: 'ask' });
          });
        }
      });

      await ctx.permission.hook('evaluate', (event) => {
        if (event.action === UNREDACT_ACTION && event.effect === 'deny') event.message ??= UNREDACT_DENIED_MESSAGE;
      });

      await ctx.tool.hook('execute.before', async (event) => {
        const scopeID = await scopeOf(event.sessionID);
        const refs = engine.referencedSecrets(scopeID, event.input);
        if (refs.pending.length === 0 && refs.revealed.length === 0) return;
        if (refs.pending.length > 0) {
          const permission = buildUnredactPermission(refs.pending, event.tool);
          trace(`ask tool=${event.tool} session=${event.sessionID} secrets=${permission.resources.join(',')}`);
          try {
            await ctx.permission.assert({
              sessionID: event.sessionID,
              agent: event.agent,
              source: { type: 'tool', messageID: event.messageID, id: event.id },
              ...permission,
            });
          } catch (err) {
            trace(`denied tool=${event.tool} session=${event.sessionID} ${errorText(err)}`);
            throw err; // a decline must propagate unchanged so opencode ends or reports the step
          }
        }
        const approved = new Set([...refs.pending, ...refs.revealed].map((e) => e.handle));
        const { input, used } = engine.rehydrate(event.input, approved);
        if (used.length === 0) return;
        event.input = input;
        trace(`rehydrated tool=${event.tool} session=${event.sessionID} handles=${used.join(',')}`);
      });
    }

    await ctx.rpc.register(SecretRedactorRpc, {
      status: async (input) => {
        const parsed = parseSecretRedactorRpcInput(input);
        const secrets = parsed ? engine.status(await scopeOf(parsed.sessionID)) : [];
        return { summary: describeRedactorConfig(config), secrets };
      },
      reveal: async (input, context) => {
        const parsed = parseSecretRedactorRpcInput(input);
        const handle = parsed?.handle ?? '';
        const scopeID = parsed ? await scopeOf(parsed.sessionID) : '';
        const entry = parsed && handle ? engine.reveal(scopeID, handle) : undefined;
        if (!entry) return context.error('not_found', `No redacted secret #${handle}`, { handle });
        trace(`reveal scope=${scopeID} secret=${secretRef(entry)}`);
        return { handle: entry.handle, label: entry.label };
      },
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ['session.deleted'], signal: controller.signal })) {
        engine.forget(event.data.sessionID);
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) trace(`subscribe-error ${errorText(err)}`);
    });
    return () => controller.abort();
  },
});
