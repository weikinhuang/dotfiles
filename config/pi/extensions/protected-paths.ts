/**
 * Protected-paths gate for pi's `write` and `edit` tools.
 *
 * Prompts before pi writes to or edits:
 *   - `.env` and `.env.*` files (basename match, any depth)
 *   - anywhere inside a `node_modules/` directory
 *   - anywhere outside `ctx.cwd` (the current workspace)
 *
 * Approvals are **session-scoped only**. There is no persistent allowlist:
 * these paths are almost always incidental, and you rarely want pi to
 * silently touch an external file or a secret forever. The dialog offers:
 *
 *   1. Allow once
 *   2. Allow "<path>" for this session
 *   3. Deny
 *   4. Deny with feedback…
 *
 * In non-interactive mode (print / JSON / RPC without UI) the gate blocks
 * by default so the model sees a concrete reason and can retry differently.
 *
 * The `bash` tool is intentionally NOT gated here — `bash-permissions.ts`
 * owns that channel. A leading `~` in the tool's `path` argument is
 * expanded to the current user's home directory before classification so
 * an LLM writing to `~/.env` actually trips the `.env` / outside-workspace
 * rules instead of silently creating a `./~/.env` file. `~user/` syntax
 * is NOT supported. Symlink-following is intentionally NOT attempted:
 * the gate uses `path.resolve()` (lexical), so symlinks that escape the
 * workspace are still treated as "inside" if their link path is inside.
 * That's a known limitation — fix it with file-watcher-grade logic if you
 * need it.
 *
 * Environment:
 *   PI_PROTECTED_PATHS_DISABLED=1         skip the gate entirely
 *   PI_PROTECTED_PATHS_DEFAULT=allow      in non-UI mode, allow instead
 *                                         of blocking
 *   PI_PROTECTED_PATHS_EXTRA_GLOBS=a,b,c  extra basename globs to protect
 *                                         (glob syntax: `*` and `?`)
 *
 * Commands:
 *   /protected-paths   list session allowlist + current protection rules
 *
 * Pure helpers (expandTilde, classify, globToRegex, …) live in
 * ./lib/paths.ts so they can be unit-tested under plain `node --test`
 * without pulling in the pi runtime.
 */

import { resolve } from 'node:path';
import {
  type EditToolCallEvent,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  type WriteToolCallEvent,
} from '@mariozechner/pi-coding-agent';
import { classify, DEFAULT_SENSITIVE_BASENAMES, expandTilde, globToRegex, type Protection } from './lib/paths.ts';

// ──────────────────────────────────────────────────────────────────────
// Prompt
// ──────────────────────────────────────────────────────────────────────

type Decision = { kind: 'allow-once' } | { kind: 'allow-session' } | { kind: 'deny'; feedback?: string };

async function askForPermission(
  ctx: ExtensionContext,
  toolName: string,
  path: string,
  protection: Protection,
): Promise<Decision> {
  interface Entry {
    label: string;
    decision: Decision | 'deny-feedback';
  }
  const entries: Entry[] = [
    { label: 'Allow once', decision: { kind: 'allow-once' } },
    { label: `Allow "${path}" for this session`, decision: { kind: 'allow-session' } },
    { label: 'Deny', decision: { kind: 'deny' } },
    { label: 'Deny with feedback…', decision: 'deny-feedback' },
  ];

  const choice = await ctx.ui.select(
    `⚠️  ${toolName} wants to touch a protected path:\n\n  ${path}\n  (${protection.detail})\n\nHow should pi proceed?`,
    entries.map((e) => e.label),
  );

  const picked = entries.find((e) => e.label === choice);
  if (!picked) return { kind: 'deny' };

  if (picked.decision === 'deny-feedback') {
    const feedback = await ctx.ui.input('Tell the assistant why:', 'e.g. write to src/foo.ts instead');
    return { kind: 'deny', feedback: feedback?.trim() || undefined };
  }
  return picked.decision;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

export default function protectedPaths(pi: ExtensionAPI): void {
  if (process.env.PI_PROTECTED_PATHS_DISABLED === '1') return;

  const defaultFallback = process.env.PI_PROTECTED_PATHS_DEFAULT === 'allow' ? 'allow' : 'deny';

  const extraRegexes: RegExp[] = (process.env.PI_PROTECTED_PATHS_EXTRA_GLOBS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegex);

  // Session allowlist: resolved-absolute paths the user OK'd this session.
  const sessionAllow = new Set<string>();

  pi.on('session_shutdown', () => {
    sessionAllow.clear();
  });

  const getPath = (event: EditToolCallEvent | WriteToolCallEvent): string => String(event.input?.path ?? '').trim();

  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('write', event) && !isToolCallEventType('edit', event)) {
      return undefined;
    }
    const inputPath = getPath(event);
    if (!inputPath) return undefined;

    const absolute = resolve(ctx.cwd, expandTilde(inputPath));
    if (sessionAllow.has(absolute)) return undefined;

    const protection = classify(inputPath, ctx.cwd, extraRegexes);
    if (!protection) return undefined;

    if (!ctx.hasUI) {
      if (defaultFallback === 'allow') return undefined;
      return {
        block: true,
        reason:
          `No UI available for approval. Protected path "${inputPath}" ` +
          `(${protection.detail}). Set PI_PROTECTED_PATHS_DEFAULT=allow to override, ` +
          'or pick a different path inside the workspace.',
      };
    }

    const decision = await askForPermission(ctx, event.toolName, inputPath, protection);
    if (decision.kind === 'deny') {
      return {
        block: true,
        reason: decision.feedback ?? `Blocked by user (protected path: ${protection.detail})`,
      };
    }
    if (decision.kind === 'allow-session') {
      sessionAllow.add(absolute);
    }
    return undefined;
  });

  // ────────────────────────────────────────────────────────────────────
  // Command
  // ────────────────────────────────────────────────────────────────────

  pi.registerCommand('protected-paths', {
    description: 'Show session allowlist and active protected-path rules',
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      lines.push('Protected patterns:');
      for (const glob of DEFAULT_SENSITIVE_BASENAMES) lines.push(`  basename: ${glob}`);
      lines.push('  segment:  node_modules/');
      lines.push(`  scope:    outside ${ctx.cwd}`);
      for (const rx of extraRegexes) lines.push(`  extra:    ${rx.source}`);

      lines.push('');
      lines.push('Session allowlist (cleared on session_shutdown):');
      if (sessionAllow.size === 0) {
        lines.push('  (empty)');
      } else {
        for (const p of sessionAllow) lines.push(`  ${p}`);
      }
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
