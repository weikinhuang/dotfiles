/** Read-only detail text for an original schedule card's UI snapshot. */
import { formatDuration } from './duration.ts';
import { describeTrigger, type Schedule, wantsIdle } from './schedule.ts';

export type ScheduleCardStatus = 'enabled' | 'paused' | 'deleted' | 'exhausted';

export interface ScheduleCardDetails {
  metadata: string;
  prompt: string;
}

function fireTime(at: number | undefined): string {
  return at === undefined ? 'none' : new Date(at).toLocaleString();
}

export function formatScheduleDetails(schedule: Schedule, status: ScheduleCardStatus): ScheduleCardDetails {
  const pool = schedule.prompts;
  const lines = [
    `id: ${schedule.id}`,
    `name: ${schedule.name ?? 'none'}`,
    `trigger: ${describeTrigger(schedule.trigger)}`,
    `scope: ${schedule.scope} | status: ${status}`,
    `runs: ${schedule.runCount} | maxRuns: ${schedule.maxRuns ?? 'unlimited'} | unansweredRuns: ${schedule.unansweredRuns ?? 0}`,
    `last fire: ${fireTime(schedule.lastRunAt)}`,
    `next fire: ${fireTime(status === 'enabled' ? schedule.nextFireAt : undefined)}`,
    `jitter: ${formatDuration(schedule.jitterMs ?? 0)} | chance: ${schedule.chance ?? 1}`,
    `resetOnActivity: ${schedule.resetOnActivity ?? false} | whenIdle: ${wantsIdle(schedule)}`,
  ];
  if (pool && pool.length > 0) {
    lines.push(
      `prompt pool: ${pool.length} | pick: ${schedule.promptPick ?? 'random'} | cursor: ${schedule.promptCursor ?? 0}`,
    );
  }
  return {
    metadata: lines.join('\n'),
    prompt:
      pool && pool.length > 0 ? pool.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n') : schedule.prompt,
  };
}
