/**
 * Tests for lib/node/pi/native-web.ts.
 *
 * Responses SSE fixtures mirror Copilot `/responses` streams (trimmed to the
 * final `response.completed` event). Anthropic fixtures follow the Messages
 * streaming shape for server tools (`server_tool_use`,
 * `web_search_tool_result`, `citations_delta`).
 */

import { describe, expect, test, vi } from 'vitest';

import {
  applyWebGate,
  createCapturingFetch,
  injectWebTool,
  parseModelOverrides,
  parseNativeWebRaw,
  parseSkillList,
  parseSseData,
  resolveWebModel,
  type WebCall,
  webCallHeaders,
  webCallPrompt,
} from '../../../../lib/node/pi/native-web.ts';

const sse = (events: readonly Record<string, unknown>[]): string =>
  events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const search: WebCall = { kind: 'search', input: { query: 'bats' } };
const fetchCall: WebCall = { kind: 'fetch', input: { url: 'https://x.dev/r', prompt: 'keys' } };

describe('resolveWebModel', () => {
  const models = [
    { provider: 'github-copilot', id: 'claude-haiku-5.5', api: 'anthropic-messages', cost: { input: 0.1 } },
    { provider: 'github-copilot', id: 'gpt-6.1-terra', api: 'openai-responses', cost: { input: 1 } },
    { provider: 'github-copilot', id: 'gpt-6-luna', api: 'openai-responses', cost: { input: 0.1 } },
    { provider: 'openai-codex', id: 'gpt-6-sol', api: 'openai-codex-responses', cost: { input: 2 } },
    { provider: 'openai-codex', id: 'gpt-5.6-luna', api: 'openai-codex-responses', cost: { input: 0.2 } },
    { provider: 'anthropic', id: 'claude-opus-5-5', api: 'anthropic-messages', cost: { input: 4 } },
    { provider: 'amazon-bedrock', id: 'claude', api: 'bedrock-converse-stream', cost: { input: 0.1 } },
  ];

  test('Claude on Copilot borrows the Copilot GPT Responses model', () => {
    expect(resolveWebModel(models, 'github-copilot')).toEqual({ model: models[2], family: 'openai-responses' });
  });

  test('falls back to the cheapest eligible model when the preferred one is missing', () => {
    expect(resolveWebModel(models, 'openai-codex')?.model.id).toBe('gpt-5.6-luna');
    expect(resolveWebModel(models, 'anthropic')).toEqual({ model: models[5], family: 'anthropic-messages' });
  });

  test('overrides pick a specific model per provider', () => {
    const overrides = new Map([['github-copilot', 'gpt-6.1-terra']]);
    expect(resolveWebModel(models, 'github-copilot', overrides)?.model.id).toBe('gpt-6.1-terra');
  });

  test('providers without a native tool, or with no eligible model, are unsupported', () => {
    expect(resolveWebModel(models, 'amazon-bedrock')).toBeUndefined();
    expect(resolveWebModel(models, 'llama-cpp')).toBeUndefined();
    expect(resolveWebModel(models, undefined)).toBeUndefined();
    expect(resolveWebModel(models.slice(0, 1), 'github-copilot')).toBeUndefined();
    expect(resolveWebModel([], 'openai')).toBeUndefined();
  });
});

describe('parseModelOverrides', () => {
  test('parses provider/id pairs and skips malformed entries', () => {
    expect([...parseModelOverrides(' github-copilot/gpt-6.1-terra , bad, /x, y/ ,openai-codex/gpt-6-luna')]).toEqual([
      ['github-copilot', 'gpt-6.1-terra'],
      ['openai-codex', 'gpt-6-luna'],
    ]);
    expect(parseModelOverrides(undefined).size).toBe(0);
  });
});

describe('webCallPrompt / webCallHeaders', () => {
  test('search and fetch prompts', () => {
    expect(webCallPrompt(search).userText).toBe('Search the web for: bats');
    expect(webCallPrompt(fetchCall).userText).toBe('URL: https://x.dev/r\n\nTask: keys');
    expect(webCallPrompt(fetchCall).systemPrompt).toMatch(/Open exactly the URL/);
  });

  test('only Anthropic fetch needs the beta header', () => {
    expect(webCallHeaders('anthropic-messages', fetchCall)).toEqual({ 'anthropic-beta': 'web-fetch-2025-09-10' });
    expect(webCallHeaders('anthropic-messages', search)).toBeUndefined();
    expect(webCallHeaders('openai-responses', fetchCall)).toBeUndefined();
  });
});

