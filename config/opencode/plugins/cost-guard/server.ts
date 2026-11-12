/**
 * Local-only cost / cache warnings for opencode, ported from the pi
 * `cost-guard` extension (config/pi/extensions/cost-guard.ts). See ./README.md.
 *
 * Observes `session.step.ended` / `session.step.failed` (one provider call
 * each, carrying `cost` + `tokens`) and compaction usage, feeds a per-root
 * rolling window (subagent sessions add spend only), and pushes warnings to
 * the TUI part over the `dotfiles.cost-guard` RPC `update` event. Nothing is
 * model-bound: no hooks, instructions, or synthetic messages.
 *
 * Resume: the first event (or TUI `status` call) for a root session not seen
 * by this process silently replays `ctx.session.context` and seeds spend
 * from the session tree's `Session.Info.cost`. Logic lives in
 * lib/node/opencode/cost-guard.ts.
 */

import { appendFileSync } from 'node:fs';

import { Plugin } from '@opencode/plugin';

import {
  buildUpdateEvent,
  contextUsageRecords,
  type CostGuardUpdateEvent,
  createCostGuardTracker,
  formatLogLine,
  type GuardUpdate,
  modelIdentity,
  opencodeCostSample,
  parseStatusInput,
  type PriceTier,
  resolveOpencodeCostGuardConfig,
  type UsageRecord,
} from '../../../../lib/node/opencode/cost-guard.ts';
import { cacheParentLookup, resolveRootSessionID } from '../../../../lib/node/opencode/session-tree.ts';
import { CostGuardRpc } from './rpc.ts';

