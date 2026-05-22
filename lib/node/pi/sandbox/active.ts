/**
 * Cross-extension singleton tracking the actively-resolved sandbox
 * configuration plus a reconfigure mutex so bash hooks can avoid TOCTOU
 * between a config edit and the next spawn.
 *
 * Anchored on `globalThis` behind a `Symbol.for()` key so it's shared
 * across the multiple jiti'd module copies pi's extension loader
 * produces (same pattern as `persona/active.ts` and `bash-gate.ts`).
 *
 * State exposed:
 *
 *   {@link getActiveSandbox} - current snapshot or `undefined` before
 *     the sandbox extension has initialized.
 *   {@link publishActiveSandbox} - sandbox.ts (Phase 3) publishes a
 *     fresh snapshot here on every config (re)load. Returns `true` if
 *     the configuration HASH changed (caller should call ASRT's
 *     `SandboxManager.updateConfig()`); `false` if nothing changed
 *     (caller skips the reconfigure - hot-path sensitive on tight
 *     bash loops).
 *   {@link beginActiveReconfigure} / {@link activeReconfigure} - mutex
 *     pair for "in flight" reconfigures. Bash hooks `await
 *     activeReconfigure()` before reading the snapshot, so a
 *     `/persona switch` mid-turn cannot race with the next spawn.
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 */

import { createGlobalSlot } from '../global-slot.ts';
import { sha256Hex } from '../shared.ts';
import type { FilesystemPolicy } from '../filesystem-policy/schema.ts';

import type { SandboxConfig } from './config-schema.ts';

export type SandboxPlatformKind = 'darwin' | 'linux' | 'unsupported';

export interface ActiveSandboxSnapshot {
  /** Stable hash of the resolved policy + sandbox config. Callers use
   *  this to short-circuit no-op reconfigures. */
  readonly configHash: string;
  /** Monotonic version (incremented on every accepted publish, even
   *  when the hash is unchanged - useful for "did anyone touch the
   *  config since I last looked?" assertions in tests). */
  readonly version: number;
  /** Resolved filesystem policy from `<piAgentDir>/filesystem.json`. */
  readonly filesystem: FilesystemPolicy;
  /** Resolved sandbox-only config from `<piAgentDir>/sandbox.json`. */
  readonly sandbox: SandboxConfig;
  /** Detected platform kind so consumers can branch without re-running
   *  `os.platform()` everywhere. */
  readonly platform: SandboxPlatformKind;
  /** Wall-clock millis the snapshot was published. Surfaces in
   *  `/sandbox` output for diagnosis. */
  readonly publishedAt: number;
}

interface ActiveSandboxSlot {
  active?: ActiveSandboxSnapshot;
  /** In-flight reconfigure promise. `activeReconfigure()` awaits this
   *  if set; `beginActiveReconfigure()` installs a fresh one. */
  inflight?: Promise<void>;
}

const getSlot = createGlobalSlot<ActiveSandboxSlot>('@dotfiles/pi/sandbox/active', () => ({}));

/**
 * JSON.stringify replacer that emits object keys in sorted order so a
 * `{ a, b }` and a `{ b, a }` produce the same string. Arrays are left
 * in their original order (rule order is meaningful). */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

/**
 * Stable hash of the resolved configuration. Must be deterministic
 * across runs so two snapshots that should be considered equal compare
 * equal - the simplest safe approach is to JSON-stringify with sorted
 * object keys and sha256 the result.
 *
 * Exported so tests (and `/sandbox` rendering) can pre-compute the hash
 * and assert no-op publishes don't bump the version slot's `cas`.
 */
export function hashSandboxConfig(input: { filesystem: FilesystemPolicy; sandbox: SandboxConfig }): string {
  return sha256Hex(JSON.stringify(input, sortedReplacer));
}

export interface PublishActiveSandboxInput {
  filesystem: FilesystemPolicy;
  sandbox: SandboxConfig;
  platform: SandboxPlatformKind;
}

export interface PublishActiveSandboxResult {
  /** True when the config hash changed (or nothing was published yet)
   *  - caller should reconfigure ASRT. */
  changed: boolean;
  snapshot: ActiveSandboxSnapshot;
}

/**
 * Publish a fresh snapshot. Returns `changed: true` when the hash
 * differs from the last publish (or when this is the first publish);
 * `false` when the hash matches and the caller can skip an expensive
 * `SandboxManager.updateConfig()` call. The version still increments
 * on every accepted publish.
 *
 * Now is supplied as an argument (not `Date.now()`) so tests can pin
 * the timestamp deterministically.
 */
export function publishActiveSandbox(
  input: PublishActiveSandboxInput,
  now: number = Date.now(),
): PublishActiveSandboxResult {
  const slot = getSlot();
  const hash = hashSandboxConfig({ filesystem: input.filesystem, sandbox: input.sandbox });
  const previous = slot.active;
  const changed = !previous || previous.configHash !== hash;
  const next: ActiveSandboxSnapshot = Object.freeze({
    configHash: hash,
    version: (previous?.version ?? 0) + 1,
    filesystem: input.filesystem,
    sandbox: input.sandbox,
    platform: input.platform,
    publishedAt: now,
  });
  slot.active = next;
  return { changed, snapshot: next };
}

/** Read the most-recently published snapshot, or `undefined` if the
 *  sandbox extension has not initialized yet. */
export function getActiveSandbox(): ActiveSandboxSnapshot | undefined {
  return getSlot().active;
}

/** Clear the singleton. Intended for tests + the extension's
 *  `session_shutdown` hook. */
export function clearActiveSandbox(): void {
  const slot = getSlot();
  slot.active = undefined;
  slot.inflight = undefined;
}

/**
 * Mark a reconfigure as in-flight. Returns a `done()` callback that
 * resolves the in-flight promise; callers MUST invoke it (typically in
 * a try/finally around the actual reload). If a reconfigure is already
 * in flight, the new caller chains onto it - sandbox.ts is responsible
 * for serializing reconfigures on its side.
 *
 * Once the chain resolves we drop the slot reference (when no later
 * `beginActiveReconfigure` has already replaced it) so the chain GC's
 * after each reconfigure - otherwise `slot.inflight` retains every
 * prior promise via the `.then(() => next)` closure and grows one
 * link per reconfigure for the lifetime of the session.
 */
export function beginActiveReconfigure(): () => void {
  const slot = getSlot();
  // `Promise.withResolvers` (Node 22+) gives us the resolver without
  // the `let resolveFn: () => void = noop` gymnastics that an inline
  // `new Promise(resolve => {...})` would require to satisfy strict
  // type rules + oxlint's `no-empty-function`.
  const { promise: next, resolve: resolveFn } = Promise.withResolvers<void>();
  const previous = slot.inflight;
  const chain = previous ? previous.then(() => next) : next;
  slot.inflight = chain;
  void chain.then(() => {
    if (slot.inflight === chain) slot.inflight = undefined;
  });
  return resolveFn;
}

/**
 * Bash hooks call `await activeReconfigure()` before reading the
 * snapshot. Resolves immediately when no reconfigure is in flight.
 */
export async function activeReconfigure(): Promise<void> {
  const inflight = getSlot().inflight;
  if (!inflight) return;
  await inflight;
}

/** Test-only: peek at the slot's in-flight promise. Used by the
 *  inflight-no-leak regression to verify that the chain reference is
 *  dropped between paired `beginActiveReconfigure() / done()` calls. */
export function __getInflightForTest(): Promise<void> | undefined {
  return getSlot().inflight;
}
