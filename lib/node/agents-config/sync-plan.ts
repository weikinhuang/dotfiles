/**
 * `config/agents/sync.ts diff` / `apply`: one planning pass over the
 * harness homes that both commands share, so `diff` always prints
 * exactly what `apply` would do. Planning only reads the filesystem;
 * {@link applyPlan} performs the planned actions.
 *
 * Safety rules (same spirit as `config/opencode/plugins/install.sh`):
 * a real file in the way of a link is moved to
 * `<name>.dotfiles-backup-<YYYYmmddHHMMSS>` first; a symlink that
 * resolves somewhere else is replaced only with `force` (otherwise it is
 * a conflict); a broken symlink is replaced; real directories are never
 * touched. Live settings files are copied to a backup before rewriting.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from '../pi/atomic-write.ts';
import { stripJsonComments } from '../pi/jsonc.ts';
import {
  type ConfigHarness,
  type Env,
  HARNESS_ITEMS,
  homeDir,
  resolveHarnessHome,
  type SettingsFormat,
  SHARED_ENV_SOURCE,
  SKILLS_SOURCE,
} from './harnesses.ts';
import { mergeSettings, renderSettingsChange, type SettingsChange, type SettingsCodec } from './settings-merge.ts';
import type { HarnessName } from './sync-args.ts';

export type SyncAction =
  | {
      kind: 'link';
      /** Absolute link path. */
      path: string;
      /** Absolute link text. */
      source: string;
      /** Existing link text being replaced. */
      replaces?: string;
      /** Where an existing real file is moved first. */
      backup?: string;
    }
  | { kind: 'copy'; path: string; source: string; content: string; reason: string; replaces?: string; backup?: string }
  | {
      kind: 'settings';
      path: string;
      /** Repo-relative baseline path. */
      source: string;
      content: string;
      /** True when the live file does not exist and the baseline is written verbatim. */
      create: boolean;
      changes: SettingsChange[];
      warnings: string[];
      backup?: string;
      /** Permission bits of the live file, kept across the rewrite. */
      mode?: number;
    }
  | { kind: 'remove-link'; path: string; target: string };

export interface HarnessPlan {
  name: HarnessName;
  home: string;
  /** Set when the harness is skipped entirely. */
  skipped?: string;
  actions: SyncAction[];
  /** Targets left alone because changing them needs a human (or `--force`). */
  conflicts: string[];
  /** Informational lines; never affect the exit code. */
  hints: string[];
}

