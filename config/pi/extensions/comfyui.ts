/**
 * `comfyui` - a local/remote ComfyUI image-generation tool for pi.
 *
 * Registers a single `generate_image` tool the model can call. The tool
 * loads a named API-format workflow, injects the prompt / seed /
 * dimensions into the nodes named by the workflow's input map, submits
 * it to a ComfyUI server, streams generation progress, fetches the
 * rendered PNG(s), saves them to disk, and returns them inline as
 * multimodal tool results so both the terminal and vision-capable models
 * see the image.
 *
 * This is NOT a replacement for pi's built-in (provider-routed) image
 * generation - it is a custom tool, the same shape pi's own
 * `antigravity-image-gen.ts` example uses, because there is no
 * extension-pluggable image-provider hook.
 *
 * All pure logic (config layering + `${ENV}` interpolation, workflow
 * param injection, URL building, history / websocket parsing) lives under
 * `lib/node/pi/comfyui/` and is unit-tested; this shell is just the pi
 * glue: tool + command registration, the HTTP/websocket calls, and
 * result formatting.
 *
 * Config layers (lowest -> highest): shipped txt2img default ->
 * <piAgentDir>/comfyui.json -> <cwd>/.pi/comfyui.json.
 *
 * The extension auto-disables when neither config file contributes a `workflows`
 * entry. The shipped txt2img.api.json is an example, not a real default, so
 * without user workflows we deregister rather than leak a broken option into the
 * tool list.
 *
 * Environment:
 *   PI_COMFYUI_DISABLED=1   skip the extension entirely
 *   PI_COMFYUI_URL=...      override the configured baseUrl
 *   PI_COMFYUI_TOKEN=...    referenced by a config authHeader as ${PI_COMFYUI_TOKEN}
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
import { StringEnum, type Model } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { COMFYUI_USAGE } from '../../../lib/node/pi/comfyui/usage.ts';
import { DEFAULT_TARGET_PIXELS, resolveAspect } from '../../../lib/node/pi/comfyui/aspect.ts';
import { describeWorkflows } from '../../../lib/node/pi/comfyui/describe.ts';
import { extractModelCatalog, formatModelCatalog } from '../../../lib/node/pi/comfyui/models.ts';
import { emitImageGenerated } from '../../../lib/node/pi/comfyui/events.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';
import {
  loadComfyuiConfig,
  loadUserWorkflowNames,
  resolveAuthHeaders,
  resolveBaseUrl,
  resolveSendToModel,
  SHIPPED_WORKFLOW_INPUTS,
} from '../../../lib/node/pi/comfyui/config.ts';
import {
  extractOutputImages,
  historyHasEntry,
  historyHasError,
  queueHasPrompt,
} from '../../../lib/node/pi/comfyui/api.ts';
import {
  buildInjectedGraph,
  cancelPrompt,
  type Conn,
  createWaker,
  fetchAndSave,
  fetchHistory,
  fetchObjectInfo,
  fetchQueue,
  openProgressSocket,
  pingServer,
  readSavedImages,
  type SavedImage,
  submitPrompt,
  waitForImages,
} from '../../../lib/node/pi/comfyui/client.ts';
import { loadWorkflowGraph, validateMapping } from '../../../lib/node/pi/comfyui/workflow.ts';
import {
  addJob,
  findJob,
  formatJobLine,
  formatRegistry,
  formatRunningBlock,
  type ImageJob,
  type JobRegistry,
  emptyRegistry,
  runningJobs,
  updateJob,
} from '../../../lib/node/pi/comfyui/jobs.ts';
import {
  addGeneration,
  cloneGenerations,
  emptyGenerations,
  findGeneration,
  findGenerationByPrompt,
  formatGallery,
  type GenerationRecord,
  type GenerationRegistry,
  type NewGeneration,
  reduceGenerations,
} from '../../../lib/node/pi/comfyui/generations.ts';
import {
  buildEnhanceTask,
  createEnhancer,
  type Enhancer,
  resolveEnhanceModel,
} from '../../../lib/node/pi/comfyui/enhance.ts';
import type { ComfyuiConfig, WorkflowConfig } from '../../../lib/node/pi/comfyui/types.ts';
import { expandTilde } from '../../../lib/node/pi/path-expand.ts';
import {
  type AgentDef,
  defaultAgentLayers,
  loadAgents,
  makeNodeReadLayer,
} from '../../../lib/node/pi/subagent/loader.ts';
import { createPersistedSubagentSessionManager } from '../../../lib/node/pi/subagent/session-dir.ts';
import { adaptCreateAgentSession, runOneShotAgent } from '../../../lib/node/pi/subagent/spawn.ts';
import { applyContextReminder, type ReminderMessage } from '../../../lib/node/pi/context-reminder.ts';
import { applyDirectives } from '../../../lib/node/pi/context-edit/apply.ts';
import {
  addCollapse,
  cloneState,
  type ContextEditState,
  emptyState as emptyEditState,
  reduceBranch,
} from '../../../lib/node/pi/context-edit/directive.ts';
import type { LooseMessage } from '../../../lib/node/pi/context-edit/target.ts';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

interface GenerateDetails {
  workflow: string;
  seed?: number;
  promptId?: string;
  savedPaths: string[];
  error?: string;
  /** Latest streamed progress line (e.g. "generating 12/30"), shown while the result is partial. */
  progress?: string;
  /** True when the call only submitted the job and returned without waiting. */
  background?: boolean;
  /** Registry id of the background job this call started (when `background`). */
  jobId?: string;
  /** Generation-registry id (`g<n>`) recorded for this render, when it landed on disk. */
  generationId?: string;
  /** True when the render was ephemeral (shown inline, collapsed out of model context). */
  ephemeral?: boolean;
}

/** Action verbs accepted by the `image_jobs` tool. */
type JobsAction = 'list' | 'collect' | 'cancel';

