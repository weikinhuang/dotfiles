/**
 * Pure builder for the `/sandbox` status/summary text.
 *
 * The extension shell (`config/pi/extensions/sandbox.ts`) gathers the
 * live pieces - effective mode, platform probe, wrap counters, live
 * proxy ports, resolved config sources, network + filesystem policy,
 * the Linux compiled-rule report, lossy-translation notes, and the
 * most recent violation records - and hands them here as plain data.
 * This module turns them into the exact multi-line string the command
 * notifies, so the layout is golden-testable without the pi runtime,
 * ASRT, or a live SandboxManager.
 *
 * Pure module - no pi imports. `CompiledPolicyReport` and
 * `SandboxViolationRecord` are pulled in type-only from their sibling
 * modules so the report stays structurally pinned to their shapes.
 */

import { type CompiledPolicyReport } from './linux-rules-compile.ts';
import { type SandboxViolationRecord } from './violations-log.ts';

export interface SandboxStatusReportInput {
  /** Effective statusline mode literal (`resolveSandboxMode`). */
  mode: string;
  /** Optional reason appended to the mode line. */
  reason?: string;
  platform: {
    description: string;
    kind: string;
    missingDeps: readonly string[];
    hints: readonly string[];
    apparmorBlocksUserNs: boolean;
    isInsideDocker: boolean;
  };
  wrapsAttempted: number;
  wrapsErrored: number;
  lastWrapError?: string;
  /** Present only when the live manager exposes proxy ports. A falsy
   *  `http` suppresses the proxy line, matching the extension guard. */
  proxyPorts?: { http?: number; socks?: number };
  sources: {
    userFs: string;
    userSandbox: string;
    projectFs: string;
    projectSandbox: string;
  };
  /** Active persona overlay, when one contributes write roots. */
  persona?: { name: string; resolvedWriteRoots: readonly string[] };
  network: {
    unrestricted?: boolean;
    allowLocalhost?: boolean;
    allow: readonly string[];
    deny: readonly string[];
  };
  networkDefault: 'allow' | 'deny';
  filesystem: {
    writeAllowPaths: readonly string[];
    readDenyPaths: readonly string[];
  };
  compiled?: CompiledPolicyReport;
  lossyNotes: readonly string[];
  recentViolations: readonly SandboxViolationRecord[];
}

/**
 * Render the `/sandbox` status report. Returns the full body string
 * (newline-joined) ready to hand to `ctx.ui.notify(..., 'info')`.
 */
export function buildSandboxStatusReport(input: SandboxStatusReportInput): string {
  const lines: string[] = [];

  lines.push(`Mode: ${input.mode}${input.reason ? ` (${input.reason})` : ''}`);
  lines.push(`Platform: ${input.platform.description} (${input.platform.kind})`);
  if (input.platform.missingDeps.length > 0) {
    lines.push(`Missing deps: ${input.platform.missingDeps.join(', ')}`);
    for (const h of input.platform.hints) lines.push(`  ${h}`);
  }
  if (input.platform.apparmorBlocksUserNs) {
    lines.push('AppArmor restricts unprivileged user namespaces (Ubuntu 24.04+).');
  }
  if (input.platform.isInsideDocker) {
    lines.push('Running inside a container; consider PI_SANDBOX_NESTED=1.');
  }
  lines.push('');
  lines.push(`Wraps attempted: ${input.wrapsAttempted}`);
  lines.push(`Wraps errored:   ${input.wrapsErrored}${input.lastWrapError ? ` (last: ${input.lastWrapError})` : ''}`);
  if (input.proxyPorts?.http) {
    const { http, socks } = input.proxyPorts;
    lines.push(`Proxy ports: http=${http}${socks ? ` socks=${socks}` : ''}`);
  }
  lines.push('');
  lines.push('Configuration sources:');
  lines.push(`  user fs:      ${input.sources.userFs}`);
  lines.push(`  user sandbox: ${input.sources.userSandbox}`);
  lines.push(`  project fs:   ${input.sources.projectFs}`);
  lines.push(`  project sandbox: ${input.sources.projectSandbox}`);
  if (input.persona && input.persona.resolvedWriteRoots.length > 0) {
    lines.push(`  persona overlay: ${input.persona.name} (writeRoots: ${input.persona.resolvedWriteRoots.join(', ')})`);
  }
  lines.push('');
  lines.push('Network:');
  if (input.network.unrestricted) {
    lines.push('  unrestricted: true (network isolation OFF - host network shared, allow/deny NOT enforced)');
  } else if (input.network.allowLocalhost) {
    lines.push('  allowLocalhost: true (loopback routed through the proxy; HTTP/SOCKS only, filtering stays on)');
  }
  lines.push(`  allow: ${input.network.allow.join(', ') || '(empty - deny all)'}`);
  lines.push(`  deny:  ${input.network.deny.join(', ') || '(empty)'}`);
  lines.push(`  default-on-no-UI: ${input.networkDefault}`);
  lines.push('');
  lines.push('Filesystem (write.allow.paths):');
  for (const p of input.filesystem.writeAllowPaths) lines.push(`  ${p}`);
  lines.push('Filesystem (read.deny.paths):');
  for (const p of input.filesystem.readDenyPaths) lines.push(`  ${p}`);
  if (input.compiled) {
    lines.push('');
    lines.push('Compiled Linux deny paths:');
    lines.push(`  read:  ${input.compiled.read.paths.length} paths`);
    lines.push(`  write: ${input.compiled.write.paths.length} paths`);
    if (
      input.compiled.read.inertBasenames.length +
        input.compiled.read.inertSegments.length +
        input.compiled.write.inertBasenames.length +
        input.compiled.write.inertSegments.length >
      0
    ) {
      lines.push('  inert (no on-disk match):');
      for (const b of input.compiled.read.inertBasenames) lines.push(`    read.deny.basenames ${b}`);
      for (const s of input.compiled.read.inertSegments) lines.push(`    read.deny.segments  ${s}`);
      for (const b of input.compiled.write.inertBasenames) lines.push(`    write.deny.basenames ${b}`);
      for (const s of input.compiled.write.inertSegments) lines.push(`    write.deny.segments  ${s}`);
    }
  }
  if (input.lossyNotes.length > 0) {
    lines.push('');
    lines.push('Lossy translation notes:');
    for (const n of input.lossyNotes) lines.push(`  ${n}`);
  }
  if (input.recentViolations.length > 0) {
    lines.push('');
    lines.push('Recent violations (10 most recent; /sandbox-violations for full):');
    for (const r of input.recentViolations) {
      lines.push(`  ${r.ts} ${r.kind} ${r.action}${r.path ? ` ${r.path}` : ''}${r.host ? ` ${r.host}` : ''}`);
    }
  }

  return lines.join('\n');
}
