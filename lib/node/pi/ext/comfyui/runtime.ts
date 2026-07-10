/**
 * `ComfyuiRuntime` - the session-scoped mutable state for the comfyui
 * extension, plus the lifecycle + `context`-hook logic that reads and
 * mutates it. Lives under `ext/` because it imports the pi runtime
 * (`ExtensionAPI` / `ExtensionContext`) and the pi-tui-coupled context
 * helpers.
 *
 * The shell constructs ONE runtime per extension load and delegates its
 * five hooks (`session_start` / `session_tree` / `session_shutdown` /
 * `before_agent_start` / `context`) plus the tool bodies (generate.ts,
 * jobs.ts) to it, so all the knotted shared state (job registry,
 * generation registry, ephemeral-collapse overlay, scene-capture budget,
 * statusline slot, auto-download poll timer) has a single owner.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { applyDirectives } from '../../context-edit/apply.ts';
import {
  cloneState,
  type ContextEditState,
  emptyState as emptyEditState,
  reduceBranch,
} from '../../context-edit/directive.ts';
import type { LooseMessage } from '../../context-edit/target.ts';
import { applyContextReminder, type ReminderMessage } from '../../context-reminder.ts';
import { type Conn } from '../../comfyui/client.ts';
import { resolveAuthHeaders, resolveBaseUrl } from '../../comfyui/config.ts';
import { COMFYUI_IMAGE_CHANNEL, type ImageGeneratedEvent } from '../../comfyui/events.ts';
import {
  addGeneration,
  cloneGenerations,
  emptyGenerations,
  findGenerationByPrompt,
  type GenerationRecord,
  type GenerationRegistry,
  type NewGeneration,
  reduceGenerations,
} from '../../comfyui/generations.ts';
import { emptyRegistry, formatRunningBlock, type JobRegistry, runningJobs, updateJob } from '../../comfyui/jobs.ts';
import { type CollectOutcome, pollJobOnce } from '../../comfyui/poll.ts';
import { extractSceneContext, mergeSceneContext } from '../../comfyui/scene-context.ts';
import type { ComfyuiConfig } from '../../comfyui/types.ts';

// Custom session-entry type under which the ephemeral-render collapse set
// is persisted. Distinct from tool-collapse's own store so the two
// overlays stay independent. The state is a `ContextEditState` of
// `collapse` directives keyed by the generate_image call's toolCallId;
// it is reduced from the branch on session_start/session_tree (so it
// survives `/reload` + exit->resume) and reapplied each turn in the
// `context` hook.
export const EPHEMERAL_CUSTOM_TYPE = 'comfyui-ephemeral-state';

// Custom session-entry type under which the generation registry (every
// render that landed on disk, with a short `g<n>` id) is persisted. Like
// the ephemeral overlay it is rebuilt from the branch on
// session_start/session_tree, so the gallery + `variationOf` / `refine`
// reuse survive `/reload`, a branch switch, and exit->resume.
export const GENERATIONS_CUSTOM_TYPE = 'comfyui-generations';

export class ComfyuiRuntime {
  private readonly pi: ExtensionAPI;
  readonly loadConfig: (cwd: string) => ComfyuiConfig;

  // Registration runs before any session exists, so cwd is seeded to the
  // launch dir and re-pointed to the real session cwd on session_start.
  // The `/comfyui` completions close over `rt.cwd` (completions get no
  // `ctx`), so this keeps them pointed at the session's project config.
  cwd = process.cwd();

  // Background-job registry. In-memory and per-session: ComfyUI owns the
  // actual execution and persists each prompt under its id, so a job is
  // just metadata here. Not persisted to the session branch (unlike
  // bg-bash) - reattaching to a prior runtime's promptId is best handled
  // by re-submitting, and the server's own history outlives us anyway.
  registry: JobRegistry = emptyRegistry();

  // Generation registry: every render that landed on disk, addressable by
  // a `g<n>` id for the gallery + `variationOf` / `refine` reuse. Persisted
  // as a full snapshot per mutation (mirrors the ephemeral overlay) and
  // rebuilt from the branch on session_start/session_tree.
  generations: GenerationRegistry = emptyGenerations();

  // Ephemeral-render collapse overlay. Holds a `collapse` directive per
  // ephemeral `generate_image` call (keyed by toolCallId); the `context`
  // hook applies it to the OUTGOING provider payload every turn so the
  // image + call never reach the model, while the real session entry
  // keeps the image block for the TUI. Reduced from the branch on
  // session_start/session_tree so it survives `/reload` + resume.
  ephemeral: ContextEditState = emptyEditState();

  // Auto-captured scene context for the enhancer (see scene-context.ts).
  // `sceneBudget` (chars) is refreshed from config each turn in
  // beforeAgentStart; `recentScene` is snapshotted from the outgoing
  // payload in the context hook when the budget is > 0. Both are
  // session-scoped and reset on shutdown.
  sceneBudget = 0;
  recentScene = '';

  // Statusline slot (see statusline.ts): show a count of pending jobs and
  // clear the slot when none are running so quiet sessions stay clean.
  private uiRef: ExtensionContext['ui'] | undefined;
  private lastStatusRunning = -1;

  // `inFlight` guards a single job from being fetched twice at once - by
  // the auto-download timer and a concurrent manual `collect` - which would
  // double-write its output files.
  readonly inFlight = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: { pi: ExtensionAPI; loadConfig: (cwd: string) => ComfyuiConfig }) {
    this.pi = deps.pi;
    this.loadConfig = deps.loadConfig;
  }

  // ── Cross-extension image bus ───────────────────────────────────────

  /**
   * Publish an image-generated event on pi's shared event bus. Wraps the
   * private `pi` handle so the render paths (generate.ts, jobs.ts) emit
   * without reaching into it directly. pi's bus isolates each subscriber in
   * its own try/catch, so a broken consumer can never break generation.
   */
  emitImageGenerated(event: ImageGeneratedEvent): void {
    this.pi.events.emit(COMFYUI_IMAGE_CHANNEL, event);
  }

  // ── Persistence ─────────────────────────────────────────────────────

  persistEphemeral(): void {
    try {
      this.pi.appendEntry(EPHEMERAL_CUSTOM_TYPE, cloneState(this.ephemeral));
    } catch {
      // Bookkeeping must never break a generation.
    }
  }

  private persistGenerations(): void {
    try {
      this.pi.appendEntry(GENERATIONS_CUSTOM_TYPE, cloneGenerations(this.generations));
    } catch {
      // Bookkeeping must never break a generation.
    }
  }

  // Record a freshly-landed render, de-duplicating background jobs that a
  // manual `collect` and the auto-download tick could both report by
  // keying on the ComfyUI prompt id. Returns the existing or created
  // record so callers can echo its id. Never throws.
  recordGeneration(gen: NewGeneration): GenerationRecord | undefined {
    if (gen.promptId !== undefined) {
      const existing = findGenerationByPrompt(this.generations, gen.promptId);
      if (existing !== undefined) return existing;
    }
    const added = addGeneration(this.generations, gen);
    this.generations = added.registry;
    this.persistGenerations();
    return added.created;
  }

  // ── Statusline ──────────────────────────────────────────────────────

  updateStatusline(): void {
    if (!this.uiRef) return;
    const running = runningJobs(this.registry).length;
    if (running === this.lastStatusRunning) return;
    this.lastStatusRunning = running;
    this.uiRef.setStatus('comfyui', running > 0 ? `▦ img:${running}` : undefined);
  }

  // ── Background auto-download ─────────────────────────────────────────
  // When `autoDownload` is on, an off-turn timer polls `/history` for
  // every running job and fetches its PNG(s) to disk the instant the
  // render finishes - no `image_jobs collect` needed. The file lands on
  // disk either way; auto-download cannot push the image into the model's
  // context (only a model-invoked `collect` can), so a later `collect`
  // re-serves the already-downloaded files from disk.

  stopPollTimer(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  ensurePollTimer(intervalMs: number): void {
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => {
      void this.autoDownloadTick();
    }, intervalMs);
    // Never keep the process alive solely for the poll.
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
  }
  // Note: the interval is fixed when the timer is first created and is not
  // re-read while it runs. The timer stops itself once no jobs are running
  // (autoDownloadTick), so a `pollIntervalMs` config edit takes effect the
  // next time a background job spins the timer back up - not mid-run.

  // Walk every running job once; auto-download the finished ones. Stops the
  // timer when nothing is running or `autoDownload` got turned off, so a
  // quiet session isn't polling forever.
  async autoDownloadTick(): Promise<void> {
    const running = runningJobs(this.registry);
    if (running.length === 0) {
      this.stopPollTimer();
      return;
    }
    const config = this.loadConfig(this.cwd);
    if (!config.autoDownload) {
      this.stopPollTimer();
      return;
    }
    const conn: Conn = {
      base: resolveBaseUrl(config),
      headers: resolveAuthHeaders(config),
      timeoutMs: config.timeoutMs,
    };
    // Poll every job in parallel, but apply the registry patches in a
    // single synchronous pass afterwards: `this.registry = updateJob(...)`
    // reads-then-reassigns, so concurrent reassignments would lose
    // updates. The `inFlight` guard still serializes any one job against a
    // manual collect.
    const results = await Promise.all(
      running.map(async (job): Promise<{ id: string; outcome: CollectOutcome } | null> => {
        // Managed jobs are owned by a detached auto-refine loop that waits,
        // critiques, re-renders, and records the final itself - skip them so
        // we never double-fetch or record an un-refined intermediate.
        if (this.inFlight.has(job.id) || job.managed === true) return null;
        this.inFlight.add(job.id);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), conn.timeoutMs);
        try {
          return { id: job.id, outcome: await pollJobOnce(job, conn, ac.signal) };
        } catch {
          // Best-effort: a transient poll/network failure just retries next tick.
          return null;
        } finally {
          clearTimeout(timer);
          this.inFlight.delete(job.id);
        }
      }),
    );
    let changed = false;
    for (const r of results) {
      if (!r) continue;
      if (r.outcome.kind === 'done') {
        const donePaths = r.outcome.saved.map((s) => s.savedPath);
        this.registry = updateJob(this.registry, r.id, {
          status: 'done',
          savedPaths: donePaths,
          endedAt: Date.now(),
        });
        const doneJob = running.find((j) => j.id === r.id);
        this.emitImageGenerated({
          savedPaths: donePaths,
          workflow: doneJob?.workflow ?? '',
          prompt: doneJob?.prompt,
          seed: doneJob?.seed,
          background: true,
        });
        if (doneJob) {
          this.recordGeneration({
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
        this.registry = updateJob(this.registry, r.id, {
          status: 'error',
          error: r.outcome.reason,
          endedAt: Date.now(),
        });
        changed = true;
      }
    }
    if (changed) this.updateStatusline();
  }

  // ── Lifecycle hooks (delegated from the shell's pi.on handlers) ──────

  onSessionStart(ctx: ExtensionContext): void {
    // Re-point cwd from the registration-time `process.cwd()` seed to the
    // real session cwd. The `/comfyui workflows` completion resolver
    // closes over `rt.cwd` (completions get no `ctx`), so this keeps it
    // pointed at the session's project config after a `/reload`.
    this.cwd = ctx.cwd;
    this.uiRef = ctx.ui;
    this.lastStatusRunning = -1;
    this.updateStatusline();
    // Rebuild the ephemeral-render collapse overlay + generation registry
    // from the persisted branch so `/reload` and exit->resume keep prior
    // ephemeral renders collapsed and the gallery intact.
    this.ephemeral = reduceBranch(ctx.sessionManager.getBranch(), EPHEMERAL_CUSTOM_TYPE);
    this.generations = reduceGenerations(ctx.sessionManager.getBranch(), GENERATIONS_CUSTOM_TYPE);
  }

  // A branch switch (edit/rewind) replays a different history, so re-derive
  // the ephemeral overlay + generation registry from the new branch's
  // persisted snapshots.
  onSessionTree(ctx: ExtensionContext): void {
    this.ephemeral = reduceBranch(ctx.sessionManager.getBranch(), EPHEMERAL_CUSTOM_TYPE);
    this.generations = reduceGenerations(ctx.sessionManager.getBranch(), GENERATIONS_CUSTOM_TYPE);
  }

  onShutdown(ctx: ExtensionContext): void {
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
    this.registry = emptyRegistry();
    this.uiRef = undefined;
    this.lastStatusRunning = -1;
    // Drop the ephemeral overlay + generation registry; onSessionStart
    // rebuilds both from the branch on the next (re)start.
    this.ephemeral = emptyEditState();
    this.generations = emptyGenerations();
    // Drop the enhancer scene-capture state.
    this.sceneBudget = 0;
    this.recentScene = '';
    // Stop the auto-download poll so a `/reload` doesn't leave an orphaned
    // interval bound to a replaced session, and drop the in-flight guard.
    this.stopPollTimer();
    this.inFlight.clear();
  }

  // Refresh the captured UI reference + statusline at every turn start
  // (must run regardless of injection).
  beforeAgentStart(ctx: ExtensionContext): void {
    this.uiRef = ctx.ui;
    this.updateStatusline();
    // Refresh the enhancer's scene-capture budget from config so a
    // config edit takes effect without a /reload. Cheap JSON read; the
    // executor reads config per call anyway.
    try {
      this.sceneBudget = this.loadConfig(ctx.cwd).enhanceContextChars ?? 0;
    } catch {
      this.sceneBudget = 0;
    }
  }

  // The `context` hook does three things to the OUTGOING provider payload
  // (never persisted): collapse ephemeral renders out of it, remind the
  // model about pending background jobs, and snapshot recent conversation
  // as enhancer scene context. Returns the modified messages or undefined
  // when nothing changed.
  applyContextHook(input: LooseMessage[]): { messages: LooseMessage[] } | undefined {
    let messages = input;
    let changed = false;

    // 1. Collapse ephemeral generate_image call+result pairs out of the
    //    outgoing payload. The real session entry keeps the image block
    //    (the TUI renders from it); only this provider copy is stripped,
    //    so the image + call cost no persistent context and the model
    //    never re-reads the scene.
    if (this.ephemeral.directives.length > 0) {
      const applied = applyDirectives(messages, this.ephemeral.directives);
      if (applied.applied > 0) {
        messages = applied.messages;
        changed = true;
      }
    }

    // 2. Remind the model about pending background jobs so even a weak
    //    model remembers to collect them.
    const block = formatRunningBlock(this.registry);
    if (block) {
      messages = applyContextReminder(messages as unknown as ReminderMessage[], {
        id: 'comfyui-jobs',
        body: block,
      }) as unknown as LooseMessage[];
      changed = true;
    }

    // 3. Snapshot recent conversation as enhancer scene context (read-only -
    //    does not alter the outgoing payload). Off when the budget is 0.
    this.recentScene = this.sceneBudget > 0 ? extractSceneContext(messages, this.sceneBudget) : '';

    return changed ? { messages } : undefined;
  }

  // Build merged enhancer scene context (per-call `context` arg + captured
  // recent scene) for the generate pipeline. Returns undefined when neither
  // contributes anything.
  mergedSceneContext(callContext: string | undefined): string | undefined {
    return mergeSceneContext(callContext, this.sceneBudget > 0 ? this.recentScene : '');
  }
}
