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
 *   /sandbox-disable          session-only full bypass; badge hidden.
 *   /sandbox-enable           clear full bypass for new commands.
 *   /sandbox-network <verb>   enable/disable/status for network only.
 *   /sandbox-reset            clear sandbox session grants and overrides.
 *   /sandbox-explain <kind>   explain path or host policy without probing.
 *   /sandbox-test             native synthetic filesystem self-test.
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

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

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
import { buildFilesystemAskDialog, explainUngrantableWrite } from '../../../lib/node/pi/sandbox/filesystem-ask.ts';
import {
  SANDBOX_ALLOW_USAGE,
  SANDBOX_ALLOW_WRITE_USAGE,
  SANDBOX_DENY_USAGE,
  SANDBOX_DISABLE_USAGE,
  SANDBOX_ENABLE_USAGE,
  SANDBOX_NETWORK_USAGE,
  SANDBOX_RESET_USAGE,
  SANDBOX_EXPLAIN_USAGE,
  SANDBOX_TEST_USAGE,
  SANDBOX_RECHECK_USAGE,
  SANDBOX_RESCAN_USAGE,
  SANDBOX_USAGE,
  SANDBOX_VIOLATIONS_USAGE,
} from '../../../lib/node/pi/sandbox/usage.ts';
import { parseFsFailures } from '../../../lib/node/pi/sandbox/fs-failures.ts';
import { gitTrackedSubset, resolveGitExcludeFile } from '../../../lib/node/pi/sandbox/git-tracked.ts';
import { computeExcludableStubs, spliceManagedBlock } from '../../../lib/node/pi/sandbox/git-exclude-block.ts';
import { buildNetworkAskCallback, type NetworkAskAnswer } from '../../../lib/node/pi/sandbox/network-ask.ts';
import { annotateBashResult, prependBashHint } from '../../../lib/node/pi/sandbox/result-annotate.ts';
import { buildSandboxStatusReport } from '../../../lib/node/pi/sandbox/status-report.ts';
import {
  applyNetworkSandboxOverride,
  buildNetworkControlStatus,
  type NetworkSandboxOverride,
} from '../../../lib/node/pi/sandbox/session-controls.ts';
import { buildSandboxExplanation } from '../../../lib/node/pi/sandbox/explain.ts';
import { runSandboxSelfTest } from '../../../lib/node/pi/sandbox/self-test.ts';
import { detectLoopbackFailure } from '../../../lib/node/pi/sandbox/loopback-hint.ts';
import { prependLocalhostProxyEnv } from '../../../lib/node/pi/sandbox/localhost-proxy.ts';
import { type FilesystemPolicyLayer, loadFilesystemPolicy } from '../../../lib/node/pi/filesystem-policy/load.ts';
import { type FilesystemPolicyWarning } from '../../../lib/node/pi/filesystem-policy/schema.ts';
import { readTextOrEmpty } from '../../../lib/node/pi/fs-safe.ts';
import { atomicWriteFile, ensureDirSync } from '../../../lib/node/pi/atomic-write.ts';
import { JsoncReadError } from '../../../lib/node/pi/jsonc.ts';
import { createNotifyOnce } from '../../../lib/node/pi/notify-once.ts';
import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { piAgentDir, piProjectPath } from '../../../lib/node/pi/pi-paths.ts';
import { pickScopeFile } from '../../../lib/node/pi/scope-pick.ts';
import { getActivePersona } from '../../../lib/node/pi/persona/active.ts';
import { preserveStructuredContent } from '../../../lib/node/pi/tool-events.ts';

import {
  activeReconfigure,
  beginActiveReconfigure,
  clearActiveSandbox,
  getActiveSandbox,
  hashSandboxConfig,
  publishActiveSandbox,
  runActiveSandboxOperation,
} from '../../../lib/node/pi/sandbox/active.ts';
import {
  type AsrtModule,
  type AsrtSandboxManager,
  loadAsrtModule,
  resolveAsrtPackageRoot,
  validateRuntimeConfig,
} from '../../../lib/node/pi/sandbox/asrt-manager.ts';
import { ensureAsrtTmpdir } from '../../../lib/node/pi/sandbox/asrt-tmpdir.ts';
import { loadSandboxConfig } from '../../../lib/node/pi/sandbox/config-load.ts';
import { translateToASRT } from '../../../lib/node/pi/sandbox/config-translate.ts';
import { addNetworkRule, addWriteAllowPath } from '../../../lib/node/pi/sandbox/config-write.ts';
import { logE2bigWrap } from '../../../lib/node/pi/sandbox/e2big-debug.ts';
import { resolveNetworkDefault, resolveSandboxFallback } from '../../../lib/node/pi/sandbox/env-defaults.ts';
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
  readCommandId,
  stashCommandId,
  stashOriginalCommand,
  stripMarkerFromUserInput,
} from '../../../lib/node/pi/sandbox/markers.ts';
import { extractBashStderr, resolveSandboxedCommand } from '../../../lib/node/pi/sandbox/tool-result.ts';
import {
  createWrapLedger,
  drainWrapLedger,
  recordWrap,
  releaseWrap,
  type WrapLedger,
} from '../../../lib/node/pi/sandbox/wrap-ledger.ts';
import { createViolationFeed, hostOfHostPort, violationToRecord } from '../../../lib/node/pi/sandbox/violation-feed.ts';
import { chainSignalListeners, snapshotSignalListeners } from '../../../lib/node/pi/sandbox/signal-chain.ts';
import {
  installSandboxWrapper,
  releaseSandboxWrap,
  requestSandboxWrap,
  type SandboxWrapFn,
  type SandboxWrapHandle,
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
  return resolveSandboxFallback();
}

