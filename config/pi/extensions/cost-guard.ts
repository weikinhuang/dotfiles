/** Diagnostics are UI-only. Never register a context hook, prompt addendum, or model message. */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  costGuardConfig,
  costSample,
  createCostGuardState,
  enabledAutoInjectors,
  guardNotification,
  guardStatus,
  guardUsageRecords,
  observeCostSample,
  reconcileGuardAccounting,
} from '../../../lib/node/pi/cost-guard.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

export default function costGuard(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_COST_GUARD_DISABLED)) return;
  const config = costGuardConfig(process.env);
  let state = createCostGuardState();
  pi.on('session_start', (_event, ctx) => {
    state = createCostGuardState();
    for (const record of guardUsageRecords(ctx.sessionManager.getEntries())) {
      observeCostSample(state, costSample(record.usage), config, record.identity, record.assistant);
    }
    const status = guardStatus(state);
    if (ctx.hasUI) ctx.ui.setStatus('cost-guard', status ? `cost:${status}` : undefined);
  });
  pi.on('session_tree', (_event, ctx) => {
    state.samples = [];
    state.active.clear();
    if (ctx.hasUI) ctx.ui.setStatus('cost-guard', undefined);
  });
  const reconcile = (_event: unknown, ctx: ExtensionContext): void => {
    reconcileGuardAccounting(state, ctx.sessionManager.getEntries());
    const notices = observeCostSample(state, costSample(null), config, state.identity, false);
    if (ctx.hasUI && notices.length)
      ctx.ui.notify(guardNotification(notices, enabledAutoInjectors(process.env, pi.getActiveTools())), 'warning');
  };
  pi.on('agent_end', reconcile);
  pi.on('session_compact', reconcile);
  pi.on('message_end', (event, ctx) => {
    const message = event.message;
    if (message.role !== 'assistant' && message.role !== 'toolResult') return;
    if (!message.usage) return;
    const assistant = message.role === 'assistant';
    const identity = assistant ? JSON.stringify([message.provider, message.model]) : state.identity;
    const notices = observeCostSample(state, costSample(message.usage), config, identity, assistant);
    if (!ctx.hasUI) return;
    const status = guardStatus(state);
    ctx.ui.setStatus('cost-guard', status ? `cost:${status}` : undefined);
    if (notices.length > 0)
      ctx.ui.notify(
        guardNotification(notices, enabledAutoInjectors(process.env, pi.getActiveTools())),
        notices.some((notice) => notice.severity === 'critical') ? 'error' : 'warning',
      );
  });
  pi.on('session_shutdown', (_event, ctx) => {
    state = createCostGuardState();
    if (ctx.hasUI) ctx.ui.setStatus('cost-guard', undefined);
  });
}
