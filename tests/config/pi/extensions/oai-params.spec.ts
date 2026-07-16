/**
 * Tests for the `oai-params` extension's command surface.
 *
 * Sits under `tests/config/pi/extensions/` to document the `/oai-params`
 * command shell, but - per project convention - only drives the pure lib
 * helpers the shell composes (`isHelpArg`, `OAI_PARAMS_USAGE`,
 * `renderStatus`). The shell itself pulls in `@earendil-works/*` and can't
 * be imported under vitest.
 */

import { describe, expect, test, vi } from 'vitest';

import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import type { ParsedVariant } from '../../../../lib/node/pi/oai-params/types.ts';
import { OAI_PARAMS_USAGE, renderStatus } from '../../../../lib/node/pi/oai-params/usage.ts';

const variant = (over: Partial<ParsedVariant> = {}): ParsedVariant => ({
  id: 'qwen-creative',
  name: 'Qwen Creative',
  parentProvider: 'llama-cpp',
  parentId: 'qwen3-6-27b',
  samplingParams: { temperature: 1.0, min_p: 0.05 },
  ...over,
});

// ──────────────────────────────────────────────────────────────────────
// Help convention - the handler guards with `isHelpArg`, notifying
// OAI_PARAMS_USAGE at info level.
// ──────────────────────────────────────────────────────────────────────

test('help: `/oai-params --help` notifies OAI_PARAMS_USAGE', () => {
  const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
  if (isHelpArg('--help')) notify(OAI_PARAMS_USAGE, 'info');

  expect(notify).toHaveBeenCalledTimes(1);
  const [msg, level] = notify.mock.calls[0];
  expect(level).toBe('info');
  expect(msg).toBe(OAI_PARAMS_USAGE);
  expect(OAI_PARAMS_USAGE).toContain('/oai-params');
});

test('help: bare `/oai-params` is not a help arg (falls through to status)', () => {
  expect(isHelpArg('')).toBe(false);
  expect(isHelpArg(undefined)).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────
// Status renderer (the empty-arg default for this command).
// ──────────────────────────────────────────────────────────────────────

describe('renderStatus', () => {
  test('empty state when no variants are defined', () => {
    const out = renderStatus({ variants: [], registeredProviders: new Set(), errors: [], activeProvider: undefined });
    expect(out).toContain('no variants defined');
  });

  test('lists each variant with its parent and sampling params', () => {
    const out = renderStatus({
      variants: [variant()],
      registeredProviders: new Set(['qwen-creative']),
      errors: [],
      activeProvider: undefined,
    });
    expect(out).toContain('1 variant');
    expect(out).toContain('qwen-creative  (extends llama-cpp/qwen3-6-27b)');
    expect(out).toContain('temperature=1');
    expect(out).toContain('min_p=0.05');
    expect(out).not.toContain('[not registered]');
  });

  test('marks the active variant with an arrow', () => {
    const out = renderStatus({
      variants: [variant()],
      registeredProviders: new Set(['qwen-creative']),
      errors: [],
      activeProvider: 'qwen-creative',
    });
    expect(out).toContain('→ qwen-creative');
  });

  test('flags a variant that failed to register', () => {
    const out = renderStatus({
      variants: [variant()],
      registeredProviders: new Set(),
      errors: [],
      activeProvider: undefined,
    });
    expect(out).toContain('[not registered]');
  });

  test('appends config errors', () => {
    const out = renderStatus({
      variants: [],
      registeredProviders: new Set(),
      errors: ['variant "x": unknown provider "ghost" in models.json'],
      activeProvider: undefined,
    });
    expect(out).toContain('errors:');
    expect(out).toContain('unknown provider "ghost"');
  });

  test('renders "(no sampling params)" when the block is empty', () => {
    const out = renderStatus({
      variants: [variant({ samplingParams: {} })],
      registeredProviders: new Set(['qwen-creative']),
      errors: [],
      activeProvider: undefined,
    });
    expect(out).toContain('(no sampling params)');
  });
});
