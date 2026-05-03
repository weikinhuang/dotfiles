/**
 * `fetch-web` CLI-backed {@link McpClient} for the deep-research
 * extension.
 *
 * Why this exists: Phase 6 of the deep-research plan uncovered
 * that registering the MCP fetch_web tool list as flat per-tool
 * entries (pi-mcp-adapter's `directTools: true` mode) causes the
 * Anthropic provider to reject the entire tool list because at
 * least one fetch_web tool's `input_schema` uses top-level
 * `oneOf/allOf/anyOf`, which Anthropic refuses. Reverting
 * `directTools` fixes the parent session but leaves the
 * `web-researcher` subagent with zero fetch capability — the
 * pi-mcp-adapter gateway is only exposed as the generic `mcp`
 * tool, which is too thin a shape to ask a small model to drive.
 *
 * The locked decision: migrate the fetch surface to a standalone
 * `fetch-web` CLI (`dotenv/bin/fetch-web`) that hits the same
 * MCP HTTP endpoint but speaks to us over stdout. The subagent
 * now uses its `bash` tool to invoke the CLI; the extension's
 * post-fanout source-store populate step calls that same CLI
 * from node, via this module.
 *
 * Scope:
 *   - Three methods, mapping one-to-one to `McpClient`:
 *     `fetchUrl`, `convertHtml`, `searchWeb`.
 *   - Every call spawns `fetch-web <subcmd> [args] --json`.
 *     `--json` emits the raw MCP `result` object on stdout, so
 *     we parse `structuredContent` directly rather than scraping
 *     the human-readable prelude-stripped default output.
 *   - `convertHtml` pipes the HTML body through the child's stdin
 *     using `fetch-web convert --html-file -`.
 *   - Binary lookup is deferred to the shell's PATH resolution;
 *     callers who want a pre-flight existence check use
 *     `findFetchWebBinary()`.
 *
 * Non-goals:
 *   - No retry logic. `fetchAndStore` already tolerates
 *     per-URL failures and journals them.
 *   - No fallback to the old MCP-over-HTTP client. That module
 *     is being removed as part of the Phase 6a migration.
 *   - No auth-header plumbing here. The CLI reads
 *     `FETCH_WEB_URL` / `FETCH_WEB_AUTH` / `FETCH_WEB_HEADERS`
 *     from its own env, and has a `~/.pi/agent/mcp.json`
 *     convenience fallback for pi-managed installs. We
 *     propagate the parent env unchanged so either path works
 *     without a config knob here.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  type McpClient,
  type McpConvertHtmlInput,
  type McpConvertHtmlResult,
  type McpFetchUrlInput,
  type McpFetchUrlResult,
  type McpSearchResultItem,
  type McpSearchWebInput,
  type McpSearchWebResult,
} from './research-sources.ts';

// ──────────────────────────────────────────────────────────────────────
// Spawn abstraction.
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal shape the module consumes from `child_process.spawn`.
 * The full return type is a `ChildProcess`; we only touch stdin,
 * stdout, stderr, and a single `'close'` event, so the interface
 * is narrowed to match. Tests inject a fake that matches this
 * shape without pulling in a full ChildProcess.
 */
