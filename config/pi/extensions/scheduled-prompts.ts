/**
 * Scheduled prompts for pi - fire recurring or one-shot prompts at the
 * agent on a timer, the way you would type them yourself.
 *
 * Use cases: a roleplay character that keeps a conversation going
 * without a nudge, a "morning report" while pi is left running, a
 * periodic "summarize what changed" ping, etc. A fired prompt is
 * delivered via `pi.sendUserMessage`, which always triggers a turn even
 * when the agent is idle, so it lands exactly like user input.
 *
 * Three scopes:
 *   - global   `~/.pi/agent/scheduled-prompts.json`  (every session)
 *   - project  `<cwd>/.pi/scheduled-prompts.json`    (this workspace)
 *   - session  in-process only, dies when this session ends
 *
 * Three trigger kinds (each with optional `--jitter`):
 *   - cron      5-field expression in local time
 *   - interval  `--every 30m`
 *   - once      `--in 10m` / `--at 09:00`
 *
 * Surfaces:
 *   - `/schedule`   create a schedule
 *   - `/schedules`  list / cancel / clear / on / off
 *   - `schedule`    LLM-callable tool (create|list|update|delete) so the
 *                   agent can queue its own next beat
 *
 * All scheduling logic (cron, durations, the schedule model, the
 * command parser, persistence) lives in pure, unit-tested helpers under
 * `../../../lib/node/pi/scheduled-prompts/`; this file is the pi-coupled
 * glue: timers, delivery, command/tool registration.
 *
 * The scheduler's timer handle and the ephemeral session schedules are
 * anchored in a process-global slot (see `global-slot.ts`) so a
 * `/reload` - which re-instantiates the extension - can clear the stale
 * timer and re-arm cleanly while session schedules survive the reload
 * (they only die on a real session end).
 *
 * Environment:
 *   PI_SCHEDULED_PROMPTS_DISABLED=1   skip the extension entirely.
 *   PI_SCHEDULED_PROMPTS_DEBUG=1      log scheduler decisions to stderr.
 */

import { StringEnum } from '@earendil-works/pi-ai';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { createGlobalSlot } from '../../../lib/node/pi/global-slot.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { formatDuration, parseDuration } from '../../../lib/node/pi/scheduled-prompts/duration.ts';
import {
  computeNextFire,
  describeTrigger,
  makeScheduleId,
  recordRun,
  reconcileSchedule,
  type Schedule,
  type ScheduleScope,
  type Trigger,
} from '../../../lib/node/pi/scheduled-prompts/schedule.ts';
import { parseCron } from '../../../lib/node/pi/scheduled-prompts/cron.ts';
import {
  formatScheduleList,
  parseScheduleCommand,
  SCHEDULE_USAGE,
  SCHEDULES_USAGE,
} from '../../../lib/node/pi/scheduled-prompts/parse-command.ts';
import {
  addToList,
  findById,
  globalSchedulesPath,
  projectSchedulesPath,
  readScopeFile,
  removeFromList,
  updateInList,
  writeScopeFile,
} from '../../../lib/node/pi/scheduled-prompts/store.ts';

// `setTimeout` clamps delays above ~24.8 days (2^31-1 ms) to 1ms, which
// would fire a long-range schedule immediately. We cap the timer at the
// max and rely on `onTimer` finding nothing due, then re-arming.
const MAX_TIMEOUT = 2_147_483_647;
// Fire schedules whose target is within this window of the wake-up, to
// absorb timer slop.
const FIRE_SLOP_MS = 1_000;

interface SchedulerSlot {
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Ephemeral session-scope schedules; survive reload, die on quit. */
  sessions: Schedule[];
}

const getSlot = createGlobalSlot<SchedulerSlot>('@dotfiles/pi/scheduled-prompts', () => ({
  timer: undefined,
  sessions: [],
}));

