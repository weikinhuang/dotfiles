/**
 * Lazy-imported `@anthropic-ai/sandbox-runtime` module + structural
 * type for its `SandboxManager`.
 *
 * Pi's `sandbox.ts` extension wraps every bash subprocess through
 * ASRT's `SandboxManager.wrapWithSandbox(...)`. Two reasons the
 * loader lives in lib instead of inline in the extension:
 *
 *   1. Lazy import. `@anthropic-ai/sandbox-runtime` pulls in zod and
 *      a handful of native-y helpers; deferring the require() until
 *      the first bash call shaves ~50ms off pi's cold-start when the
 *      sandbox is disabled or no bash is run that turn.
 *   2. Single source of truth for the structural type. Keeping the
 *      structural `AsrtSandboxManager` here (type-checked under the
 *      root `tsconfig.json` alongside the extension shells) makes the
 *      contract enforceable from the lib side.
 *
 * Pure module: no pi imports, no @anthropic-ai/* type-imports.
 * Documented as the LIB face of the structural ASRT shape; when
 * ASRT's d.ts changes, update this file and any extension that
 * destructures fields off the live manager.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * Loose structural shape of ASRT's `SandboxManager` - matches the
 * `ISandboxManager` interface in
 * `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.d.ts`.
 * Typed structurally so consumers (sandbox.ts and any future channel
 * that wraps bash through ASRT) don't have to import the runtime at
 * type-level.
 */
/** ASRT's ask-callback answer (`SandboxAskCallback`, ASRT >= 0.0.80). */
export type AsrtAskAnswer = boolean | { allow: false; reason: string };

/** Structural shape of ASRT's `SandboxViolationEvent`. */
export interface AsrtViolation {
  line: string;
  command?: string;
  encodedCommand?: string;
  timestamp: Date;
}

/** Per-invocation wrap options (`WrapWithSandboxOptions`). */
export interface AsrtWrapOptions {
  /** Opaque correlation key for violations recorded while the command
   *  runs; pass the same value to `annotateStderrWithSandboxFailures`. */
  commandId?: string;
  /** The user-facing command, when it differs from the wrapped string. */
  commandText?: string;
}

export interface AsrtSandboxManager {
  initialize(
    runtimeConfig: unknown,
    sandboxAskCallback?: (params: { host: string; port: number | undefined }) => Promise<AsrtAskAnswer>,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
    options?: AsrtWrapOptions,
  ): Promise<string>;
  updateConfig(newConfig: unknown): void;
  reset(): Promise<void>;
  getSandboxViolationStore(): {
    getViolations(limit?: number): AsrtViolation[];
    subscribe?(listener: (violations: AsrtViolation[]) => void): () => void;
  };
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  /**
   * Lightweight per-command cleanup. Removes the empty mount-point
   * files bwrap created on the host for non-existent deny paths AND
   * decrements ASRT's `activeSandboxCount`. Documented as safe to
   * call on any platform (no-op on macOS). MUST be called exactly once
   * per successful `wrapWithSandbox` (see `wrap-ledger.ts`): skipping
   * it leaks mount points; calling it for an unwrapped command can drop
   * the count to zero while another sandbox still relies on its mounts.
   */
  cleanupAfterCommand?(): void;
  /** Dependency probe (ASRT >= 0.0.80 also warns when the package itself
   *  is installed where a sandboxed command can write it). */
  checkDependencies?(): { errors: string[]; warnings: string[] };
  /** Present (`true`) on ASRT >= 0.0.80, where the ask callback may
   *  resolve to `{ allow: false, reason }`. Older releases read ANY
   *  truthy answer as an allow, so check this before returning one. */
  readonly askCallbackDenyReason?: boolean;
  getProxyPort?(): number | undefined;
  getSocksProxyPort?(): number | undefined;
}

/** Structural shape of a zod schema's `safeParse` (ASRT exports zod v3
 *  schemas; we only need the issue list). */
export interface AsrtSchemaLike {
  safeParse(
    value: unknown,
  ):
    | { success: true }
    | { success: false; error: { issues: { path: (string | number)[]; message: string; code?: string }[] } };
}

/** Top-level shape of the lazily-imported ASRT module. */
export interface AsrtModule {
  SandboxManager: AsrtSandboxManager;
  /** Full runtime-config schema. Optional so test stubs can omit it. */
  SandboxRuntimeConfigSchema?: AsrtSchemaLike;
}

/**
 * Validate a translated runtime config against ASRT's own schema. The
 * library entry points (`initialize` / `updateConfig`) do NOT validate -
 * only ASRT's CLI does - so an invalid domain pattern (`https://x.com`,
 * a bare `::1`) would otherwise just silently match nothing.
 *
 * Returns human-readable `path: message` issues. Missing
 * `network.allowedDomains` / `network.deniedDomains` are ignored: the
 * translator omits them on purpose under `network.unrestricted` (that
 * is how ASRT is told not to isolate the network).
 */
export function validateRuntimeConfig(schema: AsrtSchemaLike | undefined, config: unknown): string[] {
  if (!schema) return [];
  let result: ReturnType<AsrtSchemaLike['safeParse']>;
  try {
    result = schema.safeParse(config);
  } catch (e) {
    return [`schema validation threw: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (result.success) return [];
  const out: string[] = [];
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    if (issue.code === 'invalid_type' && (path === 'network.allowedDomains' || path === 'network.deniedDomains')) {
      continue;
    }
    out.push(`${path || '<root>'}: ${issue.message}`);
  }
  return out;
}

/**
 * Absolute, symlink-resolved directory of the installed
 * `@anthropic-ai/sandbox-runtime` package, or `undefined` when it can't
 * be resolved. Used to put the sandbox's own code (and its Linux seccomp
 * helper, executed on every wrap) on the kernel write-deny list.
 */
export function resolveAsrtPackageRoot(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return realpathSync(dirname(require.resolve('@anthropic-ai/sandbox-runtime/package.json')));
  } catch {
    return undefined;
  }
}

let asrtCache: AsrtModule | null = null;

/**
 * Dynamically-`import('@anthropic-ai/sandbox-runtime')` and cache the
 * result. A missing dep degrades gracefully (the dynamic import will
 * throw and the caller folds the failure into its degraded-fallback
 * notify). Test seams: pass {@link setAsrtModuleForTesting} to inject
 * a mock manager when exercising the wrap pipeline under vitest.
 */
export async function loadAsrtModule(): Promise<AsrtModule> {
  if (asrtCache) return asrtCache;
  asrtCache = await import('@anthropic-ai/sandbox-runtime');
  return asrtCache;
}

/**
 * Test-only seam: replace the module-level cache with a stub. Call
 * with `null` from an `afterEach` to reset back to the real loader.
 * Production callers should never reach for this.
 */
export function setAsrtModuleForTesting(stub: AsrtModule | null): void {
  asrtCache = stub;
}