function envNetworkDefault(): 'allow' | 'deny' {
  return resolveNetworkDefault();
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
  PI_SANDBOX_NETWORK_UNRESTRICTED?: string;
  PI_SANDBOX_ALLOW_LOCALHOST?: string;
} {
  return {
    PI_SANDBOX_NESTED: process.env.PI_SANDBOX_NESTED,
    PI_SANDBOX_WEAKER_NET: process.env.PI_SANDBOX_WEAKER_NET,
    PI_SANDBOX_EXTRA_ALLOW_DOMAIN: process.env.PI_SANDBOX_EXTRA_ALLOW_DOMAIN,
    PI_SANDBOX_NETWORK_UNRESTRICTED: process.env.PI_SANDBOX_NETWORK_UNRESTRICTED,
    PI_SANDBOX_ALLOW_LOCALHOST: process.env.PI_SANDBOX_ALLOW_LOCALHOST,
  };
}

/** Installed sandbox-runtime package dir, resolved once per load. */
let asrtPackageRoot: string | null | undefined;
function sandboxRuntimeRoot(): string | undefined {
  if (asrtPackageRoot === undefined) asrtPackageRoot = resolveAsrtPackageRoot() ?? null;
  return asrtPackageRoot ?? undefined;
}

interface ResolvedAll {
  fsPolicy: ReturnType<typeof loadFilesystemPolicy>['policy'];
  fsWarnings: FilesystemPolicyWarning[];
  sandboxResult: ReturnType<typeof loadSandboxConfig>;
  compiled?: CompiledPolicyReport;
  asrtConfig: ReturnType<typeof translateToASRT>['config'];
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
  networkOverride?: NetworkSandboxOverride,
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
  sandboxResult.config = applyNetworkSandboxOverride(sandboxResult.config, networkOverride);

  let compiled: CompiledPolicyReport | undefined;
  if (platform.kind === 'linux') {
    compiled = compileLinuxPolicy(fs.policy, {
      cwd,
      extraRoots: persona?.resolvedWriteRoots ?? [],
      depth: sandboxResult.config.flags.linuxRuleDepth,
    });
  }

  const mode: 'darwin' | 'linux' = platform.kind === 'linux' ? 'linux' : 'darwin';
  const runtimeRoot = sandboxResult.config.flags.protectSandboxRuntime ? sandboxRuntimeRoot() : undefined;
  const { config: asrtConfig, lossyNotes } = translateToASRT({
    policy: fs.policy,
    sandbox: sandboxResult.config,
    cwd,
    mode,
    compiled,
    protectPaths: runtimeRoot ? [runtimeRoot] : [],
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
  /** Latest session ctx (from session_start / the bash hook) so slot
   *  consumers (bg_bash, subagent bash) can lazy-init + reconfigure the
   *  manager too. Dropped on shutdown. */
  sessionCtx?: ExtensionContext;
  /** True after `manager.initialize()` returned successfully. */
  initialized: boolean;
  /** Reject new work once shutdown starts, including queued wraps. */
  stopping: boolean;
  /** Session-only bypass toggled by `/sandbox-disable`. */
  bypassed: boolean;
  /** Highest-precedence, session-only network mode; undefined restores files/env. */
  networkOverride?: NetworkSandboxOverride;
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
  /** In-flight wraps (by ASRT `commandId`) + the dangerous-file stub
   *  refcount. Every successful wrap is recorded; the matching release
   *  (bash `tool_result`, bg-bash job exit, subagent `tool_result`)
   *  calls ASRT's `cleanupAfterCommand()` exactly once and unlinks the
   *  stubs whose count dropped to zero. Unwrapped commands never touch
   *  it, so they can't drop ASRT's active-sandbox count while another
   *  sandbox still relies on its mount points. Drained on
   *  `session_shutdown`. See `lib/node/pi/sandbox/wrap-ledger.ts`. */
  ledger: WrapLedger;
  /** Origin cwd for each in-flight wrap, used to protect shared proxy policy. */
  wrapCwds: Map<string, string>;
  /** The loaded ASRT module (set by {@link ensureManager}); used for
   *  schema validation in {@link reconfigure}. */
  asrt?: AsrtModule;
  /** Unsubscribe handle for the ASRT violation-store feed. */
  violationUnsubscribe?: () => void;
  /** Issues from validating the translated config against ASRT's own
   *  schema, plus `updateConfig` failures. Rendered by `/sandbox`. */
  configIssues: string[];
  /** Warnings / errors from ASRT's `checkDependencies()`. */
  dependencyNotes: string[];
  /** Notify-once tracker for {@link configIssues}. */
  configIssueWarnings: ReturnType<typeof createNotifyOnce>;
  /** Cwd whose `dangerousProtected` Set was last computed. Used to
   *  invalidate the cache when the user runs `cd` mid-session. */
  dangerousProtectedCwd?: string;
  /** Extra git-tracked protection for stub creation and git-exclude entries.
   *  Stub ownership is checked separately, including for untracked paths.
   *  Recomputed on cwd change via {@link refreshDangerousProtected}. */
  dangerousProtected: Set<string>;
  /** Absolute path of the git exclude file (`<git-common-dir>/info/exclude`)
   *  we last wrote the pi-sandbox managed block into, so `cleanup()`
   *  can strip it on session end. Undefined when the git-exclude-stub
   *  feature is off or `cwd` is not a git work tree. See
   *  `syncGitExcludeStubs` / `stripGitExcludeStubs`. */
  gitExcludeFile?: string;
}

function newState(platform: SandboxPlatformInfo): RuntimeState {
  return {
    platform,
    initialized: false,
    stopping: false,
    bypassed: false,
    fsWarnings: createNotifyOnce({ tag: 'sandbox' }),
    sandboxWarnings: createNotifyOnce({ tag: 'sandbox' }),
    degradedNotified: false,
    wrapsAttempted: 0,
    wrapsErrored: 0,
    sessionAllowedDomains: new Set(),
    sessionWriteAllow: new Set(),
    ledger: createWrapLedger(),
    wrapCwds: new Map(),
    configIssues: [],
    dependencyNotes: [],
    configIssueWarnings: createNotifyOnce({ tag: 'sandbox' }),
    dangerousProtected: new Set(),
  };
}

/**
 * Recompute {@link RuntimeState.dangerousProtected} for `cwd` if it
 * differs from the cached value. The protected set is the subset of
 * the dangerous-stub paths under `cwd` that are tracked in `cwd`'s
 * git index. This is an extra filter, not evidence of stub ownership:
 * unknown files are preserved even when git is unavailable.
 * `gitTrackedSubset` runs once per cwd change with a 2s timeout.
 */
function refreshDangerousProtected(state: RuntimeState, cwd: string): void {
  if (state.dangerousProtectedCwd === cwd) return;
  state.dangerousProtected = gitTrackedSubset(cwd, listDangerousStubPaths(cwd));
  state.dangerousProtectedCwd = cwd;
}

/** Dangerous-file stubs are a bubblewrap mount-point race workaround:
 *  only Linux creates host-side mount points for absent deny paths.
 *  sandbox-exec (macOS) denies by pattern, so no stubs and no
 *  git-exclude block there. The sweep only touches process-owned stubs;
 *  unknown leftovers from older versions are preserved. */
function stubsApply(state: RuntimeState): boolean {
  return state.platform.kind === 'linux';
}

/** True when the git-exclude-stub feature is active: the resolved
 *  `sandbox.json` knob is on AND the hard env off-switch is not set.
 *  The env disable wins over the config file (aspect-level disable
 *  convention), so a stray `PI_SANDBOX_DISABLE_GIT_EXCLUDE=1` always
 *  turns it off. */
function gitExcludeEnabled(state: RuntimeState): boolean {
  if (!stubsApply(state)) return false;
  if (envTruthy(process.env.PI_SANDBOX_DISABLE_GIT_EXCLUDE)) return false;
  return state.lastResolved?.sandboxResult.config.gitExcludeStubs ?? true;
}

/**
 * Write / refresh the pi-sandbox managed block in `cwd`'s git exclude
 * file so the transient dangerous-file stubs stay out of `git status`.
 * No-op when the feature is disabled or `cwd` is not a git work tree.
 * Records the exclude-file path on {@link RuntimeState.gitExcludeFile}
 * so {@link stripGitExcludeStubs} can remove the block on shutdown.
 * Best-effort and never-throwing - a failure here must never break a
 * bash wrap or session start.
 */
function syncGitExcludeStubs(state: RuntimeState, cwd: string): void {
  if (!gitExcludeEnabled(state)) return;
  try {
    const file = resolveGitExcludeFile(cwd);
    if (!file) return;
    refreshDangerousProtected(state, cwd);
    const entries = computeExcludableStubs(cwd, {
      isTracked: (abs) => state.dangerousProtected.has(abs),
    });
    const next = spliceManagedBlock(readTextOrEmpty(file), entries);
    ensureDirSync(dirname(file));
    atomicWriteFile(file, next);
    state.gitExcludeFile = file;
  } catch {
    // Best-effort: leave git status noisier rather than crash.
  }
}

/**
 * Remove the pi-sandbox managed block from the exclude file we last
 * wrote to, so the repo's `info/exclude` is untouched whenever pi is
 * not running. Idempotent and never-throwing (safe in `cleanup()`).
 */
function stripGitExcludeStubs(state: RuntimeState): void {
  const file = state.gitExcludeFile;
  if (!file) return;
  state.gitExcludeFile = undefined;
  try {
    const current = readTextOrEmpty(file);
    if (!current) return;
    atomicWriteFile(file, spliceManagedBlock(current, []));
  } catch {
    // Best-effort teardown.
  }
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
  });
}

