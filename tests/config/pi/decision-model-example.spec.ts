/**
 * Pins config/pi/decision-model-example.json to the loader it documents:
 * the example must resolve to a ready config with the documented defaults.
 */

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { DEFAULT_SHELL_POLICY, loadDecisionModelConfig } from '../../../lib/node/decision-model/config.ts';

const EXAMPLE = join(import.meta.dirname, '../../../config/pi/decision-model-example.json');

test('decision-model-example.json: resolves to a ready config with default policy', () => {
  const { status, warnings } = loadDecisionModelConfig({
    configPath: EXAMPLE,
    defaultLogPath: '/tmp/decision-model.jsonl',
    env: { TYPESAFE_API_KEY: 'k' },
    home: '/home/u',
  });
  expect(warnings).toEqual([]);
  expect(status.state).toBe('ready');
  if (status.state !== 'ready') return;
  expect(status.config.endpoint.url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(status.config.endpoint.timeoutMs).toBe(3000);
  expect(status.config.logPath).toBe('/tmp/decision-model.jsonl');
  expect(status.config.shell).toEqual(DEFAULT_SHELL_POLICY);
});

test('decision-model-example.json: without the key env var it stays off', () => {
  const { status } = loadDecisionModelConfig({
    configPath: EXAMPLE,
    defaultLogPath: '/tmp/x.jsonl',
    env: {},
    home: '/home/u',
  });
  expect(status).toMatchObject({
    state: 'invalid',
    error: 'API key env var TYPESAFE_API_KEY is unset and no "provider.apiKey" is set',
  });
});
