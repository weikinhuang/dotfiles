// Ambient declaration for the query-string re-import trick used by
// `session-flags.spec.ts`. Vite resolves `session-flags.ts?copy=b` to a
// distinct module record so the spec can verify the `globalThis` singleton
// survives duplicate module instances (the same scenario pi's jiti-based
// extension loader creates in production).
declare module '*/lib/node/pi/session-flags.ts?copy=b' {
  export function isBashAutoEnabled(): boolean;
  export function setBashAutoEnabled(value: boolean): void;
}
