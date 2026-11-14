/**
 * Tests for lib/node/pi/bash-permissions/no-ui-reason.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { expect, test } from 'vitest';

import {
  buildNoUiDenyReason,
  buildNoUiOperatorHint,
} from '../../../../../lib/node/pi/bash-permissions/no-ui-reason.ts';

const RULES = '~/.pi/agent/bash-permissions.json';

test('keeps the existing prefix and lists every unknown command', () => {
  const reason = buildNoUiDenyReason(['curl -s https://example.com', 'ai-fetch-web search x']);
  expect(reason.startsWith('No UI available for approval. Unknown command(s):\n')).toBe(true);
  expect(reason).toContain('\n  curl -s https://example.com\n  ai-fetch-web search x\n');
});

test('tells the model the block is final and not to retry or change settings', () => {
  const reason = buildNoUiDenyReason(['ai-fetch-web search x']);
  expect(reason).toMatch(/will be blocked again/);
  expect(reason).toMatch(/Do not retry it/);
  expect(reason).toMatch(/variations of it/);
  expect(reason).toMatch(/do not try to change the permission settings/);
});

test('names no bypass: no rules path, slash command, or env var', () => {
  const reason = buildNoUiDenyReason(['x']);
  expect(reason).not.toMatch(/bash-permissions\.json|\/bash-allow|PI_BASH_PERMISSIONS|For the user/);
});

test('the operator hint carries the rules path and every way to allow', () => {
  const hint = buildNoUiOperatorHint(RULES);
  expect(hint.startsWith('[bash-permissions] ')).toBe(true);
  expect(hint).toContain(RULES);
  expect(hint).toContain('/bash-allow');
  expect(hint).toContain('PI_BASH_PERMISSIONS_DEFAULT=allow');
  expect(hint).not.toContain('\n');
});
