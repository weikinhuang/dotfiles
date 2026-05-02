/**
 * Per-run source store for the research toolkit.
 *
 * The research pipelines fetch web pages (via the MCP `fetch_web`
 * server), cache the content by a stable URL-derived key, and
 * serve cached hits back to downstream stages (planner, synthesizer,
 * critic) without re-hitting the network. This module is the
 * on-disk backing store for that cache, plus a thin wrapper around
 * the MCP search flow.
 *
 * Design constraints:
 *
 *   - **Pi-runtime-free at the module level.** The module takes an
 *     `McpClient` abstraction object so unit tests can supply a
 *     hand-written fake. The real implementation that bridges to
 *     the MCP `fetch_web` tools lives in the consuming extension.
 *     That keeps the rules around fetch_web's tool surface (tool
 *     names, argument shapes, error semantics) out of this module
 *     and simplifies testing.
 *   - **Per-run scope.** The store writes into `<runRoot>/sources/`.
 *     Cross-run caching (a global `~/.pi/research-cache/`) is a v2
 *     question; it would need TTL + eviction policy that v1 does
 *     not solve for. Callers who want sharing across runs bridge it
 *     at a layer above this module.
 *   - **Stable, collision-resistant keys.** Cache keys are the
 *     12-hex-char prefix of `sha256(normalizeUrl(url))`, matching
 *     `research-provenance.hashPrompt`'s length. Normalization
 *     strips tracking parameters, fragments, default ports, and
 *     sorts remaining query params so trivial URL variants land on
 *     the same cache entry.
 *   - **Provenance on every source.** Each cached `.md` carries a
 *     YAML frontmatter block (via `research-provenance.writeSidecar`)
 *     recording that the content came from `mcp/fetch_web`. The
 *     sibling `.json` carries the structural `SourceRef` so
 *     downstream consumers can `listRun` / `getById` without
 *     parsing the markdown body.
 *   - **Atomic writes.** All mutating writes go through
 *     `atomic-write.atomicWriteFile`; concurrent callers never see
 *     a half-written source file.
 *   - **Tolerant reads.** `getById` / `listRun` silently skip
 *     malformed cache entries rather than throwing — a broken entry
 *     is a re-fetch candidate, not a fatal error. `fetchAndStore`
 *     detects a broken cache (missing / invalid JSON, missing .md)
 *     and re-fetches, overwriting the bad entry.
 *
 * No pi imports.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { paths } from './research-paths.ts';
import { type Provenance, writeSidecar } from './research-provenance.ts';
import { isRecord, sha256Hex, sha256HexPrefix } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Types.
// ──────────────────────────────────────────────────────────────────────

/**
 * On-disk metadata describing a cached source. One `.json` file per
 * cached URL under `<runRoot>/sources/`. The sibling `.md` file (or
 * `.txt`, depending on fetch format — though markdown is the only
 * production output today) holds the actual content.
 *
 *   - `id`           — `hashKey(url)`. Also the cache file basename.
 *   - `url`          — normalized URL used to derive the key. The
 *                      original caller-supplied URL is lost once it
 *                      normalizes; callers who need the raw form
 *                      retain it themselves.
 *   - `title`        — page title if fetch_web returned one, else
 *                      the normalized URL as a readable fallback.
 *   - `fetchedAt`    — ISO8601 timestamp of the successful fetch
 *                      (or of the most recent re-fetch after cache
 *                      repair). Not updated on cached hits.
 *   - `contentHash`  — sha256 hex of the fetched body bytes (the
 *                      exact string the MCP client returned, before
 *                      we prepend any provenance frontmatter). Use
 *                      this to detect whether two runs fetched the
 *                      same resource content, or to diff against a
 *                      re-fetch. Empty string on `method: 'failed'`.
 *   - `method`       — how the ref was produced by this call:
 *                      `fetch` (cache miss → network),
 *                      `cached` (cache hit, no network),
 *                      `failed` (network attempted, failed; no
 *                      content persisted, the ref is returned so
 *                      callers can journal / escalate).
 *   - `mediaType`    — fetch_web's reported media type, else
 *                      `text/markdown` (the default fetch format).
 *   - `errorReason?` — present only when `method === 'failed'`.
 *                      The stringified underlying error (the `err.message`
 *                      from the thrown fetch call, or the string form
 *                      of the value when a non-Error was thrown). Lets
 *                      callers journal *why* a fetch failed without
 *                      having to retain the exception themselves.
 */
