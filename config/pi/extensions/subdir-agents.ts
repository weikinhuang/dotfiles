/**
 * Subdir AGENTS.md / CLAUDE.md loader for pi.
 *
 * Pi's built-in context loader only walks UPWARD from `ctx.cwd` at startup,
 * so nested `AGENTS.md` / `CLAUDE.md` files in subdirectories are never
 * picked up. Claude Code, Codex, and opencode all do the opposite - they
 * lazily discover context files alongside whatever file the model touches,
 * so `tests/AGENTS.md` applies when editing `tests/foo.spec.ts`.
 *
 * This extension replicates that behaviour on top of pi:
 *
 *   1. On `before_agent_start` (first turn), record the absolute paths of
 *      every context file pi already loaded so we don't re-inject them.
 *   2. On `tool_call` for `read` / `write` / `edit`, walk from the target
 *      file's directory upward until `ctx.cwd`. For every directory that
 *      contains an `AGENTS.md` or `CLAUDE.md` not yet loaded, queue the
 *      file content as a steered user message.
 *   3. Delivery uses `pi.sendMessage({ deliverAs: "steer" })`, which gets
 *      the file content to the LLM after the current assistant turn's
 *      tool calls complete and before its next response - i.e. right when
 *      the model is about to reason about the file it just accessed.
 *
 * Scope choices:
 *   - Only triggers for files inside `ctx.cwd`. Nested context files
 *     outside the workspace aren't this extension's problem (pi already
 *     walks up at startup).
 *   - Only `read` / `write` / `edit` are gated. `bash` paths are too
 *     noisy to parse reliably; `grep` / `find` / `ls` don't imply the
 *     model is about to DO anything with the listed files.
 *   - Symlinked context files are deduped by `realpath` so a symlinked
 *     `CLAUDE.md -> AGENTS.md` (common pattern) doesn't inject twice.
 *   - Content is capped at {@link DEFAULT_CONTEXT_FILE_BYTE_CAP} bytes.
 *     Runaway AGENTS.md files can always be re-read with the `read` tool.
 *
 * Environment:
 *   PI_SUBDIR_AGENTS_DISABLED=1    skip the injector entirely
 *   PI_SUBDIR_AGENTS_NAMES=a,b,c   override the filenames to discover
 *                                  (default: AGENTS.md, CLAUDE.md)
 *
 * Commands:
 *   /subdir-agents    list everything this extension has loaded this
 *                     session, plus the startup-loaded baseline.
 *
 * Pure helpers (candidate discovery, size capping, message formatting)
 * live in ./lib/node/pi/subdir-agents.ts so they can be unit-tested under
 * `vitest` without pulling in the pi runtime.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { type ExtensionAPI, isToolCallEventType, type ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';

import {
  candidateContextPaths,
  capContent,
  DEFAULT_CONTEXT_FILE_BYTE_CAP,
  DEFAULT_CONTEXT_FILE_NAMES,
  displayPath,
  formatBytes,
  formatContextInjection,
  type LoadedContextFile,
  type SubdirAgentsDetails,
} from '../../../lib/node/pi/subdir-agents.ts';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract the `path` input from a read/write/edit tool call. Returns an
 * empty string for other tools or missing inputs.
 */
function getPathInput(event: ToolCallEvent): string {
  if (isToolCallEventType('read', event) || isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
    return String(event.input?.path ?? '').trim();
  }
  return '';
}

/**
 * Try to resolve the real path of `abs`. Returns `abs` itself on any I/O
 * error (missing file, permission denied, race against deletion). The
 * caller uses realpath only for dedup, so a fallback to the lexical path
 * is a safe default.
 */
