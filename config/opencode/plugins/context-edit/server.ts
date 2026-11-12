/**
 * Non-destructive context editing for opencode, ported from the pi
 * `tool-collapse` and `context-trim` extensions. See ./README.md.
 *
 * - Overlay: per-session directives in `ctx.storage`, applied to every
 *   agent-loop request in the session `context` hook. Session history is
 *   never modified; a directive whose target is gone is a silent no-op.
 * - Model tools `collapse_output` / `drop_image` (direct, gated by
 *   `ctx.permission.assert` with action `context_edit`).
 * - RPC (./rpc.ts) for the TUI part's `/context-edit` picker.
 *
 * Logic lives in lib/node/opencode/context-edit{,-store}.ts.
 */

import { appendFileSync, writeFileSync } from 'node:fs';

import { Plugin } from '@opencode/plugin';
import type { ToolContext } from '@opencode/plugin/promise/tool';
import type { Schema } from 'effect';

import {
  applyOverlay,
  applySelection,
  buildCandidates,
  buildListOutput,
  COLLAPSE_OUTPUT_DESCRIPTION,
  COLLAPSE_OUTPUT_INPUT_SCHEMA,
  COLLAPSE_TOOL,
  type ContentRecord,
  CONTEXT_EDIT_PERMISSION,
  describeProjection,
  DROP_IMAGE_DESCRIPTION,
  DROP_IMAGE_INPUT_SCHEMA,
  DROP_IMAGE_TOOL,
  dropReply,
  type OcMessage,
  parseDropInput,
  parseRpcRequest,
  planDrop,
  recordsFromSessionMessages,
  resolveContextEditConfig,
  restoreDirectives,
} from '../../../../lib/node/opencode/context-edit.ts';
import { createDirectiveStore } from '../../../../lib/node/opencode/context-edit-store.ts';
import type { ContextEditState } from '../../../../lib/node/pi/context-edit/directive.ts';
import { ContextEditRpc } from './rpc.ts';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: 'dotfiles.context-edit',
  async setup(ctx) {
    const config = resolveContextEditConfig(ctx.options, process.env);
    if (!config.enabled) return;

    const store = createDirectiveStore({
      get: (key) => ctx.storage.get(key),
      // Directive state is plain JSON data; the cast only bridges the interface to effect's Json type.
      set: (key, value) => ctx.storage.set(key, value as unknown as Schema.Json),
      remove: (key) => ctx.storage.remove(key),
    });

    const debug = (line: Record<string, unknown>, dump?: string[]): void => {
      if (!config.debugFile) return;
      try {
        appendFileSync(config.debugFile, `${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);
        if (dump) writeFileSync(`${config.debugFile}.last.txt`, `${dump.join('\n')}\n`);
      } catch {
        // debugging is best-effort
      }
    };

    const load = async (sessionID: string): Promise<{ records: ContentRecord[]; state: ContextEditState }> => {
      const [history, state] = await Promise.all([ctx.session.context({ sessionID }), store.get(sessionID)]);
      return { records: recordsFromSessionMessages(history), state };
    };

    await ctx.session.hook('context', async (event) => {
      const state = await store.get(event.sessionID);
      if (state.directives.length === 0 && !config.debugFile) return;
      const original = event.messages as unknown as readonly OcMessage[];
      const result = applyOverlay(original, state.directives);
      if (result.applied > 0) event.messages = result.messages as unknown as typeof event.messages;
      if (config.debugFile) {
        const after = describeProjection(result.messages);
        debug(
          {
            event: 'context',
            sessionID: event.sessionID,
            messages: original.length,
            bytesBefore: describeProjection(original).bytes,
            bytesAfter: after.bytes,
            directives: state.directives.length,
            applied: result.applied,
            stale: result.stale,
          },
          after.lines,
        );
      }
    });

    const rpc = await ctx.rpc.register(ContextEditRpc, {
      list: async (input) => {
        const req = parseRpcRequest(input);
        if (!req.ok) throw new Error(req.error);
        const { records, state } = await load(req.value.sessionID);
        return buildListOutput(records, state, { minBytes: config.minBytes, snippetChars: config.snippetChars });
      },
      apply: async (input) => {
        const req = parseRpcRequest(input);
        if (!req.ok) throw new Error(req.error);
        const { sessionID, keys = [], reason } = req.value;
        const { records } = await load(sessionID);
        let changed = 0;
        const next = await store.update(sessionID, (s) => {
          const candidates = buildCandidates(records, s, { snippetChars: config.snippetChars });
          const outcome = applySelection(s, candidates, keys, { reason, now: Date.now() });
          changed = outcome.applied.length;
          return changed > 0 ? outcome.state : undefined;
        });
        const message =
          changed > 0
            ? `Edited ${changed} item(s); applies from the next request.`
            : 'Nothing changed (already edited or no longer in context).';
        await rpc.events.emit('changed', { sessionID, count: next.directives.length, source: 'rpc', message });
        return { changed, message };
      },
      restore: async (input) => {
        const req = parseRpcRequest(input);
        if (!req.ok) throw new Error(req.error);
        const { sessionID, ids } = req.value;
        let restored: number[] = [];
        const next = await store.update(sessionID, (s) => {
          const r = restoreDirectives(s, ids);
          restored = r.restored;
          return r.restored.length > 0 ? r.state : undefined;
        });
        const message =
          restored.length > 0 ? `Restored ${restored.map((id) => `#${id}`).join(', ')}.` : 'Nothing to restore.';
        await rpc.events.emit('changed', { sessionID, count: next.directives.length, source: 'rpc', message });
        return { changed: restored.length, message };
      },
    });

    if (config.tools) {
      const runDrop = async (
        tool: typeof COLLAPSE_TOOL | typeof DROP_IMAGE_TOOL,
        raw: unknown,
        context: ToolContext,
      ): Promise<{ content: string }> => {
        const isCollapse = tool === COLLAPSE_TOOL;
        const parsed = parseDropInput(raw, isCollapse ? ['toolName'] : ['summary']);
        if (!parsed.ok) throw new Error(parsed.error);
        const { records, state } = await load(context.sessionID);
        const candidates = buildCandidates(records, state, { snippetChars: config.snippetChars });
        const plan = planDrop(
          isCollapse ? candidates.tools : candidates.images,
          parsed.value,
          config.tailGuard,
          isCollapse ? { one: 'tool pair', many: 'tool pairs' } : { one: 'image', many: 'images' },
        );
        if (plan.kind === 'none') return { content: plan.message };
        // Native rules decide: `"context_edit": "allow"` (or per-tool patterns) skips the prompt, "deny" blocks.
        await ctx.permission.assert({
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: 'tool', messageID: context.messageID, id: context.id },
          action: CONTEXT_EDIT_PERMISSION,
          resources: [tool],
          save: [tool],
          metadata: { tool, summary: plan.summary, reason: parsed.value.reason },
        });
        let applied = 0;
        const next = await store.update(context.sessionID, (s) => {
          const r = applySelection(s, candidates, plan.keys, {
            reason: parsed.value.reason,
            description: parsed.value.summary,
            now: Date.now(),
          });
          applied = r.applied.length;
          return applied > 0 ? r.state : undefined;
        });
        const reply = dropReply(isCollapse ? 'Collapsed' : 'Dropped', plan, applied);
        await rpc.events.emit('changed', {
          sessionID: context.sessionID,
          count: next.directives.length,
          source: 'tool',
          message: `${tool}: ${isCollapse ? 'collapsed' : 'dropped'} ${applied}`,
        });
        return { content: reply };
      };

      await ctx.tool.transform((editor) => {
        editor.add({
          name: COLLAPSE_TOOL,
          description: COLLAPSE_OUTPUT_DESCRIPTION,
          input: COLLAPSE_OUTPUT_INPUT_SCHEMA,
          options: { codemode: false, permission: CONTEXT_EDIT_PERMISSION },
          execute: (input, context) => runDrop(COLLAPSE_TOOL, input, context),
        });
        editor.add({
          name: DROP_IMAGE_TOOL,
          description: DROP_IMAGE_DESCRIPTION,
          input: DROP_IMAGE_INPUT_SCHEMA,
          options: { codemode: false, permission: CONTEXT_EDIT_PERMISSION },
          execute: (input, context) => runDrop(DROP_IMAGE_TOOL, input, context),
        });
      });
    }

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ['session.deleted'], signal: controller.signal })) {
        await store.forget(event.data.sessionID);
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) debug({ event: 'subscribe-error', error: errorText(err) });
    });

    return () => controller.abort();
  },
});
