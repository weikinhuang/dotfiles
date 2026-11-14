/**
 * Provider-native web search / fetch for pi: route `web_search` and
 * `web_fetch` through the current provider's own server-side web tool
 * (OpenAI Responses `web_search`, Anthropic `web_search` / `web_fetch`), and
 * fall back to the `ai-fetch-web` skill on providers that have none.
 *
 * The extension sends the request through pi's own provider stack
 * (`modelRegistry.complete`), so auth, endpoints, and headers come from pi for
 * every provider (Copilot, ChatGPT-subscription Codex, OpenAI, Anthropic).
 * This module only:
 *
 *   - decides which (provider, api) pairs have a native web tool and which
 *     model on that provider runs it (`resolveWebModel`);
 *   - adds the tool to pi's outgoing payload (`injectWebTool`);
 *   - parses the raw response bytes a capturing `fetch` copied, because pi's
 *     message parsers drop citations and server-tool results
 *     (`parseNativeWebRaw`);
 *   - gates the tools and the fallback skill per provider (`applyWebGate`).
 *
 * Pure module: no harness imports.
 */

import {
  ANSWER_INSTRUCTIONS,
  type Citation,
  FETCH_INSTRUCTIONS,
  type FetchInput,
  fetchInputText,
  type ParsedResponse,
  parseResponsesBody,
  type SearchInput,
  searchInputText,
  stripTracking,
  type WebAction,
} from './copilot-web.ts';
import { isRecord } from './shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Capability table
// ──────────────────────────────────────────────────────────────────────

/** Wire-protocol family the injector and parser speak. */
export type WebFamily = 'openai-responses' | 'anthropic-messages';

export interface NativeWebProvider {
  readonly provider: string;
  /** pi `api` ids on this provider whose models have the native tool. */
  readonly apis: readonly string[];
  readonly family: WebFamily;
  /** Model to run web calls on when it is available; else the cheapest eligible one. */
  readonly preferredModel?: string;
}

/**
 * Providers with a server-side web tool. Keyed by provider *and* api: Copilot
 * serves Claude over `anthropic-messages` but rejects Anthropic's web tools
 * there ("The use of the web search tool is not supported"), so only its
 * Responses models qualify.
 */
export const NATIVE_WEB_PROVIDERS: readonly NativeWebProvider[] = [
  { provider: 'github-copilot', apis: ['openai-responses'], family: 'openai-responses', preferredModel: 'gpt-6-luna' },
  {
    provider: 'openai-codex',
    apis: ['openai-codex-responses'],
    family: 'openai-responses',
    preferredModel: 'gpt-6-luna',
  },
  { provider: 'openai', apis: ['openai-responses'], family: 'openai-responses', preferredModel: 'gpt-6-luna' },
  {
    provider: 'anthropic',
    apis: ['anthropic-messages'],
    family: 'anthropic-messages',
    preferredModel: 'claude-haiku-5-5',
  },
];

export interface WebModelCandidate {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  readonly cost?: { readonly input?: number };
}

export interface ResolvedWebModel<T> {
  readonly model: T;
  readonly family: WebFamily;
}

/**
 * Pick the model that serves web calls for the session's current provider:
 * an override (`provider/id`), else the provider's preferred model, else the
 * cheapest eligible model on that provider (ties keep registry order).
 * `undefined` when the provider has no native web tool or no eligible model
 * is available - the caller then falls back to `ai-fetch-web`.
 */
export function resolveWebModel<T extends WebModelCandidate>(
  available: readonly T[],
  currentProvider: string | undefined,
  overrides: ReadonlyMap<string, string> = new Map(),
  table: readonly NativeWebProvider[] = NATIVE_WEB_PROVIDERS,
): ResolvedWebModel<T> | undefined {
  if (!currentProvider) return undefined;
  const entry = table.find((e) => e.provider === currentProvider);
  if (!entry) return undefined;
  const eligible = available.filter((m) => m.provider === entry.provider && entry.apis.includes(m.api));
  const wanted = overrides.get(entry.provider) ?? entry.preferredModel;
  const exact = wanted ? eligible.find((m) => m.id === wanted) : undefined;
  if (exact) return { model: exact, family: entry.family };
  let best: T | undefined;
  for (const m of eligible) {
    const cost = m.cost?.input ?? Number.POSITIVE_INFINITY;
    if (!best || cost < (best.cost?.input ?? Number.POSITIVE_INFINITY)) best = m;
  }
  return best ? { model: best, family: entry.family } : undefined;
}

