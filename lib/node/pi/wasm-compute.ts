/**
 * Pure helper for the `wasm-compute` pi extension.
 *
 * Evaluates a model-supplied JavaScript snippet inside a QuickJS context
 * compiled to WebAssembly. The context starts with zero host capabilities -
 * no `fs`, `net`, `process`, `require`, or `import` - and every call is bounded
 * by a memory cap, a wall-clock deadline, and an output-size cap. Because the
 * capability set is provably empty, the tool that wraps this helper can be
 * auto-approved without a permission prompt.
 *
 * QuickJS already ships the compute-heavy stdlib (Math, Date, JSON, BigInt,
 * typed arrays, RegExp, Map/Set). A small pure-JS prelude (see {@link PRELUDE})
 * fills the gaps that are useful for compute but missing from the default
 * intrinsics: base64 (`atob` / `btoa`), UTF-8 (`TextEncoder` / `TextDecoder`),
 * and a `sha256(input)` hex digest. The prelude is plain JS running inside the
 * isolate, not a host binding, so it grants no new capabilities - `console.log`
 * remains the only function that crosses the sandbox boundary.
 *
 * This module imports only `quickjs-emscripten` (a pure WASM library) plus the
 * Node globals, so it stays unit-testable without pi's runtime.
 */

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten';

/** Resource limits enforced on every {@link runCompute} call. */
export interface ComputeBounds {
  /** Hard heap cap for the QuickJS runtime, in bytes. */
  memoryBytes: number;
  /** Maximum interpreter stack size, in bytes. */
  maxStackBytes: number;
  /** Wall-clock budget before the snippet is interrupted, in milliseconds. */
  timeoutMs: number;
  /** Cap on captured stdout, in bytes; output past this is dropped. */
  maxOutputBytes: number;
}

export const DEFAULT_BOUNDS: ComputeBounds = {
  memoryBytes: 64 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
  timeoutMs: 1000,
  maxOutputBytes: 64 * 1024,
};

export interface ComputeRequest {
  /** JavaScript source to evaluate. The last expression value is returned. */
  code: string;
  /** Optional JSON-serializable value exposed inside the sandbox as `input`. */
  input?: unknown;
  /** Per-call overrides layered on top of {@link DEFAULT_BOUNDS}. */
  bounds?: Partial<ComputeBounds>;
}

export interface ComputeResult {
  /** True when the snippet ran to completion without throwing. */
  ok: boolean;
  /** The dumped value of the snippet's final expression (undefined on error). */
  value: unknown;
  /** Captured `console.log` output, newline-joined. */
  stdout: string;
  /** Formatted error string when `ok` is false. */
  error?: string;
  /** True when the snippet was killed by the wall-clock deadline. */
  timedOut: boolean;
  /** True when stdout hit `maxOutputBytes` and was truncated. */
  truncated: boolean;
}

interface StdoutSink {
  push: (chunk: string) => void;
  text: () => string;
  truncated: () => boolean;
}

/**
 * Pure-JS polyfills evaluated inside the isolate before the user snippet.
 * Adds base64 (`atob` / `btoa`) and UTF-8 (`TextEncoder` / `TextDecoder`),
 * which are useful for compute but absent from QuickJS's default intrinsics.
 * This is ordinary JS running in the sandbox - it adds no host bindings.
 */
const PRELUDE = `(() => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function btoa(data) {
    const str = String(data);
    let out = '';
    for (let i = 0; i < str.length; i += 3) {
      const c0 = str.charCodeAt(i);
      const c1 = str.charCodeAt(i + 1);
      const c2 = str.charCodeAt(i + 2);
      if (c0 > 0xff || c1 > 0xff || c2 > 0xff) {
        throw new Error('btoa: string contains characters outside the Latin1 range');
      }
      const triplet = (c0 << 16) | ((isNaN(c1) ? 0 : c1) << 8) | (isNaN(c2) ? 0 : c2);
      out += B64[(triplet >> 18) & 0x3f] + B64[(triplet >> 12) & 0x3f];
      out += i + 1 < str.length ? B64[(triplet >> 6) & 0x3f] : '=';
      out += i + 2 < str.length ? B64[triplet & 0x3f] : '=';
    }
    return out;
  }

  function atob(data) {
    let str = String(data).replace(/[ \\t\\r\\n\\f]/g, '');
    if (str.length % 4 === 1) {
      throw new Error('atob: invalid base64 length');
    }
    str = str.replace(/=+$/, '');
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < str.length; i++) {
      const idx = B64.indexOf(str[i]);
      if (idx === -1) {
        throw new Error('atob: invalid base64 character');
      }
      buffer = (buffer << 6) | idx;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buffer >> bits) & 0xff);
      }
    }
    return out;
  }

  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      const str = String(input);
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            i++;
          }
        }
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
          bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      }
      return new Uint8Array(bytes);
    }
  }

  class TextDecoder {
    constructor(label = 'utf-8') {
      this.encoding = String(label).toLowerCase();
    }
    decode(input) {
      if (input === undefined) return '';
      const bytes = input instanceof Uint8Array
        ? input
        : (input && input.buffer ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input));
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i++];
        let code;
        if (b0 < 0x80) {
          code = b0;
        } else if ((b0 & 0xe0) === 0xc0) {
          code = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
        } else if ((b0 & 0xf0) === 0xe0) {
          code = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        } else {
          code = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        }
        if (code > 0xffff) {
          code -= 0x10000;
          out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
        } else {
          out += String.fromCharCode(code);
        }
      }
      return out;
    }
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256(input) {
    let bytes;
    if (typeof input === 'string') {
      bytes = Array.from(new TextEncoder().encode(input));
    } else if (input instanceof Uint8Array) {
      bytes = Array.from(input);
    } else if (Array.isArray(input)) {
      bytes = input.slice();
    } else {
      throw new Error('sha256: expected a string, Uint8Array, or array of bytes');
    }

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) {
      bytes.push(0);
    }
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    const w = new Array(64);
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) | 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }

      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }

    const toHex = (x) => (x >>> 0).toString(16).padStart(8, '0');
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(toHex).join('');
  }

  globalThis.btoa = btoa;
  globalThis.atob = atob;
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
  globalThis.sha256 = sha256;
})();`;

