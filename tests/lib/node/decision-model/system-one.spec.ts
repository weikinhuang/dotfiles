/**
 * Tests for lib/node/decision-model/system-one.ts.
 */

import { expect, test } from 'vitest';

import {
  callSystemOne,
  type FetchLike,
  parseSystemOneResponse,
  type SystemOneEndpoint,
  type SystemOneQuestion,
  type SystemOneRequest,
  systemOneUrl,
} from '../../../../lib/node/decision-model/system-one.ts';

const QUESTIONS: Record<string, SystemOneQuestion> = {
  flag: { type: 'noul', instructions: 'Is it?' },
  queue: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } },
  level: { type: 'score', instructions: 'How much?', criteria: ['low', 'mid', 'high'] },
};

const VALID = {
  model: 'jev-1.13.0',
  answers: {
    flag: { type: 'noul', noul: 0.2 },
    queue: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.9, b: 0.1 } },
    level: {
      type: 'score',
      score: 1.4,
      confidence: 0.6,
      legend: { '0': 'low', '1': 'mid', '2': 'high' },
      probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 },
    },
  },
  usage: { input_tokens: 420, output_tokens: 52 },
};

function withAnswer(id: string, answer: unknown): unknown {
  return { ...VALID, answers: { ...VALID.answers, [id]: answer } };
}

test('systemOneUrl: appends the spec path, trims slashes, and honors an override', () => {
  expect(systemOneUrl('https://api.example.com')).toBe('https://api.example.com/v1/systemone');
  expect(systemOneUrl('https://api.example.com//')).toBe('https://api.example.com/v1/systemone');
  expect(systemOneUrl('https://api.example.com/v1/systemone')).toBe('https://api.example.com/v1/systemone');
  expect(systemOneUrl('https://api.example.com/v1/systemone/')).toBe('https://api.example.com/v1/systemone');
  expect(systemOneUrl('https://gw.example.com/team')).toBe('https://gw.example.com/team/v1/systemone');
  expect(systemOneUrl('https://ignored', 'https://x/run/clef')).toBe('https://x/run/clef');
});

test('parseSystemOneResponse: accepts a spec-shaped response and maps usage', () => {
  const r = parseSystemOneResponse(VALID, QUESTIONS, 'jev-latest');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.response.model).toBe('jev-1.13.0');
  expect(r.response.answers.flag).toEqual({ type: 'noul', noul: 0.2 });
  expect(r.response.answers.queue).toMatchObject({ choice: 'a', probabilities: { a: 0.9, b: 0.1 } });
  expect(r.response.answers.level).toMatchObject({ score: 1.4 });
  expect(r.response.usage).toEqual({ inputTokens: 420, outputTokens: 52 });
});

test('parseSystemOneResponse: missing model falls back to the requested one; usage optional', () => {
  const r = parseSystemOneResponse({ answers: VALID.answers }, QUESTIONS, 'jev-latest');
  expect(r.ok && r.response.model).toBe('jev-latest');
  expect(r.ok && r.response.usage).toBeUndefined();
});

test.each([
  ['non-object body', 'nope'],
  ['no answers', { model: 'm' }],
  ['missing answer', withAnswer('flag', undefined)],
  ['type mismatch', withAnswer('flag', { type: 'choice', choice: 'a' })],
  ['noul out of range', withAnswer('flag', { type: 'noul', noul: 1.5 })],
  ['unknown choice', withAnswer('queue', { ...VALID.answers.queue, choice: 'c' })],
  ['choice without probabilities', withAnswer('queue', { type: 'choice', choice: 'a', confidence: 0.9 })],
  ['choice without confidence', withAnswer('queue', { ...VALID.answers.queue, confidence: undefined })],
  ['missing probability key', withAnswer('queue', { ...VALID.answers.queue, probabilities: { a: 1 } })],
  ['extra probability key', withAnswer('queue', { ...VALID.answers.queue, probabilities: { a: 0.5, b: 0.5, c: 0 } })],
  [
    'probabilities not summing to 1',
    withAnswer('queue', { ...VALID.answers.queue, probabilities: { a: 0.5, b: 0.2 } }),
  ],
  ['NaN probability', withAnswer('queue', { ...VALID.answers.queue, probabilities: { a: Number.NaN, b: 1 } })],
  ['score out of range', withAnswer('level', { ...VALID.answers.level, score: 3 })],
  ['score probabilities with wrong keys', withAnswer('level', { ...VALID.answers.level, probabilities: { a: 1 } })],
])('parseSystemOneResponse: rejects %s', (_label, body) => {
  expect(parseSystemOneResponse(body, QUESTIONS, 'm').ok).toBe(false);
});