const EVENT_TYPES = [
  'session.step.started',
  'session.step.ended',
  'session.step.failed',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.revert.committed',
  'session.deleted',
] as const;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: 'dotfiles.cost-guard',
  async setup(ctx) {
    const config = resolveOpencodeCostGuardConfig(ctx.options, process.env);
    if (!config.enabled) return;

    const tracker = createCostGuardTracker(config.guard);
    const parentOf = cacheParentLookup(async (sessionID) => (await ctx.session.get({ sessionID })).parentID);
    const rootOf = (sessionID: string): Promise<string> =>
      resolveRootSessionID(sessionID, parentOf).catch(() => sessionID);
    /** Model of each in-flight step, from `session.step.started`. */
    const stepModels = new Map<string, unknown>();

    const log = (line: string): void => {
      if (!config.log) return;
      try {
        appendFileSync(config.log, `${line}\n`);
      } catch {
        // logging is best-effort
      }
    };

    // Catalog pricing, only used to apportion each step's single `cost` to cache writes.
    let pricing: Map<string, readonly PriceTier[]> | undefined;
    const loadPricing = async (): Promise<void> => {
      try {
        const { data } = await ctx.model.list();
        pricing = new Map(data.map((model) => [JSON.stringify([model.providerID, model.id]), model.cost]));
      } catch (err) {
        pricing = new Map();
        log(`${new Date().toISOString()} pricing-error ${errorText(err)}`);
      }
    };
    const pricingFor = (model: unknown): readonly PriceTier[] | undefined => {
      const key = modelIdentity(model);
      return key === undefined ? undefined : pricing?.get(key);
    };

    const childDollars = async (root: string): Promise<number> => {
      const page = await ctx.session.list({ parentID: root, limit: 200 });
      return page.data.reduce((sum, session) => sum + (Number.isFinite(session.cost) ? session.cost : 0), 0);
    };

    const seed = async (root: string, exclude?: { messageID?: string; dollars: number }): Promise<void> => {
      try {
        const [messages, info, children] = await Promise.all([
          ctx.session.context({ sessionID: root }),
          ctx.session.get({ sessionID: root }),
          childDollars(root).catch((err: unknown) => {
            log(`${new Date().toISOString()} children-error session=${root} ${errorText(err)}`);
            return 0;
          }),
        ]);
        const records = contextUsageRecords(messages, pricingFor);
        tracker.seed(root, { records, sessionDollars: info.cost + children, exclude });
        const snapshot = tracker.snapshot(root);
        log(
          `${new Date().toISOString()} seed session=${root} records=${records.length} total=$${(snapshot?.totalDollars ?? 0).toFixed(4)} status=${snapshot?.status}`,
        );
      } catch (err) {
        tracker.seed(root, { records: [] });
        log(`${new Date().toISOString()} seed-error session=${root} ${errorText(err)}`);
      }
    };

    /**
     * Silent replay for a root first seen by this process (from an event or the TUI's `status` call). `exclude` is
     * the triggering, already committed event, observed live afterwards so it still warns.
     */
    const seeding = new Map<string, Promise<void>>();
    const ensureSeeded = async (root: string, exclude?: { messageID?: string; dollars: number }): Promise<void> => {
      if (tracker.has(root)) return;
      let pending = seeding.get(root);
      if (!pending) {
        pending = seed(root, exclude).finally(() => seeding.delete(root));
        seeding.set(root, pending);
      }
      await pending;
    };

    const registration = await ctx.rpc.register(CostGuardRpc, {
      status: async (input) => {
        const sessionID = parseStatusInput(input);
        if (!sessionID) return { sessionID: '', known: false, status: 'ok', totalDollars: 0 };
        const root = await rootOf(sessionID);
        await ensureSeeded(root);
        const snapshot = tracker.snapshot(root);
        return {
          sessionID: root,
          known: snapshot !== undefined,
          status: snapshot?.status ?? 'ok',
          totalDollars: snapshot?.totalDollars ?? 0,
        };
      },
    });

    const deliver = async (root: string, update: GuardUpdate | undefined): Promise<void> => {
      const event: CostGuardUpdateEvent | undefined = update && buildUpdateEvent(root, update);
      if (!event) return;
      log(formatLogLine(new Date(), event));
      try {
        await registration.events.emit('update', { ...event });
      } catch (err) {
        log(`${new Date().toISOString()} emit-error ${errorText(err)}`);
      }
    };

    const observe = async (sessionID: string, record: UsageRecord): Promise<void> => {
      const root = await rootOf(sessionID);
      const nested = root !== sessionID;
      await ensureSeeded(root, { messageID: record.messageID, dollars: record.sample.dollars });
      const update = tracker.observe(root, {
        ...record,
        // Subagent calls count toward the root's spend but not its rolling window.
        assistant: record.assistant && !nested,
        messageID: nested ? undefined : record.messageID,
      });
      log(
        `${new Date().toISOString()} observe session=${sessionID} root=${root} window=${record.assistant && !nested} cost=$${record.sample.dollars.toFixed(6)}${update ? ` total=$${update.totalDollars.toFixed(6)}` : ' replayed'}`,
      );
      await deliver(root, update);
    };

    const controller = new AbortController();
    void (async () => {
      await loadPricing();
      for await (const event of ctx.event.subscribe({ types: [...EVENT_TYPES], signal: controller.signal })) {
        try {
          switch (event.type) {
            case 'session.step.started':
              stepModels.set(event.data.assistantMessageID, event.data.model);
              break;
            case 'session.step.ended':
            case 'session.step.failed': {
              const { sessionID, assistantMessageID } = event.data;
              const model = stepModels.get(assistantMessageID);
              stepModels.delete(assistantMessageID);
              const sample = opencodeCostSample(event.data.cost, event.data.tokens, pricingFor(model));
              if (!sample) break;
              await observe(sessionID, {
                messageID: assistantMessageID,
                identity: modelIdentity(model),
                assistant: true,
                sample,
              });
              break;
            }
            case 'session.compaction.ended':
            case 'session.compaction.failed': {
              const sample = opencodeCostSample(event.data.cost, event.data.tokens);
              if (sample) await observe(event.data.sessionID, { assistant: false, sample });
              break;
            }
            case 'session.revert.committed': {
              const root = await rootOf(event.data.sessionID);
              await deliver(root, tracker.resetWindow(root));
              break;
            }
            case 'session.deleted':
              tracker.forget(event.data.sessionID);
              break;
          }
        } catch (err) {
          log(`${new Date().toISOString()} event-error type=${event.type} ${errorText(err)}`);
        }
      }
    })().catch((err: unknown) => {
      if (!controller.signal.aborted) log(`${new Date().toISOString()} subscribe-error ${errorText(err)}`);
    });

    return async () => {
      controller.abort();
      await registration.dispose();
    };
  },
});