export interface SourceRef {
  id: string;
  url: string;
  title: string;
  fetchedAt: string;
  contentHash: string;
  method: 'fetch' | 'cached' | 'failed';
  mediaType: string;
  errorReason?: string;
}

/**
 * Full source record — `ref` plus the cached content bytes.
 * Returned by `getById`. `content` is empty for a historical
 * `failed` ref (should not happen in practice since failed refs
 * are not persisted, but the type accommodates it).
 */
export interface Source {
  ref: SourceRef;
  content: string;
}

// ──────────────────────────────────────────────────────────────────────
// McpClient abstraction — what this module needs from fetch_web.
// ──────────────────────────────────────────────────────────────────────

/**
 * Minimal abstraction over the subset of MCP `fetch_web` tools the
 * source store depends on. Consumers build a concrete client that
 * bridges these three methods onto real MCP tool calls; unit tests
 * pass a fake returning deterministic fixtures.
 *
 * Keeping the interface narrow (three methods, small arg shapes)
 * means research-core does not drift when MCP fetch_web adds
 * parameters — the bridge in the consuming extension can ignore
 * them or expose them behind an opt-in extension point.
 */
export interface McpClient {
  fetchUrl(input: McpFetchUrlInput): Promise<McpFetchUrlResult>;
  convertHtml(input: McpConvertHtmlInput): Promise<McpConvertHtmlResult>;
  searchWeb(input: McpSearchWebInput): Promise<McpSearchWebResult>;
}

export interface McpFetchUrlInput {
  url: string;
  /**
   * Preferred output format. Callers typically leave it unset and
   * accept the default (`readability`-derived markdown), which is
   * what the cache stores. `html` is available for callers that
   * want to convert downstream via `convertHtml`.
   */
  format?: 'markdown' | 'readability' | 'text' | 'html';
}

export interface McpFetchUrlResult {
  /** Primary text content in the requested format. */
  content: string;
  /** Final URL after redirects, if fetch_web reports one. */
  url?: string;
  /** Page title if fetch_web could extract one. */
  title?: string;
  /** Media type fetch_web returned; defaults to `text/markdown`. */
  mediaType?: string;
}

export interface McpConvertHtmlInput {
  html: string;
  baseUrl?: string;
  format?: 'markdown' | 'readability' | 'text';
}

export interface McpConvertHtmlResult {
  content: string;
}

export interface McpSearchWebInput {
  query: string;
  limit?: number;
}

export interface McpSearchWebResult {
  results: McpSearchResultItem[];
}

export interface McpSearchResultItem {
  url: string;
  title?: string;
  snippet?: string;
}

// ──────────────────────────────────────────────────────────────────────
// URL normalization.
// ──────────────────────────────────────────────────────────────────────

/**
 * Tracking-parameter matchers. The plan specifies utm_*, fbclid,
 * gclid, and mc_* — we stick to exactly those so behavior is
 * predictable; adding more (yclid, msclkid, ...) would broaden the
 * contract without a matching test guarantee.
 */
const TRACKING_PARAM_RULES: RegExp[] = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_/i];

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAM_RULES.some((re) => re.test(name));
}

