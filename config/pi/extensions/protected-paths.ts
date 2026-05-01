/**
 * Protected-paths gate for pi's `read`, `write`, and `edit` tools.
 *
 * Prompts before pi touches sensitive paths, with separate rule sets for
 * the two threat models:
 *
 *   - `read` rules   gate the `read` tool. Aimed at files whose CONTENTS
 *                    are sensitive (secrets, private keys). Defaults:
 *                      basenames: .env, .env.*, .envrc
 *                      paths:     ~/.ssh
 *   - `write` rules  gate `write` / `edit`. Aimed at files/dirs that are
 *                    dangerous to MUTATE even if reading is fine. Defaults:
 *                      segments: node_modules, .git
 *
 * The effective write rule set is `read ∪ write` — anything sensitive to
 * read is trivially sensitive to write, so there's no point duplicating
 * entries. The `read` rules do NOT include an outside-workspace check
 * (reading external files is often legit); `write` rules do.
 *
 * Rules are additive across four layers (any match prompts — there's
 * deliberately no "deny" escape hatch, since the point of the gate is
 * to make accidental access LOUD):
 *
 *   1. Built-in defaults  (DEFAULT_CONFIG in ./lib/paths.ts)
 *   2. User config:       `~/.pi/protected-paths.json`
 *   3. Project config:    `.pi/protected-paths.json` inside ctx.cwd
 *   4. Env var:           PI_PROTECTED_PATHS_EXTRA_GLOBS (extra basename
 *                         globs, merged into BOTH read and write)
 *
 * Config files are JSONC (`//` and C-style block comments allowed). Shape:
 *
 *   {
 *     "read": {
 *       "basenames": ["*.key"],
 *       "segments":  [],
 *       "paths":     ["~/secrets"]
 *     },
 *     "write": {
 *       "basenames": [],
 *       "segments":  [".terraform"],
 *       "paths":     []
 *     }
 *   }
 *
 * Approvals (interactive dialog):
 *
 *   1. Allow once
 *   2. Allow "<path>" for this session
 *   3. Deny
 *   4. Deny with feedback…
 *
 * The session allowlist is shared across tools: approving a path for the
 * session satisfies subsequent reads AND writes of the same file. That's
 * intentional — if you vetted the path for one access, you vetted it for
 * the other.
 *
 * In non-interactive mode (print / JSON / RPC without UI) the gate blocks
 * by default so the model sees a concrete reason and can retry differently.
 *
 * The `bash` tool is intentionally NOT gated here — `bash-permissions.ts`
 * owns that channel. `grep`, `find`, `ls` also aren't gated (yet); their
 * output is already constrained by pi's size limits and they rarely
 * exfiltrate secrets on their own. Add them here if that assumption changes.
 *
 * A leading `~` is expanded to the current user's home before classification
 * (`~/.ssh/config` → `$HOME/.ssh/config`), so tilde paths can't sneak past
 * the path-prefix or basename checks. `~user/` syntax is NOT supported.
 * Symlink-following is intentionally NOT attempted — the gate uses
 * `path.resolve()` (lexical), so symlinks that escape a protected path
 * are treated as their link path. Fix with file-watcher-grade logic if
 * you need it.
 *
 * Environment:
 *   PI_PROTECTED_PATHS_DISABLED=1         skip the gate entirely
 *   PI_PROTECTED_PATHS_DEFAULT=allow      in non-UI mode, allow instead
 *                                         of blocking
 *   PI_PROTECTED_PATHS_EXTRA_GLOBS=a,b,c  extra basename globs, merged
 *                                         into BOTH read and write
 *
 * Commands:
 *   /protected-paths   list active rules (grouped by source) + session allowlist
 *
 * Pure helpers (classify, classifyRead, classifyWrite, mergeConfigs, …)
 * live in ./lib/paths.ts so they can be unit-tested under
 * `vitest` without pulling in the pi runtime.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  type ToolCallEvent,
} from '@mariozechner/pi-coding-agent';
import { clearConfigWarning, parseJsonc, warnBadConfigFileOnce } from '../../../lib/node/pi/jsonc.ts';
import {
  classifyRead,
  classifyWrite,
  DEFAULT_CONFIG,
  emptyConfig,
  expandTilde,
  mergeConfigs,
  type Protection,
  type ProtectionConfig,
} from '../../../lib/node/pi/paths.ts';

// ──────────────────────────────────────────────────────────────────────
// Rule file loading
// ──────────────────────────────────────────────────────────────────────

const USER_RULES_PATH = join(homedir(), '.pi', 'protected-paths.json');
const PROJECT_RULES_RELATIVE = join('.pi', 'protected-paths.json');

function projectRulesPath(cwd: string): string {
  return resolve(cwd, PROJECT_RULES_RELATIVE);
}

function readConfig(path: string): ProtectionConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // File missing / unreadable — silent.
    return emptyConfig();
  }
  try {
    const parsed = parseJsonc<Partial<ProtectionConfig>>(raw);
    clearConfigWarning('protected-paths', path);
    return mergeConfigs(parsed);
  } catch (e) {
    warnBadConfigFileOnce('protected-paths', path, e);
    return emptyConfig();
  }
}

function envExtraConfig(): ProtectionConfig {
  const extras = (process.env.PI_PROTECTED_PATHS_EXTRA_GLOBS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (extras.length === 0) return emptyConfig();
  // Apply to both read and write — users setting this want "extra-strict".
  return {
    read: { basenames: [...extras], segments: [], paths: [] },
    write: { basenames: [...extras], segments: [], paths: [] },
  };
}

interface ConfigLayer {
  label: string;
  source: string;
  config: ProtectionConfig;
}

function loadLayers(cwd: string): ConfigLayer[] {
  return [
    { label: 'defaults', source: '(built-in)', config: mergeConfigs(DEFAULT_CONFIG) },
    { label: 'user', source: USER_RULES_PATH, config: readConfig(USER_RULES_PATH) },
    { label: 'project', source: projectRulesPath(cwd), config: readConfig(projectRulesPath(cwd)) },
    { label: 'env', source: 'PI_PROTECTED_PATHS_EXTRA_GLOBS', config: envExtraConfig() },
  ];
}

function mergedConfig(layers: ConfigLayer[]): ProtectionConfig {
  return mergeConfigs(...layers.map((l) => l.config));
}

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
    const feedback = await ctx.ui.input('Tell the assistant why:', 'e.g. read docs/foo.md instead');
    return { kind: 'deny', feedback: feedback?.trim() || undefined };
  }
  return picked.decision;
}

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract the `path` input from a read/write/edit event. All three have
 * a `path: string` field on their input; returning '' means "skip this
 * event" (e.g. malformed or missing input).
 */
