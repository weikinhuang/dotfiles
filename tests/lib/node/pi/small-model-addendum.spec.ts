/**
 * Tests for lib/node/pi/small-model-addendum.ts.
 *
 * Pure module — no pi runtime needed. Uses tmpdir to exercise the
 * file-backed config loader.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type AddendumConfig,
  appendAddendum,
  DEFAULT_ADDENDUM,
  loadConfig,
  matchesModel,
} from '../../../../lib/node/pi/small-model-addendum.ts';

// ──────────────────────────────────────────────────────────────────────
// matchesModel
// ──────────────────────────────────────────────────────────────────────

const cfg = (overrides: Partial<AddendumConfig> = {}): AddendumConfig => ({
  providers: [],
  models: [],
  text: DEFAULT_ADDENDUM,
  ...overrides,
});

describe('matchesModel', () => {
  test('returns false when no model is resolved', () => {
    expect(matchesModel(undefined, cfg({ providers: ['llama-cpp'] }))).toBe(false);
  });

  test('returns false when both allow-lists are empty', () => {
    expect(matchesModel({ provider: 'llama-cpp', id: 'qwen3-6-35b-a3b' }, cfg())).toBe(false);
  });

  test('matches by provider', () => {
    expect(matchesModel({ provider: 'llama-cpp', id: 'qwen3-6-35b-a3b' }, cfg({ providers: ['llama-cpp'] }))).toBe(
      true,
    );
  });

  test('matches by provider/id tuple', () => {
    expect(
      matchesModel({ provider: 'llama-cpp', id: 'qwen3-6-35b-a3b' }, cfg({ models: ['llama-cpp/qwen3-6-35b-a3b'] })),
    ).toBe(true);
  });

  test('ignores id-only listings that lack a provider prefix', () => {
    // Users must always write `provider/id` — a bare id is ambiguous.
    expect(matchesModel({ provider: 'llama-cpp', id: 'qwen3-6-35b-a3b' }, cfg({ models: ['qwen3-6-35b-a3b'] }))).toBe(
      false,
    );
  });

  test('does not match when provider differs', () => {
    expect(matchesModel({ provider: 'amazon-bedrock', id: 'claude-opus-4' }, cfg({ providers: ['llama-cpp'] }))).toBe(
      false,
    );
  });

  test('missing model.provider disables provider-based match', () => {
    expect(matchesModel({ id: 'qwen3-6-35b-a3b' }, cfg({ providers: ['llama-cpp'] }))).toBe(false);
  });

  test('provider match takes precedence; model list irrelevant when provider already matches', () => {
    expect(
      matchesModel(
        { provider: 'llama-cpp', id: 'qwen3-6-35b-a3b' },
        cfg({ providers: ['llama-cpp'], models: ['other/thing'] }),
      ),
    ).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// appendAddendum
// ──────────────────────────────────────────────────────────────────────

describe('appendAddendum', () => {
  test('appends with a blank-line separator', () => {
    expect(appendAddendum('You are a helpful assistant.', 'X')).toBe('You are a helpful assistant.\n\nX');
  });

  test('trims trailing whitespace on the base before appending', () => {
    expect(appendAddendum('base\n\n\n', 'ADD')).toBe('base\n\nADD');
  });

  test('returns trimmed addendum when base is empty', () => {
    expect(appendAddendum('', '  ADD  ')).toBe('ADD');
  });

  test('returns base unchanged when addendum is empty or whitespace-only', () => {
    expect(appendAddendum('base', '')).toBe('base');
    expect(appendAddendum('base', '   \n   ')).toBe('base');
  });

  test('is idempotent if base already ends with the addendum', () => {
    const base = 'hello\n\nADD';

    expect(appendAddendum(base, 'ADD')).toBe(base);
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadConfig
// ──────────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let workdir: string;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    workdir = join(tmpdir(), `sma-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    home = join(workdir, 'home');
    cwd = join(workdir, 'proj');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  test('returns defaults and no warnings when no files exist', () => {
    const { config, warnings } = loadConfig(cwd, home);

    expect(config.providers).toEqual([]);
    expect(config.models).toEqual([]);
    expect(config.text).toBe(DEFAULT_ADDENDUM);
    expect(warnings).toEqual([]);
  });

  test('loads global config', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'small-model-addendum.json'),
      JSON.stringify({ providers: ['llama-cpp'] }),
    );
    const { config, warnings } = loadConfig(cwd, home);

    expect(config.providers).toEqual(['llama-cpp']);
    expect(config.text).toBe(DEFAULT_ADDENDUM); // falls back to default
    expect(warnings).toEqual([]);
  });

  test('project config overlays on top of global (arrays replace wholesale)', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'small-model-addendum.json'),
      JSON.stringify({ providers: ['llama-cpp'], models: ['a/b'], text: 'GLOBAL' }),
    );
    writeFileSync(
      join(cwd, '.pi', 'small-model-addendum.json'),
      JSON.stringify({ providers: ['local-vllm'], text: 'PROJECT' }),
    );
    const { config } = loadConfig(cwd, home);

    expect(config.providers).toEqual(['local-vllm']); // overridden
    expect(config.models).toEqual(['a/b']); // unchanged (not set in project)
    expect(config.text).toBe('PROJECT'); // overridden
  });

  test('supports JSONC comments', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'small-model-addendum.json'),
      `// a comment\n{ "providers": ["llama-cpp"] /* inline */ }`,
    );
    const { config, warnings } = loadConfig(cwd, home);

    expect(config.providers).toEqual(['llama-cpp']);
    expect(warnings).toEqual([]);
  });

  test('malformed JSON produces a warning and is otherwise ignored', () => {
    writeFileSync(join(home, '.pi', 'agent', 'small-model-addendum.json'), '{ not json');
    const { config, warnings } = loadConfig(cwd, home);

    expect(config).toEqual({ providers: [], models: [], text: DEFAULT_ADDENDUM });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toMatch(/small-model-addendum\.json$/);
  });

  test('non-object root is rejected with a warning', () => {
    writeFileSync(join(home, '.pi', 'agent', 'small-model-addendum.json'), '"not an object"');
    const { config, warnings } = loadConfig(cwd, home);

    expect(config.providers).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.error).toContain('object');
  });

  test('empty text in config falls back to default (does not zero out addendum)', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'small-model-addendum.json'),
      JSON.stringify({ providers: ['llama-cpp'], text: '   ' }),
    );
    const { config } = loadConfig(cwd, home);

    expect(config.text).toBe(DEFAULT_ADDENDUM);
  });

  test('non-string entries in providers / models arrays are dropped', () => {
    writeFileSync(
      join(home, '.pi', 'agent', 'small-model-addendum.json'),
      JSON.stringify({ providers: ['llama-cpp', 42, null, ''], models: [{}, 'a/b'] }),
    );
    const { config } = loadConfig(cwd, home);

    expect(config.providers).toEqual(['llama-cpp']);
    expect(config.models).toEqual(['a/b']);
  });
});
