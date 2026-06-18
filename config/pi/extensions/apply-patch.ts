/**
 * `apply_patch` tool for pi.
 *
 * Registers a single `apply_patch` tool that takes a Codex-format
 * patch string and applies it atomically against the working
 * directory. Coexists with `edit` / `write`; opus-class models on
 * multi-file or large diffs reach for this, small models keep using
 * `edit` + `edit-recovery`.
 *
 * Pipeline:
 *
 *   1. Parse the patch string via `lib/node/pi/apply-patch/parse.ts`.
 *   2. Validate every op against the on-disk snapshot via
 *      `lib/node/pi/apply-patch/apply.ts`. All-or-nothing: even one
 *      hunk mismatch / missing-source / overwrite-existing aborts
 *      the whole patch.
 *   3. Gate each affected absolute path through the SAME
 *      `filesystem-policy` classify + approval pipeline that the
 *      `filesystem.ts` extension applies to `write` / `edit` calls.
 *      Any denial aborts before any write touches disk.
 *   4. Commit the staged plan via `lib/node/pi/atomic-write.ts` per
 *      file; deletions go through `unlinkSync` after writes succeed.
 *
 * Composition:
 *
 *   - `filesystem` (the policy gate) — reused INLINE here per-path,
 *     so a write to `~/.ssh/config` or a forbidden project subdir is
 *     refused exactly the way it would be under `write` / `edit`. The
 *     extension does NOT route through pi's `write` tool (pi has no
 *     cross-tool invocation API); instead both call sites consume the
 *     same `classifyWrite` + `askForPermission` library.
 *   - `edit-recovery` — does NOT engage; `apply_patch` formats its own
 *     recovery blocks via `lib/node/pi/apply-patch/format-recovery.ts`.
 *   - `tool-output-condenser` — composes downstream as usual: the
 *     tool returns a normal `AgentToolResult`, so the condenser sees
 *     a single big text part on the happy path and (error + recovery)
 *     on the failure path.
 *
 * Environment:
 *   PI_APPLY_PATCH_DISABLED=1         skip the extension entirely
 *   PI_APPLY_PATCH_MAX_BYTES=<n>      per-file size cap when reading
 *                                     existing content (default
 *                                     1048576 = 1 MB)
 *   PI_APPLY_PATCH_DEBUG=1            ctx.ui.notify each decision
 *   PI_APPLY_PATCH_TRACE=<path>       append one line per decision
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { applyPatch, type ReadFile, type WritePlan } from '../../../lib/node/pi/apply-patch/apply.ts';
import { parsePatch } from '../../../lib/node/pi/apply-patch/parse.ts';
import { askForPermission } from '../../../lib/node/pi/approval-prompt.ts';
import { atomicWriteFile } from '../../../lib/node/pi/atomic-write.ts';
import { classifyFilesystemAccess } from '../../../lib/node/pi/filesystem-policy/classify.ts';
import { findGitRoot } from '../../../lib/node/pi/filesystem/git-root.ts';
import {
  filesystemProjectPolicyPath,
  filesystemUserPolicyPath,
  loadFilesystemPolicy,
} from '../../../lib/node/pi/filesystem-policy/load.ts';
import { type FilesystemPolicyWarning } from '../../../lib/node/pi/filesystem-policy/schema.ts';
import { readTextOrEmpty } from '../../../lib/node/pi/fs-safe.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { makeDiagnostics } from '../../../lib/node/pi/recovery-diagnostics.ts';
import { truncate } from '../../../lib/node/pi/shared.ts';

const DEFAULT_MAX_BYTES = 1_048_576;
const USER_RULES_PATH = filesystemUserPolicyPath();

const ApplyPatchParams = Type.Object({
  patch: Type.String({
    description:
      'Codex-format patch. Must start with "*** Begin Patch" and end with "*** End Patch". Per-op headers: "*** Add File: <path>", "*** Update File: <path>", "*** Delete File: <path>", "*** Move File: <from> -> <to>". Hunks begin with "@@" and use " " / "-" / "+" prefixes. See the `apply-patch-format` skill for the exact shape — do NOT hand-write from training data.',
  }),
});

interface ApplyPatchDetails {
  ok: boolean;
  files: { path: string; op: 'add' | 'update' | 'delete' | 'move'; from?: string }[];
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────
// Filesystem helpers
// ──────────────────────────────────────────────────────────────────────

function readLayer(path: string): string {
  return readTextOrEmpty(path);
}

function projectRulesPath(cwd: string): string {
  return filesystemProjectPolicyPath(cwd);
}

function buildReadFile(cwd: string, maxBytes: number): ReadFile {
  return (path) => {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    let size: number;
    try {
      size = statSync(absolute).size;
    } catch {
      return null;
    }
    if (size > maxBytes) {
      throw new Error(`apply_patch: file "${path}" too large (${size} > ${maxBytes}); raise PI_APPLY_PATCH_MAX_BYTES`);
    }
    try {
      return readFileSync(absolute, 'utf8');
    } catch {
      return null;
    }
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-path filesystem gate (mirror of filesystem.ts:makeFilesystemToolCallHandler
// for write/edit semantics — same library helpers, same approval prompt)
// ──────────────────────────────────────────────────────────────────────

interface GateResult {
  block?: { path: string; reason: string };
}

async function gatePaths(
  ctx: ExtensionContext,
  paths: readonly string[],
  defaultFallback: 'allow' | 'deny',
  sessionAllow: Set<string>,
  surfaceWarnings: (warnings: FilesystemPolicyWarning[]) => void,
): Promise<GateResult> {
  if (paths.length === 0) return {};

  const layers = [
    { source: USER_RULES_PATH, raw: readLayer(USER_RULES_PATH) },
    { source: projectRulesPath(ctx.cwd), raw: readLayer(projectRulesPath(ctx.cwd)) },
  ];
  const active = getActivePersona();
  const { policy, warnings } = loadFilesystemPolicy(layers, {
    personaOverlay:
      active && active.resolvedWriteRoots.length > 0
        ? { source: `persona:${active.name}`, paths: active.resolvedWriteRoots }
        : undefined,
  });
  surfaceWarnings(warnings);

  for (const inputPath of paths) {
    const accessDecision = classifyFilesystemAccess({
      operation: 'write',
      inputPath,
      cwd: ctx.cwd,
      policy,
      sessionAllowPaths: sessionAllow,
      personaWriteRoots: active?.resolvedWriteRoots,
    });
    if (accessDecision.kind === 'allow') continue;

    if (!ctx.hasUI) {
      if (defaultFallback === 'allow') continue;
      return {
        block: {
          path: inputPath,
          reason:
            `No UI available for approval. Filesystem-protected path "${inputPath}" ` +
            `(${accessDecision.match.detail}). Set PI_FILESYSTEM_DEFAULT=allow to override, ` +
            'or pick a different path.',
        },
      };
    }

    // oxlint-disable-next-line no-await-in-loop -- prompts must serialize: a "deny" on path #2 aborts the rest of the patch
    const decision = await askForPermission(ctx, {
      tool: 'apply_patch',
      path: inputPath,
      detail: accessDecision.match.detail,
      sessionTargets: {
        file: accessDecision.absolutePath,
        parentDir: dirname(accessDecision.absolutePath),
        gitRoot: findGitRoot(dirname(accessDecision.absolutePath), existsSync),
      },
    });
    if (decision.kind === 'deny') {
      return {
        block: { path: inputPath, reason: decision.feedback ?? `Blocked by user (${accessDecision.match.detail})` },
      };
    }
    if (decision.kind === 'allow-session') sessionAllow.add(decision.path ?? accessDecision.absolutePath);
  }

  return {};
}

// ──────────────────────────────────────────────────────────────────────
// Plan commit (atomic per-file write, then deletions)
// ──────────────────────────────────────────────────────────────────────

function commitPlan(cwd: string, plan: WritePlan): void {
  // Source-of-move removals happen first so a rename of `a -> b`
  // where `a` and `b` differ only in case doesn't see the source file
  // re-created by the target write on a case-insensitive FS. The same
  // sequencing is fine on case-sensitive systems.
  for (const fromPath of plan.moves.keys()) {
    const absolute = isAbsolute(fromPath) ? fromPath : resolve(cwd, fromPath);
    try {
      unlinkSync(absolute);
    } catch {
      // The plan was validated against the snapshot — a missing
      // source here means a concurrent process raced us. Surface as
      // a thrown error so the tool returns isError: true.
      throw new Error(`apply_patch: failed to remove move source "${fromPath}"`);
    }
  }

  for (const [path, content] of plan.writes) {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    atomicWriteFile(absolute, content);
  }

  for (const path of plan.deletes) {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    try {
      unlinkSync(absolute);
    } catch {
      throw new Error(`apply_patch: failed to delete "${path}"`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Plan path enumeration for the gate (every write target and every
// delete / move source — i.e. anything `apply_patch` is going to mutate)
// ──────────────────────────────────────────────────────────────────────

function planPaths(plan: WritePlan): string[] {
  const paths = new Set<string>();
  for (const p of plan.writes.keys()) paths.add(p);
  for (const p of plan.deletes) paths.add(p);
  for (const [from, to] of plan.moves) {
    paths.add(from);
    paths.add(to);
  }
  return [...paths];
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function applyPatchExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_APPLY_PATCH_DISABLED)) return;

  const maxBytes = parsePositiveInt(process.env.PI_APPLY_PATCH_MAX_BYTES, DEFAULT_MAX_BYTES);
  const defaultFallback = process.env.PI_FILESYSTEM_DEFAULT === 'allow' ? 'allow' : 'deny';
  const sessionAllow = new Set<string>();
  const seenWarnings = new Set<string>();
  const { trace, notify } = makeDiagnostics({
    label: 'apply-patch',
    tracePath: process.env.PI_APPLY_PATCH_TRACE,
    debug: envTruthy(process.env.PI_APPLY_PATCH_DEBUG),
  });

  pi.on('session_shutdown', () => {
    sessionAllow.clear();
    seenWarnings.clear();
  });

  pi.registerTool({
    name: 'apply_patch',
    label: 'Apply patch',
    description:
      'Apply a Codex-format patch atomically against the working directory. Supports `*** Add File`, `*** Update File`, `*** Delete File`, and `*** Move File` ops in a single patch. All-or-nothing: any per-op error (hunk mismatch, missing source, overwrite-existing) aborts the whole patch and writes nothing. Each file write is gated by the same `filesystem` policy that `write` / `edit` use.',
    promptSnippet:
      'Use `apply_patch` for multi-file changes or large diffs; reach for `edit` for single-line targeted edits.',
    promptGuidelines: [
      'On a hunk-locate failure, the tool returns a recovery block as a second text part showing the file content around the candidate region — copy a fresh hunk against that text rather than re-emitting the same patch.',
    ],
    parameters: ApplyPatchParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const surfaceWarnings = (warnings: FilesystemPolicyWarning[]): void => {
        for (const w of warnings) {
          const key = `${w.source}|${w.reason}`;
          if (seenWarnings.has(key)) continue;
          seenWarnings.add(key);
          if (ctx.hasUI) ctx.ui.notify(`apply-patch: ${w.source}: ${w.reason}`, 'warning');
        }
      };

      // ── 1. parse ────────────────────────────────────────────────────
      const parsed = parsePatch(params.patch);
      if ('error' in parsed) {
        const msg = `apply_patch: parse error at line ${parsed.error.line}: ${parsed.error.message}`;
        trace(`parse-error: ${msg}`);
        return {
          content: [{ type: 'text', text: msg }],
          details: { ok: false, files: [], error: msg } satisfies ApplyPatchDetails,
          isError: true,
        };
      }

      // ── 2. validate + build write plan ──────────────────────────────
      let result: ReturnType<typeof applyPatch>;
      try {
        result = applyPatch(parsed.patch, buildReadFile(ctx.cwd, maxBytes));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        trace(`read-error: ${msg}`);
        return {
          content: [{ type: 'text', text: msg }],
          details: { ok: false, files: [], error: msg } satisfies ApplyPatchDetails,
          isError: true,
        };
      }

      if ('errors' in result) {
        const summary = result.errors.map((e) => `  • op[${e.opIndex}]: ${e.message}`).join('\n');
        const recoveryBlocks = result.errors.flatMap((e) => (e.recovery ? [e.recovery] : []));
        const errorText = `apply_patch: ${result.errors.length} op error(s):\n${summary}`;
        trace(`apply-error: ${result.errors.length} op(s)`);
        notify(ctx, `apply-patch: refused (${result.errors.length} op error(s))`, 'warning');
        const content: { type: 'text'; text: string }[] = [{ type: 'text', text: errorText }];
        if (recoveryBlocks.length > 0) content.push({ type: 'text', text: `\n${recoveryBlocks.join('\n\n')}` });
        return {
          content,
          details: { ok: false, files: [], error: errorText } satisfies ApplyPatchDetails,
          isError: true,
        };
      }

      // ── 3. filesystem-policy gate per affected path ─────────────────
      const paths = planPaths(result.plan);
      const gate = await gatePaths(ctx, paths, defaultFallback, sessionAllow, surfaceWarnings);
      if (gate.block) {
        const msg = `apply_patch: blocked at "${gate.block.path}" — ${gate.block.reason}`;
        trace(`gate-block: ${gate.block.path}`);
        return {
          content: [{ type: 'text', text: msg }],
          details: { ok: false, files: [], error: msg } satisfies ApplyPatchDetails,
          isError: true,
        };
      }

      // ── 4. commit ───────────────────────────────────────────────────
      try {
        commitPlan(ctx.cwd, result.plan);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        trace(`commit-error: ${msg}`);
        return {
          content: [{ type: 'text', text: msg }],
          details: { ok: false, files: [], error: msg } satisfies ApplyPatchDetails,
          isError: true,
        };
      }

      // ── 5. report ───────────────────────────────────────────────────
      const files: ApplyPatchDetails['files'] = [];
      for (const op of parsed.patch.ops) {
        if (op.type === 'move') files.push({ path: op.to, op: 'move', from: op.from });
        else if (op.type === 'add') files.push({ path: op.path, op: 'add' });
        else if (op.type === 'delete') files.push({ path: op.path, op: 'delete' });
        else files.push({ path: op.path, op: 'update' });
      }
      const summaryLines = files.map((f) => {
        if (f.op === 'move') return `  • move   ${f.from} -> ${f.path}`;
        return `  • ${f.op.padEnd(6)} ${f.path}`;
      });
      const text = `apply_patch: applied ${files.length} op(s):\n${summaryLines.join('\n')}`;
      trace(`ok: ${files.length} op(s)`);
      notify(ctx, `apply-patch: applied ${files.length} op(s)`, 'info');
      return {
        content: [{ type: 'text', text }],
        details: { ok: true, files } satisfies ApplyPatchDetails,
      };
    },

    renderCall(args, theme, _context) {
      const patch = String(args.patch ?? '');
      const opCount = patch.match(/^\*\*\* (Add|Update|Delete|Move) File:/gm)?.length ?? 0;
      const head = theme.fg('toolTitle', theme.bold('apply_patch '));
      const summary = theme.fg('muted', `${opCount} op${opCount === 1 ? '' : 's'}`);
      const firstHeader = patch.split(/\r?\n/).find((line) => line.startsWith('*** ') && !line.endsWith('Patch'));
      const hint = firstHeader ? ` ${theme.fg('dim', truncate(firstHeader, 60))}` : '';
      return new Text(`${head}${summary}${hint}`, 0, 0);
    },

    renderResult(result, _opts, theme, _context) {
      const details = (result.details ?? {}) as Partial<ApplyPatchDetails>;
      if (details.error) {
        return new Text(theme.fg('error', `✗ ${truncate(details.error, 200)}`), 0, 0);
      }
      const files = details.files ?? [];
      if (files.length === 0) {
        return new Text(theme.fg('dim', '(no files touched)'), 0, 0);
      }
      const lines: string[] = [theme.fg('success', `✓ ${files.length} op(s) applied`)];
      for (const f of files) {
        const label =
          f.op === 'move'
            ? `${theme.fg('dim', 'move  ')} ${f.from} → ${f.path}`
            : `${theme.fg('dim', `${f.op.padEnd(6)}`)} ${f.path}`;
        lines.push(`  ${label}`);
      }
      return new Text(lines.join('\n'), 0, 0);
    },
  });
}