function getPathInput(event: ToolCallEvent): string {
  if (isToolCallEventType('read', event) || isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
    return String(event.input?.path ?? '').trim();
  }
  return '';
}

export default function protectedPaths(pi: ExtensionAPI): void {
  if (process.env.PI_PROTECTED_PATHS_DISABLED === '1') return;

  const defaultFallback = process.env.PI_PROTECTED_PATHS_DEFAULT === 'allow' ? 'allow' : 'deny';

  // Shared session allowlist: resolved-absolute paths the user OK'd this
  // session. Approving a path OK's it for both reads AND writes — if you
  // vetted the path for one, you vetted it for the other.
  const sessionAllow = new Set<string>();

  pi.on('session_shutdown', () => {
    sessionAllow.clear();
  });

  pi.on('tool_call', async (event, ctx) => {
    const isRead = isToolCallEventType('read', event);
    const isWrite = isToolCallEventType('write', event) || isToolCallEventType('edit', event);
    if (!isRead && !isWrite) return undefined;

    const inputPath = getPathInput(event);
    if (!inputPath) return undefined;

    // Key sessionAllow on the same resolved+tilde-expanded path classify()
    // produces, so approvals survive across calls with mixed `~/foo` /
    // `/Users/.../foo` forms of the same file.
    const absolute = resolve(ctx.cwd, expandTilde(inputPath));
    if (sessionAllow.has(absolute)) return undefined;

    const config = mergedConfig(loadLayers(ctx.cwd));
    const protection = isRead ? classifyRead(inputPath, ctx.cwd, config) : classifyWrite(inputPath, ctx.cwd, config);
    if (!protection) return undefined;

    if (!ctx.hasUI) {
      if (defaultFallback === 'allow') return undefined;
      return {
        block: true,
        reason:
          `No UI available for approval. Protected path "${inputPath}" ` +
          `(${protection.detail}). Set PI_PROTECTED_PATHS_DEFAULT=allow to override, ` +
          'or pick a different path.',
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
    description: 'Show active protected-path rules (by source) and the session allowlist',
    handler: async (_args, ctx) => {
      const layers = loadLayers(ctx.cwd);
      const lines: string[] = [];

      for (const layer of layers) {
        const { read, write } = layer.config;
        const hasRead = read.basenames.length + read.segments.length + read.paths.length > 0;
        const hasWrite = write.basenames.length + write.segments.length + write.paths.length > 0;
        lines.push(`[${layer.label}] ${layer.source}`);
        if (!hasRead && !hasWrite) {
          lines.push('  (empty)');
          continue;
        }
        if (hasRead) {
          lines.push('  read:');
          for (const g of read.basenames) lines.push(`    basename: ${g}`);
          for (const s of read.segments) lines.push(`    segment:  ${s}/`);
          for (const p of read.paths) lines.push(`    path:     ${p}`);
        }
        if (hasWrite) {
          lines.push('  write:');
          for (const g of write.basenames) lines.push(`    basename: ${g}`);
          for (const s of write.segments) lines.push(`    segment:  ${s}/`);
          for (const p of write.paths) lines.push(`    path:     ${p}`);
        }
      }

      lines.push('');
      lines.push(`Scope: outside ${ctx.cwd} always prompts on write/edit (outside-workspace rule)`);
      lines.push('       reads outside the workspace are NOT auto-prompted — add a rule if needed');

      lines.push('');
      lines.push('Session allowlist (shared between read/write, cleared on session_shutdown):');
      if (sessionAllow.size === 0) {
        lines.push('  (empty)');
      } else {
        for (const p of sessionAllow) lines.push(`  ${p}`);
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
