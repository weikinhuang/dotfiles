/**
 * Web search and web fetch routed through GitHub Copilot's model-native
 * `web_search` tool, shared by the pi `copilot-web` extension and the
 * opencode `copilot-web` plugin.
 *
 * Copilot exposes the OpenAI Responses API at `<base>/responses`; sending
 * `tools: [{type: "web_search"}]` lets the model search, open pages
 * (`open_page`), and search inside them (`find_in_page`) server-side. There is
 * no separate search or fetch endpoint: a "fetch" is a Responses call that
 * asks the model to open one URL and answer a prompt from it.
 *
 * Pure module: no harness imports. `postCopilotResponses` takes an injectable
 * `fetch` so specs never hit the network.
 */

import { isRecord, truncate } from './shared.ts';

/** Cheap Copilot Responses model that supports `web_search` (verified 2026-11). */
export const DEFAULT_COPILOT_WEB_MODEL = 'gpt-6-luna';

/** Base URL used when neither the token nor the credential names one. */
export const COPILOT_DEFAULT_BASE_URL = 'https://api.githubcopilot.com';

/**
 * Headers Copilot's own clients send. The search runs as a tool call inside an
 * agent turn, so `X-Initiator` is `agent`.
 */
export const COPILOT_WEB_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-edits',
  'X-Initiator': 'agent',
};

export const DEFAULT_TIMEOUT_MS = 120_000;

const ERROR_BODY_LIMIT = 500;

// ──────────────────────────────────────────────────────────────────────
// Endpoint resolution
// ──────────────────────────────────────────────────────────────────────

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Copilot session tokens (`tid=...;proxy-ep=proxy.business.githubcopilot.com;...`)
 * name their API host: `proxy.` becomes `api.`. Returns `undefined` for tokens
 * without a `proxy-ep` field (for example a raw `gho_` GitHub token).
 */
export function copilotBaseUrlFromToken(token: string): string | undefined {
  const match = /(?:^|;)proxy-ep=([^;]+)/.exec(token);
  if (!match?.[1]) return undefined;
  return `https://${match[1].trim().replace(/^proxy\./, 'api.')}`;
}

/**
 * Base URL from opencode's stored Copilot OAuth metadata: `apiEndpoint`, else
 * `copilot-api.<enterpriseUrl host>`, else the public default.
 */
export function copilotBaseUrlFromMetadata(metadata: Readonly<Record<string, unknown>> | undefined): string {
  const endpoint = metadata?.apiEndpoint;
  if (typeof endpoint === 'string' && endpoint.trim()) return trimSlashes(endpoint.trim());
  const enterprise = metadata?.enterpriseUrl;
  if (typeof enterprise === 'string' && enterprise.trim()) {
    const host = enterprise
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (host) return `https://copilot-api.${host}`;
  }
  return COPILOT_DEFAULT_BASE_URL;
}

// ──────────────────────────────────────────────────────────────────────
// Input validation
// ──────────────────────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SearchInput {
  readonly query: string;
  readonly allowedDomains?: readonly string[];
}

export interface FetchInput {
  readonly url: string;
  readonly prompt: string;
}

function nonEmpty(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Drop `utm_*` tracking params (Copilot tags citations with
 * `utm_source=openai`) so the same page dedupes across citations and sources.
 */
export function stripTracking(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const tracked = [...url.searchParams.keys()].filter((k) => k.toLowerCase().startsWith('utm_'));
  if (tracked.length === 0) return raw;
  for (const key of tracked) url.searchParams.delete(key);
  return url.href;
}

function urlField(raw: unknown): string | undefined {
  const url = nonEmpty(raw);
  return url ? stripTracking(url) : undefined;
}

/** Validate tool input for a search call (`query`, optional `allowed_domains`). */
export function validateSearchInput(raw: unknown): Validated<SearchInput> {
  if (!isRecord(raw)) return { ok: false, error: 'expected an object with a `query` string' };
  const query = nonEmpty(raw.query);
  if (!query) return { ok: false, error: '`query` must be a non-empty string' };
  const domainsRaw = raw.allowed_domains ?? raw.allowedDomains;
  if (domainsRaw === undefined) return { ok: true, value: { query } };
  if (!Array.isArray(domainsRaw) || !domainsRaw.every((d) => typeof d === 'string')) {
    return { ok: false, error: '`allowed_domains` must be an array of strings' };
  }
  const allowedDomains = domainsRaw
    .map((d) =>
      d
        .trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, ''),
    )
    .filter((d) => d.length > 0);
  return { ok: true, value: allowedDomains.length > 0 ? { query, allowedDomains } : { query } };
}

