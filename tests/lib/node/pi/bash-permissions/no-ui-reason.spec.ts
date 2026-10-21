/**
 * Tests for lib/node/pi/bash-permissions/no-ui-reason.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import { buildNoUiDenyReason } from '../../../../../lib/node/pi/bash-permissions/no-ui-reason.ts';

const RULES = '~/.pi/agent/bash-permissions.json';

test('keeps the existing prefix and lists every unknown command', () => {
  const reason = buildNoUiDenyReason(['curl -s https://example.com', 'ai-fetch-web search x'], RULES);
  expect(reason.startsWith('No UI available for approval. Unknown command(s):\n')).toBe(true);
  expect(reason).toContain('\n  curl -s https://example.com\n  ai-fetch-web search x\n');
});

test('tells the model the block is final and not to retry variations', () => {
  const reason = buildNoUiDenyReason(['ai-fetch-web search x'], RULES);
  expect(reason).toMatch(/will be blocked again/);
  expect(reason).toMatch(/Do not retry it/);
  expect(reason).toMatch(/variations of it/);
});

test('labels the operator hint as being for the user and puts it last', () => {
  const reason = buildNoUiDenyReason(['x'], RULES);
  const lastLine = reason.split('\n').at(-1) ?? '';
  expect(lastLine.startsWith('(For the user: add a rule via /bash-allow')).toBe(true);
  expect(lastLine).toContain(RULES);
  expect(lastLine).toContain('PI_BASH_PERMISSIONS_DEFAULT=allow');
});