export interface SyncOptions {
  /** Real path of the repo checkout. */
  repoRoot: string;
  env: Env;
  harnesses: HarnessName[];
  force: boolean;
  /** Timestamp for backup names. */
  now: Date;
  codecs: Record<SettingsFormat, SettingsCodec>;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYYmmddHHMMSS` in local time. */
export function backupStamp(now: Date): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function backupPath(path: string, now: Date): string {
  const base = `${path}.dotfiles-backup-${backupStamp(now)}`;
  let candidate = base;
  for (let n = 2; lstatOrUndefined(candidate) !== undefined; n++) candidate = `${base}-${n}`;
  return candidate;
}

class Planner {
  readonly plan: HarnessPlan;
  private readonly opts: SyncOptions;

  constructor(opts: SyncOptions, name: HarnessName, home: string) {
    this.opts = opts;
    this.plan = { name, home, actions: [], conflicts: [], hints: [] };
  }

  private rel(path: string): string {
    return path.startsWith(`${this.plan.home}/`) ? path.slice(this.plan.home.length + 1) : path;
  }

  private conflict(path: string, reason: string): void {
    this.plan.conflicts.push(`${this.rel(path)}: ${reason}`);
  }

  link(path: string, source: string): void {
    const st = lstatOrUndefined(path);
    if (st === undefined) {
      this.plan.actions.push({ kind: 'link', path, source });
      return;
    }
    if (st.isSymbolicLink()) {
      const text = readlinkSync(path);
      const resolved = realpathOrUndefined(path);
      if (resolved !== undefined && resolved === realpathOrUndefined(source)) return;
      if (resolved !== undefined && !this.opts.force) {
        this.conflict(path, `links to ${text}; rerun with --force to replace it`);
        return;
      }
      this.plan.actions.push({ kind: 'link', path, source, replaces: text });
      return;
    }
    if (st.isDirectory()) {
      this.conflict(path, 'is a directory; leaving it alone');
      return;
    }
    this.plan.actions.push({ kind: 'link', path, source, backup: backupPath(path, this.opts.now) });
  }

  copy(path: string, source: string, reason: string): void {
    const content = readFileSync(source, 'utf8');
    const st = lstatOrUndefined(path);
    if (st === undefined) {
      this.plan.actions.push({ kind: 'copy', path, source, content, reason });
      return;
    }
    if (st.isSymbolicLink()) {
      const text = readlinkSync(path);
      const resolved = realpathOrUndefined(path);
      const ours = resolved !== undefined && resolved === realpathOrUndefined(source);
      if (resolved !== undefined && !ours && !this.opts.force) {
        this.conflict(path, `links to ${text}; rerun with --force to replace it`);
        return;
      }
      this.plan.actions.push({ kind: 'copy', path, source, content, reason, replaces: text });
      return;
    }
    if (st.isDirectory()) {
      this.conflict(path, 'is a directory; leaving it alone');
      return;
    }
    if (readFileSync(path, 'utf8') === content) return;
    this.plan.actions.push({ kind: 'copy', path, source, content, reason, backup: backupPath(path, this.opts.now) });
  }

  settings(path: string, source: string, format: SettingsFormat): void {
    const baselineText = readFileSync(join(this.opts.repoRoot, source), 'utf8');
    const st = lstatOrUndefined(path);
    if (st === undefined) {
      this.plan.actions.push({
        kind: 'settings',
        path,
        source,
        content: baselineText,
        create: true,
        changes: [],
        warnings: [],
      });
      return;
    }
    if (st.isSymbolicLink()) {
      this.conflict(path, `is a symlink to ${readlinkSync(path)}; a merge would write through it, so it is left alone`);
      return;
    }
    if (!st.isFile()) {
      this.conflict(path, 'is not a regular file; leaving it alone');
      return;
    }
    const codec = this.opts.codecs[format];
    const liveText = readFileSync(path, 'utf8');
    let live;
    try {
      live = codec.parse(liveText);
    } catch (err) {
      this.conflict(path, `cannot parse the live file (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    const { merged, changes } = mergeSettings(codec.parse(baselineText), live);
    if (changes.length === 0) return;
    const hasComments = format === 'toml' ? /^\s*#/m.test(liveText) : stripJsonComments(liveText) !== liveText;
    this.plan.actions.push({
      kind: 'settings',
      path,
      source,
      content: codec.stringify(merged),
      create: false,
      changes,
      warnings: hasComments ? ['comments in the live file will not survive the merge'] : [],
      backup: backupPath(path, this.opts.now),
      mode: st.mode & 0o777,
    });
  }

  /** Hint when the machine-local `env` still carries the lines now in `config/agents/env`. */
  envHint(): void {
    const envPath = join(this.plan.home, 'env');
    let text: string;
    try {
      text = readFileSync(envPath, 'utf8');
    } catch {
      return;
    }
    const shared = readFileSync(join(this.opts.repoRoot, SHARED_ENV_SOURCE), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('export '));
    const local = new Set(text.split('\n').map((line) => line.trim()));
    const names = shared.flatMap((line) => {
      const name = /^export\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1];
      return name !== undefined && local.has(line) ? [name] : [];
    });
    if (names.length > 0) {
      this.plan.hints.push(
        `env still sets ${names.join(', ')}, which ${SHARED_ENV_SOURCE} now provides; remove those lines by hand`,
      );
    }
  }
}

function planHarness(opts: SyncOptions, name: ConfigHarness): HarnessPlan {
  const home = resolveHarnessHome(name, opts.env);
  const planner = new Planner(opts, name, home);
  if (!existsSync(home)) {
    planner.plan.skipped = `${home} does not exist`;
    return planner.plan;
  }
  for (const item of HARNESS_ITEMS[name]) {
    const path = join(home, item.target);
    const source = join(opts.repoRoot, item.source);
    if (item.kind === 'link') planner.link(path, source);
    else if (item.kind === 'copy') planner.copy(path, source, item.reason);
    else planner.settings(path, item.source, item.format);
  }
  planner.envHint();
  if (name === 'opencode' && existsSync(join(home, 'opencode.json'))) {
    planner.plan.hints.push('opencode.json also exists next to opencode.jsonc; check `opencode debug config`');
  }
  return planner.plan;
}

function planSkills(opts: SyncOptions): HarnessPlan {
  const home = resolveHarnessHome('skills', opts.env);
  const planner = new Planner(opts, 'skills', home);
  const userHome = homeDir(opts.env);
  if (!existsSync(userHome)) {
    planner.plan.skipped = `${userHome} does not exist`;
    return planner.plan;
  }
  const st = lstatOrUndefined(home);
  if (st !== undefined && !st.isDirectory()) {
    planner.plan.conflicts.push(`${home}: must be a real directory (one link per skill); leaving it alone`);
    return planner.plan;
  }
  const sourceDir = join(opts.repoRoot, SKILLS_SOURCE);
  const names = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) planner.link(join(home, name), join(sourceDir, name));
  if (st === undefined) return planner.plan;
  const managed = new Set(names);
  for (const entry of readdirSync(home, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(home, entry.name);
    if (managed.has(entry.name) || !entry.isSymbolicLink() || existsSync(path)) continue;
    planner.plan.actions.push({ kind: 'remove-link', path, target: readlinkSync(path) });
  }
  return planner.plan;
}

