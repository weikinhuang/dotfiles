/**
 * Tests for lib/node/opencode/memory.ts: config resolution, tool input
 * validation, reports, and store compatibility with pi's memory helpers
 * (both hosts must read each other's files on a shared temp root).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  buildMemoryReport,
  MEMORY_TOOL_INPUT_SCHEMA,
  type OpencodeMemoryConfig,
  parseMemoryToolInput,
  parseReportRequest,
  resolveOpencodeMemoryConfig,
} from '../../../../lib/node/opencode/memory.ts';
import {
  clearScanCache,
  fileFor,
  indexFileFor,
  memoryRoot,
  readMemoryBody,
  rebuildMemoryIndex,
} from '../../../../lib/node/pi/memory-paths.ts';
import { renderMemoryMd, serializeMemory } from '../../../../lib/node/pi/memory-reducer.ts';
import { runMemoryAction } from '../../../../lib/node/pi/memory/actions.ts';

const HOME = '/home/u';
const CWD = '/work/demo';
const NOW = new Date('2026-11-12T10:00:00.000Z');

let sandbox: string;
const savedRoot = process.env.PI_MEMORY_ROOT;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'oc-memory-'));
  clearScanCache();
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.PI_MEMORY_ROOT;
  else process.env.PI_MEMORY_ROOT = savedRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

// ── config ───────────────────────────────────────────────────────────

test('resolveOpencodeMemoryConfig: defaults to pi’s store root', () => {
  const config = resolveOpencodeMemoryConfig(undefined, {}, HOME);
  expect(config).toEqual({
    enabled: true,
    root: '/home/u/.pi/agent/memory',
    autoInject: true,
    readOnlyReason: undefined,
    maxInjectedChars: 6000,
    staleDays: 30,
    debugFile: undefined,
  });
  expect(resolveOpencodeMemoryConfig(undefined, { PI_CODING_AGENT_DIR: '/agent' }, HOME).root).toBe('/agent/memory');
  expect(resolveOpencodeMemoryConfig(undefined, { PI_MEMORY_ROOT: '~/mem' }, HOME).root).toBe('/home/u/mem');
  expect(memoryRoot({ PI_MEMORY_ROOT: '~/mem' }, HOME)).toBe('/home/u/mem');
});

test('resolveOpencodeMemoryConfig: env beats option beats default', () => {
  const config = resolveOpencodeMemoryConfig(
    { root: '~/opt-root', maxInjectedChars: 100, staleDays: 7, readOnly: true },
    { OPENCODE_MEMORY_ROOT: '/env-root', OPENCODE_MEMORY_AUTO_INJECT: '0', PI_MEMORY_ROOT: '/ignored' },
    HOME,
  );
  expect(config.root).toBe('/env-root');
  expect(config.autoInject).toBe(false);
  expect(config.maxInjectedChars).toBe(500);
  expect(config.staleDays).toBe(7);
  expect(config.readOnlyReason).toBe('readOnly (OPENCODE_MEMORY_READ_ONLY)');
  expect(resolveOpencodeMemoryConfig({ root: '~/opt-root' }, {}, HOME).root).toBe('/home/u/opt-root');
  expect(resolveOpencodeMemoryConfig({}, { OPENCODE_MEMORY_ENABLED: 'off' }, HOME).enabled).toBe(false);
});

// ── tool input ───────────────────────────────────────────────────────

test('parseMemoryToolInput: accepts the schema fields and rejects bad values', () => {
  expect(parseMemoryToolInput({ action: 'save', type: 'user', scope: 'project', name: 'n', body: 'b' })).toEqual({
    ok: true,
    value: { action: 'save', type: 'user', scope: 'project', name: 'n', body: 'b' },
  });
  expect(parseMemoryToolInput({ action: 'list' })).toEqual({ ok: true, value: { action: 'list' } });
  expect(parseMemoryToolInput(null)).toMatchObject({ ok: false });
  expect(parseMemoryToolInput({ action: 'delete' })).toMatchObject({
    ok: false,
    error: expect.stringMatching(/^`action`/) as unknown,
  });
  expect(parseMemoryToolInput({ action: 'save', type: 'todo' })).toMatchObject({ ok: false });
  expect(parseMemoryToolInput({ action: 'remove', scope: 'repo' })).toMatchObject({ ok: false });
  expect(parseMemoryToolInput({ action: 'read', id: 3 })).toEqual({ ok: false, error: '`id` must be a string' });
  expect(Object.keys(MEMORY_TOOL_INPUT_SCHEMA.properties)).toEqual([
    'action',
    'type',
    'scope',
    'id',
    'name',
    'description',
    'body',
    'query',
  ]);
});

// ── store compatibility ──────────────────────────────────────────────

test('store: an opencode save is read back by pi’s own resolution of the same root', () => {
  const config = resolveOpencodeMemoryConfig({ root: sandbox }, {}, HOME);
  const scanned = rebuildMemoryIndex(CWD, 'ses_oc', config.root).state;
  const result = runMemoryAction(
    scanned,
    { action: 'save', type: 'feedback', name: 'No summaries', description: 'skip recaps', body: 'Do not recap.' },
    { cwd: CWD, sessionId: 'ses_oc', root: config.root, now: () => NOW },
  );
  expect(result.isError).toBeUndefined();

  // pi resolves the root from PI_MEMORY_ROOT and uses its default-root helpers.
  process.env.PI_MEMORY_ROOT = sandbox;
  clearScanCache();
  const pi = rebuildMemoryIndex(CWD, 'pi-session').state;
  expect(pi.index.global).toEqual([
    {
      id: 'no-summaries',
      scope: 'global',
      type: 'feedback',
      name: 'No summaries',
      description: 'skip recaps',
      created: '2026-11-12T10:00:00.000Z',
      updated: '2026-11-12T10:00:00.000Z',
    },
  ]);
  const [saved] = pi.index.global;
  expect(saved && readMemoryBody(saved, CWD, 'pi-session')).toBe('Do not recap.\n');
  expect(readFileSync(fileFor('global', 'feedback', 'no-summaries', CWD), 'utf8')).toBe(
    serializeMemory({
      name: 'No summaries',
      description: 'skip recaps',
      type: 'feedback',
      body: 'Do not recap.',
      created: NOW.toISOString(),
      updated: NOW.toISOString(),
    }),
  );
  expect(readFileSync(indexFileFor('global', CWD), 'utf8')).toBe(renderMemoryMd(pi.index.global, 'global'));
});

test('store: a pi save (default root via PI_MEMORY_ROOT) is visible to the opencode config root', () => {
  process.env.PI_MEMORY_ROOT = sandbox;
  const piRoot = memoryRoot();
  runMemoryAction(
    rebuildMemoryIndex(CWD, 'pi-session').state,
    { action: 'save', type: 'project', name: 'Freeze', description: 'merge freeze', body: 'From 2026-11-20.' },
    { cwd: CWD, sessionId: 'pi-session', root: piRoot, now: () => NOW, readOnlyReason: undefined },
  );
  const config = resolveOpencodeMemoryConfig({}, process.env, HOME);
  expect(config.root).toBe(sandbox);
  clearScanCache();
  const oc = rebuildMemoryIndex(CWD, 'ses_oc', config.root).state;
  expect(oc.index.project.map((e) => `${e.type}/${e.id}`)).toEqual(['project/freeze']);
  // Session scope is keyed per session id, so pi's session notes never leak into an opencode session.
  expect(oc.index.session).toEqual([]);
  expect(oc.projectSlug).toBe('--work-demo--');
});

// ── reports ──────────────────────────────────────────────────────────

const reportConfig = (): OpencodeMemoryConfig => resolveOpencodeMemoryConfig({ root: sandbox }, {}, HOME);

test('parseReportRequest: validates the session and view', () => {
  expect(parseReportRequest({ sessionID: 's', view: 'dir' })).toEqual({
    ok: true,
    value: { sessionID: 's', view: 'dir' },
  });
  expect(parseReportRequest({ sessionID: '', view: 'dir' })).toMatchObject({ ok: false });
  expect(parseReportRequest({ sessionID: 's', view: 'gc' })).toMatchObject({ ok: false });
});

test('buildMemoryReport: dir, preview, stale, and list views', () => {
  const config = reportConfig();
  const state = rebuildMemoryIndex(CWD, 'ses_1', config.root).state;
  const base = {
    state,
    config,
    cwd: CWD,
    sessionID: 'ses_1',
    delivery: null,
    child: false,
    warnings: [],
    now: NOW,
    env: {},
  };
  expect(buildMemoryReport({ ...base, view: 'dir' })).toBe(
    [
      `Memory root: ${sandbox}`,
      `Global:  ${sandbox}/global`,
      `Project: ${sandbox}/projects/--work-demo--`,
      `Session: ${sandbox}/projects/--work-demo--/sessions/ses_1`,
      'Project slug: --work-demo--',
      'Session id: ses_1',
    ].join('\n'),
  );
  expect(buildMemoryReport({ ...base, view: 'preview' })).toBe('(no memories - nothing is delivered)');
  expect(buildMemoryReport({ ...base, view: 'list' })).toBe('(no memories saved)');

  const saved = runMemoryAction(
    state,
    { action: 'save', type: 'project', name: 'Old', description: 'old fact', body: 'b' },
    { cwd: CWD, sessionId: 'ses_1', root: config.root, now: () => new Date('2026-09-01T00:00:00.000Z') },
  ).state;
  const withEntry = { ...base, state: saved };
  expect(buildMemoryReport({ ...withEntry, view: 'preview' })).toMatch(
    /^Next prompt \(full\):\n\nput <context key="memory-index">:\n\n## Memory/,
  );
  expect(buildMemoryReport({ ...withEntry, view: 'stale' })).toContain('  old (72d) - Old: old fact');
  expect(buildMemoryReport({ ...withEntry, child: true, view: 'preview' })).toMatch(/^Subagent session/);
  expect(buildMemoryReport({ ...withEntry, warnings: ['x.md: bad'], view: 'list' })).toContain(
    'Warnings:\n  x.md: bad',
  );
});
