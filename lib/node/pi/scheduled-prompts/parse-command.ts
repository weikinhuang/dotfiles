/**
 * `/schedule` argument parsing + `/schedules` listing format for the
 * scheduled-prompts extension.
 *
 * Grammar (flags may appear in any order; the prompt is everything
 * after a bare `--`):
 *
 *   /schedule --cron "0 9 * * *" --jitter 5m --scope global \
 *             --name "morning report" -- summarize my day
 *   /schedule --every 30m -- keep the roleplay going
 *   /schedule --in 10m -- remind me to stretch
 *   /schedule --at 09:00 -- stand-up notes
 *
 * Exactly one trigger flag (`--cron` / `--every` / `--in` / `--at` /
 * `--after`) is required. Multi-token values (a cron expression) must be quoted so a
 * single token carries the whole expression. The tokenizer honors
 * single and double quotes.
 *
 * Time resolution for `--in` / `--at` is relative to an injected `now`
 * so the parser stays pure and testable.
 *
 * Pure module - no pi imports - so it is directly unit-testable.
 */

import { formatDuration, parseDuration } from './duration.ts';
import { truncate } from '../shared/strings.ts';
import {
  computeNextFire,
  describeTrigger,
  type PromptPick,
  type Schedule,
  type ScheduleScope,
  type Trigger,
} from './schedule.ts';
import { buildTriggerFromParams, type TriggerParams } from './tool.ts';

export interface ScheduleDraft {
  trigger: Trigger;
  jitterMs?: number;
  scope: ScheduleScope;
  name?: string;
  /** Primary prompt (first of the pool). */
  prompt: string;
  /** Prompt pool when more than one was given (split on `|`). */
  prompts?: string[];
  promptPick?: PromptPick;
  resetOnActivity?: boolean;
  whenIdle?: boolean;
  maxRuns?: number;
  chance?: number;
}

export type ParseResult = { ok: true; draft: ScheduleDraft } | { ok: false; error: string };

/** Default scope for the `/schedule` command when `--scope` is omitted. */
export const DEFAULT_COMMAND_SCOPE: ScheduleScope = 'session';

export const SCHEDULE_USAGE = [
  'Usage: /schedule <trigger> [options] -- <prompt>[ | <prompt> ...]',
  '',
  'Trigger (exactly one):',
  '  --cron "<m h dom mon dow>"   recurring, 5-field cron (local time)',
  '  --every <dur>                recurring interval, e.g. 30m, 2h, 1d',
  '  --in <dur>                   one-shot after a delay, e.g. 10m',
  '  --at <HH:MM>                 one-shot at the next local HH:MM',
  '  --after <min-max>            idle nudge a random gap after activity,',
  '                               e.g. 30s-5m (repeats during silence)',
  '',
  'Options:',
  '  --jitter <dur>               random extra delay added to each fire',
  '  --scope global|project|session   default: session (ephemeral)',
  '  --name "<label>"             human-readable name shown in /schedules',
  '  --max-runs <n>               retire after n fires',
  '  --chance <0..1>              only fire with this probability when due',
  '  --reset-on-activity          restart the timer when you send a message',
  '  --when-idle                  only fire while the agent is idle',
  '  --interrupt                  allow firing mid-turn (opposite of --when-idle)',
  '  --round-robin                cycle a multi-prompt pool in order (default: random)',
  '',
  'The prompt is everything after a bare `--`; split alternatives with ` | `.',
  'Prompt variables: ${t} = elapsed since last run (or last message for --after), ${d} = current time.',
].join('\n');

export const SCHEDULES_USAGE = [
  'Manage schedules:',
  '  /schedules                     list all schedules',
  '  /schedules cancel <id>         remove one schedule',
  '  /schedules clear [scope|all]   remove a whole scope (default: all)',
  '  /schedules on <id>             enable a schedule',
  '  /schedules off <id>            disable a schedule',
  '',
  'Create one with /schedule (run /schedule for usage).',
].join('\n');

