import type { SandboxConfig } from './config-schema.ts';
import type { SandboxModeName } from './plan.ts';
import type { SandboxPlatformKind } from './platform.ts';

export type NetworkSandboxOverride = 'enabled' | 'disabled';
export type SocketSandboxOverride = 'enabled' | 'disabled';

/** Session controls sit above files and env without mutating either. */
export function applyNetworkSandboxOverride(
  config: SandboxConfig,
  override: NetworkSandboxOverride | undefined,
): SandboxConfig {
  if (!override) return config;
  return { ...config, network: { ...config.network, unrestricted: override === 'disabled' } };
}

export interface NetworkControlStatus {
  mode: SandboxModeName;
  initialized: boolean;
  dryRun: boolean;
  unrestricted: boolean;
  override?: NetworkSandboxOverride;
  activeWraps: number;
}

/** Preserve domain filtering and filesystem-related flags when allowing IPC. */
export function applySocketSandboxOverride(
  config: SandboxConfig,
  override: SocketSandboxOverride | undefined,
): SandboxConfig {
  if (!override) return config;
  return { ...config, unixSockets: { ...config.unixSockets, allowAll: override === 'disabled' } };
}

export interface SocketControlStatus {
  mode: SandboxModeName;
  initialized: boolean;
  dryRun: boolean;
  platform: SandboxPlatformKind;
  allowAll: boolean;
  allow: readonly string[];
  networkUnrestricted: boolean;
  override?: SocketSandboxOverride;
  activeWraps: number;
}

export const SOCKET_PROCESS_WARNING =
  'Existing processes and open sockets keep their original access. Stop/restart background clients after changing modes; ' +
  're-enabling cannot revoke access already granted.';

export function buildSocketControlStatus(input: SocketControlStatus): string {
  const enforcement =
    input.mode !== 'wrapped'
      ? `NOT ENFORCED (${input.mode}; socket-only controls do not enable the full sandbox)`
      : input.dryRun
        ? 'NOT ENFORCED (PI_SANDBOX_DRY_RUN=1)'
        : !input.initialized
          ? 'PENDING runtime initialization'
          : input.platform === 'darwin' && input.networkUnrestricted
            ? 'NOT ENFORCED (macOS unrestricted networking also permits Unix sockets; use /sandbox-network enable)'
            : input.allowAll
              ? 'DISABLED (ALL Unix sockets permitted, subject to filesystem/OS permissions)'
              : 'ENABLED (configured Unix-socket restrictions for new wrapped processes)';
  return [
    `Unix-socket sandbox: ${enforcement}`,
    `Requested socket mode: ${input.allowAll ? 'allow all' : 'restricted'}`,
    `Socket session override: ${input.override ?? '(none; configured policy)'}`,
    `Configured socket paths: ${input.allow.join(', ') || '(none)'}${input.platform === 'linux' ? ' (ignored on Linux)' : ''}`,
    `Filesystem and network policies: unchanged (network ${input.networkUnrestricted ? 'unrestricted' : 'filtered'})`,
    `Active wrapped commands: ${input.activeWraps}`,
    'WARNING: privileged sockets such as Docker can indirectly bypass filesystem and network protections.',
    ...(input.platform === 'linux'
      ? [
          'Linux: socket access is all-or-nothing and restriction requires the runtime seccomp helper.',
          ...(input.allowAll
            ? [
                'Allowing sockets skips that helper and its filesystem violation monitoring. Nested-user-namespace ' +
                  'hardening then depends on bubblewrap support and nesting settings; write denies may be bypassable.',
              ]
            : []),
        ]
      : []),
    SOCKET_PROCESS_WARNING,
  ].join('\n');
}

export const NETWORK_PROCESS_WARNING =
  'Existing processes keep their network namespace. Stop/restart background clients after changing modes; ' +
  're-enabling cannot confine an already-running unrestricted process.';

export function buildNetworkControlStatus(input: NetworkControlStatus): string {
  const enforcement =
    input.mode !== 'wrapped'
      ? `NOT ENFORCED (${input.mode}; network-only controls do not enable the full sandbox)`
      : input.dryRun
        ? 'NOT ENFORCED (PI_SANDBOX_DRY_RUN=1)'
        : !input.initialized
          ? 'PENDING runtime initialization'
          : input.unrestricted
            ? 'DISABLED (host network shared; ALL reachable destinations permitted, allow/deny lists not enforced)'
            : 'ENABLED (network isolation and configured domain filtering)';
  const filesystem =
    input.mode === 'wrapped' && !input.dryRun
      ? input.initialized
        ? 'active for new wrapped processes'
        : 'pending runtime initialization'
      : 'not enforced by the kernel wrapper';
  return [
    `Network sandbox: ${enforcement}`,
    `Requested network mode: ${input.unrestricted ? 'unrestricted' : 'filtered'}`,
    `Session override: ${input.override ?? '(none; configured policy)'}`,
    `Filesystem sandbox: ${filesystem}`,
    `Active wrapped commands: ${input.activeWraps}`,
    NETWORK_PROCESS_WARNING,
  ].join('\n');
}
