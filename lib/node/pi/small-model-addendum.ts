/**
 * Pure helpers for the small-model-addendum extension.
 *
 * No pi imports so this module can be unit-tested under `vitest` without
 * the pi runtime.
 *
 * The extension appends a short, directive reminder block to the system
 * prompt whenever the active model is one we've classified as "small
 * self-hosted" — models like qwen3-30B-A3B or gpt-oss-20B served via
 * llama.cpp / vLLM. They benefit disproportionately from terse,
 * repeated reinforcement of the behaviors our broader toolkit encourages
 * (grep before read, verify before claim, don't loop on the same tool
 * call, skip preambles).
 *
 * This module handles:
 *
 *   - Loading the optional JSONC config from
 *     `~/.pi/agent/small-model-addendum.json` and, if present, the
 *     project-local `.pi/small-model-addendum.json`.
 *   - Deciding whether a given model matches (by provider name and/or
 *     by `provider/id` tuple).
 *   - Rendering the final system prompt by appending the chosen
 *     addendum text with a consistent leading blank-line separator.
 *
 * Config shape (all fields optional):
 *
 *   {
 *     // Providers whose models all get the addendum.
 *     "providers": ["llama-cpp"],
 *     // Specific models in "provider/id" form. Matched in addition to
 *     // any provider-level rule.
 *     "models": ["llama-cpp/qwen3-6-35b-a3b"],
 *     // Override the default addendum text. If omitted we use
 *     // `DEFAULT_ADDENDUM`.
 *     "text": "## Reminders\n- Do the thing."
 *   }
 *
 * Precedence: project config overlays onto global config key-by-key
 * (arrays replace wholesale, `text` replaces). Missing config files are
 * silent. Malformed config files log a single diagnostic to stderr and
 * the file is ignored — the extension never crashes pi.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.ts';

export interface AddendumConfig {
  providers: string[];
  models: string[];
  text: string;
}

/**
 * Loose duck-typed shape of `ctx.model` — we only need `provider` and
 * `id`, and both may legitimately be absent in some ExtensionContext
 * states (e.g. before a model is resolved).
 */
export interface ModelRef {
  provider?: string;
  id?: string;
}

/** Diagnostic emitted when a config file can't be parsed. */
export interface ConfigWarning {
  path: string;
  error: string;
}

/**
 * Default addendum text. Deliberately terse — weak models tune their
 * verbosity to the shape of what they see. Five bullets is enough to
 * reinforce behavior without bloating every turn's system prompt.
 */
export const DEFAULT_ADDENDUM = [
  '## Small-model reminders',
  '',
  '- Prefer `grep -n` plus targeted `read --offset/--limit` over full-file reads.',
  '- After every code change, run a verification step (test / lint / rerun) before claiming done.',
  '- If a tool call fails twice with the same arguments, change the approach — do not retry unchanged.',
  '- Never claim "I\'m done" while `pending`, `in_progress`, or `review` todos remain.',
  '- When an iteration-loop task is active (system prompt shows `## Iteration Loop`), never claim the artifact "looks right / matches the spec / is done" without a passing `check run` verdict this turn — edit, `check run`, read the verdict, repeat.',
  '- Keep responses short. Skip preambles like "Sure, I\'ll help with that."',
].join('\n');

const DEFAULT_CONFIG: AddendumConfig = {
  providers: [],
  models: [],
  text: DEFAULT_ADDENDUM,
};

/**
 * Config loader. Reads up to two files (global + project), merges them,
 * and returns the resolved config plus any parse warnings the caller
 * should surface to the user.
 *
 * A missing file is NOT a warning. An unreadable / malformed file IS.
 */
export function loadConfig(
  cwd: string,
  home: string = homedir(),
): { config: AddendumConfig; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const paths = [
    join(home, '.pi', 'agent', 'small-model-addendum.json'),
    join(cwd, '.pi', 'small-model-addendum.json'),
  ];

  const mergeInto = (base: AddendumConfig, patch: Record<string, unknown>): AddendumConfig => {
    const out: AddendumConfig = {
      providers: base.providers,
      models: base.models,
      text: base.text,
    };
    if (Array.isArray(patch.providers)) {
      out.providers = patch.providers.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
    if (Array.isArray(patch.models)) {
      out.models = patch.models.filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
    if (typeof patch.text === 'string' && patch.text.trim().length > 0) {
      out.text = patch.text;
    }
    return out;
  };

  let merged: AddendumConfig = { ...DEFAULT_CONFIG };
  let anyLoaded = false;

  for (const path of paths) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // missing file → silent
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (e) {
      warnings.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') {
      warnings.push({ path, error: 'config root must be an object' });
      continue;
    }
    merged = mergeInto(merged, parsed as Record<string, unknown>);
    anyLoaded = true;
  }

  // When a user drops in a config with only `providers` / `models` (no
  // `text`), they want the default addendum — which is what
  // DEFAULT_CONFIG.text already is, so no extra handling needed.
  // `anyLoaded` is exposed for tests / debug logging only.
  void anyLoaded;

  return { config: merged, warnings };
}

/**
 * Decide whether `model` should receive the addendum under `config`.
 *
 * Returns false when:
 *   - no model is currently resolved (nothing to decide against), or
 *   - the config has no `providers` or `models` entries at all.
 *
 * Otherwise returns true when either the model's provider is in
 * `config.providers`, or `${provider}/${id}` is in `config.models`.
 */
export function matchesModel(model: ModelRef | undefined, config: AddendumConfig): boolean {
  if (!model) return false;
  if (config.providers.length === 0 && config.models.length === 0) return false;
  const provider = model.provider ?? '';
  if (provider && config.providers.includes(provider)) return true;
  const id = model.id ?? '';
  if (provider && id && config.models.includes(`${provider}/${id}`)) return true;
  return false;
}

/**
 * Append `addendum` to `basePrompt`, separated by a blank line. If
 * `basePrompt` is empty-ish, returns the addendum trimmed. If
 * `basePrompt` already ends with the addendum (indicating a re-entry on
 * the same prompt, which shouldn't happen with pi's chain semantics but
 * is cheap to defend against), returns it unchanged.
 */
export function appendAddendum(basePrompt: string, addendum: string): string {
  const base = basePrompt ?? '';
  const add = (addendum ?? '').trim();
  if (!add) return base;
  if (!base.trim()) return add;
  if (base.trimEnd().endsWith(add)) return base;
  return `${base.replace(/\s+$/, '')}\n\n${add}`;
}