/**
 * Canonicalize a URL so "the same resource with different noise"
 * collapses to a single cache key.
 *
 * Rules:
 *   - Parse via WHATWG URL so invalid inputs throw `TypeError` (the
 *     same error `new URL` throws). Callers catch upstream.
 *   - Lowercase scheme + host. Path + query keys/values stay
 *     case-sensitive — URLs are case-sensitive below the authority
 *     component in HTTP, and flattening would collide distinct
 *     resources.
 *   - Strip default ports (`:80` on http, `:443` on https). Other
 *     schemes and non-default ports are preserved.
 *   - Strip fragment (`#anchor`). Fragments are client-side only
 *     and never change the fetched bytes.
 *   - Strip tracking parameters matching `TRACKING_PARAM_RULES`.
 *   - Sort the remaining query parameters alphabetically. URL
 *     parameter order rarely matters for the resource identity, and
 *     sorting is the cheapest dedup we get against callers that
 *     rearrange args.
 *   - Drop the `?` suffix entirely when the query becomes empty
 *     after filtering.
 *
 * Idempotent: `normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)`.
 */
export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());

  // WHATWG URL already lowercases `protocol` and `hostname` on
  // construction, but we assign back in case the upstream
  // platform's URL implementation drifts.
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  url.hash = '';

  // Filter tracking params. Collect remaining (key,value) pairs,
  // sort, and rebuild the query in one pass so we don't mutate the
  // iterator we're reading.
  const kept: [string, string][] = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  // Reset the search and repopulate. Assigning `url.search = ''`
  // also clears the surviving `?` suffix so an all-tracking-param
  // URL collapses cleanly.
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);

  return url.toString();
}

// ──────────────────────────────────────────────────────────────────────
// Cache key derivation.
// ──────────────────────────────────────────────────────────────────────

/**
 * Hash a URL that has ALREADY been through `normalizeUrl`. Skip this
 * entry point unless you have an already-normalized string in hand —
 * callers who pass raw URLs should use `hashKey` so they stay on the
 * single normalize-then-hash pipeline.
 */
function hashKeyOfNormalized(normalized: string): string {
  return sha256HexPrefix(normalized, 12);
}

/**
 * 12-char hex sha256 prefix of the normalized URL. Matches the
 * length convention from `research-provenance.hashPrompt` so keys
 * in journals / provenance / source refs all read consistently.
 */
export function hashKey(url: string): string {
  return hashKeyOfNormalized(normalizeUrl(url));
}

// ──────────────────────────────────────────────────────────────────────
// Layout helpers.
// ──────────────────────────────────────────────────────────────────────

/**
 * Source store dir: `<runRoot>/sources/`. Mirrors `research-paths`
 * so callers that already have a run root can reach the store
 * without re-deriving the path.
 */
function sourcesDir(runRoot: string): string {
  return paths(runRoot).sources;
}

function refPath(runRoot: string, id: string): string {
  return join(sourcesDir(runRoot), `${id}.json`);
}

function contentPath(runRoot: string, id: string): string {
  return join(sourcesDir(runRoot), `${id}.md`);
}

// ──────────────────────────────────────────────────────────────────────
// SourceRef validation.
// ──────────────────────────────────────────────────────────────────────

function isSourceMethod(v: unknown): v is SourceRef['method'] {
  return v === 'fetch' || v === 'cached' || v === 'failed';
}

function isSourceRefShape(v: unknown): v is SourceRef {
  if (!isRecord(v)) return false;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.url !== 'string' || v.url.length === 0) return false;
  if (typeof v.title !== 'string') return false;
  if (typeof v.fetchedAt !== 'string' || v.fetchedAt.length === 0) return false;
  if (typeof v.contentHash !== 'string') return false;
  if (!isSourceMethod(v.method)) return false;
  if (typeof v.mediaType !== 'string' || v.mediaType.length === 0) return false;
  // `contentHash` must be non-empty for any ref we persist — only
  // `failed` refs (which are NEVER persisted) are allowed an empty
  // hash. Tightening here means an on-disk ref with an empty hash
  // is rejected as malformed and triggers a re-fetch, which is
  // what callers would want anyway.
  if (v.method !== 'failed' && v.contentHash.length === 0) return false;
  if (v.errorReason !== undefined && typeof v.errorReason !== 'string') return false;
  return true;
}