describe('injectWebTool', () => {
  test('Responses: appends web_search, forces it, and adds the sources include once', () => {
    const payload = { model: 'm', tools: [{ type: 'function', name: 'x' }], include: ['reasoning.encrypted_content'] };
    const next = injectWebTool('openai-responses', payload, search);
    expect(next).toMatchObject({
      tools: [{ type: 'function', name: 'x' }, { type: 'web_search' }],
      tool_choice: 'required',
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
    });
    expect(payload.tools).toHaveLength(1);
    const again = injectWebTool('openai-responses', { include: ['web_search_call.action.sources'] }, search);
    expect(again).toMatchObject({ include: ['web_search_call.action.sources'] });
  });

  test('Responses: domain filters for search, high context for fetch', () => {
    const filtered = injectWebTool(
      'openai-responses',
      {},
      { kind: 'search', input: { query: 'q', allowedDomains: ['a.dev'] } },
    );
    expect(filtered).toMatchObject({ tools: [{ type: 'web_search', filters: { allowed_domains: ['a.dev'] } }] });
    expect(injectWebTool('openai-responses', {}, fetchCall)).toMatchObject({
      tools: [{ type: 'web_search', search_context_size: 'high' }],
    });
  });

  test('Anthropic: server tools, no tool_choice', () => {
    const s = injectWebTool(
      'anthropic-messages',
      {},
      { kind: 'search', input: { query: 'q', allowedDomains: ['a.dev'] } },
    );
    expect(s).toEqual({
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5, allowed_domains: ['a.dev'] }],
    });
    expect(injectWebTool('anthropic-messages', {}, fetchCall)).toEqual({
      tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5, citations: { enabled: true } }],
    });
  });

  test('non-object payloads pass through', () => {
    expect(injectWebTool('openai-responses', 'raw', search)).toBe('raw');
  });
});

describe('parseSseData', () => {
  test('decodes data frames, joins multi-line data, skips [DONE] and junk', () => {
    const raw = 'event: a\ndata: {"x":1}\n\ndata: {"y":\ndata: 2}\n\n: keepalive\n\ndata: [DONE]\n\ndata: nope\n\n';
    expect(parseSseData(raw)).toEqual([{ x: 1 }, { y: 2 }]);
  });
});

describe('parseNativeWebRaw: openai-responses', () => {
  const final = {
    status: 'completed',
    output: [
      { type: 'web_search_call', action: { type: 'open_page', url: 'https://x.dev/r' } },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Answer.',
            annotations: [{ type: 'url_citation', url: 'https://x.dev/r?utm_source=openai', title: 'X' }],
          },
        ],
      },
    ],
  };

  test('reads the final response.completed event from an SSE stream', () => {
    const raw = sse([
      { type: 'response.created', response: { status: 'in_progress', output: [] } },
      { type: 'response.output_text.delta', delta: 'Ans' },
      { type: 'response.completed', response: final },
    ]);
    const parsed = parseNativeWebRaw('openai-responses', raw);
    expect(parsed.text).toBe('Answer.');
    expect(parsed.citations).toEqual([{ url: 'https://x.dev/r', title: 'X' }]);
    expect(parsed.actions).toEqual([{ type: 'open_page', url: 'https://x.dev/r' }]);
  });

  test('accepts a plain JSON body and surfaces errors', () => {
    expect(parseNativeWebRaw('openai-responses', JSON.stringify(final)).text).toBe('Answer.');
    expect(() =>
      parseNativeWebRaw('openai-responses', JSON.stringify({ error: { message: 'not supported' } })),
    ).toThrow(/not supported/);
    expect(() => parseNativeWebRaw('openai-responses', sse([{ type: 'error', error: { message: 'quota' } }]))).toThrow(
      /quota/,
    );
    expect(() => parseNativeWebRaw('openai-responses', sse([{ type: 'response.created', response: {} }]))).toThrow(
      /without a final response/,
    );
  });
});