const ENDPOINT: SystemOneEndpoint = {
  url: 'https://api.typesafe.ai/v1/systemone',
  apiKey: 'k-123',
  headers: { 'X-Team': 'dev', Authorization: 'spoofed' },
  timeoutMs: 1000,
};

const REQUEST: SystemOneRequest = { model: 'jev-latest', state: { a: 1 }, questions: QUESTIONS };

function fetchReturning(status: number, body: string, seen: { url?: string; init?: RequestInit }[] = []): FetchLike {
  return (url, init) => {
    seen.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  };
}

test('callSystemOne: posts the request with bearer auth that extra headers cannot override', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  const r = await callSystemOne(ENDPOINT, REQUEST, fetchReturning(200, JSON.stringify(VALID), seen));
  expect(r.ok).toBe(true);
  expect(seen[0].url).toBe(ENDPOINT.url);
  const headers = seen[0].init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe('Bearer k-123');
  expect(headers['X-Team']).toBe('dev');
  expect(seen[0].init?.method).toBe('POST');
  const sent = JSON.parse(seen[0].init?.body as string) as SystemOneRequest;
  expect(sent.model).toBe('jev-latest');
  expect(Object.keys(sent.questions)).toEqual(['flag', 'queue', 'level']);
});

test('callSystemOne: HTTP errors carry the status and a trimmed body', async () => {
  const r = await callSystemOne(ENDPOINT, REQUEST, fetchReturning(429, '{"detail":"slow down"}'));
  expect(r).toMatchObject({ ok: false, kind: 'http', status: 429 });
  expect(!r.ok && r.error).toContain('slow down');
});

test('callSystemOne: non-JSON and invalid bodies are "invalid"', async () => {
  expect(await callSystemOne(ENDPOINT, REQUEST, fetchReturning(200, '<html>'))).toMatchObject({
    ok: false,
    kind: 'invalid',
  });
  const bad = JSON.stringify(withAnswer('flag', { type: 'noul', noul: 7 }));
  expect(await callSystemOne(ENDPOINT, REQUEST, fetchReturning(200, bad))).toMatchObject({
    ok: false,
    kind: 'invalid',
  });
});

test('callSystemOne: network failures and timeouts never throw', async () => {
  const offline: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
  expect(await callSystemOne(ENDPOINT, REQUEST, offline)).toMatchObject({ ok: false, kind: 'network' });

  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const slow: FetchLike = () => Promise.reject(timeout);
  const r = await callSystemOne(ENDPOINT, REQUEST, slow);
  expect(r).toMatchObject({ ok: false, kind: 'timeout' });
});

test('callSystemOne: the request carries an abort signal for the timeout', async () => {
  const seen: { url?: string; init?: RequestInit }[] = [];
  await callSystemOne(ENDPOINT, REQUEST, fetchReturning(200, JSON.stringify(VALID), seen));
  expect(seen[0].init?.signal).toBeInstanceOf(AbortSignal);
});

test('callSystemOne: latency comes from the injected clock', async () => {
  let t = 100;
  const clock = (): number => {
    t += 25;
    return t;
  };
  const r = await callSystemOne(ENDPOINT, REQUEST, fetchReturning(200, JSON.stringify(VALID)), clock);
  expect(r.latencyMs).toBe(25);
});
