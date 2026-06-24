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

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import { completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { COMFYUI_USAGE } from '../../../lib/node/pi/comfyui/usage.ts';
import { DEFAULT_TARGET_PIXELS, resolveAspect } from '../../../lib/node/pi/comfyui/aspect.ts';
import { describeWorkflows, workflowCapabilities } from '../../../lib/node/pi/comfyui/describe.ts';
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
  buildInjectedGraph,
  cancelPrompt,
  type Conn,
  createWaker,
  fetchAndSave,
  fetchObjectInfo,
  openProgressSocket,
  pingServer,
  readSavedImages,
  submitPrompt,
  waitForImages,
} from '../../../lib/node/pi/comfyui/client.ts';
import { isRoleMap, loadWorkflowGraph, validateMapping } from '../../../lib/node/pi/comfyui/workflow.ts';
import { type CollectOutcome, pollJobOnce } from '../../../lib/node/pi/comfyui/poll.ts';
import {
  addJob,
  findJob,
  formatRegistry,
  formatJobHint,
  formatRunningBlock,
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
  formatGenerationDetail,
  formatGenerationHint,
  type GenerationRecord,
  type GenerationRegistry,
  type NewGeneration,
  reduceGenerations,
} from '../../../lib/node/pi/comfyui/generations.ts';
import { buildEnhanceTask } from '../../../lib/node/pi/comfyui/enhance.ts';
import {
  extractSceneContext,
  mergeSceneContext,
  type SceneMessage,
} from '../../../lib/node/pi/comfyui/scene-context.ts';
import type { ComfyuiConfig, WorkflowConfig } from '../../../lib/node/pi/comfyui/types.ts';
import {
  previewTransformFor,
  resolveRoleImages,
  type RoleImageInput,
} from '../../../lib/node/pi/ext/comfyui/images.ts';
import type { GenerateDetails, JobsAction, JobsDetails } from '../../../lib/node/pi/ext/comfyui/details.ts';
import {
  renderGenerateCall,
  renderGenerateResult,
  renderJobsCall,
  renderJobsResult,
} from '../../../lib/node/pi/ext/comfyui/render.ts';
import { createEnhancerAccess, readGuidanceText } from '../../../lib/node/pi/ext/comfyui/enhancer.ts';
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
// Shipped default workflow (committed at config/pi/comfyui/txt2img.api.json)
// ──────────────────────────────────────────────────────────────────────

