/**
 * Cross-session memory for opencode, ported from the pi `memory` extension
 * (config/pi/extensions/memory.ts) and sharing its on-disk store. See
 * ./README.md.
 *
 * - `memory` tool (direct, not codemode): the shared pi actions
 *   (lib/node/pi/memory/actions.ts) over a fresh disk scan per call.
 * - Index delivery: the `prompt` hook (before the step that answers a user
 *   prompt) syncs the `memory-index` / `memory-changes` session instruction
 *   entries (lib/node/opencode/memory-delivery.ts); a compaction re-puts
 *   the full index.
 * - Subagent child sessions get neither the index nor the tool, as in pi.
 * - RPC (./rpc.ts) for the TUI part's `/memory` dialog.
 */

import { appendFileSync } from 'node:fs';

import { Plugin } from '@opencode/plugin';
import type { Schema } from 'effect';

import {
  buildMemoryReport,
  MEMORY_TOOL,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_INPUT_SCHEMA,
  parseMemoryToolInput,
  parseReportRequest,
  renderFullIndex,
  resolveOpencodeMemoryConfig,
} from '../../../../lib/node/opencode/memory.ts';
import {
  createDeliveryStore,
  noteLocalChange,
  planInstructionDelivery,
} from '../../../../lib/node/opencode/memory-delivery.ts';
import { cacheParentLookup } from '../../../../lib/node/opencode/session-tree.ts';
import { rebuildMemoryIndex } from '../../../../lib/node/pi/memory-paths.ts';
import { type MemoryState } from '../../../../lib/node/pi/memory-reducer.ts';
import { runMemoryAction } from '../../../../lib/node/pi/memory/actions.ts';
import { MemoryRpc } from './rpc.ts';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: 'dotfiles.memory',
  async setup(ctx) {
    const config = resolveOpencodeMemoryConfig(ctx.options, process.env);
    if (!config.enabled) return;

    const cwd = ctx.location.directory;
    const { debugFile } = config;
    const debug = (line: Record<string, unknown>): void => {
      if (!debugFile) return;
      try {
        appendFileSync(debugFile, `${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);
      } catch {
        // debugging is best-effort
      }
    };

    const parentOf = cacheParentLookup(async (sessionID) => (await ctx.session.get({ sessionID })).parentID);
    // A failed lookup treats the session as a root: losing memory in a real root session is worse.
    const isChild = async (sessionID: string): Promise<boolean> =>
      (await parentOf(sessionID).catch(() => undefined)) !== undefined;

    const scan = (sessionID: string): { state: MemoryState; warnings: string[] } =>
      rebuildMemoryIndex(cwd, sessionID, config.root);

    const store = createDeliveryStore({
      get: (key) => ctx.storage.get(key),
      // Delivery state is plain JSON data; the cast only bridges the interface to effect's Json type.
      set: (key, value) => ctx.storage.set(key, value as unknown as Schema.Json),
      remove: (key) => ctx.storage.remove(key),
    });

    const sync = (sessionID: string, refresh: boolean): Promise<void> =>
      store.update(sessionID, async (prev) => {
        const { state } = scan(sessionID);
        const now = new Date();
        const plan = planInstructionDelivery(prev, state.index, () => renderFullIndex(state, config, now), {
          refresh,
        });
        // Ops touch distinct keys, so they can run together.
        await Promise.all(
          plan.ops.map((op) =>
            op.op === 'put'
              ? ctx.session.instructions.entry.put({ sessionID, key: op.key, value: op.value })
              : ctx.session.instructions.entry.remove({ sessionID, key: op.key }),
          ),
        );
        debug({ event: 'sync', sessionID, refresh, kind: plan.kind, ops: plan.ops.map((o) => `${o.op}:${o.key}`) });
        return plan.next;
      });

    if (config.autoInject) {
      // Awaited before the prompt's first step assembles its instructions, so the index is in that request.
      await ctx.session.hook('prompt', async (event) => {
        if (await isChild(event.sessionID)) return;
        await sync(event.sessionID, false).catch((err: unknown) =>
          debug({ event: 'sync-error', sessionID: event.sessionID, error: errorText(err) }),
        );
      });
    }

    // Subagent children never see the tool (pi does not give children `memory` either).
    await ctx.session.hook('context', async (event) => {
      if (event.tools[MEMORY_TOOL] && (await isChild(event.sessionID))) delete event.tools[MEMORY_TOOL];
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: MEMORY_TOOL,
        description: MEMORY_TOOL_DESCRIPTION,
        input: MEMORY_TOOL_INPUT_SCHEMA,
        options: { codemode: false },
        execute: async (input, context) => {
          const parsed = parseMemoryToolInput(input);
          if (!parsed.ok) throw new Error(parsed.error);
          if (await isChild(context.sessionID)) {
            throw new Error('memory is not available in subagent sessions; report findings to the parent instead');
          }
          // Rescan before every action: writes from pi or other sessions are seen and MEMORY.md is never rebuilt stale.
          const { state } = scan(context.sessionID);
          const result = runMemoryAction(state, parsed.value, {
            cwd,
            sessionId: context.sessionID,
            root: config.root,
            now: () => new Date(),
            ...(config.readOnlyReason ? { readOnlyReason: config.readOnlyReason } : {}),
          });
          if (result.isError) throw new Error(result.content.replace(/^Error: /, ''));
          const change = result.change;
          if (change && config.autoInject) {
            await store
              .update(context.sessionID, async (prev) => Promise.resolve(noteLocalChange(prev, change) ?? undefined))
              .catch((err: unknown) => debug({ event: 'note-error', error: errorText(err) }));
          }
          return { content: result.content };
        },
      });
    });

    const rpc = await ctx.rpc.register(MemoryRpc, {
      report: async (input) => {
        const req = parseReportRequest(input);
        if (!req.ok) throw new Error(req.error);
        const { sessionID, view } = req.value;
        const { state, warnings } = scan(sessionID);
        const [delivery, child] = await Promise.all([store.get(sessionID), isChild(sessionID)]);
        return {
          text: buildMemoryReport({
            view,
            state,
            config,
            cwd,
            sessionID,
            delivery,
            child,
            warnings,
            now: new Date(),
            env: process.env,
          }),
        };
      },
    });

    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ['session.compaction.ended', 'session.deleted'],
        signal: controller.signal,
      })) {
        const { sessionID } = event.data;
        if (event.type === 'session.deleted') {
          await store.forget(sessionID);
          continue;
        }
        // The compaction folded the entries into a new baseline but the summary replaced the tool results
        // that told the model about its own writes: resend the full index.
        if (config.autoInject && !(await isChild(sessionID))) {
          await sync(sessionID, true).catch((err: unknown) =>
            debug({ event: 'sync-error', sessionID, error: errorText(err) }),
          );
        }
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) debug({ event: 'subscribe-error', error: errorText(err) });
    });

    return async () => {
      controller.abort();
      await rpc.dispose();
    };
  },
});
