/**
 * Filesystem permission gate for pi's `read`, `write`, and `edit`
 * tools. Reads the unified `<piAgentDir>/filesystem.json` policy
 * (default `~/.pi/agent/filesystem.json`, overridable via
 * `PI_CODING_AGENT_DIR`) shared with
 * the kernel-level `sandbox.ts` extension so the in-process gate and
 * the syscall-level gate stay in lockstep.
 *
 * Two threat models with separate rule sets:
 *
 *   - `read.deny.*`  - files whose CONTENTS are sensitive (.env,
 *                      ~/.ssh, ~/.aws, ...). Deny-then-allow-back:
 *                      `read.allow.*` carves narrow holes inside an
 *                      otherwise-denied prefix.
 *   - `write.allow.paths` - ALLOW-ONLY for writes. Anything outside
 *                      these prefixes is gated. Defaults `['.', '/tmp']`;
 *                      persona `writeRoots` are merged on top.
 *   - `write.deny.*` - carves holes inside the allow set
 *                      (.git/hooks, .git/config, node_modules, .env*).
 *
 * `classifyWrite` walks `read.deny` after `write.deny`, so anything
 * read-sensitive is automatically also write-sensitive without
 * duplicate-config burden.
 *
 * Layered config (additive within categories, last layer wins on
 * scalars - see `lib/node/pi/filesystem-policy/load.ts`):
 *
 *   1. Built-in DEFAULT_POLICY            (lib/node/pi/filesystem-policy/schema.ts)
 *   2. User    `<piAgentDir>/filesystem.json`
 *   3. Project `<repo>/.pi/filesystem.json` inside `ctx.cwd`
 *   4. Persona writeRoots                  (positive vouch, merged into write.allow.paths)
 *
 * Approval flow (interactive dialog):
 *
 *   1. Allow once
 *   2. Allow "<path>" for this session
 *   3. Deny
 *   4. Deny with feedback…
 *
 * The session allowlist is shared across read/write/edit, cleared on
 * `session_shutdown`. In non-UI mode (print / RPC without UI) the gate
 * blocks by default; set `PI_FILESYSTEM_DEFAULT=allow` to override.
 *
 * The `bash` tool is intentionally NOT gated here - `bash-permissions.ts`
 * owns that channel at the regex layer and `sandbox.ts` owns it at the
 * kernel layer. `grep` / `find` / `ls` are not gated either; their
 * output is bounded by pi's size limits and sandbox.ts already covers
 * the kernel-level read.
 *
 * Composition with the persona extension: when a persona is active,
 * its resolved `writeRoots` are merged into `write.allow.paths` AND
 * also vouch any path whose absolute resolution is inside a writeRoot
 * (so a write inside `~/notes/` skips the gate entirely - the persona
 * file is the user opting in). Reads are NOT vouched by writeRoots
 * (reading a `.env` is suspicious regardless of who's authoring the
 * persona).
 *
 * Rule files are JSONC (`//` and C-style block comments allowed).
 * Tilde paths (`~/`, `~`) are expanded; `~user/` syntax is NOT
 * supported.  See `config/pi/filesystem-example.json` for a hand-
 * curated example with comments.
 *
 * Environment:
 *   PI_FILESYSTEM_DISABLED=1     skip the gate entirely
 *   PI_FILESYSTEM_DEFAULT=allow  in non-UI mode, allow instead
 *                                     of blocking
 *
 * Commands:
 *   /filesystem   list the active policy (grouped by source) +
 *                 session allowlist
 *
 * Pure helpers (`classifyRead`, `classifyWrite`, `loadFilesystemPolicy`,
 * …) live under `lib/node/pi/filesystem-policy/` so they can be
 * unit-tested under vitest without the pi runtime.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  type ToolCallEvent,
} from '@earendil-works/pi-coding-agent';

import { askForPermission } from '../../../lib/node/pi/approval-prompt.ts';
import { classifyFilesystemAccess } from '../../../lib/node/pi/filesystem-policy/classify.ts';
import {
  filesystemProjectPolicyPath,
  filesystemUserPolicyPath,
  type FilesystemPolicyLayer,
  loadFilesystemPolicy,
} from '../../../lib/node/pi/filesystem-policy/load.ts';
import { readTextOrEmpty } from '../../../lib/node/pi/fs-safe.ts';
import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { registerSubagentInjection } from '../../../lib/node/pi/subagent/extension-injection.ts';

// ─────────────────────────────────────────────────────────────────
// Layer loading
// ─────────────────────────────────────────────────────────────────

const USER_RULES_PATH = filesystemUserPolicyPath();

function projectRulesPath(cwd: string): string {
  return filesystemProjectPolicyPath(cwd);
}

function buildLayers(cwd: string): FilesystemPolicyLayer[] {
  return [
    { source: USER_RULES_PATH, raw: readTextOrEmpty(USER_RULES_PATH) },
    { source: projectRulesPath(cwd), raw: readTextOrEmpty(projectRulesPath(cwd)) },
  ];
}

/** Resolve the active filesystem policy for `cwd`, folding in the
 *  active persona's `writeRoots` (positive vouch into
 *  `write.allow.paths`). */
