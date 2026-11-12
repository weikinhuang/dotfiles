import { expect, test } from 'vitest';

import {
  readSummaryAttempt,
  resolveSummaryLimits,
  type SummaryAttemptMetadata,
} from '../../../../../lib/node/pi/roleplay/summary-attempt.ts';

test.each([
  [1500, 0, 0, { targetChars: 1000, maxChars: 1500, minChars: 0 }],
  [100, 30, 0, { targetChars: 30, maxChars: 100, minChars: 0 }],
  [100, 999, 0, { targetChars: 100, maxChars: 100, minChars: 0 }],
  [100, 20, 151, { targetChars: 76, maxChars: 100, minChars: 76 }],
  [100, 0, 201, { targetChars: 100, maxChars: 100, minChars: 101 }],
  [1, 0, 0, { targetChars: 1, maxChars: 1, minChars: 0 }],
  [0, -1, -3, { targetChars: 1, maxChars: 1, minChars: 0 }],
  [9.9, 3.9, 5, { targetChars: 3, maxChars: 9, minChars: 3 }],
  [NaN, Infinity, NaN, { targetChars: 1, maxChars: 1, minChars: 0 }],
])('resolveSummaryLimits(%s, %s, %s) resolves numeric bounds', (max, target, prior, expected) => {
  expect(resolveSummaryLimits(max, target, prior)).toEqual(expected);
});

test('resolveSummaryLimits defaults the target and prior and does not weaken an infeasible floor', () => {
  expect(resolveSummaryLimits(1500)).toEqual({ targetChars: 1000, maxChars: 1500, minChars: 0 });
  const conflict = resolveSummaryLimits(10, 4, 23);
  expect(conflict).toEqual({ targetChars: 10, maxChars: 10, minChars: 12 });
});

const metadata: SummaryAttemptMetadata = {
  targetChars: 10,
  maxChars: 15,
  minChars: 4,
  priorChars: 7,
  outputChars: 12,
  reason: 'accepted',
  attempts: [
    { reason: 'over-limit', outputChars: 20 },
    { reason: 'accepted', outputChars: 12 },
  ],
};

test('readSummaryAttempt returns only detached content-free fields', () => {
  const parsed = readSummaryAttempt(metadata);
  expect(parsed).toEqual(metadata);
  expect(parsed).not.toBe(metadata);
  expect(parsed?.attempts).not.toBe(metadata.attempts);
  expect(parsed?.attempts[0]).not.toBe(metadata.attempts[0]);
  expect(Object.keys(parsed ?? {})).toEqual([
    'targetChars',
    'maxChars',
    'minChars',
    'priorChars',
    'outputChars',
    'reason',
    'attempts',
  ]);
});

test.each([
  null,
  'secret recap',
  [],
  {},
  { ...metadata, raw: 'secret recap' },
  { ...metadata, model: 'private/model' },
  { ...metadata, error: new Error('private provider error') },
  { ...metadata, reason: 'private user string' },
  { ...metadata, outputChars: '12' },
  { ...metadata, outputChars: -1 },
  { ...metadata, maxChars: Infinity },
  { ...metadata, targetChars: NaN },
  { ...metadata, priorChars: 1.5 },
  { ...metadata, minChars: 3 },
  { ...metadata, targetChars: 0 },
  { ...metadata, targetChars: 16 },
  { ...metadata, attempts: [{ reason: 'accepted', outputChars: 12, text: 'private recap' }] },
  { ...metadata, attempts: [{ reason: 'private error', outputChars: 0 }] },
  { ...metadata, attempts: [{ reason: 'accepted', outputChars: Number.MAX_SAFE_INTEGER + 1 }] },
  { ...metadata, attempts: [null] },
  { ...metadata, attempts: Array.from({ length: 3 }, () => ({ reason: 'over-limit', outputChars: 20 })) },
])('readSummaryAttempt rejects malformed or non-whitelisted value %#', (value) => {
  expect(readSummaryAttempt(value)).toBeNull();
});

test('readSummaryAttempt accepts zero-attempt outcomes and a preserved constraints conflict', () => {
  for (const reason of ['disabled', 'empty-span', 'model-unavailable', 'constraints-conflict'] as const) {
    const value = {
      ...resolveSummaryLimits(10, 0, 30),
      priorChars: 30,
      outputChars: 0,
      reason,
      attempts: [],
    };
    expect(readSummaryAttempt(value)).toEqual(value);
  }
});