function publishStatusline(state: RuntimeState): void {
  const { mode, reason } = effectiveMode(state);
  const networkNote =
    mode === 'wrapped' && state.lastResolved?.sandboxResult.config.network.unrestricted
      ? 'network sandbox disabled; filesystem protection remains on'
      : undefined;
  const detail = [reason, networkNote].filter(Boolean).join('; ');
  setSandboxState(detail ? { mode, reason: detail } : { mode });
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
  supportsDenyReason: boolean,
): (params: { host: string; port: number | undefined }) => Promise<NetworkAskAnswer> {
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
    supportsDenyReason,
  });
}

/** Validate the translated config against ASRT's schema (the library
 *  itself does not) and surface new issues once. */
function checkRuntimeConfig(state: RuntimeState, asrtConfig: unknown, ctx?: ExtensionContext): void {
  const issues = validateRuntimeConfig(state.asrt?.SandboxRuntimeConfigSchema, asrtConfig);
  state.configIssues = issues;
  if (ctx && issues.length > 0) {
    state.configIssueWarnings.surface(
      ctx.ui.notify.bind(ctx.ui),
      issues.map((reason) => ({ source: 'runtime config', reason })),
    );
  }
}

/**
 * Reconfigure the live ASRT manager from the current on-disk config
 * + active persona. Returns the resolved snapshot the caller can
 * render; publish only after SandboxManager.updateConfig() accepts it,
 * so status and the shared snapshot never claim an unapplied policy.
 */
