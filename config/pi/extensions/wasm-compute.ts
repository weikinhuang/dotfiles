/**
 * `compute` tool for pi.
 *
 * Registers a single `compute` tool that evaluates a JavaScript snippet inside
 * a QuickJS-WASM sandbox with zero host capabilities (no fs / net / process /
 * require / import) under hard memory, wall-clock, and output bounds. Because
 * the capability set is provably empty, the tool is safe to run without a
 * permission prompt - it is the inverse of a security gate.
 *
 * All evaluation logic lives in the pure helper
 * `lib/node/pi/wasm-compute.ts` (unit-tested under
 * `tests/lib/node/pi/wasm-compute.spec.ts`); this shell is just the pi glue:
 * tool registration, env-var bounds, and result formatting.
 *
 * Adoption: the wording here (description + promptSnippet) plus the companion
 * `compute-over-bash` skill steer the model to prefer `compute` over shelling
 * out to `python -c` / `node -e` / `bc` for pure computation.
 *
 * Environment:
 *   PI_WASM_COMPUTE_DISABLED=1            skip the extension entirely
 *   PI_WASM_COMPUTE_TIMEOUT_MS=<n>        wall-clock budget (default 1000)
 *   PI_WASM_COMPUTE_MEMORY_BYTES=<n>      heap cap (default 67108864 = 64 MB)
 *   PI_WASM_COMPUTE_MAX_OUTPUT_BYTES=<n>  stdout cap (default 65536 = 64 KB)
 */

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { envTruthy, parsePositiveInt } from '../../../lib/node/pi/parse-env.ts';
import { type ComputeBounds, DEFAULT_BOUNDS, runCompute } from '../../../lib/node/pi/wasm-compute.ts';

const ComputeParams = Type.Object({
  code: Type.String({
    description:
      'JavaScript to evaluate; the value of the final expression is returned (use console.log for intermediate output). Available: Math, Date, JSON, BigInt, typed arrays, RegExp, Map/Set, btoa/atob, TextEncoder/TextDecoder, sha256(input). Example: "const n = 2 ** 16; n * n".',
  }),
  input: Type.Optional(
    Type.Any({
      description: 'Optional JSON-serializable value exposed inside the sandbox as the global `input`.',
    }),
  ),
});

interface ComputeToolDetails {
  ok: boolean;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

export default function wasmComputeExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_WASM_COMPUTE_DISABLED)) return;

  const bounds: ComputeBounds = {
    ...DEFAULT_BOUNDS,
    timeoutMs: parsePositiveInt(process.env.PI_WASM_COMPUTE_TIMEOUT_MS, DEFAULT_BOUNDS.timeoutMs),
    memoryBytes: parsePositiveInt(process.env.PI_WASM_COMPUTE_MEMORY_BYTES, DEFAULT_BOUNDS.memoryBytes),
    maxOutputBytes: parsePositiveInt(process.env.PI_WASM_COMPUTE_MAX_OUTPUT_BYTES, DEFAULT_BOUNDS.maxOutputBytes),
  };

  pi.registerTool({
    name: 'compute',
    label: 'Compute',
    description:
      'Evaluate a JavaScript snippet in a sandboxed VM and return its value. Use this for ANY pure calculation or data transform: arithmetic, big-number (BigInt) math, base/radix conversion, date math, string/regex work, reshaping JSON, hashing (sha256), base64 (btoa/atob), and UTF-8 byte work. Prefer this over running `python -c`, `node -e`, `bc`, or `jq` in bash - it is sandboxed (no filesystem, network, or environment access), needs no approval, and is deterministic. The value of the final expression is returned; use console.log(...) for intermediate output. Synchronous only: no await, no imports, no fs/net.',
    promptSnippet:
      'For any pure calculation, data transform, or hashing, call `compute` (sandboxed JS, no approval) instead of shelling out to python/node/bc.',
    promptGuidelines: [
      'Reach for `compute` whenever you would otherwise run `python3 -c`, `node -e`, `bc`, `expr`, or a `jq` expression purely to calculate or reshape data.',
    ],
    parameters: ComputeParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await runCompute({ code: params.code, input: params.input, bounds });

      const details: ComputeToolDetails = {
        ok: result.ok,
        timedOut: result.timedOut,
        truncated: result.truncated,
        error: result.error,
      };

      if (!result.ok) {
        const prefix = result.timedOut ? 'compute timed out' : 'compute error';
        const text = result.stdout ? `${result.stdout}\n${prefix}: ${result.error}` : `${prefix}: ${result.error}`;
        return { content: [{ type: 'text', text }], details, isError: true };
      }

      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout.replace(/\n$/, ''));
      parts.push(formatValue(result.value));
      if (result.truncated) parts.push('(stdout truncated)');
      return { content: [{ type: 'text', text: parts.join('\n') }], details };
    },

    renderCall(args, theme, _context) {
      const code = String(args.code ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const preview = code.length > 60 ? `${code.slice(0, 60)}…` : code;
      const head = theme.fg('toolTitle', theme.bold('compute '));
      return new Text(`${head}${theme.fg('dim', preview)}`, 0, 0);
    },

    renderResult(result, _opts, theme, _context) {
      const details = (result.details ?? {}) as Partial<ComputeToolDetails>;
      if (details.error) {
        const label = details.timedOut ? 'timed out' : 'error';
        return new Text(theme.fg('error', `✗ ${label}: ${details.error}`), 0, 0);
      }
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      const flat = text.replace(/\n+/g, ' ');
      const preview = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
      return new Text(theme.fg('success', `✓ ${preview}`), 0, 0);
    },
  });
}
