/**
 * reminder-primer - teach non-Claude models the `<system-reminder>`
 * convention via a short, static system-prompt addendum.
 *
 * Why
 * ───
 * todo, scratchpad, bg-bash, context-budget, and roleplay splice an
 * ephemeral `<system-reminder id="…">…</system-reminder>` block into the
 * last user / toolResult message every turn (see
 * `lib/node/pi/context-reminder.ts`). Claude models are trained to read
 * that framing as ephemeral, harness-authored current-state context. A
 * non-Claude model has no such prior: it still reads the text, but can
 * misattribute authorship - treating injected state as a user instruction
 * to act on. This extension supplies the missing prior as a one-time,
 * static system-prompt primer.
 *
 * How it fires
 * ────────────
 *   1. On `before_agent_start` we resolve config and check `ctx.model`.
 *   2. In the default `auto` mode we inject UNLESS the model is a Claude /
 *      Anthropic model (which already knows the convention), detected by
 *      `claude` / `anthropic` in the provider or id - robust to Claude
 *      served via openrouter / bedrock / vertex. `always` / `never`
 *      override the gate.
 *   3. We append the primer to `event.systemPrompt` and return it. Pi
 *      chains `systemPrompt` results across `before_agent_start` handlers,
 *      so we compose with small-model-addendum and anything else.
 *
 * Cache safety: the primer is constant, so it lives in the cached
 * system-prompt prefix and never busts it (unlike the per-turn reminders
 * it explains, which is precisely why those go through the `context` hook,
 * not the system prompt).
 *
 * Config (optional JSONC) at `~/.pi/agent/reminder-primer.json` and
 * project `.pi/reminder-primer.json`:
 *
 *   {
 *     "mode": "auto",          // "auto" | "always" | "never"
 *     "text": "## ...\n- ..."  // override the default primer wording
 *   }
 *
 * Environment:
 *   PI_REMINDER_PRIMER_DISABLED=1   skip the extension entirely
 *   PI_REMINDER_PRIMER_DEBUG=1      notify on each injection decision
 *
 * See reminder-primer.md for the full reference.
 */

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import {
  appendPrimer,
  type ConfigWarning,
  loadConfig,
  type ModelRef,
  type PrimerConfig,
  shouldInjectPrimer,
} from '../../../lib/node/pi/reminder-primer.ts';

const STATUS_KEY = 'reminder-primer';

export default function reminderPrimer(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_REMINDER_PRIMER_DISABLED)) return;

  const debug = envTruthy(process.env.PI_REMINDER_PRIMER_DEBUG);

  // Lazy config load - cached per-session, reloaded on session_start so
  // edits to the config files are picked up without `/reload`.
  let cached: { config: PrimerConfig; warnings: ConfigWarning[] } | undefined;
  const warnings = createNotifyOnce<ConfigWarning>({
    tag: 'reminder-primer',
    keyOf: (w) => `${w.path}:${w.error}`,
    render: (w, tag) => `${tag}: failed to load ${w.path}: ${w.error}`,
  });

  const getConfig = (cwd: string): PrimerConfig => {
    cached ??= loadConfig(cwd);
    return cached.config;
  };

  const surfaceWarnings = (ctx: ExtensionContext): void => {
    if (!cached) return;
    warnings.surface(ctx.ui.notify.bind(ctx.ui), cached.warnings);
  };

  const clearStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  pi.on('session_start', (_event, ctx) => {
    cached = undefined;
    warnings.reset();
    getConfig(ctx.cwd);
    surfaceWarnings(ctx);
  });

  pi.on('before_agent_start', (event, ctx) => {
    const config = getConfig(ctx.cwd);
    surfaceWarnings(ctx);

    const model = ctx.model as ModelRef | undefined;
    if (!shouldInjectPrimer(model, config)) {
      clearStatus(ctx);
      if (debug) {
        const label = model ? `${model.provider ?? '?'}/${model.id ?? '?'}` : 'no model';
        ctx.ui.notify(`reminder-primer: skip (mode=${config.mode}, ${label})`, 'info');
      }
      return undefined;
    }

    const base = (event as { systemPrompt?: string }).systemPrompt ?? ctx.getSystemPrompt();
    const next = appendPrimer(base, config.text);

    ctx.ui.setStatus(STATUS_KEY, '✓ reminder primer active');

    if (debug) {
      const label = model ? `${model.provider ?? '?'}/${model.id ?? '?'}` : 'no model';
      ctx.ui.notify(`reminder-primer: appended ${config.text.length} chars for ${label}`, 'info');
    }

    return { systemPrompt: next };
  });

  pi.on('session_shutdown', () => {
    cached = undefined;
    warnings.reset();
  });
}
