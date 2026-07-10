/**
 * Hook config schema + layered loader for the `hooks` extension.
 *
 * Three layers, additive within an event:
 *
 *   1. Session rules: in-memory, supplied by the caller (lives in the
 *                     extension closure - persisted across tool calls
 *                     within one pi session, cleared on shutdown).
 *   2. Project rules: `<cwd>/.pi/hooks.json`
 *   3. User rules:    `<piAgentDir>/hooks.json` (default `~/.pi/agent/hooks.json`)
 *
 * Rule files are JSONC - `//` line comments and C-style block comments
 * are allowed so you can annotate why a hook exists. Malformed files
 * log one `console.warn` per unique path+error (via
 * {@link loadJsoncConfigOrFallback}) and are otherwise ignored;
 * missing files are silent. Mirrors the warning de-dup contract used
 * by `bash-permissions` and the `filesystem-policy` loader.
 *
 * Pure-ish: this module reads from disk so the extension shell only
 * has to call `loadHooks(ctx)`. Tests can inject `userHooks` /
 * `projectHooks` directly to bypass disk, and the lower-level
 * {@link parseHooksLayer} helper takes a raw string for fixture-free
 * coverage of the validation logic.
 */

import { join } from 'node:path';

import { loadJsoncConfigOrFallback, parseJsonc } from '../jsonc.ts';
import { piAgentDir, piProjectPath } from '../pi-paths.ts';
import { isRecord } from '../shared.ts';

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookScope = 'session' | 'project' | 'user';

export interface Hook {
  /** Tool-name matcher. Optional for events with no tool dimension. */
  matcher?: string;
  /** Path to executable. `~` expanded; relative paths resolved against ctx.cwd. */
  command: string;
  /** Timeout in milliseconds. Default 60000. */
  timeout?: number;
  /** When true, the hook subprocess is wrapped by sandbox.ts. Default false. */
  sandboxed?: boolean;
  /** Layer this hook came from, for /hooks and warning surfacing. */
  scope: HookScope;
}

/** Raw file shape (pre-validation). */
interface HookFile {
  hooks?: Partial<Record<string, unknown>>;
}

const TAG = 'hooks';

function userRulesPath(agentDir: string): string {
  return join(agentDir, 'hooks.json');
}

function projectRulesPath(cwd: string): string {
  return piProjectPath(cwd, 'hooks.json');
}

/** Empty per-event map, used as the fallback for missing/malformed files. */
function emptyConfig(): Record<HookEvent, Hook[]> {
  return {
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
    SessionStart: [],
  };
}

function isHookEvent(name: string): name is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

/**
 * Validate a single hook entry from a config file. Returns the
 * normalized `Hook` or `null` if the entry is malformed.
 */
function validateHook(raw: unknown, scope: HookScope): Hook | null {
  if (!isRecord(raw)) return null;
  const command = raw.command;
  if (typeof command !== 'string' || command.length === 0) return null;

  const hook: Hook = { command, scope };

  if (raw.matcher !== undefined) {
    if (typeof raw.matcher !== 'string') return null;
    hook.matcher = raw.matcher;
  }
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== 'number' || !Number.isFinite(raw.timeout) || raw.timeout <= 0) return null;
    hook.timeout = raw.timeout;
  }
  if (raw.sandboxed !== undefined) {
    if (typeof raw.sandboxed !== 'boolean') return null;
    hook.sandboxed = raw.sandboxed;
  }

  return hook;
}

/** Walk a parsed `hooks` object and produce a per-event map. */
function normalizeHookFile(file: HookFile | undefined, scope: HookScope): Record<HookEvent, Hook[]> {
  const out = emptyConfig();
  if (!file || !isRecord(file.hooks)) return out;
  for (const [event, entries] of Object.entries(file.hooks)) {
    if (!isHookEvent(event)) continue;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const hook = validateHook(entry, scope);
      if (hook) out[event].push(hook);
    }
  }
  return out;
}

/**
 * Parse one already-read raw file body. Pure - no disk I/O - so tests
 * can exercise it without fixtures. Malformed JSONC or unexpected
 * top-level shapes silently produce an empty config; tests that want
 * to assert on malformed-file warnings should drive {@link loadHooks}
 * via on-disk fixtures.
 */
