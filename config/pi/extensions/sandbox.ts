/**
 * Kernel-level sandbox extension for pi.
 *
 * Wraps every `bash` subprocess that pi runs in
 * [@anthropic-ai/sandbox-runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)
 * ("ASRT"), which enforces filesystem and network restrictions at the
 * OS level - `sandbox-exec` on macOS, `bubblewrap` on Linux. Even if
 * the model smuggles a `cat ~/.ssh/id_rsa` past the regex matcher in
 * [`bash-permissions.ts`](./bash-permissions.md), the kernel still
 * blocks the syscall.
 *
 * This extension is the third (lowest) layer of defense-in-depth:
 *
 *   1. `bash-permissions.ts`  - regex/UI gate at the LLM tool-call layer.
 *   2. `filesystem.ts`        - in-process gate for `read`/`write`/`edit`.
 *   3. `sandbox.ts`           - kernel sandbox for every bash subprocess.
 *
 * See plan section 2 for the full threat-model table:
 * `plans/pi-sandbox-runtime-extension.md`.
 *
 * Tool-call ordering: `bash-permissions.ts` runs FIRST (its approval
 * dialog sees the user's original command); `sandbox.ts` runs SECOND
 * (rewrites `event.input.command` to `srt -- <original>`). Order is
 * controlled by the auto-loaded extensions array's alphabetical
 * directory ordering: `bash-permissions` < `bg-bash` < `filesystem` <
 * `persona` < `sandbox`. Each load registers `tool_call` handlers in
 * order; pi runs them in registration order; later handlers see the
 * earlier mutations.
 *
 * Configuration:
 *
 *   <piAgentDir>/sandbox.json      - sandbox-only knobs (network, unix sockets, flags).
 *                                    See `config/pi/sandbox-example.json`.
 *   <piAgentDir>/filesystem.json   - shared with `filesystem.ts`. See
 *                                    `config/pi/filesystem-example.json`.
 *
 *   `<piAgentDir>` defaults to `~/.pi/agent`; override via `PI_CODING_AGENT_DIR`.
 *
 * Environment overrides:
 *
 *   PI_SANDBOX_DISABLED=1            bypass entirely; identity-wrap.
 *   PI_SANDBOX_DRY_RUN=1             log the wrapped command but pass
 *                                    the original through.
 *   PI_SANDBOX_DEFAULT=warn|allow|block
 *                                    fallback when wrap itself errors.
 *                                    Default `warn` (run unwrapped + log).
 *   PI_SANDBOX_NESTED=1              flags.weakerNestedSandbox.
 *   PI_SANDBOX_WEAKER_NET=1          flags.weakerNetworkIsolation (macOS).
 *   PI_SANDBOX_NETWORK_DEFAULT=allow|deny
 *                                    non-UI default for the network
 *                                    ask-callback. Default `deny`.
 *   PI_SANDBOX_EXTRA_ALLOW_DOMAIN=a,b,c
 *                                    additive convenience.
 *   PI_SANDBOX_ALLOW_ROOT=1          allow the extension to load when
 *                                    pi is running as root (off by
 *                                    default per plan section 6).
 *   PI_INSIDE_DOCKER=1               hint platform.ts to recommend
 *                                    flags.weakerNestedSandbox.
 *
 * Slash commands:
 *
 *   /sandbox                  print active config + diagnostics + violations.
 *   /sandbox-allow <domain>   add domain to network.allow.
 *   /sandbox-deny  <domain>   add domain to network.deny.
 *   /sandbox-allow-write <p>  add p to filesystem.write.allow.paths
 *                             (UI-confirmed; weakens policy).
 *   /sandbox-violations       dump SandboxViolationStore [+ JSONL backup].
 *                             `--net` and `--fs` filter by kind.
 *   /sandbox-rescan           recompile Linux rules (basenames/segments
 *                             -> literal paths via ripgrep).
 *   /sandbox-recheck          re-run dependency detection.
 *   /sandbox-disable          session-only bypass; statusline badge hidden.
 *
 * Pure helpers (config schema, layered loader, ASRT translator,
 * platform probe, Linux rule compilation, violations JSONL,
 * wrapper slot, active singleton) live under
 * `lib/node/pi/sandbox/` so they can be unit-tested under vitest
 * without spawning ASRT or a real bash child.
 *
 * Subagent injection: `sandboxFactoryHookOnly` is registered via
 * `lib/node/pi/subagent/extension-injection.ts`, so spawned subagent
 * sessions also wrap their bash calls through the parent's
 * SandboxManager singleton (subagents run in the same Node process,
 * so the manager + active config + active UI + wrapper slot are
 * shared).
 */

import { join } from 'node:path';