function readRef(runRoot: string, id: string): SourceRef | null {
  const p = refPath(runRoot, id);
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    return isSourceRefShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Persist a fetched source.
// ──────────────────────────────────────────────────────────────────────

interface PersistInput {
  runRoot: string;
  id: string;
  normalizedUrl: string;
  title: string;
  content: string;
  mediaType: string;
  fetchedAt: string;
}

function persist(input: PersistInput): SourceRef {
  ensureDirSync(sourcesDir(input.runRoot));

  const md = contentPath(input.runRoot, input.id);
  atomicWriteFile(md, input.content);

  // Frontmatter carrying provenance: the fetch was performed by the
  // MCP fetch_web bridge, not authored by an LLM. `promptHash`
  // doubles as the cache key here — the "prompt" of a fetch is its
  // URL, and the key is already `sha256(normalizedUrl) prefix-12`.
  const prov: Provenance = {
    model: 'mcp/fetch_web',
    thinkingLevel: null,
    timestamp: input.fetchedAt,
    promptHash: input.id,
  };
  writeSidecar(md, prov);

  const ref: SourceRef = {
    id: input.id,
    url: input.normalizedUrl,
    title: input.title,
    fetchedAt: input.fetchedAt,
    // Hash the body bytes as returned by the MCP client — NOT the
    // full on-disk file, which also includes the provenance
    // frontmatter. Body-only means two runs that fetched the same
    // resource produce the same hash even if their provenance
    // timestamps differ, and re-hashing the raw fetch result in
    // tests / tooling lines up without having to parse off the
    // frontmatter first.
    contentHash: sha256Hex(input.content),
    method: 'fetch',
    mediaType: input.mediaType,
  };

  atomicWriteFile(refPath(input.runRoot, input.id), `${JSON.stringify(ref, null, 2)}\n`);
  return ref;
}

// ──────────────────────────────────────────────────────────────────────
// Public API: fetchAndStore.
// ──────────────────────────────────────────────────────────────────────

export interface FetchAndStoreOpts {
  /**
   * Fetch format passed to the MCP client. Defaults to
   * `readability` which yields markdown optimized for reading. The
   * stored file is always written as `<id>.md` regardless — the
   * format parameter controls what the upstream renderer produces.
   */
  format?: McpFetchUrlInput['format'];
  /**
   * Explicit timestamp used for `fetchedAt`. Tests pass a frozen
   * value for byte-identical output; production callers leave it
   * unset and the helper uses `new Date().toISOString()`.
   */
  now?: () => Date;
}

/**
 * Cache-or-fetch for a single URL. Return a `SourceRef` describing
 * the outcome:
 *
 *   - Valid cache hit            → `method: 'cached'`
 *   - Cache miss (or broken cache) → fetch via `mcpClient`, persist,
 *                                    return `method: 'fetch'`
 *   - Network failure             → `method: 'failed'`, nothing
 *                                    persisted (so a subsequent
 *                                    call will retry)
 *
 * "Broken cache" means the `.json` ref is missing / malformed OR
 * the companion `.md` content file is missing / unreadable. Either
 * case triggers a re-fetch; the new entry overwrites whatever was
 * there.
 */
/**
 * Extract a human-readable reason string from an unknown thrown
 * value. Covers the three shapes we actually see from the MCP
 * client fake + real transports: native `Error` subclasses, plain
 * strings thrown directly, and arbitrary structural objects that
 * get JSON.stringified. Falls back to `'unknown error'` for values
 * we can't meaningfully serialize (circular refs, symbols).
 */
function errorToReason(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown error';
  }
}