/** Plan every selected harness, in {@link HarnessName} order. */
export function planSync(opts: SyncOptions): HarnessPlan[] {
  return opts.harnesses.map((name) => (name === 'skills' ? planSkills(opts) : planHarness(opts, name)));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAction(action: SyncAction, home: string, repoRoot: string): string[] {
  const rel = (path: string): string => (path.startsWith(`${home}/`) ? path.slice(home.length + 1) : path);
  const repoRel = (path: string): string => (path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path);
  const backup = (path: string | undefined): string =>
    path === undefined ? '' : ` (moves the existing file to ${basename(path)})`;
  switch (action.kind) {
    case 'link':
      if (action.replaces !== undefined) {
        return [`~ link ${rel(action.path)} -> ${action.source} (replaces the link to ${action.replaces})`];
      }
      return [
        `${action.backup === undefined ? '+' : '~'} link ${rel(action.path)} -> ${action.source}${backup(action.backup)}`,
      ];
    case 'copy': {
      const why = `; ${action.reason}`;
      if (action.replaces !== undefined) {
        return [
          `~ copy ${repoRel(action.source)} to ${rel(action.path)} (replaces the link to ${action.replaces}${why})`,
        ];
      }
      if (action.backup !== undefined) {
        return [
          `~ copy ${repoRel(action.source)} to ${rel(action.path)} (content differs; backs up to ${basename(action.backup)}${why})`,
        ];
      }
      return [`+ copy ${repoRel(action.source)} to ${rel(action.path)} (${action.reason})`];
    }
    case 'settings':
      if (action.create) return [`+ write ${rel(action.path)} (copy of ${action.source})`];
      return [
        `~ merge ${action.source} into ${rel(action.path)} (backs up to ${basename(action.backup ?? '')})`,
        ...action.warnings.map((w) => `    warning: ${w}`),
        ...action.changes.flatMap((change) => renderSettingsChange(change).map((line) => `    ${line}`)),
      ];
    case 'remove-link':
      return [`- remove broken link ${rel(action.path)} -> ${action.target}`];
  }
}

/** Human-readable plan; identical for `diff` and `apply`. Never contains secret values. */
export function renderPlan(plans: HarnessPlan[], repoRoot: string): string[] {
  const out: string[] = [];
  for (const plan of plans) {
    if (plan.skipped !== undefined) {
      out.push(`${plan.name}: skipped, ${plan.skipped}`);
      continue;
    }
    const inSync = plan.actions.length === 0 && plan.conflicts.length === 0;
    out.push(`${plan.name}: ${plan.home}${inSync ? ' (in sync)' : ''}`);
    for (const action of plan.actions) out.push(...renderAction(action, plan.home, repoRoot).map((l) => `  ${l}`));
    for (const conflict of plan.conflicts) out.push(`  ! conflict: ${conflict}`);
    for (const hint of plan.hints) out.push(`  hint: ${hint}`);
  }
  return out;
}

export function countActions(plans: HarnessPlan[]): number {
  return plans.reduce((n, plan) => n + plan.actions.length, 0);
}

export function countConflicts(plans: HarnessPlan[]): number {
  return plans.reduce((n, plan) => n + plan.conflicts.length, 0);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyAction(action: SyncAction): void {
  switch (action.kind) {
    case 'link':
      ensureDirSync(dirname(action.path));
      if (action.backup !== undefined) renameSync(action.path, action.backup);
      else if (action.replaces !== undefined) unlinkSync(action.path);
      symlinkSync(action.source, action.path);
      return;
    case 'copy':
      if (action.backup !== undefined) renameSync(action.path, action.backup);
      else if (action.replaces !== undefined) unlinkSync(action.path);
      atomicWriteFile(action.path, action.content);
      return;
    case 'settings':
      if (action.backup !== undefined) copyFileSync(action.path, action.backup);
      atomicWriteFile(action.path, action.content, action.mode);
      return;
    case 'remove-link':
      unlinkSync(action.path);
      return;
  }
}

/** Perform every planned action; conflicts and skipped harnesses are left alone. */
export function applyPlan(plans: HarnessPlan[]): void {
  for (const plan of plans) for (const action of plan.actions) applyAction(action);
}
