/**
 * Pure helpers for the opencode `cost-guard` plugin
 * (`config/opencode/plugins/cost-guard/`): config resolution, opencode
 * usage -> {@link CostSample} mapping, silent history replay, a per-root
 * session tracker, and the RPC payload the server part pushes to the TUI.
 *
 * Detection (rolling window, episodes, milestones) is the pi detector in
 * `lib/node/pi/cost-guard.ts`; this module only adapts opencode's step,
 * compaction, and message shapes onto it. The plugin shell owns the side
 * effects (event subscription, session / model lookups, RPC emit).
 *
 * Pure module - no opencode imports.
 */

import {
  type CostGuardConfig,
  costGuardConfig,
  type CostGuardState,
  type CostSample,
  createCostGuardState,
  guardNotification,
  type GuardNotice,
  guardStatus,
  observeCostSample,
} from '../pi/cost-guard.ts';
import { isRecord } from '../pi/shared/guards.ts';
import {
  createOptionReader,
  type EnvBag,
  parseNonEmptyString,
  type PluginOptionBag,
  toEnvKey,
} from './plugin-options.ts';

/** Env override prefix: option `callDollars` -> `OPENCODE_COST_GUARD_CALL_DOLLARS`. */
export const OPENCODE_COST_GUARD_ENV_PREFIX = 'OPENCODE_COST_GUARD_';

/** Detector knobs, by option name; each maps onto the pi `costGuardConfig` key `toEnvKey(name)`. */
export const COST_GUARD_THRESHOLD_KEYS = [
  'window',
  'readTolerance',
  'writeContextRatio',
  'writeCostRatio',
  'callDollars',
] as const;

export interface OpencodeCostGuardConfig {
  /** Master switch; `false` makes the plugin a no-op. */
  enabled: boolean;
  /** Append one line per warning to this file (server-side fallback without a TUI). */
  log: string | undefined;
  /** Detector thresholds, validated and bounded by the pi resolver. */
  guard: CostGuardConfig;
}

function rawThreshold(raw: unknown): string | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : undefined;
  return parseNonEmptyString(raw);
}

/** Milestones accept `[2, 5]`, `"2,5"`, `"none"`, `[]`, or `false` (the last three disable them). */
function rawMilestones(raw: unknown): string | undefined {
  if (raw === false) return 'none';
  if (Array.isArray(raw)) {
    const values = raw as unknown[];
    if (values.length === 0) return 'none';
    return values.every((value) => typeof value === 'number' || typeof value === 'string')
      ? values.join(',')
      : undefined;
  }
  return rawThreshold(raw);
}

/**
 * Resolve the plugin config from `ctx.options` and `env`. Env beats option beats default. Threshold values are
 * validated by the shared pi resolver, so an out-of-range value falls back to the default.
 */
export function resolveOpencodeCostGuardConfig(
  options: PluginOptionBag | undefined,
  env: EnvBag,
): OpencodeCostGuardConfig {
  const reader = createOptionReader(options, env, OPENCODE_COST_GUARD_ENV_PREFIX);
  const raw: Record<string, string | undefined> = {};
  for (const key of COST_GUARD_THRESHOLD_KEYS) raw[toEnvKey(key)] = reader.get(key, rawThreshold);
  raw.MILESTONES = reader.get('milestones', rawMilestones);
  return {
    enabled: reader.bool('enabled', true),
    log: reader.optionalString('log'),
    guard: costGuardConfig(raw, ''),
  };
}

// ── usage mapping ─────────────────────────────────────────────────────

/** opencode `TokenUsage.Info`: `input` is fresh (non-cached) input. */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** One opencode `Model.Cost` tier, USD per million tokens. */
export interface PriceTier {
  readonly tier?: { readonly type: string; readonly size: number };
  readonly input: number;
  readonly output: number;
  readonly cache: { readonly read: number; readonly write: number };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Parse a `TokenUsage.Info`-shaped value; `undefined` when absent or not an object. */
export function parseTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const cache = isRecord(raw.cache) ? raw.cache : {};
  return {
    input: count(raw.input),
    output: count(raw.output),
    reasoning: count(raw.reasoning),
    cache: { read: count(cache.read), write: count(cache.write) },
  };
}

/** Tier selection mirroring opencode's `SessionUsage.calculateCost`: largest context tier exceeded, else the base. */
function selectTier(tiers: readonly PriceTier[], tokens: TokenUsage): PriceTier | undefined {
  const context = tokens.input + tokens.cache.read + tokens.cache.write;
  let best: PriceTier | undefined;
  for (const tier of tiers) {
    if (tier.tier?.type !== 'context' || context <= tier.tier.size) continue;
    if (!best?.tier || tier.tier.size > best.tier.size) best = tier;
  }
  return best ?? tiers.find((tier) => tier.tier === undefined);
}

/**
 * opencode records one USD `cost` per step with no breakdown. Apportion it to cache writes by the catalog price
 * split, so `writeDollars <= cost` and a reported (non-catalog) cost keeps its total. Zero without pricing.
 */
