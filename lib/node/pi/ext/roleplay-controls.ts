import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ReminderMessage } from '../context-reminder.ts';
import { messageSummaryText } from '../roleplay/context-window.ts';
import {
  EXTRACTION_JOB_ENTRY,
  formatExtractionJobs,
  pendingExtractionJobs,
  resolveExtractionSpan,
  scanExtractionJobs,
  updateExtractionStage,
  type ExtractionJob,
  type ExtractionKind,
} from '../roleplay/extraction-jobs.ts';
import { planFactReconcile } from '../roleplay/fact-branch.ts';
import { escapeRoleplayReportText as localText } from '../roleplay/report-text.ts';
import { ROLEPLAY_POLICY_ENTRY, sceneOpenerRange, type EffectiveRoleplayPolicy } from '../roleplay/retention-policy.ts';
import { latestSceneBoundary } from '../roleplay/scene-state.ts';
import type { SummarizableMessage } from '../roleplay/summarize.ts';
import { renderTimelineBlock } from '../roleplay/timeline.ts';

export interface RoleplayControlsSource {
  cast: () => string | null;
  memory: (ctx: ExtensionContext) => { recap: string; timeline: string };
  timelineMaxChars?: () => number;
  scene: (ctx: ExtensionContext) => readonly ReminderMessage[];
  policy: (ctx: ExtensionContext) => EffectiveRoleplayPolicy;
  inFlight: () => boolean;
  runTask: (
    ctx: ExtensionContext,
    task: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) => Promise<void>;
  recapNow: (ctx: ExtensionContext, signal: AbortSignal, current: () => boolean) => Promise<void>;
  runJob: (
    ctx: ExtensionContext,
    job: ExtractionJob,
    span: SummarizableMessage[],
    signal: AbortSignal,
    current: () => boolean,
    kinds?: readonly ExtractionKind[],
  ) => Promise<void>;
  sanitize: (messages: readonly ReminderMessage[], ctx: ExtensionContext) => readonly ReminderMessage[] | null;
}

function sceneBranch(ctx: ExtensionContext): Record<string, unknown>[] {
  const entries = ctx.sessionManager.getBranch() as unknown as Record<string, unknown>[];
  const boundary = latestSceneBoundary(entries);
  return boundary ? entries.slice(entries.indexOf(boundary) + 1) : entries;
}

