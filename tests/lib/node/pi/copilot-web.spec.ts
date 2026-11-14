/**
 * Tests for lib/node/pi/copilot-web.ts.
 *
 * Response fixtures mirror real Copilot `/responses` bodies captured with the
 * `web_search` tool (trimmed): `web_search_call` items with search /
 * open_page / find_in_page actions, then a `message` whose `output_text`
 * carries `url_citation` annotations.
 */

import { describe, expect, test, vi } from 'vitest';

import {
  buildFetchRequest,
  buildHeaders,
  buildSearchRequest,
  COPILOT_DEFAULT_BASE_URL,
  copilotBaseUrlFromMetadata,
  copilotBaseUrlFromToken,
  formatAnswer,
  formatFetch,
  openedUrl,
  type ParsedResponse,
  parseResponsesBody,
  stripTracking,
  postCopilotResponses,
  toSearchResults,
  validateFetchInput,
  validateSearchInput,
} from '../../../../lib/node/pi/copilot-web.ts';

function message(text: string, citations: { url: string; title?: string }[] = []): Record<string, unknown> {
  return {
    type: 'message',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
        annotations: citations.map((c) => ({ type: 'url_citation', start_index: 0, end_index: 1, ...c })),
      },
    ],
  };
}

const SEARCH_BODY = {
  status: 'completed',
  error: null,
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        query: 'opencode latest release',
        queries: ['opencode latest release', 'opencode npm version'],
        sources: [
          { type: 'url', url: 'https://github.com/anomalyco/opencode/releases' },
          { url: 'https://npm.example/oc' },
        ],
      },
    },
    { type: 'reasoning', summary: [] },
    {
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'open_page', url: 'https://github.com/anomalyco/opencode/releases' },
    },
    {
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'find_in_page', url: 'https://github.com/anomalyco/opencode/releases', pattern: '## v2.2.6' },
    },
    message('The latest released version is **v2.3.0**.', [
      { url: 'https://github.com/anomalyco/opencode/releases', title: 'Releases · anomalyco/opencode' },
    ]),
  ],
};

const parsed = (overrides: Partial<ParsedResponse> = {}): ParsedResponse => ({
  text: 'answer',
  citations: [],
  sources: [],
  actions: [],
  ...overrides,
});

describe('copilotBaseUrlFromToken', () => {
  test('maps proxy-ep proxy.* to api.*', () => {
    expect(copilotBaseUrlFromToken('tid=1;exp=2;proxy-ep=proxy.business.githubcopilot.com;sku=x')).toBe(
      'https://api.business.githubcopilot.com',
    );
  });

  test('keeps a non-proxy host as-is', () => {
    expect(copilotBaseUrlFromToken('proxy-ep=copilot-api.example.ghe.com')).toBe('https://copilot-api.example.ghe.com');
  });

  test('returns undefined for a raw GitHub token', () => {
    expect(copilotBaseUrlFromToken('gho_abc123')).toBeUndefined();
  });
});

describe('copilotBaseUrlFromMetadata', () => {
  test('prefers apiEndpoint and trims trailing slashes', () => {
    expect(copilotBaseUrlFromMetadata({ apiEndpoint: 'https://api.business.githubcopilot.com/' })).toBe(
      'https://api.business.githubcopilot.com',
    );
  });

  test('derives copilot-api.<host> from enterpriseUrl', () => {
    expect(copilotBaseUrlFromMetadata({ enterpriseUrl: 'https://acme.ghe.com/some/path' })).toBe(
      'https://copilot-api.acme.ghe.com',
    );
  });

  test('falls back to the public default', () => {
    expect(copilotBaseUrlFromMetadata(undefined)).toBe(COPILOT_DEFAULT_BASE_URL);
    expect(copilotBaseUrlFromMetadata({ apiEndpoint: '  ' })).toBe(COPILOT_DEFAULT_BASE_URL);
  });
});

describe('stripTracking', () => {
  test('removes only utm_* params and leaves other URLs untouched', () => {
    expect(stripTracking('https://a.dev/p?utm_source=openai&q=1&UTM_medium=x#h')).toBe('https://a.dev/p?q=1#h');
    expect(stripTracking('https://a.dev/p?utm_source=openai')).toBe('https://a.dev/p');
    expect(stripTracking('https://a.dev/p?q=1')).toBe('https://a.dev/p?q=1');
    expect(stripTracking('not a url')).toBe('not a url');
  });
});

describe('validateSearchInput', () => {
  test('accepts a query and normalizes allowed domains', () => {
    expect(
      validateSearchInput({ query: ' bats ', allowed_domains: ['https://docs.github.com/en', ' ', 'x.dev'] }),
    ).toEqual({
      ok: true,
      value: { query: 'bats', allowedDomains: ['docs.github.com', 'x.dev'] },
    });
  });

  test('drops an all-blank domain list', () => {
    expect(validateSearchInput({ query: 'q', allowedDomains: [''] })).toEqual({ ok: true, value: { query: 'q' } });
  });

  test('rejects missing queries and bad domain lists', () => {
    expect(validateSearchInput(null).ok).toBe(false);
    expect(validateSearchInput({ query: '  ' }).ok).toBe(false);
    expect(validateSearchInput({ query: 'q', allowed_domains: 'a.com' }).ok).toBe(false);
  });
});

