/**
 * `checkpoint` - Claude-Code-style code checkpoint/rewind, built on pi's own
 * conversation tree instead of a parallel history.
 *
 * pi already navigates its session tree non-destructively (go back / roll
 * forward / fork); it just never moves *code* in lockstep. This extension
 * snapshots the files its `write` / `edit` / `apply_patch` tools touch per
 * user message, anchors each snapshot to the session-tree entry the message
 * hung off, and - when the user navigates or forks the tree - opens an
 * interactive review (per-file diff summary, drill-down, multi-select) to
 * restore files to match the destination. Restore is never silent.
 *
 * Two modes (see `checkpoint.json`):
 *   - `tool` (default): snapshot the before/after bytes of each file the
 *     write tools touch. No git; restore never reasons about gitignore.
 *   - `full`: additionally snapshot the whole work-tree per message via a
 *     side git-dir, so bash-made changes (`sed -i`, `mv`, redirects) are
 *     reversible too. The review is then derived from the git tree diff.
 *
 * All pure logic (resolution, conflict classification, diff, restore plan,
 * config, git argv) lives under `lib/node/pi/checkpoint/` and is vitest-
 * covered; this shell holds only the pi-coupled glue: the hooks, the
 * `ctx.ui.custom` review overlay, and the side-process git exec.
 *
 * Environment:
 *   PI_CHECKPOINT_DISABLED=1       skip the extension entirely
 *   PI_CHECKPOINT_DISABLE_FULL=1   force `mode: "tool"` regardless of config
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  isToolCallEventType,
} from '@earendil-works/pi-coding-agent';

import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { showModal } from '../../../lib/node/pi/ext/show-modal.ts';
import { ReviewOverlay } from '../../../lib/node/pi/ext/checkpoint-review-overlay.ts';
import { capturePaths } from '../../../lib/node/pi/checkpoint/capture.ts';
import { rewindCompletions } from '../../../lib/node/pi/checkpoint/complete.ts';
import { type CheckpointConfig, DEFAULT_CONFIG, loadCheckpointConfig } from '../../../lib/node/pi/checkpoint/config.ts';
import { formatCheckpointList, outOfSyncWidgetText } from '../../../lib/node/pi/checkpoint/format.ts';
import * as git from '../../../lib/node/pi/checkpoint/gitsnap.ts';
import { resolveFileTargets } from '../../../lib/node/pi/checkpoint/resolve.ts';
import { buildRestorePlan } from '../../../lib/node/pi/checkpoint/restore.ts';
import { buildReviewRow, sortReviewRows } from '../../../lib/node/pi/checkpoint/review.ts';
import {
  checkpointStoreDir,
  deriveProjectKey,
  getBlob,
  hashBytes,
  listManifests,
  pruneOldManifests,
  putBlob,
  writeManifest,
} from '../../../lib/node/pi/checkpoint/store.ts';
import type {
  CaptureTool,
  CheckpointEntry,
  CheckpointManifest,
  FileTarget,
  ReviewRow,
} from '../../../lib/node/pi/checkpoint/types.ts';
import { REWIND_USAGE } from '../../../lib/node/pi/checkpoint/usage.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';

const WIDGET_KEY = 'checkpoint-out-of-sync';
const CAPTURE_TOOLS: CaptureTool[] = ['write', 'edit', 'apply_patch'];

// ──────────────────────────────────────────────────────────────────────────
// git side-process helpers (full mode)
// ──────────────────────────────────────────────────────────────────────────

// stdio: stderr is ignored so probes like `rev-parse --show-toplevel` in a
// non-git cwd don't leak `fatal: not a git repository` to the user's terminal.
function gitText(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stdout?: Buffer | string };
    return { ok: false, stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString('utf8') ?? '') };
  }
}

function gitBytes(args: string[], cwd: string): Buffer | undefined {
  try {
    return execFileSync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

const execFileAsync = promisify(execFile);

// Async git for the boot-path-deferred rebuild. execFile buffers stderr (never
// inherits), so a non-git cwd's "fatal: not a git repository" can't leak.
async function gitTextAsync(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// path + disk helpers
// ──────────────────────────────────────────────────────────────────────────

function absPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Read a file's bytes → { text, hash }, or { null, null } if absent/unreadable. */
function readDisk(abs: string): { text: string | null; hash: string | null } {
  try {
    const buf = readFileSync(abs);
    return { text: buf.toString('utf8'), hash: hashBytes(buf) };
  } catch {
    return { text: null, hash: null };
  }
}

