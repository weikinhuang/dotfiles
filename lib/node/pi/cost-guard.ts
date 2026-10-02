/** Local-only bounded cost/cache warning state. No prompts, provider calls, or runtime SDK imports. */
import { envTruthy, parsePositiveInt } from './parse-env.ts';
import { isRecord } from './shared/guards.ts';

export interface CostGuardConfig {
  window: number;
  readTolerance: number;
  writeContextRatio: number;
  writeCostRatio: number;
  callDollars: number;
  milestones: number[];
}

function threshold(raw: string | undefined, fallback: number, maximum = Infinity): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= maximum ? value : fallback;
}

export function costGuardConfig(env: Record<string, string | undefined>): CostGuardConfig {
  const rawMilestones = env.PI_COST_GUARD_MILESTONES;
  const milestones = rawMilestones?.split(',').map((value) => Number(value.trim()));
  return {
    window: Math.min(100, Math.max(2, parsePositiveInt(env.PI_COST_GUARD_WINDOW, 4))),
    readTolerance: threshold(env.PI_COST_GUARD_READ_TOLERANCE, 0.02, 1),
    writeContextRatio: threshold(env.PI_COST_GUARD_WRITE_CONTEXT_RATIO, 0.5, 1),
    writeCostRatio: threshold(env.PI_COST_GUARD_WRITE_COST_RATIO, 0.7, 1),
    callDollars: threshold(env.PI_COST_GUARD_CALL_DOLLARS, 0.25),
    milestones:
      rawMilestones === 'none'
        ? []
        : milestones?.length && milestones.every((value) => Number.isFinite(value) && value > 0)
          ? [...new Set(milestones)].sort((left, right) => left - right)
          : [2, 5, 10],
  };
}

export interface CostSample {
  read: number;
  write: number;
  context: number;
  dollars: number;
  writeDollars: number;
}

function nonnegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function costSample(usage: unknown): CostSample {
  const u = isRecord(usage) ? usage : {};
  const cost = isRecord(u.cost) ? u.cost : {};
  const read = nonnegative(u.cacheRead);
  const write = nonnegative(u.cacheWrite);
  return {
    read,
    write,
    context: nonnegative(u.input) + read + write,
    dollars:
      typeof cost.total === 'number' && Number.isFinite(cost.total) && cost.total >= 0
        ? cost.total
        : nonnegative(cost.input) +
          nonnegative(cost.output) +
          nonnegative(cost.cacheRead) +
          nonnegative(cost.cacheWrite),
    writeDollars: nonnegative(cost.cacheWrite),
  };
}

export interface GuardNotice {
  id: string;
  severity: 'warning' | 'critical';
  text: string;
}

export interface CostGuardState {
  identity: string;
  samples: CostSample[];
  totalDollars: number;
  writeDollars: number;
  active: Map<string, { notice: GuardNotice; recovery: number }>;
  milestones: Set<number>;
}

export function createCostGuardState(): CostGuardState {
  return { identity: '', samples: [], totalDollars: 0, writeDollars: 0, active: new Map(), milestones: new Set() };
}

