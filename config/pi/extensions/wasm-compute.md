# `wasm-compute.ts`

Sandboxed `compute` tool: evaluate a JavaScript snippet inside a QuickJS-WASM isolate with zero host capabilities, under
hard resource bounds, and return its value - no permission prompt. It is the inverse of a security gate: a tool that
needs no gate because it cannot do anything dangerous.

## What the tool does

Registers a single `compute` tool the model calls with `params.code` (a JS snippet) and an optional `params.input` (a
JSON value exposed inside the sandbox as the global `input`). All evaluation runs through the pure helper
[`lib/node/pi/wasm-compute.ts`](../../../lib/node/pi/wasm-compute.ts) (`runCompute`), which:

1. Spins up a fresh QuickJS runtime compiled to WebAssembly, sets the memory limit + max stack + a deadline-based
   interrupt handler.
2. Installs a capped `console.log`, evaluates a small pure-JS prelude (base64, UTF-8, `sha256`), injects `input`, then
   evaluates the snippet.
3. Returns `{ ok, value, stdout, error, timedOut, truncated }`. The value of the final expression is the result.

The only function that crosses the sandbox boundary is `console.log`. There is no `fs`, `net`, `process`, `require`,
`import`, timers, or `crypto` inside the isolate - the capability set is provably empty, which is why the tool is safe
to run without an approval prompt.

## Why it exists (adoption)

Models default to `python -c` / `node -e` / `bc` in bash for computation. This tool gives them a deterministic,
prompt-free path for pure compute that is more accurate than token prediction and avoids the bash permission dialog.
Getting the model to actually use it is a separate problem from registering it; see "Steering" below.

## Available globals

QuickJS default intrinsics plus a pure-JS prelude:

- **Built in:** `Math` (full library), `Date`, `JSON`, `BigInt`, typed arrays (`Uint8Array`, `DataView`, ...), `RegExp`,
  `Map` / `Set`, `encodeURIComponent` / `decodeURIComponent`.
- **Prelude (pure JS, no host binding):** `btoa` / `atob`, `TextEncoder` / `TextDecoder` (UTF-8), and `sha256(input)`
  returning a hex digest (accepts a string, `Uint8Array`, or byte array).
- **Deliberately absent:** timers (`setTimeout`), `crypto` / `getRandomValues` / `subtle`, `Intl`, `structuredClone`,
  `performance`, and all async (no `await`, no dynamic `import`).

## Steering (preferring `compute` over bash)

Three composable levers, weakest to strongest:

1. **Tool `description` + `promptSnippet`** - state explicitly that `compute` is preferred over `python -c` / `node -e`
   / `bc` for pure calculation, and that it needs no approval. This is the model's primary cue at tool-selection time.
2. **The [`compute-over-bash`](../skills/compute-over-bash/SKILL.md) skill** - teaches the WHEN: which task shapes
   (arithmetic, hashing, date math, JSON reshaping) should route to `compute` and which should not.
3. **A detection nudge extension (not built yet)** - the robust backstop, mirroring
   [`read-reread-detector`](./read-reread-detector.md): detect a pure-compute bash one-liner (`python3 -c`, `node -e`,
   `bc`, ...) and inject a one-time, sentinel-guarded nudge to prefer `compute`. Add only if real `pi -p` runs show the
   model still preferring bash after levers 1-2.

Note the incentive gradient: `compute` wins on "no dialog" only if the equivalent bash compute is at least as
inconvenient. If `python -c` flows freely through `bash-permissions`, the model has little reason to switch.

## Result shape

- **Success:** the content text is the captured `console.log` output (if any) followed by the formatted final value;
  `(stdout truncated)` is appended when output hit the cap. `details` carries `{ ok: true, timedOut, truncated }`.
- **Error / timeout:** `isError: true`, content text is `compute error: <message>` (or `compute timed out: ...`);
  `details.error` is set and `details.timedOut` distinguishes a deadline kill from a thrown error.

## Environment variables

- `PI_WASM_COMPUTE_DISABLED=1` - skip the extension entirely.
- `PI_WASM_COMPUTE_TIMEOUT_MS=<n>` - wall-clock budget per call (default `1000`).
- `PI_WASM_COMPUTE_MEMORY_BYTES=<n>` - heap cap (default `67108864` = 64 MB).
- `PI_WASM_COMPUTE_MAX_OUTPUT_BYTES=<n>` - stdout cap (default `65536` = 64 KB).

## Hot reload

Edit [`extensions/wasm-compute.ts`](./wasm-compute.ts) or the pure helper
[`lib/node/pi/wasm-compute.ts`](../../../lib/node/pi/wasm-compute.ts) and run `/reload` in an interactive pi session to
pick up changes without restarting.
