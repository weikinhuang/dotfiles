/**
 * Provider-native `web_search` and `web_fetch` tools for pi. See ./native-web.md.
 *
 * When the session's current provider has a server-side web tool (GitHub
 * Copilot and OpenAI / ChatGPT-subscription Codex via the Responses
 * `web_search` tool, Anthropic via its `web_search` / `web_fetch` server
 * tools), the tools are active and the overlapping `ai-fetch-web` skill is
 * hidden. On any other provider the tools are off and `ai-fetch-web` stays the
 * web path.
 *
 * Each call goes through pi's own provider stack (`modelRegistry.complete`),
 * so auth, endpoints, and headers are pi's for every provider. `onPayload`
 * adds the native tool and a capturing `fetch` copies the raw response,
 * because pi's message parsers drop citations and server-tool results. The
 * logic lives in lib/node/pi/native-web.ts and lib/node/pi/copilot-web.ts.
 *
 * Environment:
 *   PI_NATIVE_WEB_DISABLED=1          skip the extension entirely
 *   PI_NATIVE_WEB_MODELS=<p/id,...>   per-provider model for web calls (default: the table's preferred
 *                                     model, else the cheapest eligible model on that provider)
 *   PI_NATIVE_WEB_TIMEOUT_MS=<n>      per-call timeout (default 120000)
 *   PI_NATIVE_WEB_ALWAYS=1            keep the tools on for every provider (unsupported ones error)
 *   PI_NATIVE_WEB_HIDE_SKILLS=<a,b>   skills hidden while the tools are on (default ai-fetch-web;
 *                                     empty hides none)
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  DEFAULT_TIMEOUT_MS,
  formatAnswer,
  formatFetch,
  type ParsedResponse,
  validateFetchInput,
  validateSearchInput,
} from '../../../lib/node/pi/copilot-web.ts';
import {
  applyWebGate,
  createCapturingFetch,
  injectWebTool,
  parseModelOverrides,
  parseNativeWebRaw,
  parseSkillList,
  type ResolvedWebModel,
  resolveWebModel,
  type WebCall,
  webCallHeaders,
  webCallPrompt,
} from '../../../lib/node/pi/native-web.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';

const SearchParams = Type.Object({
  query: Type.String({ description: 'What to search the web for.' }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), { description: 'Only use results from these domains (e.g. ["docs.github.com"]).' }),
  ),
});

const FetchParams = Type.Object({
  url: Type.String({ description: 'Absolute http(s) URL to open.' }),
  prompt: Type.Optional(
    Type.String({
      description:
        'What to extract or answer from the page. Be specific; omit to get the main content back as faithfully as possible.',
    }),
  ),
});

interface WebCallResult {
  model: string;
  parsed: ParsedResponse;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function preview(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

export default function nativeWebExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_NATIVE_WEB_DISABLED)) return;

  const overrides = parseModelOverrides(process.env.PI_NATIVE_WEB_MODELS);
  const timeoutMs = parsePositiveInt(process.env.PI_NATIVE_WEB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const hiddenSkills = parseSkillList(process.env.PI_NATIVE_WEB_HIDE_SKILLS);

  const resolve = (ctx: ExtensionContext): ResolvedWebModel<Model<Api>> | undefined =>
    resolveWebModel<Model<Api>>(ctx.modelRegistry.getAvailable(), ctx.model?.provider, overrides);

  async function runWebCall(
    ctx: ExtensionContext,
    call: WebCall,
    signal: AbortSignal | undefined,
  ): Promise<WebCallResult> {
    const resolved = resolve(ctx);
    if (!resolved) {
      throw new Error(
        `The current provider (${ctx.model?.provider ?? 'none'}) has no native web tool; use the ai-fetch-web CLI instead.`,
      );
    }
    const { model, family } = resolved;
    const { systemPrompt, userText } = webCallPrompt(call);
    const capture = createCapturingFetch();
    let piError: string | undefined;
    try {
      const message = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt,
          messages: [{ role: 'user', content: [{ type: 'text', text: userText }], timestamp: Date.now() }],
        },
        {
          signal,
          timeoutMs,
          fetch: capture.fetch,
          headers: webCallHeaders(family, call),
          onPayload: (payload) => injectWebTool(family, payload, call),
        },
      );
      if (message.stopReason === 'error' || message.stopReason === 'aborted') piError = message.errorMessage;
    } catch (err) {
      piError = errorText(err);
    }
    if (signal?.aborted) throw new Error('web call aborted');
    const raw = await capture.body();
    if (!raw) throw new Error(piError ?? `${model.provider}/${model.id} returned no response`);
    try {
      return { model: `${model.provider}/${model.id}`, parsed: parseNativeWebRaw(family, raw) };
    } catch (err) {
      throw new Error(piError ?? errorText(err));
    }
  }

  if (!envTruthy(process.env.PI_NATIVE_WEB_ALWAYS)) {
    let hiddenByGate: string[] = [];
    pi.on('before_agent_start', (event, ctx) => {
      const options = event.systemPromptOptions;
      const gate = applyWebGate({
        supported: resolve(ctx) !== undefined,
        selectedTools: options.selectedTools,
        skills: options.skills,
        hiddenByGate,
        hiddenSkills,
      });
      hiddenByGate = gate.hiddenByGate;
      options.selectedTools.splice(0, options.selectedTools.length, ...gate.selectedTools);
      options.skills.splice(0, options.skills.length, ...gate.skills);
    });
  }

  pi.registerTool({
    name: 'web_search',
    label: 'Web search',
    description:
      "Search the web with the current provider's built-in web search and get back a concise, cited answer with a Sources list. Use for current information, release versions, documentation lookups, and anything past your training data. Phrase `query` as a specific question.",
    promptSnippet: 'For web lookups, call `web_search` (cited answer) or `web_fetch` (read one URL).',
    parameters: SearchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = validateSearchInput(params);
      if (!input.ok) return { content: [{ type: 'text', text: input.error }], details: {}, isError: true };
      try {
        const { model, parsed } = await runWebCall(ctx, { kind: 'search', input: input.value }, signal);
        return {
          content: [{ type: 'text', text: formatAnswer(parsed) }],
          details: { model, citations: parsed.citations.length, actions: parsed.actions.length },
        };
      } catch (err) {
        return { content: [{ type: 'text', text: errorText(err) }], details: {}, isError: true };
      }
    },

    renderCall(args, theme, _context) {
      const head = theme.fg('toolTitle', theme.bold('web_search '));
      return new Text(`${head}${theme.fg('dim', preview(String(args.query ?? ''), 80))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: 'web_fetch',
    label: 'Web fetch',
    description:
      "Have the current provider's built-in web tool open one URL server-side and answer `prompt` from that page only. Returns the model's answer (not raw HTML), with a note when the provider could not open the exact URL. Good for docs pages, READMEs, changelogs, and pages that block plain HTTP clients. Not for localhost, private, or authenticated URLs.",
    parameters: FetchParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = validateFetchInput(params);
      if (!input.ok) return { content: [{ type: 'text', text: input.error }], details: {}, isError: true };
      try {
        const { model, parsed } = await runWebCall(ctx, { kind: 'fetch', input: input.value }, signal);
        return {
          content: [{ type: 'text', text: formatFetch(parsed, input.value.url) }],
          details: { model, citations: parsed.citations.length, actions: parsed.actions.length },
        };
      } catch (err) {
        return { content: [{ type: 'text', text: errorText(err) }], details: {}, isError: true };
      }
    },

    renderCall(args, theme, _context) {
      const head = theme.fg('toolTitle', theme.bold('web_fetch '));
      return new Text(`${head}${theme.fg('dim', preview(String(args.url ?? ''), 80))}`, 0, 0);
    },
  });
}
