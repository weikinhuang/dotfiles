/**
 * Tests for lib/node/pi/research-sources.ts.
 *
 * The suite is organized into three rings:
 *
 *   1. URL normalization - a hand-written table for pinning specific
 *      semantics (tracking-param strip, default port, fragment, case)
 *      PLUS a programmatic grid that produces 200+ coverage cases by
 *      combining hosts × casings × protocols × query-param shapes.
 *   2. Cache key stability - sha256 prefix length, canonical form
 *      across semantically-equal variants, idempotency under repeat
 *      normalization.
 *   3. Source store - round-trip through `fetchAndStore`,
 *      `getById`, `listRun`; cache-miss → fetch → cache-hit pattern;
 *      recovery from a broken cache (missing / malformed ref);
 *      search-web flow caching hits.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { paths } from '../../../../lib/node/pi/research-paths.ts';
import {
  fetchAndStore,
  getById,
  hashKey,
  listRun,
  type McpClient,
  type McpFetchUrlInput,
  type McpFetchUrlResult,
  type McpSearchWebInput,
  type McpSearchWebResult,
  normalizeUrl,
  searchWeb,
  type SourceRef,
} from '../../../../lib/node/pi/research-sources.ts';
import { sha256Hex } from '../../../../lib/node/pi/shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Tempdir fixture.
// ──────────────────────────────────────────────────────────────────────

let cwd: string;
let runRoot: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'pi-research-sources-'));
  runRoot = join(cwd, 'research', 'r-slug');
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────
// Mock MCP client.
// ──────────────────────────────────────────────────────────────────────

class MockMcpClient implements McpClient {
  readonly fetchResponses = new Map<string, McpFetchUrlResult | Error>();
  readonly searchResponses = new Map<string, McpSearchWebResult>();
  readonly fetchCalls: McpFetchUrlInput[] = [];
  readonly searchCalls: McpSearchWebInput[] = [];

  fetchUrl(input: McpFetchUrlInput): Promise<McpFetchUrlResult> {
    this.fetchCalls.push(input);
    const res = this.fetchResponses.get(input.url);
    if (res instanceof Error) return Promise.reject(res);
    if (res) return Promise.resolve(res);
    return Promise.reject(new Error(`mock fetchUrl: no response configured for ${input.url}`));
  }

  convertHtml(): Promise<{ content: string }> {
    return Promise.reject(new Error('mock convertHtml: not implemented'));
  }

  searchWeb(input: McpSearchWebInput): Promise<McpSearchWebResult> {
    this.searchCalls.push(input);
    return Promise.resolve(this.searchResponses.get(input.query) ?? { results: [] });
  }
}

function frozenClock(iso: string): () => Date {
  const d = new Date(iso);
  return () => d;
}

// ──────────────────────────────────────────────────────────────────────
// URL normalization - hand-written "pinning" cases.
// ──────────────────────────────────────────────────────────────────────

describe('normalizeUrl - canonical table', () => {
  // Each entry pins a specific rule. Expected values are exactly
  // what WHATWG URL serialization produces after our rules are
  // applied, so changes here are a deliberate contract change.
  const cases: [string, string, string][] = [
    ['lowercases scheme', 'HTTPS://example.com/', 'https://example.com/'],
    ['lowercases host', 'https://Example.COM/path', 'https://example.com/path'],
    ['preserves path case', 'https://example.com/Case/Path', 'https://example.com/Case/Path'],
    ['strips fragment', 'https://example.com/#section', 'https://example.com/'],
    ['strips fragment with query', 'https://example.com/?a=1#x', 'https://example.com/?a=1'],
    ['strips http default port', 'http://example.com:80/', 'http://example.com/'],
    ['strips https default port', 'https://example.com:443/', 'https://example.com/'],
    ['preserves http non-default port', 'http://example.com:8080/', 'http://example.com:8080/'],
    ['preserves https non-default port', 'https://example.com:8443/', 'https://example.com:8443/'],
    ['strips utm_source', 'https://example.com/?utm_source=x', 'https://example.com/'],
    ['strips utm_medium', 'https://example.com/?utm_medium=y', 'https://example.com/'],
    ['strips utm_campaign', 'https://example.com/?utm_campaign=z', 'https://example.com/'],
    ['strips utm_term', 'https://example.com/?utm_term=q', 'https://example.com/'],
    ['strips utm_content', 'https://example.com/?utm_content=w', 'https://example.com/'],
    ['strips fbclid', 'https://example.com/?fbclid=abc', 'https://example.com/'],
    ['strips gclid', 'https://example.com/?gclid=xyz', 'https://example.com/'],
    ['strips mc_cid', 'https://example.com/?mc_cid=123', 'https://example.com/'],
    ['strips mc_eid', 'https://example.com/?mc_eid=456', 'https://example.com/'],
    ['keeps unrelated params', 'https://example.com/?q=hello', 'https://example.com/?q=hello'],
    ['keeps when mixed', 'https://example.com/?q=hello&utm_source=x', 'https://example.com/?q=hello'],
    ['sorts query params', 'https://example.com/?b=2&a=1', 'https://example.com/?a=1&b=2'],
    ['empties ? when only tracking', 'https://example.com/?utm_source=x&fbclid=y', 'https://example.com/'],
    ['handles percent-encoded path', 'https://example.com/a%20b', 'https://example.com/a%20b'],
    ['case-insensitive fbclid key', 'https://example.com/?FBCLID=x', 'https://example.com/'],
    ['case-insensitive utm prefix', 'https://example.com/?UTM_Source=x', 'https://example.com/'],
    ['case-insensitive mc_ prefix', 'https://example.com/?MC_CID=x', 'https://example.com/'],
    ['trims leading whitespace', '   https://example.com/', 'https://example.com/'],
    ['trims trailing whitespace', 'https://example.com/   ', 'https://example.com/'],
    ['keeps trailing slash on path', 'https://example.com/a/', 'https://example.com/a/'],
    ['keeps no-trailing-slash path', 'https://example.com/a', 'https://example.com/a'],
    ['keeps duplicate values sorted', 'https://example.com/?a=2&a=1', 'https://example.com/?a=1&a=2'],
    ['distinct hosts stay distinct', 'https://sub.example.com/', 'https://sub.example.com/'],
    // WHATWG URL itself strips well-known default ports for known schemes
    // (ftp:21, http:80, https:443, ws:80, wss:443). We rely on that for
    // http/https; non-default ports on any scheme must survive.
    ['preserves non-default ftp port', 'ftp://example.com:2121/', 'ftp://example.com:2121/'],
    ['strips mc_tc', 'https://example.com/?mc_tc=1', 'https://example.com/'],
    ['strips mc_anything', 'https://example.com/?mc_whatever=1', 'https://example.com/'],
    ['strips bare fbclid mixed-case', 'https://example.com/?FbClId=x&q=y', 'https://example.com/?q=y'],
    ['preserves numeric paths', 'https://example.com/123/456', 'https://example.com/123/456'],
  ];

  for (const [label, input, expected] of cases) {
    test(`${label}: ${input}`, () => {
      expect(normalizeUrl(input)).toBe(expected);
    });
  }

  test('throws on invalid URL', () => {
    expect(() => normalizeUrl('not a url')).toThrow();
    expect(() => normalizeUrl('')).toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────
// URL normalization - programmatic grid (ensures ≥ 200 cases total).
// ──────────────────────────────────────────────────────────────────────

describe('normalizeUrl - combinatoric grid', () => {
  const hosts = ['example.com', 'sub.example.com', 'foo.example.org', 'a-b-c.example.net', 'site.example.co.uk'];
  const casings: ((s: string) => string)[] = [
    (s) => s,
    (s) => s.toUpperCase(),
    (s) => s.replace(/./g, (ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch)),
  ];
  const protocols: { scheme: string; port?: string }[] = [
    { scheme: 'http' },
    { scheme: 'https' },
    { scheme: 'http', port: '80' },
    { scheme: 'https', port: '443' },
  ];
  const paths_: string[] = ['/', '/a', '/a/b', '/path/to/page'];

  // Smoke every host × casing × protocol × path combination: the result
  // must round-trip back to the same normalized form regardless of
  // where we injected casing or a default port.
  for (const host of hosts) {
    for (const casing of casings) {
      for (const proto of protocols) {
        for (const path of paths_) {
          const portSuffix = proto.port ? `:${proto.port}` : '';
          const raw = `${proto.scheme}://${casing(host)}${portSuffix}${path}`;

          test(`idempotent normalize: ${raw}`, () => {
            const once = normalizeUrl(raw);

            expect(normalizeUrl(once)).toBe(once);
            // Host comes out lowercase regardless of casing chosen.
            expect(once).toContain(host.toLowerCase());
            // Default port never survives.
            expect(once).not.toMatch(/:80\//);
            expect(once).not.toMatch(/:443\//);
          });
        }
      }
    }
  }

  // Tracking-param grid: every (tracking key, value position) gets
  // stripped, and the surviving `q=` param is kept.
  const trackingKeys = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'fbclid',
    'gclid',
    'mc_cid',
    'mc_eid',
    'mc_tc',
  ];
  for (const key of trackingKeys) {
    test(`strips ${key}`, () => {
      const raw = `https://example.com/?q=keep&${key}=drop`;

      expect(normalizeUrl(raw)).toBe('https://example.com/?q=keep');
    });

    test(`strips ${key} even when alone`, () => {
      expect(normalizeUrl(`https://example.com/?${key}=drop`)).toBe('https://example.com/');
    });
  }
});

// ──────────────────────────────────────────────────────────────────────
// hashKey stability.
// ──────────────────────────────────────────────────────────────────────

describe('hashKey', () => {
  test('returns a 12-char hex prefix', () => {
    expect(hashKey('https://example.com/')).toMatch(/^[0-9a-f]{12}$/);
  });

  test('is stable across calls on the same input', () => {
    expect(hashKey('https://example.com/a')).toBe(hashKey('https://example.com/a'));
  });

  test('collapses semantically-equal URLs to the same key', () => {
    const variants = [
      'https://Example.COM/path?b=2&a=1',
      'https://example.com:443/path?a=1&b=2',
      'https://example.com/path?a=1&b=2#anchor',
      'HTTPS://EXAMPLE.COM/path?utm_source=x&a=1&b=2',
    ];
    const keys = variants.map((v) => hashKey(v));

    expect(new Set(keys).size).toBe(1);
  });

  test('distinguishes semantically-different URLs', () => {
    const k1 = hashKey('https://example.com/a');
    const k2 = hashKey('https://example.com/b');

    expect(k1).not.toBe(k2);
  });

  test('normalizes before hashing - tracking params do not change the key', () => {
    const a = hashKey('https://example.com/?utm_source=x');
    const b = hashKey('https://example.com/');

    expect(a).toBe(b);
  });
});

// ──────────────────────────────────────────────────────────────────────
// fetchAndStore - round-trip through the cache.
// ──────────────────────────────────────────────────────────────────────

describe('fetchAndStore - round-trip', () => {
  test('fetches on miss, stores markdown + ref sidecar', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/article';
    mcp.fetchResponses.set(url, {
      content: '# Article\n\nHello world.\n',
      title: 'Article',
      mediaType: 'text/markdown',
    });

    const now = frozenClock('2025-01-02T03:04:05.000Z');
    const ref = await fetchAndStore(runRoot, url, mcp, { now });

    expect(ref.method).toBe('fetch');
    expect(ref.id).toBe(hashKey(url));
    expect(ref.url).toBe(normalizeUrl(url));
    expect(ref.title).toBe('Article');
    expect(ref.fetchedAt).toBe('2025-01-02T03:04:05.000Z');
    expect(ref.mediaType).toBe('text/markdown');
    expect(ref.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const sources = paths(runRoot).sources;
    const mdPath = join(sources, `${ref.id}.md`);
    const refPath = join(sources, `${ref.id}.json`);

    expect(existsSync(mdPath)).toBe(true);
    expect(existsSync(refPath)).toBe(true);

    // Markdown file carries a provenance frontmatter identifying
    // the fetch_web bridge as the author.
    const md = readFileSync(mdPath, 'utf8');

    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('model: "mcp/fetch_web"');
    expect(md).toContain('# Article');

    // Ref JSON round-trips.
    const parsed: unknown = JSON.parse(readFileSync(refPath, 'utf8'));

    expect(parsed).toEqual(ref);
  });

  test('issues exactly one MCP fetch call on a cache miss', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/once';
    mcp.fetchResponses.set(url, { content: 'body', title: 'T' });

    await fetchAndStore(runRoot, url, mcp);

    expect(mcp.fetchCalls).toHaveLength(1);
  });

  test('falls back to a URL-derived title when fetch_web omits one', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/untitled';
    mcp.fetchResponses.set(url, { content: 'body' });

    const ref = await fetchAndStore(runRoot, url, mcp);

    expect(ref.title).toBe(normalizeUrl(url));
  });

  test('uses a default mediaType when fetch_web omits one', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/no-media-type';
    mcp.fetchResponses.set(url, { content: 'x', title: 't' });

    const ref = await fetchAndStore(runRoot, url, mcp);

    expect(ref.mediaType).toBe('text/markdown');
  });

  test('normalizes the URL before issuing the fetch call', async () => {
    const mcp = new MockMcpClient();
    const normalized = 'https://example.com/p';
    mcp.fetchResponses.set(normalized, { content: 'hi', title: 'T' });

    // Raw URL has trackers + uppercase host.
    await fetchAndStore(runRoot, 'HTTPS://Example.COM/p?utm_source=nope', mcp);

    expect(mcp.fetchCalls[0].url).toBe(normalized);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Idempotent re-fetch - second call hits cache.
// ──────────────────────────────────────────────────────────────────────

describe('fetchAndStore - idempotent re-fetch', () => {
  test('second call returns method=cached and does not re-invoke MCP', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/twice';
    mcp.fetchResponses.set(url, { content: 'body', title: 'T' });

    const first = await fetchAndStore(runRoot, url, mcp);
    const second = await fetchAndStore(runRoot, url, mcp);

    expect(first.method).toBe('fetch');
    expect(second.method).toBe('cached');
    expect(second.id).toBe(first.id);
    expect(mcp.fetchCalls).toHaveLength(1);
  });

  test('semantically-equal URL variants dedupe to one cache entry', async () => {
    const mcp = new MockMcpClient();
    const normalized = 'https://example.com/p';
    mcp.fetchResponses.set(normalized, { content: 'body', title: 'T' });

    await fetchAndStore(runRoot, 'https://Example.COM/p?utm_source=x', mcp);
    await fetchAndStore(runRoot, 'https://example.com:443/p?fbclid=y', mcp);
    await fetchAndStore(runRoot, 'HTTPS://example.com/p#frag', mcp);

    // Three calls, one underlying fetch.
    expect(mcp.fetchCalls).toHaveLength(1);
    expect(listRun(runRoot)).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Broken-cache recovery.
// ──────────────────────────────────────────────────────────────────────

describe('fetchAndStore - broken-cache recovery', () => {
  test('missing .md alongside a valid ref triggers a re-fetch', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/repair-md';
    mcp.fetchResponses.set(url, { content: 'v1', title: 'T' });

    const first = await fetchAndStore(runRoot, url, mcp);
    unlinkSync(join(paths(runRoot).sources, `${first.id}.md`));

    // Update mock so we can tell the refetch happened.
    mcp.fetchResponses.set(url, { content: 'v2', title: 'T' });

    const second = await fetchAndStore(runRoot, url, mcp);

    expect(second.method).toBe('fetch');
    expect(mcp.fetchCalls).toHaveLength(2);

    const md = readFileSync(join(paths(runRoot).sources, `${second.id}.md`), 'utf8');

    expect(md).toContain('v2');
  });

  test('malformed ref JSON triggers a re-fetch', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/bad-json';
    mcp.fetchResponses.set(url, { content: 'v1', title: 'T' });

    const first = await fetchAndStore(runRoot, url, mcp);
    writeFileSync(join(paths(runRoot).sources, `${first.id}.json`), 'not json {');

    mcp.fetchResponses.set(url, { content: 'v2', title: 'T' });

    const second = await fetchAndStore(runRoot, url, mcp);

    expect(second.method).toBe('fetch');
    expect(readFileSync(join(paths(runRoot).sources, `${second.id}.md`), 'utf8')).toContain('v2');
  });

  test('structurally-incomplete ref JSON triggers a re-fetch', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/partial';
    mcp.fetchResponses.set(url, { content: 'v1', title: 'T' });

    const first = await fetchAndStore(runRoot, url, mcp);
    writeFileSync(join(paths(runRoot).sources, `${first.id}.json`), JSON.stringify({ id: first.id }));

    mcp.fetchResponses.set(url, { content: 'v2', title: 'T' });

    const second = await fetchAndStore(runRoot, url, mcp);

    expect(second.method).toBe('fetch');
  });

  test('fetch failure returns method=failed and persists nothing', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/doomed';
    mcp.fetchResponses.set(url, new Error('network down'));

    const ref = await fetchAndStore(runRoot, url, mcp);

    expect(ref.method).toBe('failed');
    expect(ref.contentHash).toBe('');
    expect(listRun(runRoot)).toHaveLength(0);
    expect(existsSync(join(paths(runRoot).sources, `${ref.id}.json`))).toBe(false);
  });

  test('fetch failure carries errorReason extracted from the thrown Error', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/err-error';
    mcp.fetchResponses.set(url, new Error('connection reset by peer'));

    const ref = await fetchAndStore(runRoot, url, mcp);

    expect(ref.method).toBe('failed');
    expect(ref.errorReason).toBe('connection reset by peer');
  });

  test('fetch failure errorReason omitted on the success path', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/ok-no-error';
    mcp.fetchResponses.set(url, { content: 'x', title: 't' });

    const ref = await fetchAndStore(runRoot, url, mcp);

    expect(ref.method).toBe('fetch');
    expect(ref.errorReason).toBeUndefined();
  });

  test('fetch failure leaves the cache open for a retry', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/retry';
    mcp.fetchResponses.set(url, new Error('boom'));

    const first = await fetchAndStore(runRoot, url, mcp);

    expect(first.method).toBe('failed');

    // Now the upstream recovers - the retry should fetch, not cache.
    mcp.fetchResponses.set(url, { content: 'finally', title: 'ok' });
    const second = await fetchAndStore(runRoot, url, mcp);

    expect(second.method).toBe('fetch');
  });
});

// ──────────────────────────────────────────────────────────────────────
// getById / listRun.
// ──────────────────────────────────────────────────────────────────────

describe('getById / listRun', () => {
  test('getById returns ref + content for a valid cache entry', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/p';
    mcp.fetchResponses.set(url, { content: 'body', title: 'T' });

    const ref = await fetchAndStore(runRoot, url, mcp);
    const got = getById(runRoot, ref.id);

    expect(got?.ref.id).toBe(ref.id);
    expect(got?.content).toContain('body');
  });

  test('getById returns null for an unknown id', () => {
    expect(getById(runRoot, 'nope123456')).toBeNull();
  });

  test('getById returns null when the .md is missing', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/orphan';
    mcp.fetchResponses.set(url, { content: 'x', title: 'T' });

    const ref = await fetchAndStore(runRoot, url, mcp);
    unlinkSync(join(paths(runRoot).sources, `${ref.id}.md`));

    expect(getById(runRoot, ref.id)).toBeNull();
  });

  test('listRun enumerates cached refs in alphabetical id order', async () => {
    const mcp = new MockMcpClient();
    const urls = ['https://a.example.com/', 'https://b.example.com/', 'https://c.example.com/'];
    for (const u of urls) mcp.fetchResponses.set(u, { content: `body ${u}`, title: u });
    for (const u of urls) await fetchAndStore(runRoot, u, mcp);

    const listed = listRun(runRoot);

    expect(listed).toHaveLength(3);

    const ids = listed.map((r) => r.id);

    expect(ids).toEqual([...ids].sort());
  });

  test('listRun skips malformed / orphaned entries', async () => {
    const mcp = new MockMcpClient();
    const u = 'https://example.com/good';
    mcp.fetchResponses.set(u, { content: 'x', title: 't' });
    await fetchAndStore(runRoot, u, mcp);

    // Inject two bogus sidecars.
    writeFileSync(join(paths(runRoot).sources, 'aabbccddeeff.json'), 'not json');
    writeFileSync(join(paths(runRoot).sources, 'ffeeddccbbaa.json'), JSON.stringify({ id: 'ffeeddccbbaa' }));

    const listed = listRun(runRoot);

    expect(listed).toHaveLength(1);
    expect(listed[0].url).toBe(normalizeUrl(u));
  });

  test('listRun returns [] when the sources dir does not exist yet', () => {
    expect(listRun(runRoot)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// searchWeb.
// ──────────────────────────────────────────────────────────────────────

describe('searchWeb', () => {
  test('caches each hit via fetchAndStore, returns refs in ranked order', async () => {
    const mcp = new MockMcpClient();
    const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
    mcp.searchResponses.set('deep research', {
      results: urls.map((u, i) => ({ url: u, title: `hit-${i}` })),
    });
    for (const u of urls) mcp.fetchResponses.set(u, { content: `body-${u}`, title: u });

    const refs = await searchWeb(runRoot, 'deep research', mcp);

    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.url)).toEqual(urls.map(normalizeUrl));
    // Each hit hit the network exactly once.
    expect(mcp.fetchCalls).toHaveLength(3);
  });

  test('forwards the limit to the MCP search call', async () => {
    const mcp = new MockMcpClient();
    mcp.searchResponses.set('q', { results: [] });

    await searchWeb(runRoot, 'q', mcp, { limit: 5 });

    expect(mcp.searchCalls[0]).toEqual({ query: 'q', limit: 5 });
  });

  test('includes failed fetches inline as method=failed refs', async () => {
    const mcp = new MockMcpClient();
    const good = 'https://example.com/good';
    const bad = 'https://example.com/bad';
    mcp.searchResponses.set('q', { results: [{ url: good }, { url: bad }] });
    mcp.fetchResponses.set(good, { content: 'ok', title: 'T' });
    mcp.fetchResponses.set(bad, new Error('boom'));

    const refs = await searchWeb(runRoot, 'q', mcp);

    expect(refs).toHaveLength(2);
    expect(refs[0].method).toBe('fetch');
    expect(refs[1].method).toBe('failed');
  });

  test('skips search results that have no URL', async () => {
    const mcp = new MockMcpClient();
    mcp.searchResponses.set('q', {
      // @ts-expect-error - exercising defensive filtering for malformed search output.
      results: [{ url: '' }, { url: 'https://example.com/x' }, { title: 'no url' }],
    });
    mcp.fetchResponses.set('https://example.com/x', { content: 'x', title: 'x' });

    const refs = await searchWeb(runRoot, 'q', mcp);

    expect(refs).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// SourceRef shape contract.
// ──────────────────────────────────────────────────────────────────────

describe('SourceRef shape', () => {
  test('never writes a ref without every required field', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/contract';
    mcp.fetchResponses.set(url, { content: 'c', title: 't' });
    const ref: SourceRef = await fetchAndStore(runRoot, url, mcp);

    for (const key of ['id', 'url', 'title', 'fetchedAt', 'contentHash', 'method', 'mediaType'] as const) {
      expect(ref[key]).toBeDefined();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// contentHash semantics - body-only.
// ──────────────────────────────────────────────────────────────────────

describe('SourceRef.contentHash - body-only semantic', () => {
  test('equals sha256 of the raw fetched body, NOT the on-disk bytes', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/hash-body';
    const body = '# Article\n\nHello world.\n';
    mcp.fetchResponses.set(url, { content: body, title: 'T' });

    const ref = await fetchAndStore(runRoot, url, mcp);

    expect(ref.contentHash).toBe(sha256Hex(body));
  });

  test('re-fetching the same body on different runRoots produces the same hash', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/stable-hash';
    const body = 'stable body bytes\n';
    mcp.fetchResponses.set(url, { content: body, title: 'T' });

    const ref1 = await fetchAndStore(runRoot, url, mcp);

    // Distinct run root - frontmatter timestamps will differ, but the
    // content hash is body-only, so it must match.
    const otherRoot = join(cwd, 'research', 'other-run');
    mcp.fetchResponses.set(url, { content: body, title: 'T' });
    const ref2 = await fetchAndStore(otherRoot, url, mcp);

    expect(ref2.contentHash).toBe(ref1.contentHash);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Validator tightening - non-failed refs must carry a non-empty hash.
// ──────────────────────────────────────────────────────────────────────

describe('cache ref validator - contentHash strictness', () => {
  test('on-disk ref with empty contentHash on a non-failed method triggers a re-fetch', async () => {
    const mcp = new MockMcpClient();
    const url = 'https://example.com/empty-hash';
    mcp.fetchResponses.set(url, { content: 'v1', title: 'T' });

    const first = await fetchAndStore(runRoot, url, mcp);

    // Corrupt the cached ref so its hash is empty under method='fetch'.
    // The validator must reject this as malformed, triggering re-fetch.
    const refFile = join(paths(runRoot).sources, `${first.id}.json`);
    const corrupted = { ...first, contentHash: '' };
    writeFileSync(refFile, JSON.stringify(corrupted));

    mcp.fetchResponses.set(url, { content: 'v2', title: 'T' });
    const second = await fetchAndStore(runRoot, url, mcp);

    expect(second.method).toBe('fetch');
    expect(second.contentHash).toBe(sha256Hex('v2'));
    expect(second.contentHash.length).toBe(64);
  });
});
