// Resolves a harness + session id/prefix (or nothing) to a concrete session
// log, mirroring the ergonomics of `ai-tool-usage <tool> session <id>` so the
// doctor can be pointed at a session by short id instead of a full path.
//
// The selection logic (`pickSession`) is pure and unit-tested; the per-harness
// directory scanning is impure (fs), and opencode resolution lives in the CLI
// since it queries SQLite. Directory conventions mirror the four
// config/<tool>/session-usage.ts adapters.
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import { type Harness } from './analyze/turn-model.ts';
import { expandUserPath } from './paths.ts';

// Default per-harness data dirs (overridable via --user-dir).
export const DEFAULT_DIRS: Record<Harness, string> = {
  pi: '~/.pi/agent/sessions',
  claude: '~/.claude/projects',
  codex: '~/.codex/sessions',
  opencode: '~/.local/share/opencode',
};

export interface Candidate {
  // Session id extracted from the filename (uuid suffix / basename).
  id: string;
  filePath: string;
  mtimeMs: number;
}

export type PickResult =
  | { ok: true; filePath: string }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'ambiguous'; matches: string[] };

// Pure: choose one candidate by id/prefix, or the newest when no id is given.
// An exact id match wins over multiple prefix matches.
export function pickSession(candidates: Candidate[], idOrPrefix?: string): PickResult {
  if (candidates.length === 0) return { ok: false, error: 'not-found' };

  if (!idOrPrefix) {
    const latest = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    return { ok: true, filePath: latest.filePath };
  }

  const matches = candidates.filter(
    (c) => c.id === idOrPrefix || c.id.startsWith(idOrPrefix) || c.filePath.includes(idOrPrefix),
  );
  if (matches.length === 0) return { ok: false, error: 'not-found' };
  if (matches.length === 1) return { ok: true, filePath: matches[0].filePath };

  const exact = matches.filter((m) => m.id === idOrPrefix);
  if (exact.length === 1) return { ok: true, filePath: exact[0].filePath };
  return { ok: false, error: 'ambiguous', matches: matches.map((m) => m.id).sort() };
}

// pi encodes the uuid as `<timestamp>_<uuid>.jsonl`.
function piId(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  return base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base;
}

function statMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function listJsonlOneLevel(rootDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(rootDir, entry.name);
    for (const f of fs.readdirSync(projectDir)) {
      if (f.endsWith('.jsonl')) out.push(path.join(projectDir, f));
    }
  }
  return out;
}

function walkJsonl(rootDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonl(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// Claude Code slugifies the cwd (and ancestors) into the project dir name.
function claudeSlug(dir: string): string {
  return dir.replace(/[/.]/g, '-');
}

function claudeProjectDirForCwd(projectsDir: string, cwd: string): string | undefined {
  let dir = cwd;
  while (dir !== '/' && dir !== '.') {
    const candidate = path.join(projectsDir, claudeSlug(dir));
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function toCandidates(files: string[], idOf: (f: string) => string): Candidate[] {
  return files.map((f) => ({ id: idOf(f), filePath: f, mtimeMs: statMs(f) }));
}

// Builds the candidate set for a JSONL harness. For claude with no explicit
// id, the current project's sessions are preferred (matching `ai-tool-usage`),
// falling back to every project.
export function collectCandidates(harness: Harness, userDir: string, cwd: string, hasId: boolean): Candidate[] {
  const root = expandUserPath(userDir);
  if (harness === 'pi') return toCandidates(listJsonlOneLevel(root), piId);
  if (harness === 'codex') return toCandidates(walkJsonl(root), (f) => path.basename(f, '.jsonl'));
  if (harness === 'claude') {
    if (!hasId) {
      const projectDir = claudeProjectDirForCwd(root, cwd);
      if (projectDir) {
        const local = toCandidates(
          fs
            .readdirSync(projectDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => path.join(projectDir, f)),
          (f) => path.basename(f, '.jsonl'),
        );
        if (local.length > 0) return local;
      }
    }
    return toCandidates(listJsonlOneLevel(root), (f) => path.basename(f, '.jsonl'));
  }
  return [];
}
