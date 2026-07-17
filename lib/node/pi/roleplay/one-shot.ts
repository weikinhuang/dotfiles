/**
 * Shared scaffolding for the `roleplay` extension's one-shot subagent
 * adapters (`summarize.ts`, `event.ts`, and future siblings).
 *
 * Both the auto-summarizer and the scene-event generator resolve a child
 * model from the same three-file cascade and then run a single one-shot
 * subagent with identical model-resolution + spawn + stop-reason handling.
 * That duplicated settings resolver and adapter body live here so a change
 * to either lands in one place. Each caller keeps its own validation and
 * enable/disable contract on top.
 *
 * No pi imports (only the pi-free `resolveChildModel` / `ModelRegistryLike`
 * types from `../subagent/spawn.ts`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { parseModelSpec } from '../model-spec.ts';
import { piAgentDir, piProjectPath } from '../pi-paths.ts';
import { isRecord } from '../shared.ts';
import { type AgentDef } from '../subagent/loader.ts';
import { agentWithResolvedThinking, resolveChildModel, type ModelRegistryLike } from '../subagent/spawn.ts';

// ──────────────────────────────────────────────────────────────────────
// Child-model settings resolution
// ──────────────────────────────────────────────────────────────────────

export interface RoleplayChildModel {
  /** Resolved model spec of the form `provider/model-id`. */
  model: string;
  /** Which file produced the winning value - useful for diagnostics. */
  source: string;
}

export interface ResolveRoleplayChildModelOpts {
  cwd: string;
  /** Override for `~` - lets tests point at a temp home. Defaults to `os.homedir()`. */
  home?: string;
  /** Settings field name, e.g. `summarizeModel` / `eventModel`. */
  key: string;
  /** Standalone override filename, e.g. `roleplay-summarize.json`. */
  filename: string;
}

function parseChildModelSpec(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseModelSpec(raw);
  return parsed ? `${parsed.provider}/${parsed.modelId}` : null;
}

/**
 * Resolve a roleplay child-model setting from, in order:
 *
 *   1. `<cwd>/.pi/<filename>` - `{[key]: "…"}` or a bare string.
 *   2. `<piAgentDir>/<filename>` - same shape.
 *   3. `<piAgentDir>/settings.json` - under `roleplay.<key>`.
 *
 * First hit wins. Returns `null` when none resolve a non-empty
 * `provider/model` string.
 */
export function resolveRoleplayChildModelSettings(opts: ResolveRoleplayChildModelOpts): RoleplayChildModel | null {
  const home = opts.home ?? homedir();
  const agentDir = piAgentDir(process.env, home);
  const candidates: { path: string; extract: (v: unknown) => unknown }[] = [
    {
      path: piProjectPath(opts.cwd, opts.filename),
      extract: (v) => (isRecord(v) ? v[opts.key] : v),
    },
    {
      path: join(agentDir, opts.filename),
      extract: (v) => (isRecord(v) ? v[opts.key] : v),
    },
    {
      path: join(agentDir, 'settings.json'),
      extract: (v) => {
        if (!isRecord(v)) return undefined;
        const roleplay = v.roleplay;
        if (!isRecord(roleplay)) return undefined;
        return roleplay[opts.key];
      },
    },
  ];

  for (const candidate of candidates) {
    const body = readJsoncOrUndefined(candidate.path);
    if (body === undefined) continue;
    const value = parseChildModelSpec(candidate.extract(body));
    if (value !== null) return { model: value, source: candidate.path };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// One-shot subagent adapter factory
// ──────────────────────────────────────────────────────────────────────

/** Result of a one-shot subagent run, as returned by `runOneShotAgent`. */
export interface OneShotRunResult {
  finalText: string;
  /** One of `completed | max_turns | aborted | error`. */
  stopReason: string;
  errorMessage?: string;
}

/**
 * Shim over `runOneShotAgent` - tests replace this with a mock that returns
 * scripted `OneShotRunResult` values without spawning anything. Production
 * wires through `subagent/spawn.runOneShotAgent`.
 */
export type OneShotRunner<M> = (args: {
  cwd: string;
  agent: AgentDef;
  model: M;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<OneShotRunResult>;

/** Structural parent-context the adapter needs to spawn a child. */
export interface OneShotContext<M> {
  cwd: string;
  /** Parent's current model - inherited when the caller passes no override. */
  model: M | undefined;
  modelRegistry: ModelRegistryLike<M> & { authStorage: unknown };
  /** Parent turn / compaction signal. */
  signal?: AbortSignal;
}

export interface OneShotAdapterWiring<M> {
  agent: AgentDef;
  /** One-shot spawner. Usually `runOneShotAgent` wrapped. */
  runOneShot: OneShotRunner<M>;
  /** Per-call agent timeout, in ms. */
  timeoutMs: number;
  /** Prefix for diagnostic messages, e.g. `summarizer` / `event`. */
  label: string;
  /** Optional diagnostic sink - non-fatal errors are reported here. */
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface OneShotSubagentAdapter<M> {
  /**
   * Resolve the child model (honouring `override`, else the parent's), spawn
   * once, and return the run's `finalText` on a `completed` stop, or `null`
   * on ANY failure (empty task, model-resolution failure, spawn throw,
   * non-`completed` stop). Validating / capping the text is the caller's job.
   */
  run(ctx: OneShotContext<M>, task: string, override?: string): Promise<string | null>;
}

function report(
  log: ((level: 'info' | 'warn', message: string) => void) | undefined,
  level: 'info' | 'warn',
  message: string,
): void {
  if (!log) return;
  try {
    log(level, message);
  } catch {
    /* swallow - diagnostics never break the adapter */
  }
}

export function createOneShotSubagentAdapter<M>(wiring: OneShotAdapterWiring<M>): OneShotSubagentAdapter<M> {
  return {
    async run(ctx, task, override) {
      if (task.trim().length === 0) return null;

      const resolution = resolveChildModel({
        override,
        agent: wiring.agent,
        parent: ctx.model,
        modelRegistry: ctx.modelRegistry,
      });
      if (!resolution.ok) {
        report(wiring.log, 'info', `${wiring.label} model resolution failed: ${resolution.error}`);
        return null;
      }

      // A thinking-level suffix on the model override (e.g. `:off`)
      // overrides the agent def's own thinkingLevel for this run.
      const runAgent = agentWithResolvedThinking(wiring.agent, resolution.thinkingLevel);

      let result: OneShotRunResult;
      try {
        result = await wiring.runOneShot({
          cwd: ctx.cwd,
          agent: runAgent,
          model: resolution.model,
          modelRegistry: ctx.modelRegistry,
          task,
          signal: ctx.signal,
          timeoutMs: wiring.timeoutMs,
        });
      } catch (e) {
        report(wiring.log, 'info', `${wiring.label} spawn error: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      if (result.stopReason !== 'completed') {
        report(
          wiring.log,
          'info',
          `${wiring.label} stop=${result.stopReason}: ${result.errorMessage ?? '(no message)'}`,
        );
        return null;
      }

      return result.finalText;
    },
  };
}
