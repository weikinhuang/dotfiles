/**
 * Shared child-session wiring for the `roleplay` extension's one-shot
 * subagents (summarizer, scene-event generator, fact / timeline
 * extractors). Every one of them resolved its agent the same way, built the
 * same persisted-or-in-memory child `SessionManager`, and fed the same
 * `runOneShotAgent` deps; this module owns that shape once.
 *
 * Lives under `ext/` because it imports the pi runtime (`SessionManager`,
 * `DefaultResourceLoader`, `getAgentDir`, `parseFrontmatter`).
 */

import { type Model } from '@earendil-works/pi-ai';
import { DefaultResourceLoader, getAgentDir, parseFrontmatter, SessionManager } from '@earendil-works/pi-coding-agent';

import { createAgentGateFactory } from '../subagent/agent-gate.ts';
import { type AgentDef, defaultAgentLayers, loadAgents, type ReadLayer } from '../subagent/loader.ts';
import { createPersistedSubagentSessionManager } from '../subagent/session-dir.ts';
import { type ModelRegistryLike, runOneShotAgent } from '../subagent/spawn.ts';
import { piCreateAgentSession } from './pi-session.ts';

/**
 * Persisted child-session manager under the parent's subagent tree, falling
 * back to in-memory when the parent is untracked (`--no-session`). The
 * fallback is non-load-bearing: an untracked parent must not block the
 * side-write; we lose the child transcript, not the result.
 */
export function roleplayChildSessionManager(
  parentSessionManager: unknown,
  extensionLabel: string,
  cwd: string,
): SessionManager {
  try {
    return createPersistedSubagentSessionManager<SessionManager>({
      parentSessionManager: parentSessionManager as never,
      extensionLabel,
      cwd,
      SessionManager,
    });
  } catch {
    return SessionManager.inMemory(cwd);
  }
}

/** Resolve one agent by name from the default layers (global / user / project). `null` when missing or on error. */
export function loadRoleplayAgent(opts: {
  name: string;
  extensionDir: string;
  cwd: string;
  knownToolNames: ReadonlySet<string>;
  fs: ReadLayer;
}): AgentDef | null {
  try {
    const load = loadAgents({
      layers: defaultAgentLayers({ extensionDir: opts.extensionDir, cwd: opts.cwd }),
      knownToolNames: opts.knownToolNames,
      fs: opts.fs,
      parseFrontmatter,
    });
    return load.agents.get(opts.name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Inline gate factory pinning the agent's frontmatter `requestOptions` (its
 * sampler) onto the child's provider request. `runOneShotAgent` loads the
 * child with noExtensions, so this is the only way the sampler applies.
 * `null` when the agent declares no request options.
 */
export function requestOptionsGateFactory(agent: AgentDef): ReturnType<typeof createAgentGateFactory> | null {
  if (!agent.requestOptions) return null;
  return createAgentGateFactory({
    config: {
      name: agent.name,
      bashAllow: [],
      bashDeny: [],
      resolvedWriteRoots: [],
      requestOptions: agent.requestOptions,
    },
    enforceWriteRoots: false,
    resolveAbsolute: (_cwd, p) => p,
  });
}

export interface RoleplayChildRunArgs {
  /** Subagent session-dir label (e.g. `roleplay-summarize`). */
  extensionLabel: string;
  /** Parent `ctx.sessionManager`, used to anchor the persisted child transcript. */
  parentSessionManager: unknown;
  cwd: string;
  agent: AgentDef;
  model: Model<any>;
  task: string;
  modelRegistry: ModelRegistryLike<Model<any>>;
  /** Pin the agent's `requestOptions` via {@link requestOptionsGateFactory}. */
  pinRequestOptions: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RoleplayChildRunResult {
  finalText: string;
  stopReason: string;
  errorMessage?: string;
}

/** Run one roleplay child agent with a persisted transcript. Throws whatever `runOneShotAgent` throws. */
export async function runRoleplayChild(args: RoleplayChildRunArgs): Promise<RoleplayChildRunResult> {
  const gateFactory = args.pinRequestOptions ? requestOptionsGateFactory(args.agent) : null;
  const result = await runOneShotAgent({
    deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
    cwd: args.cwd,
    agent: args.agent,
    model: args.model,
    task: args.task,
    modelRegistry: args.modelRegistry as never,
    agentDir: getAgentDir(),
    sessionManager: roleplayChildSessionManager(args.parentSessionManager, args.extensionLabel, args.cwd),
    ...(gateFactory ? { extensionFactories: [gateFactory as never] } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  });
  return {
    finalText: result.finalText,
    stopReason: result.stopReason,
    ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
  };
}
