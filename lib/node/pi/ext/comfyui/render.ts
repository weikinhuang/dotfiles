/**
 * `renderCall` / `renderResult` formatters for the comfyui extension's two
 * tools. Pure of session state - they read only the tool args, the result
 * `details`, and the render options/context - but live under `ext/` because
 * they build `pi-tui` `Text` components.
 */

import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

import { formatJobLine } from '../../comfyui/jobs.ts';
import type { GenerateDetails, JobsDetails } from './details.ts';

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
  const prompt = ((args as { prompt?: string }).prompt ?? '').replace(/\s+/g, ' ').trim();
  const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  const head = theme.fg('toolTitle', theme.bold('generate_image '));
  return new Text(`${head}${theme.fg('dim', preview)}`, 0, 0);
}

export function renderGenerateResult(
  result: ToolResultLike,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Text {
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
  const summary = theme.fg('success', `✓${idNote} ${n} image${n === 1 ? '' : 's'}${seedNote}`) + ephemeralNote;
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
}