/** Validate tool input for a fetch call: an absolute http(s) `url` and a `prompt`. */
export function validateFetchInput(raw: unknown): Validated<FetchInput> {
  if (!isRecord(raw)) return { ok: false, error: 'expected an object with `url` and `prompt` strings' };
  const urlText = nonEmpty(raw.url);
  if (!urlText) return { ok: false, error: '`url` must be a non-empty string' };
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return { ok: false, error: `\`url\` is not an absolute URL: ${urlText}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `\`url\` must use http or https, got ${url.protocol}` };
  }
  const prompt = nonEmpty(raw.prompt) ?? 'Return the main content of the page as faithfully as you can.';
  return { ok: true, value: { url: url.href, prompt } };
}

// ──────────────────────────────────────────────────────────────────────
// Request bodies
// ──────────────────────────────────────────────────────────────────────

export const ANSWER_INSTRUCTIONS =
  'You are the web search backend for a coding agent. Use your web search tool to research the query, then answer concisely and factually. Include specific facts, version numbers, dates, API names, commands, and short quotes where useful. Cite every claim with the page it came from. Never invent URLs.';

const RESULTS_INSTRUCTIONS = `You are the web search backend for a coding agent. Use your web search tool to research the query, then report what you found as JSON matching the schema.

For each result:
- "url": the exact URL of a page your web search returned. Never invent or guess URLs.
- "title": the page title.
- "content": a self-contained, detailed summary of everything on the page relevant to the query, with specific facts, figures, dates, version numbers, API names, code, commands, and short direct quotes. The agent reads only this text, not the page.
- "published": the page's publication or last-updated date in ISO 8601 when the page states it, else null.

List results from most to least relevant, never repeat a URL, and return {"results":[]} when nothing relevant was found.`;

export const FETCH_INSTRUCTIONS =
  'You are the web fetch backend for a coding agent. Open exactly the URL you are given with your web search tool (open_page; use find_in_page for long pages) and answer the task using only that page. Quote code, commands, and identifiers verbatim. If the page cannot be opened, or does not contain the answer, say so plainly instead of guessing or answering from other sources.';

const RESULTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title', 'content', 'published'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          published: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

export type SearchShape = 'answer' | 'results';

/** User-turn text for a search call. */
export function searchInputText(input: SearchInput): string {
  return `Search the web for: ${input.query}`;
}

/** User-turn text for a fetch call. */
export function fetchInputText(input: FetchInput): string {
  return `URL: ${input.url}\n\nTask: ${input.prompt}`;
}

function webSearchTool(allowedDomains?: readonly string[]): Record<string, unknown> {
  return allowedDomains?.length
    ? { type: 'web_search', filters: { allowed_domains: [...allowedDomains] } }
    : { type: 'web_search' };
}

/**
 * Responses body for a search. `answer` returns a cited prose answer (pi);
 * `results` returns strict JSON `{results:[{url,title,content,published}]}`
 * (opencode's native websearch shape).
 */
export function buildSearchRequest(model: string, input: SearchInput, shape: SearchShape): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    instructions: shape === 'results' ? RESULTS_INSTRUCTIONS : ANSWER_INSTRUCTIONS,
    input: searchInputText(input),
    tools: [webSearchTool(input.allowedDomains)],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    store: false,
    stream: false,
  };
  if (shape === 'results') {
    body.text = { format: { type: 'json_schema', name: 'web_search_results', strict: true, schema: RESULTS_SCHEMA } };
  }
  return body;
}

