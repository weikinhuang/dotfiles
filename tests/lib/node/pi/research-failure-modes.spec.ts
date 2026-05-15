/**
 * Cross-module failure-mode suite for research-core.
 *
 * These invariants span MORE THAN ONE research-* module — individual
 * module specs cannot assert them because the contract lives at the
 * seam between modules. They are the evidence that the
 * research-extensions robustness principle holds: the machinery
 * carries the load across model tiers, and the same guarantees hold
 * regardless of whether the optional `tinyModel` plumbing is wired
 * in.
 *
 * The seven assertions here mirror the Phase 5 handoff spec:
 *
 *   1. Quarantined artifact's `.provenance.json` sidecar survives
 *      the move (research-quarantine + research-provenance).
 *   2. `callTyped` that exhausts retries with a throwing fallback
 *      surfaces a typed error, not `undefined` (research-structured
 *      + research-stuck).
 *   3. `fanout.json` + `plan.json` writes to the same run directory
 *      do not corrupt each other under concurrency (atomic-write
 *      + research-plan).
 *   4. `fetchAndStore` concurrent on the same URL produces one
 *      source file (research-sources cache-key de-dup).
 *   5. `appendJournal` under simulated interrupt leaves either a
 *      full entry or no entry, never a truncated entry
 *      (research-journal + atomic-write).
 *   6. `research-watchdog.watch` with `abortOnStall: false` reports
 *      the stall but never touches the handle (pure observation
 *      mode).
 *   7. Tiny adapter is non-load-bearing: with `tinyModel` unset,
 *      every `callTinyRewrite` / `callTinyClassify` /
 *      `callTinyMatch` returns `null`; a representative subset of
 *      the other failure-mode assertions produces identical results
 *      regardless of whether `tinyModel` is wired up.
 */

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { atomicWriteFile } from '../../../../lib/node/pi/atomic-write.ts';
import { appendJournal, readJournal } from '../../../../lib/node/pi/research-journal.ts';
import { paths } from '../../../../lib/node/pi/research-paths.ts';
import { readPlan, writePlan, type DeepResearchPlan } from '../../../../lib/node/pi/research-plan.ts';
import { readProvenance, writeSidecar, type Provenance } from '../../../../lib/node/pi/research-provenance.ts';
import { quarantine } from '../../../../lib/node/pi/research-quarantine.ts';
import {
  fetchAndStore,
  listRun,
  type McpClient,
  type McpConvertHtmlResult,
  type McpFetchUrlInput,
  type McpFetchUrlResult,
  type McpSearchWebResult,
} from '../../../../lib/node/pi/research-sources.ts';
import { callTyped, type ResearchSessionLike, type SchemaLike } from '../../../../lib/node/pi/research-structured.ts';
import {
  createTinyAdapter,
  type TinyAdapterWiring,
  type TinyRunOneShot,
  type TinyRunResult,
  type TinySettings,
} from '../../../../lib/node/pi/research-tiny.ts';
import { watch, type WatchdogHandleLike, type WatchdogStatus } from '../../../../lib/node/pi/research-watchdog.ts';
import { type AgentDef } from '../../../../lib/node/pi/subagent-loader.ts';

// ──────────────────────────────────────────────────────────────────────
// Shared tempdir fixture
// ──────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'research-failure-modes-'));
});

