/**
 * `image_jobs` tool action bodies for the comfyui extension: list / collect
 * / cancel. Lives under `ext/` because each takes the {@link ComfyuiRuntime}
 * (session state) and builds multimodal tool results.
 *
 * Each action mutates the runtime's job + generation registries via the
 * runtime's own setters/recorders and returns a {@link JobsReturn}; the
 * shell's `image_jobs` execute just dispatches on the action verb.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { cancelPrompt, type Conn, readSavedImages } from '../../comfyui/client.ts';
import { resolveAuthHeaders, resolveBaseUrl, resolveSendToModel } from '../../comfyui/config.ts';
import { emitImageGenerated } from '../../comfyui/events.ts';
import { findGenerationByPrompt } from '../../comfyui/generations.ts';
import { findJob, formatRegistry, updateJob } from '../../comfyui/jobs.ts';
import { pollJobOnce } from '../../comfyui/poll.ts';
import type { JobsAction, JobsDetails } from './details.ts';
import { previewTransformFor } from './images.ts';
import type { ComfyuiRuntime } from './runtime.ts';

// Hard cap on the best-effort `image_jobs cancel` round-trip (interrupt /
// dequeue). Cancellation should be near-instant, so it gets a tighter
// bound than a full generation's `config.timeoutMs`. The background submit
// path in generate.ts reuses it for the cancel-while-submitting case.
export const CANCEL_TIMEOUT_MS = 10_000;

type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface JobsReturn {
  content: ToolContent[];
  details: JobsDetails;
  isError?: boolean;
}

const jobsError = (action: JobsAction, message: string): JobsReturn => ({
  content: [{ type: 'text', text: message }],
  details: { action, error: message },
  isError: true,
});

export function actListJobs(rt: ComfyuiRuntime): JobsReturn {
  return {
    content: [{ type: 'text', text: formatRegistry(rt.registry, Date.now()) }],
    details: { action: 'list', jobs: rt.registry.jobs },
  };
}

export async function actCollect(
  rt: ComfyuiRuntime,
  id: string | undefined,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<JobsReturn> {
  if (!id) return jobsError('collect', 'collect requires `id`');
  const job = findJob(rt.registry, id);
  if (!job) return jobsError('collect', `job [${id}] not found`);

  // A collected background job is re-served to the model, so it gets the
  // same token-economy downscale as a foreground render (config-only -
  // collect takes no per-call preview arg, and is never ephemeral).
  const config = rt.loadConfig(ctx.cwd);
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
    const existing = findGenerationByPrompt(rt.generations, job.promptId);
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
  if (rt.inFlight.has(id)) {
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
  rt.inFlight.add(id);
  try {
    const outcome = await pollJobOnce(job, conn, ac.signal, previewTransform);
    if (outcome.kind === 'failed') {
      rt.registry = updateJob(rt.registry, id, { status: 'error', error: outcome.reason, endedAt: Date.now() });
      rt.updateStatusline();
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
    rt.registry = updateJob(rt.registry, id, { status: 'done', savedPaths, endedAt: Date.now() });
    rt.updateStatusline();
    emitImageGenerated({
      savedPaths,
      workflow: job.workflow,
      prompt: job.prompt,
      seed: job.seed,
      background: true,
    });
    const collected = rt.recordGeneration({
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
    rt.inFlight.delete(id);
  }
}

export async function actCancel(
  rt: ComfyuiRuntime,
  id: string | undefined,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<JobsReturn> {
  if (!id) return jobsError('cancel', 'cancel requires `id`');
  const job = findJob(rt.registry, id);
  if (!job) return jobsError('cancel', `job [${id}] not found`);
  if (job.status !== 'running') return jobsError('cancel', `[${id}] is not running (status: ${job.status})`);

  const config = rt.loadConfig(ctx.cwd);
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
  rt.registry = updateJob(rt.registry, id, { status: 'cancelled', endedAt: Date.now() });
  rt.updateStatusline();
  return {
    content: [
      {
        type: 'text',
        text: `Cancelled [${id}] (best-effort: interrupts a running render or dequeues a pending one; a render that finished first still lands on disk).`,
      },
    ],
    details: { action: 'cancel', jobId: id, status: 'cancelled' },
  };
}
