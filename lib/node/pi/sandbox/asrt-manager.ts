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
 *   2. Single source of truth for the structural type. The extension
 *      shell is excluded from this repo's `tsc --noEmit`, but lib is
 *      type-checked. Keeping the structural `AsrtSandboxManager` here
 *      makes the contract enforceable from the lib side.
 *
 * Pure module: no pi imports, no @anthropic-ai/* type-imports.
 * Documented as the LIB face of the structural ASRT shape; when
 * ASRT's d.ts changes, update this file and any extension that
 * destructures fields off the live manager.
 */

/**
 * Loose structural shape of ASRT's `SandboxManager` - matches the
 * `ISandboxManager` interface in
 * `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.d.ts`.
 * Typed structurally so consumers (sandbox.ts and any future channel
 * that wraps bash through ASRT) don't have to import the runtime at
 * type-level.
 */
export interface AsrtSandboxManager {
  initialize(
    runtimeConfig: unknown,
    sandboxAskCallback?: (params: { host: string; port: number | undefined }) => Promise<boolean>,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: unknown,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  updateConfig(newConfig: unknown): void;
  reset(): Promise<void>;
  getSandboxViolationStore(): {
    getViolations(): unknown[];
  };
  annotateStderrWithSandboxFailures(command: string, stderr: string): string;
  /**
   * Lightweight per-command cleanup. Removes the empty mount-point
   * files bwrap created on the host for non-existent deny paths AND
   * decrements ASRT's `activeSandboxCount`. Documented as safe to
   * call on any platform (no-op on macOS). Pi's `tool_result` hook
   * calls this after each bash invocation - skipping it leaks
   * `/tmp/claude-empty-*` dirs and the active-count gauge over a
   * long session.
   */
  cleanupAfterCommand?(): void;
  getProxyPort?(): number | undefined;
  getSocksProxyPort?(): number | undefined;
}

/** Top-level shape of the lazily-imported ASRT module. */
export interface AsrtModule {
  SandboxManager: AsrtSandboxManager;
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
