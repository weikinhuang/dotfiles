/**
 * Tests for lib/node/pi/preset.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  describePreset,
  loadPresetFiles,
  normalizePreset,
  type Preset,
  type PresetWarning,
  readFileOrUndefined,
  THINKING_LEVELS,
} from '../../../../lib/node/pi/preset.ts';

// ──────────────────────────────────────────────────────────────────────
// normalizePreset
// ──────────────────────────────────────────────────────────────────────

describe('normalizePreset', () => {
  test('accepts a fully-specified preset', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset(
      'p',
      'qwen3-local',
      {
        model: 'llama-cpp/qwen3-6-35b-a3b',
        thinkingLevel: 'high',
        tools: ['read', 'bash'],
        appendSystemPrompt: 'be terse',
      },
      warnings,
    );

    expect(warnings).toEqual([]);
    expect(out).toEqual({
      model: 'llama-cpp/qwen3-6-35b-a3b',
      thinkingLevel: 'high',
      tools: ['read', 'bash'],
      appendSystemPrompt: 'be terse',
    });
  });

  test('empty/partial preset is valid', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'empty', {}, warnings);

    expect(warnings).toEqual([]);
    expect(out).toEqual({});
  });

  test('trims model', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'x', { model: '  provider/id  ' }, warnings);

    expect(out?.model).toBe('provider/id');
  });

  test('rejects invalid model type', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'x', { model: 42 }, warnings);

    expect(warnings).toHaveLength(1);
    expect(out?.model).toBeUndefined();
  });

  test('rejects invalid thinking level', () => {
    const warnings: PresetWarning[] = [];
    normalizePreset('p', 'x', { thinkingLevel: 'turbo' }, warnings);

    expect(warnings[0]?.error).toMatch(/thinkingLevel/);
  });

  test('accepts every canonical thinking level', () => {
    for (const lvl of THINKING_LEVELS) {
      const warnings: PresetWarning[] = [];
      const out = normalizePreset('p', 'x', { thinkingLevel: lvl }, warnings);

      expect(warnings).toEqual([]);
      expect(out?.thinkingLevel).toBe(lvl);
    }
  });

  test('drops non-string tool entries silently but keeps the rest', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'x', { tools: ['read', 42, '', null, 'bash'] }, warnings);

    expect(out?.tools).toEqual(['read', 'bash']);
  });

  test('empty tools array → no tools field set', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'x', { tools: [] }, warnings);

    expect(out?.tools).toBeUndefined();
  });

  test('whitespace-only appendSystemPrompt is dropped', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'x', { appendSystemPrompt: '   \n  ' }, warnings);

    expect(warnings).toEqual([]);
    expect(out?.appendSystemPrompt).toBeUndefined();
  });

  test('rejects non-object preset', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'x', 42, warnings);

    expect(out).toBeUndefined();
    expect(warnings[0]?.error).toMatch(/not an object/);
  });

  test('arrays are not accepted as preset bodies', () => {
    const warnings: PresetWarning[] = [];
    const out = normalizePreset('p', 'x', [], warnings);

    expect(out).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadPresetFiles (injected reader)
// ──────────────────────────────────────────────────────────────────────

describe('loadPresetFiles', () => {
  const MAP: Record<string, string> = {
    '/a/shipped.json': JSON.stringify({
      'qwen3-local': { model: 'llama-cpp/qwen3', thinkingLevel: 'high' },
      'opus-reason': { model: 'bedrock/opus-4', thinkingLevel: 'high' },
    }),
    '/a/user.json': JSON.stringify({
      'qwen3-local': { model: 'llama-cpp/qwen3', thinkingLevel: 'medium' }, // override
      'my-preset': { thinkingLevel: 'off' },
    }),
    '/a/project.json': `// project-level\n${JSON.stringify({
      'qwen3-local': { model: 'llama-cpp/qwen3', thinkingLevel: 'low' }, // override again
    })}`,
  };
  const reader = (p: string): string | undefined => MAP[p];

  test('later layer overrides earlier by name', () => {
    const { presets } = loadPresetFiles(['/a/shipped.json', '/a/user.json', '/a/project.json'], reader);

    expect(presets['qwen3-local']?.thinkingLevel).toBe('low');
  });

  test('non-overriding presets from all layers are present', () => {
    const { presets } = loadPresetFiles(['/a/shipped.json', '/a/user.json'], reader);

    expect(presets).toHaveProperty('qwen3-local');
    expect(presets).toHaveProperty('opus-reason');
    expect(presets).toHaveProperty('my-preset');
  });

  test('missing files are silent', () => {
    const { presets, warnings } = loadPresetFiles(['/does/not/exist.json'], reader);

    expect(presets).toEqual({});
    expect(warnings).toEqual([]);
  });

  test('malformed JSON produces a warning', () => {
    const r = (p: string): string | undefined => (p === '/bad.json' ? '{ not json' : undefined);
    const { warnings } = loadPresetFiles(['/bad.json'], r);

    expect(warnings).toHaveLength(1);
  });

  test('non-object root is rejected', () => {
    const r = (p: string): string | undefined => (p === '/x.json' ? '"nope"' : undefined);
    const { warnings } = loadPresetFiles(['/x.json'], r);

    expect(warnings[0]?.error).toMatch(/object/);
  });

  test('invalid preset name is skipped with a warning', () => {
    const r = (): string => JSON.stringify({ '123-bad': {} });
    const { presets, warnings } = loadPresetFiles(['/w.json'], r);

    expect(presets['123-bad']).toBeUndefined();
    expect(warnings.some((w) => w.error.includes('123-bad'))).toBe(true);
  });

  test('nameOrder is sorted alphabetically', () => {
    const { nameOrder } = loadPresetFiles(['/a/shipped.json', '/a/user.json'], reader);

    expect(nameOrder).toEqual([...nameOrder].sort());
  });
});

// ──────────────────────────────────────────────────────────────────────
// describePreset
// ──────────────────────────────────────────────────────────────────────

describe('describePreset', () => {
  test('includes all non-empty fields', () => {
    const preset: Preset = {
      model: 'provider/id',
      thinkingLevel: 'high',
      tools: ['bash', 'read'],
      appendSystemPrompt: 'be terse',
    };
    const desc = describePreset(preset);

    expect(desc).toContain('provider/id');
    expect(desc).toContain('thinking=high');
    expect(desc).toContain('tools=bash,read');
    expect(desc).toContain('"be terse"');
  });

  test('elides long prompts', () => {
    const preset: Preset = { appendSystemPrompt: 'x'.repeat(200) };

    expect(describePreset(preset)).toMatch(/"x+\.\.\./);
    expect(describePreset(preset).length).toBeLessThan(80);
  });

  test('empty preset → empty description', () => {
    expect(describePreset({})).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
// readFileOrUndefined (tiny filesystem integration)
// ──────────────────────────────────────────────────────────────────────

describe('readFileOrUndefined', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `preset-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns file contents when present', () => {
    const p = join(dir, 'x');
    writeFileSync(p, 'hello');

    expect(readFileOrUndefined(p)).toBe('hello');
  });

  test('returns undefined for missing file', () => {
    expect(readFileOrUndefined(join(dir, 'missing'))).toBeUndefined();
  });
});
