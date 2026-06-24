/**
 * Tool-result `details` shapes for the comfyui extension's two tools.
 * Shared by the tool `execute` bodies (which build them) and the render
 * helpers in `render.ts` (which read them).
 */

import type { ImageJob } from '../../comfyui/jobs.ts';

export interface GenerateDetails {
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
export type JobsAction = 'list' | 'collect' | 'cancel';

export interface JobsDetails {
  action: JobsAction;
  jobId?: string;
  status?: ImageJob['status'];
  savedPaths?: string[];
  error?: string;
  jobs?: ImageJob[];
  /** Generation-registry id (`g<n>`) recorded when this collect landed the render. */
  generationId?: string;
}
