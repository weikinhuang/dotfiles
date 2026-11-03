/**
 * `renderCall` / `renderResult` formatters for the comfyui extension's two
 * tools. Pure of session state - they read only the tool args, the result
 * `details`, and the render options/context - but live under `ext/` because
 * they build `pi-tui` `Text` components.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

import { formatDuration, formatJobLine } from '../../comfyui/jobs.ts';
import { mediaCountNote } from '../../comfyui/summary.ts';
import type { GenerateDetails, GenerateLiveCard, JobsDetails } from './details.ts';

/** Render options (`expanded`, partial flags) - structural subset we use. */
interface RenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}
/** Render context (`args`, partial flag) - structural subset we use. */
interface RenderContext {
  args?: Record<string, unknown>;
  isPartial?: boolean;
}
interface ToolResultLike {
  details?: unknown;
}

// ── generate_image ─────────────────────────────────────────────────────

export function renderGenerateCall(args: unknown, theme: Theme): Text {
  const input = args as { prompt?: string; workflowFile?: string };
  const prompt = (input.workflowFile ?? input.prompt ?? '').replace(/\s+/g, ' ').trim();
  const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  const head = theme.fg('toolTitle', theme.bold('generate_image '));
  return new Text(`${head}${theme.fg('dim', preview)}`, 0, 0);
}

/** Render only text, never an unsolicited image/video/audio attachment. */
function renderGenerateLiveCard(live: GenerateLiveCard, options: RenderOptions, theme: Theme): Text {
  const { job } = live;
  const status = job.status === 'running' && !job.promptId ? 'queued' : job.status;
  const glyph = status === 'done' ? '✓' : status === 'error' ? '✗' : status === 'cancelled' ? '◌' : '⟳';
  const color = status === 'done' ? 'success' : status === 'error' ? 'error' : 'accent';
  const seed = job.seed !== undefined ? ` · seed ${job.seed}` : '';
  const elapsed = formatDuration(0, live.elapsedMs);
  const note =
    status === 'done'
      ? `${mediaCountNote(job.savedPaths)}${job.savedPaths[0] ? ` · ${job.savedPaths[0]}` : ''}`
      : status === 'error'
        ? job.error
        : status === 'cancelled'
          ? undefined
          : live.progress;
  const summary =
    theme.fg(color, `${glyph} background [${job.id}] ${status}`) +
    theme.fg('dim', ` · ${elapsed}${seed}${note ? ` · ${note}` : ''}`);
  if (!options.expanded) return new Text(summary, 0, 0);
  const label = (text: string): string => theme.fg('dim', text);
  const lines = [summary, `${label('workflow: ')}${job.workflowFile ?? job.workflow}`];
  if (job.promptId) lines.push(`${label('prompt id: ')}${job.promptId}`);
  if (job.prompt) lines.push(`${label('prompt:   ')}${job.prompt}`);
  if (!job.workflowFile) lines.push(`${label('negative: ')}${job.negative ?? '(workflow default)'}`);
  if (job.status === 'done' && live.progress && job.managed) lines.push(`${label('refine:   ')}${live.progress}`);
  for (const path of job.savedPaths) lines.push(`${label('saved:    ')}${path}`);
  return new Text(lines.join('\n'), 0, 0);
}

export function renderGenerateResult(
  result: ToolResultLike,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
  live?: GenerateLiveCard,
): Text {
  if (live) return renderGenerateLiveCard(live, options, theme);
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
  const idNote = details.generationId ? ` [${details.generationId}]` : '';
  const countNote =
    details.savedPaths === undefined ? `${n} image${n === 1 ? '' : 's'}` : mediaCountNote(details.savedPaths);
  const summary = theme.fg('success', `✓${idNote} ${countNote}${seedNote}`) + ephemeralNote;
  if (!options.expanded) return new Text(summary, 0, 0);

  // Expanded (ctrl+o): show the full positive / negative prompt and paths.
  const args = (context.args ?? {}) as { prompt?: string; negative?: string };
  const label = (text: string): string => theme.fg('dim', text);
  const lines = [summary];
  if (args.prompt) lines.push(`${label('prompt:   ')}${args.prompt}`);
  lines.push(`${label('negative: ')}${args.negative ?? '(workflow default)'}`);
  for (const p of details.savedPaths ?? []) lines.push(`${label('saved:    ')}${p}`);
  return new Text(lines.join('\n'), 0, 0);
}

// ── image_jobs ─────────────────────────────────────────────────────────

export function renderJobsCall(args: unknown, theme: Theme): Text {
  const action = (args as { action?: string }).action ?? '';
  const id = (args as { id?: string }).id;
  let text = theme.fg('toolTitle', theme.bold('image_jobs ')) + theme.fg('muted', action);
  if (id) text += ` ${theme.fg('accent', `[${id}]`)}`;
  return new Text(text, 0, 0);
}

export function renderJobsResult(result: ToolResultLike, theme: Theme): Text {
  const details = (result.details ?? {}) as Partial<JobsDetails>;
  if (details.error) return new Text(theme.fg('error', `✗ ${details.error}`), 0, 0);

  if (details.action === 'list') {
    const jobs = details.jobs ?? [];
    if (jobs.length === 0) return new Text(theme.fg('dim', '(no background media jobs)'), 0, 0);
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
      const paths = details.savedPaths ?? [];
      const countNote = paths.length > 0 ? mediaCountNote(paths) : '0 images';
      return new Text(theme.fg('success', `✓ [${id}] ${countNote}`), 0, 0);
    }
    default:
      return new Text(theme.fg('dim', `[${id}]`), 0, 0);
  }
}