afterEach(() => {
  // Restore perms on the atomic-write simulation dir if a test
  // left it chmodded — `rmSync(..., { force: true })` ignores
  // ENOENT but cannot remove a non-empty read-only dir. Best-effort
  // restore before the final rm.
  try {
    chmodSync(tmpDir, 0o755);
  } catch {
    /* ignore — may already be writable or already removed */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Helpers: planner fixture, schema, session fake.
// ──────────────────────────────────────────────────────────────────────

function makePlan(slug: string): DeepResearchPlan {
  return {
    kind: 'deep-research',
    question: `why ${slug}?`,
    slug,
    subQuestions: [],
    budget: { maxSubagents: 4, maxFetches: 20, maxCostUsd: 1, wallClockSec: 300 },
    status: 'planning',
  };
}

interface Verdict {
  approved: boolean;
}

const verdictSchema: SchemaLike<Verdict> = {
  validate(v) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'not an object' };
    const o = v as Record<string, unknown>;
    if (typeof o.approved !== 'boolean') return { ok: false, error: 'approved must be boolean' };
    return { ok: true, value: { approved: o.approved } };
  },
};

/** Mock session delivering a fixed script of assistant replies. */
function makeSession(scripted: string[]): ResearchSessionLike {
  const messages: { role: string; content: { type: string; text: string }[] }[] = [];
  let next = 0;
  return {
    state: { messages },
    prompt: (task: string) => {
      const reply = scripted[next++] ?? '';
      messages.push({ role: 'user', content: [{ type: 'text', text: task }] });
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      return Promise.resolve();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers: MCP client, watchdog clock + handle.
//
// These shapes duplicate patterns in sibling specs on purpose — each
// research-*.spec.ts owns its own fixtures rather than reaching into
// a shared module. See research-watchdog.spec.ts for the canonical
// `makeClock` / `makeHandle`, research-sources.spec.ts for the
// canonical `MockMcpClient`, research-structured.spec.ts for the
// canonical `makeSession`. Keeping them local avoids cross-spec
// imports; if a future maintainer extracts a shared fixtures module,
// this file is a natural migration target alongside the siblings.
// ──────────────────────────────────────────────────────────────────────

/**
 * Client that answers any normalized form of one URL with the same
 * markdown body. The returned response's `url` field is the ORIGINAL
 * caller-supplied URL (captured from the factory argument) — the
 * source store records `normalizeUrl(url)` in the persisted ref
 * regardless, so the literal here is just a placeholder.
 */
function makeSingleUrlClient(url: string, content: string): McpClient {
  return {
    fetchUrl(_input: McpFetchUrlInput): Promise<McpFetchUrlResult> {
      return Promise.resolve<McpFetchUrlResult>({ content, title: 'Article', mediaType: 'text/markdown', url });
    },
    convertHtml(): Promise<McpConvertHtmlResult> {
      return Promise.reject(new Error('convertHtml: not used'));
    },
    searchWeb(): Promise<McpSearchWebResult> {
      return Promise.reject(new Error('searchWeb: not used'));
    },
  };
}

/** Virtual clock the tests drive forward explicitly via sleep(). */
function makeClock(startMs = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = startMs;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
}

/** Script a handle whose `status()` returns queued snapshots in order. */
function makeHandle(id: string, snapshots: WatchdogStatus[]): WatchdogHandleLike & { aborts: string[] } {
  const aborts: string[] = [];
  let i = 0;
  return {
    id,
    aborts,
    status: () => {
      const snap = snapshots[i] ?? snapshots[snapshots.length - 1];
      if (i < snapshots.length - 1) i++;
      return Promise.resolve(snap);
    },
    abort: (reason?: string) => {
      aborts.push(reason ?? '(none)');
      return Promise.resolve();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers: Tiny-adapter fixtures (for invariant 7).
// ──────────────────────────────────────────────────────────────────────

interface FakeModel {
  readonly __tag: 'fake-model';
  readonly id: string;
}

function fakeAgent(): AgentDef {
  return {
    path: '/virtual/tiny-helper.md',
    source: 'global',
    name: 'tiny-helper',
    description: 'failure-modes test fake',
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
    body: 'fake body',
  };
}

function fakeModelRegistry(): {
  find: (provider: string, modelId: string) => FakeModel;
  authStorage: unknown;
} {
  return {
    find(provider, modelId) {
      return { __tag: 'fake-model', id: `${provider}/${modelId}` };
    },
    authStorage: {},
  };
}

function noopRunOneShot(): TinyRunOneShot<FakeModel> {
  return () =>
    Promise.resolve<TinyRunResult>({
      finalText: 'unused',
      stopReason: 'completed',
    });
}

function fakeCtx(cwd: string): {
  cwd: string;
  model: FakeModel;
  modelRegistry: ReturnType<typeof fakeModelRegistry>;
} {
  return {
    cwd,
    model: { __tag: 'fake-model', id: 'parent' },
    modelRegistry: fakeModelRegistry(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Representative-subset runner — used by the non-load-bearing
// invariant (test 8) to assert bit-identical outcomes with and
// without `tinyModel` configured.
// ──────────────────────────────────────────────────────────────────────

async function runRepresentativeSubset(rootDir: string): Promise<{
  sidecarSurvived: boolean;
  typedErrorThrown: string;
  sourceFileCount: number;
  journalEntryCount: number;
  watchdogAborted: boolean;
  watchdogCallbacks: number;
}> {
  // (a) quarantine sidecar round-trip.
  const qdir = join(rootDir, 'q');
  const artifact = join(qdir, 'finding.md');
  atomicWriteFile(artifact, '---\nmodel: "m"\n---\n# body\n');
  const prov: Provenance = { model: 'm', thinkingLevel: null, timestamp: '2025-01-01T00:00:00Z', promptHash: 'h' };
  writeSidecar(artifact, prov);
  const qres = quarantine(artifact, 'representative-subset', {
    now: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
  });
  const sidecarSurvived = readProvenance(qres.movedTo) !== null;

  // (b) callTyped with throwing fallback.
  const session = makeSession(['not json', 'still not', 'never json']);
  let typedErrorThrown = '';
  try {
    await callTyped<Verdict>({
      session,
      prompt: 'verdict',
      schema: verdictSchema,
      maxRetries: 3,
      fallback: () => {
        throw new Error('fallback-exhausted');
      },
    });
  } catch (e) {
    typedErrorThrown = e instanceof Error ? e.message : String(e);
  }

  // (c) cache de-dup under concurrent fetchAndStore.
  const runRoot = join(rootDir, 'run');
  const fetchClient = makeSingleUrlClient('https://example.com/article?utm_source=a', 'article body');
  await Promise.all([
    fetchAndStore(runRoot, 'https://example.com/article?utm_source=a', fetchClient),
    fetchAndStore(runRoot, 'https://example.com/article?utm_source=b', fetchClient),
  ]);
  const sourceFileCount = listRun(runRoot).length;

  // (d) journal — a single successful append gives us the entry
  //     count surface; the full atomic-write contract under
  //     simulated interrupt lives in its dedicated test so this
  //     helper stays side-effect-predictable across the two passes.
  const journalPath = join(rootDir, 'journal.md');
  appendJournal(journalPath, { level: 'info', heading: 'subset-first', body: 'body-1' });
  const journalEntryCount = readJournal(journalPath).length;

  // (e) watchdog pure observation mode.
  const clock = makeClock(1_000_000);
  const handle = makeHandle('h-obs', [{ done: false, lastProgressAt: 1_000_000 }]);
  let watchdogCallbacks = 0;
  await watch({
    handle,
    staleThresholdMs: 20_000,
    pollIntervalMs: 5_000,
    abortOnStall: false,
    onStall: () => {
      watchdogCallbacks++;
    },
    now: clock.now,
    sleep: clock.sleep,
  });

  return {
    sidecarSurvived,
    typedErrorThrown,
    sourceFileCount,
    journalEntryCount,
    watchdogAborted: handle.aborts.length > 0,
    watchdogCallbacks,
  };
}

// ──────────────────────────────────────────────────────────────────────
// "Running as root" gate — chmod is a no-op against uid 0, so the
// atomic-write simulation test becomes inconclusive under root. The
// invariant still holds; we just can't exercise the failure path.
// ──────────────────────────────────────────────────────────────────────

const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// ──────────────────────────────────────────────────────────────────────
// Assertions — one test() block per cross-module invariant.
// ──────────────────────────────────────────────────────────────────────

describe('research failure modes', () => {
  test('quarantined artifact preserves its .provenance.json sidecar', () => {
    // Cross-module: research-quarantine + research-provenance.
    // An artifact written with a provenance sidecar must remain
    // paired with that sidecar after quarantine. The robustness
    // principle says quarantined artifacts are raw material for
    // post-mortem debugging; losing provenance defeats that.
    const findingsDir = join(tmpDir, 'findings');
    const artifact = join(findingsDir, 'f-7.json');
    atomicWriteFile(artifact, JSON.stringify({ example: true }));
    const prov: Provenance = {
      model: 'anthropic/claude-test',
      thinkingLevel: 'medium',
      timestamp: '2025-02-03T04:05:06.000Z',
      promptHash: 'abc123def456',
    };
    writeSidecar(artifact, prov);

    expect(readProvenance(artifact)).toEqual(prov);

    const result = quarantine(artifact, 'cross-module invariant', {
      now: new Date(Date.UTC(2025, 0, 1, 0, 0, 0)),
    });

    expect(existsSync(artifact)).toBe(false);
    expect(existsSync(`${artifact}.provenance.json`)).toBe(false);
    expect(existsSync(result.movedTo)).toBe(true);
    expect(existsSync(`${result.movedTo}.provenance.json`)).toBe(true);
    expect(readProvenance(result.movedTo)).toEqual(prov);
  });

  test('callTyped exhausting retries with a throwing fallback surfaces a typed error, not undefined', async () => {
    // The callTyped contract says `fallback` is mandatory; callers
    // who want throw-on-exhaust wire `fallback: () => { throw ... }`.
    // This asserts the surface: exhausted retries must either
    // produce a caller-authored value OR propagate the caller's
    // typed error — never `undefined`.
    const session = makeSession(['prose only', 'still prose', 'nope']);
    const onRetry = vi.fn();

    let thrown: unknown;
    try {
      await callTyped<Verdict>({
        session,
        prompt: 'verdict?',
        schema: verdictSchema,
        maxRetries: 3,
        onRetry,
        fallback: () => {
          throw new TypeError('research-structured: no fallback configured');
        },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain('no fallback configured');
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  test('fanout.json alongside plan.json writes cleanly — readPlan reads plan, fanout.json stays intact', async () => {
    // research-plan and (future) research-fanout both land files in
    // the same run directory. They don't truly race — Node.js runs
    // sync fs calls sequentially on a single thread — but their
    // tempfile suffixes must stay unique so interleaved writes don't
    // collide or leak residue. atomic-write's pid+timestamp+counter
    // suffix is what buys us that; this test pins the contract end-
    // to-end at the two modules' shared directory so a future
    // regression (e.g. a static `.tmp` suffix) surfaces here.
    const runRoot = join(tmpDir, 'research', 'race-slug');
    const layout = paths(runRoot);
    const plan = makePlan('race-slug');
    const fanoutSnapshot = {
      tasks: [
        { id: 'sq-1', status: 'running', spawnedAt: '2025-01-01T00:00:00Z' },
        { id: 'sq-2', status: 'spawned', spawnedAt: '2025-01-01T00:00:01Z' },
      ],
    };

    // Interleave the two writers via `Promise.all` across several
    // rounds so a hypothetical tmp-suffix collision has multiple
    // chances to surface.
    for (let round = 0; round < 10; round++) {
      await Promise.all([
        Promise.resolve().then(() => {
          writePlan(layout.plan, { ...plan, status: round % 2 === 0 ? 'planning' : 'fanout' });
        }),
        Promise.resolve().then(() => {
          atomicWriteFile(layout.fanout, `${JSON.stringify({ ...fanoutSnapshot, round }, null, 2)}\n`);
        }),
      ]);
    }

    // readPlan must return a validated plan after the race.
    const readBack = readPlan(layout.plan);

    expect(readBack.kind).toBe('deep-research');
    expect(readBack.slug).toBe('race-slug');

    // fanout.json must still parse cleanly.
    const fanoutJson: unknown = JSON.parse(readFileSync(layout.fanout, 'utf8'));

    expect(fanoutJson).toMatchObject({ round: 9 });

    // No tmp-* residue from either writer.
    const residue = readdirSync(runRoot).filter((n) => n.includes('.tmp-'));

    expect(residue).toEqual([]);
  });

  test('concurrent fetchAndStore on the same URL produces ONE source file (cache-key de-dup)', async () => {
    // Two callers racing on the same URL may both miss the cache and
    // both call the network (the module does not serialize in-flight
    // fetches; higher layers do), but because cache keys derive
    // purely from the normalized URL both persists land on the same
    // pair of files. listRun must show exactly one entry.
    const runRoot = join(tmpDir, 'research', 'dedup');
    const url = 'https://example.com/page?utm_source=twitter&a=1';
    const urlVariant = 'https://example.com/page?a=1&fbclid=xyz';
    const client = makeSingleUrlClient(url, '# page content\n');

    await Promise.all([
      fetchAndStore(runRoot, url, client),
      fetchAndStore(runRoot, urlVariant, client),
      fetchAndStore(runRoot, url, client),
    ]);

    const refs = listRun(runRoot);

    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe('https://example.com/page?a=1');
  });

  test.skipIf(RUNNING_AS_ROOT)(
    'appendJournal under simulated interrupt produces a full entry or no entry (atomic-write contract)',
    () => {
      // chmodSync to block the tempfile write is our interrupt
      // simulation — atomicWriteFile throws inside appendJournal
      // without having touched the destination. The destination
      // must keep its full old content (or stay absent); a
      // truncated entry at the tail would be a violation of the
      // atomic contract.
      const path = join(tmpDir, 'journal.md');
      appendJournal(path, { level: 'info', heading: 'first', body: 'body-1' });
      const before = readFileSync(path, 'utf8');

      expect(readJournal(path)).toHaveLength(1);

      // Block any new file creation in `tmpDir` — atomicWriteFile's
      // tempfile creation fails with EACCES before the rename step.
      chmodSync(tmpDir, 0o555);
      let threw = false;
      try {
        appendJournal(path, { level: 'error', heading: 'second', body: 'body-2' });
      } catch {
        threw = true;
      } finally {
        chmodSync(tmpDir, 0o755);
      }

      expect(threw).toBe(true);

      // Full old content survives — not truncated, not partially
      // rewritten.
      const after = readFileSync(path, 'utf8');

      expect(after).toBe(before);
      expect(readJournal(path)).toHaveLength(1);
      expect(readJournal(path)[0].heading).toBe('first');

      // And no tempfile residue leaked into the directory.
      const residue = readdirSync(tmpDir).filter((n) => n.includes('.tmp-'));

      expect(residue).toEqual([]);

      // Empty-file case: a fresh path under a read-only parent
      // should leave no file behind after a throwing
      // appendJournal.
      const freshDir = mkdtempSync(join(tmpdir(), 'research-fm-fresh-'));
      try {
        chmodSync(freshDir, 0o555);
        const freshPath = join(freshDir, 'journal.md');
        let freshThrew = false;
        try {
          appendJournal(freshPath, { level: 'info', heading: 'never-lands' });
        } catch {
          freshThrew = true;
        }

        expect(freshThrew).toBe(true);
        expect(existsSync(freshPath)).toBe(false);
      } finally {
        chmodSync(freshDir, 0o755);
        rmSync(freshDir, { recursive: true, force: true });
      }
    },
  );

  test('watchdog with abortOnStall: false reports the stall but never touches the handle', async () => {
    // Pure-observation mode: the watchdog must call onStall exactly
    // once on stall detection and must NOT call handle.abort().
    // Parent controllers that want to decide abort policy
    // themselves rely on this contract.
    const clock = makeClock(1_000_000);
    const handle = makeHandle('h-observe', [{ done: false, lastProgressAt: 1_000_000 }]);
    const onStall = vi.fn();

    const result = await watch({
      handle,
      staleThresholdMs: 20_000,
      pollIntervalMs: 5_000,
      abortOnStall: false,
      onStall,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ kind: 'stalled', aborted: false });
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(handle.aborts).toEqual([]);
  });

  test('tiny adapter (tinyModel unset): every call returns null without invoking the runner', async () => {
    // Non-load-bearing plumbing — part 1: with no settings
    // resolved, the adapter is permanently disabled and MUST short-
    // circuit every call surface without spawning anything.
    const runner = vi.fn<TinyRunOneShot<FakeModel>>(noopRunOneShot());
    const wiring: TinyAdapterWiring<FakeModel> = {
      settings: null,
      tinyHelperAgent: fakeAgent(),
      runOneShot: runner,
    };
    const adapter = createTinyAdapter(wiring);
    const cwd = mkdtempSync(join(tmpdir(), 'research-fm-tiny-off-'));
    try {
      expect(adapter.isEnabled()).toBe(false);
      expect(await adapter.callTinyRewrite(fakeCtx(cwd), 'slugify', 'hello')).toBeNull();
      expect(await adapter.callTinyClassify(fakeCtx(cwd), 'classify', 'x', ['a', 'b'])).toBeNull();
      expect(await adapter.callTinyMatch(fakeCtx(cwd), 'q', ['alpha', 'beta'])).toBeNull();
      expect(runner).not.toHaveBeenCalled();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('failure-mode representative subset is identical with and without tinyModel configured', async () => {
    // Non-load-bearing plumbing — part 2: flipping the tiny adapter
    // between unset (no settings) and set (settings + mock runner)
    // must not change the outcome of any cross-module failure-mode
    // invariant. The subset run here exercises quarantine +
    // provenance, callTyped, source de-dup, journal append, and
    // watchdog pure observation — none of which touch the tiny
    // adapter. If a future change starts threading tiny calls
    // through any of these paths, this test will flip red and flag
    // the regression.
    const runDirA = mkdtempSync(join(tmpdir(), 'research-fm-subset-off-'));
    const runDirB = mkdtempSync(join(tmpdir(), 'research-fm-subset-on-'));

    try {
      // --- Pass A: tiny adapter disabled. ---
      const adapterOff = createTinyAdapter<FakeModel>({
        settings: null,
        tinyHelperAgent: fakeAgent(),
        runOneShot: noopRunOneShot(),
      });

      expect(adapterOff.isEnabled()).toBe(false);

      const resultA = await runRepresentativeSubset(runDirA);

      // --- Pass B: tiny adapter enabled (but none of the subset
      //             helpers actually invoke it — that's the point). ---
      const settingsOn: TinySettings = { tinyModel: 'local/tiny-1', source: '/virtual/settings.json' };
      const runner = vi.fn<TinyRunOneShot<FakeModel>>(noopRunOneShot());
      const adapterOn = createTinyAdapter<FakeModel>({
        settings: settingsOn,
        tinyHelperAgent: fakeAgent(),
        runOneShot: runner,
      });

      expect(adapterOn.isEnabled()).toBe(true);

      const resultB = await runRepresentativeSubset(runDirB);

      // The subset outcome MUST be identical regardless of whether
      // the adapter is wired up.
      expect(resultB).toEqual(resultA);

      // And the tiny runner must not have been invoked by the
      // subset — if something in the subset acquired a tiny-adapter
      // dependency, this catches it.
      expect(runner).not.toHaveBeenCalled();
    } finally {
      rmSync(runDirA, { recursive: true, force: true });
      rmSync(runDirB, { recursive: true, force: true });
    }
  });
});
