/** Final provider-neutral projection, after all producers and context-window transforms. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import {
  createReminderLifecycle,
  readReminderSnapshots,
  REMINDER_SNAPSHOT_TYPE,
} from '../../../lib/node/pi/reminder-lifecycle.ts';

export default function cacheReminders(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CACHE_REMINDERS_DISABLED) || !envTruthy(process.env.PI_CACHE_REMINDERS_ENABLED)) return;
  const lifecycle = createReminderLifecycle();
  pi.on('before_agent_start', () => {
    lifecycle.refresh();
  });
  pi.on('session_start', (_event, ctx) => {
    lifecycle.restore(readReminderSnapshots(ctx.sessionManager.getBranch()));
  });
  pi.on('session_tree', (_event, ctx) => {
    lifecycle.restore(readReminderSnapshots(ctx.sessionManager.getBranch()));
  });
  pi.on('session_compact', (_event, ctx) => {
    lifecycle.restore(readReminderSnapshots(ctx.sessionManager.getBranch()));
  });
  pi.on('session_shutdown', () => {
    lifecycle.restore([]);
  });
  pi.on('context_with_system', (event) => {
    const result = lifecycle.project(event.messages as unknown as ReminderMessage[]);
    if (result.captured) {
      pi.appendEntry(REMINDER_SNAPSHOT_TYPE, result.captured);
      pi.events.emit('cache-reminders:captured', result.captured);
    }
    return { messages: result.messages as unknown as typeof event.messages };
  });
}
