/**
 * One-shot poll of a background job's `/history`, shared by the comfyui
 * extension's auto-download timer and its manual `image_jobs collect`.
 *
 * Pure: it takes an {@link ImageJob} plus a {@link Conn} and returns a
 * {@link CollectOutcome} without touching the in-memory job registry (the
 * caller applies the status patch). No pi runtime imports - lives in the
 * pure lib tree so it can be unit-tested against a stubbed `fetch`.
 */

import { extractOutputImages, historyHasError, historyHasEntry, queueHasPrompt } from './api.ts';
import {
  type Conn,
  fetchAndSave,
  fetchHistory,
  fetchQueue,
  type ImageBlockTransform,
  type SavedImage,
} from './client.ts';
import type { ImageJob } from './jobs.ts';

/** Result of a single {@link pollJobOnce} call. */
export type CollectOutcome =
  | { kind: 'running' }
  | { kind: 'failed'; reason: string }
  | { kind: 'done'; saved: SavedImage[] };

/**
 * One poll of a job's `/history`: returns `done` with fetched+saved
 * images, `failed` (execution error or a prompt the server has dropped),
 * or `running`. Pure of registry mutation - the caller applies the patch.
 */
export async function pollJobOnce(
  job: ImageJob,
  conn: Conn,
  signal: AbortSignal,
  transform?: ImageBlockTransform,
): Promise<CollectOutcome> {
  // A background job whose deferred submit hasn't landed a prompt id yet is
  // still "running" (preparing) - never hit `/history` with an empty id, or
  // the absent entry reads as a lost prompt and falsely fails the job.
  if (!job.promptId) return { kind: 'running' };
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
  const saved = await fetchAndSave(conn, refs, job.saveDir, signal, transform);
  return { kind: 'done', saved };
}