async function reconfigureUnlocked(state: RuntimeState, cwd: string, ctx?: ExtensionContext): Promise<ResolvedAll> {
  const done = beginActiveReconfigure();
  try {
    const resolved = resolveAll(cwd, state.platform, Array.from(state.sessionWriteAllow), state.networkOverride);
    // Network namespaces cannot be changed in-place. ASRT also has a
    // shared live proxy, so do not switch it out beneath active wraps.
    if (
      state.ledger.inflight.size > 0 &&
      state.lastResolved &&
      (state.lastResolved.sandboxResult.config.network.unrestricted === true) !==
        (resolved.sandboxResult.config.network.unrestricted === true)
    ) {
      throw new Error(
        'sandbox: different network policy/isolation requested while wrapped commands are active; stop them first, then retry',
      );
    }
    // ASRT's proxy reads one live network policy for every command.
    // Do not let a different cwd replace it under an existing job.
    // Same-cwd trusted edits/approval commands retain live reload.
    if (
      [...state.wrapCwds.values()].some((origin) => origin !== cwd) &&
      state.lastResolved &&
      JSON.stringify(state.lastResolved.sandboxResult.config.network) !==
        JSON.stringify(resolved.sandboxResult.config.network)
    ) {
      throw new Error(
        'sandbox: a different network policy is in use by running commands; wait for them to finish, then retry',
      );
    }
    if (ctx) {
      const notify = ctx.ui.notify.bind(ctx.ui);
      if (resolved.fsWarnings.length > 0) state.fsWarnings.surface(notify, resolved.fsWarnings);
      if (resolved.sandboxResult.warnings.length > 0) {
        state.sandboxWarnings.surface(notify, resolved.sandboxResult.warnings);
      }
    }

    const snapshot = {
      filesystem: resolved.fsPolicy,
      sandbox: resolved.sandboxResult.config,
      platform: state.platform.kind,
      // Hash what ASRT actually receives, so a change that only appears
      // after translation (a new secret file found by the Linux compile,
      // a different cwd) still reaches updateConfig().
      runtime: resolved.asrtConfig,
    };
    const changed = getActiveSandbox()?.configHash !== hashSandboxConfig(snapshot);
    if (state.manager && state.initialized && changed) {
      checkRuntimeConfig(state, resolved.asrtConfig, ctx);
      try {
        state.manager.updateConfig(resolved.asrtConfig);
      } catch (e) {
        // Do not publish or report a requested control change as applied
        // while ASRT still enforces the previous policy.
        const msg = `updateConfig failed (previous config still in effect): ${e instanceof Error ? e.message : String(e)}`;
        state.configIssues = [...state.configIssues, msg];
        if (ctx) {
          state.configIssueWarnings.surface(ctx.ui.notify.bind(ctx.ui), [{ source: 'runtime config', reason: msg }]);
        }
        throw new Error(msg);
      }
    }

    publishActiveSandbox(snapshot);
    state.lastCwd = cwd;
    state.lastResolved = resolved;
    publishStatusline(state);
    return resolved;
  } finally {
    done();
  }
}

function reconfigure(state: RuntimeState, cwd: string, ctx?: ExtensionContext): Promise<ResolvedAll> {
  return runActiveSandboxOperation(() => reconfigureUnlocked(state, cwd, ctx));
}

/** Run ASRT's dependency probe once per init and surface its notes.
 *  The "installed where a sandboxed command can write it" warning is
 *  dropped when `flags.protectSandboxRuntime` already put the package
 *  on the kernel write-deny list (ASRT's probe only looks at the write
 *  roots, not at denies beneath them). */
function surfaceDependencyNotes(state: RuntimeState, resolved: ResolvedAll, ctx: ExtensionContext): void {
  const manager = state.manager;
  if (!manager?.checkDependencies) return;
  let result: { errors: string[]; warnings: string[] };
  try {
    result = manager.checkDependencies();
  } catch {
    return;
  }
  const protectedRuntime =
    resolved.sandboxResult.config.flags.protectSandboxRuntime && sandboxRuntimeRoot() !== undefined;
  const warnings = result.warnings.filter((w) => !(protectedRuntime && w.includes('sandbox-runtime is installed in')));
  state.dependencyNotes = [...result.errors.map((e) => `error: ${e}`), ...warnings.map((w) => `warning: ${w}`)];
  if (state.dependencyNotes.length > 0) {
    ctx.ui.notify(`sandbox: dependency check:\n  ${state.dependencyNotes.join('\n  ')}`, 'warning');
  }
}

/** Mirror ASRT's violation store (proxy denials, with host + command
 *  attribution) into the JSONL audit log. Idempotent. */