export default function scheduledPromptsExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_SCHEDULED_PROMPTS_DISABLED)) return;

  const debugEnabled = envTruthy(process.env.PI_SCHEDULED_PROMPTS_DEBUG);
  const debug = (msg: string): void => {
    if (debugEnabled) process.stderr.write(`[scheduled-prompts] ${msg}\n`);
  };

  let currentCtx: ExtensionContext | undefined;
  let cwd = process.cwd();

  // ── Per-scope persistence (session lives in the slot) ───────────────

  const loadGlobal = (): Schedule[] => readScopeFile(globalSchedulesPath());
  const saveGlobal = (list: Schedule[]): void => writeScopeFile(globalSchedulesPath(), list);
  const loadProject = (): Schedule[] => readScopeFile(projectSchedulesPath(cwd));
  const saveProject = (list: Schedule[]): void => writeScopeFile(projectSchedulesPath(cwd), list);

  const readScope = (scope: ScheduleScope): Schedule[] => {
    if (scope === 'session') return getSlot().sessions;
    return scope === 'global' ? loadGlobal() : loadProject();
  };

  const writeScope = (scope: ScheduleScope, list: Schedule[]): void => {
    if (scope === 'session') {
      getSlot().sessions = list;
      return;
    }
    if (scope === 'global') saveGlobal(list);
    else saveProject(list);
  };

  const collectAll = (): Schedule[] => [...loadGlobal(), ...loadProject(), ...getSlot().sessions];

  // ── Scheduler ───────────────────────────────────────────────────────

  const deliver = (schedule: Schedule): void => {
    const named = schedule.name ? ` (${schedule.name})` : '';
    try {
      if (!currentCtx || currentCtx.isIdle()) {
        pi.sendUserMessage(schedule.prompt);
      } else {
        pi.sendUserMessage(schedule.prompt, { deliverAs: 'followUp' });
      }
      debug(`fired ${schedule.id}${named}`);
      currentCtx?.ui.notify(`scheduled-prompts: fired ${schedule.id}${named}`, 'info');
    } catch (e) {
      debug(`delivery failed for ${schedule.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Fire any due schedules in `scope`, persisting run bookkeeping (and
  // removing spent one-shots). Returns nothing; re-arm happens after.
  //
  // Fires on the *cached* `nextFireAt`: the timer always wakes a hair
  // after the target, so `nextFireAt` is slightly in the past here. We
  // must NOT reconcile-forward at this point (that would roll a
  // recurring schedule to its next occurrence and skip the fire we just
  // woke for). Schedules missed while pi was closed are skipped earlier,
  // at `session_start`, where the reconciliation is persisted.
  const fireDueInScope = (scope: ScheduleScope, now: number): void => {
    const list = readScope(scope);
    let next = list;
    let changed = false;
    for (const s of list) {
      if (!s.enabled || s.nextFireAt === undefined) continue;
      if (s.nextFireAt > now + FIRE_SLOP_MS) continue;
      deliver(s);
      const ran = recordRun(s, now);
      if (ran.trigger.kind === 'once') {
        next = removeFromList(next, s.id).list;
      } else {
        next = updateInList(next, s.id, ran).list;
      }
      changed = true;
    }
    if (changed) writeScope(scope, next);
  };

  // Bring every cached `nextFireAt` up to date for `now` and persist the
  // result. Recurring schedules whose cached target fell into the past
  // (a fire missed while pi was closed) are rolled forward to their next
  // occurrence here, so the live fire path can trust cached targets.
  const reconcileScopePersist = (scope: ScheduleScope, now: number): void => {
    const list = readScope(scope);
    let changed = false;
    const next = list.map((s) => {
      const r = reconcileSchedule(s, now);
      if (r !== s) changed = true;
      return r;
    });
    if (changed) writeScope(scope, next);
  };

  const fireAllDue = (): void => {
    const now = Date.now();
    fireDueInScope('global', now);
    fireDueInScope('project', now);
    fireDueInScope('session', now);
  };

  const rearm = (): void => {
    const slot = getSlot();
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    const now = Date.now();
    let soonest: number | undefined;
    for (const original of collectAll()) {
      const s = reconcileSchedule(original, now);
      if (!s.enabled || s.nextFireAt === undefined) continue;
      if (soonest === undefined || s.nextFireAt < soonest) soonest = s.nextFireAt;
    }
    if (soonest === undefined) {
      debug('no schedules armed');
      return;
    }
    const delay = Math.min(Math.max(soonest - now, 0), MAX_TIMEOUT);
    debug(`armed: next fire in ${formatDuration(delay)}`);
    const timer = setTimeout(() => {
      fireAllDue();
      rearm();
    }, delay);
    // Don't let an armed timer hold the process open on its own.
    if (typeof timer.unref === 'function') timer.unref();
    slot.timer = timer;
  };

  // ── Mutations ────────────────────────────────────────────────────────

  const addSchedule = (schedule: Schedule): void => {
    writeScope(schedule.scope, addToList(readScope(schedule.scope), schedule));
  };

  const removeById = (id: string): Schedule | undefined => {
    for (const scope of ['session', 'global', 'project'] as const) {
      const { list, removed } = removeFromList(readScope(scope), id);
      if (removed) {
        writeScope(scope, list);
        return removed;
      }
    }
    return undefined;
  };

  // Recompute nextFireAt for a freshly patched schedule.
  const reconcileEnabled = (schedule: Schedule): Schedule => {
    if (!schedule.enabled) return { ...schedule, nextFireAt: undefined };
    const next = computeNextFire(schedule, new Date());
    return { ...schedule, nextFireAt: next ?? undefined };
  };

  const updateById = (id: string, patch: Partial<Schedule>): Schedule | undefined => {
    for (const scope of ['session', 'global', 'project'] as const) {
      const list = readScope(scope);
      if (!findById(list, id)) continue;
      const { list: patched, updated } = updateInList(list, id, patch);
      if (!updated) continue;
      const reconciled = reconcileEnabled(updated);
      const final = updateInList(patched, id, reconciled).list;
      writeScope(scope, final);
      return reconciled;
    }
    return undefined;
  };

  const clearScopes = (scope: ScheduleScope | 'all'): number => {
    const scopes: ScheduleScope[] = scope === 'all' ? ['session', 'global', 'project'] : [scope];
    let count = 0;
    for (const s of scopes) {
      count += readScope(s).length;
      writeScope(s, []);
    }
    return count;
  };

  const describeNext = (schedule: Schedule): string => {
    if (!schedule.enabled) return 'disabled';
    if (schedule.nextFireAt === undefined) return 'not scheduled';
    const delta = schedule.nextFireAt - Date.now();
    if (delta <= 0) return 'due now';
    return `in ${formatDuration(delta)} (${new Date(schedule.nextFireAt).toLocaleString()})`;
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx;
    cwd = ctx.cwd;
    const now = Date.now();
    reconcileScopePersist('global', now);
    reconcileScopePersist('project', now);
    reconcileScopePersist('session', now);
    rearm();
  });

  pi.on('session_shutdown', (event) => {
    const slot = getSlot();
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    // Session schedules survive a reload (same session, re-instantiated
    // extension) but die on any real session end.
    if (event.reason !== 'reload') slot.sessions = [];
  });

  // ── /schedule command ─────────────────────────────────────────────────

  pi.registerCommand('schedule', {
    description: 'Schedule a recurring/one-shot prompt: /schedule --cron|--every|--in|--at ... -- <prompt>',
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      currentCtx = ctx;
      const trimmed = (args ?? '').trim();
      if (trimmed.length === 0) {
        ctx.ui.notify(SCHEDULE_USAGE, 'info');
        return;
      }
      const result = parseScheduleCommand(args);
      if (!result.ok) {
        ctx.ui.notify(`schedule: ${result.error}\n\n${SCHEDULE_USAGE}`, 'warning');
        return;
      }
      const { draft } = result;
      const now = Date.now();
      const schedule: Schedule = {
        id: makeScheduleId(),
        name: draft.name,
        prompt: draft.prompt,
        trigger: draft.trigger,
        jitterMs: draft.jitterMs,
        scope: draft.scope,
        enabled: true,
        createdAt: now,
        runCount: 0,
      };
      schedule.nextFireAt = computeNextFire(schedule, new Date(now)) ?? undefined;
      addSchedule(schedule);
      rearm();
      ctx.ui.notify(
        `Scheduled ${schedule.id} [${schedule.scope}] ${describeTrigger(schedule.trigger)} - next ${describeNext(schedule)}`,
        'info',
      );
    },
  });

  // ── /schedules command ─────────────────────────────────────────────────

  const SUBVERBS = ['cancel', 'clear', 'on', 'off'];

  pi.registerCommand('schedules', {
    description: 'List schedules; subverbs: cancel <id>, clear [scope], on <id>, off <id>',
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.split(/\s+/);
      if (parts.length <= 1) {
        const verbs = SUBVERBS.filter((v) => v.startsWith(parts[0] ?? ''));
        return verbs.map((v) => ({ value: v, label: v }));
      }
      const verb = parts[0];
      const tail = parts[parts.length - 1];
      // pi replaces the whole argument string (everything after the
      // command name) with the chosen completion's `value`, so each
      // value must include the verb - not just the id/scope - or the
      // verb is dropped from the submitted line.
      if (verb === 'clear') {
        return ['global', 'project', 'session', 'all']
          .filter((s) => s.startsWith(tail))
          .map((s) => ({ value: `clear ${s}`, label: s }));
      }
      if (verb === 'cancel' || verb === 'on' || verb === 'off') {
        return collectAll()
          .filter((s) => s.id.startsWith(tail))
          .map((s) => ({ value: `${verb} ${s.id}`, label: s.id, description: describeTrigger(s.trigger) }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      currentCtx = ctx;
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
      const verb = tokens[0];

      if (!verb) {
        const now = Date.now();
        const reconciled = collectAll().map((s) => reconcileSchedule(s, now));
        ctx.ui.notify(`${formatScheduleList(reconciled, now)}\n\n${SCHEDULES_USAGE}`, 'info');
        return;
      }

      if (verb === 'cancel') {
        const id = tokens[1];
        if (!id) {
          ctx.ui.notify('Usage: /schedules cancel <id>', 'warning');
          return;
        }
        const removed = removeById(id);
        rearm();
        ctx.ui.notify(removed ? `Cancelled ${id}.` : `No schedule with id "${id}".`, removed ? 'info' : 'warning');
        return;
      }

      if (verb === 'clear') {
        const scopeArg = tokens[1];
        if (scopeArg && !['global', 'project', 'session', 'all'].includes(scopeArg)) {
          ctx.ui.notify(`Unknown scope "${scopeArg}". Use global|project|session|all.`, 'warning');
          return;
        }
        const target = (scopeArg as ScheduleScope | 'all' | undefined) ?? 'all';
        const count = clearScopes(target);
        rearm();
        ctx.ui.notify(`Cleared ${count} schedule(s) from ${target}.`, 'info');
        return;
      }

      if (verb === 'on' || verb === 'off') {
        const id = tokens[1];
        if (!id) {
          ctx.ui.notify(`Usage: /schedules ${verb} <id>`, 'warning');
          return;
        }
        const updated = updateById(id, { enabled: verb === 'on' });
        rearm();
        if (!updated) {
          ctx.ui.notify(`No schedule with id "${id}".`, 'warning');
          return;
        }
        ctx.ui.notify(`${verb === 'on' ? 'Enabled' : 'Disabled'} ${id} - next ${describeNext(updated)}`, 'info');
        return;
      }

      ctx.ui.notify(`Unknown subcommand "${verb}". Usage: /schedules [cancel|clear|on|off] ...`, 'warning');
    },
  });

  // ── schedule tool ───────────────────────────────────────────────────────

  const ScheduleToolParams = Type.Object({
    action: StringEnum(['create', 'list', 'update', 'delete'] as const),
    cron: Type.Optional(Type.String({ description: '5-field cron expression, e.g. "0 9 * * *" (create/update).' })),
    every: Type.Optional(Type.String({ description: 'Interval like 30m, 2h, 1d (create/update).' })),
    in: Type.Optional(Type.String({ description: 'One-shot delay like 10m (create/update).' })),
    at: Type.Optional(Type.String({ description: 'One-shot local time HH:MM (create/update).' })),
    jitter: Type.Optional(Type.String({ description: 'Random extra delay added to each fire, e.g. 5m.' })),
    scope: Type.Optional(
      StringEnum(['global', 'project', 'session'] as const, {
        description: 'Persistence scope. Defaults to session (ephemeral) for tool-created schedules.',
      }),
    ),
    name: Type.Optional(Type.String({ description: 'Human-readable label shown in /schedules.' })),
    prompt: Type.Optional(Type.String({ description: 'The prompt text to fire (required for create).' })),
    id: Type.Optional(Type.String({ description: 'Schedule id (required for update/delete).' })),
    enabled: Type.Optional(Type.Boolean({ description: 'Enable/disable a schedule (update).' })),
  });

  interface ScheduleToolParamsT {
    action: 'create' | 'list' | 'update' | 'delete';
    cron?: string;
    every?: string;
    in?: string;
    at?: string;
    jitter?: string;
    scope?: ScheduleScope;
    name?: string;
    prompt?: string;
    id?: string;
    enabled?: boolean;
  }

  const buildTrigger = (params: ScheduleToolParamsT, now: number): { trigger: Trigger } | { error: string } => {
    const provided = [params.cron, params.every, params.in, params.at].filter((v) => v !== undefined);
    if (provided.length === 0) return { error: 'a trigger is required (cron, every, in, or at)' };
    if (provided.length > 1) return { error: 'only one trigger may be set (cron, every, in, or at)' };
    if (params.cron !== undefined) {
      if (parseCron(params.cron) === null) return { error: `invalid cron expression: "${params.cron}"` };
      return { trigger: { kind: 'cron', expr: params.cron.trim() } };
    }
    if (params.every !== undefined) {
      const ms = parseDuration(params.every);
      if (ms === null) return { error: `invalid every duration: "${params.every}"` };
      return { trigger: { kind: 'interval', ms } };
    }
    if (params.in !== undefined) {
      const ms = parseDuration(params.in);
      if (ms === null) return { error: `invalid in duration: "${params.in}"` };
      return { trigger: { kind: 'once', at: now + ms } };
    }
    const match = /^(\d{1,2}):(\d{2})$/.exec((params.at ?? '').trim());
    if (!match) return { error: `invalid at time (expected HH:MM): "${params.at}"` };
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return { error: `invalid at time (expected HH:MM): "${params.at}"` };
    const d = new Date(now);
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return { trigger: { kind: 'once', at: target.getTime() } };
  };

  const toolCreate = (params: ScheduleToolParamsT): { content: string; isError?: boolean } => {
    if (!params.prompt || params.prompt.trim().length === 0) {
      return { content: 'Error: `prompt` is required for create.', isError: true };
    }
    const now = Date.now();
    const built = buildTrigger(params, now);
    if ('error' in built) return { content: `Error: ${built.error}`, isError: true };
    let jitterMs: number | undefined;
    if (params.jitter !== undefined) {
      const j = parseDuration(params.jitter);
      if (j === null) return { content: `Error: invalid jitter duration: "${params.jitter}"`, isError: true };
      jitterMs = j;
    }
    const schedule: Schedule = {
      id: makeScheduleId(),
      name: params.name,
      prompt: params.prompt.trim(),
      trigger: built.trigger,
      jitterMs,
      scope: params.scope ?? 'session',
      enabled: true,
      createdAt: now,
      runCount: 0,
    };
    schedule.nextFireAt = computeNextFire(schedule, new Date(now)) ?? undefined;
    addSchedule(schedule);
    rearm();
    return {
      content: `Created ${schedule.id} [${schedule.scope}] ${describeTrigger(schedule.trigger)} - next ${describeNext(schedule)}`,
    };
  };

  const toolUpdate = (params: ScheduleToolParamsT): { content: string; isError?: boolean } => {
    if (!params.id) return { content: 'Error: `id` is required for update.', isError: true };
    const existing = findById(collectAll(), params.id);
    if (!existing) return { content: `Error: no schedule with id "${params.id}".`, isError: true };
    const patch: Partial<Schedule> = {};
    if (params.prompt !== undefined) patch.prompt = params.prompt.trim();
    if (params.name !== undefined) patch.name = params.name;
    if (params.enabled !== undefined) patch.enabled = params.enabled;
    if (params.jitter !== undefined) {
      const j = parseDuration(params.jitter);
      if (j === null) return { content: `Error: invalid jitter duration: "${params.jitter}"`, isError: true };
      patch.jitterMs = j;
    }
    if (params.cron !== undefined || params.every !== undefined || params.in !== undefined || params.at !== undefined) {
      const built = buildTrigger(params, Date.now());
      if ('error' in built) return { content: `Error: ${built.error}`, isError: true };
      patch.trigger = built.trigger;
    }
    if (Object.keys(patch).length === 0) {
      return { content: 'Error: nothing to update (set prompt, name, enabled, jitter, or a trigger).', isError: true };
    }
    const updated = updateById(params.id, patch);
    rearm();
    if (!updated) return { content: `Error: no schedule with id "${params.id}".`, isError: true };
    return { content: `Updated ${updated.id} - next ${describeNext(updated)}` };
  };

  pi.registerTool({
    name: 'schedule',
    label: 'Schedule',
    description:
      'Schedule a prompt to fire at the agent later, on a timer. Use to self-continue a roleplay, queue a recurring report, or set a reminder. Actions: create ({prompt, one of cron|every|in|at, jitter?, scope?, name?}), list, update ({id, ...}), delete ({id}). Default scope is `session` (ephemeral); pass scope `global`/`project` to persist.',
    promptSnippet: 'Queue recurring or one-shot prompts to fire at yourself on a timer (cron / interval / once).',
    promptGuidelines: [
      'Use `schedule` create to continue without a user nudge (roleplay "keep going") or to set up a recurring/one-shot ping. Provide `prompt` plus exactly one of `cron`, `every`, `in`, `at`.',
      'Default scope is `session` (gone when this session ends). Use scope `global` or `project` only when the user wants the schedule to persist across sessions.',
      'Prefer a small `jitter` for recurring schedules that might collide with other sessions.',
    ],
    parameters: ScheduleToolParams,

    async execute(_toolCallId, params: ScheduleToolParamsT, _signal, _onUpdate, ctx) {
      if (ctx?.cwd && ctx.cwd !== cwd) cwd = ctx.cwd;
      if (ctx) currentCtx = ctx;
      let out: { content: string; isError?: boolean };
      switch (params.action) {
        case 'list': {
          const now = Date.now();
          const reconciled = collectAll().map((s) => reconcileSchedule(s, now));
          out = { content: formatScheduleList(reconciled, now) };
          break;
        }
        case 'create':
          out = toolCreate(params);
          break;
        case 'update':
          out = toolUpdate(params);
          break;
        case 'delete': {
          if (!params.id) {
            out = { content: 'Error: `id` is required for delete.', isError: true };
            break;
          }
          const removed = removeById(params.id);
          rearm();
          out = removed
            ? { content: `Deleted ${params.id}.` }
            : { content: `Error: no schedule with id "${params.id}".`, isError: true };
          break;
        }
      }
      return {
        content: [{ type: 'text', text: out.content }],
        details: { action: params.action },
        isError: out.isError,
      };
    },

    renderCall(args, theme) {
      const a = args as ScheduleToolParamsT;
      let text = theme.fg('toolTitle', theme.bold('schedule ')) + theme.fg('muted', a.action);
      if (a.id) text += ` ${theme.fg('accent', a.id)}`;
      const trig = a.cron ?? a.every ?? a.in ?? a.at;
      if (trig) text += ` ${theme.fg('dim', trig)}`;
      return new Text(text, 0, 0);
    },
  });
}
