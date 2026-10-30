/** Policy explanation only: no runtime, DNS, UI, or transport probes. */
import { isIP } from 'node:net';

import { classifyFilesystemAccess, classifyRead, classifyWrite, isUnderPath } from '../filesystem-policy/classify.ts';
import { type FilesystemPolicyLayer, loadFilesystemPolicy } from '../filesystem-policy/load.ts';
import { type FilesystemPolicy, type FilesystemRules, emptyPolicy } from '../filesystem-policy/schema.ts';
import { type SandboxConfigLayer, loadSandboxConfig } from './config-load.ts';
import { type SandboxConfig } from './config-schema.ts';
import { loopbackAllowEntries } from './localhost-proxy.ts';

export interface SandboxExplanationInput {
  target: { kind: 'path'; value: string } | { kind: 'host'; value: string };
  cwd: string;
  /** Effective policy; layers are evidence, not a replacement for this snapshot. */
  filesystem: FilesystemPolicy;
  sandbox: SandboxConfig;
  fsLayers?: FilesystemPolicyLayer[];
  sandboxLayers?: SandboxConfigLayer[];
  sessionWriteAllowPaths?: readonly string[];
  sessionAllowedDomains?: readonly string[];
  persona?: { name: string; resolvedWriteRoots: readonly string[] };
  mode?: string;
  networkOverride?: 'enabled' | 'disabled';
  platform?: 'linux' | 'darwin' | 'unsupported';
}

type RuleScope = 'read.deny' | 'read.allow' | 'write.deny' | 'write.allow';
type RuleField = keyof FilesystemRules;

function rulesAt(policy: FilesystemPolicy, scope: RuleScope): FilesystemRules {
  switch (scope) {
    case 'read.deny':
      return policy.read.deny;
    case 'read.allow':
      return policy.read.allow;
    case 'write.deny':
      return policy.write.deny;
    case 'write.allow':
      return policy.write.allow;
  }
}

function samePolicy(a: FilesystemPolicy, b: FilesystemPolicy): boolean {
  return (['read.deny', 'read.allow', 'write.deny', 'write.allow'] as const).every((scope) =>
    (['paths', 'basenames', 'segments'] as const).every(
      (field) => JSON.stringify(rulesAt(a, scope)[field]) === JSON.stringify(rulesAt(b, scope)[field]),
    ),
  );
}

