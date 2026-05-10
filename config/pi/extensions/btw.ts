/**
 * `/btw` — Claude Code–style ephemeral side-question command.
 *
 * The user types `/btw <question>` and gets an answer synthesized from
 * the current session's already-loaded context, without:
 *   1. Saving the Q&A to session history (no sendMessage / appendEntry).
 *   2. Letting the model call tools (tools: [] in the Context we pass).
 *
 * Pi's extension API doesn't expose a "call the LLM out of band"
 * primitive — `pi.sendMessage` / `pi.sendUserMessage` both append to the
 * session and trigger turns. To get ephemeral semantics we reach through
 * to the `@earendil-works/pi-ai` `complete()` function directly, using
 * pi's own helpers to reconstruct the branch context that would be sent
 * next turn:
 *
 *   1. Grab the current branch: ctx.sessionManager.getBranch()
 *   2. Convert entries → LLM messages: buildSessionContext(entries)
 *   3. Append the side question as a synthetic user message.
 *   4. Resolve creds: ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
 *   5. Call pi-ai's complete() with tools: [] and sessionId set so
 *      prompt caching engages.
 *   6. Render the answer via ctx.ui.notify — DO NOT persist it.
 *
 * Request parameters we inherit: model, system prompt (ctx.getSystemPrompt),
 * messages (via buildSessionContext), apiKey + headers (via ModelRegistry),
 * sessionId (for prompt cache reuse).
 *
 * Request parameters we do NOT inherit: temperature, maxTokens, timeouts,
 * retries, metadata, per-provider options (Anthropic cacheRetention,
 * Google thinkingBudgets, Bedrock options). pi-ai defaults apply. In the
 * typical Anthropic/OpenAI case cache reuse still works because the
 * request prefix (system + messages + tools) is unchanged; for exotic
 * provider-specific setups cache reuse is best-effort.
 *
 * Environment:
 *   PI_BTW_DISABLED=1          skip the extension entirely (no /btw command)
 *   PI_BTW_MODEL=provider/id   answer side questions with a specific model
 *                              instead of the session's current model
 *   PI_BTW_INCLUDE_TOOLS=1     pass the currently-active tools to the call
 *                              (escape hatch — defeats the whole point)
 *
 * Pure helpers live in ../../../lib/node/pi/btw.ts so they can be
 * unit-tested under `vitest` without the pi runtime.
 */

import { complete, type Context, type Message, type Model } from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  buildSessionContext,
  convertToLlm,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';

/**
 * Read-only subset of `SessionManager` — pi 0.74 dropped the public
 * `ReadonlySessionManager` alias, so we redeclare the narrow Pick we
 * actually use.
 */
type ReadonlySessionManager = Pick<SessionManager, 'getBranch' | 'getSessionId'>;

import {
  BTW_USAGE,
  type BtwFooterStats,
  buildSideQuestionUserContent,
  extractAnswerText,
  formatFooter,
  parseModelSpec,
} from '../../../lib/node/pi/btw.ts';

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

/**
 * Pi's default cache retention (per `StreamOptions` docs in
 * `@earendil-works/pi-ai/types.d.ts`). We pass it explicitly so the
 * request is byte-identical to what pi would have sent for the main
 * turn prefix, maximizing cache-hit odds.
 */
const CACHE_RETENTION = 'short' as const;

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

type ModelLike = Model<any>;

/**
 * Narrow read-only session manager surface — intentionally a Pick of
 * only the methods this extension uses, so the helpers can be reasoned
 * about without dragging in the full pi type.
 */
type SessionView = Pick<ReadonlySessionManager, 'getBranch' | 'getSessionId'>;

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** No-op unsubscribe. Shared so we don't allocate per call. */
const NO_UNSUBSCRIBE = (): void => {
  // intentionally empty — nothing to clean up when there was nothing to subscribe.
};

/**
 * Wire a parent AbortSignal to a child handler, returning an
 * unsubscribe function that removes the listener on successful
 * completion. If the parent is already aborted we run the handler
 * synchronously.
 */