export async function fetchAndStore(
  runRoot: string,
  url: string,
  mcpClient: McpClient,
  opts: FetchAndStoreOpts = {},
): Promise<SourceRef> {
  // Normalize once, hash the normalized form. The old call chain
  // (`const id = hashKey(url)`) did the normalization twice per
  // cache miss — cheap, but pointlessly so.
  const normalized = normalizeUrl(url);
  const id = hashKeyOfNormalized(normalized);

  // Probe the cache. Accept a ref only if both sibling files are
  // readable — a stray .json with no .md is a broken cache entry
  // that we want to repair via re-fetch.
  const cachedRef = readRef(runRoot, id);
  if (cachedRef && existsSync(contentPath(runRoot, id))) {
    return { ...cachedRef, method: 'cached' };
  }

  const now = opts.now ?? ((): Date => new Date());
  const fetchedAt = now().toISOString();

  let result: McpFetchUrlResult;
  try {
    result = await mcpClient.fetchUrl({
      url: normalized,
      ...(opts.format !== undefined ? { format: opts.format } : {}),
    });
  } catch (err) {
    // Transport / upstream error. Do not persist; return a
    // `failed` ref so the caller can journal / escalate. A
    // subsequent `fetchAndStore(url)` will retry. We preserve the
    // underlying error text in `errorReason` so downstream code
    // that wants to log "why did it fail?" has a stable signal
    // without needing the original exception.
    return {
      id,
      url: normalized,
      title: normalized,
      fetchedAt,
      contentHash: '',
      method: 'failed',
      mediaType: 'text/plain',
      errorReason: errorToReason(err),
    };
  }

  const title = typeof result.title === 'string' && result.title.length > 0 ? result.title : normalized;
  const mediaType =
    typeof result.mediaType === 'string' && result.mediaType.length > 0 ? result.mediaType : 'text/markdown';

  return persist({
    runRoot,
    id,
    normalizedUrl: normalized,
    title,
    content: result.content,
    mediaType,
    fetchedAt,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Public API: getById / listRun.
// ──────────────────────────────────────────────────────────────────────

/**
 * Read a single cached source by id. Returns `null` when the entry
 * is missing or structurally invalid (malformed JSON, missing .md).
 * Callers who want to force-repair broken entries reach for
 * `fetchAndStore` on the underlying URL.
 */
export function getById(runRoot: string, id: string): Source | null {
  const ref = readRef(runRoot, id);
  if (!ref) return null;
  const md = contentPath(runRoot, id);
  if (!existsSync(md)) return null;
  try {
    const content = readFileSync(md, 'utf8');
    return { ref, content };
  } catch {
    return null;
  }
}

/**
 * List every valid source ref in the run's cache. Order is stable
 * (alphabetical by id) so repeated calls produce identical output
 * — convenient for diffing snapshots between runs. Malformed or
 * orphaned entries are silently skipped.
 */
export function listRun(runRoot: string): SourceRef[] {
  const dir = sourcesDir(runRoot);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const out: SourceRef[] = [];
  for (const name of entries) {
    const id = name.slice(0, -'.json'.length);
    const ref = readRef(runRoot, id);
    if (!ref) continue;
    if (!existsSync(contentPath(runRoot, id))) continue;
    out.push(ref);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Public API: searchWeb.
// ──────────────────────────────────────────────────────────────────────

export interface SearchWebOpts extends FetchAndStoreOpts {
  /** Forwarded to `mcpClient.searchWeb.limit`. */
  limit?: number;
}

/**
 * Search, then cache each hit. Returns a `SourceRef[]` in the
 * upstream search engine's ranking order (we do NOT re-rank).
 * Failed fetches appear as `method: 'failed'` refs inline with
 * successful hits — callers filter as needed.
 *
 * Fetches are issued serially (not in parallel) to keep MCP
 * pressure predictable; callers that need parallel fetch batching
 * compose `fetchAndStore` with their own concurrency primitive.
 */
export async function searchWeb(
  runRoot: string,
  query: string,
  mcpClient: McpClient,
  opts: SearchWebOpts = {},
): Promise<SourceRef[]> {
  const { limit, ...fetchOpts } = opts;
  const searchResult = await mcpClient.searchWeb({
    query,
    ...(typeof limit === 'number' ? { limit } : {}),
  });

  const refs: SourceRef[] = [];
  for (const item of searchResult.results) {
    if (typeof item.url !== 'string' || item.url.length === 0) continue;
    refs.push(await fetchAndStore(runRoot, item.url, mcpClient, fetchOpts));
  }
  return refs;
}
