/**
 * Tests for lib/node/pi/research-tiny.ts.
 *
 * Two independent surfaces:
 *
 *   1. Pure helpers (settings resolver + call counter) - tested with
 *      real filesystem fixtures in `mkdtempSync` dirs, no pi.
 *   2. Adapter factory - tested via a mock `runOneShot` that returns
 *      scripted `TinyRunResult` values. No subagent, no agent load,
 *      no network.
 *
 * The mock AgentDef is hand-rolled (the adapter only consumes
 * `tools` / `thinkingLevel` / `timeoutMs` / `maxTurns` on the
 * downstream path, and we bypass that path entirely).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  createTinyAdapter,
  getCallCount,
  incrementCallCount,
  resolveTinySettings,
  shouldCall,
  tinyProvenanceSummary,
  type TinyAdapter,
  type TinyAdapterWiring,
  type TinyCallContext,
  type TinyRunOneShot,
  type TinyRunResult,
  type TinySettings,
} from '../../../../lib/node/pi/research-tiny.ts';
import { type AgentDef } from '../../../../lib/node/pi/subagent-loader.ts';

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `research-tiny-${prefix}-`));
}

function fakeAgent(): AgentDef {
  return {
    path: '/virtual/tiny-helper.md',
    source: 'global',
    name: 'tiny-helper',
    description: 'test-fake',
    tools: [],
    model: 'inherit',
    thinkingLevel: 'off',
    maxTurns: 1,
    timeoutMs: 10_000,
    isolation: 'shared-cwd',
    appendSystemPrompt: undefined,
    bashAllow: [],
    bashDeny: [],
    writeRoots: [],
    body: 'test fake body',
  };
}

interface FakeModel {
  readonly __tag: 'fake-model';
  readonly id: string;
}

function makeModelRegistry(available = true): {
  find: (provider: string, modelId: string) => FakeModel | undefined;
  authStorage: unknown;
} {
  return {
    find(provider, modelId) {
      if (!available) return undefined;
      return { __tag: 'fake-model', id: `${provider}/${modelId}` };
    },
    authStorage: {},
  };
}

/** Helper: scripted run-one-shot that returns pre-queued results. */
function scriptedRun(results: (TinyRunResult | Error)[]): TinyRunOneShot<FakeModel> & { calls: { task: string }[] } {
  let i = 0;
  const calls: { task: string }[] = [];
  const fn = (args: {
    task: string;
    onEvent?: (e: {
      event: { type: string; message?: { role?: string; usage?: { cost?: { total?: number } } } };
    }) => void;
  }): Promise<TinyRunResult> => {
    calls.push({ task: args.task });
    const next = results[i++];
    if (next === undefined) return Promise.reject(new Error('no scripted result'));
    // Emit a synthetic `message_end` with usage so the adapter
    // exercises its cost-aggregation branch.
    args.onEvent?.({
      event: {
        type: 'message_end',
        message: { role: 'assistant', usage: { cost: { total: 0.0001 } } },
      },
    });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  (fn as unknown as { calls: { task: string }[] }).calls = calls;
  return fn as unknown as TinyRunOneShot<FakeModel> & { calls: { task: string }[] };
}

// ──────────────────────────────────────────────────────────────────────
// Settings resolution
// ──────────────────────────────────────────────────────────────────────

describe('resolveTinySettings', () => {
  test('returns null when all three locations are missing', () => {
    const cwd = mkTmp('settings-none');
    const home = mkTmp('home-none');

    expect(resolveTinySettings({ cwd, home })).toBeNull();
  });

  test('(h.1) cwd/.pi/research-tiny.json wins over home files', () => {
    const cwd = mkTmp('settings-cwd');
    const home = mkTmp('home-cwd');
    // cwd value
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'research-tiny.json'), JSON.stringify({ tinyModel: 'local/qwen3' }));
    // home research-tiny.json (would win if cwd were absent)
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'research-tiny.json'), JSON.stringify({ tinyModel: 'anthropic/haiku' }));
    // home settings.json (tie-breaker)
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ research: { tinyModel: 'openai/gpt' } }),
    );

    const out = resolveTinySettings({ cwd, home });

    expect(out).toEqual({ tinyModel: 'local/qwen3', source: join(cwd, '.pi', 'research-tiny.json') });
  });

  test('(h.2) home research-tiny.json wins when cwd has no value', () => {
    const cwd = mkTmp('settings-home');
    const home = mkTmp('home-home');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'research-tiny.json'), JSON.stringify({ tinyModel: 'anthropic/haiku' }));
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ research: { tinyModel: 'openai/gpt' } }),
    );

    const out = resolveTinySettings({ cwd, home });

    expect(out).toEqual({ tinyModel: 'anthropic/haiku', source: join(home, '.pi', 'agent', 'research-tiny.json') });
  });

  test('(h.3) home settings.json is the final fallback', () => {
    const cwd = mkTmp('settings-fallback');
    const home = mkTmp('home-fallback');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ research: { tinyModel: 'openai/gpt-mini' } }),
    );

    const out = resolveTinySettings({ cwd, home });

    expect(out).toEqual({ tinyModel: 'openai/gpt-mini', source: join(home, '.pi', 'agent', 'settings.json') });
  });

  test('accepts a bare string instead of an object', () => {
    const cwd = mkTmp('settings-bare');
    const home = mkTmp('home-bare');
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'research-tiny.json'), JSON.stringify('local/qwen3-bare'));
    const out = resolveTinySettings({ cwd, home });

    expect(out?.tinyModel).toBe('local/qwen3-bare');
  });

  test('tolerates // and /* */ comments (JSONC) in user-authored settings', () => {
    const cwd = mkTmp('settings-jsonc');
    const home = mkTmp('home-jsonc');
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(
      join(cwd, '.pi', 'research-tiny.json'),
      '// my tiny model override\n{ /* provider/model */ "tinyModel": "local/qwen3-commented" }\n',
    );
    const out = resolveTinySettings({ cwd, home });

    expect(out?.tinyModel).toBe('local/qwen3-commented');
  });

  test('rejects a value without provider/model separator', () => {
    const cwd = mkTmp('settings-invalid');
    const home = mkTmp('home-invalid');
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'research-tiny.json'), JSON.stringify({ tinyModel: 'no-slash' }));

    expect(resolveTinySettings({ cwd, home })).toBeNull();
  });

  test('normalizes provider/model whitespace via parseModelSpec', () => {
    const cwd = mkTmp('settings-normalize');
    const home = mkTmp('home-normalize');
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'research-tiny.json'), JSON.stringify({ tinyModel: '  foo /  bar  ' }));
    const out = resolveTinySettings({ cwd, home });

    expect(out?.tinyModel).toBe('foo/bar');
  });

  test('rejects a value with empty provider or model half', () => {
    const cwd = mkTmp('settings-half');
    const home = mkTmp('home-half');
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'research-tiny.json'), JSON.stringify({ tinyModel: '/bar' }));

    expect(resolveTinySettings({ cwd, home })).toBeNull();
  });

  test('tolerates an unreadable / malformed JSON file and continues to the next candidate', () => {
    const cwd = mkTmp('settings-broken');
    const home = mkTmp('home-broken');
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi', 'research-tiny.json'), '{{not valid json');
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(home, '.pi', 'agent', 'research-tiny.json'), JSON.stringify({ tinyModel: 'anthropic/haiku' }));

    const out = resolveTinySettings({ cwd, home });

    expect(out?.tinyModel).toBe('anthropic/haiku');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Call counter
// ──────────────────────────────────────────────────────────────────────

describe('call counter', () => {
  test('getCallCount returns 0 for a fresh runRoot', () => {
    const run = mkTmp('counter-fresh');

    expect(getCallCount(run)).toBe(0);
    expect(shouldCall(run, 3)).toBe(true);
  });

  test('incrementCallCount persists to <runRoot>/.tiny-count', () => {
    const run = mkTmp('counter-inc');

    expect(incrementCallCount(run)).toBe(1);
    expect(incrementCallCount(run)).toBe(2);
    expect(getCallCount(run)).toBe(2);

    const body = readFileSync(join(run, '.tiny-count'), 'utf8').trim();

    expect(body).toBe('2');
  });

  test('(g) shouldCall flips to false after maxCalls increments', () => {
    const run = mkTmp('counter-cap');

    expect(shouldCall(run, 3)).toBe(true);

    incrementCallCount(run);
    incrementCallCount(run);
    incrementCallCount(run);

    expect(shouldCall(run, 3)).toBe(false);
  });

  test('tolerates a corrupted counter file', () => {
    const run = mkTmp('counter-bad');
    writeFileSync(join(run, '.tiny-count'), 'not-a-number\n');

    expect(getCallCount(run)).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Adapter
// ──────────────────────────────────────────────────────────────────────

function makeWiring(
  overrides: Partial<TinyAdapterWiring<FakeModel>> = {},
): TinyAdapterWiring<FakeModel> & { journalPath: string } {
  const settings: TinySettings = { tinyModel: 'local/qwen3', source: '/virtual/settings.json' };
  const tmp = mkTmp('adapter');
  const journalPath = join(tmp, 'journal.md');
  return {
    settings,
    tinyHelperAgent: fakeAgent(),
    runOneShot: scriptedRun([]),
    journalPath,
    ...overrides,
  };
}

function makeCtx(
  cwd: string,
  extra: { runRoot?: string; maxCalls?: number } = {},
): {
  cwd: string;
  model: FakeModel;
  modelRegistry: ReturnType<typeof makeModelRegistry>;
  runRoot?: string;
  maxCalls?: number;
} {
  return {
    cwd,
    model: { __tag: 'fake-model', id: 'parent' },
    modelRegistry: makeModelRegistry(),
    ...extra,
  };
}

describe('createTinyAdapter.isEnabled', () => {
  test('(a.1) returns false when settings is null', () => {
    const wiring = makeWiring({ settings: null });
    const adapter = createTinyAdapter(wiring);

    expect(adapter.isEnabled()).toBe(false);
  });

  test('(a.2) returns false when tinyHelperAgent is null', () => {
    const wiring = makeWiring({ tinyHelperAgent: null });
    const adapter = createTinyAdapter(wiring);

    expect(adapter.isEnabled()).toBe(false);
  });

  test('returns true with both settings and agent', () => {
    const adapter = createTinyAdapter(makeWiring());

    expect(adapter.isEnabled()).toBe(true);
  });
});

describe('createTinyAdapter (disabled paths)', () => {
  test('(a) tinyModel unset - every call returns null without invoking the mock', async () => {
    const run = scriptedRun([]);
    const wiring = makeWiring({ settings: null, runOneShot: run });
    const adapter = createTinyAdapter(wiring);
    const cwd = mkTmp('cwd-disabled');

    expect(await adapter.callTinyRewrite(makeCtx(cwd), 'slugify', 'Hello World')).toBeNull();
    expect(await adapter.callTinyClassify(makeCtx(cwd), 'classify', 'x', ['a', 'b'])).toBeNull();
    expect(await adapter.callTinyMatch(makeCtx(cwd), 'q', ['a', 'b'])).toBeNull();
    expect((run as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });
});

describe('createTinyAdapter (happy paths)', () => {
  test('(b) callTinyRewrite returns trimmed first non-whitespace line', async () => {
    const run = scriptedRun([{ finalText: 'my-slug-123\n', stopReason: 'completed' }]);
    const wiring = makeWiring({ runOneShot: run });
    const adapter = createTinyAdapter(wiring);

    const out = await adapter.callTinyRewrite(makeCtx(mkTmp('cwd-rewrite')), 'slugify', 'My Slug 123');

    expect(out).toBe('my-slug-123');
    expect(adapter.getTotalCost()).toBeGreaterThan(0);
  });

  test('callTinyRewrite drops leading blank lines', async () => {
    const run = scriptedRun([{ finalText: '\n   \nrelevant-line\nignored-second-line\n', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyRewrite(makeCtx(mkTmp('cwd-rewrite2')), 'task', 'input');

    expect(out).toBe('relevant-line');
  });

  test('callTinyClassify returns the label when it matches the allowed set', async () => {
    const run = scriptedRun([{ finalText: 'search\n', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyClassify(makeCtx(mkTmp('cwd-classify')), 'url-type', 'https://foo', [
      'content',
      'search',
      'index',
    ]);

    expect(out).toBe('search');
  });

  test('callTinyMatch returns the candidate when it matches', async () => {
    const run = scriptedRun([{ finalText: 'alpha\n', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyMatch(makeCtx(mkTmp('cwd-match')), 'al', ['alpha', 'beta']);

    expect(out).toBe('alpha');
  });
});

describe('createTinyAdapter (null paths)', () => {
  test('(c) literal "null" response → adapter returns null', async () => {
    const run = scriptedRun([{ finalText: 'null\n', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyRewrite(makeCtx(mkTmp('cwd-null')), 'task', 'input');

    expect(out).toBeNull();
  });

  test('empty response → adapter returns null', async () => {
    const run = scriptedRun([{ finalText: '   \n   ', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyRewrite(makeCtx(mkTmp('cwd-empty')), 'task', 'input');

    expect(out).toBeNull();
  });

  test('over-long response → adapter returns null', async () => {
    const long = 'x'.repeat(300);
    const run = scriptedRun([{ finalText: long, stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyRewrite(makeCtx(mkTmp('cwd-long')), 'task', 'input');

    expect(out).toBeNull();
  });

  test('(d) agent throws → adapter returns null and logs info line', async () => {
    const run = scriptedRun([new Error('boom')]);
    const wiring = makeWiring({ runOneShot: run });
    const adapter = createTinyAdapter(wiring);

    const out = await adapter.callTinyRewrite(makeCtx(mkTmp('cwd-throws')), 'task', 'input');

    expect(out).toBeNull();

    const journal = readFileSync(wiring.journalPath, 'utf8');

    expect(journal).toContain('[info]');
    expect(journal).toContain('spawn error');
    expect(journal).toContain('boom');
  });

  test('non-completed stopReason → adapter returns null and journals info line', async () => {
    const run = scriptedRun([{ finalText: 'ignored', stopReason: 'max_turns', errorMessage: 'hit cap' }]);
    const wiring = makeWiring({ runOneShot: run });
    const adapter = createTinyAdapter(wiring);

    const out = await adapter.callTinyRewrite(makeCtx(mkTmp('cwd-stop')), 'task', 'input');

    expect(out).toBeNull();

    const journal = readFileSync(wiring.journalPath, 'utf8');

    expect(journal).toContain('stop=max_turns');
  });

  test('(e) classify with answer outside the label set → null', async () => {
    const run = scriptedRun([{ finalText: 'podcast\n', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyClassify(makeCtx(mkTmp('cwd-classify-miss')), 'url-type', 'https://foo', [
      'content',
      'search',
      'index',
    ]);

    expect(out).toBeNull();
  });

  test('(f) match with answer outside candidates → null', async () => {
    const run = scriptedRun([{ finalText: 'c\n', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const out = await adapter.callTinyMatch(makeCtx(mkTmp('cwd-match-miss')), 'q', ['a', 'b']);

    expect(out).toBeNull();
  });
});

describe('createTinyAdapter (budget / counter)', () => {
  test('(g) shouldCall false short-circuits without invoking the mock and journals a warning', async () => {
    const run = scriptedRun([]);
    const wiring = makeWiring({ runOneShot: run });
    const adapter = createTinyAdapter(wiring);
    const runRoot = mkTmp('cwd-budget');
    // Prime the counter past the cap.
    incrementCallCount(runRoot);
    incrementCallCount(runRoot);
    incrementCallCount(runRoot);

    const out = await adapter.callTinyRewrite(
      makeCtx(mkTmp('cwd-budget-parent'), { runRoot, maxCalls: 3 }),
      'task',
      'input',
    );

    expect(out).toBeNull();
    expect((run as unknown as { calls: unknown[] }).calls).toHaveLength(0);

    const journal = readFileSync(wiring.journalPath, 'utf8');

    expect(journal).toContain('[warn]');
    expect(journal).toContain('call budget exhausted');
  });

  test('increments the counter before spawning when runRoot is set', async () => {
    const run = scriptedRun([{ finalText: 'ok', stopReason: 'completed' }]);
    const adapter = createTinyAdapter(makeWiring({ runOneShot: run }));
    const runRoot = mkTmp('cwd-budget-inc');

    expect(getCallCount(runRoot)).toBe(0);

    const out = await adapter.callTinyRewrite(
      makeCtx(mkTmp('cwd-parent-inc'), { runRoot, maxCalls: 5 }),
      'task',
      'input',
    );

    expect(out).toBe('ok');
    expect(getCallCount(runRoot)).toBe(1);
  });

  test('model resolution failure → null, journals info line, no spawn', async () => {
    const run = scriptedRun([]);
    const wiring = makeWiring({ runOneShot: run });
    const adapter = createTinyAdapter(wiring);

    const ctx = {
      cwd: mkTmp('cwd-resolve-fail'),
      model: undefined as FakeModel | undefined,
      modelRegistry: makeModelRegistry(false),
    };
    // Settings use 'local/qwen3'; registry returns undefined → resolution error.
    const out = await adapter.callTinyRewrite(ctx, 'task', 'input');

    expect(out).toBeNull();
    expect((run as unknown as { calls: unknown[] }).calls).toHaveLength(0);

    const journal = readFileSync(wiring.journalPath, 'utf8');

    expect(journal).toContain('[info]');
    expect(journal).toContain('model resolution failed');
  });
});

// ──────────────────────────────────────────────────────────────────────
// tinyProvenanceSummary - convenience wrapper
// ──────────────────────────────────────────────────────────────────────

describe('tinyProvenanceSummary', () => {
  const ctx: TinyCallContext<FakeModel> = {
    cwd: '/virtual',
    model: undefined,
    modelRegistry: { find: () => undefined, authStorage: {} },
  };

  function adapterReturning(value: string | null): TinyAdapter<FakeModel> {
    return {
      isEnabled: () => true,
      callTinyRewrite: () => Promise.resolve(value),
      callTinyClassify: () => Promise.resolve(null),
      callTinyMatch: () => Promise.resolve(null),
      getTotalCost: () => 0,
    };
  }

  function adapterThrowing(): TinyAdapter<FakeModel> {
    return {
      isEnabled: () => true,
      callTinyRewrite: () => Promise.reject(new Error('boom')),
      callTinyClassify: () => Promise.resolve(null),
      callTinyMatch: () => Promise.resolve(null),
      getTotalCost: () => 0,
    };
  }

  function disabledAdapter(): TinyAdapter<FakeModel> {
    return {
      isEnabled: () => false,
      callTinyRewrite: () => Promise.resolve('never-called'),
      callTinyClassify: () => Promise.resolve(null),
      callTinyMatch: () => Promise.resolve(null),
      getTotalCost: () => 0,
    };
  }

  test('returns null when adapter is undefined', async () => {
    expect(await tinyProvenanceSummary<FakeModel>(undefined, ctx, 'excerpt')).toBeNull();
  });

  test('returns null when ctx is undefined', async () => {
    expect(await tinyProvenanceSummary(adapterReturning('x'), undefined, 'excerpt')).toBeNull();
  });

  test('returns null when adapter is disabled', async () => {
    expect(await tinyProvenanceSummary(disabledAdapter(), ctx, 'excerpt')).toBeNull();
  });

  test('returns null when adapter returns null', async () => {
    expect(await tinyProvenanceSummary(adapterReturning(null), ctx, 'excerpt')).toBeNull();
  });

  test('returns null when adapter returns empty / whitespace', async () => {
    expect(await tinyProvenanceSummary(adapterReturning('   '), ctx, 'excerpt')).toBeNull();
    expect(await tinyProvenanceSummary(adapterReturning(''), ctx, 'excerpt')).toBeNull();
  });

  test('returns trimmed summary on happy path', async () => {
    expect(await tinyProvenanceSummary(adapterReturning('  short summary  '), ctx, 'excerpt')).toBe('short summary');
  });

  test('swallows adapter errors and returns null', async () => {
    expect(await tinyProvenanceSummary(adapterThrowing(), ctx, 'excerpt')).toBeNull();
  });
});