/** Split a command-argument string into tokens, honoring quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function takeValue(tokens: string[], index: number, flag: string): { value: string; next: number } | string {
  const next = tokens[index + 1];
  if (next === undefined || next === '--') return `${flag} requires a value`;
  return { value: next, next: index + 1 };
}

/**
 * Parse a `/schedule` argument string into a draft or a human-readable
 * error. `now` resolves relative triggers and defaults to the current
 * time.
 */
export function parseScheduleCommand(input: string, now: Date = new Date()): ParseResult {
  const tokens = tokenize(input);
  if (tokens.length === 0) return { ok: false, error: 'no arguments' };

  // Trigger flags are collected into a `TriggerParams` and resolved once,
  // after the loop, through the shared `buildTriggerFromParams` (the same
  // builder the `schedule` LLM tool uses) so the two entry points can't
  // drift on validation, `--after` range handling, or HH:MM resolution.
  const triggerParams: TriggerParams = {};
  let jitterMs: number | undefined;
  let scope: ScheduleScope = DEFAULT_COMMAND_SCOPE;
  let name: string | undefined;
  let prompt = '';
  let prompts: string[] | undefined;
  let promptPick: PromptPick | undefined;
  let resetOnActivity: boolean | undefined;
  let whenIdle: boolean | undefined;
  let maxRuns: number | undefined;
  let chance: number | undefined;

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === '--') {
      const rest = tokens.slice(i + 1).join(' ');
      const pool = rest
        .split('|')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      prompt = pool[0] ?? '';
      if (pool.length > 1) prompts = pool;
      break;
    }
    switch (tok) {
      case '--cron': {
        const v = takeValue(tokens, i, '--cron');
        if (typeof v === 'string') return { ok: false, error: v };
        triggerParams.cron = v.value;
        i = v.next;
        break;
      }
      case '--every': {
        const v = takeValue(tokens, i, '--every');
        if (typeof v === 'string') return { ok: false, error: v };
        triggerParams.every = v.value;
        i = v.next;
        break;
      }
      case '--in': {
        const v = takeValue(tokens, i, '--in');
        if (typeof v === 'string') return { ok: false, error: v };
        triggerParams.in = v.value;
        i = v.next;
        break;
      }
      case '--at': {
        const v = takeValue(tokens, i, '--at');
        if (typeof v === 'string') return { ok: false, error: v };
        triggerParams.at = v.value;
        i = v.next;
        break;
      }
      case '--after': {
        const v = takeValue(tokens, i, '--after');
        if (typeof v === 'string') return { ok: false, error: v };
        triggerParams.after = v.value;
        i = v.next;
        break;
      }
      case '--max-runs': {
        const v = takeValue(tokens, i, '--max-runs');
        if (typeof v === 'string') return { ok: false, error: v };
        const n = Number(v.value);
        if (!Number.isInteger(n) || n <= 0)
          return { ok: false, error: `invalid --max-runs (expected a positive integer): "${v.value}"` };
        maxRuns = n;
        i = v.next;
        break;
      }
      case '--chance': {
        const v = takeValue(tokens, i, '--chance');
        if (typeof v === 'string') return { ok: false, error: v };
        const c = Number(v.value);
        if (!Number.isFinite(c) || c <= 0 || c > 1)
          return { ok: false, error: `invalid --chance (expected 0..1): "${v.value}"` };
        chance = c;
        i = v.next;
        break;
      }
      case '--reset-on-activity':
        resetOnActivity = true;
        break;
      case '--when-idle':
        whenIdle = true;
        break;
      case '--interrupt':
        whenIdle = false;
        break;
      case '--round-robin':
        promptPick = 'roundRobin';
        break;
      case '--jitter': {
        const v = takeValue(tokens, i, '--jitter');
        if (typeof v === 'string') return { ok: false, error: v };
        const ms = parseDuration(v.value);
        if (ms === null) return { ok: false, error: `invalid --jitter duration: "${v.value}"` };
        jitterMs = ms;
        i = v.next;
        break;
      }
      case '--scope': {
        const v = takeValue(tokens, i, '--scope');
        if (typeof v === 'string') return { ok: false, error: v };
        if (v.value !== 'global' && v.value !== 'project' && v.value !== 'session') {
          return { ok: false, error: `invalid --scope: "${v.value}" (expected global|project|session)` };
        }
        scope = v.value;
        i = v.next;
        break;
      }
      case '--name': {
        const v = takeValue(tokens, i, '--name');
        if (typeof v === 'string') return { ok: false, error: v };
        name = v.value;
        i = v.next;
        break;
      }
      default:
        return { ok: false, error: `unknown argument: "${tok}"` };
    }
    i++;
  }

  const built = buildTriggerFromParams(triggerParams, now.getTime());
  if ('error' in built) {
    return { ok: false, error: built.error };
  }
  if (prompt.trim().length === 0) {
    return { ok: false, error: 'a prompt is required after `--`' };
  }
  return {
    ok: true,
    draft: {
      trigger: built.trigger,
      jitterMs,
      scope,
      name,
      prompt: prompt.trim(),
      prompts,
      promptPick,
      resetOnActivity,
      whenIdle,
      maxRuns,
      chance,
    },
  };
}

