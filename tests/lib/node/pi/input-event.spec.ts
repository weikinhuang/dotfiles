import { describe, expect, test } from 'vitest';

import { isFreshUserPrompt } from '../../../../lib/node/pi/input-event.ts';

describe('isFreshUserPrompt', () => {
  test('true for an interactive idle prompt with no streamingBehavior', () => {
    expect(isFreshUserPrompt({ source: 'interactive' })).toBe(true);
  });

  test('true for an rpc idle prompt with no streamingBehavior', () => {
    expect(isFreshUserPrompt({ source: 'rpc' })).toBe(true);
  });

  test('true when source is missing (legacy events) and no streamingBehavior', () => {
    expect(isFreshUserPrompt({})).toBe(true);
  });

  test('false when extension synthesised the message', () => {
    expect(isFreshUserPrompt({ source: 'extension' })).toBe(false);
  });

  test('false for a mid-stream steer', () => {
    expect(isFreshUserPrompt({ source: 'interactive', streamingBehavior: 'steer' })).toBe(false);
  });

  test('false for a queued follow-up', () => {
    expect(isFreshUserPrompt({ source: 'interactive', streamingBehavior: 'followUp' })).toBe(false);
  });

  test('false for any truthy streamingBehavior value (forward-compat)', () => {
    expect(isFreshUserPrompt({ source: 'rpc', streamingBehavior: 'someFutureMode' })).toBe(false);
  });

  test('extension source wins over streamingBehavior', () => {
    expect(isFreshUserPrompt({ source: 'extension', streamingBehavior: 'steer' })).toBe(false);
  });
});
