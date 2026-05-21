/**
 * Platform / dependency detection for the sandbox extension.
 *
 * Returns a structured snapshot consumers (the `sandbox.ts` extension
 * shell + `/sandbox` slash command) render. We deliberately do NOT
 * import @anthropic-ai/sandbox-runtime here - the goal is to decide
 * whether ASRT can run BEFORE we touch ASRT, so a missing dep doesn't
 * crash the lazy import.
 *
 * Pure module - no pi imports - so it's directly unit-testable. All
 * filesystem / process / spawn lookups are dependency-injected through
 * a `PlatformProbe` so tests can replay an arbitrary host.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform as osPlatform, release as osRelease } from 'node:os';

import { shQuote } from '../util.ts';

export type SandboxPlatformKind = 'darwin' | 'linux' | 'unsupported';

export interface SandboxPlatformInfo {
  kind: SandboxPlatformKind;
  /** Human-friendly description used in startup notifications. */
  description: string;
  /** Names of binaries the runtime needs but couldn't find on $PATH. */
  missingDeps: string[];
  /** One-line per-OS install hints, in the order users should try them. */
  hints: string[];
  /** True when the process is running as the superuser. ASRT's
   *  user-namespace approach assumes non-root; sandbox.ts refuses to
   *  load when this is true unless `PI_SANDBOX_ALLOW_ROOT=1`. */
  isRoot: boolean;
  /** True when the process appears to be running inside a container
   *  (Docker, podman, k8s). Surfaces as a recommendation to enable
   *  `flags.weakerNestedSandbox`. */
  isInsideDocker: boolean;
  /** Linux-only: AppArmor's `restrict_unprivileged_userns` is `1`,
   *  meaning unprivileged user namespaces (and therefore bwrap) are
   *  blocked unless the user runs `sysctl -w
   *  kernel.apparmor_restrict_unprivileged_userns=0`. */
  apparmorBlocksUserNs: boolean;
  /** WSL major version, when running under Microsoft's WSL. `0` when
   *  not on WSL. WSL1 is unsupported (no user namespaces). */
  wslVersion: number;
}

/** Dependency-injection seam so tests can simulate any host. */
export interface PlatformProbe {
  /** `'darwin' | 'linux' | 'win32' | ...` */
  osPlatform: () => string;
  /** Effective uid; `process.getuid()` on POSIX or `null` on Windows. */
  getuid: () => number | null;
  /** Walk through `commandExists` for every dep we care about. Returns
   *  `true` when the command is on $PATH. */
  commandExists: (cmd: string) => boolean;
  /** Read /proc/$$/cgroup, /etc/os-release, kernel sysctls, etc. */
  readFile: (path: string) => string | null;
  /** Cheap fileExists for `/proc/...` probes. */
  fileExists: (path: string) => boolean;
  /** Environment variables (subset of `process.env`). */
  env: Record<string, string | undefined>;
  /** `os.release()` - used to detect WSL via the `microsoft` marker. */
  osRelease: () => string;
}

// ──────────────────────────────────────────────────────────────────────
// Default probe (real-host implementation)
// ──────────────────────────────────────────────────────────────────────