import { type ExtensionAPI, type ExtensionContext, type ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { clearActiveUI, publishActiveUI } from '../../../lib/node/pi/active-ui.ts';
import { completePositional, completeSubverbs } from '../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../lib/node/pi/commands/help.ts';
import { extractBashCommand } from '../../../lib/node/pi/bash/hook.ts';
import {
  cleanupDangerousFileStubs,
  createDangerousFileStubs,
  listDangerousStubPaths,
  sweepOrphanDangerousStubs,
} from '../../../lib/node/pi/sandbox/dangerous-file-stubs.ts';
import { buildFilesystemAskDialog } from '../../../lib/node/pi/sandbox/filesystem-ask.ts';
import {
  SANDBOX_ALLOW_USAGE,
  SANDBOX_ALLOW_WRITE_USAGE,
  SANDBOX_DENY_USAGE,
  SANDBOX_DISABLE_USAGE,
  SANDBOX_RECHECK_USAGE,
  SANDBOX_RESCAN_USAGE,
  SANDBOX_USAGE,
  SANDBOX_VIOLATIONS_USAGE,
} from '../../../lib/node/pi/sandbox/usage.ts';
import { parseFsFailures } from '../../../lib/node/pi/sandbox/fs-failures.ts';
import { gitTrackedSubset } from '../../../lib/node/pi/sandbox/git-tracked.ts';
import { buildNetworkAskCallback } from '../../../lib/node/pi/sandbox/network-ask.ts';
import { annotateBashResult, prependBashHint } from '../../../lib/node/pi/sandbox/result-annotate.ts';
import { buildSandboxStatusReport } from '../../../lib/node/pi/sandbox/status-report.ts';
import { detectLoopbackFailure } from '../../../lib/node/pi/sandbox/loopback-hint.ts';
import { prependLocalhostProxyEnv } from '../../../lib/node/pi/sandbox/localhost-proxy.ts';
import { type FilesystemPolicyLayer, loadFilesystemPolicy } from '../../../lib/node/pi/filesystem-policy/load.ts';
import { type FilesystemPolicyWarning } from '../../../lib/node/pi/filesystem-policy/schema.ts';
import { readTextOrEmpty } from '../../../lib/node/pi/fs-safe.ts';
import { JsoncReadError } from '../../../lib/node/pi/jsonc.ts';
import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { piAgentDir, piProjectPath } from '../../../lib/node/pi/pi-paths.ts';
import { pickScopeFile } from '../../../lib/node/pi/scope-pick.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';

import {
  activeReconfigure,
  beginActiveReconfigure,
  clearActiveSandbox,
  publishActiveSandbox,
} from '../../../lib/node/pi/sandbox/active.ts';
import { type AsrtSandboxManager, loadAsrtModule } from '../../../lib/node/pi/sandbox/asrt-manager.ts';
import { loadSandboxConfig } from '../../../lib/node/pi/sandbox/config-load.ts';
import { translateToASRT } from '../../../lib/node/pi/sandbox/config-translate.ts';
import { addNetworkRule, addWriteAllowPath } from '../../../lib/node/pi/sandbox/config-write.ts';
import { logE2bigWrap } from '../../../lib/node/pi/sandbox/e2big-debug.ts';
import { compileLinuxPolicy, type CompiledPolicyReport } from '../../../lib/node/pi/sandbox/linux-rules-compile.ts';
import { resolveSandboxMode, resolveWrapPlan, type WrapPlan } from '../../../lib/node/pi/sandbox/plan.ts';
import {
  defaultPlatformProbe,
  detectSandboxPlatform,
  type SandboxPlatformInfo,
} from '../../../lib/node/pi/sandbox/platform.ts';
import {
  appendViolation,
  readViolations,
  type SandboxViolationKind,
  type SandboxViolationRecord,
} from '../../../lib/node/pi/sandbox/violations-log.ts';
import {
  hasOriginalStash,
  readCreatedStubs,
  stashCreatedStubs,
  stashOriginalCommand,
  stripMarkerFromUserInput,
} from '../../../lib/node/pi/sandbox/markers.ts';
import { extractBashStderr, resolveSandboxedCommand } from '../../../lib/node/pi/sandbox/tool-result.ts';
import { decStubRefs, incStubRefs } from '../../../lib/node/pi/sandbox/stub-refcount.ts';
import {
  installSandboxWrapper,
  type SandboxWrapFn,
  type SandboxWrapResult,
  uninstallSandboxWrapper,
} from '../../../lib/node/pi/sandbox/wrapper-slot.ts';
import { setSandboxState, type SandboxMode } from '../../../lib/node/pi/session-flags.ts';
import { registerSubagentInjection } from '../../../lib/node/pi/subagent/extension-injection.ts';

// ─────────────────────────────────────────────────────────────────
// Constants + paths
// ─────────────────────────────────────────────────────────────────

const USER_PI_DIR = piAgentDir();
const USER_FS_PATH = join(USER_PI_DIR, 'filesystem.json');
const USER_SANDBOX_PATH = join(USER_PI_DIR, 'sandbox.json');
const USER_VIOLATIONS_LOG = join(USER_PI_DIR, 'sandbox-violations.log');

function projectFsPath(cwd: string): string {
  return piProjectPath(cwd, 'filesystem.json');
}
function projectSandboxPath(cwd: string): string {
  return piProjectPath(cwd, 'sandbox.json');
}

function envFallback(): 'warn' | 'allow' | 'block' {
  const raw = (process.env.PI_SANDBOX_DEFAULT ?? 'warn').trim().toLowerCase();
  if (raw === 'allow' || raw === 'block' || raw === 'warn') return raw;
  return 'warn';
}

function envNetworkDefault(): 'allow' | 'deny' {
  const raw = (process.env.PI_SANDBOX_NETWORK_DEFAULT ?? 'deny').trim().toLowerCase();
  return raw === 'allow' ? 'allow' : 'deny';
}

// ─────────────────────────────────────────────────────────────────
// Wrap helpers
// ─────────────────────────────────────────────────────────────────

// Wrap helpers (alreadyWrapped, stripMarkerFromUserInput,
// buildIdentityWrap) live in `lib/node/pi/sandbox/markers.ts` so they
// can be unit-tested without dragging in `@earendil-works/*`. They are
// re-exported above.

// ─────────────────────────────────────────────────────────────────
// Config loading + ASRT manager glue
// ─────────────────────────────────────────────────────────────────

// `AsrtSandboxManager`, `AsrtModule`, and the lazy `loadAsrtModule()`
// loader live in `lib/node/pi/sandbox/asrt-manager.ts` so they're
// vitest-testable and the structural shape is enforceable from lib.

function buildLayers(cwd: string): {
  fsLayers: FilesystemPolicyLayer[];
  sandboxLayers: { source: string; raw: string }[];
} {
  return {
    fsLayers: [
      { source: USER_FS_PATH, raw: readTextOrEmpty(USER_FS_PATH) },
      { source: projectFsPath(cwd), raw: readTextOrEmpty(projectFsPath(cwd)) },
    ],
    sandboxLayers: [
      { source: USER_SANDBOX_PATH, raw: readTextOrEmpty(USER_SANDBOX_PATH) },
      { source: projectSandboxPath(cwd), raw: readTextOrEmpty(projectSandboxPath(cwd)) },
    ],
  };
}

function sandboxEnvOverlay(): {
  PI_SANDBOX_NESTED?: string;
  PI_SANDBOX_WEAKER_NET?: string;
  PI_SANDBOX_EXTRA_ALLOW_DOMAIN?: string;
} {
  return {
    PI_SANDBOX_NESTED: process.env.PI_SANDBOX_NESTED,
    PI_SANDBOX_WEAKER_NET: process.env.PI_SANDBOX_WEAKER_NET,
    PI_SANDBOX_EXTRA_ALLOW_DOMAIN: process.env.PI_SANDBOX_EXTRA_ALLOW_DOMAIN,
  };
}

interface ResolvedAll {
  fsPolicy: ReturnType<typeof loadFilesystemPolicy>['policy'];
  fsWarnings: FilesystemPolicyWarning[];
  sandboxResult: ReturnType<typeof loadSandboxConfig>;
  compiled?: CompiledPolicyReport;
  asrtConfig: unknown;
  lossyNotes: string[];
  platform: SandboxPlatformInfo;
}

/** Resolve the in-memory config snapshot from on-disk layers + the
 *  active persona overlay + the session-only write-allow set. Pure
 *  (no ASRT side-effects). The caller decides whether to publish to
 *  the active singleton + reconfigure the live SandboxManager. */
function resolveAll(
  cwd: string,
  platform: SandboxPlatformInfo,
  sessionWriteAllowPaths: readonly string[] = [],
): ResolvedAll {
  const { fsLayers, sandboxLayers } = buildLayers(cwd);
  const persona = getActivePersona();
  const fs = loadFilesystemPolicy(fsLayers, {
    personaOverlay:
      persona && persona.resolvedWriteRoots.length > 0
        ? { source: `persona:${persona.name}`, paths: persona.resolvedWriteRoots }
        : undefined,
    sessionWriteAllowPaths,
  });
  const sandboxResult = loadSandboxConfig(sandboxLayers, sandboxEnvOverlay());

  let compiled: CompiledPolicyReport | undefined;
  if (platform.kind === 'linux') {
    compiled = compileLinuxPolicy(fs.policy, {
      cwd,
      extraRoots: persona?.resolvedWriteRoots ?? [],
      depth: sandboxResult.config.flags.linuxRuleDepth,
    });
  }

  const mode: 'darwin' | 'linux' = platform.kind === 'linux' ? 'linux' : 'darwin';
  const { config: asrtConfig, lossyNotes } = translateToASRT({
    policy: fs.policy,
    sandbox: sandboxResult.config,
    cwd,
    mode,
    compiled,
  });

  return {
    fsPolicy: fs.policy,
    fsWarnings: fs.warnings,
    sandboxResult,
    compiled,
    asrtConfig,
    lossyNotes,
    platform,
  };
}

// ─────────────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────────────

interface RuntimeState {
  /** Detected platform info; recomputed on `/sandbox-recheck`. */
  platform: SandboxPlatformInfo;
  /** Live SandboxManager, lazily initialized on first bash call. */
  manager?: AsrtSandboxManager;
  /** True after `manager.initialize()` returned successfully. */
  initialized: boolean;
  /** Session-only bypass toggled by `/sandbox-disable`. */
  bypassed: boolean;
  /** Reason string surfaced in the statusline tooltip (latest). */
  reason?: string;
  /** Last resolved snapshot - used by `/sandbox` rendering. */
  lastResolved?: ResolvedAll;
  /** Per-source notify-once tracker for filesystem-policy warnings
   *  surfaced from `loadFilesystemPolicy`. Keyed on `<source>|<reason>`,
   *  rendered as `sandbox: <source>: <reason>` (warning severity). */
  fsWarnings: ReturnType<typeof createNotifyOnce>;
  /** Per-source notify-once tracker for sandbox-config warnings
   *  surfaced from `loadSandboxConfig`. Separate tracker so a fs +
   *  sandbox warning with the same path wouldn't accidentally dedup
   *  against each other. */
  sandboxWarnings: ReturnType<typeof createNotifyOnce>;
  /** Set when a degraded-fallback notify has been surfaced this
   *  session (graceful-degradation rule per plan section 6). */
  degradedNotified: boolean;
  /** Diagnostic counter for `/sandbox` output. */
  wrapsAttempted: number;
  wrapsErrored: number;
  /** Most recent wrap-error message. */
  lastWrapError?: string;
  /** Session-only network allow set, populated by the `Allow ... for
   *  this session` choice in the network ask-callback. Cleared on
   *  session_shutdown along with the rest of the runtime state. */
  sessionAllowedDomains: Set<string>;
  /** Session-only write-allow paths, populated by the `Allow once`
   *  choice in the reactive filesystem-ask dialog. Merged into
   *  `policy.write.allow.paths` during {@link resolveAll} so the
   *  next `wrapWithSandbox` call respects them. Cleared on
   *  `session_shutdown` along with the rest of the runtime state. */
  sessionWriteAllow: Set<string>;
  /** Cwd captured during config resolution; the ask-callback uses it
   *  to decide project vs user scope for `Always allow` choices. */
  lastCwd?: string;
  /** Refcount keyed by absolute path of every dangerous-file stub
   *  currently relied on by an in-flight `wrapWithSandbox`. Each
   *  `tool_call` (per command) increments by one for every stub the
   *  wrapper touched; the matching `tool_result` decrements. The
   *  cleanup helper unlinks paths whose count drops to zero, so two
   *  bg-bash commands that overlap on the same stubs only have them
   *  removed when the LAST in-flight reference releases. Cleared on
   *  `session_shutdown`. See `lib/node/pi/sandbox/stub-refcount.ts`. */
  stubRefcount: Map<string, number>;
  /** Cwd whose `dangerousProtected` Set was last computed. Used to
   *  invalidate the cache when the user runs `cd` mid-session. */
  dangerousProtectedCwd?: string;
  /** Cached set of git-tracked dangerous-stub paths under
   *  {@link dangerousProtectedCwd}. Passed as `isProtected` to
   *  `createDangerousFileStubs` / `sweepOrphanDangerousStubs` so
   *  user-authored 0-byte files are never adopted + deleted.
   *  Recomputed on cwd change via {@link refreshDangerousProtected}. */
  dangerousProtected: Set<string>;
}

function newState(platform: SandboxPlatformInfo): RuntimeState {
  return {
    platform,
    initialized: false,
    bypassed: false,
    fsWarnings: createNotifyOnce({ tag: 'sandbox' }),
    sandboxWarnings: createNotifyOnce({ tag: 'sandbox' }),
    degradedNotified: false,
    wrapsAttempted: 0,
    wrapsErrored: 0,
    sessionAllowedDomains: new Set(),
    sessionWriteAllow: new Set(),
    stubRefcount: new Map(),
    dangerousProtected: new Set(),
  };
}

/**
 * Recompute {@link RuntimeState.dangerousProtected} for `cwd` if it
 * differs from the cached value. The protected set is the subset of
 * the dangerous-stub paths under `cwd` that are tracked in `cwd`'s
 * git index, so a user-authored 0-byte file (e.g. a freshly-created
 * `.npmrc`) is never adopted by the orphan-sweep on session_start or
 * the adopt-on-EEXIST path inside `createDangerousFileStubs`.
 *
 * Synchronous: `gitTrackedSubset` runs `git ls-files` once per cwd
 * change with a 2s timeout and folds every failure mode into
 * `tracked = ∅`, which is the safe-but-permissive default for
 * non-git scratch directories.
 */
function refreshDangerousProtected(state: RuntimeState, cwd: string): void {
  if (state.dangerousProtectedCwd === cwd) return;
  state.dangerousProtected = gitTrackedSubset(cwd, listDangerousStubPaths(cwd));
  state.dangerousProtectedCwd = cwd;
}

/** Compute the effective {@link SandboxMode} for the statusline
 *  badge. Plan section 7 enumerates the five visible states. Thin
 *  wrapper around `lib/node/pi/sandbox/plan.ts::resolveSandboxMode`
 *  that adapts the lib type back to the `SandboxMode` literal-union
 *  re-exported from `session-flags.ts`. */
function effectiveMode(state: RuntimeState): { mode: SandboxMode; reason?: string } {
  return resolveSandboxMode({
    platform: state.platform,
    bypassed: state.bypassed,
    initialized: state.initialized,
    reason: state.reason,
  }) as { mode: SandboxMode; reason?: string };
}

function publishStatusline(state: RuntimeState): void {
  const { mode, reason } = effectiveMode(state);
  setSandboxState(reason !== undefined ? { mode, reason } : { mode });
}

// `surfaceFsWarnings` was inlined into `reconfigure` once both warning
// sources (fs-policy + sandbox-config) routed through `notify-once`'s
// per-source dedup. See `state.fsWarnings` / `state.sandboxWarnings`.

// ─────────────────────────────────────────────────────────────────
// Config-write helpers for /sandbox-allow / -deny / -allow-write and
// the six-option network ask-callback dialog (see buildAskCallback).
// ─────────────────────────────────────────────────────────────────

function pickScopeSandbox(cwd: string): string {
  return pickScopeFile({ cwd, projectFile: projectSandboxPath(cwd), userFile: USER_SANDBOX_PATH });
}
function pickScopeFs(cwd: string): string {
  return pickScopeFile({ cwd, projectFile: projectFsPath(cwd), userFile: USER_FS_PATH });
}

/** Thrown by {@link readJsoncForMutation} when an existing file fails
 *  to parse. The slash-command handlers catch it and abort the write
 *  with a clear notify, so a user with a malformed `<piAgentDir>/sandbox.json`
 *  doesn't lose their hand-edited rules + comments to a clobbering
 *  `/sandbox-allow` save. Imported directly from
 *  {@link ../../../lib/node/pi/jsonc.ts | jsonc.ts}. */
// (no re-export - downstream callers should import JsoncReadError from
// `lib/node/pi/jsonc.ts` directly.)

// `addNetworkRule`, `addWriteAllowPath`, and the JSONC schema types
// live in `lib/node/pi/sandbox/config-write.ts` so the slash-command
// mutation pipeline is vitest-testable.

/** Run a write-side config mutation; surface a `JsoncReadError` as a
 *  user-facing notify and return false (handler aborts without writing).
 *  Other errors propagate. */
function withSafeConfigWrite(ctx: ExtensionContext, action: () => void): boolean {
  try {
    action();
    return true;
  } catch (e) {
    if (e instanceof JsoncReadError) {
      ctx.ui.notify(
        `sandbox: refusing to overwrite a malformed file.\n  ${e.message}\n  Fix the file by hand, then retry.`,
        'error',
      );
      return false;
    }
    throw e;
  }
}

/**
 * Build the SandboxAskCallback fired by ASRT when a sandboxed bash
 * hits an un-allowlisted domain. Wired up using the lib-level helper
 * so the dialog flow is unit-testable without the extension shell.
 */
function buildAskCallback(
  state: RuntimeState,
  triggerReconfigure: () => Promise<void>,
): (params: { host: string; port: number | undefined }) => Promise<boolean> {
  return buildNetworkAskCallback({
    sessionAllowedDomains: state.sessionAllowedDomains,
    triggerReconfigure,
    saveProjectAllow: (host) => {
      const path = pickScopeSandbox(state.lastCwd ?? process.cwd());
      addNetworkRule(path, 'allow', host);
      return path;
    },
    saveUserAllowParent: (parent) => {
      addNetworkRule(USER_SANDBOX_PATH, 'allow', parent);
      return USER_SANDBOX_PATH;
    },
    envNetworkDefault,
  });
}

/**
 * Reconfigure the live ASRT manager from the current on-disk config
 * + active persona. Returns the resolved snapshot the caller can
 * render; the active singleton is updated atomically before the
 * SandboxManager.updateConfig() call so bash hooks reading
 * `getActiveSandbox()` after `await activeReconfigure()` see
 * consistent state.
 */
async function reconfigure(state: RuntimeState, cwd: string, ctx?: ExtensionContext): Promise<ResolvedAll> {
  const done = beginActiveReconfigure();
  state.lastCwd = cwd;
  try {
    const resolved = resolveAll(cwd, state.platform, Array.from(state.sessionWriteAllow));
    if (ctx) {
      const notify = ctx.ui.notify.bind(ctx.ui);
      if (resolved.fsWarnings.length > 0) state.fsWarnings.surface(notify, resolved.fsWarnings);
      if (resolved.sandboxResult.warnings.length > 0) {
        state.sandboxWarnings.surface(notify, resolved.sandboxResult.warnings);
      }
    }

    const publish = publishActiveSandbox({
      filesystem: resolved.fsPolicy,
      sandbox: resolved.sandboxResult.config,
      platform: state.platform.kind,
    });

    if (state.manager && state.initialized && publish.changed) {
      state.manager.updateConfig(resolved.asrtConfig);
    }

    state.lastResolved = resolved;
    publishStatusline(state);
    return resolved;
  } finally {
    done();
  }
}

/**
 * Lazy-init ASRT's SandboxManager. Idempotent - subsequent calls are
 * cheap. Returns true on success, false on failure (caller logs
 * + falls back per `PI_SANDBOX_DEFAULT`).
 */
async function ensureManager(state: RuntimeState, cwd: string, ctx: ExtensionContext): Promise<boolean> {
  if (state.initialized && state.manager) return true;
  if (state.platform.kind === 'unsupported') return false;
  if (state.platform.missingDeps.length > 0) return false;
  if (state.platform.isRoot && !envTruthy(process.env.PI_SANDBOX_ALLOW_ROOT)) return false;

  try {
    const asrt = await loadAsrtModule();
    const resolved = state.lastResolved ?? (await reconfigure(state, cwd, ctx));
    if (!asrt.SandboxManager.isSupportedPlatform()) {
      state.reason = 'ASRT reports platform unsupported';
      publishStatusline(state);
      return false;
    }
    const askCallback = buildAskCallback(state, async () => {
      await reconfigure(state, state.lastCwd ?? cwd, ctx);
    });
    await asrt.SandboxManager.initialize(resolved.asrtConfig, askCallback, false);
    state.manager = asrt.SandboxManager;
    state.initialized = true;
    publishStatusline(state);
    return true;
  } catch (e) {
    state.lastWrapError = e instanceof Error ? e.message : String(e);
    state.reason = `init failed: ${state.lastWrapError}`;
    if (!state.degradedNotified) {
      state.degradedNotified = true;
      ctx.ui.notify(
        `sandbox: failed to initialize (${state.lastWrapError}); falling back to ${envFallback()}`,
        'warning',
      );
    }
    publishStatusline(state);
    return false;
  }
}

/** Resolve which mode the bash hook should take for `command`.
 *  Thin wrapper around `lib/node/pi/sandbox/plan.ts::resolveWrapPlan`
 *  that pipes through the live state. */
function planFor(state: RuntimeState): WrapPlan {
  return resolveWrapPlan({
    platform: state.platform,
    bypassed: state.bypassed,
    initialized: state.initialized,
    reason: state.reason,
  });
}

// ─────────────────────────────────────────────────────────────────
// E2BIG diagnostic - see `lib/node/pi/sandbox/e2big-debug.ts` for
// the per-wrap size logger gated on `PI_SANDBOX_E2BIG_DEBUG`.
// ─────────────────────────────────────────────────────────────────

/**
 * Wrap a command for the live SandboxManager when one is available;
 * otherwise return a structured result describing what the caller
 * should do (identity-wrap, warn-then-run, or block).
 *
 * This is the single source of truth for the wrap pipeline. The bash
 * tool_call hook AND the wrapper-slot consumers (bg-bash, the subagent
 * hook-only factory) all flow through here, so PI_SANDBOX_DEFAULT=block
 * blocks every channel consistently.
 */
async function performWrap(
  command: string,
  state: RuntimeState,
  _ctx: { hasUI: boolean; cwd: string },
): Promise<SandboxWrapResult> {
  state.wrapsAttempted++;
  const plan = planFor(state);
  if (plan.kind === 'identity') {
    return { command, wrapped: false, action: 'identity', reason: plan.reason };
  }
  if (envTruthy(process.env.PI_SANDBOX_DRY_RUN)) {
    return { command, wrapped: false, action: 'identity', reason: 'PI_SANDBOX_DRY_RUN=1' };
  }
  if (!state.initialized || !state.manager) {
    const fallback = envFallback();
    const reason = `sandbox not initialized (${state.lastWrapError ?? 'pending'})`;
    if (fallback === 'block') {
      return {
        command,
        wrapped: false,
        action: 'block',
        reason: `${reason}; refusing to run unwrapped under PI_SANDBOX_DEFAULT=block`,
      };
    }
    return { command, wrapped: false, action: fallback === 'warn' ? 'warn' : 'identity', reason };
  }
  try {
    await activeReconfigure();
    // Pre-create empty stubs for ASRT's DANGEROUS_FILES so concurrent
    // bwrap setups don't race on the mount-point `O_CREAT|O_WRONLY`
    // against a 0444 stub (see dangerous-file-stubs.ts module docs).
    // The `isProtected` hook also lets the helper adopt orphan stubs
    // a prior session leaked via SIGKILL, while leaving git-tracked
    // 0-byte files (a freshly-cloned `.npmrc`, etc.) alone.
    refreshDangerousProtected(state, process.cwd());
    const created = createDangerousFileStubs(process.cwd(), {
      isProtected: (p) => state.dangerousProtected.has(p),
    });
    incStubRefs(state.stubRefcount, created);
    // Under network.allowLocalhost, rewrite the command's NO_PROXY so
    // loopback HTTP(S)/SOCKS routes through ASRT's proxy (which dials
    // the host loopback). No-op when unrestricted (host net already
    // shared) or when the flag is off. The original command is stashed
    // by the caller; only the executed string carries the prefix.
    const net = state.lastResolved?.sandboxResult.config.network;
    const toWrap = net?.allowLocalhost && net.unrestricted !== true ? prependLocalhostProxyEnv(command) : command;
    const wrapped = await state.manager.wrapWithSandbox(toWrap);
    logE2bigWrap(
      { wrapsAttempted: state.wrapsAttempted, lastResolvedAsrtConfig: state.lastResolved?.asrtConfig },
      command,
      wrapped,
    );
    return { command: wrapped, wrapped: true, createdStubs: created };
  } catch (e) {
    state.wrapsErrored++;
    state.lastWrapError = e instanceof Error ? e.message : String(e);
    const fallback = envFallback();
    const reason = `wrap failed: ${state.lastWrapError}`;
    if (fallback === 'block') {
      return {
        command,
        wrapped: false,
        action: 'block',
        reason: `${reason}; refusing to run unwrapped under PI_SANDBOX_DEFAULT=block`,
      };
    }
    return { command, wrapped: false, action: fallback === 'warn' ? 'warn' : 'identity', reason };
  }
}

// ─────────────────────────────────────────────────────────────────
// Subagent injection: hook-only factory
// ─────────────────────────────────────────────────────────────────

/**
 * Hook-only factory injected into spawned subagent sessions. Mirrors
 * the bash hook installed by the parent extension, but without
 * touching slash commands or the statusline. The wrapper-slot is a
 * `globalThis`-anchored singleton (per Phase 1's `wrapper-slot.ts`),
 * so the child's `bash` calls share the parent's installed wrap
 * function.
 */
export function sandboxFactoryHookOnly(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_SANDBOX_DISABLED)) return;
  pi.on('tool_call', async (event, ctx) => {
    const original = extractBashCommand(event);
    if (!original) return undefined;
    // Re-entry guard: only true if WE wrapped this event in an earlier
    // hook pass. Detecting via the original-stash symbol (which only
    // this extension can write) prevents a model that prepends
    // `__PI_SANDBOX_WRAPPED=` to its bash command from short-circuiting
    // the wrap, which `alreadyWrapped(original)` cannot.
    if (hasOriginalStash(event.input)) return undefined;

    // Sanitize any pre-existing marker so a model that learns the
    // marker can't smuggle past downstream re-entry checks either.
    const safe = stripMarkerFromUserInput(original);
    // Children share the parent's wrapper-slot. If empty, identity-
    // wrap (no-op) - matches the parent's degraded-fallback behavior.
    const slot = await import('../../../lib/node/pi/sandbox/wrapper-slot.ts');
    const result = await slot.requestSandboxWrap(safe, { hasUI: ctx.hasUI, cwd: ctx.cwd });
    if (result.wrapped) {
      stashOriginalCommand(event.input, original);
      stashCreatedStubs(event.input, result.createdStubs ?? []);
      (event.input as { command: string }).command = result.command;
      return undefined;
    }
    if (result.action === 'block') {
      return { block: true, reason: result.reason ?? 'sandbox refused to wrap the command' };
    }
    return undefined;
  });
}