export interface SpawnedChild {
  stdin: { write(chunk: string): boolean; end(): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

// ──────────────────────────────────────────────────────────────────────
// Public factory options.
// ──────────────────────────────────────────────────────────────────────

export interface CreateFetchWebCliClientOpts {
  /**
   * Override the CLI binary. Defaults to the literal name
   * `fetch-web`; the OS resolves it via `PATH`. Tests and
   * non-standard installs pass an absolute path.
   */
  bin?: string;
  /**
   * Extra CLI flags prepended to every invocation after the
   * subcommand. Reserved for tests (e.g. `--timeout-ms`, `-v`);
   * production leaves it empty.
   */
  extraArgs?: string[];
  /**
   * Injected spawn function. Defaults to
   * `node:child_process.spawn`. Tests pass a stub that captures
   * argv + env and yields scripted stdout.
   */
  spawn?: SpawnFn;
  /**
   * Environment variables passed to the child. Defaults to
   * `process.env`, which carries any `FETCH_WEB_URL` /
   * `FETCH_WEB_AUTH` the user set. Tests override to verify the
   * env is threaded through.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Per-call timeout, propagated into the CLI via
   * `--timeout-ms`. Defaults to 30 seconds; the CLI's own
   * default is the same, so omitting it is fine.
   */
  timeoutMs?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Binary discovery.
// ──────────────────────────────────────────────────────────────────────

export interface FindFetchWebBinaryOpts {
  /** Override for `process.env.PATH`. Used by tests. */
  pathEnv?: string;
  /**
   * Override for `process.env`. Used by tests to stub a custom
   * `FETCH_WEB_BIN` short-circuit.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Search `$PATH` for a `fetch-web` executable and return its
 * absolute path, or `null` when nothing is found. An explicit
 * `FETCH_WEB_BIN` env var short-circuits the lookup.
 *
 * The factory does not require this — callers that inject a
 * `bin` override skip PATH entirely. The helper is here so the
 * extension can decide whether to degrade (no source-store
 * populate) when the CLI isn't installed.
 */
export function findFetchWebBinary(opts: FindFetchWebBinaryOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const override = env.FETCH_WEB_BIN;
  if (override && override.length > 0) {
    return existsSync(override) ? override : null;
  }
  const pathEnv = opts.pathEnv ?? env.PATH ?? '';
  if (pathEnv.length === 0) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, 'fetch-web');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Internal: run the CLI, capture stdout, parse JSON.
// ──────────────────────────────────────────────────────────────────────

interface RunArgs {
  bin: string;
  args: string[];
  extraArgs: string[];
  spawn: SpawnFn;
  env: NodeJS.ProcessEnv;
  /** Optional stdin payload; `undefined` leaves stdin closed. */
  stdin?: string;
  timeoutMs: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  /** CLI exit code; `null` only on signal-terminated runs. */
  code: number | null;
}

async function runCli(args: RunArgs): Promise<RunResult> {
  const finalArgs = [...args.extraArgs, '--json', '--timeout-ms', String(args.timeoutMs), ...args.args];
  const child = args.spawn(args.bin, finalArgs, {
    env: args.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });

  if (args.stdin !== undefined) {
    child.stdin.write(args.stdin);
  }
  child.stdin.end();

  return new Promise<RunResult>((resolve, reject) => {
    child.on('error', (err) => {
      reject(new Error(`fetch-web cli: spawn failed: ${err.message}`));
    });
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
      });
    });
  });
}

