/**
 * Tests for lib/node/pi/wasm-compute.ts.
 *
 * Drives the real QuickJS-WASM sandbox (no pi runtime needed) to prove the
 * capability and resource bounds hold: pure compute works, infinite loops are
 * killed by the deadline, the heap cap trips, output is truncated, and there is
 * no fs / net / process / require / import surface inside the sandbox.
 */

import { expect, test } from 'vitest';

import { type ComputeResult, runCompute } from '../../../../lib/node/pi/wasm-compute.ts';

// ──────────────────────────────────────────────────────────────────────
// Happy path: pure compute
// ──────────────────────────────────────────────────────────────────────

test('runCompute: returns the final expression value', async () => {
  const r = await runCompute({ code: '40 + 2' });

  expect(r.ok).toBe(true);
  expect(r.value).toBe(42);
  expect(r.timedOut).toBe(false);
  expect(r.error).toBeUndefined();
});

test('runCompute: returns structured (JSON-able) values', async () => {
  const r = await runCompute({ code: '({ sum: [1, 2, 3].reduce((a, b) => a + b, 0), ok: true })' });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual({ sum: 6, ok: true });
});

test('runCompute: captures console.log into stdout', async () => {
  const r = await runCompute({ code: 'console.log("hello", 1, { a: 2 }); 0' });

  expect(r.ok).toBe(true);
  expect(r.stdout).toBe('hello 1 {"a":2}\n');
});

test('runCompute: exposes the input blob as `input`', async () => {
  const r = await runCompute({
    code: 'input.values.map((n) => n * 2)',
    input: { values: [1, 2, 3] },
  });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual([2, 4, 6]);
});

test('runCompute: input defaults to null when omitted', async () => {
  const r = await runCompute({ code: 'input' });

  expect(r.ok).toBe(true);
  expect(r.value).toBe(null);
});

// ──────────────────────────────────────────────────────────────────────
// Errors and resource bounds
// ──────────────────────────────────────────────────────────────────────

test('runCompute: a thrown error is reported, not a timeout', async () => {
  const r = await runCompute({ code: 'throw new TypeError("boom")' });

  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(false);
  expect(r.error).toContain('boom');
  expect(r.error).toContain('TypeError');
});

test('runCompute: an infinite loop is killed by the wall-clock deadline', async () => {
  const r = await runCompute({ code: 'while (true) {}', bounds: { timeoutMs: 50 } });

  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(true);
});

test('runCompute: the heap cap trips on runaway allocation', async () => {
  const r = await runCompute({
    code: 'const a = []; for (;;) { a.push(new Array(10000).fill(7)); }',
    bounds: { memoryBytes: 8 * 1024 * 1024, timeoutMs: 5000 },
  });

  expect(r.ok).toBe(false);
  expect(r.error?.toLowerCase()).toContain('memory');
});

test('runCompute: stdout is truncated at the output cap', async () => {
  const r = await runCompute({
    code: 'for (let i = 0; i < 1000; i++) { console.log("x".repeat(100)); } 0',
    bounds: { maxOutputBytes: 256 },
  });

  expect(r.ok).toBe(true);
  expect(r.truncated).toBe(true);
  expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(256);
});

test('runCompute: stdout truncation stays within the byte cap for multibyte output', async () => {
  // Each euro sign is 3 UTF-8 bytes; a char-based slice would overshoot the
  // byte cap and could split a codepoint into a U+FFFD replacement char.
  const r = await runCompute({
    code: 'for (let i = 0; i < 1000; i++) { console.log("€".repeat(100)); } 0',
    bounds: { maxOutputBytes: 256 },
  });

  expect(r.ok).toBe(true);
  expect(r.truncated).toBe(true);
  expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(256);
  expect(r.stdout).not.toContain('\uFFFD');
});

// ──────────────────────────────────────────────────────────────────────
// No host capabilities
// ──────────────────────────────────────────────────────────────────────

const undefinedGlobals: string[] = [
  'require',
  'process',
  'fetch',
  'globalThis.fetch',
  'module',
  'global',
  '__dirname',
  'Deno',
  'Bun',
];

for (const expr of undefinedGlobals) {
  test(`runCompute: \`${expr}\` is not present in the sandbox`, async () => {
    // `typeof` never throws even for undeclared identifiers, so this is a
    // clean probe for "is this capability reachable at all".
    const r: ComputeResult = await runCompute({ code: `typeof (${expr})` });

    expect(r.ok).toBe(true);
    expect(r.value).toBe('undefined');
  });
}

// ──────────────────────────────────────────────────────────────────────
// Allowed pure stdlib: the full Math library, Math.random, and Date
//
// These have no escape surface (no fs / net / process), so they are
// intentionally allowed. The only trade-off is non-determinism from
// Math.random / Date, which is acceptable for a compute scratchpad.
// ──────────────────────────────────────────────────────────────────────

test('runCompute: the full Math library is available', async () => {
  const r = await runCompute({
    code: '[Math.sqrt(16), Math.max(1, 9, 4), Math.pow(2, 10), Math.floor(Math.PI * 100), Math.abs(-5)]',
  });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual([4, 9, 1024, 314, 5]);
});