/** Mutates only the local guard state. At most one notice per threshold/episode, rearmed after a healthy window. */
export function observeCostSample(
  state: CostGuardState,
  sample: CostSample,
  config: CostGuardConfig,
  identity: string,
  assistant = true,
): GuardNotice[] {
  state.totalDollars += sample.dollars;
  state.writeDollars += sample.writeDollars;
  if (assistant) {
    if (state.identity !== identity) {
      state.samples = [];
      state.active.clear();
      state.identity = identity;
    }
    state.samples.push(sample);
    state.samples = state.samples.slice(-config.window);
  }
  const candidates: GuardNotice[] = [];
  const window = state.samples;
  if (assistant && sample.dollars > config.callDollars && config.callDollars > 0) {
    candidates.push({
      id: 'call',
      severity: 'warning',
      text: `one call cost $${sample.dollars.toFixed(2)} (limit $${config.callDollars.toFixed(2)})`,
    });
  }
  if (window.length >= config.window) {
    const maximum = Math.max(...window.map((turn) => turn.read));
    const minimum = Math.min(...window.map((turn) => turn.read));
    const advancing = window.slice(1).every((turn, index) => turn.read > window[index].read);
    const growing = window.at(-1)!.context > window[0].context * (1 + config.readTolerance);
    if (maximum > 0 && minimum > 0 && (maximum - minimum) / maximum <= config.readTolerance && growing && !advancing) {
      candidates.push({
        id: 'plateau',
        severity: 'critical',
        text: `cached prefix stayed near ${Math.round(maximum)} tokens while context grew over ${config.window} calls`,
      });
    }
    if (
      config.writeContextRatio > 0 &&
      window.every((turn) => turn.context > 0 && turn.write / turn.context > config.writeContextRatio)
    ) {
      candidates.push({
        id: 'rewrite',
        severity: 'critical',
        text: `cache writes exceeded ${Math.round(config.writeContextRatio * 100)}% of context for ${config.window} calls`,
      });
    }
    if (
      config.writeCostRatio > 0 &&
      state.totalDollars > 0 &&
      state.writeDollars / state.totalDollars > config.writeCostRatio
    ) {
      candidates.push({
        id: 'spend',
        severity: 'warning',
        text: `${Math.round((state.writeDollars / state.totalDollars) * 100)}% of session cost is cache-write ($${state.writeDollars.toFixed(2)})`,
      });
    }
  }
  const notices: GuardNotice[] = [];
  const present = new Set(candidates.map((candidate) => candidate.id));
  if (assistant) {
    for (const [id, active] of state.active) {
      active.recovery = present.has(id) ? 0 : active.recovery + 1;
      if (active.recovery >= config.window) state.active.delete(id);
    }
  }
  for (const notice of candidates) {
    if (!state.active.has(notice.id)) {
      state.active.set(notice.id, { notice, recovery: 0 });
      notices.push(notice);
    }
  }
  for (const milestone of config.milestones) {
    if (state.totalDollars >= milestone && !state.milestones.has(milestone)) {
      state.milestones.add(milestone);
      notices.push({
        id: `budget:${milestone}`,
        severity: 'warning',
        text: `session cost crossed $${milestone.toFixed(2)} (now $${state.totalDollars.toFixed(2)})`,
      });
    }
  }
  return notices;
}

export function guardStatus(state: CostGuardState): 'warning' | 'critical' | undefined {
  const active = [...state.active.values()];
  return active.some((item) => item.notice.severity === 'critical')
    ? 'critical'
    : active.length
      ? 'warning'
      : undefined;
}

export function guardNotification(notices: readonly GuardNotice[], injectors: readonly string[]): string {
  const text = `Cost guard: ${notices.map((notice) => notice.text).join('; ')}.`;
  return notices.some((notice) => notice.severity === 'critical')
    ? `${text} Start a fresh session or compact; review active auto-injectors${injectors.length ? ` (${injectors.join(', ')})` : ''}. Use local cache tracing to distinguish mutation from eviction/routing.`
    : text;
}

export function enabledAutoInjectors(env: Record<string, string | undefined>, tools: readonly string[]): string[] {
  return [
    ['todo', 'TODO'],
    ['bg_bash', 'BG_BASH'],
    ['scratchpad', 'SCRATCHPAD'],
    ['memory', 'MEMORY'],
    ['roleplay', 'ROLEPLAY'],
  ]
    .filter(
      ([tool, prefix]) =>
        tools.includes(tool) &&
        !envTruthy(env[`PI_${prefix}_DISABLED`]) &&
        !envTruthy(env[`PI_${prefix}_DISABLE_AUTOINJECT`]),
    )
    .map(([tool]) => tool);
}

/** Replay accounting without reading prompt bodies or requesting any model work. */
export function guardUsageRecords(
  entries: readonly unknown[],
): { usage: unknown; identity: string; assistant: boolean }[] {
  const records: { usage: unknown; identity: string; assistant: boolean }[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const message = entry.type === 'message' && isRecord(entry.message) ? entry.message : entry;
    if (!isRecord(message.usage)) continue;
    records.push({
      usage: message.usage,
      identity: JSON.stringify([message.provider, message.model]),
      assistant: entry.type === 'message' && message.role === 'assistant',
    });
  }
  return records;
}

/** Reconcile out-of-band usage (compaction/cache warming) without resetting window or alert receipts. */
export function reconcileGuardAccounting(state: CostGuardState, entries: readonly unknown[]): void {
  let total = 0;
  let write = 0;
  for (const record of guardUsageRecords(entries)) {
    const sample = costSample(record.usage);
    total += sample.dollars;
    write += sample.writeDollars;
  }
  state.totalDollars = total;
  state.writeDollars = write;
}
