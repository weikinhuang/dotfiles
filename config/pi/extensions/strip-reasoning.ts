/**
 * strip-reasoning extension for pi.
 *
 * Drops plain-text `thinking` blocks from assistant history before each LLM
 * call, for models on an explicit allowlist. A non-destructive overlay: the
 * `context`-hook output is ephemeral, so the full reasoning stays in the session
 * .jsonl and the TUI scrollback - the model is just sent less.
 *
 * OPT-IN, default no-op. Stripping applies ONLY to models listed in
 * `strip-reasoning.json` (project `.pi/` over user `<agentDir>/`). The case
 * where no model is listed - and where the config is absent - is left untouched.
 * Real signed thinking (Anthropic / encrypted reasoning) is preserved per-block,
 * so listing such a model is a no-op rather than a broken request.
 *
 * Decision logic + config loader live in `lib/node/pi/strip-reasoning.ts` and are
 * unit-tested without the pi runtime.
 *
 * Environment:
 *   PI_STRIP_REASONING_DISABLED=1   skip the extension entirely.
 *
 * Config (`strip-reasoning.json`):
 *   { "models": ["llama-cpp/gemma4-31b", "gemma4-31b"], "keepLast": 1 }
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import {
  loadStripReasoningConfig,
  type ReasoningMessage,
  shouldStripForModel,
  stripReasoning,
} from '../../../lib/node/pi/strip-reasoning.ts';

export default function stripReasoningExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_STRIP_REASONING_DISABLED)) return;

  pi.on('context', async (event, ctx) => {
    const messages = (event as unknown as { messages?: ReasoningMessage[] }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;

    const cwd = (ctx as ExtensionContext & { cwd?: string }).cwd ?? process.cwd();
    const config = loadStripReasoningConfig(cwd);
    if (config.models.length === 0) return undefined; // default: no change

    const model = (ctx as { model?: { id?: string; provider?: string } }).model;
    if (!shouldStripForModel(config.models, model?.id, model?.provider)) return undefined;

    const out = stripReasoning(messages, config.keepLast);
    return out === messages ? undefined : { messages: out as never };
  });
}
