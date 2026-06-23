/**
 * Pure in-memory registry for background ComfyUI generations.
 *
 * A "background" generation is one the model fires off without blocking
 * the turn: the extension submits the workflow to ComfyUI (which queues
 * and runs it server-side, persisting the result under its `prompt_id`)
 * and records a lightweight {@link ImageJob} here. On a later turn the
 * model `collect`s the job - the extension polls `/history/{promptId}`,
 * fetches + saves the PNGs, and hands them back. Because ComfyUI owns the
 * actual execution, the registry never holds a process or a buffer; it is
 * just metadata, which keeps this module a pure reducer testable without
 * a server.
 *
 * No pi imports.
 */

/** Lifecycle of a background job from the extension's point of view. */
export type ImageJobStatus = 'running' | 'done' | 'error' | 'cancelled';

/** A submitted-but-not-yet-collected (or finished) background generation. */
export interface ImageJob {
  /** Registry-local id the model passes back to `image_jobs` (e.g. "1"). */
  id: string;
  /**
   * ComfyUI prompt id; the key used to poll `/history`. Empty string while a
   * background job is still being submitted off-turn (enhancement + graph
   * build + queue round-trip); the detached submit patches in the real id.
   * Pollers treat an empty id as "still submitting", not a lost prompt.
   */
  promptId: string;
  /** Named workflow that produced this job. */
  workflow: string;
  /** Seed used (echoed for reproduce/vary). */
  seed?: number;
  /** Positive prompt, kept for `list` / expanded rendering. */
  prompt: string;
  /** Negative prompt, if any. */
  negative?: string;
  /** Absolute directory the PNGs are written to on collect. */
  saveDir: string;
  /** Resolved `sendToModel` preference, re-evaluated against the model on collect. */
  sendToModel: boolean;
  status: ImageJobStatus;
  /** Paths written once the job is collected. */
  savedPaths: string[];
  /** Failure reason when `status === 'error'`. */
  error?: string;
  /** Epoch ms when the job was submitted. */
  startedAt: number;
  /** Epoch ms when it reached a terminal status. */
  endedAt?: number;
}

/** The whole registry: ordered jobs plus the next id to hand out. */
export interface JobRegistry {
  jobs: ImageJob[];
  nextId: number;
}

/** Fields a caller supplies when registering a freshly-submitted job. */
export interface NewJob {
  promptId: string;
  workflow: string;
  seed?: number;
  prompt: string;
  negative?: string;
  saveDir: string;
  sendToModel: boolean;
  startedAt: number;
}

/**
 * Mutable fields a `collect` / `cancel` may patch onto an existing job, plus
 * the fields a deferred background submit fills in once ComfyUI has queued the
 * graph (`promptId`) and the enhancer/graph builder have finalized the
 * rendered prompt, negative, and seed.
 */
export interface JobPatch {
  promptId?: string;
  prompt?: string;
  negative?: string;
  seed?: number;
  status?: ImageJobStatus;
  savedPaths?: string[];
  error?: string;
  endedAt?: number;
}

export function emptyRegistry(): JobRegistry {
  return { jobs: [], nextId: 1 };
}

/** The id the next {@link addJob} will assign, as a string. */
export function allocateId(reg: JobRegistry): string {
  return String(reg.nextId);
}

/**
 * Append a new running job, returning a new registry and the created
 * job. The id is taken from `reg.nextId`, which is then bumped.
 */
export function addJob(reg: JobRegistry, job: NewJob): { registry: JobRegistry; created: ImageJob } {
  const id = allocateId(reg);
  const created: ImageJob = {
    id,
    promptId: job.promptId,
    workflow: job.workflow,
    seed: job.seed,
    prompt: job.prompt,
    negative: job.negative,
    saveDir: job.saveDir,
    sendToModel: job.sendToModel,
    status: 'running',
    savedPaths: [],
    startedAt: job.startedAt,
  };
  return {
    registry: { jobs: [...reg.jobs, created], nextId: reg.nextId + 1 },
    created,
  };
}