function defaultCommandExists(cmd: string): boolean {
  try {
    // Use the platform's `command -v` shim. We DELIBERATELY don't shell
    // out via `bash -lc` here because some hosts have very slow rc files.
    execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${shQuote(cmd)}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function defaultPlatformProbe(): PlatformProbe {
  return {
    osPlatform: () => osPlatform(),
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : null),
    commandExists: defaultCommandExists,
    readFile: defaultReadFile,
    fileExists: existsSync,
    env: process.env as Record<string, string | undefined>,
    osRelease: () => osRelease(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Probe implementation
// ──────────────────────────────────────────────────────────────────────

const LINUX_DEPS = ['bwrap', 'socat', 'rg'] as const;
const MACOS_DEPS = ['rg'] as const; // sandbox-exec ships with the OS

function detectWsl(probe: PlatformProbe): number {
  if (probe.osPlatform() !== 'linux') return 0;
  const release = probe.osRelease().toLowerCase();
  if (!(release.includes('microsoft') || release.includes('wsl'))) return 0;
  // WSL2 kernels include "WSL2" in the release string; older WSL1 do
  // NOT, so absence of the WSL2 marker means WSL1.
  if (release.includes('wsl2')) return 2;
  return 1;
}

function detectDocker(probe: PlatformProbe): boolean {
  if (probe.env.PI_INSIDE_DOCKER) return probe.env.PI_INSIDE_DOCKER !== '0';
  if (probe.fileExists('/.dockerenv')) return true;
  const cgroup = probe.readFile('/proc/1/cgroup');
  if (cgroup && /docker|kubepods|containerd|podman/.test(cgroup)) return true;
  return false;
}

function detectApparmorBlock(probe: PlatformProbe): boolean {
  // Path is present on Ubuntu 24.04+ when AppArmor confines unprivileged
  // user namespaces. `1` = restricted (bwrap will fail); anything else
  // (or path missing) = unrestricted enough.
  const v = probe.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
  if (v === null) return false;
  return v.trim() === '1';
}

/** Build a list of `PATH-missing` deps for the kind. */
function missingFor(kind: SandboxPlatformKind, probe: PlatformProbe): string[] {
  if (kind === 'darwin') return MACOS_DEPS.filter((d) => !probe.commandExists(d));
  if (kind === 'linux') return LINUX_DEPS.filter((d) => !probe.commandExists(d));
  return [];
}

/** Return install hints in user-actionable order. */
function hintsFor(kind: SandboxPlatformKind, missing: string[], info: { wsl: number; root: boolean }): string[] {
  const hints: string[] = [];
  if (info.wsl === 1) {
    hints.push('WSL1 has no user namespaces; sandboxing is unsupported. Upgrade to WSL2.');
    return hints;
  }
  if (info.root) {
    hints.push(
      'pi is running as root; sandbox-runtime assumes non-root. Re-run as a regular user, or set PI_SANDBOX_ALLOW_ROOT=1 to override.',
    );
  }
  if (missing.length === 0) return hints;
  if (kind === 'darwin') {
    hints.push(`Install missing deps with Homebrew:\n  brew install ${missing.join(' ')}`);
  } else if (kind === 'linux') {
    const apt = missing.map((d) => (d === 'rg' ? 'ripgrep' : d === 'bwrap' ? 'bubblewrap' : d));
    hints.push(`Install missing deps on Debian/Ubuntu:\n  sudo apt install ${apt.join(' ')}`);
    const dnf = missing.map((d) => (d === 'rg' ? 'ripgrep' : d === 'bwrap' ? 'bubblewrap' : d));
    hints.push(`Install missing deps on Fedora/RHEL:\n  sudo dnf install ${dnf.join(' ')}`);
  }
  return hints;
}

/**
 * Snapshot the current host. Cheap; safe to call on every
 * `/sandbox-recheck`. Tests pass a stub `PlatformProbe`; callers in pi
 * pass the real `defaultPlatformProbe()`.
 */
export function detectSandboxPlatform(probe: PlatformProbe = defaultPlatformProbe()): SandboxPlatformInfo {
  const raw = probe.osPlatform();
  const wsl = detectWsl(probe);

  let kind: SandboxPlatformKind;
  let description: string;
  if (raw === 'darwin') {
    kind = 'darwin';
    description = 'macOS (sandbox-exec)';
  } else if (raw === 'linux') {
    if (wsl === 1) {
      kind = 'unsupported';
      description = 'WSL1 (no user namespaces)';
    } else {
      kind = 'linux';
      description = wsl === 2 ? 'Linux / WSL2 (bubblewrap)' : 'Linux (bubblewrap)';
    }
  } else {
    kind = 'unsupported';
    description = `${raw} - unsupported`;
  }

  const uid = probe.getuid();
  const isRoot = uid === 0;
  const isInsideDocker = kind === 'linux' && detectDocker(probe);
  const apparmorBlocksUserNs = kind === 'linux' && detectApparmorBlock(probe);
  const missingDeps = missingFor(kind, probe);
  const hints = hintsFor(kind, missingDeps, { wsl, root: isRoot });

  return {
    kind,
    description,
    missingDeps,
    hints,
    isRoot,
    isInsideDocker,
    apparmorBlocksUserNs,
    wslVersion: wsl,
  };
}
