/**
 * Persistence + in-memory list operations for the scheduled-prompts
 * extension.
 *
 * Two scopes live on disk as `{ version: 1, schedules: [] }` JSON:
 *   - global  -> `~/.pi/agent/scheduled-prompts.json` (cross-session)
 *   - project -> `<cwd>/.pi/scheduled-prompts.json`  (this workspace)
 *
 * Both scope paths can be redirected with the `PI_SCHEDULED_PROMPTS_DIR`
 * env var (a test/eval harness sets it to a disposable sandbox dir so
 * schedule writes never touch the live files). When it is set, global
 * resolves to `<dir>/global.scheduled-prompts.json` and project to
 * `<dir>/project.scheduled-prompts.json` - distinct files so the two
 * scopes never collide, since `collectAll()` reads them separately.
 *
 * The third scope (`session`) is ephemeral and never written here - the
 * extension holds it in a process-global slot that dies on quit. Each
 * schedule carries its own `scope`, so a loaded file is expected to
 * contain only schedules of its own scope; `readScopeFile` does not
 * enforce that (it trusts the file) but the writers always pass a
 * scope-filtered list.
 *
 * Reads are tolerant: a missing file is an empty list, and malformed /
 * shape-mismatched entries are dropped rather than throwing, so a
 * hand-edited file can never crash session start. Writes are atomic
 * (tempfile + rename) via the shared `atomic-write` helper.
 *
 * Pure module - no pi imports - so it is directly unit-testable with a
 * temp `PI_CODING_AGENT_DIR` / cwd.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from '../atomic-write.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';
import { type Schedule, SCHEDULE_SCOPES, type ScheduleScope, type Trigger } from './schedule.ts';

export const SCHEDULES_FILENAME = 'scheduled-prompts.json';

/**
 * When `PI_SCHEDULED_PROMPTS_DIR` is set to a non-empty (trimmed) value,
 * return that directory; otherwise `undefined`. Resolved on each call so
 * a subprocess that sets it mid-run picks it up.
 */
function overrideDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.PI_SCHEDULED_PROMPTS_DIR?.trim();
  return dir && dir.length > 0 ? dir : undefined;
}

export interface ScheduleFile {
  version: 1;
  schedules: Schedule[];
}

/** Absolute path to the global schedules file. */
export function globalSchedulesPath(env: NodeJS.ProcessEnv = process.env): string {
  // With the override active both scopes live in the same dir, so they
  // must use distinct filenames or collectAll() would double-count.
  const dir = overrideDir(env);
  if (dir) return join(dir, `global.${SCHEDULES_FILENAME}`);
  // piAgentPath honors PI_CODING_AGENT_DIR via process.env.
  return piAgentPath(SCHEDULES_FILENAME);
}

/**
 * Absolute path to the project-scope schedules file for `cwd`. When
 * `PI_SCHEDULED_PROMPTS_DIR` is active, `cwd` is ignored and the path
 * resolves inside the override dir instead.
 */
export function projectSchedulesPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = overrideDir(env);
  if (dir) return join(dir, `project.${SCHEDULES_FILENAME}`);
  return piProjectPath(cwd, SCHEDULES_FILENAME);
}

function isTrigger(value: unknown): value is Trigger {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  switch (t.kind) {
    case 'cron':
      return typeof t.expr === 'string';
    case 'interval':
      return typeof t.ms === 'number' && Number.isFinite(t.ms);
    case 'once':
      return typeof t.at === 'number' && Number.isFinite(t.at);
    case 'after':
      return (
        typeof t.minMs === 'number' &&
        Number.isFinite(t.minMs) &&
        typeof t.maxMs === 'number' &&
        Number.isFinite(t.maxMs)
      );
    default:
      return false;
  }
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isScheduleShape(value: unknown): value is Schedule {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id.length === 0) return false;
  if (typeof s.prompt !== 'string') return false;
  if (!isTrigger(s.trigger)) return false;
  if (typeof s.scope !== 'string' || !SCHEDULE_SCOPES.includes(s.scope as ScheduleScope)) return false;
  if (typeof s.enabled !== 'boolean') return false;
  if (typeof s.createdAt !== 'number' || !Number.isFinite(s.createdAt)) return false;
  if (typeof s.runCount !== 'number' || !Number.isFinite(s.runCount)) return false;
  if (s.name !== undefined && typeof s.name !== 'string') return false;
  if (s.jitterMs !== undefined && typeof s.jitterMs !== 'number') return false;
  if (s.lastRunAt !== undefined && typeof s.lastRunAt !== 'number') return false;
  if (s.nextFireAt !== undefined && typeof s.nextFireAt !== 'number') return false;
  if (s.prompts !== undefined && (!Array.isArray(s.prompts) || !s.prompts.every((p) => typeof p === 'string'))) {
    return false;
  }
  if (s.promptPick !== undefined && s.promptPick !== 'random' && s.promptPick !== 'roundRobin') return false;
  if (!isOptionalNumber(s.promptCursor)) return false;
  if (!isOptionalNumber(s.maxRuns)) return false;
  if (!isOptionalNumber(s.chance)) return false;
  if (!isOptionalNumber(s.unansweredRuns)) return false;
  if (s.resetOnActivity !== undefined && typeof s.resetOnActivity !== 'boolean') return false;
  if (s.whenIdle !== undefined && typeof s.whenIdle !== 'boolean') return false;
  return true;
}

/**
 * Parse a schedules-file body, returning only the entries that match
 * the `Schedule` shape. Malformed JSON yields an empty list. Never
 * throws.
 */
export function parseScheduleFile(raw: string): Schedule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const schedules = (parsed as Record<string, unknown>).schedules;
  if (!Array.isArray(schedules)) return [];
  const arr = schedules as unknown[];
  const out: Schedule[] = [];
  for (const item of arr) {
    if (isScheduleShape(item)) out.push(item);
  }
  return out;
}

/** Read + validate a scope file. Missing file -> empty list. */
export function readScopeFile(path: string): Schedule[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return parseScheduleFile(raw);
}

/** Atomically write `schedules` to `path` as a versioned file. */
export function writeScopeFile(path: string, schedules: Schedule[]): void {
  const file: ScheduleFile = { version: 1, schedules };
  atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

/** Read both on-disk scopes for `cwd`. */
export function loadPersisted(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  global: Schedule[];
  project: Schedule[];
} {
  return {
    global: readScopeFile(globalSchedulesPath(env)),
    project: readScopeFile(projectSchedulesPath(cwd, env)),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Pure list operations (used for all three scopes)
// ──────────────────────────────────────────────────────────────────────

export function findById(list: Schedule[], id: string): Schedule | undefined {
  return list.find((s) => s.id === id);
}

export function addToList(list: Schedule[], schedule: Schedule): Schedule[] {
  return [...list, schedule];
}

export function removeFromList(list: Schedule[], id: string): { list: Schedule[]; removed: Schedule | undefined } {
  const removed = findById(list, id);
  if (!removed) return { list, removed: undefined };
  return { list: list.filter((s) => s.id !== id), removed };
}

export function updateInList(
  list: Schedule[],
  id: string,
  patch: Partial<Schedule>,
): { list: Schedule[]; updated: Schedule | undefined } {
  const existing = findById(list, id);
  if (!existing) return { list, updated: undefined };
  const updated: Schedule = { ...existing, ...patch, id: existing.id };
  return { list: list.map((s) => (s.id === id ? updated : s)), updated };
}