// ─────────────────────────────────────────────────────────────────
// Extension shell
// ─────────────────────────────────────────────────────────────────

export default function sandbox(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_SANDBOX_DISABLED)) {
    setSandboxState({ mode: 'env-disabled', reason: 'PI_SANDBOX_DISABLED=1' });
    return;
  }

  const platform = detectSandboxPlatform(defaultPlatformProbe());
  const state = newState(platform);

  // Refuse to load when running as root unless explicitly overridden.
  if (platform.isRoot && !envTruthy(process.env.PI_SANDBOX_ALLOW_ROOT)) {
    setSandboxState({ mode: 'identity', reason: 'running as root (set PI_SANDBOX_ALLOW_ROOT=1 to override)' });
    // Still register the hook-only factory so subagents in a
    // (hypothetical) non-root child also stay consistent. v1 leaves
    // root-mode pi entirely unsandboxed.
    return;
  }

  publishStatusline(state);

  // Register the hook-only factory once per extension load so
  // spawned subagents wrap their bash calls through the same shared
  // SandboxManager singleton via the wrapper slot.
  registerSubagentInjection('sandbox', sandboxFactoryHookOnly);

  // Install the wrapper-slot used by bg-bash (Phase 4) and the
  // subagent hook-only factory above. The slot is `globalThis`-
  // anchored so the parent's installed function reaches every jiti'd
  // module copy.
  const slotFn: SandboxWrapFn = async (command, ctx) => performWrap(command, state, ctx);
  installSandboxWrapper(slotFn);

  // Process-level cleanup hooks (plan section 9.8): if pi crashes
  // hard or the user SIGINTs, ASRT's proxy ports + sockets need to be
  // released. session_shutdown also fires for clean exits. We deregister
  // these on `cleanup()` so `/reload` doesn't accumulate listeners.
  const cleanup = (): void => {
    if (state.manager && state.initialized) {
      // Fire-and-forget; we're shutting down.
      void state.manager.reset();
    }
    state.initialized = false;
    state.manager = undefined;
    state.sessionAllowedDomains.clear();
    state.sessionWriteAllow.clear();
    cleanupDangerousFileStubs(state.stubRefcount.keys());
    state.stubRefcount.clear();
    clearActiveSandbox();
    clearActiveUI();
    uninstallSandboxWrapper();
    setSandboxState({ mode: 'off' });
    process.off('exit', cleanup);
    process.off('SIGTERM', cleanup);
    process.off('SIGINT', cleanup);
  };
  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Surface deps / platform notifications once at startup.
  pi.on('session_start', async (_event, ctx) => {
    publishActiveUI({
      hasUI: ctx.hasUI,
      select: ctx.ui.select.bind(ctx.ui),
      input: ctx.ui.input.bind(ctx.ui),
      notify: ctx.ui.notify.bind(ctx.ui),
    });
    if (platform.kind === 'unsupported') {
      ctx.ui.notify(`sandbox: ${platform.description}; bash will run unsandboxed`, 'warning');
      state.degradedNotified = true;
    } else if (platform.missingDeps.length > 0) {
      const lines = [
        `sandbox: missing dependencies: ${platform.missingDeps.join(', ')}`,
        ...platform.hints,
        'sandbox is degraded to identity-wrap until deps install + /sandbox-recheck.',
      ];
      ctx.ui.notify(lines.join('\n'), 'warning');
      state.degradedNotified = true;
    }
    if (platform.apparmorBlocksUserNs) {
      ctx.ui.notify(
        'sandbox: AppArmor restricts unprivileged user namespaces (Ubuntu 24.04+).\n' +
          '  Run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
        'warning',
      );
    }
    if (platform.isInsideDocker && !envTruthy(process.env.PI_SANDBOX_NESTED)) {
      ctx.ui.notify(
        'sandbox: pi appears to run inside a container; if bash subprocesses fail to start,\n' +
          '  set PI_SANDBOX_NESTED=1 to enable flags.weakerNestedSandbox.',
        'info',
      );
    }
    // Pre-resolve so /sandbox can render even before the first bash.
    await reconfigure(state, ctx.cwd, ctx);

    // Sweep cwd for dangerous-file stubs leaked by a prior pi session
    // that exited too hard for the cleanup handler to fire (SIGKILL,
    // OOM, WSL VM kill, parent shell crash). Skips git-tracked
    // 0-byte files / empty dirs via the same `isProtected` hook used
    // by `createDangerousFileStubs`. No-op on a clean cwd.
    refreshDangerousProtected(state, ctx.cwd);
    const swept = sweepOrphanDangerousStubs(ctx.cwd, {
      isProtected: (p) => state.dangerousProtected.has(p),
    });
    if (swept.length > 0) {
      ctx.ui.notify(
        `sandbox: cleaned up ${swept.length} orphaned dangerous-file stub${swept.length === 1 ? '' : 's'} from a prior session`,
        'info',
      );
    }
  });

  pi.on('session_shutdown', () => {
    cleanup();
  });

  // The main bash interceptor. Runs AFTER `bash-permissions` (later
  // in directory alphabetical order) so the approval dialog saw the
  // original command. We mutate `event.input.command` in place per
  // plan section 5; the `SANDBOX_ORIGINAL_SYMBOL` stash preserves
  // the unwrapped value for transcript / `/bash-history` consumers.
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    publishActiveUI({
      hasUI: ctx.hasUI,
      select: ctx.ui.select.bind(ctx.ui),
      input: ctx.ui.input.bind(ctx.ui),
      notify: ctx.ui.notify.bind(ctx.ui),
    });
    const original = extractBashCommand(event);
    if (!original) return undefined;
    // Re-entry guard: see hasOriginalStash docstring. Using the symbol
    // stash (which only we can set) instead of alreadyWrapped(original)
    // closes the fail-open on model-supplied marker prefixes.
    if (hasOriginalStash(event.input)) return undefined;

    // Make sure the SandboxManager + active config are current. Lazy-init
    // ASRT here; failure modes (unsupported platform, missing deps, init
    // throw, ...) are folded into performWrap's structured result below
    // so PI_SANDBOX_DEFAULT=block blocks every channel consistently.
    await reconfigure(state, ctx.cwd, ctx);
    await ensureManager(state, ctx.cwd, ctx);

    const safe = stripMarkerFromUserInput(original);

    if (envTruthy(process.env.PI_SANDBOX_DRY_RUN) && state.manager && state.initialized) {
      // Log to stderr so the user can confirm the wrap shape without
      // running it. Only meaningful when init actually succeeded.
      try {
        const wrapped = await state.manager.wrapWithSandbox(safe);
        ctx.ui.notify(`sandbox dry-run wrap:\n  ${wrapped}`, 'info');
      } catch {
        // ignore
      }
      return undefined;
    }

    const result = await performWrap(safe, state, { hasUI: ctx.hasUI, cwd: ctx.cwd });
    if (result.wrapped) {
      stashOriginalCommand(event.input, original);
      stashCreatedStubs(event.input, result.createdStubs ?? []);
      (event.input as { command: string }).command = result.command;
      return undefined;
    }
    if (result.action === 'block') {
      return { block: true, reason: result.reason ?? 'sandbox refused to wrap the command' };
    }
    if (result.action === 'warn' && result.reason) {
      ctx.ui.notify(`sandbox: ${result.reason}`, 'warning');
    }
    return undefined;
  });

  // ─────────────────────────────────────────────────────────────────
  // Tool result hook: surface ASRT's annotated stderr when a
  // sandboxed bash failed, so the model gets a clear violation
  // message instead of an opaque EPERM. Plan section 9.16.
  // Also writes a JSONL audit row to <piAgentDir>/sandbox-violations.log
  // for forensic inspection via /sandbox-violations.
  // ─────────────────────────────────────────────────────────────────
  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    if (!state.manager || !state.initialized) return undefined;
    // Per-command ASRT cleanup. Decrements ASRT's `activeSandboxCount`
    // (incremented by the matching `wrapWithSandbox` in tool_call) and
    // unlinks the empty mount-point files bwrap created on the host
    // for non-existent deny paths. Skipping it leaks `/tmp/claude-empty-*`
    // dirs and the active-count gauge over a long session. Safe to
    // call on every platform - documented as no-op on macOS.
    state.manager.cleanupAfterCommand?.();

    // Per-command dangerous-file-stub cleanup. The matching tool_call
    // hook stashed the per-wrap stub list on `event.input` and bumped
    // each path's refcount in `state.stubRefcount`; here we decrement
    // and unlink the ones that hit zero. Skipping this leaves the
    // stubs sitting in cwd until session_shutdown - the user sees
    // `.bashrc`, `.gitconfig`, `bunfig.toml`, etc. as untracked files
    // for the duration of the session even though every bash command
    // has long since exited. Bg-bash makes the refcount load-bearing:
    // two concurrent commands touching the same stubs only release
    // them when the second `tool_result` fires.
    const wrapStubs = readCreatedStubs(event.input);
    if (wrapStubs.length > 0) {
      const toRemove = decStubRefs(state.stubRefcount, wrapStubs);
      if (toRemove.length > 0) cleanupDangerousFileStubs(toRemove);
    }
    const command = resolveSandboxedCommand(event.input);

    // pi's bash tool returns content as `[{ type: 'text', text: ... }]`
    // with stdout + stderr + a trailing tail marker. We feed that to
    // ASRT's annotator and prefix the resulting hint to the content so
    // the model sees a clear violation message instead of an opaque
    // EPERM. Plan section 9.16.
    const evt = event as {
      content?: { type: string; text?: string }[];
      result?: { stderr?: unknown; output?: unknown };
      isError?: boolean;
    };
    const stderr = extractBashStderr(evt);
    if (!stderr) return undefined;

    // Reactive filesystem-ask: parse the bash stderr ourselves so we
    // can surface a "user just granted access, retry next turn?"
    // dialog. ASRT has no filesystem ask-callback, and its log
    // monitor (which populates the violation store) is macOS-only
    // and we don't enable it - so direct stderr parsing is the only
    // signal we have on either platform. See
    // `lib/node/pi/sandbox/fs-failures.ts`.
    const parsed = parseFsFailures(stderr);
    if (parsed.writePaths.length > 0 && ctx.hasUI) {
      const ask = buildFilesystemAskDialog({
        sessionWriteAllow: state.sessionWriteAllow,
        triggerReconfigure: async () => {
          await reconfigure(state, state.lastCwd ?? ctx.cwd, ctx);
        },
        saveProjectWriteAllow: (p) => {
          const path = pickScopeFs(ctx.cwd);
          addWriteAllowPath(path, p);
          return path;
        },
        saveUserWriteAllow: (p) => {
          addWriteAllowPath(USER_FS_PATH, p);
          return USER_FS_PATH;
        },
        cwd: ctx.cwd,
      });
      const outcome = await ask({ paths: parsed.writePaths, command });

      if (outcome.kind === 'allow') {
        const tag = '⚠️  sandbox blocked this write, but the user just granted access:';
        const hint =
          `scope:        ${outcome.scope}` +
          `\nallowed:      ${outcome.allowedPath}` +
          (outcome.savedPath ? `\nsaved to:     ${outcome.savedPath}` : '') +
          `\n\nThe previous command did not run to completion under the` +
          `\nupdated policy. You may retry the same command on the next` +
          `\nturn if it is still useful.`;
        const newContent = prependBashHint(evt.content, hint, tag);
        if (newContent) {
          const record: SandboxViolationRecord = {
            ts: new Date().toISOString(),
            kind: 'fs',
            action: 'allow',
            command,
            cwd: ctx.cwd,
            path: outcome.allowedPath,
            note: `granted via fs-ask (${outcome.scope})`,
          };
          try {
            appendViolation(USER_VIOLATIONS_LOG, record);
          } catch {
            // Best-effort logging; never let the audit log break the hook.
          }
          return { content: newContent as ToolResultEvent['content'] };
        }
      } else if (outcome.kind === 'deny' && outcome.feedback) {
        const tag = '⚠️  sandbox blocked this write; the user declined to widen the policy:';
        const hint = `user feedback: ${outcome.feedback}`;
        const newContent = prependBashHint(evt.content, hint, tag);
        if (newContent) return { content: newContent as ToolResultEvent['content'] };
      }
      // `kind: 'deny'` without feedback, or `kind: 'no-ui'`, falls
      // through to the existing ASRT-annotation path below.
    }

    // Reactive localhost hint: ASRT's annotator says nothing about a
    // failed connection to a host loopback service, because network
    // isolation (`bwrap --unshare-net`) silently cuts the sandboxed
    // process off from the host's 127.0.0.1 - and ASRT's hardcoded
    // `NO_PROXY=localhost,…` means the request never reaches the
    // filtering proxy that would otherwise log a violation. So a
    // `curl localhost:PORT` against a Docker published port just
    // returns an opaque `000` / `Connection refused`. Detect that
    // signature and tell the model how to reach the service. Skip
    // when network isolation isn't actually in effect: it only
    // unshares the net namespace on Linux, and `network.unrestricted`
    // / a session bypass turn it off. See `loopback-hint.ts`.
    const netUnrestricted = state.lastResolved?.sandboxResult.config.network.unrestricted === true;
    if (state.platform.kind === 'linux' && !state.bypassed && !netUnrestricted) {
      const loopbackHint = detectLoopbackFailure(stderr);
      if (loopbackHint) {
        const tag = '⚠️  sandbox network isolation likely blocked this localhost connection:';
        const newContent = prependBashHint(evt.content, loopbackHint, tag);
        if (newContent) {
          const record: SandboxViolationRecord = {
            ts: new Date().toISOString(),
            kind: 'net',
            action: 'deny',
            command,
            cwd: ctx.cwd,
            note: 'localhost unreachable under --unshare-net (host loopback hint)',
          };
          try {
            appendViolation(USER_VIOLATIONS_LOG, record);
          } catch {
            // Best-effort logging; never let the audit log break the hook.
          }
          return { content: newContent as ToolResultEvent['content'] };
        }
      }
    }

    let annotated: string;
    try {
      annotated = state.manager.annotateStderrWithSandboxFailures(command, stderr);
    } catch {
      return undefined;
    }
    const splice = annotateBashResult(annotated, stderr, evt.content);
    if (!splice) {
      return undefined;
    }

    // Best-effort: append a JSONL audit row.
    const record: SandboxViolationRecord = {
      ts: new Date().toISOString(),
      kind: splice.kind,
      action: 'deny',
      command,
      cwd: ctx.cwd,
      note: splice.hint.split('\n').slice(0, 4).join(' / '),
    };
    try {
      appendViolation(USER_VIOLATIONS_LOG, record);
    } catch {
      // Best-effort logging; never let the audit log break the hook.
    }

    return { content: splice.content as ToolResultEvent['content'] };
  });

  // ─────────────────────────────────────────────────────────────────
  // Slash commands
  // ─────────────────────────────────────────────────────────────────

  pi.registerCommand('sandbox', {
    description: 'Show sandbox status, configuration sources, and recent violations',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_USAGE, 'info');
        return;
      }
      const resolved = await reconfigure(state, ctx.cwd, ctx);
      const { mode, reason } = effectiveMode(state);
      let proxyPorts: { http?: number; socks?: number } | undefined;
      if (state.manager?.getProxyPort) {
        const httpPort = state.manager.getProxyPort();
        const socksPort = state.manager.getSocksProxyPort?.();
        proxyPorts = { http: httpPort, socks: socksPort };
      }
      const persona = getActivePersona();
      const report = buildSandboxStatusReport({
        mode,
        reason,
        platform: {
          description: state.platform.description,
          kind: state.platform.kind,
          missingDeps: state.platform.missingDeps,
          hints: state.platform.hints,
          apparmorBlocksUserNs: state.platform.apparmorBlocksUserNs,
          isInsideDocker: state.platform.isInsideDocker,
        },
        wrapsAttempted: state.wrapsAttempted,
        wrapsErrored: state.wrapsErrored,
        lastWrapError: state.lastWrapError,
        proxyPorts,
        sources: {
          userFs: USER_FS_PATH,
          userSandbox: USER_SANDBOX_PATH,
          projectFs: projectFsPath(ctx.cwd),
          projectSandbox: projectSandboxPath(ctx.cwd),
        },
        persona:
          persona && persona.resolvedWriteRoots.length > 0
            ? { name: persona.name, resolvedWriteRoots: persona.resolvedWriteRoots }
            : undefined,
        network: resolved.sandboxResult.config.network,
        networkDefault: envNetworkDefault(),
        filesystem: {
          writeAllowPaths: resolved.fsPolicy.write.allow.paths,
          readDenyPaths: resolved.fsPolicy.read.deny.paths,
        },
        compiled: resolved.compiled,
        lossyNotes: resolved.lossyNotes,
        recentViolations: readViolations(USER_VIOLATIONS_LOG, { limit: 10 }),
      });
      ctx.ui.notify(report, 'info');
    },
  });

  // Recently-blocked domains from the violation log, newest first, for
  // `/sandbox-allow` / `/sandbox-deny` completion. The `host` field is
  // `host:port`; strip the port so the candidate is a bare domain.
  const recentBlockedDomains = (): string[] => {
    const seen = new Set<string>();
    for (const r of readViolations(USER_VIOLATIONS_LOG, { kind: 'net', limit: 50 })) {
      const host = r.host?.split(':')[0]?.trim();
      if (host) seen.add(host);
    }
    return [...seen];
  };

  pi.registerCommand('sandbox-allow', {
    description: 'Add a domain to the sandbox network allowlist',
    getArgumentCompletions: (prefix) =>
      completePositional(prefix, () => recentBlockedDomains().map((label) => ({ label }))),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_ALLOW_USAGE, 'info');
        return;
      }
      const domain = args.trim();
      if (!domain) {
        ctx.ui.notify(SANDBOX_ALLOW_USAGE, 'warning');
        return;
      }
      const path = pickScopeSandbox(ctx.cwd);
      if (!withSafeConfigWrite(ctx, () => addNetworkRule(path, 'allow', domain))) return;
      ctx.ui.notify(`Added network.allow "${domain}" \u2192 ${path}`, 'info');
      await reconfigure(state, ctx.cwd, ctx);
    },
  });

  pi.registerCommand('sandbox-deny', {
    description: 'Add a domain to the sandbox network denylist',
    getArgumentCompletions: (prefix) =>
      completePositional(prefix, () => recentBlockedDomains().map((label) => ({ label }))),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_DENY_USAGE, 'info');
        return;
      }
      const domain = args.trim();
      if (!domain) {
        ctx.ui.notify(SANDBOX_DENY_USAGE, 'warning');
        return;
      }
      const path = pickScopeSandbox(ctx.cwd);
      if (!withSafeConfigWrite(ctx, () => addNetworkRule(path, 'deny', domain))) return;
      ctx.ui.notify(`Added network.deny "${domain}" \u2192 ${path}`, 'info');
      await reconfigure(state, ctx.cwd, ctx);
    },
  });

  pi.registerCommand('sandbox-allow-write', {
    description: 'Add a path to filesystem.write.allow.paths (UI-confirmed; weakens policy)',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_ALLOW_WRITE_USAGE, 'info');
        return;
      }
      const p = args.trim();
      if (!p) {
        ctx.ui.notify(SANDBOX_ALLOW_WRITE_USAGE, 'warning');
        return;
      }
      let targetPath: string;
      if (ctx.hasUI) {
        const choice = await ctx.ui.select(
          `\u26a0\ufe0f  This widens the write-allowlist:\n\n  ${p}\n\nWrites under this path will no longer prompt and the kernel sandbox will permit them. Confirm?`,
          ['Add (project scope)', 'Add (user scope)', 'Cancel'],
        );
        if (choice === 'Cancel' || !choice) {
          ctx.ui.notify('sandbox: not modified', 'info');
          return;
        }
        targetPath = choice === 'Add (user scope)' ? USER_FS_PATH : pickScopeFs(ctx.cwd);
      } else {
        targetPath = pickScopeFs(ctx.cwd);
      }
      if (!withSafeConfigWrite(ctx, () => addWriteAllowPath(targetPath, p))) return;
      ctx.ui.notify(`Added write.allow.paths "${p}" \u2192 ${targetPath}`, 'info');
      await reconfigure(state, ctx.cwd, ctx);
    },
  });

  pi.registerCommand('sandbox-violations', {
    description: 'Show recent sandbox violations (--net / --fs to filter)',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        '--net': { description: 'Show only network violations' },
        '--fs': { description: 'Show only filesystem violations' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_VIOLATIONS_USAGE, 'info');
        return;
      }
      const trimmed = args.trim();
      const kind: SandboxViolationKind | undefined =
        trimmed === '--net'
          ? 'net'
          : trimmed === '--fs'
            ? 'fs'
            : trimmed === '--unix-socket'
              ? 'unix-socket'
              : undefined;
      const records = readViolations(USER_VIOLATIONS_LOG, kind ? { kind, limit: 50 } : { limit: 50 });
      if (records.length === 0) {
        ctx.ui.notify('sandbox: no violations recorded', 'info');
        return;
      }
      const lines = records.map(
        (r) =>
          `${r.ts} ${r.kind} ${r.action}${r.path ? ` path=${r.path}` : ''}${r.host ? ` host=${r.host}` : ''}${r.note ? ` note=${r.note}` : ''}`,
      );
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('sandbox-rescan', {
    description: 'Recompile Linux rule basenames/segments to literal paths via ripgrep',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_RESCAN_USAGE, 'info');
        return;
      }
      if (state.platform.kind !== 'linux') {
        ctx.ui.notify('sandbox-rescan: macOS uses sandbox-exec globs natively, no rescan needed', 'info');
        return;
      }
      const resolved = await reconfigure(state, ctx.cwd, ctx);
      ctx.ui.notify(
        `sandbox: recompiled ${resolved.compiled?.read.paths.length ?? 0} read + ` +
          `${resolved.compiled?.write.paths.length ?? 0} write paths`,
        'info',
      );
    },
  });

  pi.registerCommand('sandbox-recheck', {
    description: 'Re-run dependency detection (after installing bubblewrap / ripgrep / socat)',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_RECHECK_USAGE, 'info');
        return;
      }
      const next = detectSandboxPlatform(defaultPlatformProbe());
      state.platform = next;
      ctx.ui.notify(
        `sandbox: platform=${next.description}` +
          (next.missingDeps.length > 0 ? `, missing: ${next.missingDeps.join(', ')}` : ', deps OK'),
        next.missingDeps.length > 0 ? 'warning' : 'info',
      );
      publishStatusline(state);
      await reconfigure(state, ctx.cwd, ctx);
    },
  });

  pi.registerCommand('sandbox-disable', {
    description: 'Session-only sandbox bypass (cleared on session_shutdown)',
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_DISABLE_USAGE, 'info');
        return;
      }
      state.bypassed = true;
      state.reason = '/sandbox-disable';
      publishStatusline(state);
      ctx.ui.notify(
        '\u26a0\ufe0f  sandbox: session bypass active. Bash subprocesses will run UNWRAPPED until /reload or session end.',
        'warning',
      );
    },
  });
}
