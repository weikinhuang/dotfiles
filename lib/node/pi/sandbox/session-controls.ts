import type { SandboxConfig } from './config-schema.ts';
import type { SandboxModeName } from './plan.ts';

export type NetworkSandboxOverride = 'enabled' | 'disabled';

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