/** Responses body that asks the model to open `url` and answer `prompt` from it. */
export function buildFetchRequest(model: string, input: FetchInput): Record<string, unknown> {
  return {
    model,
    instructions: FETCH_INSTRUCTIONS,
    input: fetchInputText(input),
    tools: [{ type: 'web_search', search_context_size: 'high' }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    store: false,
    stream: false,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Response parsing
// ──────────────────────────────────────────────────────────────────────

export interface Citation {
  readonly url: string;
  readonly title?: string;
}

export type WebAction =
  | { readonly type: 'search'; readonly queries: readonly string[] }
  | { readonly type: 'open_page'; readonly url: string }
  | { readonly type: 'find_in_page'; readonly url: string; readonly pattern?: string };

export interface ParsedResponse {
  readonly text: string;
  readonly citations: readonly Citation[];
  /** Source URLs the search actions returned (needs `include`), deduped. */
  readonly sources: readonly string[];
  readonly actions: readonly WebAction[];
}

function parseAction(raw: unknown): WebAction | undefined {
  if (!isRecord(raw)) return undefined;
  const url = nonEmpty(raw.url);
  switch (raw.type) {
    case 'search': {
      const queries = Array.isArray(raw.queries) ? raw.queries.filter((q): q is string => typeof q === 'string') : [];
      const query = nonEmpty(raw.query);
      return { type: 'search', queries: queries.length > 0 ? queries : query ? [query] : [] };
    }
    case 'open_page':
      return url ? { type: 'open_page', url } : undefined;
    case 'find_in_page': {
      if (!url) return undefined;
      const pattern = nonEmpty(raw.pattern);
      return pattern ? { type: 'find_in_page', url, pattern } : { type: 'find_in_page', url };
    }
    default:
      return undefined;
  }
}

function pushUnique(list: string[], seen: Set<string>, value: string | undefined): void {
  if (!value || seen.has(value)) return;
  seen.add(value);
  list.push(value);
}

/**
 * Walk a non-streaming Responses body. Throws when the response carries an
 * `error` or a non-completed status with no text.
 */
export function parseResponsesBody(body: unknown): ParsedResponse {
  if (!isRecord(body)) throw new Error('Copilot returned a non-object response');
  if (isRecord(body.error)) {
    throw new Error(`Copilot error: ${nonEmpty(body.error.message) ?? JSON.stringify(body.error)}`);
  }
  const texts: string[] = [];
  const citations: Citation[] = [];
  const citationSeen = new Set<string>();
  const sources: string[] = [];
  const sourceSeen = new Set<string>();
  const actions: WebAction[] = [];

  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (!isRecord(item)) continue;
    if (item.type === 'web_search_call' && isRecord(item.action)) {
      const action = parseAction(item.action);
      if (action) actions.push(action);
      const rawSources: unknown[] = Array.isArray(item.action.sources) ? item.action.sources : [];
      for (const s of rawSources) pushUnique(sources, sourceSeen, isRecord(s) ? urlField(s.url) : undefined);
      continue;
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') continue;
      texts.push(part.text);
      for (const ann of Array.isArray(part.annotations) ? part.annotations : []) {
        if (!isRecord(ann) || ann.type !== 'url_citation') continue;
        const url = urlField(ann.url);
        if (!url || citationSeen.has(url)) continue;
        citationSeen.add(url);
        const title = nonEmpty(ann.title);
        citations.push(title ? { url, title } : { url });
      }
    }
  }

  const text = texts.join('\n\n').trim();
  const status = nonEmpty(body.status);
  if (!text && status !== undefined && status !== 'completed') {
    const reason = isRecord(body.incomplete_details) ? nonEmpty(body.incomplete_details.reason) : undefined;
    throw new Error(`Copilot response ${status}${reason ? ` (${reason})` : ''} with no text`);
  }
  return { text, citations, sources, actions };
}

// ──────────────────────────────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────────────────────────────

/** Prose answer followed by a `Sources:` list (citations first, then other search sources). */
export function formatAnswer(parsed: ParsedResponse, maxSources = 10): string {
  const lines = [parsed.text || '(Copilot returned no answer text.)'];
  const seen = new Set<string>();
  const listed: string[] = [];
  for (const c of parsed.citations) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    listed.push(c.title ? `- [${c.title}](${c.url})` : `- ${c.url}`);
  }
  for (const url of parsed.sources) {
    if (seen.has(url)) continue;
    seen.add(url);
    listed.push(`- ${url}`);
  }
  if (listed.length > 0) lines.push('', 'Sources:', ...listed.slice(0, maxSources));
  return lines.join('\n');
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** True when the model reported opening (or searching inside) `url` itself. */
export function openedUrl(parsed: ParsedResponse, url: string): boolean {
  const target = normalizeUrl(url);
  return parsed.actions.some((a) => a.type !== 'search' && normalizeUrl(a.url) === target);
}

/** Fetch output: the answer plus a note when Copilot never opened the requested URL. */
export function formatFetch(parsed: ParsedResponse, url: string): string {
  const out = formatAnswer(parsed);
  if (openedUrl(parsed, url)) return out;
  return `${out}\n\nNote: Copilot did not report opening ${url} directly; the answer may come from search results or other pages.`;
}

export interface SearchResult {
  url: string;
  title?: string;
  content?: string;
  time: { published?: number };
}

function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function resultsFromJson(text: string): SearchResult[] | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) return undefined;
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of parsed.results) {
    if (!isRecord(item)) continue;
    const url = nonEmpty(item.url);
    if (!url || !isWebUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const result: SearchResult = { url, time: {} };
    const title = nonEmpty(item.title);
    const content = nonEmpty(item.content);
    const published = typeof item.published === 'string' ? Date.parse(item.published) : Number.NaN;
    if (title) result.title = title;
    if (content) result.content = content;
    if (Number.isFinite(published)) result.time.published = published;
    out.push(result);
  }
  return out;
}