/** `PI_NATIVE_WEB_MODELS="github-copilot/gpt-6.1-terra,openai-codex/gpt-6-luna"` -> provider => model id. */
export function parseModelOverrides(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? '').split(',')) {
    const trimmed = part.trim();
    const slash = trimmed.indexOf('/');
    if (slash <= 0 || slash === trimmed.length - 1) continue;
    out.set(trimmed.slice(0, slash), trimmed.slice(slash + 1));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Request shaping
// ──────────────────────────────────────────────────────────────────────

export type WebCall =
  | { readonly kind: 'search'; readonly input: SearchInput }
  | { readonly kind: 'fetch'; readonly input: FetchInput };

/** System prompt and user text for a web call (sent through pi's normal context). */
export function webCallPrompt(call: WebCall): { systemPrompt: string; userText: string } {
  return call.kind === 'search'
    ? { systemPrompt: ANSWER_INSTRUCTIONS, userText: searchInputText(call.input) }
    : { systemPrompt: FETCH_INSTRUCTIONS, userText: fetchInputText(call.input) };
}

/** Anthropic beta header the fetch tool needs; `undefined` when none. */
export function webCallHeaders(family: WebFamily, call: WebCall): Record<string, string> | undefined {
  return family === 'anthropic-messages' && call.kind === 'fetch'
    ? { 'anthropic-beta': 'web-fetch-2025-09-10' }
    : undefined;
}

const ANTHROPIC_MAX_USES = 5;

function withTools(payload: Record<string, unknown>, tools: readonly Record<string, unknown>[]): unknown[] {
  return [...(Array.isArray(payload.tools) ? (payload.tools as unknown[]) : []), ...tools];
}

/**
 * Add the native web tool to pi's outgoing payload. Returns a new object; the
 * input payload is not mutated. Non-object payloads pass through unchanged.
 */
export function injectWebTool(family: WebFamily, payload: unknown, call: WebCall): unknown {
  if (!isRecord(payload)) return payload;
  const next: Record<string, unknown> = { ...payload };
  if (family === 'openai-responses') {
    const tool: Record<string, unknown> =
      call.kind === 'search' && call.input.allowedDomains?.length
        ? { type: 'web_search', filters: { allowed_domains: [...call.input.allowedDomains] } }
        : call.kind === 'fetch'
          ? { type: 'web_search', search_context_size: 'high' }
          : { type: 'web_search' };
    next.tools = withTools(payload, [tool]);
    next.tool_choice = 'required';
    const include = Array.isArray(payload.include) ? (payload.include as unknown[]) : [];
    next.include = include.includes('web_search_call.action.sources')
      ? include
      : [...include, 'web_search_call.action.sources'];
    return next;
  }
  const tool: Record<string, unknown> =
    call.kind === 'search'
      ? {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: ANTHROPIC_MAX_USES,
          ...(call.input.allowedDomains?.length ? { allowed_domains: [...call.input.allowedDomains] } : {}),
        }
      : { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: ANTHROPIC_MAX_USES, citations: { enabled: true } };
  next.tools = withTools(payload, [tool]);
  return next;
}

// ──────────────────────────────────────────────────────────────────────
// Response capture + parsing
// ──────────────────────────────────────────────────────────────────────

export interface CapturingFetch {
  readonly fetch: typeof fetch;
  /** Body text of the last response (resolves once the stream finishes). */
  body(): Promise<string | undefined>;
}

/** Wrap `fetch` so the last response body is copied for {@link parseNativeWebRaw}. */
export function createCapturingFetch(base: typeof fetch = fetch): CapturingFetch {
  let captured: Promise<string> | undefined;
  const wrapped: typeof fetch = async (input, init) => {
    const response = await base(input, init);
    captured = response
      .clone()
      .text()
      .catch(() => '');
    return response;
  };
  return { fetch: wrapped, body: async () => (captured ? await captured : undefined) };
}

/** `data:` payloads of an SSE stream, JSON-decoded; non-JSON lines are skipped. */
export function parseSseData(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      // keep-alives and partial frames
    }
  }
  return events;
}