export function findJob(reg: JobRegistry, id: string): ImageJob | undefined {
  return reg.jobs.find((j) => j.id === id);
}

/**
 * Immutably patch the job with `id`. Returns the registry unchanged when
 * no such job exists.
 */
export function updateJob(reg: JobRegistry, id: string, patch: JobPatch): JobRegistry {
  let touched = false;
  const jobs = reg.jobs.map((j) => {
    if (j.id !== id) return j;
    touched = true;
    return { ...j, ...patch };
  });
  return touched ? { ...reg, jobs } : reg;
}

/** Drop a job from the registry. */
export function removeJob(reg: JobRegistry, id: string): { registry: JobRegistry; removed: boolean } {
  const jobs = reg.jobs.filter((j) => j.id !== id);
  return { registry: { ...reg, jobs }, removed: jobs.length !== reg.jobs.length };
}

/** Jobs still awaiting collection (status `running`). */
export function runningJobs(reg: JobRegistry): ImageJob[] {
  return reg.jobs.filter((j) => j.status === 'running');
}

/** Glyph for a job status (plain text; the extension re-colors it). */
export function statusGlyph(status: ImageJobStatus): string {
  switch (status) {
    case 'running':
      return '⟳';
    case 'done':
      return '✓';
    case 'error':
      return '✗';
    case 'cancelled':
      return '◌';
  }
}

/** `1m03s` / `14s` / `0s`-style elapsed duration between two epoch-ms stamps. */
export function formatDuration(fromMs: number, toMs: number): string {
  const secs = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${String(rem).padStart(2, '0')}s`;
}

/**
 * A single-line summary of one job, e.g.
 * `[1] ✓ done · anima · seed 123 · 2 images · 14s`.
 */
export function formatJobLine(job: ImageJob, now: number): string {
  const parts = [`${statusGlyph(job.status)} ${job.status}`, job.workflow];
  if (job.seed !== undefined) parts.push(`seed ${job.seed}`);
  if (job.status === 'done') {
    const n = job.savedPaths.length;
    parts.push(`${n} image${n === 1 ? '' : 's'}`);
  }
  if (job.status === 'error' && job.error) parts.push(job.error);
  parts.push(formatDuration(job.startedAt, job.endedAt ?? now));
  return `[${job.id}] ${parts.join(' · ')}`;
}

/**
 * Short autocomplete-description hint for one job: its status plus a clipped
 * prompt snippet, e.g. `running · 1girl, solo, …`. Lets `/comfyui jobs <id>`
 * completions be told apart by content, not just by status.
 */
export function formatJobHint(job: ImageJob): string {
  const oneLine = job.prompt.replace(/\s+/g, ' ').trim();
  const snippet = oneLine.length <= 50 ? oneLine : `${oneLine.slice(0, 49)}…`;
  return snippet.length > 0 ? `${job.status} · ${snippet}` : job.status;
}

/** Multi-line listing of the whole registry, or an empty-state note. */
export function formatRegistry(reg: JobRegistry, now: number): string {
  if (reg.jobs.length === 0) return '(no background image jobs)';
  return reg.jobs.map((j) => formatJobLine(j, now)).join('\n');
}

/**
 * A compact system-prompt block reminding the model which background
 * generations are still pending, so even a weak model remembers to
 * `collect` them. Returns `undefined` when nothing is running.
 */
export function formatRunningBlock(reg: JobRegistry): string | undefined {
  const running = runningJobs(reg);
  if (running.length === 0) return undefined;
  const lines = running.map((j) => {
    const seed = j.seed !== undefined ? `, seed ${j.seed}` : '';
    return `- [${j.id}] ${j.workflow}${seed} — collect with \`image_jobs\` action collect, id ${j.id}`;
  });
  return ['## Pending image jobs', ...lines].join('\n');
}
