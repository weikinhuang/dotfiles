/**
 * Inject a numeric thinking budget into OpenAI-compatible requests.
 *
 * Pi's OAI-completions provider represents "how much thinking" in one of
 * three ways depending on the model's `compat.thinkingFormat`:
 *
 *   - "openai" (default)          -> `reasoning_effort: "minimal|low|medium|high"`
 *   - "qwen-chat-template"        -> `chat_template_kwargs.enable_thinking: true`
 *   - "qwen" / "zai"              -> `enable_thinking: true`
 *
 * None of those carry a numeric budget. This extension watches
 * `before_provider_request`, detects any of the three signals, and - for
 * providers that opt in via a `thinkingBudgetInjection` block in
 * `models.json` - adds a numeric `thinking_budget_tokens` (configurable
 * field name) to the payload. When the payload only carries a boolean
 * (qwen / qwen-chat-template), the current thinking level is read from
 * the session so we know which budget to use.
 *
 * Opt-in in `~/.pi/agent/models.json` (or project `.pi/models.json`):
 *
 *   {
 *     "providers": {
 *       "llama-cpp": {
 *         "baseUrl": "https://llm.example.com/v1",
 *         "api": "openai-completions",
 *         "thinkingBudgetInjection": {
 *           "field": "thinking_budget_tokens",
 *           "stripEffort": false,
 *           "models": ["qwen3-6-35b-a3b"],
 *           "budgets": {
 *             "minimal": 1024,
 *             "low": 2048,
 *             "medium": 8192,
 *             "high": 16384
 *           }
 *         },
 *         "models": [ ... ]
 *       }
 *     }
 *   }
 *
 * Keys under `thinkingBudgetInjection` (all optional):
 *   field        Numeric field name to inject. Default: "thinking_budget_tokens".
 *   stripEffort  Remove `reasoning_effort` after injecting. Default: false.
 *   models       Restrict to this list of model ids. Omit to match every model
 *                in the provider.
 *   budgets      Per-level override (minimal/low/medium/high -> int). Missing
 *                levels fall back to pi's `thinkingBudgets` setting, then to
 *                pi-ai defaults (1024/2048/8192/16384).
 *
 * Env overrides (take precedence over per-provider budgets):
 *   PI_LLAMA_BUDGET_MINIMAL / _LOW / _MEDIUM / _HIGH
 *
 * Env:
 *   PI_LLAMA_THINKING_BUDGET_DISABLED=1  skip the extension entirely
 *   PI_LLAMA_BUDGET_DEBUG=<path>         append one diagnostic line per
 *                                        request decision to <path>
 *
 * The pure logic lives under `lib/node/pi/llama-thinking-budget/`; this
 * shell only reads env / cwd, loads config, and wires the hook.
 */

import { appendFileSync } from 'node:fs';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { computeInjection } from '../../../lib/node/pi/llama-thinking-budget/inject.ts';
import { loadProviderInjections, loadSettingsBudgets } from '../../../lib/node/pi/llama-thinking-budget/load-config.ts';
import { envBudgets } from '../../../lib/node/pi/llama-thinking-budget/resolve-budget.ts';
import { resolveThinkingLevel } from '../../../lib/node/pi/llama-thinking-budget/session-thinking-level.ts';
import { type Level } from '../../../lib/node/pi/llama-thinking-budget/types.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

function currentThinkingLevel(ctx: ExtensionContext): Level | undefined {
  try {
    return resolveThinkingLevel(ctx.sessionManager.getBranch());
  } catch {
    return undefined;
  }
}

export default function llamaThinkingBudgetExtension(pi: ExtensionAPI): void {
  // TODO(phase-k): add a command-surface spec asserting this guard skips
  // registration once this extension gains a spec file.
  if (envTruthy(process.env.PI_LLAMA_THINKING_BUDGET_DISABLED)) return;

  const providers = loadProviderInjections(process.cwd());
  if (providers.size === 0) return; // No providers opted in - no-op.

  const settings = loadSettingsBudgets(process.cwd());
  const env = envBudgets(process.env);

  const debugLog = process.env.PI_LLAMA_BUDGET_DEBUG;
  const trace = (msg: string): void => {
    if (!debugLog) return;
    try {
      appendFileSync(debugLog, `[llama-thinking-budget] ${msg}\n`, 'utf8');
    } catch {}
  };

  pi.on('before_provider_request', (event, ctx) => {
    const model = ctx.model as { provider?: string; id?: string } | undefined;
    const decision = computeInjection({
      payload: event.payload,
      providerName: model?.provider,
      modelId: model?.id,
      providers,
      settings,
      env,
      getSessionLevel: () => currentThinkingLevel(ctx),
    });
    trace(decision.trace);
    if (decision.action === 'inject') return decision.payload;
    return;
  });
}