function formatNextFire(schedule: Schedule, now: number): string {
  if (!schedule.enabled) return 'disabled';
  const at = schedule.nextFireAt ?? computeNextFire(schedule, new Date(now)) ?? undefined;
  if (at === undefined) return 'done';
  const delta = at - now;
  if (delta <= 0) return 'due now';
  return `in ${formatDuration(delta)} (${new Date(at).toLocaleString()})`;
}

/** Render one schedule as a two-line listing entry. */
export function formatScheduleLine(schedule: Schedule, now: number): string {
  const flag = schedule.enabled ? '' : ' [off]';
  const label = schedule.name ? ` "${schedule.name}"` : '';
  const attrs: string[] = [];
  if (schedule.chance !== undefined) attrs.push(`chance ${Math.round(schedule.chance * 100)}%`);
  if (schedule.resetOnActivity) attrs.push('reset-on-activity');
  if (schedule.whenIdle) attrs.push('when-idle');
  const attrStr = attrs.length > 0 ? `  [${attrs.join(', ')}]` : '';
  const head = `  ${schedule.id}${label}${flag} - ${describeTrigger(schedule.trigger)}${attrStr}`;
  const runs = schedule.maxRuns !== undefined ? `${schedule.runCount}/${schedule.maxRuns}` : `${schedule.runCount}`;
  const meta = `      next: ${formatNextFire(schedule, now)}  runs: ${runs}`;
  const pool = schedule.prompts && schedule.prompts.length > 1 ? ` (+${schedule.prompts.length - 1} more)` : '';
  const body = `      prompt: ${truncate(schedule.prompt, 80, { collapseWhitespace: true })}${pool}`;
  return `${head}\n${meta}\n${body}`;
}

/** Render the full `/schedules` listing, grouped by scope. */
export function formatScheduleList(schedules: Schedule[], now: number): string {
  if (schedules.length === 0) return 'No schedules. Create one with /schedule (see /schedule for usage).';
  const groups: { scope: ScheduleScope; title: string }[] = [
    { scope: 'global', title: 'Global (persisted, all sessions)' },
    { scope: 'project', title: 'Project (persisted, this workspace)' },
    { scope: 'session', title: 'Session (ephemeral)' },
  ];
  const parts: string[] = [];
  for (const { scope, title } of groups) {
    const inScope = schedules.filter((s) => s.scope === scope);
    if (inScope.length === 0) continue;
    parts.push(`${title}:`);
    for (const s of inScope) parts.push(formatScheduleLine(s, now));
  }
  return parts.join('\n');
}