export function parseHooksLayer(raw: string, scope: HookScope): Record<HookEvent, Hook[]> {
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return emptyConfig();
  }
  if (!isRecord(parsed)) return emptyConfig();
  return normalizeHookFile(parsed, scope);
}

/** Load + validate a single config file, with the same warn-once
 *  policy as `bash-permissions`. Missing file → empty silently;
 *  malformed JSONC → one warning per unique path+error then empty. */
function readHooksFile(path: string, scope: HookScope): Record<HookEvent, Hook[]> {
  const file = loadJsoncConfigOrFallback<HookFile | undefined>(TAG, path, () => undefined);
  if (!file || !isRecord(file)) return emptyConfig();
  return normalizeHookFile(file, scope);
}

// ──────────────────────────────────────────────────────────────────────
// Public loader
// ──────────────────────────────────────────────────────────────────────

export interface LoadHooksContext {
  cwd: string;
  /**
   * Pi agent dir for the user-layer file (e.g. `~/.pi/agent`).
   * Defaults to `piAgentDir()`; tests inject a temp dir so a real
   * `~/.pi/agent/hooks.json` on the host can't contaminate the
   * fixture. Resolved lazily on each call so a spawned subprocess
   * that changes `HOME` or `PI_CODING_AGENT_DIR` mid-session still
   * loads the right file.
   */
  agentDir?: string;
  /**
   * Session-scope hooks supplied by the extension shell. Layer 1 in
   * the merge order; project and user layers are read from disk.
   */
  sessionHooks?: Partial<Record<HookEvent, Hook[]>>;
  /** Override for vitest: skip disk entirely and use these instead. */
  userHooks?: Partial<Record<HookEvent, Hook[]>>;
  /** Override for vitest: skip disk entirely and use these instead. */
  projectHooks?: Partial<Record<HookEvent, Hook[]>>;
}

function rescope(hooks: readonly Hook[], scope: HookScope): Hook[] {
  const out: Hook[] = [];
  for (const h of hooks) {
    const copy: Hook = { command: h.command, scope };
    if (h.matcher !== undefined) copy.matcher = h.matcher;
    if (h.timeout !== undefined) copy.timeout = h.timeout;
    if (h.sandboxed !== undefined) copy.sandboxed = h.sandboxed;
    out.push(copy);
  }
  return out;
}

function normalizeOverride(src: Partial<Record<HookEvent, Hook[]>>, scope: HookScope): Record<HookEvent, Hook[]> {
  const out = emptyConfig();
  for (const event of HOOK_EVENTS) {
    out[event] = rescope(src[event] ?? [], scope);
  }
  return out;
}

/**
 * Merge session + project + user layers into a single per-event map.
 * Each layer contributes hooks in the order they appear in its file;
 * across layers the order is session, project, user (so a session
 * hook that decides `block` short-circuits before project / user
 * hooks run).
 */
export function loadHooks(ctx: LoadHooksContext): Record<HookEvent, Hook[]> {
  const out = emptyConfig();

  const agentDir = ctx.agentDir ?? piAgentDir();
  const sessionRaw = ctx.sessionHooks ?? {};
  const project = ctx.projectHooks
    ? normalizeOverride(ctx.projectHooks, 'project')
    : readHooksFile(projectRulesPath(ctx.cwd), 'project');
  const user = ctx.userHooks
    ? normalizeOverride(ctx.userHooks, 'user')
    : readHooksFile(userRulesPath(agentDir), 'user');

  for (const event of HOOK_EVENTS) {
    const sessionHooks = rescope(sessionRaw[event] ?? [], 'session');
    out[event] = [...sessionHooks, ...project[event], ...user[event]];
  }
  return out;
}

/**
 * Path of the on-disk user config, exported for the extension shell.
 * `agentDir` defaults to `piAgentDir()`; resolved lazily so a test
 * can pin a temp dir.
 */
export function userHooksPath(agentDir: string = piAgentDir()): string {
  return userRulesPath(agentDir);
}

/** Path of the on-disk project config, exported for the extension shell. */
export function projectHooksPath(cwd: string): string {
  return projectRulesPath(cwd);
}