export function estimateWriteDollars(
  cost: number,
  tokens: TokenUsage,
  tiers: readonly PriceTier[] | undefined,
): number {
  if (!(cost > 0) || !tiers?.length) return 0;
  const tier = selectTier(tiers, tokens);
  if (!tier) return 0;
  const write = tokens.cache.write * count(tier.cache.write);
  const estimate =
    tokens.input * count(tier.input) +
    (tokens.output + tokens.reasoning) * count(tier.output) +
    tokens.cache.read * count(tier.cache.read) +
    write;
  return estimate > 0 ? cost * (write / estimate) : 0;
}

/** Map an opencode `{ cost, tokens }` pair onto the detector's sample; `undefined` when `tokens` is missing. */
export function opencodeCostSample(
  cost: unknown,
  tokens: unknown,
  tiers?: readonly PriceTier[],
): CostSample | undefined {
  const usage = parseTokenUsage(tokens);
  if (!usage) return undefined;
  const dollars = count(cost);
  return {
    read: usage.cache.read,
    write: usage.cache.write,
    context: usage.input + usage.cache.read + usage.cache.write,
    dollars,
    writeDollars: estimateWriteDollars(dollars, usage, tiers),
  };
}

/** Rolling-window identity for a `Model.Ref`; a change resets the window, as in pi. */
export function modelIdentity(model: unknown): string | undefined {
  if (!isRecord(model) || typeof model.providerID !== 'string' || typeof model.id !== 'string') return undefined;
  return JSON.stringify([model.providerID, model.id]);
}

/** Resolve catalog pricing for a `Model.Ref` (injected so this stays pure). */
export type PricingLookup = (model: unknown) => readonly PriceTier[] | undefined;

/** One usage observation, live or replayed. */
export interface UsageRecord {
  /** Assistant message id for steps; replay uses it to drop live duplicates. */
  messageID?: string;
  /** Model identity for assistant calls; nested records keep the current one. */
  identity?: string;
  /** Root-session assistant call (rolling window) vs nested / out-of-band spend. */
  assistant: boolean;
  sample: CostSample;
}

/**
 * Usage records from `ctx.session.context` messages, oldest first: assistant messages with `tokens` become
 * window samples; compaction messages with `tokens` become nested spend. Nothing reads message bodies.
 */
export function contextUsageRecords(messages: readonly unknown[], pricing?: PricingLookup): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const assistant = message.type === 'assistant';
    if (!assistant && message.type !== 'compaction') continue;
    const sample = opencodeCostSample(message.cost, message.tokens, pricing?.(message.model));
    if (!sample) continue;
    records.push({
      messageID: typeof message.id === 'string' ? message.id : undefined,
      identity: assistant ? modelIdentity(message.model) : undefined,
      assistant,
      sample,
    });
  }
  return records;
}

// ── tracker ───────────────────────────────────────────────────────────

export type GuardLevel = 'ok' | 'warning' | 'critical';

/** Result of one live observation for a root session. */
export interface GuardUpdate {
  /** New notices for this response (already deduped per episode / milestone). */
  notices: GuardNotice[];
  status: GuardLevel;
  statusChanged: boolean;
  totalDollars: number;
}

export interface SeedInput {
  /** Replayed records (see {@link contextUsageRecords}), oldest first. */
  records: readonly UsageRecord[];
  /** Authoritative spend for the session tree (sum of `Session.Info.cost`), when known. */
  sessionDollars?: number;
  /**
   * The live event that triggered the seed. It is already committed, so it shows up in the snapshot; leave it out
   * so the caller can observe it live and still get its notices.
   */
  exclude?: { messageID?: string; dollars: number };
}

interface TrackedSession {
  state: CostGuardState;
  replayed: Set<string>;
  /** Last level reported through a {@link GuardUpdate}; starts `ok` so the first live update after a seed reports it. */
  delivered: GuardLevel;
}

export interface CostGuardTracker {
  has(root: string): boolean;
  /** Rebuild state silently from history. Replaces any existing state for `root`. */
  seed(root: string, input: SeedInput): void;
  /** Feed one live record. `undefined` when it duplicates a replayed message. */
  observe(root: string, record: UsageRecord): GuardUpdate | undefined;
  /** Clear the rolling window and open episodes, keeping spend and milestones (pi `session_tree`). */
  resetWindow(root: string): GuardUpdate | undefined;
  snapshot(root: string): { status: GuardLevel; totalDollars: number } | undefined;
  forget(root: string): void;
}

const ZERO_SAMPLE: CostSample = { read: 0, write: 0, context: 0, dollars: 0, writeDollars: 0 };

function levelOf(state: CostGuardState): GuardLevel {
  return guardStatus(state) ?? 'ok';
}