const extDir = dirname(fileURLToPath(import.meta.url));

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

  // Agent-driven, opt-in prompt enhancer; all wiring lives in
  // ext/comfyui/enhancer.ts (subagent spawn, session manager, caching).
  const enhancerAccess = createEnhancerAccess({ pi, extDir, loadConfig });

  // Multi-line capability matrix (description / tags / mapped params /
  // image slots / prompt protocol per workflow) baked into the immutable
  // tool description so the model picks the right workflow and stops
  // passing args a workflow does not map. The "recommends enhance" hint is
  // surfaced only when the enhancer agent is actually installed and the
  // env kill-switch is not set, so the model never sees a hint it cannot
  // act on.
  const enhanceAvailableAtReg =
    !envTruthy(process.env.PI_COMFYUI_DISABLE_ENHANCE) && enhancerAccess.isAgentInstalled(cwd);
  const workflowMatrix = describeWorkflows(registrationConfig.workflows, defaultWorkflow, {
    enhanceHint: enhanceAvailableAtReg,
  });
  // Aggregate image-input / param capabilities across the configured
  // workflows so the `generate_image` schema only advertises params some
  // workflow can actually consume. A pure text-to-image setup never carries
  // `inputImages` / `images` / mask params (keeps the tool definition small).
  const caps = workflowCapabilities(registrationConfig.workflows);
  const mapsParam = (p: string): boolean => caps.params.has(p);

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

  // Auto-captured scene context for the enhancer (see scene-context.ts).
  // `sceneBudget` (chars) is refreshed from config each turn in
  // before_agent_start; `recentScene` is snapshotted from the outgoing
  // payload in the context hook when the budget is > 0. Both are
  // session-scoped and reset on shutdown.
  let sceneBudget = 0;
  let recentScene = '';

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
    // Drop the enhancer scene-capture state.
    sceneBudget = 0;
    recentScene = '';
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
    // Refresh the enhancer's scene-capture budget from config so a
    // config edit takes effect without a /reload. Cheap JSON read; the
    // executor reads config per call anyway.
    try {
      sceneBudget = loadConfig(ctx.cwd).enhanceContextChars ?? 0;
    } catch {
      sceneBudget = 0;
    }
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

    // 3. Snapshot recent conversation as enhancer scene context (read-only -
    //    does not alter the outgoing payload). Off when the budget is 0.
    recentScene = sceneBudget > 0 ? extractSceneContext(messages as unknown as SceneMessage[], sceneBudget) : '';

    return changed ? { messages: messages as unknown as typeof event.messages } : undefined;
  });

  // Build the parameter schema from the configured workflows' capabilities.
  // The full literal below keeps the precise TypeBox `Static` types the
  // executor relies on; we then drop (at runtime) the params no configured
  // workflow can consume, so the model-facing tool definition only
  // advertises what is usable. Every param is optional and the executor
  // reads `params.X ?? config.X`, so dropping one is purely a schema change.
  const maskValue = Type.Object({
    bbox: Type.Array(Type.Array(Type.Number()), {
      description: 'Normalized [x, y, w, h] rects (0-1, top-left origin), unioned for multi-region edits.',
    }),
    feather: Type.Optional(Type.Number({ description: 'Mask edge softening in px (default 0).' })),
    invert: Type.Optional(Type.Boolean({ description: 'Flip polarity (default white = region to change).' })),
  });
  const generateProps = {
    prompt: Type.Optional(Type.String({ description: 'What to depict. Required unless `variationOf` reuses one.' })),
    negative: Type.Optional(Type.String({ description: 'What to avoid.' })),
    variationOf: Type.Optional(
      Type.String({
        description:
          'Reuse a prior generation id (e.g. "g3"): inherits its workflow/prompt/negative/seed/dims; any param here overrides.',
      }),
    ),
    refine: Type.Optional(
      Type.String({
        description:
          'Reuse a prior generation id as the input image for an edit workflow; set `workflow` + `prompt` to the edit. Not with `inputImages`.',
      }),
    ),
    workflow: Type.Optional(Type.String({ description: `One of: ${workflowList}. Default ${defaultWorkflow}.` })),
    width: Type.Optional(Type.Number({ description: 'Output width (px).' })),
    height: Type.Optional(Type.Number({ description: 'Output height (px).' })),
    aspect: Type.Optional(
      Type.String({
        description: 'Aspect preset (e.g. "16:9", "portrait", "square") setting width/height; explicit dims win.',
      }),
    ),
    steps: Type.Optional(Type.Number({ description: 'Sampler steps.' })),
    cfg: Type.Optional(Type.Number({ description: 'CFG / guidance scale.' })),
    seed: Type.Optional(Type.Number({ description: 'Omit for random; reuse to reproduce.' })),
    denoise: Type.Optional(Type.Number({ description: 'Denoise strength 0-1 (img2img).' })),
    inputImages: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Reference image paths for img2img/edit workflows, e.g. ["~/in.png"]; filled into slots in order.',
      }),
    ),
    images: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), maskValue]), {
        description:
          'Image inputs keyed by role (init, mask, control); value is a path, or a { bbox } mask spec. Not with inputImages.',
      }),
    ),
    count: Type.Optional(Type.Number({ description: 'Batch size.' })),
    sendToModel: Type.Optional(
      Type.Boolean({
        default: registrationConfig.sendToModel,
        description: 'Return the image to you for analysis; false = save to disk only.',
      }),
    ),
    ephemeral: Type.Optional(
      Type.Boolean({
        default: registrationConfig.ephemeral,
        description:
          'Show once, then drop the call+image from context (not seen on later turns); for VN/roleplay scene renders. Foreground only.',
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        default: registrationConfig.background,
        description: 'Return immediately; collect later via `image_jobs`. For slow renders.',
      }),
    ),
    enhance: Type.Optional(
      Type.Boolean({
        default: registrationConfig.enhance,
        description: "Refine prompt+negative into the workflow's protocol via a helper agent first.",
      }),
    ),
    context: Type.Optional(
      Type.String({
        description: 'Background for enhancement (scene/continuity) to honor without depicting. Only with enhance.',
      }),
    ),
    previewMaxDimension: Type.Optional(
      Type.Number({
        description:
          "Downscale the returned copy's longer side to this many px (saved file stays full-res) to save tokens.",
      }),
    ),
  };
  // Drop params no configured workflow can consume. Casting to a loose record
  // keeps the precise `typeof generateProps` (and thus the executor's param
  // types) while letting us delete keys at runtime; the schema TypeBox builds
  // reflects only the surviving keys.
  const dropProp = (key: string): void => {
    delete (generateProps as Record<string, unknown>)[key];
  };
  for (const p of ['negative', 'width', 'height', 'steps', 'cfg', 'seed', 'denoise', 'count']) {
    if (!mapsParam(p)) dropProp(p);
  }
  if (!caps.dimensions) dropProp('aspect');
  if (!caps.imageInput) dropProp('refine');
  if (!caps.positionalImages) dropProp('inputImages');
  if (!caps.roleImages) {
    dropProp('images');
  } else if (!caps.maskRole) {
    // Role workflows without a mask slot take only file paths, so drop the
    // bbox-mask object from the `images` value union.
    (generateProps as Record<string, unknown>).images = Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: 'Image inputs keyed by role (init, control); value is a file path. Not with inputImages.',
      }),
    );
  }
  if (!enhanceAvailableAtReg) {
    dropProp('enhance');
    dropProp('context');
  }
  const GenerateParams = Type.Object(generateProps);

  pi.registerTool({
    name: 'generate_image',
    label: 'Generate image',
    description:
      `Generate an image from a prompt via a ComfyUI server and return it inline. ` +
      `Use when the user asks to create, draw, render, or generate a picture. ` +
      `Each workflow bakes in its own checkpoint/sampler/scheduler; pick one by capability and prompt in its protocol. ` +
      `Available workflows (default ${defaultWorkflow}):\n${workflowMatrix}\n` +
      `Saved to disk and returned so you can see it.`,
    promptSnippet: `To create or render an image, call \`generate_image\` (workflows: ${workflowList}) instead of describing it in text.`,
    promptGuidelines: [
      "Never call ComfyUI's HTTP API (`/object_info`, `/prompt`, `/view`, …) via bash/curl/anything - `generate_image` is the only entry point; it encapsulates model and sampler choice.",
      ...(caps.positionalImages ? ['Only pass `inputImages` for img2img / edit workflows.'] : []),
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

      // Image inputs are either positional (`inputImages`) or role-keyed
      // (`images`), set by the workflow; reject the wrong arg up front for
      // a clearer message than a downstream mapping error.
      const roleMap = isRoleMap(wf.images) ? wf.images : undefined;
      if (roleMap !== undefined && params.inputImages !== undefined && params.inputImages.length > 0) {
        return fail(`workflow "${name}" uses named image roles; pass "images" (role -> path/bbox), not "inputImages"`);
      }
      if (roleMap === undefined && params.images !== undefined && Object.keys(params.images).length > 0) {
        return fail(`workflow "${name}" does not use named image roles; pass "inputImages", not "images"`);
      }
      if (refineImage !== undefined && roleMap !== undefined && !('init' in roleMap)) {
        return fail(`workflow "${name}" has no "init" role to refine into`);
      }
      if (refineImage !== undefined && params.images?.init !== undefined) {
        return fail('refine supplies the init image; do not also pass images.init');
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

      // The enhancement → graph-build → submit pipeline, shared by the
      // foreground (await it) and background (run it off-turn) paths. It
      // takes its own abort signal + progress reporter so the background
      // path can detach from the turn's lifetime, and returns the rendered
      // prompt / negative / seed / dims the caller needs to record the
      // result. `clientId` is generated by the caller so the foreground
      // path can also bind its progress websocket to the same id.
      type PipelineResult =
        | {
            ok: true;
            promptId: string;
            seed?: number;
            prompt: string;
            negative?: string;
            width?: number;
            height?: number;
            enhanceNote: string;
          }
        | { ok: false; error: string };

      const runPipeline = async (
        clientId: string,
        pipeSignal: AbortSignal,
        pipeReport: (text: string) => void,
      ): Promise<PipelineResult> => {
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
        const wantEnhance = params.enhance ?? wf.enhance ?? config.enhance;
        if (wantEnhance) {
          const enh = enhancerAccess.getEnhancer(ctx);
          if (enh?.isEnabled()) {
            pipeReport('enhancing prompt…');
            const task = buildEnhanceTask({
              prompt: effectivePrompt,
              ...(baselineNegative !== undefined ? { negative: baselineNegative } : {}),
              guidance: readGuidanceText(config, wf, ctx.cwd),
              ...(wf.description !== undefined ? { description: wf.description } : {}),
              ...(wf.tags !== undefined ? { tags: wf.tags } : {}),
              ...(wf.promptProtocol !== undefined ? { promptProtocol: wf.promptProtocol } : {}),
              ...((): { context?: string } => {
                const merged = mergeSceneContext(params.context, sceneBudget > 0 ? recentScene : '');
                return merged !== undefined ? { context: merged } : {};
              })(),
            });
            const enhanceResult = await enh.enhance(
              {
                cwd: ctx.cwd,
                model: ctx.model,
                modelRegistry: ctx.modelRegistry as never,
                signal: pipeSignal,
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
          // Positional refine feeds inputImages[0]; in role mode the prior
          // render goes into the `init` role instead (handled below), so
          // inputImages stays empty.
          inputImages:
            roleMap !== undefined ? undefined : refineImage !== undefined ? [refineImage] : params.inputImages,
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

        // Role-keyed image inputs: resolve paths + synthesize bbox masks and
        // upload them (the mask raster needs `sharp`, so it lives here, not
        // in the pure graph builder). A `refine` id feeds the `init` role.
        let roleImages: Record<string, string> | undefined;
        if (roleMap !== undefined) {
          const sources: Record<string, RoleImageInput> = { ...params.images };
          if (refineImage !== undefined) sources.init = refineImage;
          if (Object.keys(sources).length > 0) {
            const resolvedRoles = await resolveRoleImages(
              conn,
              roleMap,
              sources,
              { width: resolvedParams.width, height: resolvedParams.height },
              homedir(),
              pipeReport,
              pipeSignal,
            );
            if (resolvedRoles.error !== undefined) return { ok: false, error: resolvedRoles.error };
            roleImages = resolvedRoles.uploadedByRole;
          }
        }

        const prep = await buildInjectedGraph(
          conn,
          wf,
          name,
          resolvedParams,
          ctx.cwd,
          homedir(),
          pipeReport,
          pipeSignal,
          roleImages,
        );
        if (prep.error || !prep.graph) {
          return { ok: false, error: prep.error ?? 'failed to prepare workflow' };
        }

        pipeReport('submitting to ComfyUI…');
        const promptId = await submitPrompt(conn, prep.graph, clientId, pipeSignal);
        return {
          ok: true,
          promptId,
          seed: prep.seed,
          prompt: resolvedParams.prompt,
          negative: resolvedParams.negative,
          width: resolvedParams.width,
          height: resolvedParams.height,
          enhanceNote,
        };
      };

      // Background: register the job and return immediately, then run the
      // enhancement + graph-build + submit pipeline off-turn so the turn is
      // never blocked on the enhancer LLM call, image uploads, or the submit
      // round-trip. The detached task owns its abort controller + timeout
      // (NOT the turn's signal, which is gone the instant we return) and
      // patches the real prompt id / seed / rendered prompt onto the job once
      // ComfyUI has queued it, or marks the job errored if prep/submit fails.
      if (background) {
        const baselineNegative = params.negative ?? reuse?.negative ?? d?.negative;
        const added = addJob(registry, {
          promptId: '',
          workflow: name,
          prompt: effectivePrompt,
          negative: baselineNegative,
          saveDir,
          sendToModel: requested,
          startedAt: Date.now(),
        });
        registry = added.registry;
        const jobId = added.created.id;
        updateStatusline();
        details.background = true;
        details.jobId = jobId;
        // Spin the poll timer up now (idempotent); it skips jobs whose
        // deferred submit hasn't filled in a prompt id yet, so it simply
        // starts watching the moment the submit lands.
        const autoDownload = config.autoDownload;
        if (autoDownload) ensurePollTimer(config.pollIntervalMs);

        void (async () => {
          const bgAc = new AbortController();
          const bgTimer = setTimeout(() => bgAc.abort(), conn.timeoutMs);
          try {
            const result = await runPipeline(randomUUID(), bgAc.signal, () => {
              /* off-turn: progress lines have nowhere to stream */
            });
            if (!result.ok) {
              registry = updateJob(registry, jobId, { status: 'error', error: result.error, endedAt: Date.now() });
              updateStatusline();
              return;
            }
            // The model may have cancelled the job while it was still
            // submitting. Honor that by interrupting the prompt we just
            // queued instead of resurrecting a cancelled job.
            if (findJob(registry, jobId)?.status !== 'running') {
              const cAc = new AbortController();
              const cTimer = setTimeout(() => cAc.abort(), CANCEL_TIMEOUT_MS);
              try {
                await cancelPrompt(conn, result.promptId, cAc.signal);
              } catch {
                /* best-effort: a cancelled job that already finished still lands on disk */
              } finally {
                clearTimeout(cTimer);
              }
              return;
            }
            registry = updateJob(registry, jobId, {
              promptId: result.promptId,
              seed: result.seed,
              prompt: result.prompt,
              negative: result.negative,
            });
            if (autoDownload) ensurePollTimer(config.pollIntervalMs);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const reason = bgAc.signal.aborted ? `timed out after ${conn.timeoutMs}ms` : message;
            registry = updateJob(registry, jobId, { status: 'error', error: reason, endedAt: Date.now() });
            updateStatusline();
          } finally {
            clearTimeout(bgTimer);
          }
        })();

        const collectHint = autoDownload
          ? `It will auto-download to ${saveDir} when ready; collect it with the image_jobs tool (action collect, id ${jobId}) to view it inline.`
          : `Collect it later with the image_jobs tool (action collect, id ${jobId}).`;
        const text = `Started background generation [${jobId}] via "${name}". ${collectHint}`;
        return { content: [{ type: 'text', text }], details };
      }

      // Foreground: combine the turn's abort signal with the per-generation
      // timeout, then await the pipeline and the render.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
      if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
      const runSignal = ac.signal;
      const clientId = randomUUID();

      let socket: WebSocket | null = null;
      try {
        const result = await runPipeline(clientId, runSignal, report);
        if (!result.ok) {
          details.error = result.error;
          return { content: [{ type: 'text', text: result.error }], details, isError: true };
        }
        const { promptId, seed, enhanceNote } = result;
        details.promptId = promptId;
        details.seed = seed;
        const seedNote = seed !== undefined ? ` (seed ${seed})` : '';

        // The socket wakes the poll the instant the render finishes, so a
        // healthy websocket trims the up-to-1s poll-interval latency; the
        // poll stays the source of truth when the socket never connects.
        const waker = createWaker();
        socket = openProgressSocket(conn, clientId, promptId, onUpdate ? report : undefined, runSignal, waker);
        const refs = await waitForImages(conn, promptId, runSignal, waker);

        // Downscale the model-facing copy (token economy), but never an
        // ephemeral render: its block is collapsed out of model context,
        // so shrinking it only degrades the one-time TUI view for no gain.
        const previewTransform = ephemeral
          ? undefined
          : previewTransformFor(params.previewMaxDimension ?? config.previewMaxDimension);
        const saved = await fetchAndSave(conn, refs, saveDir, runSignal, previewTransform);
        for (const s of saved) details.savedPaths.push(s.savedPath);
        emitImageGenerated({
          savedPaths: details.savedPaths,
          workflow: name,
          prompt: result.prompt,
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
          prompt: result.prompt,
          negative: result.negative,
          seed: details.seed,
          width: wf.inputs.width !== undefined ? result.width : undefined,
          height: wf.inputs.height !== undefined ? result.height : undefined,
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

    renderCall: (args, theme) => renderGenerateCall(args, theme),
    renderResult: (result, options, theme, context) => renderGenerateResult(result, options, theme, context),
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

    // A collected background job is re-served to the model, so it gets the
    // same token-economy downscale as a foreground render (config-only -
    // collect takes no per-call preview arg, and is never ephemeral).
    const config = loadConfig(ctx.cwd);
    const previewTransform = previewTransformFor(config.previewMaxDimension);

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
        const blocks = await readSavedImages(job.savedPaths, previewTransform);
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
      const outcome = await pollJobOnce(job, conn, ac.signal, previewTransform);
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
      // An empty prompt id means the deferred submit hasn't queued the graph
      // yet; there is nothing on the server to interrupt, so just mark it
      // cancelled locally (the detached submit checks the status before it
      // patches, and best-effort cancels the prompt if it already queued).
      if (job.promptId) await cancelPrompt(conn, job.promptId, ac.signal);
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

    renderCall: (args, theme) => renderJobsCall(args, theme),
    renderResult: (result, _options, theme) => renderJobsResult(result, theme),
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
          args: () => registry.jobs.map((j) => ({ label: j.id, description: formatJobHint(j) })),
        },
        gallery: {
          description: 'List recorded generations (reuse with variationOf / refine)',
          args: () => generationsState.generations.map((g) => ({ label: g.id, description: formatGenerationHint(g) })),
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

      if (sub === 'gallery' || sub.startsWith('gallery ')) {
        const id = sub.slice('gallery'.length).trim();
        if (id.length === 0) {
          ctx.ui.notify(formatGallery(generationsState), 'info');
          return;
        }
        const rec = findGeneration(generationsState, id);
        ctx.ui.notify(
          rec ? formatGenerationDetail(rec) : `unknown generation "${id}" (see /comfyui gallery)`,
          rec ? 'info' : 'warning',
        );
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
