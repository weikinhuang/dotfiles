/**
 * Retry-on-transient-error helper for deep-research fanout subagents.
 *
 * Observed failure mode: when the pipeline dispatches N parallel
 * `web-researcher` subagents against a single local-model backend
 * (e.g. one-GPU llama.cpp / litellm proxy), transient network /
 * concurrency errors occasionally knock out the whole batch at
 * the same moment. The pi-ai SDK surfaces these as thrown
 * `Error("Connection error.")` / `fetch failed` / `ECONNRESET` etc.,
 * which the fanout layer faithfully records as
 * `{ ok: false, reason: <msg> }` — at which point the only
 * recovery is `/research --resume --from=fanout --sq=<failed ids>`.
 *
 * This helper adds a thin retry layer *inside* the spawner, so a
 * transient blip doesn't burn a whole fanout's worth of work. The
 * classifier is conservative: only network-class + 5xx / 429
 * patterns retry. Auth (401/403) / validation (400) / quota errors
 * pass through immediately.
 *
 * Design choices:
 *   - Retries are wrapped *around* the single LLM call, not the
 *     outer fanout loop — the fanout's own idempotency (one finding
 *     file per sub-question) already handles broader recovery.
 *   - Jittered exponential backoff so 5 concurrent retries don't
 *     re-collide at the same millisecond (which is exactly what
 *     caused the batch failure we saw).
 *   - `classifyTransientError` is exported separately so tests can
 *     exercise the pattern list without spinning up a retry loop.
 *   - `sleep` is injectable so tests don't burn wall-clock.
 *
 * Non-goals: this is NOT a circuit breaker, token-bucket, or
 * queue. It's a bounded retry per task. Backend-level overload
 * (many sustained retries across many tasks) is still best-handled
 * by the existing `/research --resume` recovery path.
 */

/**
 * Error-message substrings / patterns we treat as transient.
 * Matched case-insensitively where appropriate. Kept conservative:
 * the goal is "don't burn a whole fanout batch on a connection
 * blip", not "retry everything that fails".
 */
export const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  // Generic network / transport failures from node:http, undici,
  // node-fetch, openai-sdk.
  /\bconnection error\b/i,
  /\bfetch failed\b/i,
  /\bnetwork error\b/i,
  /\bsocket hang up\b/i,
  /\brequest timed out\b/i,
  /\brequest timeout\b/i,

  // POSIX-style errno codes bubbled up by node net stack.
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bECONNABORTED\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bENOTFOUND\b/, // intermittent DNS failures

  // HTTP-level transient statuses. Anchored to avoid matching "429ers"
  // or "503-byte response" — look for the code as a bare token.
  /(?:^|\D)429(?:\D|$)/,
  /(?:^|\D)500(?:\D|$)/,
  /(?:^|\D)502(?:\D|$)/,
  /(?:^|\D)503(?:\D|$)/,
  /(?:^|\D)504(?:\D|$)/,

  // Named forms of the same.
  /\brate limit(ed|ing)?\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
  /\binternal server error\b/i,
];

/**
 * True when `err.message` (or `String(err)` for non-Error throws)
 * matches a known transient pattern.
 */
export function classifyTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(msg));
}

export interface RetryOptions {
  /** Total attempts including the initial call. Default `3`. */
  maxAttempts?: number;
  /** Base delay for the first retry (ms). Default `1500`. */
  initialDelayMs?: number;
  /** Hard upper bound on any single backoff wait (ms). Default `8000`. */
  maxDelayMs?: number;
  /**
   * Abort signal. When aborted mid-wait, the helper rejects with
   * the last observed error (so callers see *why* we were retrying,
   * not a generic abort).
   */
  signal?: AbortSignal;
  /**
   * Optional hook fired before each retry wait. Useful for journal
   * logging: `(attempt, err, delayMs) => appendJournal(...)`.
   */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Injection point for tests. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter. Defaults to `Math.random`. Range [0,1). */
  random?: () => number;
}

/**
 * Compute the backoff delay for a given `attempt` (1-indexed,
 * where `1` is the first retry, i.e. after the initial call
 * failed). Exponential with ±25% jitter.
 *
 * Exported so tests can reason about the schedule without
 * stubbing the whole retry loop.
 */
export function computeBackoffMs(
  attempt: number,
  opts: Pick<RetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'random'> = {},
): number {
  const initial = opts.initialDelayMs ?? 1500;
  const cap = opts.maxDelayMs ?? 8000;
  const rand = opts.random ?? Math.random;
  // Exponential: initial, 2×, 4×, 8× … capped at `maxDelayMs`.
  const base = Math.min(cap, initial * 2 ** Math.max(0, attempt - 1));
  // ±25% jitter so N concurrent retries don't re-collide at the
  // same millisecond (exactly the failure mode this helper exists
  // to absorb).
  const jitter = base * (rand() * 0.5 - 0.25);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Run `fn` up to `opts.maxAttempts` times. Retries only when the
 * thrown error passes `classifyTransientError`; anything else
 * rethrows immediately so semantic failures aren't masked.
 *
 * `fn` is passed the 1-indexed attempt number so callers can
 * log / fingerprint retries.
 */
export async function withTransientRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      // Surface the last real error if we had one; otherwise a
      // plain abort. Never swallow the reason we were retrying.
      // `lastErr` is typed `unknown` (caught value) so we fork on
      // `instanceof Error` to keep @typescript-eslint/only-throw-error
      // happy without lying about the type.
      if (lastErr instanceof Error) throw lastErr;
      // eslint-disable-next-line no-use-before-define -- stringifyUnknown is a hoisted function declaration defined below the loop; inlining the stringify dispatch here would duplicate it between this branch and the fall-through.
      if (lastErr !== undefined) throw new Error(stringifyUnknown(lastErr));
      throw new Error('aborted');
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      // Last attempt — nothing to wait for, just rethrow.
      if (attempt >= maxAttempts) throw err;
      // Non-transient — bail out immediately so we don't paper
      // over a real problem (auth, validation, quota).
      if (!classifyTransientError(err)) throw err;

      const delayMs = computeBackoffMs(attempt, opts);
      opts.onRetry?.(attempt, err, delayMs);
      await sleep(delayMs);
    }
  }
  // Unreachable — the loop always either returns or throws. Kept
  // as a belt-and-suspenders bail-out that preserves the last real
  // error if we somehow fell through without one being thrown.
  if (lastErr instanceof Error) throw lastErr;
  // eslint-disable-next-line no-use-before-define -- see note above on the in-loop aborted branch.
  if (lastErr !== undefined) throw new Error(stringifyUnknown(lastErr));
  throw new Error('withTransientRetry: exhausted attempts');
}

/**
 * Stringify a non-Error throw (string, number, object, etc.) without
 * falling into `[object Object]`. Preferred over bare `String(v)` so
 * `@typescript-eslint/no-base-to-string` doesn't flag the call site,
 * and so rethrown non-Error values carry a human-readable message.
 */
function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? 'unknown error';
  } catch {
    return 'unknown error (unstringifiable throw value)';
  }
}