function resolveActivePolicy(cwd: string): ReturnType<typeof loadFilesystemPolicy> {
  const active = getActivePersona();
  return loadFilesystemPolicy(buildLayers(cwd), {
    personaOverlay:
      active && active.resolvedWriteRoots.length > 0
        ? { source: `persona:${active.name}`, paths: active.resolvedWriteRoots }
        : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────
// Tool-call gate
// ─────────────────────────────────────────────────────────────────

/** Pull the `path` argument out of a `read` / `write` / `edit` event.
 *  Returns the empty string when the event isn't one of those, or when
 *  the input is missing/malformed (caller skips the event in that
 *  case). */
function getPathInput(event: ToolCallEvent): string {
  if (isToolCallEventType('read', event) || isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
    return String(event.input?.path ?? '').trim();
  }
  return '';
}

interface BuildHandlerOpts {
  /** Shared session allowlist of OK'd absolute paths. */
  sessionAllow: Set<string>;
  /** Non-UI fallback policy (`PI_FILESYSTEM_DEFAULT`). */
  defaultFallback: 'allow' | 'deny';
  /** Optional warning-tracker. The hook-only factory passes its own;
   *  the parent extension shares one with its `session_shutdown`. */
  warnings?: ReturnType<typeof createNotifyOnce>;
}

/**
 * Build the shared `tool_call` handler used by both the parent
 * `filesystem` extension and the hook-only factory injected into
 * subagent child sessions. Closes over the session allowlist and the
 * non-UI fallback so callers can supply their own state - the parent
 * uses its own `Set` (and clears it on `session_shutdown`); a child
 * session gets a fresh empty `Set` per spawn (children run with
 * `hasUI: false`, so the allowlist is unused there but kept structural
 * for parity).
 */
function makeFilesystemToolCallHandler(
  opts: BuildHandlerOpts,
): (event: ToolCallEvent, ctx: ExtensionContext) => Promise<{ block: true; reason: string } | undefined> {
  const { sessionAllow, defaultFallback, warnings } = opts;
  return async (event, ctx) => {
    const isRead = isToolCallEventType('read', event);
    const isWrite = isToolCallEventType('write', event) || isToolCallEventType('edit', event);
    if (!isRead && !isWrite) return undefined;

    const inputPath = getPathInput(event);
    if (!inputPath) return undefined;

    const { policy, warnings: layerWarnings } = resolveActivePolicy(ctx.cwd);
    if (warnings && layerWarnings.length > 0) warnings.surface(ctx.ui.notify.bind(ctx.ui), layerWarnings);

    const active = isWrite ? getActivePersona() : undefined;
    const accessDecision = classifyFilesystemAccess({
      operation: isRead ? 'read' : 'write',
      inputPath,
      cwd: ctx.cwd,
      policy,
      sessionAllowPaths: sessionAllow,
      personaWriteRoots: active?.resolvedWriteRoots,
    });
    if (accessDecision.kind === 'allow') return undefined;

    if (!ctx.hasUI) {
      if (defaultFallback === 'allow') return undefined;
      return {
        block: true,
        reason:
          `No UI available for approval. Filesystem-protected path "${inputPath}" ` +
          `(${accessDecision.match.detail}). Set PI_FILESYSTEM_DEFAULT=allow to override, ` +
          'or pick a different path.',
      };
    }

    const promptDecision = await askForPermission(ctx, {
      tool: event.toolName,
      path: inputPath,
      detail: accessDecision.match.detail,
    });
    if (promptDecision.kind === 'deny') {
      return {
        block: true,
        reason: promptDecision.feedback ?? `Blocked by user (${accessDecision.match.detail})`,
      };
    }
    if (promptDecision.kind === 'allow-session') {
      sessionAllow.add(accessDecision.absolutePath);
    }
    return undefined;
  };
}

// ─────────────────────────────────────────────────────────────────
// Subagent injection: hook-only factory
// ─────────────────────────────────────────────────────────────────

/**
 * Hook-only `ExtensionFactory` installed inside spawned subagent
 * sessions via `lib/node/pi/subagent/extension-injection.ts`. Mounts
 * ONLY a `tool_call` handler - no `/filesystem` slash command, no
 * statusline glue - so the child stays minimal while still routing
 * `read` / `write` / `edit` calls through the same classify pipeline
 * the parent uses.
 *
 * The child gets a fresh empty `sessionAllow` set; subagent sessions
 * run with `hasUI: false`, so the approval dialog branch never fires
 * and unknown protected paths fall through to
 * `PI_FILESYSTEM_DEFAULT` (default deny). Defaults / user /
 * project layers are re-read from disk per call inside the child, so
 * a matching `read.deny` / `write.allow` / `write.deny` entry still
 * blocks the tool call.
 *
 * Exported as a stable function value so re-registering across
 * `/reload` cycles is idempotent (the registry replaces by id).
 */
export function filesystemFactoryHookOnly(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_FILESYSTEM_DISABLED)) return;
  const defaultFallback = process.env.PI_FILESYSTEM_DEFAULT === 'allow' ? 'allow' : 'deny';
  const sessionAllow = new Set<string>();
  pi.on('tool_call', makeFilesystemToolCallHandler({ sessionAllow, defaultFallback }));
}

// ─────────────────────────────────────────────────────────────────
// Extension shell
// ─────────────────────────────────────────────────────────────────

export default function filesystem(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_FILESYSTEM_DISABLED)) return;

  const defaultFallback = process.env.PI_FILESYSTEM_DEFAULT === 'allow' ? 'allow' : 'deny';

  // Shared session allowlist: resolved-absolute paths the user OK'd this
  // session. Approving a path OK's it for both reads AND writes - if you
  // vetted the path for one, you vetted it for the other.
  const sessionAllow = new Set<string>();
  const warnings = createNotifyOnce({ tag: 'filesystem' });

  // Register the hook-only factory so spawned subagents (deep-research /
  // iteration-loop / `subagent`) re-apply this gate against their own
  // `tool_call` events. The child does NOT share the parent's
  // `sessionAllow` - children run with `hasUI: false` and would always
  // hit the non-UI fallback anyway. The classify rules and default
  // policy are re-loaded from disk per call inside the child, so a
  // matching DEFAULT_POLICY / project / user / persona-overlay entry
  // still fires.
  registerSubagentInjection('filesystem', filesystemFactoryHookOnly);

  pi.on('session_shutdown', () => {
    sessionAllow.clear();
    warnings.reset();
  });

  pi.on('tool_call', makeFilesystemToolCallHandler({ sessionAllow, defaultFallback, warnings }));

  // ─────────────────────────────────────────────────────────────────
  // Command
  // ─────────────────────────────────────────────────────────────────

  pi.registerCommand('filesystem', {
    description: 'Show the active filesystem policy (defaults / user / project / persona) and the session allowlist',
    handler: async (_args, ctx) => {
      const { policy, warnings: layerWarnings } = resolveActivePolicy(ctx.cwd);
      if (layerWarnings.length > 0) warnings.surface(ctx.ui.notify.bind(ctx.ui), layerWarnings);

      const lines: string[] = [];
      lines.push(`Source files (additive, additive within categories):`);
      lines.push(`  defaults  (built-in DEFAULT_POLICY)`);
      lines.push(`  user      ${USER_RULES_PATH}`);
      lines.push(`  project   ${projectRulesPath(ctx.cwd)}`);
      const active = getActivePersona();
      if (active && active.resolvedWriteRoots.length > 0) {
        lines.push(`  persona   ${active.name} (writeRoots: ${active.resolvedWriteRoots.join(', ')})`);
      } else {
        lines.push(`  persona   (none)`);
      }

      const renderRules = (
        label: string,
        rules: { basenames: string[]; segments: string[]; paths: string[] },
      ): void => {
        const { basenames, segments, paths } = rules;
        if (basenames.length + segments.length + paths.length === 0) return;
        lines.push(`  ${label}:`);
        for (const g of basenames) lines.push(`    basename: ${g}`);
        for (const s of segments) lines.push(`    segment:  ${s}`);
        for (const p of paths) lines.push(`    path:     ${p}`);
      };

      lines.push('');
      lines.push('Resolved policy:');
      lines.push('read:');
      renderRules('deny', policy.read.deny);
      renderRules('allow', policy.read.allow);
      lines.push('write:');
      renderRules('allow', policy.write.allow);
      renderRules('deny', policy.write.deny);

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