test('runCompute: trig and log helpers compute correctly', async () => {
  const r = await runCompute({ code: '[Math.round(Math.sin(Math.PI / 2)), Math.round(Math.log(Math.E))]' });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual([1, 1]);
});

test('runCompute: Math.random is present and stays within [0, 1)', async () => {
  const r = await runCompute({
    code: 'const xs = Array.from({ length: 100 }, () => Math.random()); ({ allInRange: xs.every((x) => x >= 0 && x < 1), distinct: new Set(xs).size > 1 })',
  });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual({ allInRange: true, distinct: true });
});

test('runCompute: Date is available for date math', async () => {
  const r = await runCompute({
    code: '({ nowIsNumber: typeof Date.now() === "number", epoch: new Date(0).toISOString(), diffDays: (new Date("2026-01-11") - new Date("2026-01-01")) / 86400000 })',
  });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual({ nowIsNumber: true, epoch: '1970-01-01T00:00:00.000Z', diffDays: 10 });
});

// ──────────────────────────────────────────────────────────────────────
// Pure-JS prelude: base64 + UTF-8 text encoding
// ──────────────────────────────────────────────────────────────────────

test('runCompute: btoa / atob are present', async () => {
  const r = await runCompute({ code: '[typeof btoa, typeof atob, typeof TextEncoder, typeof TextDecoder]' });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual(['function', 'function', 'function', 'function']);
});

test('runCompute: btoa encodes to base64', async () => {
  const r = await runCompute({ code: 'btoa("hello")' });

  expect(r.ok).toBe(true);
  expect(r.value).toBe('aGVsbG8=');
});

test('runCompute: atob round-trips base64 back to the original', async () => {
  const r = await runCompute({ code: 'atob(btoa("the quick brown fox"))' });

  expect(r.ok).toBe(true);
  expect(r.value).toBe('the quick brown fox');
});

test('runCompute: btoa rejects characters outside Latin1', async () => {
  const r = await runCompute({ code: 'btoa("\\u{1f600}")' });

  expect(r.ok).toBe(false);
  expect(r.error?.toLowerCase()).toContain('latin1');
});

test('runCompute: TextEncoder produces UTF-8 bytes', async () => {
  const r = await runCompute({ code: 'Array.from(new TextEncoder().encode("é"))' });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual([0xc3, 0xa9]);
});

test('runCompute: TextEncoder encodes an astral codepoint as 4 bytes', async () => {
  const r = await runCompute({ code: 'Array.from(new TextEncoder().encode("\\u{1f600}"))' });

  expect(r.ok).toBe(true);
  expect(r.value).toEqual([0xf0, 0x9f, 0x98, 0x80]);
});

test('runCompute: TextEncoder / TextDecoder round-trip multibyte text', async () => {
  const r = await runCompute({
    code: 'const t = "héllo · 世界 · \\u{1f600}"; new TextDecoder().decode(new TextEncoder().encode(t)) === t',
  });

  expect(r.ok).toBe(true);
  expect(r.value).toBe(true);
});

test('runCompute: base64 + UTF-8 compose for byte-accurate encoding', async () => {
  const r = await runCompute({
    code: 'btoa(String.fromCharCode(...new TextEncoder().encode("café")))',
  });

  expect(r.ok).toBe(true);
  // "café" => bytes 63 61 66 c3 a9 => base64
  expect(r.value).toBe('Y2Fmw6k=');
});

// ──────────────────────────────────────────────────────────────────────
// sha256 (pure-JS, from the prelude) - checked against known test vectors
// ──────────────────────────────────────────────────────────────────────

test('runCompute: sha256 is present', async () => {
  const r = await runCompute({ code: 'typeof sha256' });

  expect(r.ok).toBe(true);
  expect(r.value).toBe('function');
});

test('runCompute: sha256 of the empty string matches the known vector', async () => {
  const r = await runCompute({ code: 'sha256("")' });

  expect(r.ok).toBe(true);
  expect(r.value).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('runCompute: sha256("abc") matches the FIPS-180 vector', async () => {
  const r = await runCompute({ code: 'sha256("abc")' });

  expect(r.ok).toBe(true);
  expect(r.value).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('runCompute: sha256 handles a multi-block (>55 byte) message', async () => {
  const r = await runCompute({
    code: 'sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")',
  });

  expect(r.ok).toBe(true);
  expect(r.value).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('runCompute: sha256 accepts UTF-8 bytes and agrees with the string form', async () => {
  const r = await runCompute({
    code: 'sha256(new TextEncoder().encode("café")) === sha256("café")',
  });

  expect(r.ok).toBe(true);
  expect(r.value).toBe(true);
});

test('runCompute: sha256 rejects unsupported input types', async () => {
  const r = await runCompute({ code: 'sha256(42)' });

  expect(r.ok).toBe(false);
  expect(r.error).toContain('sha256');
});

test('runCompute: there is no module loader (a static import is rejected)', async () => {
  // QuickJS evaluates plain scripts, not modules, so an `import` statement is
  // a syntax error - there is no path to pull in `node:fs` or any host module.
  const r = await runCompute({ code: 'import * as fs from "node:fs"; fs' });

  expect(r.ok).toBe(false);
});