describe('validateFetchInput', () => {
  test('accepts an http(s) URL and keeps the prompt', () => {
    expect(validateFetchInput({ url: 'https://example.com/a', prompt: ' list keys ' })).toEqual({
      ok: true,
      value: { url: 'https://example.com/a', prompt: 'list keys' },
    });
  });

  test('defaults the prompt', () => {
    const r = validateFetchInput({ url: 'http://example.com' });
    expect(r.ok && r.value.prompt).toMatch(/main content/);
  });

  test('rejects relative, non-http, and missing URLs', () => {
    const relative = validateFetchInput({ url: '/docs' });
    expect(!relative.ok && relative.error).toMatch(/absolute/);
    const file = validateFetchInput({ url: 'file:///etc/passwd' });
    expect(!file.ok && file.error).toMatch(/http or https/);
    expect(validateFetchInput({ prompt: 'x' }).ok).toBe(false);
    expect(validateFetchInput('https://example.com').ok).toBe(false);
  });
});

describe('request bodies', () => {
  test('answer search: web_search forced, sources included, no JSON format', () => {
    const body = buildSearchRequest('gpt-6-luna', { query: 'bats' }, 'answer');
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      input: 'Search the web for: bats',
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      store: false,
      stream: false,
    });
    expect(body.text).toBeUndefined();
  });

  test('results search adds a strict JSON schema and domain filters', () => {
    const body = buildSearchRequest('m', { query: 'q', allowedDomains: ['a.dev'] }, 'results');
    expect(body.tools).toEqual([{ type: 'web_search', filters: { allowed_domains: ['a.dev'] } }]);
    expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true, name: 'web_search_results' } });
  });

  test('fetch names the URL and task', () => {
    const body = buildFetchRequest('m', { url: 'https://x.dev/r', prompt: 'list keys' });
    expect(body.input).toBe('URL: https://x.dev/r\n\nTask: list keys');
    expect(body.tools).toEqual([{ type: 'web_search', search_context_size: 'high' }]);
    expect(body.tool_choice).toBe('required');
  });
});

describe('parseResponsesBody', () => {
  test('collects text, citations, sources, and actions', () => {
    const r = parseResponsesBody(SEARCH_BODY);
    expect(r.text).toBe('The latest released version is **v2.3.0**.');
    expect(r.citations).toEqual([
      { url: 'https://github.com/anomalyco/opencode/releases', title: 'Releases · anomalyco/opencode' },
    ]);
    expect(r.sources).toEqual(['https://github.com/anomalyco/opencode/releases', 'https://npm.example/oc']);
    expect(r.actions).toEqual([
      { type: 'search', queries: ['opencode latest release', 'opencode npm version'] },
      { type: 'open_page', url: 'https://github.com/anomalyco/opencode/releases' },
      { type: 'find_in_page', url: 'https://github.com/anomalyco/opencode/releases', pattern: '## v2.2.6' },
    ]);
  });

  test('dedupes citations, joins multiple text parts, and skips junk items', () => {
    const r = parseResponsesBody({
      output: [
        null,
        { type: 'web_search_call', action: { type: 'search', query: 'only-query' } },
        { type: 'web_search_call', action: { type: 'open_page' } },
        message('one', [{ url: 'https://a.dev' }, { url: 'https://a.dev', title: 'dup' }]),
        message('two', [{ url: 'https://b.dev', title: 'B' }]),
      ],
    });
    expect(r.text).toBe('one\n\ntwo');
    expect(r.citations).toEqual([{ url: 'https://a.dev' }, { url: 'https://b.dev', title: 'B' }]);
    expect(r.actions).toEqual([{ type: 'search', queries: ['only-query'] }]);
  });

  test('strips utm_* params so tagged citations dedupe against sources', () => {
    const r = parseResponsesBody({
      output: [
        { type: 'web_search_call', action: { type: 'search', sources: [{ url: 'https://a.dev/r' }] } },
        message('x', [{ url: 'https://a.dev/r?utm_source=openai', title: 'A' }]),
      ],
    });
    expect(r.citations).toEqual([{ url: 'https://a.dev/r', title: 'A' }]);
    expect(formatAnswer(r)).toBe('x\n\nSources:\n- [A](https://a.dev/r)');
  });

  test('throws on error bodies and empty incomplete responses', () => {
    expect(() => parseResponsesBody({ error: { message: 'model not supported' } })).toThrow(/model not supported/);
    expect(() =>
      parseResponsesBody({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }),
    ).toThrow(/incomplete \(max_output_tokens\)/);
    expect(() => parseResponsesBody('nope')).toThrow(/non-object/);
  });

  test('keeps partial text from an incomplete response', () => {
    expect(parseResponsesBody({ status: 'incomplete', output: [message('partial')] }).text).toBe('partial');
  });
});

