/**
 * Minimal client for the System One decision API: `POST /v1/systemone`
 * with a bearer key, typed questions in, typed answers out. The shapes
 * follow TypeSafe's published OpenAPI spec (`api.typesafe.ai/openapi.json`),
 * which other System One endpoints (Cloudflare Clef, self-hosted
 * deployments) implement too.
 *
 * Only the `noul` / `choice` / `score` question types are modelled; `box`
 * (image regions) has no use in a coding agent yet.
 *
 * Responses are validated strictly against the questions that were asked:
 * a missing answer, a type mismatch, an unknown choice, or probabilities
 * that are out of range or do not sum to ~1 all reject the response. The
 * callers treat any rejection as "no decision", so a backend that does
 * not fully implement the spec can never cause an auto-approval.
 *
 * Pure module apart from the injected `fetch`; no harness imports.
 */

/** Yes/no question: the answer is the probability of "yes". */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

/** Pick one option: `criteria` maps option names to descriptions. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** Ordered scale: `criteria[i]` describes level `i` (scores start at 0). */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface SystemOneRequest {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, SystemOneQuestion>;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  /** Resolved model; may differ from a requested alias. */
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { inputTokens: number; outputTokens: number };
}

/** Where and how to reach one System One endpoint. */
export interface SystemOneEndpoint {
  /** Full request URL (already including `/v1/systemone` or a custom path). */
  url: string;
  apiKey: string;
  /** Extra request headers; cannot replace `Authorization` or `Content-Type`. */
  headers?: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type SystemOneErrorKind = 'timeout' | 'network' | 'http' | 'invalid';

export type SystemOneCallResult =
  | { ok: true; response: SystemOneResponse; latencyMs: number }
  | { ok: false; kind: SystemOneErrorKind; error: string; status?: number; latencyMs: number };

/** Probabilities may drift from 1 by rounding; anything further is a malformed answer. */
const PROBABILITY_SUM_TOLERANCE = 0.02;

/** Longest HTTP error body kept in an error message. */
const ERROR_BODY_CHARS = 300;

const SYSTEM_ONE_PATH = '/v1/systemone';

/**
 * `https://host/` -> `https://host/v1/systemone`; a base URL that already
 * ends in `/v1/systemone` is used as is. An explicit `endpoint` wins verbatim.
 */
export function systemOneUrl(baseUrl: string, endpoint?: string): string {
  if (endpoint) return endpoint;
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith(SYSTEM_ONE_PATH) ? base : `${base}${SYSTEM_ONE_PATH}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Validate a probability map whose keys must be exactly `keys`. Returns
 * the map or an error string.
 */
function parseProbabilities(raw: unknown, keys: readonly string[]): Record<string, number> | string {
  if (!isRecord(raw)) return 'probabilities missing';
  const extra = Object.keys(raw).filter((k) => !keys.includes(k));
  if (extra.length > 0) return `unexpected probability keys: ${extra.join(', ')}`;
  const out: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const p = raw[key];
    if (!isUnit(p)) return `probability for "${key}" missing or out of range`;
    out[key] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return `probabilities sum to ${sum.toFixed(3)}`;
  return out;
}

function parseAnswer(id: string, question: SystemOneQuestion, raw: unknown): SystemOneAnswer | string {
  if (!isRecord(raw)) return `answer "${id}" missing`;
  if (raw.type !== question.type) return `answer "${id}" has type ${String(raw.type)}, expected ${question.type}`;
  if (question.type === 'noul') {
    return isUnit(raw.noul) ? { type: 'noul', noul: raw.noul } : `answer "${id}" noul out of range`;
  }
  if (!isUnit(raw.confidence)) return `answer "${id}" confidence missing or out of range`;
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    if (typeof raw.choice !== 'string' || !keys.includes(raw.choice)) return `answer "${id}" chose an unknown option`;
    const probabilities = parseProbabilities(raw.probabilities, keys);
    if (typeof probabilities === 'string') return `answer "${id}": ${probabilities}`;
    return { type: 'choice', choice: raw.choice, confidence: raw.confidence, probabilities };
  }
  const levels = question.criteria.length;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > levels - 1) {
    return `answer "${id}" score out of range`;
  }
  const probabilities = parseProbabilities(
    raw.probabilities,
    question.criteria.map((_, i) => String(i)),
  );
  if (typeof probabilities === 'string') return `answer "${id}": ${probabilities}`;
  return { type: 'score', score: raw.score, confidence: raw.confidence, probabilities };
}

/**
 * Validate a decoded response body against the questions that were asked.
 * `requestedModel` fills in a missing `model` field.
 */
export function parseSystemOneResponse(
  raw: unknown,
  questions: Readonly<Record<string, SystemOneQuestion>>,
  requestedModel: string,
): { ok: true; response: SystemOneResponse } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'response is not an object' };
  if (!isRecord(raw.answers)) return { ok: false, error: 'response has no answers' };
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const parsed = parseAnswer(id, question, raw.answers[id]);
    if (typeof parsed === 'string') return { ok: false, error: parsed };
    answers[id] = parsed;
  }
  const response: SystemOneResponse = {
    model: typeof raw.model === 'string' && raw.model ? raw.model : requestedModel,
    answers,
  };
  const usage = raw.usage;
  if (isRecord(usage) && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
    response.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  }
  return { ok: true, response };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Send one request. Never throws: every failure (timeout, network, non-2xx,
 * undecodable or invalid body) comes back as `{ ok: false }`. There are no
 * retries; a decision that cannot be made inside the timeout is simply not
 * made, and the caller falls back to its normal behavior.
 */
export async function callSystemOne(
  endpoint: SystemOneEndpoint,
  request: SystemOneRequest,
  fetchImpl: FetchLike = fetch,
  clock: () => number = () => performance.now(),
): Promise<SystemOneCallResult> {
  const started = clock();
  const elapsed = (): number => Math.round(clock() - started);
  let res: Response;
  try {
    res = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, kind: 'timeout', error: `no response within ${endpoint.timeoutMs}ms`, latencyMs: elapsed() };
    }
    return { ok: false, kind: 'network', error: errorText(err), latencyMs: elapsed() };
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const kind = isAbortError(err) ? 'timeout' : 'network';
    return { ok: false, kind, error: errorText(err), status: res.status, latencyMs: elapsed() };
  }
  if (!res.ok) {
    const body = text.trim().slice(0, ERROR_BODY_CHARS);
    return {
      ok: false,
      kind: 'http',
      error: `HTTP ${res.status}${body ? `: ${body}` : ''}`,
      status: res.status,
      latencyMs: elapsed(),
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'invalid', error: 'response is not JSON', status: res.status, latencyMs: elapsed() };
  }
  const parsed = parseSystemOneResponse(decoded, request.questions, request.model);
  if (!parsed.ok) return { ok: false, kind: 'invalid', error: parsed.error, status: res.status, latencyMs: elapsed() };
  return { ok: true, response: parsed.response, latencyMs: elapsed() };
}