interface JobsDetails {
  action: JobsAction;
  jobId?: string;
  status?: ImageJob['status'];
  savedPaths?: string[];
  error?: string;
  jobs?: ImageJob[];
  /** Generation-registry id (`g<n>`) recorded when this collect landed the render. */
  generationId?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Shipped default workflow (committed at config/pi/comfyui/txt2img.api.json)
// ──────────────────────────────────────────────────────────────────────

const extDir = dirname(fileURLToPath(import.meta.url));

// Bridge pi's concrete `createAgentSession` (typed with the concrete
// `ModelRegistry` class) to the pi-free structural registry the
// `runOneShotAgent` helper consumes. Compatible at runtime; the adapter
// just casts the registry at the call. Mirrors roleplay / deep-research.
const piCreateAgentSession = adaptCreateAgentSession<Model<any>, SessionManager, ModelRegistry, ResourceLoader>(
  createAgentSession,
);

// Hard cap on the best-effort `image_jobs cancel` round-trip (interrupt /
// dequeue). Cancellation should be near-instant, so it gets a tighter
// bound than a full generation's `config.timeoutMs`.
const CANCEL_TIMEOUT_MS = 10_000;

// Custom session-entry type under which the ephemeral-render collapse set
// is persisted. Distinct from tool-collapse's own store so the two
// overlays stay independent. The state is a `ContextEditState` of
// `collapse` directives keyed by the generate_image call's toolCallId;
// it is reduced from the branch on session_start/session_tree (so it
// survives `/reload` + exit->resume) and reapplied each turn in the
// `context` hook.
const EPHEMERAL_CUSTOM_TYPE = 'comfyui-ephemeral-state';

// Custom session-entry type under which the generation registry (every
// render that landed on disk, with a short `g<n>` id) is persisted. Like
// the ephemeral overlay it is rebuilt from the branch on
// session_start/session_tree, so the gallery + `variationOf` / `refine`
// reuse survive `/reload`, a branch switch, and exit->resume.
const GENERATIONS_CUSTOM_TYPE = 'comfyui-generations';

// Only the on-disk path of the shipped example workflow is shell-specific;
// its input map is pure data (SHIPPED_WORKFLOW_INPUTS in lib).
function shippedWorkflow(): WorkflowConfig {
  return { file: join(extDir, '..', 'comfyui', 'txt2img.api.json'), inputs: SHIPPED_WORKFLOW_INPUTS };
}

function loadConfig(cwd: string): ComfyuiConfig {
  return loadComfyuiConfig(cwd, shippedWorkflow());
}

// ──────────────────────────────────────────────────────────────────────
// Tool parameters
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function comfyuiExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_COMFYUI_DISABLED)) return;

  // Registration-time seed only. Registration runs before any session
  // exists, so there is no `ctx` to read `ctx.cwd` from yet - the real
  // session cwd arrives on `session_start` below, where we re-point this.
  // It is used here for two things that can only be decided at
  // registration: the auto-disable gate, and the workflow list baked
  // into the (immutable) tool description. Tool handlers and the command
  // completions re-resolve from `ctx.cwd` / the updated `cwd` instead.
  let cwd = process.cwd();

  // Auto-disable when no user-supplied workflows exist. The shipped txt2img
  // graph (config/pi/comfyui/txt2img.api.json) is an example - it expects a
  // v1-5-pruned-emaonly checkpoint that most servers won't have - so registering
  // the tool with only that available would leak a broken option into the model's
  // tool list. The user has to point at their own workflow in
  // ~/.pi/agent/comfyui.json or <cwd>/.pi/comfyui.json to opt in.
  //
  // This gate is necessarily registration-time: pi has no unregisterTool API,
  // so we cannot register first and back out on `session_start`. It is keyed
  // off the user-global config (cwd-independent) and the project config under
  // the registration-time cwd. A project whose only workflows live under a
  // later `ctx.cwd` that differs from the launch dir would miss this gate, but
  // its handlers still work once that project's config loads at call time.
  if (loadUserWorkflowNames(cwd).length === 0) return;

  const registrationConfig = loadConfig(cwd);
  const workflowNames = Object.keys(registrationConfig.workflows);
  const defaultWorkflow = registrationConfig.defaultWorkflow;
  const workflowList = workflowNames.join(', ') || '(none)';

  // Filesystem read layer for loading the `comfyui-enhance` subagent def
  // (shared between the registration-time matrix hint and the lazy
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

  // Multi-line capability matrix (description / tags / mapped params /
  // image slots / prompt protocol per workflow) baked into the immutable
  // tool description so the model picks the right workflow and stops
  // passing args a workflow does not map. The "recommends enhance" hint is
  // surfaced only when the enhancer agent is actually installed and the
  // env kill-switch is not set, so the model never sees a hint it cannot
  // act on.
  const enhanceAvailableAtReg = !envTruthy(process.env.PI_COMFYUI_DISABLE_ENHANCE) && loadEnhanceAgent(cwd) !== null;
  const workflowMatrix = describeWorkflows(registrationConfig.workflows, defaultWorkflow, {
    enhanceHint: enhanceAvailableAtReg,
  });

  // Background-job registry. In-memory and per-session: ComfyUI owns the
  // actual execution and persists each prompt under its id, so a job is
  // just metadata here. Not persisted to the session branch (unlike
  // bg-bash) - reattaching to a prior runtime's promptId is best handled
  // by re-submitting, and the server's own history outlives us anyway.
  let registry: JobRegistry = emptyRegistry();

  // Ephemeral-render collapse overlay. Holds a `collapse` directive per
  // ephemeral `generate_image` call (keyed by toolCallId); the `context`
  // hook applies it to the OUTGOING provider payload every turn so the
  // image + call never reach the model, while the real session entry
  // keeps the image block for the TUI. Reduced from the branch on
  // session_start/session_tree so it survives `/reload` + resume.
  let ephemeralState: ContextEditState = emptyEditState();
  const persistEphemeral = (): void => {
    try {
      pi.appendEntry(EPHEMERAL_CUSTOM_TYPE, cloneState(ephemeralState));
    } catch {
      // Bookkeeping must never break a generation.
    }
  };

  // Generation registry: every render that landed on disk, addressable by
  // a `g<n>` id for the gallery + `variationOf` / `refine` reuse. Persisted
  // as a full snapshot per mutation (mirrors the ephemeral overlay) and
  // rebuilt from the branch on session_start/session_tree.
  let generationsState: GenerationRegistry = emptyGenerations();
  const persistGenerations = (): void => {
    try {
      pi.appendEntry(GENERATIONS_CUSTOM_TYPE, cloneGenerations(generationsState));
    } catch {
      // Bookkeeping must never break a generation.
    }
  };

  // Record a freshly-landed render, de-duplicating background jobs that a
  // manual `collect` and the auto-download tick could both report by
  // keying on the ComfyUI prompt id. Returns the existing or created
  // record so callers can echo its id. Never throws.
  const recordGeneration = (gen: NewGeneration): GenerationRecord | undefined => {
    if (gen.promptId !== undefined) {
      const existing = findGenerationByPrompt(generationsState, gen.promptId);
      if (existing !== undefined) return existing;
    }
    const added = addGeneration(generationsState, gen);
    generationsState = added.registry;
    persistGenerations();
    return added.created;
  };

  // ── Prompt enhancer (agent-driven, opt-in) ───────────────────────
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

  // Read + concatenate prompt-enhancer guidance: the global
  // `enhanceGuidanceFile` first, then the workflow's own `guidanceFile`.
  // Each path resolves like a workflow `file` (`~` / absolute /
  // relative-to-cwd). A missing or unreadable file is skipped silently -
  // guidance is advisory and must never block a render.
  const readGuidanceText = (config: ComfyuiConfig, wf: WorkflowConfig, fromCwd: string): string => {
    const readOne = (file: string | undefined): string => {
      if (file === undefined || file.trim().length === 0) return '';
      try {
        const resolved = resolve(fromCwd, expandTilde(file, homedir()));
        if (!existsSync(resolved)) return '';
        return readFileSync(resolved, 'utf8').trim();
      } catch {
        return '';
      }
    };
    return [readOne(config.enhanceGuidanceFile), readOne(wf.guidanceFile)].filter((s) => s.length > 0).join('\n\n');
  };

  // Statusline slot (see statusline.ts): show a count of pending jobs and
  // clear the slot when none are running so quiet sessions stay clean.
  let uiRef: ExtensionContext['ui'] | undefined;
  let lastStatusRunning = -1;
  const updateStatusline = (): void => {
    if (!uiRef) return;
    const running = runningJobs(registry).length;
    if (running === lastStatusRunning) return;
    lastStatusRunning = running;
    uiRef.setStatus('comfyui', running > 0 ? `▦ img:${running}` : undefined);
  };

  // ── Background auto-download ──────────────────────────────────────
  // When `autoDownload` is on, an off-turn timer polls `/history` for
  // every running job and fetches its PNG(s) to disk the instant the
  // render finishes - no `image_jobs collect` needed. The file lands on
  // disk either way; auto-download cannot push the image into the model's
  // context (only a model-invoked `collect` can), so a later `collect`
  // re-serves the already-downloaded files from disk.
  //
  // `inFlight` guards a single job from being fetched twice at once - by
  // the timer and a concurrent manual `collect` - which would double-write
  // its output files.
  const inFlight = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  type CollectOutcome =
    | { kind: 'running' }
    | { kind: 'failed'; reason: string }
    | { kind: 'done'; saved: SavedImage[] };

  // One poll of a job's `/history`: returns `done` with fetched+saved
  // images, `failed` (execution error or a prompt the server has dropped),
  // or `running`. Pure of registry mutation - the caller applies the patch.
  const pollJobOnce = async (job: ImageJob, conn: Conn, signal: AbortSignal): Promise<CollectOutcome> => {
    const history = await fetchHistory(conn, job.promptId, signal);
    const refs = extractOutputImages(history, job.promptId);
    if (refs.length === 0) {
      if (historyHasError(history, job.promptId)) {
        return { kind: 'failed', reason: 'ComfyUI reported an execution error (see server log)' };
      }
      // No outputs and no error. Usually still rendering - but if the server
      // has no history entry AND the prompt isn't queued, it is gone
      // (ComfyUI restarted, queue + history wiped); stop polling it.
      if (!historyHasEntry(history, job.promptId)) {
        const queue = await fetchQueue(conn, signal);
        if (!queueHasPrompt(queue, job.promptId)) {
          return {
            kind: 'failed',
            reason: 'prompt is no longer on the server (ComfyUI may have restarted); resubmit to retry',
          };
        }
      }
      return { kind: 'running' };
    }
    const saved = await fetchAndSave(conn, refs, job.saveDir, signal);
    return { kind: 'done', saved };
  };

  const stopPollTimer = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  // Walk every running job once; auto-download the finished ones. Stops the
  // timer when nothing is running or `autoDownload` got turned off, so a
  // quiet session isn't polling forever.
  const autoDownloadTick = async (): Promise<void> => {
    const running = runningJobs(registry);
    if (running.length === 0) {
      stopPollTimer();
      return;
    }
    const config = loadConfig(cwd);
    if (!config.autoDownload) {
      stopPollTimer();
      return;
    }
    const conn: Conn = {
      base: resolveBaseUrl(config),
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    };
    // Poll every job in parallel, but apply the registry patches in a
    // single synchronous pass afterwards: `registry = updateJob(...)`
    // reads-then-reassigns, so concurrent reassignments would lose
    // updates. The `inFlight` guard still serializes any one job against a
    // manual collect.
    const results = await Promise.all(
      running.map(async (job): Promise<{ id: string; outcome: CollectOutcome } | null> => {
        if (inFlight.has(job.id)) return null;
        inFlight.add(job.id);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
        try {
          return { id: job.id, outcome: await pollJobOnce(job, conn, ac.signal) };
        } catch {
          // Best-effort: a transient poll/network failure just retries next tick.
          return null;
        } finally {
          clearTimeout(timer);
          inFlight.delete(job.id);
        }
      }),
    );
    let changed = false;
    for (const r of results) {
      if (!r) continue;
      if (r.outcome.kind === 'done') {
        const donePaths = r.outcome.saved.map((s) => s.savedPath);
        registry = updateJob(registry, r.id, {
          status: 'done',
          savedPaths: donePaths,
          endedAt: Date.now(),
        });
        const doneJob = running.find((j) => j.id === r.id);
        emitImageGenerated({
          savedPaths: donePaths,
          workflow: doneJob?.workflow ?? '',
          prompt: doneJob?.prompt,
          seed: doneJob?.seed,
          background: true,
        });
        if (doneJob) {
          recordGeneration({
            workflow: doneJob.workflow,
            promptId: doneJob.promptId,
            prompt: doneJob.prompt,
            negative: doneJob.negative,
            seed: doneJob.seed,
            savedPaths: donePaths,
            source: 'background',
            createdAt: Date.now(),
          });
        }
        changed = true;
      } else if (r.outcome.kind === 'failed') {
        registry = updateJob(registry, r.id, { status: 'error', error: r.outcome.reason, endedAt: Date.now() });
        changed = true;
      }
    }
    if (changed) updateStatusline();
  };

  const ensurePollTimer = (intervalMs: number): void => {
    if (pollTimer !== undefined) return;
    pollTimer = setInterval(() => {
      void autoDownloadTick();
    }, intervalMs);
    // Never keep the process alive solely for the poll.
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  };
  // Note: the interval is fixed when the timer is first created and is not
  // re-read while it runs. The timer stops itself once no jobs are running
  // (autoDownloadTick), so a `pollIntervalMs` config edit takes effect the
  // next time a background job spins the timer back up - not mid-run.

  pi.on('session_start', (_event, ctx) => {
    // Re-point cwd from the registration-time `process.cwd()` seed to the
    // real session cwd. The `/comfyui workflows` completion resolver
    // closes over `cwd` (completions get no `ctx`), so this keeps it
    // pointed at the session's project config after a `/reload`.
    cwd = ctx.cwd;
    uiRef = ctx.ui;
    lastStatusRunning = -1;
    updateStatusline();
    // Rebuild the ephemeral-render collapse overlay from the persisted
    // branch so `/reload` and exit->resume keep prior ephemeral renders
    // collapsed out of the model's context.
    ephemeralState = reduceBranch(ctx.sessionManager.getBranch() as never, EPHEMERAL_CUSTOM_TYPE);
    generationsState = reduceGenerations(ctx.sessionManager.getBranch() as never, GENERATIONS_CUSTOM_TYPE);
  });

  // A branch switch (edit/rewind) replays a different history, so re-derive
  // the ephemeral overlay + generation registry from the new branch's
  // persisted snapshots.
  pi.on('session_tree', (_event, ctx) => {
    ephemeralState = reduceBranch(ctx.sessionManager.getBranch() as never, EPHEMERAL_CUSTOM_TYPE);
    generationsState = reduceGenerations(ctx.sessionManager.getBranch() as never, GENERATIONS_CUSTOM_TYPE);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // Clear the statusline badge and drop the in-memory job registry so
    // a /reload doesn't leave a stale `▦ img:N` count claiming the slot
    // or surface a prior session's background jobs. ComfyUI owns the
    // actual executions server-side, so dropping our metadata is safe;
    // the user re-collects via the server's own history if needed.
    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus('comfyui', undefined);
      } catch {
        // best-effort: shutdown must never throw.
      }
    }
    registry = emptyRegistry();
    uiRef = undefined;
    lastStatusRunning = -1;
    // Drop the ephemeral overlay + generation registry; session_start
    // rebuilds both from the branch on the next (re)start.
    ephemeralState = emptyEditState();
    generationsState = emptyGenerations();
    // Stop the auto-download poll so a `/reload` doesn't leave an orphaned
    // interval bound to a replaced session, and drop the in-flight guard.
    stopPollTimer();
    inFlight.clear();
  });

  // Refresh the captured UI reference + statusline at every turn start
  // (must run regardless of injection).
  pi.on('before_agent_start', (_event, ctx) => {
    uiRef = ctx.ui;
    updateStatusline();
    return undefined;
  });

  // Remind the model about pending image jobs each turn so even a weak
  // model remembers to collect them. Injected as an ephemeral
  // `<system-reminder id="comfyui-jobs">` spliced into the last
  // user/toolResult turn via the `context` hook (not the system prompt):
  // pi's `context` output is never persisted, so the system-prompt prefix
  // stays byte-stable (the provider's prompt cache survives job churn) and
  // nothing accumulates. No running jobs -> nothing injected.
  pi.on('context', (event) => {
    let messages = event.messages as unknown as LooseMessage[];
    let changed = false;

    // 1. Collapse ephemeral generate_image call+result pairs out of the
    //    outgoing payload. The real session entry keeps the image block
    //    (the TUI renders from it); only this provider copy is stripped,
    //    so the image + call cost no persistent context and the model
    //    never re-reads the scene.
    if (ephemeralState.directives.length > 0) {
      const applied = applyDirectives(messages, ephemeralState.directives);
      if (applied.applied > 0) {
        messages = applied.messages;
        changed = true;
      }
    }

    // 2. Remind the model about pending background jobs so even a weak
    //    model remembers to collect them.
    const block = formatRunningBlock(registry);
    if (block) {
      messages = applyContextReminder(messages as unknown as ReminderMessage[], {
        id: 'comfyui-jobs',
        body: block,
      }) as unknown as LooseMessage[];
      changed = true;
    }

    return changed ? { messages: messages as unknown as typeof event.messages } : undefined;
  });

  const GenerateParams = Type.Object({
    prompt: Type.Optional(
      Type.String({
        description: 'Positive prompt: what to depict. Required unless `variationOf` supplies one to reuse.',
      }),
    ),
    negative: Type.Optional(Type.String({ description: 'Negative prompt: what to avoid.' })),
    variationOf: Type.Optional(
      Type.String({
        description:
          'Reuse a prior generation id (e.g. "g3", from a result line or /comfyui gallery): inherits its workflow, prompt, negative, seed, and dimensions as the baseline, then any param you pass here overrides. Use to iterate on a render.',
      }),
    ),
    refine: Type.Optional(
      Type.String({
        description:
          'Refine a prior generation id (e.g. "g3"): feeds that render\'s saved image as the input of an edit workflow. Set `workflow` to an edit workflow and `prompt` to the edit instruction. Do not also pass `inputImages`.',
      }),
    ),
    workflow: Type.Optional(
      Type.String({ description: `One of: ${workflowList}. Default ${defaultWorkflow}. Do not invent names.` }),
    ),
    width: Type.Optional(Type.Number({ description: 'Output width (px).' })),
    height: Type.Optional(Type.Number({ description: 'Output height (px).' })),
    aspect: Type.Optional(
      Type.String({
        description:
          'Aspect preset that sets width/height, e.g. "16:9", "portrait", "square". Explicit width/height override it. Only for workflows that map width and height.',
      }),
    ),
    steps: Type.Optional(Type.Number({ description: 'Sampler steps.' })),
    cfg: Type.Optional(Type.Number({ description: 'CFG / guidance scale.' })),
    seed: Type.Optional(Type.Number({ description: 'Omit for a random seed; reuse a prior seed to reproduce.' })),
    denoise: Type.Optional(Type.Number({ description: 'Denoise strength 0-1 (img2img).' })),
    inputImages: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Ordered reference image paths for img2img / edit workflows, e.g. ["~/in.png"]. Multi-reference edit workflows fill their slots in order; extra slots beyond the supplied images keep the graph default.',
      }),
    ),
    count: Type.Optional(Type.Number({ description: 'Batch size.' })),
    sendToModel: Type.Optional(
      Type.Boolean({
        description: `Return the image to you for analysis; false = save to disk only. Auto-suppressed for non-vision models. Default ${registrationConfig.sendToModel}.`,
      }),
    ),
    ephemeral: Type.Optional(
      Type.Boolean({
        description: `Show the image in the terminal once, then drop this tool call and image from the conversation so they do NOT stay in context on later turns (you will not re-read the image). Use for visual-novel / roleplay scene renders where the picture is for the user, not for you. Foreground renders only. Default ${registrationConfig.ephemeral}.`,
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description: `Return immediately without waiting; collect later via \`image_jobs\` (collect). Use for slow renders. Default ${registrationConfig.background}.`,
      }),
    ),
    enhance: Type.Optional(
      Type.Boolean({
        description: `Refine prompt + negative into the workflow's native protocol via a helper agent before rendering. Use when a workflow lists "recommends enhance" or you are unsure of its protocol. Default ${registrationConfig.enhance}.`,
      }),
    ),
    context: Type.Optional(
      Type.String({
        description:
          'Background to honor during enhancement (scene, continuity, character facts) without depicting it literally. Only used when enhance is on; ignored otherwise.',
      }),
    ),
  });

  pi.registerTool({
    name: 'generate_image',
    label: 'Generate image',
    description:
      `Generate an image from a prompt via a ComfyUI server and return it inline. ` +
      `Use when the user asks to create, draw, render, or generate a picture. ` +
      `Each workflow bakes in its own checkpoint, sampler, and scheduler; pick one by capability and send the prompt ` +
      `in the protocol it lists. Pass only the params a workflow maps (others error). Available workflows ` +
      `(default ${defaultWorkflow}):\n${workflowMatrix}\n` +
      `The PNG is saved to disk and returned so you can see it.`,
    promptSnippet: `To create or render an image, call \`generate_image\` (workflows: ${workflowList}) instead of describing it in text.`,
    promptGuidelines: [
      "Never call ComfyUI's HTTP API (`/object_info`, `/prompt`, `/view`, …) via bash/curl/anything - `generate_image` is the only entry point; it encapsulates model and sampler choice.",
      'Only pass `inputImages` for img2img / edit workflows.',
    ],
    parameters: GenerateParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);

      const fail = (
        message: string,
      ): { content: { type: 'text'; text: string }[]; details: GenerateDetails; isError: true } => ({
        content: [{ type: 'text', text: message }],
        details: { workflow: params.workflow ?? config.defaultWorkflow, savedPaths: [], error: message },
        isError: true,
      });

      // Resolve generation reuse before picking the workflow. `variationOf`
      // inherits a prior render's workflow + prompt + negative + seed + dims
      // as the baseline (per-call params still override); `refine` feeds a
      // prior render's saved image into an edit workflow as its input.
      if (params.variationOf !== undefined && params.refine !== undefined) {
        return fail('pass either variationOf or refine, not both');
      }
      let reuse: GenerationRecord | undefined;
      if (params.variationOf !== undefined) {
        reuse = findGeneration(generationsState, params.variationOf);
        if (reuse === undefined) return fail(`unknown generation "${params.variationOf}" (see /comfyui gallery)`);
      }
      let refineImage: string | undefined;
      if (params.refine !== undefined) {
        const rec = findGeneration(generationsState, params.refine);
        if (rec === undefined) return fail(`unknown generation "${params.refine}" (see /comfyui gallery)`);
        const src = rec.savedPaths[0];
        if (src === undefined || !existsSync(src)) {
          return fail(`generation "${params.refine}" has no saved image on disk to refine`);
        }
        if (params.inputImages !== undefined && params.inputImages.length > 0) {
          return fail('refine supplies the input image; do not also pass inputImages');
        }
        refineImage = src;
      }

      const name = params.workflow ?? reuse?.workflow ?? config.defaultWorkflow;
      const details: GenerateDetails = { workflow: name, savedPaths: [] };

      const wf = config.workflows[name];
      if (!wf) {
        const known = Object.keys(config.workflows).join(', ') || '(none)';
        details.error = `unknown workflow "${name}"`;
        return {
          content: [{ type: 'text', text: `${details.error}. Configured workflows: ${known}.` }],
          details,
          isError: true,
        };
      }

      // Positive prompt comes from the call, else inherited from variationOf.
      const effectivePrompt = params.prompt ?? reuse?.prompt;
      if (effectivePrompt === undefined || effectivePrompt.trim().length === 0) {
        details.error = 'prompt is required (or pass variationOf to reuse a prior prompt)';
        return { content: [{ type: 'text', text: details.error }], details, isError: true };
      }

      const base = resolveBaseUrl(config);
      const headers = resolveAuthHeaders(config);
      const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };
      const saveDir = isAbsolute(config.saveDir) ? config.saveDir : join(ctx.cwd, config.saveDir);
      const requested = params.sendToModel ?? config.sendToModel;
      const background = params.background ?? config.background;
      // Ephemeral is meaningful only for a foreground render (a background
      // job returns no image to collapse); ignore it when backgrounding.
      const ephemeral = !background && (params.ephemeral ?? config.ephemeral);

      const d = config.defaults;

      // Aspect preset -> width/height. Only meaningful for a workflow that
      // maps both dimensions; erroring on the rest matches the
      // unmapped-arg contract (a clear failure beats a silent no-op). The
      // pixel budget follows the configured default area when set.
      let aspectDims: { width: number; height: number } | undefined;
      if (params.aspect) {
        if (wf.inputs.width === undefined || wf.inputs.height === undefined) {
          details.error = `workflow "${name}" does not support aspect (it maps no width/height)`;
          return { content: [{ type: 'text', text: details.error }], details, isError: true };
        }
        const targetPixels =
          d?.width !== undefined && d?.height !== undefined ? d.width * d.height : DEFAULT_TARGET_PIXELS;
        aspectDims = resolveAspect(params.aspect, targetPixels);
        if (!aspectDims) {
          details.error = `invalid aspect "${params.aspect}" (use e.g. "16:9", "portrait", "square")`;
          return { content: [{ type: 'text', text: details.error }], details, isError: true };
        }
      }

      // Stream a progress line; pi's onUpdate wants a full tool result, so
      // carry the (partial) details alongside the text. Stash the line on
      // details too so renderResult can show it while the result is partial
      // (the result renderer only sees details, not the content text).
      const report = (text: string): void => {
        details.progress = text;
        if (onUpdate) onUpdate({ content: [{ type: 'text', text }], details });
      };

      // Combine the turn's abort signal with the per-generation timeout.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
      if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
      const runSignal = ac.signal;

      // Opt-in prompt enhancement: refine the positive + baseline negative
      // into the workflow's native protocol via the `comfyui-enhance`
      // subagent before building the graph. Best-effort - a missing agent,
      // model-resolution failure, spawn error, or unparseable output keeps
      // the original prompt + baseline negative (the enhancer returns null).
      // The enhanced negative REPLACES the baseline (the agent is told to
      // build on it), matching the configured refine-replace merge.
      let promptForRender = effectivePrompt;
      const baselineNegative = params.negative ?? reuse?.negative ?? d?.negative;
      let enhancedNegative: string | undefined;
      const wantEnhance = params.enhance ?? config.enhance;
      if (wantEnhance) {
        const enh = getEnhancer(ctx);
        if (enh?.isEnabled()) {
          report('enhancing prompt…');
          const task = buildEnhanceTask({
            prompt: effectivePrompt,
            ...(baselineNegative !== undefined ? { negative: baselineNegative } : {}),
            guidance: readGuidanceText(config, wf, ctx.cwd),
            ...(wf.description !== undefined ? { description: wf.description } : {}),
            ...(wf.tags !== undefined ? { tags: wf.tags } : {}),
            ...(wf.promptProtocol !== undefined ? { promptProtocol: wf.promptProtocol } : {}),
            ...(params.context !== undefined ? { context: params.context } : {}),
          });
          const enhanceResult = await enh.enhance(
            {
              cwd: ctx.cwd,
              model: ctx.model,
              modelRegistry: ctx.modelRegistry as never,
              signal: runSignal,
            },
            task,
          );
          if (enhanceResult) {
            promptForRender = enhanceResult.prompt;
            if (enhanceResult.negative !== undefined) enhancedNegative = enhanceResult.negative;
          }
        }
      }
      const enhancedPrompt = promptForRender !== effectivePrompt;

      // Layer the config `defaults` block (and any aspect-derived
      // dimensions) under the per-call params: `param ?? aspect ?? defaults`.
      // The graph builder only injects params that are present, so a default
      // simply pre-fills the param before injection; the workflow-baked graph
      // value stays the final fallback for anything neither the call nor the
      // defaults set. Explicit per-call width/height still win over `aspect`.
      const resolvedParams = {
        ...params,
        prompt: promptForRender,
        negative: enhancedNegative ?? baselineNegative,
        seed: params.seed ?? reuse?.seed,
        width: params.width ?? aspectDims?.width ?? reuse?.width ?? d?.width,
        height: params.height ?? aspectDims?.height ?? reuse?.height ?? d?.height,
        steps: params.steps ?? d?.steps,
        cfg: params.cfg ?? d?.cfg,
        denoise: params.denoise ?? d?.denoise,
        count: params.count ?? d?.count,
        inputImages: refineImage !== undefined ? [refineImage] : params.inputImages,
      };

      // Echo the enhanced prompt so the model knows what was actually
      // rendered (and can reuse it via variationOf). Capped to keep the
      // result line readable. Empty when enhancement was off or no-op'd.
      // Also flag a `context` arg that was supplied with enhancement off
      // (it is only consumed by the enhancer), so the model learns the
      // arg did nothing rather than silently dropping it.
      const enhanceNote =
        (enhancedPrompt ? `\nEnhanced prompt: ${truncate(resolvedParams.prompt, 240)}` : '') +
        (params.context !== undefined && !wantEnhance
          ? '\nNote: `context` was ignored (only used when enhance is on).'
          : '');

      let socket: WebSocket | null = null;
      try {
        const prep = await buildInjectedGraph(conn, wf, name, resolvedParams, ctx.cwd, homedir(), report, runSignal);
        if (prep.error || !prep.graph) {
          details.error = prep.error;
          return {
            content: [{ type: 'text', text: prep.error ?? 'failed to prepare workflow' }],
            details,
            isError: true,
          };
        }
        const seed = prep.seed;
        details.seed = seed;

        const clientId = randomUUID();
        report('submitting to ComfyUI…');
        const promptId = await submitPrompt(conn, prep.graph, clientId, runSignal);
        details.promptId = promptId;
        const seedNote = seed !== undefined ? ` (seed ${seed})` : '';

        // Background: register the job and return without waiting. ComfyUI
        // keeps running it server-side; the model collects it later via
        // `image_jobs`.
        if (background) {
          const added = addJob(registry, {
            promptId,
            workflow: name,
            seed,
            prompt: resolvedParams.prompt,
            negative: resolvedParams.negative,
            saveDir,
            sendToModel: requested,
            startedAt: Date.now(),
          });
          registry = added.registry;
          updateStatusline();
          details.background = true;
          details.jobId = added.created.id;
          // Kick off the off-turn auto-download poll (idempotent if already
          // running) so the PNG lands on disk the moment the render finishes.
          const autoDownload = config.autoDownload;
          if (autoDownload) ensurePollTimer(config.pollIntervalMs);
          const collectHint = autoDownload
            ? `It will auto-download to ${saveDir} when ready; collect it with the image_jobs tool (action collect, id ${added.created.id}) to view it inline.`
            : `Collect it later with the image_jobs tool (action collect, id ${added.created.id}).`;
          const text = `Started background generation [${added.created.id}] via "${name}"${seedNote}. ${collectHint}${enhanceNote}`;
          return { content: [{ type: 'text', text }], details };
        }

        // The socket wakes the poll the instant the render finishes, so a
        // healthy websocket trims the up-to-1s poll-interval latency; the
        // poll stays the source of truth when the socket never connects.
        const waker = createWaker();
        socket = openProgressSocket(conn, clientId, promptId, onUpdate ? report : undefined, runSignal, waker);
        const refs = await waitForImages(conn, promptId, runSignal, waker);

        const saved = await fetchAndSave(conn, refs, saveDir, runSignal);
        for (const s of saved) details.savedPaths.push(s.savedPath);
        emitImageGenerated({
          savedPaths: details.savedPaths,
          workflow: name,
          prompt: resolvedParams.prompt,
          seed: details.seed,
          background: false,
        });

        // Record the landed render in the generation registry so it gets a
        // reusable `g<n>` id (gallery + variationOf / refine). Only store
        // dims the workflow actually maps, so the record reflects what was
        // rendered rather than an ignored default.
        const generation = recordGeneration({
          workflow: name,
          promptId,
          prompt: resolvedParams.prompt,
          negative: resolvedParams.negative,
          seed: details.seed,
          width: wf.inputs.width !== undefined ? resolvedParams.width : undefined,
          height: wf.inputs.height !== undefined ? resolvedParams.height : undefined,
          savedPaths: details.savedPaths,
          source: ephemeral ? 'ephemeral' : 'foreground',
          createdAt: Date.now(),
        });
        if (generation) details.generationId = generation.id;
        const idNote = generation ? ` [${generation.id}]` : '';

        const countNote = `${refs.length} image${refs.length === 1 ? '' : 's'}`;

        // Ephemeral render: keep the image block in the result so the TUI
        // shows it this turn, but record a collapse directive so the
        // `context` hook strips the whole call+image from every outgoing
        // provider payload (this turn's continuation included). The image
        // never reaches the model, so the sendToModel / vision gate is
        // moot here - always attach the block for the terminal.
        if (ephemeral && toolCallId) {
          const r = addCollapse(ephemeralState, toolCallId, 'ephemeral image render', Date.now());
          if (r.ok) {
            ephemeralState = r.state;
            persistEphemeral();
          }
          details.ephemeral = true;
          const summary = `Generated ${countNote}${idNote} via "${name}"${seedNote}. Saved to ${saveDir}. (ephemeral: shown once, not kept in context)`;
          return { content: [{ type: 'text', text: summary }, ...saved.map((s) => s.block)], details };
        }

        const decision = resolveSendToModel(requested, ctx.model?.input);
        if (!decision.send) {
          const why = decision.visionBlocked
            ? ' (active model has no image input; not sent to model)'
            : ' (image not sent to model)';
          const summary = `Generated ${countNote}${idNote} via "${name}"${seedNote}. Saved to ${saveDir}.${why}${enhanceNote}`;
          return { content: [{ type: 'text', text: summary }], details };
        }
        const summary = `Generated ${countNote}${idNote} via "${name}"${seedNote}. Saved to ${saveDir}.${enhanceNote}`;
        return { content: [{ type: 'text', text: summary }, ...saved.map((s) => s.block)], details };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason =
          runSignal.aborted && !(signal?.aborted ?? false) ? `timed out after ${conn.timeoutMs}ms` : message;
        details.error = reason;
        return { content: [{ type: 'text', text: `image generation failed: ${reason}` }], details, isError: true };
      } finally {
        clearTimeout(timer);
        if (socket) {
          try {
            socket.close();
          } catch {
            /* already closing */
          }
        }
      }
    },

    renderCall(args, theme, _context) {
      const prompt = ((args as { prompt?: string }).prompt ?? '').replace(/\s+/g, ' ').trim();
      const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
      const head = theme.fg('toolTitle', theme.bold('generate_image '));
      return new Text(`${head}${theme.fg('dim', preview)}`, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const details = (result.details ?? {}) as Partial<GenerateDetails>;
      if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);

      const n = details.savedPaths?.length ?? 0;
      const seedNote = details.seed !== undefined ? ` · seed ${details.seed}` : '';

      // Background submission: no image yet, just the job handle. Expand
      // (ctrl+o) shows the prompts and seed the same way the foreground
      // path does, since the live result line is all the user gets until
      // the job is collected / auto-downloaded.
      if (details.background) {
        const head = theme.fg('accent', `▶ background [${details.jobId ?? '?'}]`);
        if (!options.expanded) return new Text(`${head}${theme.fg('dim', seedNote)}`, 0, 0);
        const bgArgs = (context.args ?? {}) as { prompt?: string; negative?: string };
        const bgLabel = (text: string): string => theme.fg('dim', text);
        const bgLines = [`${head}${theme.fg('dim', seedNote)}`];
        if (bgArgs.prompt) bgLines.push(`${bgLabel('prompt:   ')}${bgArgs.prompt}`);
        bgLines.push(`${bgLabel('negative: ')}${bgArgs.negative ?? '(workflow default)'}`);
        return new Text(bgLines.join('\n'), 0, 0);
      }

      // Still running: surface the live progress line (e.g. "generating 12/30")
      // streamed over the websocket, or a neutral "working…" if none yet.
      if ((options.isPartial || context.isPartial) && n === 0) {
        const prog = details.progress ?? 'working…';
        return new Text(theme.fg('dim', `⟳ ${prog}${seedNote}`), 0, 0);
      }

      const ephemeralNote = details.ephemeral ? theme.fg('dim', ' · ephemeral') : '';
      const summary = theme.fg('success', `✓ ${n} image${n === 1 ? '' : 's'}${seedNote}`) + ephemeralNote;
      if (!options.expanded) return new Text(summary, 0, 0);

      // Expanded (ctrl+o): show the full positive / negative prompt and paths.
      const args = (context.args ?? {}) as { prompt?: string; negative?: string };
      const label = (text: string): string => theme.fg('dim', text);
      const lines = [summary];
      if (args.prompt) lines.push(`${label('prompt:   ')}${args.prompt}`);
      lines.push(`${label('negative: ')}${args.negative ?? '(workflow default)'}`);
      for (const p of details.savedPaths ?? []) lines.push(`${label('saved:    ')}${p}`);
      return new Text(lines.join('\n'), 0, 0);
    },
  });

  // ── image_jobs: manage background generations ──────────────────────

  type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
  interface JobsReturn {
    content: ToolContent[];
    details: JobsDetails;
    isError?: boolean;
  }

  const jobsError = (action: JobsAction, message: string): JobsReturn => ({
    content: [{ type: 'text', text: message }],
    details: { action, error: message },
    isError: true,
  });

  const actListJobs = (): JobsReturn => ({
    content: [{ type: 'text', text: formatRegistry(registry, Date.now()) }],
    details: { action: 'list', jobs: registry.jobs },
  });

  const actCollect = async (
    id: string | undefined,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<JobsReturn> => {
    if (!id) return jobsError('collect', 'collect requires `id`');
    const job = findJob(registry, id);
    if (!job) return jobsError('collect', `job [${id}] not found`);

    if (job.status === 'cancelled') {
      return {
        content: [{ type: 'text', text: `[${id}] was cancelled.` }],
        details: { action: 'collect', jobId: id, status: 'cancelled' },
      };
    }
    if (job.status === 'error') {
      return jobsError('collect', `[${id}] failed: ${job.error ?? 'unknown error'}`);
    }
    if (job.status === 'done') {
      // Already finished (often auto-downloaded off-turn). Re-serve the
      // saved files from disk so the model can still view them inline,
      // since the auto-download path could not push them into context.
      const existing = findGenerationByPrompt(generationsState, job.promptId);
      const details: JobsDetails = {
        action: 'collect',
        jobId: id,
        status: 'done',
        savedPaths: job.savedPaths,
        generationId: existing?.id,
      };
      const decision = resolveSendToModel(job.sendToModel, ctx.model?.input);
      const n = job.savedPaths.length;
      const countNote = `${n} image${n === 1 ? '' : 's'}`;
      const idNote = existing ? ` (${existing.id})` : '';
      const baseText = `[${id}]${idNote} already downloaded: ${countNote} in ${job.saveDir}.`;
      if (decision.send) {
        const blocks = readSavedImages(job.savedPaths);
        if (blocks.length > 0) {
          return { content: [{ type: 'text', text: baseText }, ...blocks.map((b) => b.block)], details };
        }
      }
      return { content: [{ type: 'text', text: baseText }], details };
    }

    // Still running. Bail out if the auto-download timer (or a concurrent
    // collect) is already fetching this job, so we don't double-write its
    // output files; the model just re-polls a moment later.
    if (inFlight.has(id)) {
      return {
        content: [{ type: 'text', text: `[${id}] is being downloaded right now. Call collect again shortly.` }],
        details: { action: 'collect', jobId: id, status: 'running' },
      };
    }

    // Poll `/history` once. If outputs are ready, fetch + save and hand
    // them back; otherwise report and let the model re-poll.
    const config = loadConfig(ctx.cwd);
    const conn: Conn = {
      base: resolveBaseUrl(config),
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    inFlight.add(id);
    try {
      const outcome = await pollJobOnce(job, conn, ac.signal);
      if (outcome.kind === 'failed') {
        registry = updateJob(registry, id, { status: 'error', error: outcome.reason, endedAt: Date.now() });
        updateStatusline();
        return jobsError('collect', `[${id}] failed: ${outcome.reason}`);
      }
      if (outcome.kind === 'running') {
        return {
          content: [{ type: 'text', text: `[${id}] still running (no output yet). Call collect again shortly.` }],
          details: { action: 'collect', jobId: id, status: 'running' },
        };
      }

      const saved = outcome.saved;
      const savedPaths = saved.map((s) => s.savedPath);
      registry = updateJob(registry, id, { status: 'done', savedPaths, endedAt: Date.now() });
      updateStatusline();
      emitImageGenerated({
        savedPaths,
        workflow: job.workflow,
        prompt: job.prompt,
        seed: job.seed,
        background: true,
      });
      const collected = recordGeneration({
        workflow: job.workflow,
        promptId: job.promptId,
        prompt: job.prompt,
        negative: job.negative,
        seed: job.seed,
        savedPaths,
        source: 'background',
        createdAt: Date.now(),
      });
      const idNote = collected ? ` (${collected.id})` : '';

      const decision = resolveSendToModel(job.sendToModel, ctx.model?.input);
      const seedNote = job.seed !== undefined ? ` (seed ${job.seed})` : '';
      const countNote = `${savedPaths.length} image${savedPaths.length === 1 ? '' : 's'}`;
      const details: JobsDetails = {
        action: 'collect',
        jobId: id,
        status: 'done',
        savedPaths,
        generationId: collected?.id,
      };
      if (!decision.send) {
        const why = decision.visionBlocked
          ? ' (active model has no image input; not sent to model)'
          : ' (image not sent to model)';
        const text = `Collected ${countNote} from [${id}]${idNote} via "${job.workflow}"${seedNote}. Saved to ${job.saveDir}.${why}`;
        return { content: [{ type: 'text', text }], details };
      }
      const text = `Collected ${countNote} from [${id}]${idNote} via "${job.workflow}"${seedNote}. Saved to ${job.saveDir}.`;
      return { content: [{ type: 'text', text }, ...saved.map((s) => s.block)], details };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = ac.signal.aborted && !(signal?.aborted ?? false) ? `timed out after ${conn.timeoutMs}ms` : message;
      return jobsError('collect', `collect failed for [${id}]: ${reason}`);
    } finally {
      clearTimeout(timer);
      inFlight.delete(id);
    }
  };

  const actCancel = async (
    id: string | undefined,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<JobsReturn> => {
    if (!id) return jobsError('cancel', 'cancel requires `id`');
    const job = findJob(registry, id);
    if (!job) return jobsError('cancel', `job [${id}] not found`);
    if (job.status !== 'running') return jobsError('cancel', `[${id}] is not running (status: ${job.status})`);

    const config = loadConfig(ctx.cwd);
    const conn: Conn = {
      base: resolveBaseUrl(config),
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CANCEL_TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
      await cancelPrompt(conn, job.promptId, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    registry = updateJob(registry, id, { status: 'cancelled', endedAt: Date.now() });
    updateStatusline();
    return {
      content: [
        {
          type: 'text',
          text: `Cancelled [${id}] (best-effort: interrupts a running render or dequeues a pending one; a render that finished first still lands on disk).`,
        },
      ],
      details: { action: 'cancel', jobId: id, status: 'cancelled' },
    };
  };

  const ImageJobsParams = Type.Object({
    action: StringEnum(['list', 'collect', 'cancel'] as const, {
      description:
        'list (all background jobs), collect (poll a job; returns images once ready, "still running" otherwise - safe to repeat), cancel (drop a still-queued job).',
    }),
    id: Type.Optional(Type.String({ description: 'Job id (required for collect / cancel).' })),
  });

  pi.registerTool({
    name: 'image_jobs',
    label: 'Image jobs',
    description:
      'Manage background image generations (those started by generate_image with background=true). ' +
      'Actions: list, collect (poll, returning the image(s) once ready), cancel.',
    promptSnippet:
      'After a background generate_image (background=true), use image_jobs collect with the returned id to retrieve the image once ready.',
    parameters: ImageJobsParams,

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as unknown as { action: JobsAction; id?: string };
      switch (params.action) {
        case 'list':
          return actListJobs();
        case 'collect':
          return await actCollect(params.id, ctx, signal);
        case 'cancel':
          return await actCancel(params.id, ctx, signal);
      }
    },

    renderCall(args, theme, _context) {
      const action = (args as { action?: string }).action ?? '';
      const id = (args as { id?: string }).id;
      let text = theme.fg('toolTitle', theme.bold('image_jobs ')) + theme.fg('muted', action);
      if (id) text += ` ${theme.fg('accent', `[${id}]`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = (result.details ?? {}) as Partial<JobsDetails>;
      if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);

      if (details.action === 'list') {
        const jobs = details.jobs ?? [];
        if (jobs.length === 0) return new Text(theme.fg('dim', '(no background image jobs)'), 0, 0);
        const now = Date.now();
        return new Text(jobs.map((j) => theme.fg('text', formatJobLine(j, now))).join('\n'), 0, 0);
      }

      const id = details.jobId ?? '?';
      switch (details.status) {
        case 'running':
          return new Text(theme.fg('dim', `⟳ [${id}] still running`), 0, 0);
        case 'cancelled':
          return new Text(theme.fg('muted', `◌ [${id}] cancelled`), 0, 0);
        case 'done': {
          const n = details.savedPaths?.length ?? 0;
          return new Text(theme.fg('success', `✓ [${id}] ${n} image${n === 1 ? '' : 's'}`), 0, 0);
        }
        default:
          return new Text(theme.fg('dim', `[${id}]`), 0, 0);
      }
    },
  });

  pi.registerCommand('comfyui', {
    description: 'Inspect ComfyUI status, workflows, and background jobs',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        workflows: {
          description: 'Validate configured workflows',
          // Re-read config so a `/reload`-free config edit still completes.
          args: () => Object.keys(loadConfig(cwd).workflows).map((label) => ({ label })),
        },
        jobs: {
          description: 'List background generations',
          args: () => registry.jobs.map((j) => ({ label: j.id, description: j.status })),
        },
        gallery: {
          description: 'List recorded generations (reuse with variationOf / refine)',
          args: () => generationsState.generations.map((g) => ({ label: g.id, description: g.workflow })),
        },
        models: {
          description: 'List installed models from the server (/object_info)',
        },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(COMFYUI_USAGE, 'info');
        return;
      }
      const config = loadConfig(ctx.cwd);
      const base = resolveBaseUrl(config);
      const headers = resolveAuthHeaders(config);
      const conn: Conn = { base, headers, timeoutMs: config.timeoutMs };
      const sub = args.trim().toLowerCase();

      if (sub === 'jobs') {
        ctx.ui.notify(formatRegistry(registry, Date.now()), 'info');
        return;
      }

      if (sub === 'gallery') {
        ctx.ui.notify(formatGallery(generationsState), 'info');
        return;
      }

      // Read-only operator aid: dump the installed model files the server
      // advertises so a human can fill `ckpt_name` / `lora_name` values
      // when configuring a workflow. Never surfaced to the model.
      if (sub === 'models') {
        try {
          const objectInfo = await fetchObjectInfo(conn, AbortSignal.timeout(conn.timeoutMs));
          ctx.ui.notify(formatModelCatalog(extractModelCatalog(objectInfo)), 'info');
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`could not fetch models from ${base}: ${reason}`, 'error');
        }
        return;
      }

      if (sub === 'workflows') {
        const lines: string[] = [];
        for (const [name, wf] of Object.entries(config.workflows)) {
          const loaded = loadWorkflowGraph(wf.file, ctx.cwd, homedir());
          if (loaded.error || !loaded.graph) {
            lines.push(`✗ ${name}: ${loaded.error ?? 'load failed'}`);
            continue;
          }
          const errors = validateMapping(loaded.graph, wf.inputs);
          const inputs = Object.keys(wf.inputs).join(', ') || '(none)';
          lines.push(errors.length > 0 ? `✗ ${name}: ${errors.join('; ')}` : `✓ ${name}: ${inputs}`);
        }
        ctx.ui.notify(lines.join('\n') || 'no workflows configured', 'info');
        return;
      }

      const reachable = await pingServer(conn);
      const names = Object.keys(config.workflows).join(', ') || '(none)';
      ctx.ui.notify(
        [
          `comfyui: ${base} ${reachable ? '(reachable)' : '(unreachable)'}`,
          `auth: ${config.authHeader ? `on (${config.authHeader.name})` : 'off'}`,
          `default workflow: ${config.defaultWorkflow}`,
          `workflows: ${names}`,
          `saveDir: ${config.saveDir}`,
        ].join('\n'),
        reachable ? 'info' : 'warning',
      );
    },
  });
}