function pathExplanation(input: SandboxExplanationInput): string[] {
  const { filesystem: policy, cwd } = input;
  const read = classifyFilesystemAccess({ operation: 'read', inputPath: input.target.value, cwd, policy });
  const write = classifyFilesystemAccess({
    operation: 'write',
    inputPath: input.target.value,
    cwd,
    policy,
    sessionAllowPaths: new Set(input.sessionWriteAllowPaths),
    personaWriteRoots: input.persona?.resolvedWriteRoots,
  });
  const absolute = read.absolutePath;
  const sources = [
    { source: 'defaults', policy: loadFilesystemPolicy([]).policy },
    ...(input.fsLayers ?? []).map((layer) => ({
      source: layer.source,
      policy: loadFilesystemPolicy([layer], { includeDefaults: false }).policy,
    })),
    ...(input.persona
      ? [
          {
            source: `persona ${input.persona.name}`,
            policy: loadFilesystemPolicy([], {
              includeDefaults: false,
              personaOverlay: { source: input.persona.name, paths: input.persona.resolvedWriteRoots },
            }).policy,
          },
        ]
      : []),
    {
      source: 'session',
      policy: loadFilesystemPolicy([], {
        includeDefaults: false,
        sessionWriteAllowPaths: input.sessionWriteAllowPaths,
      }).policy,
    },
  ];
  const replay = loadFilesystemPolicy(input.fsLayers ?? [], {
    personaOverlay: input.persona ? { source: input.persona.name, paths: input.persona.resolvedWriteRoots } : undefined,
    sessionWriteAllowPaths: input.sessionWriteAllowPaths,
  }).policy;
  const exact =
    input.fsLayers !== undefined &&
    (samePolicy(replay, policy) || samePolicy(loadFilesystemPolicy(input.fsLayers).policy, policy));
  const provenance = (scope: RuleScope, field: RuleField, rule: string): string => {
    const names = sources.filter((s) => rulesAt(s.policy, scope)[field].includes(rule)).map((s) => s.source);
    if (!names.length) return 'source unavailable in supplied layers';
    return exact
      ? `source: ${names.join(', ')}`
      : `source not exact; matching supplied contributions: ${names.join(', ')}`;
  };
  // Probe each rule through the canonical read matcher, even for allow sets.
  // This preserves its path/glob/segment semantics without a second matcher.
  const matches = (scope: RuleScope, fields: readonly RuleField[]): string[] => {
    const found: string[] = [];
    for (const field of fields) {
      for (const rule of rulesAt(policy, scope)[field]) {
        const probe = emptyPolicy();
        probe.read.deny[field] = [rule];
        const match = classifyRead(absolute, cwd, probe);
        if (match) found.push(`${scope}.${field}: ${match.detail} (${provenance(scope, field, rule)})`);
      }
    }
    return found;
  };
  const denyRead = matches('read.deny', ['paths', 'basenames', 'segments']);
  const allowRead = matches('read.allow', ['paths', 'basenames', 'segments']);
  const denyWrite = matches('write.deny', ['paths', 'basenames', 'segments']);
  const allowWrite = matches('write.allow', ['basenames', 'segments']);
  const outer = matches('write.allow', ['paths']);
  const lines = [`Path: ${absolute}`];
  if (!exact)
    lines.push(
      `Configuration evidence (not exact): ${sources.map((s) => s.source).join(', ')}; supplied effective policy is authoritative.`,
    );
  lines.push(read.kind === 'allow' ? 'Read: allowed by policy' : `Read: approval required - ${read.match.detail}`);
  lines.push(`Read deny matches: ${denyRead.join('; ') || '(none)'}`);
  lines.push(
    `Read allow-back: ${allowRead.join('; ') || '(none)'}${denyRead.length && allowRead.length ? ' (overrides read deny)' : ''}`,
  );
  lines.push(
    write.kind === 'allow'
      ? 'Write: allowed by policy/session/persona'
      : write.match.reason === 'security-policy'
        ? `Write: BLOCKED - mandatory ${write.match.detail}`
        : `Write: approval required - ${write.match.detail}`,
  );
  lines.push(`Write outer root: ${outer.join('; ') || '(none; outside configured write roots)'}`);
  lines.push(`Write deny matches: ${[...denyWrite, ...denyRead].join('; ') || '(none)'}`);
  lines.push(`Write allow-back (basenames/segments only): ${allowWrite.join('; ') || '(none)'}`);
  const sessionRoot = input.sessionWriteAllowPaths?.find((p) => isUnderPath(absolute, p));
  const personaRoot = input.persona?.resolvedWriteRoots.find((p) => isUnderPath(absolute, p));
  if (sessionRoot)
    lines.push(
      `Session write grant: ${sessionRoot}${write.kind === 'prompt' ? ' (cannot override mandatory protection)' : ' (positive vouch)'}`,
    );
  if (personaRoot)
    lines.push(
      `Persona ${input.persona?.name} write root: ${personaRoot}${write.kind === 'prompt' ? ' (cannot override mandatory protection)' : ' (positive vouch)'}`,
    );
  const baseWrite = classifyWrite(absolute, cwd, policy);
  if (baseWrite && write.kind === 'allow') lines.push(`Base write policy before positive vouch: ${baseWrite.detail}`);
  lines.push('Mandatory security-policy write protection precedes allow-back, persona, and session grants.');
  lines.push('These are filesystem gate decisions; ordinary restrictions may ask for approval, not permanent denials.');
  lines.push(
    'Kernel translation/compiled rules, runtime-package protection, races and actual OS permissions are not modeled.',
  );
  return lines;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** ASRT canonicalizeHost equivalent, limited to string/IP normalization. */
function canonicalHost(raw: string): string | undefined {
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!bare || bare.length > 255 || bare.includes('%')) return undefined;
  try {
    const parsed = new URL(`http://${isIP(bare) === 6 ? `[${bare}]` : bare}/`).hostname;
    const host = parsed.startsWith('[') ? parsed.slice(1, -1) : parsed.replace(/\.$/, '');
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/i.exec(host);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return isIP(host) || /^[a-z0-9._-]+$/i.test(host) ? host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function portNumber(raw: string): number | undefined {
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) return undefined;
  const port = Number(raw);
  return port <= 65535 ? port : undefined;
}

/** Mirrors ASRT domain-pattern.js splitDomainPatternPort, not URL parsing. */
function splitPattern(pattern: string): { host: string; port?: number } {
  if (pattern.startsWith('[')) {
    const close = pattern.indexOf(']');
    if (close === -1) return { host: pattern };
    const inner = pattern.slice(1, close).split('%')[0];
    const host = canonicalHost(inner) ?? inner;
    const rest = pattern.slice(close + 1);
    if (!rest) return { host };
    const port = portNumber(rest.startsWith(':') ? rest.slice(1) : '');
    return port === undefined ? { host: pattern } : { host, port };
  }
  const colon = pattern.lastIndexOf(':');
  if (colon === -1) return { host: pattern };
  if (pattern.indexOf(':') !== colon) {
    const host = pattern.split('%')[0];
    return { host: canonicalHost(host) ?? host };
  }
  const port = portNumber(pattern.slice(colon + 1));
  return port === undefined ? { host: pattern } : { host: pattern.slice(0, colon), port };
}

function matchesHost(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return !isIP(host) && host.endsWith(`.${pattern.slice(2).toLowerCase()}`);
  return host === pattern.toLowerCase();
}

function parseTarget(value: string): { host: string; port?: number } | undefined {
  if (!value || hasControlCharacters(value) || /\s/.test(value)) return undefined;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      const defaults: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 };
      const port = url.port ? portNumber(url.port) : defaults[url.protocol];
      const host = canonicalHost(url.hostname);
      return host && port !== undefined ? { host, port } : undefined;
    } catch {
      return undefined;
    }
  }
  // Bare IPv6 must be bracketed so a last hextet cannot be mistaken for a port.
  if (/[/@?#%\\*]/.test(value) || (!value.startsWith('[') && value.split(':').length > 2)) return undefined;
  if (value.startsWith('[') && isIP(value.slice(1, value.indexOf(']'))) !== 6) return undefined;
  const split = splitPattern(value);
  if (split.host === value && value.includes(':') && !value.endsWith(']')) return undefined;
  const host = canonicalHost(split.host);
  return host ? { host, port: split.port } : undefined;
}

function safeRule(rule: string): string {
  return rule.includes('@') || rule.includes('/') || hasControlCharacters(rule)
    ? '(invalid domain rule redacted)'
    : JSON.stringify(rule);
}

function hostExplanation(input: SandboxExplanationInput): string[] | undefined {
  const target = parseTarget(input.target.value);
  if (!target) return undefined;
  const { host, port } = target;
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const lines = [`Host: ${authority}${port === undefined ? ' (port unspecified)' : `:${port}`}`];
  const { network } = input.sandbox;
  const replay = loadSandboxConfig(input.sandboxLayers ?? []).config.network;
  const networkSnapshot = (n: SandboxConfig['network']): string =>
    JSON.stringify([n.allow, n.deny, !!n.unrestricted, !!n.allowLocalhost, n.localhostPorts ?? []]);
  const exact = input.sandboxLayers !== undefined && networkSnapshot(replay) === networkSnapshot(network);
  const layers = (input.sandboxLayers ?? []).map((layer) => ({
    source: layer.source,
    network: loadSandboxConfig([layer]).config.network,
  }));
  const sourceFor = (kind: 'allow' | 'deny', rule: string): string => {
    const names = layers.filter((l) => l.network[kind].includes(rule)).map((l) => l.source);
    if (!names.length) return 'source unavailable in supplied layers';
    return exact ? `source: ${names.join(', ')}` : `source not exact; contributing config sources: ${names.join(', ')}`;
  };
  const settingSource = (key: 'unrestricted' | 'allowLocalhost'): string => {
    const candidates = layers.filter(
      (l) =>
        l.network[key] &&
        (key !== 'allowLocalhost' ||
          JSON.stringify(l.network.localhostPorts ?? []) === JSON.stringify(network.localhostPorts ?? [])),
    );
    const source = candidates.at(-1)?.source;
    return exact && source ? `source: ${source}` : 'effective config; exact layer source not determined';
  };
  if (!exact)
    lines.push(
      `Configuration evidence (not exact): ${['defaults', ...layers.map((l) => l.source)].join(', ')}; supplied effective config is authoritative.`,
    );
  const bypass =
    input.platform === 'unsupported' ||
    ['off', 'env-disabled', 'bypassed', 'identity', 'disabled', 'dry-run'].includes(input.mode ?? '');
  const unrestricted = input.networkOverride ? input.networkOverride === 'disabled' : network.unrestricted;
  if (bypass) lines.push('Network: NOT ENFORCED by full sandbox wrapper; configured allow/deny rules are inactive.');
  else if (unrestricted)
    lines.push(
      `Network: unrestricted - allow/deny filtering NOT ENFORCED (${input.networkOverride === 'disabled' ? 'source: session network override' : `network.unrestricted; ${settingSource('unrestricted')}`}).`,
    );
  else
    lines.push(
      `Network: filtered${input.networkOverride === 'enabled' ? ' (source: session network override; overrides configured unrestricted)' : ''}`,
    );
  const rules = [
    ...network.deny.map((rule) => ({ rule, kind: 'deny', source: sourceFor('deny', rule) })),
    ...network.allow.map((rule) => ({ rule, kind: 'allow', source: sourceFor('allow', rule) })),
    ...(network.allowLocalhost
      ? loopbackAllowEntries(network.localhostPorts).map((rule) => ({
          rule,
          kind: 'allow',
          source: `network.allowLocalhost (${settingSource('allowLocalhost')})`,
        }))
      : []),
  ].map((entry) => Object.assign(entry, splitPattern(entry.rule)));
  const relevant = rules.filter((r) => matchesHost(host, r.host));
  const session = input.sessionAllowedDomains?.includes(host);
  const decision = (p: number | undefined): string => {
    const matches = relevant.filter((r) => r.port === undefined || r.port === p);
    const denied = matches.find((r) => r.kind === 'deny');
    const allowed = matches.find((r) => r.kind === 'allow');
    if (denied)
      return `DENIED by explicit network.deny ${safeRule(denied.rule)} (${denied.source}); deny wins over allows/session grants`;
    if (allowed) return `allowed by ${safeRule(allowed.rule)} (${allowed.source})`;
    if (session) return 'allowed by session host grant (source: session; all ports)';
    return 'unmatched: interactive approval may be requested; no-UI outcome uses configurable PI_SANDBOX_NETWORK_DEFAULT (allow/deny), not a permanent explicit deny';
  };
  const label = bypass || unrestricted ? 'Configured policy only (inactive)' : 'Policy';
  if (port !== undefined) lines.push(`${label}: ${decision(port)}`);
  else {
    const ports = [...new Set(relevant.flatMap((r) => (r.port === undefined ? [] : [r.port])))].sort((a, b) => a - b);
    for (const p of ports) lines.push(`${label}, port ${p}: ${decision(p)}`);
    lines.push(`${label}, ${ports.length ? 'other ports' : 'all ports'}: ${decision(undefined)}`);
  }
  if (session)
    lines.push('Session host grant present; explicit denies still take precedence when filtering is active.');
  lines.push(
    'Hostname/port policy only: DNS resolution, resolved-IP/SSRF guards, proxy routing, TLS and transport checks are not modeled; allowed does not guarantee connectivity.',
  );
  lines.push(
    'Loopback allows cover proxy-aware HTTP(S)/SOCKS clients, not arbitrary raw TCP. WSL2 raw WebSocket loopback is not fixed by a hostname allow alone.',
  );
  if (input.platform === 'linux' && input.sandbox.flags.allowLocalBinding)
    lines.push('Linux: flags.allowLocalBinding has no effect (macOS-only).');
  return lines;
}

/** Render a report without mutating config, granting access, or probing connectivity.
 * Filesystem classification deliberately inherits the canonical classifier's
 * security-policy path/symlink guard rather than approximating that protection.
 */
export function buildSandboxExplanation(input: SandboxExplanationInput): string {
  if (!input.target.value.trim() || hasControlCharacters(input.target.value))
    return `Invalid ${input.target.kind} target: provide a non-empty path or host without control characters.`;
  const lines = input.target.kind === 'path' ? pathExplanation(input) : hostExplanation(input);
  if (!lines)
    return 'Invalid host target: expected host[:port] or URL with a valid host and port (1-65535); bracket IPv6 literals. Input omitted for privacy.';
  return [
    'Sandbox explanation',
    ...(input.mode ? [`Mode: ${input.mode}`] : []),
    ...(input.platform ? [`Platform: ${input.platform}`] : []),
    ...lines,
    ...(input.target.kind === 'path' &&
    (input.platform === 'unsupported' ||
      ['off', 'env-disabled', 'bypassed', 'identity', 'disabled', 'dry-run'].includes(input.mode ?? ''))
      ? ['Full sandbox kernel wrapper is NOT ENFORCED; filesystem tool gates are separate from kernel enforcement.']
      : []),
  ].join('\n');
}
