/**
 * Small-model system-prompt addendum for pi.
 *
 * Weak, self-hosted models (qwen3-30B-A3B, gpt-oss-20B, and similar
 * ~3–30B class chat models) need repeated reinforcement of the
 * behaviors the rest of this toolkit encourages. `todo`, `scratchpad`,
 * `verify-before-claim`, `context-budget`, etc. all inject
 * their own hints, but when the active model is small those hints
 * compete with every other signal in the system prompt and get tuned
 * out. This extension closes the gap by appending a short, directive
 * reminder block to the system prompt on every turn - only when the
 * active model matches a configured provider or model id.
 *
 * How it fires:
 *
 *   1. On `before_agent_start` we check `ctx.model` against the
 *      configured `providers` / `models` allow-list.
 *   2. If the model matches, we append the addendum text to
 *      `event.systemPrompt` and return the new string. Pi chains
 *      `systemPrompt` results across `before_agent_start` handlers, so
 *      we play nicely with anything else that also rewrites the prompt.
 *   3. The status widget shows "✓ active" so the user can see the
 *      extension is doing something. When the extension is installed
 *      but the current model doesn't match, status shows nothing.
 *
 * Config (optional JSONC) at
 * `~/.pi/agent/small-model-addendum.json` and project
 * `.pi/small-model-addendum.json`:
 *
 *   {
 *     "providers": ["llama-cpp"],
 *     "models": ["llama-cpp/qwen3-6-35b-a3b"],
 *     "text": "## Reminders\n- Do the thing."
 *   }
 *
 * Missing fields fall back to sensible defaults. If both `providers`
 * and `models` are empty the extension is a no-op (installed but
 * silent). The default `text` lives in `./lib/small-model-addendum.ts`
 * and is editable without patching the extension.
 *
 * Environment:
 *   PI_SMALL_MODEL_ADDENDUM_DISABLED=1   skip the extension entirely
 *   PI_SMALL_MODEL_ADDENDUM_DEBUG=1      notify on each injection decision
 */

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  type AddendumConfig,
  appendAddendum,
  type ConfigWarning,
  loadConfig,
  matchesModel,
  type ModelRef,
} from '../../../lib/node/pi/small-model-addendum.ts';

const STATUS_KEY = 'small-model-addendum';

export default function smallModelAddendum(pi: ExtensionAPI): void {
  if (process.env.PI_SMALL_MODEL_ADDENDUM_DISABLED === '1') return;

  const debug = process.env.PI_SMALL_MODEL_ADDENDUM_DEBUG === '1';

  // Lazy config load - cached per-session. The config files are small
  // and rarely change; we reload on session_start to pick up edits
  // without requiring `/reload`.
  let cached: { config: AddendumConfig; warnings: ConfigWarning[] } | undefined;
  let lastNotifiedWarnings = new Set<string>();

  const getConfig = (cwd: string): AddendumConfig => {
    if (!cached) cached = loadConfig(cwd);
    return cached.config;
  };

  const surfaceWarnings = (ctx: ExtensionContext): void => {
    if (!cached) return;
    for (const w of cached.warnings) {
      const key = `${w.path}:${w.error}`;
      if (lastNotifiedWarnings.has(key)) continue;
      lastNotifiedWarnings.add(key);
      ctx.ui.notify(`small-model-addendum: failed to load ${w.path}: ${w.error}`, 'warning');
    }
  };

  const clearStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined as unknown as string);
  };

  pi.on('session_start', (_event, ctx) => {
    // Force reload on each session_start so edits to the config files
    // are picked up on /new, /resume, /fork, /reload.
    cached = undefined;
    lastNotifiedWarnings = new Set();
    const config = getConfig(ctx.cwd);
    surfaceWarnings(ctx);
    // Touch config once so we surface warnings even if no agent turn
    // has happened yet.
    void config;
  });

  pi.on('before_agent_start', (event, ctx) => {
    const config = getConfig(ctx.cwd);
    surfaceWarnings(ctx);

    const model = ctx.model as ModelRef | undefined;
    if (!matchesModel(model, config)) {
      clearStatus(ctx);
      if (debug) {
        const label = model ? `${model.provider ?? '?'}/${model.id ?? '?'}` : 'no model';
        ctx.ui.notify(`small-model-addendum: skip (${label} not in allow-list)`, 'info');
      }
      return undefined;
    }

    const base = (event as { systemPrompt?: string }).systemPrompt ?? ctx.getSystemPrompt();
    const next = appendAddendum(base, config.text);

    ctx.ui.setStatus(STATUS_KEY, '✓ small-model addendum active');

    if (debug) {
      ctx.ui.notify(
        `small-model-addendum: appended ${config.text.length} chars for ${model?.provider}/${model?.id}`,
        'info',
      );
    }

    return { systemPrompt: next };
  });

  pi.on('session_shutdown', () => {
    cached = undefined;
    lastNotifiedWarnings = new Set();
  });
}