function subscribeViolationFeed(state: RuntimeState): void {
  if (state.violationUnsubscribe || !state.manager) return;
  const store = state.manager.getSandboxViolationStore();
  if (typeof store.subscribe !== 'function') return;
  const feed = createViolationFeed(
    (event) => {
      const record = violationToRecord(event, { cwd: state.lastCwd ?? process.cwd() });
      if (!record) return;
      try {
        appendViolation(USER_VIOLATIONS_LOG, record);
      } catch {
        // Best-effort logging.
      }
    },
    { skipBacklog: true },
  );
  state.violationUnsubscribe = store.subscribe(feed);
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
    state.asrt = asrt;
    const resolved = state.lastResolved ?? (await reconfigureUnlocked(state, cwd, ctx));
    if (!asrt.SandboxManager.isSupportedPlatform()) {
      state.reason = 'ASRT reports platform unsupported';
      publishStatusline(state);
      return false;
    }
    const askCallback = buildAskCallback(
      state,
      async () => {
        await reconfigure(state, state.lastCwd ?? cwd, ctx);
      },
      asrt.SandboxManager.askCallbackDenyReason === true,
    );
    checkRuntimeConfig(state, resolved.asrtConfig, ctx);
    const sigintBefore = snapshotSignalListeners(process, 'SIGINT');
    try {
      await asrt.SandboxManager.initialize(resolved.asrtConfig, askCallback, false);
    } finally {
      // ASRT's own SIGINT cleanup listener never re-raises, so without
      // this the first Ctrl-C on `pi -p` tears the sandbox down and pi
      // keeps running. Chain it: run ASRT's cleanup, then re-deliver.
      chainSignalListeners(process, 'SIGINT', sigintBefore);
    }
    state.manager = asrt.SandboxManager;
    state.initialized = true;
    surfaceDependencyNotes(state, resolved, ctx);
    subscribeViolationFeed(state);
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

interface SessionControlChange {
  bypassed?: boolean;
  networkOverride?: NetworkSandboxOverride;
  reset?: boolean;
}

/** Mutate controls and apply policy under the same reservation as wraps.
 * Restore session settings if the runtime rejects a change. */
async function changeSessionControls(
  state: RuntimeState,
  ctx: ExtensionContext,
  change: SessionControlChange,
): Promise<boolean> {
  return runActiveSandboxOperation(async () => {
    if (state.stopping) return false;
    const previous = {
      bypassed: state.bypassed,
      networkOverride: state.networkOverride,
      reason: state.reason,
      domains: [...state.sessionAllowedDomains],
      paths: [...state.sessionWriteAllow],
    };
    if (change.reset) {
      state.bypassed = false;
      state.networkOverride = undefined;
      state.sessionAllowedDomains.clear();
      state.sessionWriteAllow.clear();
      state.reason = undefined;
    }
    if (change.bypassed !== undefined) {
      state.bypassed = change.bypassed;
      state.reason = change.bypassed ? '/sandbox-disable' : undefined;
    }
    if (change.networkOverride !== undefined) state.networkOverride = change.networkOverride;
    try {
      if (change.bypassed !== true || change.reset || change.networkOverride !== undefined) {
        await reconfigureUnlocked(state, ctx.cwd, ctx);
        if (!state.bypassed) await ensureManager(state, ctx.cwd, ctx);
      }
      publishStatusline(state);
      return true;
    } catch (e) {
      state.bypassed = previous.bypassed;
      state.networkOverride = previous.networkOverride;
      state.reason = previous.reason;
      state.sessionAllowedDomains.clear();
      for (const host of previous.domains) state.sessionAllowedDomains.add(host);
      state.sessionWriteAllow.clear();
      for (const path of previous.paths) state.sessionWriteAllow.add(path);
      publishStatusline(state);
      ctx.ui.notify(`sandbox: controls unchanged: ${e instanceof Error ? e.message : String(e)}`, 'warning');
      return false;
    }
  });
}

function networkControlStatus(state: RuntimeState): string {
  const resolved =
    state.lastResolved ??
    resolveAll(state.lastCwd ?? process.cwd(), state.platform, [...state.sessionWriteAllow], state.networkOverride);
  return buildNetworkControlStatus({
    mode: effectiveMode(state).mode,
    initialized: state.initialized,
    dryRun: envTruthy(process.env.PI_SANDBOX_DRY_RUN),
    unrestricted: resolved.sandboxResult.config.network.unrestricted === true,
    override: state.networkOverride,
    activeWraps: state.ledger.inflight.size,
  });
}

/** Release one wrap: ASRT's per-command cleanup + stub refcount. Only
 *  acts for a wrap recorded in the ledger, and only once. */
function releaseWrapHandle(state: RuntimeState, handle: SandboxWrapHandle): void {
  const outcome = releaseWrap(state.ledger, handle.commandId);
  if (!outcome.released) return;
  if (handle.commandId) state.wrapCwds.delete(handle.commandId);
  try {
    state.manager?.cleanupAfterCommand?.();
  } catch {
    // Best-effort.
  }
  if (outcome.stubsToRemove.length > 0) cleanupDangerousFileStubs(outcome.stubsToRemove);
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
  ctx: { hasUI: boolean; cwd: string; signal?: AbortSignal },
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
  let created: string[] = [];
  try {
    await activeReconfigure();
    // Pre-create ASRT's sandbox TMPDIR on the host. ASRT sets
    // TMPDIR=/tmp/claude inside every sandboxed child and treats it as
    // a default write path, but its Linux binder skips write paths
    // that don't exist on the host - so an absent /tmp/claude is never
    // bound and any sandboxed `mktemp`/temp-file write fails with
    // `No such file or directory` (see asrt-tmpdir.ts). Idempotent.
    ensureAsrtTmpdir();
    // Linux only: pre-create empty stubs for ASRT's DANGEROUS_FILES so
    // concurrent bwrap setups don't race on the mount-point
    // `O_CREAT|O_WRONLY` against a 0444 stub (see dangerous-file-stubs.ts
    // module docs). sandbox-exec on macOS denies by pattern and never
    // creates mount points, so the stubs would only be noise there.
    // Only process-owned stubs can be reused or removed. Unknown empty
    // files and symlink ancestors are preserved, regardless of git status.
    if (stubsApply(state)) {
      refreshDangerousProtected(state, process.cwd());
      created = createDangerousFileStubs(process.cwd(), {
        isProtected: (p) => state.dangerousProtected.has(p),
      });
    }
    // Under network.allowLocalhost, rewrite the command's NO_PROXY so
    // loopback HTTP(S)/SOCKS routes through ASRT's proxy (which dials
    // the host loopback). No-op when unrestricted (host net already
    // shared) or when the flag is off. The original command is stashed
    // by the caller; only the executed string carries the prefix.
    const net = state.lastResolved?.sandboxResult.config.network;
    const toWrap = net?.allowLocalhost && net.unrestricted !== true ? prependLocalhostProxyEnv(command) : command;
    // Unguessable per-wrap id: ASRT attributes violations to it (so
    // annotateStderrWithSandboxFailures matches even though the wrapped
    // string carries the NO_PROXY prefix) and the ledger releases
    // exactly this wrap later.
    const commandId = `pi-${randomUUID()}`;
    const wrapped = await state.manager.wrapWithSandbox(toWrap, undefined, undefined, ctx.signal, {
      commandId,
      commandText: command,
    });
    recordWrap(state.ledger, commandId, created);
    state.wrapCwds.set(commandId, ctx.cwd);
    logE2bigWrap(
      { wrapsAttempted: state.wrapsAttempted, lastResolvedAsrtConfig: state.lastResolved?.asrtConfig },
      command,
      wrapped,
    );
    return { command: wrapped, wrapped: true, createdStubs: created, commandId };
  } catch (e) {
    // ASRT undoes its own active-sandbox count when a wrap throws; we
    // only have to drop stubs this attempt created that no in-flight
    // wrap holds.
    const orphaned = created.filter((p) => !state.ledger.stubRefs.has(p));
    if (orphaned.length > 0) cleanupDangerousFileStubs(orphaned);
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
    const result = await requestSandboxWrap(safe, { hasUI: ctx.hasUI, cwd: ctx.cwd, signal: ctx.signal });
    if (result.wrapped) {
      stashOriginalCommand(event.input, original);
      stashCommandId(event.input, result.commandId);
      (event.input as { command: string }).command = result.command;
      return undefined;
    }
    if (result.action === 'block') {
      return { block: true, reason: result.reason ?? 'sandbox refused to wrap the command' };
    }
    return undefined;
  });
  // Release the wrap once the subagent's bash call returns (the parent's
  // tool_result hook never sees subagent tool calls). Unknown / unwrapped
  // ids are ignored by the release function.
  pi.on('tool_result', (event) => {
    if (event.toolName !== 'bash') return undefined;
    const commandId = readCommandId(event.input);
    if (commandId) releaseSandboxWrap({ commandId });
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
  // Slot consumers (bg_bash, subagent bash) get the same per-call
  // reconfigure + lazy init as the foreground bash hook; otherwise a
  // bg_bash job started before any foreground bash finds the manager
  // uninitialized and falls back to PI_SANDBOX_DEFAULT (warn = run
  // unwrapped).
  const slotFn: SandboxWrapFn = (command, ctx) =>
    runActiveSandboxOperation(async () => {
      if (state.stopping) return { command, wrapped: false, action: 'block', reason: 'sandbox is shutting down' };
      const extCtx = state.sessionCtx;
      if (extCtx) {
        try {
          await reconfigureUnlocked(state, ctx.cwd, extCtx);
        } catch (e) {
          return { command, wrapped: false, action: 'block', reason: e instanceof Error ? e.message : String(e) };
        }
        await ensureManager(state, ctx.cwd, extCtx);
        if (envTruthy(process.env.PI_SANDBOX_DRY_RUN) && state.manager && state.initialized && !state.bypassed) {
          try {
            const wrapped = await state.manager.wrapWithSandbox(command);
            state.manager.cleanupAfterCommand?.();
            extCtx.ui.notify(`sandbox dry-run wrap:\n  ${wrapped}`, 'info');
          } catch {
            // Dry-run diagnostics never prevent an explicitly unwrapped run.
          }
        }
      }
      return performWrap(command, state, ctx);
    });
  installSandboxWrapper(slotFn, (handle) => {
    releaseWrapHandle(state, handle);
  });

  // Teardown. `session_shutdown` covers /reload and every clean exit -
  // pi turns SIGTERM / SIGHUP into a graceful shutdown that emits it.
  // The `exit` listener is only a synchronous safety net (stubs, the
  // git-exclude block) for a hard `process.exit()`. Deliberately NO
  // SIGINT / SIGTERM listeners: installing one removes Node's default
  // terminate-on-signal, so Ctrl-C under `pi -p` would tear the sandbox
  // down (uninstalling the wrapper slot, so bg_bash / subagent bash run
  // unwrapped) while pi kept running. ASRT's own SIGINT listener has
  // the same flaw; `ensureManager` chains it via `signal-chain.ts`.
  let exitCleanup: (() => void) | undefined;
  const cleanup = (): Promise<void> => {
    let reset = Promise.resolve();
    if (state.manager && state.initialized) {
      try {
        reset = state.manager.reset().catch(() => undefined);
      } catch {
        // A synchronous runtime failure must not prevent other teardown.
      }
    }
    try {
      state.violationUnsubscribe?.();
    } catch {
      // ignore
    }
    state.violationUnsubscribe = undefined;
    state.sessionCtx = undefined;
    state.initialized = false;
    state.manager = undefined;
    state.sessionAllowedDomains.clear();
    state.sessionWriteAllow.clear();
    state.networkOverride = undefined;
    state.bypassed = false;
    cleanupDangerousFileStubs(drainWrapLedger(state.ledger));
    state.wrapCwds.clear();
    stripGitExcludeStubs(state);
    clearActiveSandbox();
    clearActiveUI();
    uninstallSandboxWrapper();
    setSandboxState({ mode: 'off' });
    if (exitCleanup) process.off('exit', exitCleanup);
    return reset;
  };
  exitCleanup = (): void => {
    void cleanup();
  };
  process.on('exit', exitCleanup);

  // Surface deps / platform notifications once at startup.
  pi.on('session_start', async (_event, ctx) => {
    state.sessionCtx = ctx;
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

    // Sweep only process-owned, unused stubs. Unknown empty files and
    // crash leftovers have no ownership record and are never deleted.
    refreshDangerousProtected(state, ctx.cwd);
    const swept = sweepOrphanDangerousStubs(ctx.cwd, {
      isProtected: (p) => state.dangerousProtected.has(p),
    });
    if (swept.length > 0) {
      ctx.ui.notify(
        `sandbox: cleaned up ${swept.length} process-owned dangerous-file stub${swept.length === 1 ? '' : 's'}`,
        'info',
      );
    }

    // Hide the transient dangerous-file stubs from `git status` via a
    // managed block in the repo's git exclude file (default on; see
    // `gitExcludeStubs` / PI_SANDBOX_DISABLE_GIT_EXCLUDE). Stripped in
    // `cleanup()` on session end so the exclude file stays clean when
    // pi is not running.
    syncGitExcludeStubs(state, ctx.cwd);
  });

  pi.on('session_shutdown', async () => {
    state.stopping = true;
    await runActiveSandboxOperation(cleanup);
  });

  // The main bash interceptor. Runs AFTER `bash-permissions` (later
  // in directory alphabetical order) so the approval dialog saw the
  // original command. We mutate `event.input.command` in place per
  // plan section 5; the `SANDBOX_ORIGINAL_SYMBOL` stash preserves
  // the unwrapped value for transcript / `/bash-history` consumers.
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return undefined;
    state.sessionCtx = ctx;
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

    // All channels reserve the same config/init/wrap operation. Merely
    // awaiting reconfigure here would let a sibling cwd replace it.
    const safe = stripMarkerFromUserInput(original);
    const result = await slotFn(safe, { hasUI: ctx.hasUI, cwd: ctx.cwd, signal: ctx.signal });
    if (result.wrapped) {
      stashOriginalCommand(event.input, original);
      stashCommandId(event.input, result.commandId);
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
    // Only commands this extension actually wrapped carry a commandId.
    // Unwrapped ones (bypass, warn fallback, dry run, sandbox off) get
    // no release and no sandbox annotation: releasing them would drop
    // ASRT's active-sandbox count under a still-running wrap (bg-bash,
    // parallel calls) and let it delete mount points that sandbox's
    // deny rules depend on.
    const commandId = readCommandId(event.input);
    if (!commandId) return undefined;
    // Per-command release: ASRT's `cleanupAfterCommand()` (decrements
    // its active-sandbox count; at zero removes the empty mount-point
    // files bwrap created for absent deny paths) plus the dangerous-file
    // stub refcount (unlinks stubs no other in-flight wrap holds).
    // Idempotent per commandId - see `wrap-ledger.ts`.
    releaseWrapHandle(state, { commandId });
    if (!state.manager || !state.initialized) return undefined;
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
    // dialog. ASRT has no filesystem ask-callback and we don't run its
    // violation monitor (the Linux one is pinned to the config at
    // initialize() time and would misreport after a session grant), so
    // direct stderr parsing is the signal on both platforms. See
    // `lib/node/pi/sandbox/fs-failures.ts`.
    // A command that exited 0 is not reported as a sandbox failure: its
    // output may merely *mention* EPERM next to a path (grep / rg over
    // docs or logs), which must not fabricate a write-allow offer.
    const parsed = evt.isError === false ? { writePaths: [], readPaths: [] } : parseFsFailures(stderr);
    // Never offer (or persist) a grant the kernel would still refuse:
    // ASRT's built-in write denies and filesystem.json deny rules win
    // over write.allow.paths on both platforms.
    const fsPolicy = state.lastResolved?.fsPolicy;
    const ungrantable = new Map<string, string>();
    for (const p of parsed.writePaths) {
      const why = fsPolicy ? explainUngrantableWrite(p, ctx.cwd, fsPolicy) : undefined;
      if (why) ungrantable.set(p, why);
    }
    const grantable = parsed.writePaths.filter((p) => !ungrantable.has(p));
    if (ungrantable.size > 0 && grantable.length === 0) {
      const tag = '⚠️  sandbox blocked this write, and it cannot be allowed from pi:';
      const hint = [...ungrantable]
        .map(([p, why]) => `${p}: ${why}`)
        .concat('', 'Write somewhere else (e.g. $TMPDIR or a project path), or ask the user to change the policy.')
        .join('\n');
      const newContent = prependBashHint(evt.content, hint, tag);
      if (newContent) {
        return {
          content: newContent as ToolResultEvent['content'],
          ...preserveStructuredContent(event),
        };
      }
    }
    if (grantable.length > 0 && ctx.hasUI) {
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
      const outcome = await ask({ paths: grantable, command });

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
          return {
            content: newContent as ToolResultEvent['content'],
            ...preserveStructuredContent(event),
          };
        }
      } else if (outcome.kind === 'deny' && outcome.feedback) {
        const tag = '⚠️  sandbox blocked this write; the user declined to widen the policy:';
        const hint = `user feedback: ${outcome.feedback}`;
        const newContent = prependBashHint(evt.content, hint, tag);
        if (newContent) {
          return {
            content: newContent as ToolResultEvent['content'],
            ...preserveStructuredContent(event),
          };
        }
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
          return {
            content: newContent as ToolResultEvent['content'],
            ...preserveStructuredContent(event),
          };
        }
      }
    }

    let annotated: string;
    try {
      // Look violations up by the per-wrap commandId: ASRT stored them
      // under that key, and the wrapped string (NO_PROXY prefix,
      // stripped marker) differs from the transcript command.
      annotated = state.manager.annotateStderrWithSandboxFailures(commandId, stderr);
    } catch {
      return undefined;
    }
    const splice = annotateBashResult(annotated, stderr, evt.content);
    if (!splice) {
      return undefined;
    }

    // Best-effort: append a JSONL audit row. Network denials are
    // already logged (with host) by the violation-store feed.
    if (splice.kind !== 'net') {
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
    }

    return {
      content: splice.content as ToolResultEvent['content'],
      ...preserveStructuredContent(event),
    };
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
        lossyNotes: [
          ...resolved.lossyNotes,
          ...state.configIssues.map((i) => `runtime config: ${i}`),
          ...state.dependencyNotes.map((n) => `dependency check: ${n}`),
        ],
        recentViolations: readViolations(USER_VIOLATIONS_LOG, { limit: 10 }),
      });
      ctx.ui.notify(`${report}\n\n${networkControlStatus(state)}`, 'info');
    },
  });

  // Recently-blocked domains from the violation log, newest first, for
  // `/sandbox-allow` / `/sandbox-deny` completion. The `host` field is
  // `host:port`; strip the port so the candidate is a bare domain.
  const recentBlockedDomains = (): string[] => {
    const seen = new Set<string>();
    for (const r of readViolations(USER_VIOLATIONS_LOG, { kind: 'net', limit: 50 })) {
      const host = r.host ? hostOfHostPort(r.host) : undefined;
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
      if (args.trim()) {
        ctx.ui.notify(SANDBOX_DISABLE_USAGE, 'warning');
        return;
      }
      if (!(await changeSessionControls(state, ctx, { bypassed: true }))) return;
      ctx.ui.notify(
        '\u26a0\ufe0f  sandbox: session bypass active. New bash subprocesses run UNWRAPPED until /sandbox-enable, /sandbox-reset, /reload, or session end.',
        'warning',
      );
    },
  });

  pi.registerCommand('sandbox-enable', {
    description: 'Clear the full-session sandbox bypass for new commands',
    handler: async (args, ctx) => {
      if (isHelpArg(args) || args.trim()) {
        ctx.ui.notify(SANDBOX_ENABLE_USAGE, 'info');
        return;
      }
      if (!(await changeSessionControls(state, ctx, { bypassed: false }))) return;
      ctx.ui.notify(`sandbox: full-session bypass cleared.\n${networkControlStatus(state)}`, 'info');
    },
  });

  pi.registerCommand('sandbox-network', {
    description: 'Session-only network sandbox enable/disable/status; keeps filesystem protection',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        enable: { description: 'Enable network isolation and configured domain filtering' },
        disable: { description: 'Allow ALL reachable destinations; retain filesystem protection' },
        status: { description: 'Show effective networking, full bypass, and session override' },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_NETWORK_USAGE, 'info');
        return;
      }
      const verb = args.trim() || 'status';
      if (verb === 'status') {
        ctx.ui.notify(networkControlStatus(state), 'info');
        return;
      }
      if (verb !== 'enable' && verb !== 'disable') {
        ctx.ui.notify(SANDBOX_NETWORK_USAGE, 'warning');
        return;
      }
      const override = verb === 'enable' ? 'enabled' : 'disabled';
      if (!(await changeSessionControls(state, ctx, { networkOverride: override }))) return;
      ctx.ui.notify(networkControlStatus(state), verb === 'disable' ? 'warning' : 'info');
    },
  });

  pi.registerCommand('sandbox-reset', {
    description: 'Clear session-only grants and overrides; reload configured policy',
    handler: async (args, ctx) => {
      if (isHelpArg(args) || args.trim()) {
        ctx.ui.notify(SANDBOX_RESET_USAGE, 'info');
        return;
      }
      if (!(await changeSessionControls(state, ctx, { reset: true }))) return;
      ctx.ui.notify(
        `sandbox: session grants, network override, and full bypass cleared; config files unchanged.\n${networkControlStatus(state)}`,
        'info',
      );
    },
  });

  pi.registerCommand('sandbox-explain', {
    description: 'Explain effective path or host policy without performing the operation',
    getArgumentCompletions: (prefix) =>
      completeSubverbs(prefix, {
        path: {
          description: 'Explain read/write policy',
          args: () =>
            [...new Set([...(state.lastResolved?.fsPolicy.write.allow.paths ?? []), ...state.sessionWriteAllow])].map(
              (label) => ({ label }),
            ),
        },
        host: { description: 'Explain a host or URL', args: () => recentBlockedDomains().map((label) => ({ label })) },
      }),
    handler: async (args, ctx) => {
      if (isHelpArg(args)) {
        ctx.ui.notify(SANDBOX_EXPLAIN_USAGE, 'info');
        return;
      }
      const match = /^(path|host)\s+([\s\S]+)$/.exec(args.trim());
      if (!match) {
        ctx.ui.notify(SANDBOX_EXPLAIN_USAGE, 'info');
        return;
      }
      const kind = match[1] as 'path' | 'host';
      const resolved = resolveAll(ctx.cwd, state.platform, [...state.sessionWriteAllow], state.networkOverride);
      const layers = buildLayers(ctx.cwd);
      const persona = getActivePersona();
      const report = buildSandboxExplanation({
        target: { kind, value: match[2].trim() },
        cwd: ctx.cwd,
        filesystem: resolved.fsPolicy,
        sandbox: resolved.sandboxResult.config,
        fsLayers: layers.fsLayers,
        sandboxLayers: layers.sandboxLayers,
        sessionWriteAllowPaths: [...state.sessionWriteAllow],
        sessionAllowedDomains: [...state.sessionAllowedDomains],
        persona: persona ? { name: persona.name, resolvedWriteRoots: persona.resolvedWriteRoots } : undefined,
        mode: envTruthy(process.env.PI_SANDBOX_DRY_RUN) ? 'dry-run' : effectiveMode(state).mode,
        networkOverride: state.networkOverride,
        platform: state.platform.kind,
      });
      ctx.ui.notify(report, 'info');
    },
  });

  pi.registerCommand('sandbox-test', {
    description: 'Test native filesystem enforcement using isolated synthetic fixtures',
    handler: async (args, ctx) => {
      if (isHelpArg(args) || args.trim()) {
        ctx.ui.notify(SANDBOX_TEST_USAGE, 'info');
        return;
      }
      await runActiveSandboxOperation(async () => {
        if (state.stopping) return;
        if (state.bypassed || envTruthy(process.env.PI_SANDBOX_DRY_RUN) || planFor(state).kind !== 'wrapped') {
          ctx.ui.notify(
            'sandbox-test: unavailable while bypassed, degraded, or in dry-run mode; enable the sandbox and recheck dependencies first.',
            'warning',
          );
          return;
        }
        try {
          const resolved = await reconfigureUnlocked(state, ctx.cwd, ctx);
          if (!(await ensureManager(state, ctx.cwd, ctx)) || !state.manager) {
            ctx.ui.notify(
              `sandbox-test: FAILED to initialize native runtime (${state.lastWrapError ?? state.reason ?? 'unavailable'}); no unwrapped fallback was run.`,
              'error',
            );
            return;
          }
          const manager = state.manager;
          ensureAsrtTmpdir();
          const result = await runSandboxSelfTest({
            wrap: (command, fixture) =>
              manager.wrapWithSandbox(
                command,
                undefined,
                {
                  ...resolved.asrtConfig,
                  filesystem: {
                    ...resolved.asrtConfig.filesystem,
                    allowWrite: [...resolved.asrtConfig.filesystem.allowWrite, { path: fixture.root, literal: true }],
                    denyRead: [...resolved.asrtConfig.filesystem.denyRead, { path: fixture.readDenied, literal: true }],
                    denyWrite: [
                      ...resolved.asrtConfig.filesystem.denyWrite,
                      { path: fixture.writeDenied, literal: true },
                    ],
                  },
                },
                ctx.signal,
                { commandId: `pi-self-test-${randomUUID()}`, commandText: command },
              ),
            release: () => {
              manager.cleanupAfterCommand?.();
            },
          });
          ctx.ui.notify(
            `sandbox self-test: ${result.ok ? 'PASS' : 'FAIL'}\n${result.lines.join('\n')}`,
            result.ok ? 'info' : 'error',
          );
        } catch (e) {
          ctx.ui.notify(
            `sandbox-test: FAILED (${e instanceof Error ? e.message : String(e)}); no unwrapped fallback was run.`,
            'error',
          );
        }
      });
    },
  });
}