export default function checkpoint(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_CHECKPOINT_DISABLED)) return;
  const disableFull = envTruthy(process.env.PI_CHECKPOINT_DISABLE_FULL);

  // ── session-scoped state (rebuilt on session_start, dropped on shutdown) ──
  // cfg starts at the built-in defaults with NO disk I/O - the real config +
  // store + manifest index load on session_start, deferred off the boot path
  // (see scheduleRebuild). `configLoaded` guards the lazy sync fallback.
  let cfg: CheckpointConfig = { ...DEFAULT_CONFIG, full: { ...DEFAULT_CONFIG.full } };
  let configLoaded = false;
  let storeDir = '';
  let projectRoot = '';
  /** Resolves when the background rebuild (config + store + index) has finished. */
  let ready: Promise<void> = Promise.resolve();
  /** Manifest index, keyed by anchor entry id. */
  const manifests = new Map<string, CheckpointManifest>();
  /** The open manifest for the in-flight user message. */
  let pending: { leafEntryId: string; timestamp: number; entries: CheckpointEntry[]; treeRef?: string } | undefined;
  /** Provisional `before` captures per tool call, finalized at tool_result. */
  const provisional = new Map<string, { path: string; before: string | null; removed: boolean }[]>();
  /** Close handle for an open review overlay (so /reload doesn't leak focus). */
  let activeDone: ((value: FileTarget[] | null) => void) | undefined;
  /** Anchor ids snapshotted for `/rewind` completion (completions get no ctx). */
  let anchorIds: string[] = [];

  function sideGitDir(): string {
    return git.sideGitDir(storeDir);
  }

  function refreshAnchorIds(): void {
    anchorIds = [...manifests.values()].sort((a, b) => b.timestamp - a.timestamp).map((m) => m.leafEntryId);
  }

  // ── project key + store resolution (deferred off the boot path) ──────────

  function projectRootFallback(cwd: string): string {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  }

  /** Re-read the on-disk manifests into the in-memory index. */
  function reloadIndex(): void {
    manifests.clear();
    for (const m of listManifests(storeDir)) manifests.set(m.leafEntryId, m);
    refreshAnchorIds();
  }

  /**
   * Synchronous fallback that loads only the essentials (config + storeDir) a
   * capture needs. Normally a no-op because {@link scheduleRebuild} already set
   * them; it only does real work in the rare race where a tool runs before the
   * background rebuild finished. Spawns git synchronously then - at message
   * time, never at boot.
   */
  function ensureEssentialsSync(cwd: string): void {
    if (!configLoaded) {
      cfg = loadCheckpointConfig(cwd, disableFull);
      configLoaded = true;
    }
    if (!storeDir) {
      const r = gitText(['rev-parse', '--show-toplevel'], cwd);
      const root = r.ok && r.stdout.trim() ? r.stdout.trim() : projectRootFallback(cwd);
      projectRoot = root;
      storeDir = checkpointStoreDir(deriveProjectKey(root));
    }
  }

  /**
   * Kick off the config + store + manifest-index load in the background and
   * return immediately, so `session_start` never blocks pi's boot on a git
   * spawn, a manifest-dir scan, or a retention sweep. Retention pruning is
   * detached one level deeper (lowest priority - nothing awaits it).
   */
  function scheduleRebuild(cwd: string): void {
    ready = (async () => {
      cfg = loadCheckpointConfig(cwd, disableFull);
      configLoaded = true;
      const stdout = await gitTextAsync(['rev-parse', '--show-toplevel'], cwd);
      projectRoot = stdout?.trim() ? stdout.trim() : projectRootFallback(cwd);
      storeDir = checkpointStoreDir(deriveProjectKey(projectRoot));
      reloadIndex();
    })().catch(() => {
      /* best-effort: a navigation/rewind will lazily ensure essentials */
    });
    void ready.then(() => {
      try {
        pruneOldManifests(storeDir, cfg.retentionDays);
        reloadIndex();
      } catch {
        /* prune is maintenance; ignore failures */
      }
    });
  }

  /** Await the background rebuild; lazily backfill essentials + index if it failed. */
  async function ensureReady(cwd: string): Promise<void> {
    await ready;
    if (!storeDir) {
      ensureEssentialsSync(cwd);
      reloadIndex();
    }
  }

  // ── full-mode snapshot ────────────────────────────────────────────────────

  function fullSnapshot(cwd: string): string | undefined {
    if (cfg.mode !== 'full') return undefined;
    const gd = sideGitDir();
    // git init won't create the git-dir's missing parent, so make the store
    // dir first (the tool-capture path also creates it lazily, but a bash-only
    // message never hits that path).
    mkdirSync(storeDir, { recursive: true });
    gitText(git.initArgs(gd), cwd);
    gitText(git.addAllArgs(gd, cwd), cwd);
    const staged = git.parseNameOnly(gitText(git.stagedNameOnlyArgs(gd, cwd), cwd).stdout);
    let bytes = 0;
    for (const p of staged) {
      try {
        bytes += statSync(absPath(cwd, p)).size;
      } catch {
        /* ignore */
      }
    }
    const cap = git.withinCaps(staged, bytes, cfg.full.maxStagedFiles, cfg.full.maxStagedBytes);
    // Over a cap → skip the tree snapshot (the cap is the backstop behind the
    // .gitignore exclusion). The message is still tool-snapshotted.
    if (!cap.ok) return undefined;
    gitText(git.commitArgs(gd, cwd, `checkpoint ${new Date().toISOString()}`), cwd);
    const head = gitText(git.revParseHeadArgs(gd, cwd), cwd);
    return head.ok ? head.stdout.trim() || undefined : undefined;
  }

  /**
   * Full mode: snapshot the post-message work-tree and anchor it to the result
   * leaf, so every leaf carries a treeRef = state AS OF that leaf (the start
   * leaf gets the pre-message treeRef from `agent_start`; the result leaf gets
   * the post-message one here). This makes "navigate to L ⇒ restore treeRef(L)"
   * correct in both directions. Upserts so an existing tool manifest keeps its
   * entries.
   */
  function recordResultTreeRef(cwd: string, leafId: string | null): void {
    if (cfg.mode !== 'full' || !leafId) return;
    const treeRef = fullSnapshot(cwd);
    if (!treeRef) return;
    const existing = manifests.get(leafId);
    const manifest: CheckpointManifest = existing
      ? { ...existing, treeRef }
      : { leafEntryId: leafId, timestamp: Date.now(), entries: [], treeRef };
    manifests.set(leafId, manifest);
    writeManifest(storeDir, manifest);
    refreshAnchorIds();
  }

  // ── review construction ───────────────────────────────────────────────────

  /** Nearest manifest on a root→leaf path that carries a git treeRef (full mode). */
  function nearestTreeRef(path: string[]): string | undefined {
    for (let i = path.length - 1; i >= 0; i--) {
      const m = manifests.get(path[i]);
      if (m?.treeRef) return m.treeRef;
    }
    return undefined;
  }

  function pathIds(ctx: ExtensionContext, leafId: string | null): string[] {
    if (!leafId) return [];
    return ctx.sessionManager.getBranch(leafId).map((e) => e.id);
  }

  /** Build one review row for a resolved target, or undefined to hide it. */
  function rowFor(ctx: ExtensionContext, target: FileTarget): ReviewRow | undefined {
    const disk = readDisk(absPath(ctx.cwd, target.path));
    // Read the target blob lazily so a hidden no-op row never pays for it.
    return buildReviewRow(
      target,
      disk.text,
      disk.hash,
      () => (target.target === null ? null : (getBlob(storeDir, target.target)?.toString('utf8') ?? '')),
      { hideNoOpRows: cfg.hideNoOpRows, conflictRowsDefaultChecked: cfg.conflictRowsDefaultChecked },
    );
  }

  /** Tool-mode review: resolve targets from before/after blobs, classify vs disk. */
  function buildReviewTool(ctx: ExtensionContext, oldLeafId: string | null, newLeafId: string | null): ReviewRow[] {
    const oldPath = pathIds(ctx, oldLeafId);
    const newPath = pathIds(ctx, newLeafId);
    const { targets } = resolveFileTargets(oldPath, newPath, [...manifests.values()]);
    return targets.map((t) => rowFor(ctx, t)).filter((r): r is ReviewRow => r !== undefined);
  }

  /** Full-mode review: diff the target snapshot tree against disk, blob the contents. */
  function buildReviewFull(ctx: ExtensionContext, oldLeafId: string | null, newLeafId: string | null): ReviewRow[] {
    const gd = sideGitDir();
    const cwd = ctx.cwd;
    const targetRef = nearestTreeRef(pathIds(ctx, newLeafId));
    if (!targetRef) return [];
    const oldRef = nearestTreeRef(pathIds(ctx, oldLeafId));

    const changed = git.parseNameStatusZ(gitText(git.diffNameStatusArgs(gd, cwd, targetRef), cwd).stdout);
    const rows: ReviewRow[] = [];
    for (const { path } of changed) {
      // Target content from the snapshot tree (absent → null), blobbed so the
      // restore path is identical to tool mode.
      const targetBuf = gitBytes(git.showFileArgs(gd, cwd, targetRef, path), cwd);
      const target = targetBuf === undefined ? null : putBlob(storeDir, targetBuf);
      const expectedBuf = oldRef === undefined ? undefined : gitBytes(git.showFileArgs(gd, cwd, oldRef, path), cwd);
      const expectedCurrent = expectedBuf === undefined ? null : putBlob(storeDir, expectedBuf);
      const row = rowFor(ctx, { path, target, expectedCurrent });
      if (row) rows.push(row);
    }
    return rows;
  }

  function buildReview(ctx: ExtensionContext, oldLeafId: string | null, newLeafId: string | null): ReviewRow[] {
    const rows =
      cfg.mode === 'full' ? buildReviewFull(ctx, oldLeafId, newLeafId) : buildReviewTool(ctx, oldLeafId, newLeafId);
    return sortReviewRows(rows);
  }

  // ── apply + widget ─────────────────────────────────────────────────────────

  function applySelected(ctx: ExtensionContext, selected: FileTarget[]): number {
    let applied = 0;
    for (const action of buildRestorePlan(selected)) {
      const abs = absPath(ctx.cwd, action.path);
      try {
        if (action.kind === 'delete') {
          unlinkSync(abs);
        } else if (action.sha) {
          const buf = getBlob(storeDir, action.sha);
          if (buf === undefined) continue;
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, buf);
        }
        applied++;
      } catch {
        /* best-effort per file */
      }
    }
    return applied;
  }

  /**
   * Full mode only: after restoring the selected files, offer to remove files
   * created since the target snapshot that were never checkpointed (untracked
   * in the side repo, so the `git diff` review can't see them). Scoped to the
   * parent dirs of the applied files, `git clean -fd` (never `-x`, so ignored
   * files are safe), confirmation-gated with a preview of exactly what would
   * be removed. Skipped headless when a confirm is required (can't prompt).
   */
  async function fullModeClean(ctx: ExtensionContext, appliedPaths: string[]): Promise<void> {
    if (cfg.mode !== 'full' || appliedPaths.length === 0) return;
    const gd = sideGitDir();
    const dirs = [...new Set(appliedPaths.map((p) => dirname(p) || '.'))];
    const preview = git.parseCleanDryRun(gitText(git.cleanDryRunArgs(gd, ctx.cwd, dirs), ctx.cwd).stdout);
    if (preview.length === 0) return;
    if (cfg.full.confirmClean) {
      if (!ctx.hasUI) return; // can't confirm headless → leave created-since files alone
      const head = preview.slice(0, 20).join('\n');
      const more = preview.length > 20 ? `\n…and ${preview.length - 20} more` : '';
      const ok = await ctx.ui.confirm(`Remove ${preview.length} file(s) created since the snapshot?`, `${head}${more}`);
      if (!ok) return;
    }
    gitText(git.cleanArgs(gd, ctx.cwd, dirs), ctx.cwd);
  }

  /** Set or clear the "code ahead of conversation" widget based on residual drift. */
  function updateWidget(ctx: ExtensionContext, leftover: number): void {
    if (!ctx.hasUI || !cfg.showOutOfSyncWidget) return;
    if (leftover > 0) {
      ctx.ui.setWidget(WIDGET_KEY, [outOfSyncWidgetText(leftover)], {
        placement: 'aboveEditor',
      });
    } else {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }

  // ── the review flow (dry-run → overlay → apply) ────────────────────────────

  function openOverlay(ctx: ExtensionContext, rows: ReviewRow[]): Promise<FileTarget[] | null> {
    return showModal<FileTarget[] | null>(ctx.ui, (tui, theme, _kb, done) => {
      const overlay = new ReviewOverlay(theme, rows, tui, done);
      activeDone = done;
      return overlay;
    }).then((result) => {
      activeDone = undefined;
      return result;
    });
  }

  async function runReview(ctx: ExtensionContext, oldLeafId: string | null, newLeafId: string | null): Promise<void> {
    const rows = buildReview(ctx, oldLeafId, newLeafId);
    if (rows.length === 0) {
      updateWidget(ctx, 0);
      return; // empty plan → silent no-op (never interrupts)
    }

    // Non-interactive (auto / no UI): apply the default-checked rows silently.
    if (cfg.autoReviewOnNavigate === 'auto' || !ctx.hasUI) {
      const sel = rows.filter((r) => r.checked).map((r) => r.target);
      applySelected(ctx, sel);
      await fullModeClean(
        ctx,
        sel.map((t) => t.path),
      );
      const leftover = buildReview(ctx, oldLeafId, newLeafId).filter((r) => r.status !== 'no-op').length;
      updateWidget(ctx, leftover);
      return;
    }
    if (cfg.autoReviewOnNavigate === 'off') {
      updateWidget(ctx, rows.filter((r) => r.status !== 'no-op').length);
      return;
    }

    const selected = await openOverlay(ctx, rows);
    if (selected && selected.length > 0) {
      applySelected(ctx, selected);
      await fullModeClean(
        ctx,
        selected.map((t) => t.path),
      );
    }
    // Recompute residual drift against the destination to drive the widget.
    const leftover = buildReview(ctx, oldLeafId, newLeafId).filter((r) => r.status !== 'no-op').length;
    updateWidget(ctx, leftover);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hooks
  // ──────────────────────────────────────────────────────────────────────────

  pi.on('session_start', (event, ctx) => {
    // Boot path: kick off the config + store + index load in the background and
    // return immediately. Nothing heavy (git spawn, manifest scan, retention
    // sweep) runs synchronously here.
    scheduleRebuild(ctx.cwd);
    // After a fork lands, treat it like navigation: restore code to match the
    // fork point so the new branch starts in sync (honors reviewOnFork). Wait
    // for the index first, off the boot path.
    if (event.reason === 'fork') {
      void ensureReady(ctx.cwd).then(() => {
        if (cfg.reviewOnFork) return runReview(ctx, null, ctx.sessionManager.getLeafId());
      });
    }
  });

  pi.on('agent_start', (_event, ctx) => {
    const leafEntryId = ctx.sessionManager.getLeafId();
    if (!leafEntryId) {
      pending = undefined;
      return;
    }
    // Ensure config + storeDir are resolved before we capture. Normally a no-op
    // (the background rebuild already finished); the sync fallback only fires in
    // the rare race where a turn starts before it did - at message time, not boot.
    ensureEssentialsSync(ctx.cwd);
    pending = { leafEntryId, timestamp: Date.now(), entries: [], treeRef: fullSnapshot(ctx.cwd) };
    provisional.clear();
  });

  pi.on('tool_call', (event, ctx) => {
    if (!pending) return undefined;
    const tool = CAPTURE_TOOLS.find((t) => isToolCallEventType(t as 'write', event as never));
    if (!tool) return undefined;
    const captured: { path: string; before: string | null; removed: boolean }[] = [];
    for (const { path, removed } of capturePaths(tool, (event as { input: unknown }).input)) {
      const abs = absPath(ctx.cwd, path);
      // Per-file cap: skip oversized files (marked non-restorable by omission).
      const size = (() => {
        try {
          return statSync(abs).size;
        } catch {
          return 0;
        }
      })();
      if (size > cfg.maxFileBytes) continue;
      const disk = readDisk(abs);
      const before = disk.text === null ? null : putBlob(storeDir, Buffer.from(disk.text, 'utf8'));
      captured.push({ path, before, removed });
    }
    if (captured.length > 0) provisional.set(event.toolCallId, captured);
    return undefined;
  });

  pi.on('tool_result', (event, ctx) => {
    if (!pending) return undefined;
    const captured = provisional.get(event.toolCallId);
    if (!captured) return undefined;
    provisional.delete(event.toolCallId);
    if (event.isError) return undefined; // blocked/failed write → discard provisional
    const resultToolName = (event as { toolName?: string }).toolName;
    const tool: CaptureTool = CAPTURE_TOOLS.find((t) => t === resultToolName) ?? 'write';
    for (const c of captured) {
      let after: string | null = null;
      if (!c.removed) {
        const disk = readDisk(absPath(ctx.cwd, c.path));
        after = disk.text === null ? null : putBlob(storeDir, Buffer.from(disk.text, 'utf8'));
      }
      pending.entries.push({ path: c.path, before: c.before, after, tool, toolCallId: event.toolCallId });
    }
    return undefined;
  });

  pi.on('agent_end', (_event, ctx) => {
    if (!pending) return;
    // Persist the start-leaf manifest if there's anything to anchor: tool
    // entries (tool mode) OR the pre-message tree snapshot (full mode). A
    // message with neither leaves no manifest.
    if (pending.entries.length > 0 || pending.treeRef) {
      const manifest: CheckpointManifest = {
        leafEntryId: pending.leafEntryId,
        timestamp: pending.timestamp,
        entries: pending.entries,
        ...(pending.treeRef ? { treeRef: pending.treeRef } : {}),
      };
      manifests.set(manifest.leafEntryId, manifest);
      writeManifest(storeDir, manifest);
      refreshAnchorIds();
    }
    const startLeaf = pending.leafEntryId;
    pending = undefined;
    provisional.clear();
    // Full mode: also snapshot the post-message state onto the (new) result
    // leaf, so it carries a treeRef = state at that leaf.
    const resultLeaf = ctx.sessionManager.getLeafId();
    if (resultLeaf && resultLeaf !== startLeaf) recordResultTreeRef(ctx.cwd, resultLeaf);
  });

  pi.on('session_tree', async (event, ctx) => {
    await ensureReady(ctx.cwd); // index may still be loading right after boot
    await runReview(ctx, event.oldLeafId, event.newLeafId);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    try {
      activeDone?.(null);
    } catch {
      /* ignore */
    }
    activeDone = undefined;
    try {
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* ignore */
    }
    manifests.clear();
    provisional.clear();
    pending = undefined;
    // Reset the boot-path state so the next session_start rebuilds from scratch.
    ready = Promise.resolve();
    configLoaded = false;
    storeDir = '';
  });

  // ──────────────────────────────────────────────────────────────────────────
  // /rewind command
  // ──────────────────────────────────────────────────────────────────────────

  pi.registerCommand('rewind', {
    description: 'Review and restore files to match a point in the conversation',
    getArgumentCompletions: (prefix) => rewindCompletions(prefix, anchorIds),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(REWIND_USAGE, 'info');
        return;
      }
      await ensureReady(ctx.cwd); // the index may still be loading right after boot
      const arg = args.trim();

      if (arg === 'list') {
        if (manifests.size === 0) {
          ctx.ui.notify('No checkpoints recorded yet.', 'info');
          return;
        }
        ctx.ui.notify(formatCheckpointList([...manifests.values()]), 'info');
        return;
      }

      // /rewind <entryId>: review/restore to that anchor without moving the leaf.
      if (arg.length > 0) {
        if (!manifests.has(arg)) {
          ctx.ui.notify(`No checkpoint anchored to "${arg}". Try /rewind list.`, 'warning');
          return;
        }
        await runReview(ctx, ctx.sessionManager.getLeafId(), arg);
        return;
      }

      // bare /rewind: reconcile disk against the recorded state at the CURRENT
      // leaf and reopen the review (the deferred / change-your-mind path). The
      // null "from" makes the whole leaf ancestry the redo leg, so every file
      // whose disk drifted from its recorded leaf state surfaces as a row.
      const leaf = ctx.sessionManager.getLeafId();
      await runReview(ctx, null, leaf);
    },
  });
}