let modulePromise: Promise<QuickJSWASMModule> | undefined;

function loadModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= getQuickJS();
  return modulePromise;
}

function createStdoutSink(maxBytes: number): StdoutSink {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let bytes = 0;
  let didTruncate = false;
  return {
    push(chunk: string): void {
      if (didTruncate) {
        return;
      }
      const size = encoder.encode(chunk).length;
      if (bytes + size > maxBytes) {
        didTruncate = true;
        const remaining = maxBytes - bytes;
        if (remaining > 0) {
          chunks.push(chunk.slice(0, remaining));
        }
        return;
      }
      bytes += size;
      chunks.push(chunk);
    },
    text(): string {
      return chunks.join('');
    },
    truncated(): boolean {
      return didTruncate;
    },
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'undefined';
  }
  try {
    const json = JSON.stringify(value);
    return json ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

function dumpString(context: QuickJSContext, handle: QuickJSHandle): string {
  const value = context.dump(handle) as unknown;
  return typeof value === 'string' ? value : '';
}

function formatError(context: QuickJSContext, handle: QuickJSHandle): string {
  const nameHandle = context.getProp(handle, 'name');
  const messageHandle = context.getProp(handle, 'message');
  const name = dumpString(context, nameHandle);
  const message = dumpString(context, messageHandle);
  nameHandle.dispose();
  messageHandle.dispose();
  if (name || message) {
    return message ? `${name || 'Error'}: ${message}` : name;
  }
  return formatValue(context.dump(handle) as unknown);
}

function installConsole(context: QuickJSContext, sink: StdoutSink): void {
  const logFn = context.newFunction('log', (...args: QuickJSHandle[]): void => {
    const line = args.map((handle) => formatValue(context.dump(handle) as unknown)).join(' ');
    sink.push(`${line}\n`);
  });
  const consoleObj = context.newObject();
  context.setProp(consoleObj, 'log', logFn);
  context.setProp(context.global, 'console', consoleObj);
  consoleObj.dispose();
  logFn.dispose();
}

function installPrelude(context: QuickJSContext): string | undefined {
  const result = context.evalCode(PRELUDE);
  if (result.error) {
    const message = formatError(context, result.error);
    result.error.dispose();
    return message;
  }
  result.value.dispose();
  return undefined;
}

function defineInput(context: QuickJSContext, input: unknown): string | undefined {
  let json: string;
  try {
    json = JSON.stringify(input ?? null);
  } catch {
    return 'input is not JSON-serializable';
  }
  // Double-encode: JSON.stringify(json) turns the JSON text into a safely
  // escaped JS string literal, which JSON.parse then re-hydrates inside the
  // sandbox. This avoids any code injection from the input value.
  const setup = context.evalCode(`globalThis.input = JSON.parse(${JSON.stringify(json)});`);
  if (setup.error) {
    const message = formatError(context, setup.error);
    setup.error.dispose();
    return message;
  }
  setup.value.dispose();
  return undefined;
}

export async function runCompute(request: ComputeRequest): Promise<ComputeResult> {
  const bounds: ComputeBounds = { ...DEFAULT_BOUNDS, ...request.bounds };
  const quickjs = await loadModule();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(bounds.memoryBytes);
  runtime.setMaxStackSize(bounds.maxStackBytes);

  const context = runtime.newContext();
  const sink = createStdoutSink(bounds.maxOutputBytes);
  installConsole(context, sink);

  try {
    const preludeError = installPrelude(context);
    if (preludeError !== undefined) {
      return {
        ok: false,
        value: undefined,
        stdout: sink.text(),
        error: `prelude failed: ${preludeError}`,
        timedOut: false,
        truncated: sink.truncated(),
      };
    }

    const inputError = defineInput(context, request.input);
    if (inputError !== undefined) {
      return {
        ok: false,
        value: undefined,
        stdout: sink.text(),
        error: inputError,
        timedOut: false,
        truncated: sink.truncated(),
      };
    }

    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + bounds.timeoutMs));
    const result = context.evalCode(request.code);

    if (result.error) {
      const message = formatError(context, result.error);
      result.error.dispose();
      const timedOut = message.toLowerCase().includes('interrupt');
      return {
        ok: false,
        value: undefined,
        stdout: sink.text(),
        error: message,
        timedOut,
        truncated: sink.truncated(),
      };
    }

    const value = context.dump(result.value) as unknown;
    result.value.dispose();
    return { ok: true, value, stdout: sink.text(), timedOut: false, truncated: sink.truncated() };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
