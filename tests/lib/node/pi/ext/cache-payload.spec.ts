import type { Context, Message, Model } from '@earendil-works/pi-ai';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { expect, test } from 'vitest';

import { createCacheTracer } from '../../../../../lib/node/pi/cache-trace.ts';
import { applyContextReminder, type ReminderMessage } from '../../../../../lib/node/pi/context-reminder.ts';

export const model: Model<'azure-openai-responses'> = {
  id: 'fixture',
  name: 'Fixture',
  provider: 'azure-openai-responses',
  api: 'azure-openai-responses',
  baseUrl: 'https://invalid.example',
  reasoning: true,
  input: ['text'],
  cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  contextWindow: 200000,
  maxTokens: 1000,
};
const identity = { provider: model.provider, model: model.id };

export function responsesPayload(messages: ReminderMessage[]): { input: unknown[] } {
  const context: Context = { messages: messages as unknown as Message[] };
  return { input: convertResponsesMessages(model, context, new Set([model.provider])) };
}

export const history: ReminderMessage[] = [{ role: 'user', content: 'fixture prompt', timestamp: 1 }];
export const toolLoop: ReminderMessage[] = [
  {
    role: 'assistant',
    content: [{ type: 'toolCall', name: 'todo', id: 'call_1|fc_1', arguments: { action: 'list' } }],
    provider: model.provider,
    api: model.api,
    model: model.id,
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'call_1|fc_1',
    toolName: 'todo',
    isError: false,
    content: [{ type: 'text', text: 'fixture tool output' }],
    timestamp: 3,
  },
];

test('installed Responses converter reproduces a historical user item changing despite a stable body', () => {
  const trace = createCacheTracer();
  const first = responsesPayload(applyContextReminder(history, { id: 'todo-plan', body: 'PLAN' }));
  trace(first, identity);
  const next = responsesPayload(applyContextReminder([...history, ...toolLoop], { id: 'todo-plan', body: 'PLAN' }));
  const record = trace(next, identity);
  expect(record.firstDivergentMessage).toBe(0);
  expect(first.input[0]).not.toEqual(next.input[0]);
  expect(record.messages.at(-1)?.role).toBe('function_call_output');
  expect(record.messages.at(-1)?.reminderIds).toEqual(['todo-plan']);
});
