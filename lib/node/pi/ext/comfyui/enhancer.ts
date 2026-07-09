/**
 * Agent-driven, opt-in prompt enhancer wiring for the comfyui extension.
 * Lives under `ext/` because it imports the pi runtime (subagent spawn,
 * `SessionManager`, the `createAgentSession` adapter). The pure enhancer
 * engine (model resolution, task building, output parsing) stays in
 * `../../comfyui/enhance.ts`.
 */

import type { Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ModelRegistry,
  parseFrontmatter,
  type ResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { createEnhancer, type Enhancer, resolveEnhanceModel } from '../../comfyui/enhance.ts';
import type { ComfyuiConfig, WorkflowConfig } from '../../comfyui/types.ts';
import { envTruthy } from '../../parse-env.ts';
import { type AgentDef, defaultAgentLayers, loadAgents, makeNodeReadLayer } from '../../subagent/loader.ts';
import { createPersistedSubagentSessionManager } from '../../subagent/session-dir.ts';
import { adaptCreateAgentSession, runOneShotAgent } from '../../subagent/spawn.ts';
import { readGuidanceFiles } from './guidance.ts';

// Bridge pi's concrete `createAgentSession` (typed with the concrete
// `ModelRegistry` class) to the pi-free structural registry the
// `runOneShotAgent` helper consumes. Compatible at runtime; the adapter
// just casts the registry at the call. Mirrors roleplay / deep-research.
const piCreateAgentSession = adaptCreateAgentSession<Model<any>, SessionManager, ModelRegistry, ResourceLoader>(
  createAgentSession,
);

export interface EnhancerAccess {
  /** True when the `comfyui-enhance` subagent def is installed for `cwd`. */
  isAgentInstalled: (cwd: string) => boolean;
  /**
   * Lazily build (and process-cache) the enhancer, or null when disabled
   * (`PI_COMFYUI_DISABLE_ENHANCE`) or the agent def is unavailable. Cached
   * with the first `ctx` it is built from, matching the prior inline shell.
   */
  getEnhancer: (ctx: ExtensionContext) => Enhancer<Model<any>> | null;
}

/**
 * Build the enhancer accessor. `loadConfig` is injected so this module stays
 * decoupled from the shell's shipped-workflow defaulting.
 */
export function createEnhancerAccess(deps: {
  pi: ExtensionAPI;
  extDir: string;
  loadConfig: (cwd: string) => ComfyuiConfig;
}): EnhancerAccess {
  const { pi, extDir, loadConfig } = deps;

  // Filesystem read layer for loading the `comfyui-enhance` subagent def
  // (shared between the registration-time availability check and the lazy
  // per-session enhancer build below).
  const readLayer = makeNodeReadLayer();
  const loadEnhanceAgent = (forCwd: string): AgentDef | null => {
    try {
      const layers = defaultAgentLayers({ extensionDir: extDir, cwd: forCwd });
      const load = loadAgents({
        layers,
        knownToolNames: new Set(pi.getAllTools().map((t) => t.name)),
        fs: readLayer,
        parseFrontmatter,
      });
      return load.agents.get('comfyui-enhance') ?? null;
    } catch {
      return null;
    }
  };

  // Lazily built on first use and reused for the process. A missing
  // `comfyui-enhance` agent (or the env kill-switch) leaves it null, in
  // which case enhancement silently no-ops and the raw prompt is used.
  let enhancer: Enhancer<Model<any>> | null = null;
  let enhancerInit = false;

  const enhanceSessionManager = (ctx: ExtensionContext, childCwd: string): SessionManager => {
    try {
      return createPersistedSubagentSessionManager<SessionManager>({
        parentSessionManager: ctx.sessionManager,
        extensionLabel: 'comfyui-enhance',
        cwd: childCwd,
        SessionManager,
      });
    } catch {
      return SessionManager.inMemory(childCwd);
    }
  };

  const getEnhancer = (ctx: ExtensionContext): Enhancer<Model<any>> | null => {
    if (enhancerInit) return enhancer;
    enhancerInit = true;
    if (envTruthy(process.env.PI_COMFYUI_DISABLE_ENHANCE)) {
      enhancer = null;
      return enhancer;
    }
    try {
      const config = loadConfig(ctx.cwd);
      const agent = loadEnhanceAgent(ctx.cwd);
      enhancer = createEnhancer<Model<any>>({
        settings: resolveEnhanceModel(config.enhanceModel),
        enhanceAgent: agent,
        ...(config.enhanceTimeoutMs !== undefined ? { timeoutMs: config.enhanceTimeoutMs } : {}),
        runOneShot: async (args) => {
          const result = await runOneShotAgent({
            deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
            cwd: args.cwd,
            agent: args.agent,
            model: args.model,
            task: args.task,
            modelRegistry: args.modelRegistry,
            agentDir: getAgentDir(),
            sessionManager: enhanceSessionManager(ctx, args.cwd),
            ...(args.signal ? { signal: args.signal } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          });
          return {
            finalText: result.finalText,
            stopReason: result.stopReason,
            ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
          };
        },
        log: (level, message) => {
          // `debug` is the success / fired-OK channel - only surface it when
          // the user opts in, so normal renders stay quiet. `info` / `warn`
          // are real problems (aborts, timeouts, parse failures) and always
          // notify.
          if (level === 'debug' && !envTruthy(process.env.PI_COMFYUI_ENHANCE_DEBUG)) return;
          try {
            ctx.ui.notify(`comfyui enhance: ${message}`, level === 'warn' ? 'warning' : 'info');
          } catch {
            /* notify is best-effort */
          }
        },
      });
    } catch {
      enhancer = null;
    }
    return enhancer;
  };

  return {
    isAgentInstalled: (cwd: string) => loadEnhanceAgent(cwd) !== null,
    getEnhancer,
  };
}

/**
 * Read + concatenate prompt-enhancer guidance: the global
 * `enhanceGuidanceFile` first, then the workflow's own `guidanceFile`.
 * Each path resolves like a workflow `file` (`~` / absolute /
 * relative-to-cwd). A missing or unreadable file is skipped silently -
 * guidance is advisory and must never block a render.
 */
export function readGuidanceText(config: ComfyuiConfig, wf: WorkflowConfig, fromCwd: string): string {
  return readGuidanceFiles([config.enhanceGuidanceFile, wf.guidanceFile], fromCwd);
}