function looksLikeSse(raw: string): boolean {
  return /^(?:event|data):/m.test(raw.trimStart().slice(0, 200)) || raw.trimStart().startsWith('event:');
}

function parseJsonOrUndefined(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseResponsesRaw(raw: string): ParsedResponse {
  if (!looksLikeSse(raw)) return parseResponsesBody(parseJsonOrUndefined(raw));
  let final: unknown;
  for (const event of parseSseData(raw)) {
    if (!isRecord(event)) continue;
    if (event.type === 'error') throw new Error(`Provider error: ${JSON.stringify(event.error ?? event)}`);
    if (
      (event.type === 'response.completed' ||
        event.type === 'response.incomplete' ||
        event.type === 'response.failed' ||
        event.type === 'response.done') &&
      isRecord(event.response)
    ) {
      final = event.response;
    }
  }
  if (final === undefined) throw new Error('Provider stream ended without a final response');
  return parseResponsesBody(final);
}

interface AnthropicBlock {
  type: string;
  text: string;
  citations: Citation[];
  name?: string;
  input?: unknown;
  inputJson: string;
  sources: string[];
}

function citationOf(raw: unknown): Citation | undefined {
  if (!isRecord(raw) || typeof raw.url !== 'string' || !raw.url) return undefined;
  const url = stripTracking(raw.url);
  return typeof raw.title === 'string' && raw.title ? { url, title: raw.title } : { url };
}

function blockFrom(raw: Record<string, unknown>): AnthropicBlock {
  const block: AnthropicBlock = {
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    text: typeof raw.text === 'string' ? raw.text : '',
    citations: [],
    inputJson: '',
    sources: [],
  };
  if (Array.isArray(raw.citations)) {
    for (const c of raw.citations) {
      const citation = citationOf(c);
      if (citation) block.citations.push(citation);
    }
  }
  if (typeof raw.name === 'string') block.name = raw.name;
  if (raw.input !== undefined) block.input = raw.input;
  if (block.type === 'web_search_tool_result' && Array.isArray(raw.content)) {
    for (const r of raw.content) if (isRecord(r) && typeof r.url === 'string') block.sources.push(stripTracking(r.url));
  }
  if (block.type === 'web_fetch_tool_result' && isRecord(raw.content) && typeof raw.content.url === 'string') {
    block.sources.push(stripTracking(raw.content.url));
  }
  return block;
}

function anthropicBlocks(raw: string): AnthropicBlock[] {
  if (!looksLikeSse(raw)) {
    const body = parseJsonOrUndefined(raw);
    if (!isRecord(body)) throw new Error('Provider returned a non-object response');
    if (isRecord(body.error)) throw new Error(`Provider error: ${JSON.stringify(body.error)}`);
    return (Array.isArray(body.content) ? body.content : []).filter(isRecord).map(blockFrom);
  }
  const blocks: AnthropicBlock[] = [];
  for (const event of parseSseData(raw)) {
    if (!isRecord(event)) continue;
    if (event.type === 'error') throw new Error(`Provider error: ${JSON.stringify(event.error ?? event)}`);
    const index = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'content_block_start' && isRecord(event.content_block) && index >= 0) {
      blocks[index] = blockFrom(event.content_block);
      continue;
    }
    const block = index >= 0 ? blocks[index] : undefined;
    if (event.type !== 'content_block_delta' || !block || !isRecord(event.delta)) continue;
    const { delta } = event;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') block.text += delta.text;
    else if (delta.type === 'citations_delta') {
      const citation = citationOf(delta.citation);
      if (citation) block.citations.push(citation);
    } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      block.inputJson += delta.partial_json;
    }
  }
  return blocks.filter((b): b is AnthropicBlock => b !== undefined);
}