function onAbort(signal: AbortSignal, handler: () => void): () => void {
  if (signal.aborted) {
    handler();
    return NO_UNSUBSCRIBE;
  }
  const listener = (): void => handler();
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function btw(pi: ExtensionAPI): void {
  if (process.env.PI_BTW_DISABLED === '1') return;

  pi.registerCommand('btw', {
    description: "Ask an ephemeral side question about this session's context (no tools, not saved)",
    handler: async (args, ctx) => {
      // 1. Parse the question.
      const userContent = buildSideQuestionUserContent(args ?? '');
      if (!userContent) {
        ctx.ui.notify(BTW_USAGE, 'info');
        return;
      }

      // 2. Resolve the model to answer with.
      const override = parseModelSpec(process.env.PI_BTW_MODEL);
      let model: ModelLike | undefined = ctx.model;
      if (override) {
        const overridden = ctx.modelRegistry.find(override.provider, override.modelId);
        if (!overridden) {
          ctx.ui.notify(
            `PI_BTW_MODEL is set to ${override.provider}/${override.modelId} but that model isn't registered. ` +
              'Falling back to the current model.',
            'warning',
          );
        } else {
          model = overridden;
        }
      }
      if (!model) {
        ctx.ui.notify(
          'No active model — /btw needs a model to answer the side question. Run /login or select one with /model first.',
          'error',
        );
        return;
      }

      // 3. Resolve credentials.
      const authed = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!authed.ok) {
        ctx.ui.notify(`/btw: could not resolve API key for ${model.provider}/${model.id}: ${authed.error}`, 'error');
        return;
      }

      // 4. Reconstruct the current branch as an LLM message list.
      const sessionView: SessionView = ctx.sessionManager;
      const entries = sessionView.getBranch();
      const { messages: existingAgentMessages } = buildSessionContext(entries);
      const existingMessages = convertToLlm(existingAgentMessages);
      const sideQuestion: Message = {
        role: 'user',
        content: userContent,
        timestamp: Date.now(),
      };
      const messages: Message[] = [...existingMessages, sideQuestion];

      // 5. Assemble the Context. Tools default to empty — side questions
      //    answer from context, not by running code.
      const context: Context = {
        systemPrompt: ctx.getSystemPrompt(),
        messages,
        tools: process.env.PI_BTW_INCLUDE_TOOLS === '1' ? undefined : [],
      };

      // 6. Call the model. The AbortSignal is wired so Ctrl+C cancels
      //    cleanly if the user loses patience; apiKey / headers come
      //    from the resolved auth so we don't rely on env-var fallback.
      ctx.ui.setStatus('btw', 'thinking…');
      const controller = new AbortController();
      const unsubscribe = ctx.signal ? onAbort(ctx.signal, () => controller.abort()) : NO_UNSUBSCRIBE;
      const started = Date.now();
      let answer: string;
      let stats: BtwFooterStats;
      try {
        const resp = await complete(model, context, {
          apiKey: authed.apiKey,
          headers: authed.headers,
          sessionId: sessionView.getSessionId(),
          cacheRetention: CACHE_RETENTION,
          signal: controller.signal,
        });
        if (resp.stopReason === 'error' || resp.stopReason === 'aborted') {
          const detail = resp.errorMessage ? ` (${resp.errorMessage})` : '';
          ctx.ui.notify(`/btw: model returned ${resp.stopReason}${detail}`, 'error');
          return;
        }
        answer = extractAnswerText(resp.content);
        stats = {
          model: resp.model,
          totalTokens: resp.usage?.totalTokens,
          cacheReadTokens: resp.usage?.cacheRead,
          outputTokens: resp.usage?.output,
          costUsd: resp.usage?.cost?.total,
          durationMs: Date.now() - started,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`/btw: ${msg}`, 'error');
        return;
      } finally {
        unsubscribe();
        ctx.ui.setStatus('btw', undefined);
      }

      // 7. Render. `ctx.ui.notify` is the dismissible-overlay-ish
      //    channel in pi — it's what statusline, scratchpad, and the
      //    other extensions use for non-persistent output. We do NOT
      //    call pi.sendMessage / pi.sendUserMessage / pi.appendEntry;
      //    that's what keeps the Q&A ephemeral.
      const body = answer.length > 0 ? answer : '(model returned an empty response)';
      ctx.ui.notify(`${body}\n\n${formatFooter(stats)}`, 'info');
    },
  });
}
