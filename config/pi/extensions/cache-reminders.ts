/** Final provider-neutral projection and synchronous post-projection safety passes. */
import type { ContextEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { contextRemindersEnabled, type ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import {
  ensureReminderIdentities,
  persistedReminderOrigin,
  reminderProjectionIds,
  type ReminderTrigger,
} from '../../../lib/node/pi/reminder-identity.ts';
import {
  createReminderLifecycle,
  readReminderSnapshots,
  REMINDER_SNAPSHOT_TYPE,
  REMINDER_COORDINATOR,
  REMINDER_CAPABILITIES,
  REMINDER_SANITIZE,
  REMINDER_LIMIT,
  REMINDER_PROJECTED,
  type ReminderCapabilities,
  type ReminderSanitizeRequest,
  type ReminderLimitRequest,
} from '../../../lib/node/pi/reminder-lifecycle.ts';

export default function cacheReminders(pi: ExtensionAPI): void {
  if (!contextRemindersEnabled(process.env)) return;
  const lifecycle = createReminderLifecycle();
  let trigger: ReminderTrigger | undefined;
  let frontier = new Set<string>();
  let boundOrigin: string | undefined;
  const identify = (messages: readonly ReminderMessage[], ctx: ExtensionContext): ReminderMessage[] => {
    const projection = ctx.sessionManager.buildSessionProjection?.();
    const tagged = ensureReminderIdentities(messages, projection, true);
    if (trigger && !boundOrigin) boundOrigin = persistedReminderOrigin(projection, frontier, trigger);
    lifecycle.bindOrigin(boundOrigin);
    return tagged;
  };
  const abortContext = (ctx: ExtensionContext, reason: string): { messages: ContextEvent['messages'] } => {
    try {
      ctx.ui.notify(reason, 'error');
    } catch {
      /* reporting must not make the guard fail open */
    }
    try {
      ctx.abort();
    } catch {
      /* the returned copy still contains no conversation data */
    }
    return {
      messages: [
        { role: 'system' as const, content: 'The context safety guard aborted this request.', timestamp: 0 },
        { role: 'user' as const, content: 'No conversation data is available for this aborted request.', timestamp: 0 },
      ],
    };
  };
  const subscriptions = [
    pi.events.on('cache-reminders:placements', (data) => lifecycle.stagePlacements(data)),
    pi.events.on('cache-reminders:insertions', (data) => lifecycle.stageInsertions(data)),
  ];
  pi.on('before_agent_start', (event, ctx) => {
    trigger =
      event.messageType === 'custom'
        ? { messageType: 'custom', customType: event.message.customType, timestamp: event.message.timestamp }
        : { messageType: 'user' };
    frontier = reminderProjectionIds(ctx.sessionManager.buildSessionProjection?.());
    boundOrigin = undefined;
    lifecycle.refresh(trigger);
  });
  const restore = (ctx: ExtensionContext): void =>
    lifecycle.restore(readReminderSnapshots(ctx.sessionManager.getBranch()));
  const reset = (ctx: ExtensionContext): void => {
    trigger = undefined;
    boundOrigin = undefined;
    frontier = new Set();
    restore(ctx);
  };
  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('session_tree', (_event, ctx) => reset(ctx));
  pi.on('session_compact', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => {
    for (const unsubscribe of subscriptions) unsubscribe();
    lifecycle.restore([]);
  });
  pi.on('context', (event, ctx) => ({
    messages: identify(event.messages as unknown as ReminderMessage[], ctx) as unknown as typeof event.messages,
  }));
  pi.on('context_with_system', (event, ctx) => {
    try {
      const messages = identify(event.messages as unknown as ReminderMessage[], ctx);
      const prepared = lifecycle.prepare(messages);
      const capabilities: ReminderCapabilities = { context: ctx, sanitizerRequired: false, limiterRequired: false };
      pi.events.emit(REMINDER_CAPABILITIES, capabilities);
      let sanitationFailed = false;
      const sanitize = (copy: ReminderMessage[]): ReminderMessage[] => {
        const request: ReminderSanitizeRequest = { messages: structuredClone(copy), context: ctx, handled: false };
        pi.events.emit(REMINDER_SANITIZE, request);
        if (capabilities.sanitizerRequired && !request.handled) sanitationFailed = true;
        return request.messages;
      };
      const limit: ReminderLimitRequest = {
        messages,
        context: ctx,
        origin: lifecycle.origin(messages),
        preview: (candidate) => sanitize(lifecycle.preview(candidate, prepared)),
      };
      pi.events.emit(REMINDER_LIMIT, limit);
      const selected = limit.result?.messages ?? messages;
      const projected = sanitize(lifecycle.preview(selected, prepared));
      if (sanitationFailed || (capabilities.limiterRequired && !limit.result) || limit.result?.fits === false) {
        return abortContext(
          ctx,
          sanitationFailed
            ? 'Reminder sanitization failed; request aborted.'
            : 'Projected context exceeds the model window; reduce the latest input, toolset, or lore budget.',
        );
      }
      const result = lifecycle.project(selected, prepared, (snapshot) =>
        pi.appendEntry(REMINDER_SNAPSHOT_TYPE, snapshot),
      );
      if (result.captured) pi.events.emit('cache-reminders:captured', result.captured);
      pi.events.emit(REMINDER_PROJECTED, { messages: projected, context: ctx });
      return { messages: projected as unknown as typeof event.messages };
    } catch {
      return abortContext(ctx, 'Context finalization failed; request aborted instead of sending unsanitized data.');
    }
  });
  // Advertise ownership only after the final handler has registered successfully.
  subscriptions.push(
    pi.events.on(REMINDER_COORDINATOR, (data) => {
      (data as { active: boolean }).active = true;
    }),
  );
}
