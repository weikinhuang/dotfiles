import { describe, expect, test } from 'vitest';

import { defaultAskRuleIndex } from '../../../../lib/node/opencode/permission-rules.ts';

describe('defaultAskRuleIndex', () => {
  const base = [
    { action: '*', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'ask' },
  ];

  test('inserts right after the base wildcard allow', () => {
    expect(defaultAskRuleIndex(base, 'context_edit')).toBe(1);
  });

  test('inserts at the start when there is no base wildcard allow', () => {
    expect(defaultAskRuleIndex([], 'context_edit')).toBe(0);
    expect(defaultAskRuleIndex([{ action: '*', resource: '*', effect: 'deny' }], 'context_edit')).toBe(0);
  });

  test('is idempotent once the ask rule is in place', () => {
    const inserted = [base[0], { action: 'context_edit', resource: '*', effect: 'ask' }, base[1]];
    expect(defaultAskRuleIndex(inserted, 'context_edit')).toBeUndefined();
  });

  test('treats each action independently', () => {
    const inserted = [base[0], { action: 'secret_unredact', resource: '*', effect: 'ask' }, base[1]];
    expect(defaultAskRuleIndex(inserted, 'context_edit')).toBe(1);
  });
});