/** Per-root-session detector state. Child sessions feed their root with `assistant: false`. */
export function createCostGuardTracker(config: CostGuardConfig): CostGuardTracker {
  const sessions = new Map<string, TrackedSession>();

  const tracked = (root: string): TrackedSession => {
    let entry = sessions.get(root);
    if (!entry) {
      entry = { state: createCostGuardState(), replayed: new Set(), delivered: 'ok' };
      sessions.set(root, entry);
    }
    return entry;
  };

  const update = (entry: TrackedSession, notices: GuardNotice[]): GuardUpdate => {
    const status = levelOf(entry.state);
    const statusChanged = status !== entry.delivered;
    entry.delivered = status;
    return { notices, status, statusChanged, totalDollars: entry.state.totalDollars };
  };

  return {
    has: (root) => sessions.has(root),
    seed(root, input) {
      const entry: TrackedSession = { state: createCostGuardState(), replayed: new Set(), delivered: 'ok' };
      const { state } = entry;
      for (const record of input.records) {
        if (record.messageID !== undefined && record.messageID === input.exclude?.messageID) continue;
        observeCostSample(state, record.sample, config, record.identity ?? state.identity, record.assistant);
        if (record.messageID !== undefined) entry.replayed.add(record.messageID);
      }
      if (input.sessionDollars !== undefined) {
        const target = input.sessionDollars - (input.exclude?.dollars ?? 0);
        // Title / generate usage and child sessions only show up in the session totals.
        if (target > state.totalDollars) state.totalDollars = target;
        // Mark milestones already crossed, silently.
        observeCostSample(state, ZERO_SAMPLE, config, state.identity, false);
      }
      sessions.set(root, entry);
    },
    observe(root, record) {
      const entry = tracked(root);
      if (record.messageID !== undefined && entry.replayed.delete(record.messageID)) return undefined;
      const identity = record.assistant ? (record.identity ?? entry.state.identity) : entry.state.identity;
      return update(entry, observeCostSample(entry.state, record.sample, config, identity, record.assistant));
    },
    resetWindow(root) {
      const entry = sessions.get(root);
      if (!entry) return undefined;
      entry.state.samples = [];
      entry.state.active.clear();
      return update(entry, []);
    },
    snapshot(root) {
      const entry = sessions.get(root);
      return entry ? { status: levelOf(entry.state), totalDollars: entry.state.totalDollars } : undefined;
    },
    forget: (root) => void sessions.delete(root),
  };
}

// ── delivery ──────────────────────────────────────────────────────────

/** Payload of the `update` RPC event the server pushes to TUI parts. */
export interface CostGuardUpdateEvent {
  /** Root session id. */
  sessionID: string;
  status: GuardLevel;
  totalDollars: number;
  /** Combined notification for this response, when there were new notices. */
  message?: string;
  variant?: 'warning' | 'error';
}

/** Build the RPC payload; `undefined` when there is nothing new to show. */
export function buildUpdateEvent(root: string, update: GuardUpdate): CostGuardUpdateEvent | undefined {
  if (update.notices.length === 0 && !update.statusChanged) return undefined;
  const event: CostGuardUpdateEvent = { sessionID: root, status: update.status, totalDollars: update.totalDollars };
  if (update.notices.length > 0) {
    event.message = guardNotification(update.notices, []);
    event.variant = update.notices.some((notice) => notice.severity === 'critical') ? 'error' : 'warning';
  }
  return event;
}

function isLevel(value: unknown): value is GuardLevel {
  return value === 'ok' || value === 'warning' || value === 'critical';
}

/** Validate an `update` event's `data` on the TUI side. */
export function parseUpdateEvent(data: unknown): CostGuardUpdateEvent | undefined {
  if (!isRecord(data) || typeof data.sessionID !== 'string' || !isLevel(data.status)) return undefined;
  const event: CostGuardUpdateEvent = {
    sessionID: data.sessionID,
    status: data.status,
    totalDollars: count(data.totalDollars),
  };
  if (typeof data.message === 'string' && data.message) {
    event.message = data.message;
    event.variant = data.variant === 'error' ? 'error' : 'warning';
  }
  return event;
}

/** Output of the `status` RPC method. */
export interface CostGuardStatus {
  sessionID: string;
  /** `false` until the server has observed or replayed this session tree. */
  known: boolean;
  status: GuardLevel;
  totalDollars: number;
}

/** Session id from a `status` RPC input; `undefined` when malformed. */
export function parseStatusInput(input: unknown): string | undefined {
  return isRecord(input) && typeof input.sessionID === 'string' && input.sessionID ? input.sessionID : undefined;
}

/** Validate a `status` RPC output on the TUI side. */
export function parseStatusOutput(output: unknown): CostGuardStatus | undefined {
  if (!isRecord(output) || typeof output.sessionID !== 'string' || !isLevel(output.status)) return undefined;
  return {
    sessionID: output.sessionID,
    known: output.known === true,
    status: output.status,
    totalDollars: count(output.totalDollars),
  };
}

/** Status-slot text; `undefined` hides the slot while healthy. */
export function statusLabel(status: GuardLevel | undefined): string | undefined {
  return status === undefined || status === 'ok' ? undefined : `cost:${status}`;
}

/** One log line for the server-side fallback. */
export function formatLogLine(now: Date, event: CostGuardUpdateEvent): string {
  return `${now.toISOString()} session=${event.sessionID} status=${event.status} total=$${event.totalDollars.toFixed(4)}${event.message ? ` ${event.message}` : ''}`;
}