/** Local inspection/policy controls. Only explicit recap now / queue work invokes a model through runTask. */
export function createRoleplayControls(
  pi: ExtensionAPI,
  source: RoleplayControlsSource,
): {
  handle(verb: string, args: readonly string[], ctx: ExtensionContext): Promise<boolean>;
} {
  const handle = async (verb: string, args: readonly string[], ctx: ExtensionContext): Promise<boolean> => {
    if (
      !['summary', 'timeline', 'facts', 'budget', 'opener', 'jobs'].includes(verb) &&
      !(verb === 'recap' && args[0] === 'now')
    )
      return false;
    const notify = (text: string): void => ctx.ui.notify(localText(text), 'info');
    const usage = (text: string): true => {
      ctx.ui.notify(`Usage: /roleplay ${text}`, 'warning');
      return true;
    };
    const cast = source.cast();
    if (!cast) {
      notify('Roleplay controls are dormant: select a roleplay persona first.');
      return true;
    }
    if (verb === 'summary') {
      if (args.length) return usage('summary (sensitive local recap text; no model call)');
      notify(`Roleplay summary (sensitive local text)\n${source.memory(ctx).recap || '(no recap available)'}`);
    } else if (verb === 'timeline') {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--all')) return usage('timeline [--all]');
      const timeline = source.memory(ctx).timeline;
      const preview =
        (args.length ? timeline : renderTimelineBlock(timeline, { maxChars: source.timelineMaxChars?.() })) ?? '';
      notify(
        `Roleplay timeline (${args.length ? 'all local text' : 'injection preview, capped'})\n${preview === '' ? '(no timeline available)' : preview}`,
      );
    } else if (verb === 'facts') {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--content')) return usage('facts [--content]');
      // Reuse the capture parser/reducer, but never read the shared note tier or sibling entries.
      const branch = sceneBranch(ctx);
      const facts = planFactReconcile(branch, branch, cast).keep;
      notify(
        args.length
          ? `Roleplay facts (sensitive local text): ${facts.length}\n${facts.map((fact, i) => `${i + 1}. ${fact.name}\n${fact.description}`).join('\n')}`
          : `Roleplay facts: ${facts.length} active-scene captures; ${facts.reduce((sum, fact) => sum + fact.description.length, 0)} description chars. Use facts --content for sensitive local text. Legacy untracked notes are not enumerated.`,
      );
    } else if (verb === 'budget') {
      if (args.length) {
        const off = args.length === 1 && args[0] === 'off';
        const target = args.length === 2 && args[0] === 'set' && /^\d+$/.test(args[1]) ? Number(args[1]) : NaN;
        if (!off && (!Number.isSafeInteger(target) || target < 1024))
          return usage('budget [set N|off] (N must be an integer >= 1024)');
        pi.appendEntry(ROLEPLAY_POLICY_ENTRY, { cast, target: off ? 0 : target });
        notify(
          off
            ? 'Prompt token target disabled for this scene/branch.'
            : `Prompt token target set to ${target} for this scene/branch (soft target, not a hard context limit).`,
        );
      } else {
        const target = source.policy(ctx).target;
        notify(`Prompt token target: ${target || 'off'} (soft full-input target; scene/branch policy).`);
      }
    } else if (verb === 'opener') {
      const command = args[0] ?? 'show';
      if (
        !((command === 'show' || command === 'unpin') && args.length <= 1) &&
        !(command === 'pin' && (args.length === 1 || (args.length === 2 && args[1] === 'reply')))
      )
        return usage('opener [show|pin [reply]|unpin]');
      if (command !== 'show') {
        pi.appendEntry(ROLEPLAY_POLICY_ENTRY, {
          cast,
          pin: command === 'pin',
          includeReply: command === 'pin' && args[1] === 'reply',
        });
        notify(
          command === 'pin'
            ? `Scene opener pinned${args[1] === 'reply' ? ' with its complete reply' : ''} for this scene/branch.`
            : 'Scene opener unpinned for this scene/branch.',
        );
      } else {
        const policy = source.policy(ctx);
        const scene = source.scene(ctx);
        const range = sceneOpenerRange(scene, policy.includeReply);
        notify(
          `Scene opener: ${range ? `available; ${range.to - range.from} message(s); ${scene.slice(range.from, range.to).reduce((sum, message) => sum + messageSummaryText(message).length, 0)} text chars` : 'unavailable'}; pin ${policy.pin ? 'on' : 'off'}; include reply ${policy.includeReply ? 'on' : 'off'}. Content and identities are not shown.`,
        );
      }
    } else if (verb === 'recap') {
      if (args.length !== 1) return usage('recap now');
      await source.runTask(ctx, (signal, current) => source.recapNow(ctx, signal, current));
    } else {
      if (!args.length) {
        const jobs = scanExtractionJobs(sceneBranch(ctx), cast, { restore: !source.inFlight() });
        notify(
          `Roleplay extraction jobs${source.inFlight() ? ' (work in flight)' : ''}\n${formatExtractionJobs(jobs) || 'No queued jobs. Legacy coverage gaps are not backfilled.'}`,
        );
        return true;
      }
      const retry = args.length === 2 && args[0] === 'retry' && ['facts', 'timeline', 'all'].includes(args[1]);
      if (!(args.length === 1 && args[0] === 'drain') && !retry)
        return usage('jobs [retry facts|timeline|all|drain] (explicit model work)');
      const kind = retry ? (args[1] as ExtractionKind | 'all') : 'all';
      await source.runTask(ctx, async (signal, current) => {
        if (!current() || signal.aborted || source.cast() !== cast) return;
        const jobs = pendingExtractionJobs(scanExtractionJobs(sceneBranch(ctx), cast), kind);
        // Each job shares the extraction endpoint, so keep the queue strictly serial.
        const runNext = async (index: number): Promise<boolean> => {
          let job = jobs[index];
          if (!job) return true;
          if (!current() || signal.aborted || source.cast() !== cast) return false;
          const kinds = (kind === 'all' ? (['facts', 'timeline'] as const) : [kind]).filter((stage) =>
            ['pending', 'failed', 'interrupted'].includes(job[stage].status),
          );
          const original = resolveExtractionSpan(job, source.scene(ctx));
          const sanitized = original ? source.sanitize(original, ctx) : null;
          if (!current() || signal.aborted || source.cast() !== cast) return false;
          if (!sanitized) {
            for (const stage of kinds)
              job = updateExtractionStage(
                job,
                stage,
                'failed',
                Math.max(Date.now(), job.updatedAt),
                'span-unavailable',
              );
            pi.appendEntry(EXTRACTION_JOB_ENTRY, job);
            return runNext(index + 1);
          }
          const span = sanitized.map((message) => ({
            role: typeof message.role === 'string' ? message.role : 'unknown',
            text: messageSummaryText(message),
          }));
          await source.runJob(ctx, job, span, signal, current, kinds);
          return runNext(index + 1);
        };
        const finished = await runNext(0);
        if (finished && current() && !signal.aborted)
          notify(
            `Extraction queue pass finished: ${jobs.length} queued job(s) selected. No legacy gaps were backfilled; inspect jobs for outcomes.`,
          );
      });
    }
    return true;
  };
  return { handle };
}