describe('parseNativeWebRaw: anthropic-messages', () => {
  test('rebuilds text, citations, sources, and actions from the stream', () => {
    const raw = sse([
      { type: 'message_start', message: { id: 'm', content: [] } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"bats' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' release"}' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 's1',
          content: [
            { type: 'web_search_result', url: 'https://a.dev/r', title: 'A' },
            { type: 'web_search_result', url: 'https://b.dev?utm_source=x', title: 'B' },
          ],
        },
      },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Latest is ' } },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: { type: 'web_search_result_location', url: 'https://a.dev/r', title: 'A' },
        },
      },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'v1.14.0.' } },
      { type: 'message_stop' },
    ]);
    expect(parseNativeWebRaw('anthropic-messages', raw)).toEqual({
      text: 'Latest is v1.14.0.',
      citations: [{ url: 'https://a.dev/r', title: 'A' }],
      sources: ['https://a.dev/r', 'https://b.dev/'],
      actions: [{ type: 'search', queries: ['bats release'] }],
    });
  });

  test('parses a non-streaming body with web_fetch', () => {
    const body = {
      content: [
        { type: 'server_tool_use', name: 'web_fetch', input: { url: 'https://x.dev/r' } },
        { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://x.dev/r' } },
        { type: 'text', text: 'Keys: a, b', citations: [{ url: 'https://x.dev/r', title: 'X' }] },
      ],
    };
    expect(parseNativeWebRaw('anthropic-messages', JSON.stringify(body))).toEqual({
      text: 'Keys: a, b',
      citations: [{ url: 'https://x.dev/r', title: 'X' }],
      sources: ['https://x.dev/r'],
      actions: [{ type: 'open_page', url: 'https://x.dev/r' }],
    });
  });

  test('surfaces API errors', () => {
    expect(() =>
      parseNativeWebRaw('anthropic-messages', JSON.stringify({ type: 'error', error: { message: 'nope' } })),
    ).toThrow(/nope/);
    expect(() =>
      parseNativeWebRaw('anthropic-messages', sse([{ type: 'error', error: { type: 'overloaded_error' } }])),
    ).toThrow(/overloaded/);
    expect(() => parseNativeWebRaw('anthropic-messages', 'not json')).toThrow(/non-object/);
  });
});

describe('createCapturingFetch', () => {
  test('returns the response untouched and copies its body', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"a":1}\n\n', { status: 200 }));
    const capture = createCapturingFetch(base);
    expect(await capture.body()).toBeUndefined();
    const response = await capture.fetch('https://x.dev', { method: 'POST' });
    expect(await response.text()).toBe('data: {"a":1}\n\n');
    expect(await capture.body()).toBe('data: {"a":1}\n\n');
    expect(base).toHaveBeenCalledWith('https://x.dev', { method: 'POST' });
  });
});

describe('applyWebGate', () => {
  const skills = [{ name: 'ai-fetch-web' }, { name: 'markdown' }];
  const tools = ['read', 'bash', 'web_search', 'web_fetch'];

  test('supported provider: tools stay, ai-fetch-web is hidden', () => {
    const r = applyWebGate({ supported: true, selectedTools: tools, skills, hiddenByGate: [] });
    expect(r).toEqual({ selectedTools: tools, skills: [{ name: 'markdown' }], hiddenByGate: [] });
  });

  test('unsupported provider: tools are removed and remembered, skills untouched', () => {
    const r = applyWebGate({ supported: false, selectedTools: tools, skills, hiddenByGate: [] });
    expect(r).toEqual({ selectedTools: ['read', 'bash'], skills, hiddenByGate: ['web_search', 'web_fetch'] });
  });

  test('switching back restores only the tools the gate hid', () => {
    const off = applyWebGate({ supported: false, selectedTools: tools, skills, hiddenByGate: [] });
    const again = applyWebGate({
      supported: false,
      selectedTools: off.selectedTools,
      skills,
      hiddenByGate: off.hiddenByGate,
    });
    expect(again.hiddenByGate).toEqual(off.hiddenByGate);
    const back = applyWebGate({
      supported: true,
      selectedTools: again.selectedTools,
      skills,
      hiddenByGate: again.hiddenByGate,
    });
    expect(back.selectedTools).toEqual(tools);
    expect(back.hiddenByGate).toEqual([]);
  });

  test('does not add tools a persona / preset allowlist never selected', () => {
    expect(applyWebGate({ supported: true, selectedTools: ['read'], skills, hiddenByGate: [] }).selectedTools).toEqual([
      'read',
    ]);
  });

  test('ignores foreign names in hiddenByGate and honors custom hidden skills', () => {
    const r = applyWebGate({
      supported: true,
      selectedTools: ['read'],
      skills,
      hiddenByGate: ['bash', 'web_fetch'],
      hiddenSkills: [],
    });
    expect(r.selectedTools).toEqual(['read', 'web_fetch']);
    expect(r.skills).toEqual(skills);
  });
});

describe('parseSkillList', () => {
  test('undefined keeps the default, blank hides none, lists are trimmed', () => {
    expect(parseSkillList(undefined)).toEqual(['ai-fetch-web']);
    expect(parseSkillList('')).toEqual([]);
    expect(parseSkillList(' a , ,b ')).toEqual(['a', 'b']);
  });
});