/**
 * Native-websearch results from a `results`-shape response. Falls back to the
 * citation list (first entry carries the whole text) when the model ignored
 * the JSON schema.
 */
export function toSearchResults(parsed: ParsedResponse): SearchResult[] {
  const fromJson = resultsFromJson(parsed.text);
  if (fromJson) return fromJson;
  const urls = [...parsed.citations.map((c) => c.url), ...parsed.sources];
  const titles = new Map(parsed.citations.map((c) => [c.url, c.title]));
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const url of urls) {
    if (seen.has(url) || !isWebUrl(url)) continue;
    seen.add(url);
    const result: SearchResult = { url, time: {} };
    const title = titles.get(url);
    if (title) result.title = title;
    if (out.length === 0 && parsed.text) result.content = parsed.text;
    out.push(result);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Transport
// ──────────────────────────────────────────────────────────────────────

export interface CopilotEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  /**
   * Extra headers layered over `COPILOT_WEB_HEADERS` (for example the model's
   * own). A `null` value removes that header, matching pi's `ProviderHeaders`.
   */
  readonly headers?: Readonly<Record<string, string | null | undefined>>;
}

export interface PostOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Final request headers: Copilot defaults, then caller extras, then auth + JSON. */
export function buildHeaders(endpoint: CopilotEndpoint): Record<string, string> {
  const headers: Record<string, string> = { ...COPILOT_WEB_HEADERS };
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
    if (value === null) delete headers[name];
    else if (value !== undefined) headers[name] = value;
  }
  return {
    ...headers,
    Authorization: `Bearer ${endpoint.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function httpErrorMessage(status: number, bodyText: string): string {
  const hint =
    status === 401 || status === 403
      ? ' (sign in to GitHub Copilot again, or check that your plan and org policy allow web search)'
      : '';
  const detail = truncate(bodyText.replace(/\s+/g, ' ').trim(), ERROR_BODY_LIMIT);
  return `Copilot /responses returned HTTP ${status}${hint}${detail ? `: ${detail}` : ''}`;
}

/** POST a Responses body and return the parsed JSON. Throws on HTTP errors, timeouts, and aborts. */
export async function postCopilotResponses(
  endpoint: CopilotEndpoint,
  body: Record<string, unknown>,
  options: PostOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(`${trimSlashes(endpoint.baseUrl)}/responses`, {
    method: 'POST',
    headers: buildHeaders(endpoint),
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(httpErrorMessage(response.status, text));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Copilot /responses returned non-JSON: ${truncate(text, ERROR_BODY_LIMIT)}`);
  }
}

/** Provider id of GitHub Copilot in both pi and opencode. */
export const COPILOT_PROVIDER_ID = 'github-copilot';
