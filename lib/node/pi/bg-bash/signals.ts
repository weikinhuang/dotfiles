/**
 * POSIX signal names accepted by the bg-bash `signal` action.
 *
 * Pure - no pi imports - so both the extension shell (Type schema +
 * `sendSignalTo`) and the `/bg-bash` overlay (`ext/bg-bash-overlay.ts`)
 * can share one definition without the overlay importing the extension.
 */

export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'] as const;

export type SignalName = (typeof SIGNALS)[number];
