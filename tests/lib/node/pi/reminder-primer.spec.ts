/**
 * Tests for lib/node/pi/reminder-primer.ts.
 *
 * Pure module - no pi runtime needed. Uses tmpdir to exercise the
 * file-backed config loader.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  appendPrimer,
  DEFAULT_PRIMER,
  loadConfig,
  modelKnowsReminders,
  type PrimerConfig,
  shouldInjectPrimer,
} from '../../../../lib/node/pi/reminder-primer.ts';

const cfg = (overrides: Partial<PrimerConfig> = {}): PrimerConfig => ({
  mode: 'auto',
  text: DEFAULT_PRIMER,
  ...overrides,
});

// ──────────────────────────────────────────────────────────────────────
// modelKnowsReminders
// ──────────────────────────────────────────────────────────────────────

describe('modelKnowsReminders', () => {
  test('direct anthropic provider/id', () => {
    expect(modelKnowsReminders({ provider: 'anthropic', id: 'claude-opus-4-8' })).toBe(true);
  });

  test('claude served via bedrock', () => {
    expect(modelKnowsReminders({ provider: 'amazon-bedrock', id: 'anthropic.claude-sonnet-4' })).toBe(true);
  });

  test('claude served via openrouter (provider is not anthropic)', () => {
    expect(modelKnowsReminders({ provider: 'openrouter', id: 'anthropic/claude-3.5-sonnet' })).toBe(true);
  });

  test('non-claude model is not recognized', () => {
    expect(modelKnowsReminders({ provider: 'llama-cpp', id: 'qwen3-30b-a3b' })).toBe(false);
  });

  test('non-claude on bedrock is not recognized (gate is on model, not provider)', () => {
    expect(modelKnowsReminders({ provider: 'amazon-bedrock', id: 'meta.llama3-70b' })).toBe(false);
  });

  test('case-insensitive', () => {
    expect(modelKnowsReminders({ provider: 'Anthropic', id: 'Claude-Opus' })).toBe(true);
  });

  test('unknown model (no provider, no id) needs the primer', () => {
    expect(modelKnowsReminders(undefined)).toBe(false);
    expect(modelKnowsReminders({})).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// shouldInjectPrimer
// ──────────────────────────────────────────────────────────────────────

describe('shouldInjectPrimer', () => {
  test('auto: inject for non-claude, skip for claude', () => {
    expect(shouldInjectPrimer({ provider: 'llama-cpp', id: 'qwen' }, cfg())).toBe(true);
    expect(shouldInjectPrimer({ provider: 'anthropic', id: 'claude-opus-4-8' }, cfg())).toBe(false);
  });

  test('always: inject regardless of model', () => {
    expect(shouldInjectPrimer({ provider: 'anthropic', id: 'claude-opus-4-8' }, cfg({ mode: 'always' }))).toBe(true);
  });

  test('never: silent regardless of model', () => {
    expect(shouldInjectPrimer({ provider: 'llama-cpp', id: 'qwen' }, cfg({ mode: 'never' }))).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// appendPrimer
// ──────────────────────────────────────────────────────────────────────

describe('appendPrimer', () => {
  test('appends with a blank-line separator', () => {
    expect(appendPrimer('You are a helpful assistant.', 'X')).toBe('You are a helpful assistant.\n\nX');
  });

  test('trims trailing whitespace on the base before appending', () => {
    expect(appendPrimer('base\n\n\n', 'ADD')).toBe('base\n\nADD');
  });

  test('returns trimmed primer when base is empty', () => {
    expect(appendPrimer('', '  ADD  ')).toBe('ADD');
  });

  test('returns base unchanged when primer is empty or whitespace-only', () => {
    expect(appendPrimer('base', '')).toBe('base');
    expect(appendPrimer('base', '   \n   ')).toBe('base');
  });

  test('is idempotent if base already ends with the primer (byte-stable across turns)', () => {
    const base = 'hello\n\nADD';

    expect(appendPrimer(base, 'ADD')).toBe(base);
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadConfig
// ──────────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let workdir: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    workdir = join(tmpdir(), `rp-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    agentDir = join(workdir, 'agent');
    cwd = join(workdir, 'proj');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test('returns defaults and no warnings when no files exist', () => {
    const { config, warnings } = loadConfig(cwd, agentDir);

    expect(config.mode).toBe('auto');
    expect(config.text).toBe(DEFAULT_PRIMER);
    expect(warnings).toEqual([]);
  });

  test('loads global config and validates mode', () => {
    writeFileSync(join(agentDir, 'reminder-primer.json'), JSON.stringify({ mode: 'always' }));
    const { config, warnings } = loadConfig(cwd, agentDir);

    expect(config.mode).toBe('always');
    expect(config.text).toBe(DEFAULT_PRIMER); // falls back to default
    expect(warnings).toEqual([]);
  });

  test('ignores an invalid mode (falls back to default)', () => {
    writeFileSync(join(agentDir, 'reminder-primer.json'), JSON.stringify({ mode: 'sometimes' }));
    const { config } = loadConfig(cwd, agentDir);

    expect(config.mode).toBe('auto');
  });

  test('project config overlays on top of global', () => {
    writeFileSync(join(agentDir, 'reminder-primer.json'), JSON.stringify({ mode: 'always', text: 'GLOBAL' }));
    writeFileSync(join(cwd, '.pi', 'reminder-primer.json'), JSON.stringify({ text: 'PROJECT' }));
    const { config } = loadConfig(cwd, agentDir);

    expect(config.mode).toBe('always'); // unchanged (not set in project)
    expect(config.text).toBe('PROJECT'); // overridden
  });

  test('supports JSONC comments', () => {
    writeFileSync(join(agentDir, 'reminder-primer.json'), `// a comment\n{ "mode": "never" /* inline */ }`);
    const { config, warnings } = loadConfig(cwd, agentDir);

    expect(config.mode).toBe('never');
    expect(warnings).toEqual([]);
  });

  test('malformed JSON produces a warning and is otherwise ignored', () => {
    writeFileSync(join(agentDir, 'reminder-primer.json'), '{ not json');
    const { config, warnings } = loadConfig(cwd, agentDir);

    expect(config).toEqual({ mode: 'auto', text: DEFAULT_PRIMER });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toMatch(/reminder-primer\.json$/);
  });

  test('empty text in config falls back to default (does not zero out the primer)', () => {
    writeFileSync(join(agentDir, 'reminder-primer.json'), JSON.stringify({ text: '   ' }));
    const { config } = loadConfig(cwd, agentDir);

    expect(config.text).toBe(DEFAULT_PRIMER);
  });
});
