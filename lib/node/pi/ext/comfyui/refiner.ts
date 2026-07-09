/**
 * Agent-driven, opt-in auto-refine critic wiring for the comfyui
 * extension. Lives under `ext/` because it imports the pi runtime
 * (subagent spawn, `SessionManager`, the `createAgentSession` adapter)
 * and the pi `Model` type (for the vision-capability gate). The pure
 * refine engine - critic contract, decision parse, task builder, model
 * resolution, the reducer, and the `createRefiner` factory - stays in
 * `../../comfyui/refine.ts`.
 *
 * This is the mirror image of `./enhancer.ts`: enhance improves the
 * INPUT (prompt -> protocol) before a render; auto-refine judges the
 * OUTPUT (the pixels) after it. Same opt-in / best-effort / graceful
 * no-op contract.
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

import { createRefiner, type Refiner, resolveRefineModel } from '../../comfyui/refine.ts';
import type { ComfyuiConfig, WorkflowConfig } from '../../comfyui/types.ts';
import { envTruthy } from '../../parse-env.ts';
import { type AgentDef, defaultAgentLayers, loadAgents, makeNodeReadLayer } from '../../subagent/loader.ts';
import { createPersistedSubagentSessionManager } from '../../subagent/session-dir.ts';
import { adaptCreateAgentSession, runOneShotAgent } from '../../subagent/spawn.ts';
import { readGuidanceFiles } from './guidance.ts';

// Bridge pi's concrete `createAgentSession` (typed with the concrete
// `ModelRegistry` class) to the pi-free structural registry the
// `runOneShotAgent` helper consumes. Compatible at runtime; the adapter
// just casts the registry at the call. Mirrors enhancer.ts / roleplay.
const piCreateAgentSession = adaptCreateAgentSession<Model<any>, SessionManager, ModelRegistry, ResourceLoader>(
  createAgentSession,
);

/**
 * A model can host the vision critic only when it accepts image input
 * (the critic `read`s a PNG, which auto-attaches). The flag lives on the
 * pi `Model` type, so the gate is applied here, in `ext/`, and injected
 * into the pure `createRefiner` factory.
 */
const isVisionModel = (model: Model<any>): boolean => model.input.includes('image');

export interface RefinerAccess {
  /** True when the `comfyui-critic` subagent def is installed for `cwd`. */
  isAgentInstalled: (cwd: string) => boolean;
  /**
   * Lazily build (and process-cache) the refiner, or null when disabled
   * (`PI_COMFYUI_DISABLE_REFINE`) or the agent def is unavailable. Cached
   * with the first `ctx` it is built from, matching the enhancer shell.
   */
  getRefiner: (ctx: ExtensionContext) => Refiner<Model<any>> | null;
}

/**
 * Build the refiner accessor. `loadConfig` is injected so this module
 * stays decoupled from the shell's shipped-workflow defaulting, exactly
 * like {@link createEnhancerAccess}.
 */
export function createRefinerAccess(deps: {
  pi: ExtensionAPI;
  extDir: string;
  loadConfig: (cwd: string) => ComfyuiConfig;
}): RefinerAccess {
  const { pi, extDir, loadConfig } = deps;

  // Filesystem read layer for loading the `comfyui-critic` subagent def
  // (shared between the registration-time availability check and the lazy
  // per-session refiner build below).
  const readLayer = makeNodeReadLayer();
  const loadCriticAgent = (forCwd: string): AgentDef | null => {
    try {
      const layers = defaultAgentLayers({ extensionDir: extDir, cwd: forCwd });
      const load = loadAgents({
        layers,
        knownToolNames: new Set(pi.getAllTools().map((t) => t.name)),
        fs: readLayer,
        parseFrontmatter,
      });
      return load.agents.get('comfyui-critic') ?? null;
    } catch {
      return null;
    }
  };

  // Lazily built on first use and reused for the process. A missing
  // `comfyui-critic` agent (or the env kill-switch) leaves it null, in
  // which case auto-refine silently no-ops and the raw render is used.
  let refiner: Refiner<Model<any>> | null = null;
  let refinerInit = false;

  const refineSessionManager = (ctx: ExtensionContext, childCwd: string): SessionManager => {
    try {
      return createPersistedSubagentSessionManager<SessionManager>({
        parentSessionManager: ctx.sessionManager,
        extensionLabel: 'comfyui-critic',
        cwd: childCwd,
        SessionManager,
      });
    } catch {
      return SessionManager.inMemory(childCwd);
    }
  };

  const getRefiner = (ctx: ExtensionContext): Refiner<Model<any>> | null => {
    if (refinerInit) return refiner;
    refinerInit = true;
    if (envTruthy(process.env.PI_COMFYUI_DISABLE_REFINE)) {
      refiner = null;
      return refiner;
    }
    try {
      const config = loadConfig(ctx.cwd);
      const agent = loadCriticAgent(ctx.cwd);
      refiner = createRefiner<Model<any>>({
        settings: resolveRefineModel(config.refineModel),
        criticAgent: agent,
        isVisionModel,
        ...(config.refineTimeoutMs !== undefined ? { timeoutMs: config.refineTimeoutMs } : {}),
        runOneShot: async (args) => {
          const result = await runOneShotAgent({
            deps: { createAgentSession: piCreateAgentSession, DefaultResourceLoader, SessionManager, getAgentDir },
            cwd: args.cwd,
            agent: args.agent,
            model: args.model,
            task: args.task,
            modelRegistry: args.modelRegistry,
            agentDir: getAgentDir(),
            sessionManager: refineSessionManager(ctx, args.cwd),
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
          // `debug` is the success / critiqued-OK channel - only surface it
          // when the user opts in, so normal renders stay quiet. `info` /
          // `warn` are real problems (aborts, timeouts, parse failures, no
          // vision model) and always notify.
          if (level === 'debug' && !envTruthy(process.env.PI_COMFYUI_REFINE_DEBUG)) return;
          try {
            ctx.ui.notify(`comfyui refine: ${message}`, level === 'warn' ? 'warning' : 'info');
          } catch {
            /* notify is best-effort */
          }
        },
      });
    } catch {
      refiner = null;
    }
    return refiner;
  };

  return {
    isAgentInstalled: (cwd: string) => loadCriticAgent(cwd) !== null,
    getRefiner,
  };
}

/**
 * Read + concatenate refine-critic guidance: the global
 * {@link ComfyuiConfig.refineGuidanceFile} first, then the workflow's own
 * {@link WorkflowConfig.refineGuidanceFile}. Each path resolves like a
 * workflow `file` (`~` / absolute / relative-to-cwd). A missing or
 * unreadable file is skipped silently - guidance is advisory and must never
 * block a render. Mirrors {@link ../enhancer.readGuidanceText} on the output
 * side.
 */
export function readRefineGuidanceText(config: ComfyuiConfig, wf: WorkflowConfig, fromCwd: string): string {
  return readGuidanceFiles([config.refineGuidanceFile, wf.refineGuidanceFile], fromCwd);
}
