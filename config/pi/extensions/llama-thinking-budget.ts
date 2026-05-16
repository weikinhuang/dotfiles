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
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

type Level = 'minimal' | 'low' | 'medium' | 'high';

const LEVELS: readonly Level[] = ['minimal', 'low', 'medium', 'high'] as const;

function currentThinkingLevel(ctx: ExtensionContext): Level | undefined {
  // Walk the active branch backwards; the last `thinking_level_change` entry
  // is the live level. If there's none, pi hasn't recorded one yet for this
  // session, so we bail out (caller will skip injection).
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as { type?: string; thinkingLevel?: string };
      if (entry?.type === 'thinking_level_change') {
        const lvl = entry.thinkingLevel;
        if (typeof lvl !== 'string') return undefined;
        // pi-ai clamps "xhigh" to "high" before request build, so mirror that here.
        const normalized = lvl === 'xhigh' ? 'high' : lvl;
        return (LEVELS as readonly string[]).includes(normalized) ? (normalized as Level) : undefined;
      }
    }
  } catch {
    // fall through
  }
  return undefined;
}

const DEFAULT_BUDGETS: Record<Level, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

interface InjectionConfig {
  field: string;
  stripEffort: boolean;
  models?: Set<string>;
  budgets: Partial<Record<Level, number>>;
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseBudgets(raw: unknown): Partial<Record<Level, number>> {
  const out: Partial<Record<Level, number>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const level of LEVELS) {
    const v = parsePositiveInt(obj[level]);
    if (v !== undefined) out[level] = v;
  }
  return out;
}

function parseInjection(raw: unknown): InjectionConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const field = typeof obj.field === 'string' && obj.field.trim() ? obj.field.trim() : 'thinking_budget_tokens';
  const stripEffort = obj.stripEffort === true;
  const models = Array.isArray(obj.models)
    ? new Set(obj.models.filter((m): m is string => typeof m === 'string' && m.length > 0))
    : undefined;
  const budgets = parseBudgets(obj.budgets);
  return { field, stripEffort, models, budgets };
}

function loadSettingsBudgets(): Partial<Record<Level, number>> {
  // Project-local overrides global; parse global first, then overlay project.
  const merged: Partial<Record<Level, number>> = {};
  for (const path of [join(homedir(), '.pi', 'agent', 'settings.json'), join(process.cwd(), '.pi', 'settings.json')]) {
    const parsed = readJson(path);
    if (!parsed || typeof parsed !== 'object') continue;
    const tb = (parsed as { thinkingBudgets?: unknown }).thinkingBudgets;
    Object.assign(merged, parseBudgets(tb));
  }
  return merged;
}

function loadProviderInjections(): Map<string, InjectionConfig> {
  const out = new Map<string, InjectionConfig>();
  // Global first, then project - project wins by being applied last.
  for (const path of [join(homedir(), '.pi', 'agent', 'models.json'), join(process.cwd(), '.pi', 'models.json')]) {
    const parsed = readJson(path);
    if (!parsed || typeof parsed !== 'object') continue;
    const providers = (parsed as { providers?: Record<string, unknown> }).providers;
    if (!providers || typeof providers !== 'object') continue;
    for (const [providerName, providerCfg] of Object.entries(providers)) {
      if (!providerCfg || typeof providerCfg !== 'object') continue;
      const injection = parseInjection((providerCfg as Record<string, unknown>).thinkingBudgetInjection);
      if (injection) out.set(providerName, injection);
    }
  }
  return out;
}

function envBudgets(): Partial<Record<Level, number>> {
  return {
    minimal: parsePositiveInt(process.env.PI_LLAMA_BUDGET_MINIMAL),
    low: parsePositiveInt(process.env.PI_LLAMA_BUDGET_LOW),
    medium: parsePositiveInt(process.env.PI_LLAMA_BUDGET_MEDIUM),
    high: parsePositiveInt(process.env.PI_LLAMA_BUDGET_HIGH),
  };
}

function resolveBudget(
  level: Level,
  injection: InjectionConfig,
  settings: Partial<Record<Level, number>>,
  env: Partial<Record<Level, number>>,
): number {
  return env[level] ?? injection.budgets[level] ?? settings[level] ?? DEFAULT_BUDGETS[level];
}

export default function llamaThinkingBudgetExtension(pi: ExtensionAPI): void {
  const providers = loadProviderInjections();
  if (providers.size === 0) return; // No providers opted in - no-op.

  const settings = loadSettingsBudgets();
  const env = envBudgets();

  const debugLog = process.env.PI_LLAMA_BUDGET_DEBUG;
  const trace = (msg: string): void => {
    if (!debugLog) return;
    try {
      appendFileSync(debugLog, `[llama-thinking-budget] ${msg}\n`, 'utf8');
    } catch {}
  };

  pi.on('before_provider_request', (event, ctx) => {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') {
      trace('skip: payload not object');
      return;
    }
    const p = payload as Record<string, unknown>;

    // Detect the current reasoning level from whichever thinking format pi emitted.
    let effort: Level | undefined;
    let detectedVia: string;
    const rawEffort = p.reasoning_effort;
    const ctk = p.chat_template_kwargs as { enable_thinking?: unknown } | undefined;
    const qwenEnable = p.enable_thinking;
    if (typeof rawEffort === 'string' && (LEVELS as readonly string[]).includes(rawEffort)) {
      effort = rawEffort as Level;
      detectedVia = 'reasoning_effort';
    } else if (ctk && typeof ctk === 'object' && ctk.enable_thinking === true) {
      // thinkingFormat="qwen-chat-template": payload carries only a boolean,
      // so read the level from the session.
      effort = currentThinkingLevel(ctx);
      detectedVia = 'chat_template_kwargs.enable_thinking';
    } else if (qwenEnable === true) {
      // thinkingFormat="qwen" or "zai": top-level `enable_thinking: true`.
      effort = currentThinkingLevel(ctx);
      detectedVia = 'enable_thinking';
    } else {
      trace('skip: no reasoning signal in payload (not a thinking request)');
      return;
    }
    if (!effort) {
      trace(`skip: detected ${detectedVia} but no current thinking level in session`);
      return;
    }

    const model = ctx.model as { provider?: string; id?: string } | undefined;
    const providerName = model?.provider;
    if (!providerName) {
      trace('skip: no ctx.model.provider');
      return;
    }

    const injection = providers.get(providerName);
    if (!injection) {
      trace(`skip: provider "${providerName}" not opted in (have: ${[...providers.keys()].join(',') || '<none>'})`);
      return;
    }
    if (injection.models && model?.id && !injection.models.has(model.id)) {
      trace(`skip: model "${model.id}" not in allow-list`);
      return;
    }

    const budget = resolveBudget(effort, injection, settings, env);
    if (!Number.isFinite(budget) || budget <= 0) {
      trace(`skip: invalid budget ${budget} for level ${effort}`);
      return;
    }

    const next: Record<string, unknown> = { ...p, [injection.field]: budget };
    if (injection.stripEffort) delete next.reasoning_effort;
    trace(
      `inject: provider=${providerName} model=${model?.id ?? '?'} via=${detectedVia} effort=${effort} ${injection.field}=${budget} strip=${injection.stripEffort}`,
    );
    return next;
  });
}