describe('formatting', () => {
  test('formatAnswer lists citations then uncited sources, deduped and capped', () => {
    const out = formatAnswer(
      parsed({
        citations: [{ url: 'https://a.dev', title: 'A' }, { url: 'https://b.dev' }],
        sources: ['https://a.dev', 'https://c.dev', 'https://d.dev'],
      }),
      3,
    );
    expect(out).toBe('answer\n\nSources:\n- [A](https://a.dev)\n- https://b.dev\n- https://c.dev');
  });

  test('formatAnswer handles no text and no sources', () => {
    expect(formatAnswer(parsed({ text: '' }))).toBe('(Copilot returned no answer text.)');
  });

  test('openedUrl matches open_page / find_in_page ignoring hash and trailing slash', () => {
    const r = parsed({ actions: [{ type: 'open_page', url: 'https://x.dev/docs/' }] });
    expect(openedUrl(r, 'https://x.dev/docs#install')).toBe(true);
    expect(openedUrl(r, 'https://x.dev/other')).toBe(false);
    expect(
      openedUrl(parsed({ actions: [{ type: 'search', queries: ['https://x.dev/docs'] }] }), 'https://x.dev/docs'),
    ).toBe(false);
  });

  test('formatFetch adds a note only when the URL was not opened', () => {
    const opened = parsed({ actions: [{ type: 'find_in_page', url: 'https://x.dev' }] });
    expect(formatFetch(opened, 'https://x.dev')).toBe('answer');
    expect(formatFetch(parsed(), 'https://x.dev')).toMatch(/did not report opening https:\/\/x\.dev/);
  });
});

describe('toSearchResults', () => {
  test('parses JSON results, dropping invalid and duplicate URLs', () => {
    const text = JSON.stringify({
      results: [
        { url: 'https://a.dev', title: 'A', content: 'about a', published: '2026-07-21' },
        { url: 'https://a.dev', title: 'dup', content: 'x', published: null },
        { url: 'ftp://b.dev', title: 'B', content: 'x', published: null },
        { url: 'https://c.dev', title: ' ', content: '', published: 'not a date' },
        'junk',
      ],
    });
    expect(toSearchResults(parsed({ text }))).toEqual([
      { url: 'https://a.dev', title: 'A', content: 'about a', time: { published: Date.parse('2026-07-21') } },
      { url: 'https://c.dev', time: {} },
    ]);
  });

  test('tolerates prose around the JSON object', () => {
    const text = 'Here you go:\n{"results":[{"url":"https://a.dev","title":"A","content":"c","published":null}]}\n';
    expect(toSearchResults(parsed({ text }))).toHaveLength(1);
  });

  test('falls back to citations, then sources, when the text is not JSON', () => {
    const r = toSearchResults(
      parsed({
        text: 'plain answer',
        citations: [{ url: 'https://a.dev', title: 'A' }],
        sources: ['https://a.dev', 'https://b.dev', 'not a url'],
      }),
    );
    expect(r).toEqual([
      { url: 'https://a.dev', title: 'A', content: 'plain answer', time: {} },
      { url: 'https://b.dev', time: {} },
    ]);
  });

  test('a JSON object without results also falls back', () => {
    expect(toSearchResults(parsed({ text: '{"answer":1}', sources: ['https://a.dev'] }))).toEqual([
      { url: 'https://a.dev', content: '{"answer":1}', time: {} },
    ]);
  });
});

describe('buildHeaders', () => {
  test('layers Copilot defaults, caller overrides (null deletes), then auth', () => {
    const h = buildHeaders({
      baseUrl: 'https://api.x',
      token: 'tok',
      headers: { 'User-Agent': 'custom', 'Openai-Intent': null, 'X-Extra': '1', 'X-Skip': undefined },
    });
    expect(h['User-Agent']).toBe('custom');
    expect(h['Openai-Intent']).toBeUndefined();
    expect(h['X-Extra']).toBe('1');
    expect('X-Skip' in h).toBe(false);
    expect(h['Copilot-Integration-Id']).toBe('vscode-chat');
    expect(h['X-Initiator']).toBe('agent');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['Content-Type']).toBe('application/json');
  });
});

describe('postCopilotResponses', () => {
  const endpoint = { baseUrl: 'https://api.x/', token: 'tok' };

  test('POSTs JSON to <base>/responses and returns the parsed body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"output":[]}', { status: 200 }));
    await expect(postCopilotResponses(endpoint, { model: 'm' }, { fetchImpl })).resolves.toEqual({ output: [] });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://api.x/responses');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"model":"m"}');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('turns HTTP errors into a message with an auth hint for 401/403', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"bad token"}', { status: 401 }));
    await expect(postCopilotResponses(endpoint, {}, { fetchImpl })).rejects.toThrow(/HTTP 401 \(sign in .*bad token/);
    fetchImpl.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(postCopilotResponses(endpoint, {}, { fetchImpl })).rejects.toThrow(
      /^Copilot \/responses returned HTTP 500: boom$/,
    );
  });

  test('rejects non-JSON success bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(postCopilotResponses(endpoint, {}, { fetchImpl })).rejects.toThrow(/non-JSON/);
  });

  test('propagates a caller abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    controller.abort();
    await expect(postCopilotResponses(endpoint, {}, { fetchImpl, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
  });
});
