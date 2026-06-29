/**
 * Pure helpers for the reminder-primer extension.
 *
 * No pi imports so this module can be unit-tested under `vitest` without
 * the pi runtime.
 *
 * Why
 * ───
 * Several extensions (todo, scratchpad, bg-bash, context-budget, roleplay)
 * splice an ephemeral `<system-reminder id="…">…</system-reminder>` block
 * into the LAST user / toolResult message every turn (see
 * `context-reminder.ts`). The `<system-reminder>` framing is a convention
 * Claude / Claude Code models are trained on: they read it as ephemeral,
 * harness-authored current-state context, NOT as something the user said.
 *
 * A non-Claude model (a local llama.cpp / vLLM server, GPT, Gemini, Qwen,
 * …) has no such prior. It still reads the text, but it can misattribute
 * authorship - treating a harness budget line as "the user is asking about
 * the budget", or trying to act on injected state as if it were an
 * instruction. This module supplies the missing prior as a SHORT, STATIC
 * system-prompt primer.
 *
 * Cache safety
 * ────────────
 * The primer is constant - identical bytes every turn - so it sits in the
 * cached system-prompt prefix and never busts it. This is the crucial
 * distinction from the trap `context-reminder.ts` was built to avoid:
 * there it is the per-turn MUTATION of the system prompt that is
 * cache-hostile, not residing in the system prompt per se. A one-time
 * static primer is free after the first request.
 *
 * Gating
 * ──────
 * The convention gap is a property of the MODEL (its training), not the
 * provider / transport: a Claude model served via openrouter or bedrock
 * still has the prior, and a Llama model served via bedrock still lacks
 * it. So we gate on model identity (`claude` / `anthropic` appearing in
 * the provider or id), not on the provider name alone.
 */

import { join } from 'node:path';

import { type ConfigWarning, tryReadJsoncFile } from './jsonc.ts';
import { piAgentDir } from './pi-paths.ts';

/**
 * When to inject the primer:
 *   - `auto`   (default): inject unless the active model is a Claude /
 *              Anthropic model, which already knows the convention.
 *   - `always`: inject regardless of model (e.g. to A/B the wording, or
 *              if a future Claude variant ever needs it).
 *   - `never`:  installed but silent.
 */
export type PrimerMode = 'auto' | 'always' | 'never';

export interface PrimerConfig {
  mode: PrimerMode;
  text: string;
}

/**
 * Loose duck-typed shape of `ctx.model` - we only need `provider` and
 * `id`, and both may legitimately be absent in some ExtensionContext
 * states (e.g. before a model is resolved).
 */
export interface ModelRef {
  provider?: string;
  id?: string;
}

/** Diagnostic emitted when a config file can't be parsed. */
export type { ConfigWarning };

/**
 * Default primer text. Deliberately short - it costs tokens on every
 * request (once, via the cached prefix) and competes with everything else
 * in the system prompt. Four points: what the blocks are, who authored
 * them, that they supersede, and not to echo them.
 */
export const DEFAULT_PRIMER = [
  '## Injected reminders',
  '',
  'Some user and tool-result messages contain',
  '`<system-reminder id="...">...</system-reminder>` blocks. These are NOT written',
  'by the user - they are ephemeral status notices the harness inserts automatically',
  'to show you current state (the active plan, running background jobs, a context',
  'budget line, and similar).',
  '',
  '- Treat their content as authoritative system context, not as a user request to',
  '  act on. A budget reminder is not the user asking you about the budget.',
  '- They are regenerated every turn and may change or vanish; trust the most recent',
  '  block and ignore any earlier copy.',
  '- Do not echo the tags back to the user, and do not mention this mechanism unless',
  '  asked.',
].join('\n');

const DEFAULT_CONFIG: PrimerConfig = {
  mode: 'auto',
  text: DEFAULT_PRIMER,
};

const VALID_MODES: ReadonlySet<string> = new Set<PrimerMode>(['auto', 'always', 'never']);

/**
 * Config loader. Reads up to two files (global + project), merges them,
 * and returns the resolved config plus any parse warnings the caller
 * should surface. A missing file is NOT a warning; an unreadable /
 * malformed one IS, and the file is then ignored (never crashes pi).
 */
export function loadConfig(
  cwd: string,
  agentDir: string = piAgentDir(),
): { config: PrimerConfig; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const paths = [join(agentDir, 'reminder-primer.json'), join(cwd, '.pi', 'reminder-primer.json')];

  const mergeInto = (base: PrimerConfig, patch: Record<string, unknown>): PrimerConfig => {
    const out: PrimerConfig = { mode: base.mode, text: base.text };
    if (typeof patch.mode === 'string' && VALID_MODES.has(patch.mode)) {
      out.mode = patch.mode as PrimerMode;
    }
    if (typeof patch.text === 'string' && patch.text.trim().length > 0) {
      out.text = patch.text;
    }
    return out;
  };

  let merged: PrimerConfig = { ...DEFAULT_CONFIG };
  for (const path of paths) {
    const parsed = tryReadJsoncFile(path, warnings, { requireObject: true });
    if (parsed === undefined) continue;
    merged = mergeInto(merged, parsed as Record<string, unknown>);
  }

  return { config: merged, warnings };
}

/**
 * True when the model already understands the `<system-reminder>`
 * convention from training - i.e. it is a Claude / Anthropic model,
 * however it is routed. Detected by `claude` / `anthropic` appearing in
 * the provider or id (so `openrouter/anthropic/claude-...`,
 * `amazon-bedrock/anthropic.claude-...`, and `anthropic/claude-...` all
 * match). An unknown model (no provider and no id) returns false - we
 * assume it needs the primer.
 */
export function modelKnowsReminders(model: ModelRef | undefined): boolean {
  if (!model) return false;
  const hay = `${model.provider ?? ''}/${model.id ?? ''}`.toLowerCase();
  return hay.includes('claude') || hay.includes('anthropic');
}

/** Decide whether to inject the primer for `model` under `config`. */
export function shouldInjectPrimer(model: ModelRef | undefined, config: PrimerConfig): boolean {
  switch (config.mode) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'auto':
      return !modelKnowsReminders(model);
  }
}

/**
 * Append `primer` to `basePrompt`, separated by a blank line. If `primer`
 * is empty-ish, returns the base unchanged. If `basePrompt` is empty-ish,
 * returns the trimmed primer. If `basePrompt` already ends with the primer
 * (a defensive guard against re-entry on the same prompt), returns it
 * unchanged so the prompt stays byte-stable across turns.
 */
export function appendPrimer(basePrompt: string, primer: string): string {
  const base = basePrompt ?? '';
  const add = (primer ?? '').trim();
  if (!add) return base;
  if (!base.trim()) return add;
  if (base.trimEnd().endsWith(add)) return base;
  return `${base.replace(/\s+$/, '')}\n\n${add}`;
}