function parseJsonResult(subcommand: string, run: RunResult): unknown {
  if (run.code !== 0) {
    const stderr = run.stderr.trim().slice(0, 400);
    throw new Error(`fetch-web ${subcommand}: exit ${run.code ?? 'null'}${stderr ? `: ${stderr}` : ''}`);
  }
  const trimmed = run.stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`fetch-web ${subcommand}: empty stdout`);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (e) {
    throw new Error(`fetch-web ${subcommand}: stdout is not JSON: ${(e as Error).message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Structured-content extraction helpers.
// ──────────────────────────────────────────────────────────────────────

/**
 * MCP `tools/call` results carry both a human-readable `content`
 * array and a typed `structuredContent` object (on tools that
 * declare an output schema). The `fetch-web` CLI passes both
 * through when `--json` is set. We always prefer
 * `structuredContent` because it's schema-typed — the text
 * content has a prelude we'd otherwise have to scrape.
 */
function getStructuredContent(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  if (sc && typeof sc === 'object' && !Array.isArray(sc)) return sc as Record<string, unknown>;
  return null;
}

/**
 * Some CLI paths return a bare MCP result whose `isError: true`
 * flag marks a tool-level failure. The human message lives in
 * the `content[0].text` string. Throw with a terse version so
 * `fetchAndStore` can journal it.
 */
function throwIfMcpError(subcommand: string, result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const isError = (result as { isError?: unknown }).isError;
  if (isError !== true) return;
  const content = (result as { content?: unknown }).content;
  let message = '(no message)';
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { text?: unknown } | undefined;
    if (first && typeof first.text === 'string') message = first.text.slice(0, 400);
  }
  throw new Error(`fetch-web ${subcommand}: mcp tool error: ${message}`);
}

// ──────────────────────────────────────────────────────────────────────
// Public factory.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build an {@link McpClient} that drives the `fetch-web` CLI.
 * Every method spawns one child process; failures (non-zero
 * exit, non-JSON stdout, `isError: true` in the MCP result)
 * throw, letting `fetchAndStore` record a per-URL `failed`
 * journal entry and move on.
 */
export function createFetchWebCliClient(opts: CreateFetchWebCliClientOpts = {}): McpClient {
  const bin = opts.bin ?? 'fetch-web';
  const extraArgs = opts.extraArgs ?? [];
  // The `as unknown as SpawnFn` is needed because node's real
  // `spawn` return type is a full `ChildProcess`, but we only
  // consume a narrow subset; the runtime shape matches and
  // typing it down lets tests inject a stub without declaring
  // every ChildProcess field.
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function run(subcommand: string, cliArgs: string[], stdin?: string): Promise<unknown> {
    const runArgs: RunArgs = {
      bin,
      args: cliArgs,
      extraArgs,
      spawn,
      env,
      timeoutMs,
    };
    if (stdin !== undefined) runArgs.stdin = stdin;
    const runResult = await runCli(runArgs);
    const parsed = parseJsonResult(subcommand, runResult);
    throwIfMcpError(subcommand, parsed);
    return parsed;
  }

  return {
    async fetchUrl(input: McpFetchUrlInput): Promise<McpFetchUrlResult> {
      const args = ['fetch', input.url];
      if (input.format !== undefined) {
        // The CLI's `fetch` subcommand only knows `markdown`,
        // `html`, `text`; `readability` is the server default so
        // we drop it on the floor here (the CLI passes through
        // to the server unchanged if we do pass it, but the
        // subcommand help only advertises the three). Pick the
        // narrowest mapping so `--format=html` etc. still reach
        // the server.
        args.push('--format', input.format === 'readability' ? 'markdown' : input.format);
      }
      const result = await run('fetch', args);
      const sc = getStructuredContent(result);
      if (!sc) {
        throw new Error('fetch-web fetch: missing structuredContent in response');
      }
      const text = typeof sc.text === 'string' ? sc.text : '';
      const ret: McpFetchUrlResult = { content: text };
      if (typeof sc.articleTitle === 'string' && sc.articleTitle.length > 0) ret.title = sc.articleTitle;
      if (typeof sc.resolvedUrl === 'string' && sc.resolvedUrl.length > 0) ret.url = sc.resolvedUrl;
      if (typeof sc.contentType === 'string' && sc.contentType.length > 0) ret.mediaType = sc.contentType;
      return ret;
    },

    async convertHtml(input: McpConvertHtmlInput): Promise<McpConvertHtmlResult> {
      const args = ['convert', '--html-file', '-'];
      if (input.baseUrl !== undefined) args.push('--base-url', input.baseUrl);
      if (input.format !== undefined) args.push('--format', input.format);
      const result = await run('convert', args, input.html);
      const sc = getStructuredContent(result);
      if (!sc) {
        throw new Error('fetch-web convert: missing structuredContent in response');
      }
      const text = typeof sc.text === 'string' ? sc.text : '';
      return { content: text };
    },

    async searchWeb(input: McpSearchWebInput): Promise<McpSearchWebResult> {
      const args = ['search', input.query];
      if (input.limit !== undefined) args.push('--limit', String(input.limit));
      const result = await run('search', args);
      const sc = getStructuredContent(result);
      const rawResults = sc && Array.isArray(sc.results) ? (sc.results as unknown[]) : [];
      const results: McpSearchResultItem[] = [];
      for (const item of rawResults) {
        if (!item || typeof item !== 'object') continue;
        const o = item as { url?: unknown; title?: unknown; snippet?: unknown };
        if (typeof o.url !== 'string' || o.url.length === 0) continue;
        const r: McpSearchResultItem = { url: o.url };
        if (typeof o.title === 'string' && o.title.length > 0) r.title = o.title;
        if (typeof o.snippet === 'string' && o.snippet.length > 0) r.snippet = o.snippet;
        results.push(r);
      }
      return { results };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Convenience: construct + PATH check in one call.
// ──────────────────────────────────────────────────────────────────────

export interface CreateFetchWebCliClientFromEnvOpts extends CreateFetchWebCliClientOpts {
  /**
   * Override for the PATH-lookup `process.env.PATH` / `env` the
   * helper probes. Tests set this to restrict discovery to a
   * fixture directory.
   */
  pathEnv?: string;
}

/**
 * Look up `fetch-web` on `$PATH` (or honour `FETCH_WEB_BIN`);
 * if found, build a client pinned to that absolute path. Return
 * `null` when nothing is found so the pipeline can degrade
 * gracefully (skip source-store populate, journal a warning)
 * instead of crashing.
 */
export function createFetchWebCliClientFromEnv(opts: CreateFetchWebCliClientFromEnvOpts = {}): McpClient | null {
  const env = opts.env ?? process.env;
  const findOpts: FindFetchWebBinaryOpts = { env };
  if (opts.pathEnv !== undefined) findOpts.pathEnv = opts.pathEnv;
  const bin = opts.bin ?? findFetchWebBinary(findOpts);
  if (!bin) return null;
  const factoryOpts: CreateFetchWebCliClientOpts = { bin };
  if (opts.extraArgs !== undefined) factoryOpts.extraArgs = opts.extraArgs;
  if (opts.spawn !== undefined) factoryOpts.spawn = opts.spawn;
  if (opts.env !== undefined) factoryOpts.env = opts.env;
  if (opts.timeoutMs !== undefined) factoryOpts.timeoutMs = opts.timeoutMs;
  return createFetchWebCliClient(factoryOpts);
}

/**
 * Type-only re-export so consumers can name the child-process
 * shape the SpawnFn injects; useful for tests that want to
 * stub a child with a precise-enough type to pass strict
 * TypeScript without importing from `node:child_process`.
 */
export type { ChildProcessWithoutNullStreams };
