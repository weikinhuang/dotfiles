/**
 * Tests for lib/node/pi/ext/comfyui/usage-guidance.ts: the main-agent
 * usage-guidance resolver injected at `before_agent_start`, and its
 * enhancer-state-driven swap between the base and enhanced files.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { mergeConfigLayers } from '../../../../../../lib/node/pi/comfyui/config.ts';
import type { ComfyuiConfig } from '../../../../../../lib/node/pi/comfyui/types.ts';
import { resolveUsageGuidance } from '../../../../../../lib/node/pi/ext/comfyui/usage-guidance.ts';

let dir: string;

beforeEach(() => {
  delete process.env.PI_COMFYUI_DISABLE_USAGE_GUIDANCE;
  dir = mkdtempSync(join(tmpdir(), 'comfyui-usage-'));
  writeFileSync(join(dir, 'base.md'), 'BASE protocol');
  writeFileSync(join(dir, 'enhanced.md'), 'ENHANCED lean block');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PI_COMFYUI_DISABLE_USAGE_GUIDANCE;
});

/** A config with both guidance files set and one default workflow, layered over DEFAULT_CONFIG. */
function buildConfig(overrides: Partial<ComfyuiConfig> = {}): ComfyuiConfig {
  return mergeConfigLayers({
    defaultWorkflow: 'anima',
    workflows: { anima: { file: 'anima.json', inputs: {} } },
    usageGuidanceFile: join(dir, 'base.md'),
    usageGuidanceEnhancedFile: join(dir, 'enhanced.md'),
    ...overrides,
  });
}

test('returns empty when neither guidance file is configured', () => {
  const config = mergeConfigLayers({ defaultWorkflow: 'anima', workflows: { anima: { file: 'a.json', inputs: {} } } });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('');
});

test('uses the base file when the enhancer is unavailable, even if enhance defaults on', () => {
  const config = buildConfig({ enhance: true });
  expect(resolveUsageGuidance({ config, enhanceAvailable: false, fromCwd: dir })).toBe('BASE protocol');
});

test('uses the enhanced file when available and enhance is on by default (global)', () => {
  const config = buildConfig({ enhance: true });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('ENHANCED lean block');
});

test('uses the base file when enhance is off by default', () => {
  const config = buildConfig({ enhance: false });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('BASE protocol');
});

test('per-workflow enhance:true overrides a global enhance:false (enhanced)', () => {
  const config = buildConfig({ enhance: false, workflows: { anima: { file: 'a.json', inputs: {}, enhance: true } } });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('ENHANCED lean block');
});

test('per-workflow enhance:false overrides a global enhance:true (base)', () => {
  const config = buildConfig({ enhance: true, workflows: { anima: { file: 'a.json', inputs: {}, enhance: false } } });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('BASE protocol');
});

test('falls back to global enhance when defaultWorkflow names no configured workflow', () => {
  const config = buildConfig({ enhance: true, defaultWorkflow: 'ghost' });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('ENHANCED lean block');
});

test('resolves a relative guidance path against fromCwd', () => {
  const config = buildConfig({ enhance: false, usageGuidanceFile: 'base.md' });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('BASE protocol');
});

test('returns empty when the selected guidance file is missing', () => {
  const config = buildConfig({ enhance: false, usageGuidanceFile: join(dir, 'gone.md') });
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('');
});

test('PI_COMFYUI_DISABLE_USAGE_GUIDANCE forces empty even when a file is configured', () => {
  const config = buildConfig({ enhance: false });
  process.env.PI_COMFYUI_DISABLE_USAGE_GUIDANCE = '1';
  expect(resolveUsageGuidance({ config, enhanceAvailable: true, fromCwd: dir })).toBe('');
});