function anthropicAction(block: AnthropicBlock): WebAction | undefined {
  // Streamed blocks start with `input: {}` and fill it through input_json_delta.
  const parsed = block.inputJson ? parseJsonOrUndefined(block.inputJson) : block.input;
  const input = isRecord(parsed) ? parsed : {};
  if (block.name === 'web_search' && typeof input.query === 'string') return { type: 'search', queries: [input.query] };
  if (block.name === 'web_fetch' && typeof input.url === 'string') return { type: 'open_page', url: input.url };
  return undefined;
}

function parseAnthropicRaw(raw: string): ParsedResponse {
  const texts: string[] = [];
  const citations: Citation[] = [];
  const citationSeen = new Set<string>();
  const sources: string[] = [];
  const sourceSeen = new Set<string>();
  const actions: WebAction[] = [];
  for (const block of anthropicBlocks(raw)) {
    if (block.type === 'text') {
      texts.push(block.text);
      for (const c of block.citations) {
        if (citationSeen.has(c.url)) continue;
        citationSeen.add(c.url);
        citations.push(c);
      }
    } else if (block.type === 'server_tool_use') {
      const action = anthropicAction(block);
      if (action) actions.push(action);
    }
    for (const url of block.sources) {
      if (sourceSeen.has(url)) continue;
      sourceSeen.add(url);
      sources.push(url);
    }
  }
  return { text: texts.join('').trim(), citations, sources, actions };
}

/** Parse the raw body a {@link CapturingFetch} copied for the given family. */
export function parseNativeWebRaw(family: WebFamily, raw: string): ParsedResponse {
  return family === 'openai-responses' ? parseResponsesRaw(raw) : parseAnthropicRaw(raw);
}

// ──────────────────────────────────────────────────────────────────────
// Gating
// ──────────────────────────────────────────────────────────────────────

export const NATIVE_WEB_TOOL_NAMES: readonly string[] = ['web_search', 'web_fetch'];

/** Skills that duplicate the native tools and are hidden while they are on. */
export const DEFAULT_HIDDEN_SKILLS: readonly string[] = ['ai-fetch-web'];

export interface WebGateInput<S extends { readonly name: string }> {
  /** The current provider has a native web tool and an eligible model. */
  readonly supported: boolean;
  readonly selectedTools: readonly string[];
  readonly skills: readonly S[];
  /** Tools this gate deactivated earlier and may restore. */
  readonly hiddenByGate: readonly string[];
  readonly toolNames?: readonly string[];
  readonly hiddenSkills?: readonly string[];
}

export interface WebGateResult<S> {
  readonly selectedTools: string[];
  readonly skills: S[];
  readonly hiddenByGate: string[];
}

/**
 * When `supported`, the native tools are on (restoring only ones this gate
 * turned off, so a persona / preset allowlist that never had them stays
 * intact) and `hiddenSkills` are dropped from the prompt. Otherwise the
 * native tools are turned off and the skills (for example `ai-fetch-web`)
 * stay as the web path.
 */
export function applyWebGate<S extends { readonly name: string }>(input: WebGateInput<S>): WebGateResult<S> {
  const tools = new Set(input.toolNames ?? NATIVE_WEB_TOOL_NAMES);
  if (input.supported) {
    const hiddenSkills = new Set(input.hiddenSkills ?? DEFAULT_HIDDEN_SKILLS);
    const selectedTools = [...input.selectedTools];
    for (const name of input.hiddenByGate) {
      if (tools.has(name) && !selectedTools.includes(name)) selectedTools.push(name);
    }
    return { selectedTools, skills: input.skills.filter((s) => !hiddenSkills.has(s.name)), hiddenByGate: [] };
  }
  const hiddenByGate = new Set(input.hiddenByGate.filter((name) => tools.has(name)));
  const selectedTools: string[] = [];
  for (const name of input.selectedTools) {
    if (tools.has(name)) hiddenByGate.add(name);
    else selectedTools.push(name);
  }
  return { selectedTools, skills: [...input.skills], hiddenByGate: [...hiddenByGate] };
}

/** Comma-separated skill names; blank entries dropped, `undefined` keeps the default. */
export function parseSkillList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return DEFAULT_HIDDEN_SKILLS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