function safeRealpath(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function parseFileNames(): readonly string[] {
  const raw = process.env.PI_SUBDIR_AGENTS_NAMES;
  if (!raw) return DEFAULT_CONTEXT_FILE_NAMES;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : DEFAULT_CONTEXT_FILE_NAMES;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function subdirAgents(pi: ExtensionAPI): void {
  if (process.env.PI_SUBDIR_AGENTS_DISABLED === '1') return;

  const fileNames = parseFileNames();

  // ────────────────────────────────────────────────────────────────────
  // TUI rendering
  // ────────────────────────────────────────────────────────────────────

  // The `content` field of the CustomMessageEntry holds the full AGENTS.md
  // text (that's what the LLM consumes). Without a custom renderer the
  // TUI would print that full text to the user on every injection, which
  // is noisy and redundant - the user just opened the file, they don't
  // need it echoed back. Render a compact status line instead, and only
  // list the individual file paths when the user expands the message.
  pi.registerMessageRenderer<SubdirAgentsDetails>('subdir-agents', (message, { expanded }, theme) => {
    const files = message.details?.files ?? [];
    const prefix = theme.fg('accent', '[subdir-agents]');
    let text: string;
    if (files.length === 0) {
      text = `${prefix} loaded context files`;
    } else if (files.length === 1) {
      const f = files[0];
      const trunc = f.truncated ? ' (truncated)' : '';
      text = `${prefix} loaded ${f.path} (${formatBytes(f.bytes)})${trunc}`;
    } else {
      const total = files.reduce((sum, f) => sum + f.bytes, 0);
      text = `${prefix} loaded ${files.length} context files (${formatBytes(total)} total)`;
    }

    if (expanded && files.length > 1) {
      for (const f of files) {
        const trunc = f.truncated ? ' (truncated)' : '';
        text += `\n${theme.fg('dim', `  ${f.path} - ${formatBytes(f.bytes)}${trunc}`)}`;
      }
    }

    const box = new Box(1, 1, (t) => theme.bg('customMessageBg', t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  // ────────────────────────────────────────────────────────────────────
  // State
  // ────────────────────────────────────────────────────────────────────

  /**
   * Absolute paths (plus their realpaths) we've already surfaced to the
   * LLM - both startup-loaded ones and anything this extension injected.
   * Keyed by both the resolved lexical path and the realpath so symlink
   * chains dedupe correctly.
   */
  const loaded = new Set<string>();

  /** Files we actually injected this session (for `/subdir-agents`). */
  const injected: string[] = [];
  /** Files pi loaded at startup (for `/subdir-agents`). */
  const baseline: string[] = [];

  let baselineSeeded = false;

  function markLoaded(abs: string): void {
    loaded.add(abs);
    const real = safeRealpath(abs);
    if (real !== abs) loaded.add(real);
  }

  pi.on('session_shutdown', () => {
    loaded.clear();
    injected.length = 0;
    baseline.length = 0;
    baselineSeeded = false;
  });

  pi.on('before_agent_start', (event, _ctx) => {
    if (baselineSeeded) return undefined;
    baselineSeeded = true;
    const files = event.systemPromptOptions?.contextFiles ?? [];
    for (const f of files) {
      if (!f?.path) continue;
      const abs = resolve(f.path);
      markLoaded(abs);
      baseline.push(abs);
    }
    return undefined;
  });

  pi.on('tool_call', async (event, ctx) => {
    const isRead = isToolCallEventType('read', event);
    const isWrite = isToolCallEventType('write', event) || isToolCallEventType('edit', event);
    if (!isRead && !isWrite) return undefined;

    const raw = getPathInput(event);
    if (!raw) return undefined;

    const absFile = resolve(ctx.cwd, raw);
    const candidates = candidateContextPaths(absFile, ctx.cwd, fileNames);
    if (candidates.length === 0) return undefined;

    const newlyLoaded: LoadedContextFile[] = [];
    for (const candidate of candidates) {
      if (loaded.has(candidate)) continue;
      if (!existsSync(candidate)) continue;
      const real = safeRealpath(candidate);
      if (loaded.has(real)) {
        // Different path, same inode (e.g. symlinked alias). Record the
        // alias so later accesses via this name skip the existsSync call.
        markLoaded(candidate);
        continue;
      }
      // If the tool is reading the candidate file itself, the model will
      // see its contents via the tool result - there's no point shipping
      // it a second time. Mark as loaded so future accesses in this
      // subtree don't re-inject it, but skip the injection here.
      if (candidate === absFile || real === safeRealpath(absFile)) {
        markLoaded(candidate);
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(candidate, 'utf8');
      } catch (e) {
        // Race against deletion or permission change - silent.
        console.warn(`[subdir-agents] failed to read ${candidate}: ${String(e)}`);
        continue;
      }
      const { content, truncated } = capContent(raw, DEFAULT_CONTEXT_FILE_BYTE_CAP);
      newlyLoaded.push({ path: candidate, content, truncated });
      markLoaded(candidate);
      injected.push(candidate);
    }

    if (newlyLoaded.length === 0) return undefined;

    // Ship shallowest-first so the LLM reads the parent guidance before
    // any child overrides. `candidateContextPaths` emits deepest-first.
    newlyLoaded.reverse();

    const message = formatContextInjection(newlyLoaded, ctx.cwd);

    // `deliverAs: "steer"` queues the message to be delivered after the
    // current assistant turn finishes its tool calls, before the next LLM
    // call. That's exactly when the model is about to reason about the
    // file it just accessed.
    pi.sendMessage(
      {
        customType: 'subdir-agents',
        content: message,
        display: true,
        details: {
          files: newlyLoaded.map((f) => ({
            path: displayPath(f.path, ctx.cwd),
            bytes: Buffer.byteLength(f.content, 'utf8'),
            truncated: f.truncated ?? false,
          })),
        },
      },
      { deliverAs: 'steer' },
    );

    return undefined;
  });

  // ────────────────────────────────────────────────────────────────────
  // Command
  // ────────────────────────────────────────────────────────────────────

  pi.registerCommand('subdir-agents', {
    description: 'Show AGENTS.md/CLAUDE.md files discovered in subdirectories this session',
    handler: async (_args, ctx) => {
      const lines: string[] = [];

      lines.push(`File names: ${fileNames.join(', ')}`);
      lines.push('');

      lines.push('Startup baseline (loaded by pi at session start):');
      if (baseline.length === 0) {
        lines.push('  (none - baseline not yet captured, or no AGENTS.md/CLAUDE.md in scope)');
      } else {
        for (const p of baseline) lines.push(`  ${displayPath(p, ctx.cwd)}`);
      }
      lines.push('');

      lines.push('Injected this session (from subdirectories):');
      if (injected.length === 0) {
        lines.push('  (none)');
      } else {
        for (const p of injected) lines.push(`  ${displayPath(p, ctx.cwd)}`);
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
