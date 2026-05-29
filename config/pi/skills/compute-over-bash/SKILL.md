---
name: compute-over-bash
description: >-
  Reach for the `compute` tool (sandboxed JavaScript, no approval prompt) instead of shelling out to `python3 -c`, `node
  -e`, `bc`, `expr`, or a `jq` expression whenever the task is pure calculation or data transformation - arithmetic,
  big-number math, base/radix conversion, date math, string/regex work, reshaping JSON, hashing (sha256), base64, or
  UTF-8 byte work. Prefer it because it is deterministic, needs no permission dialog, and cannot touch the filesystem or
  network. Skip it - and use bash - the moment the task needs files, network, environment, subprocesses, package
  installs, running the project's own code or tests, or anything asynchronous.
---

# Compute over bash

Models reflexively compute by shelling out (`python3 -c "print(2**64)"`, `node -e`, `bc`, `echo $((...))`). In pi, the
`compute` tool is the better default for pure computation: it runs JavaScript in a sandboxed WASM VM, returns the value
of the final expression, and - because it has no filesystem, network, or process access - never triggers a permission
prompt. Use it as your first move for calculation and data shaping; reserve bash for work that genuinely touches the
system.

## When to use `compute`

Route to `compute` when the task is self-contained computation over values you already have:

- **Arithmetic and big numbers** - exact integer math, `BigInt`, modular arithmetic, combinatorics.
- **Base / radix conversion** - hex/binary/decimal, parsing or formatting numbers.
- **Date and time math** - day/second differences, ISO formatting, "N days from X" (`Date` is available).
- **String and regex work** - parsing, reformatting, counting matches, slicing.
- **Reshaping data** - map/filter/reduce/group over an array or object; pass the data in via the `input` argument.
- **Hashing** - `sha256(string | bytes)` returns a hex digest.
- **Encoding** - `btoa` / `atob` for base64; `TextEncoder` / `TextDecoder` for UTF-8 byte work.

## When NOT to use `compute` (use bash instead)

`compute` is pure compute only. Use bash the moment the task needs anything outside the sandbox:

- Reading or writing **files**, listing directories, globbing.
- **Network** access (HTTP, DNS, sockets) - use `ai-fetch-web` or `curl`.
- **Environment** variables, **subprocesses**, or installed CLIs.
- Running the **project's own code or tests** (`npm test`, `pytest`, a build).
- Anything **asynchronous** - `compute` is synchronous only (no `await`, no dynamic `import`).

If you find yourself wanting `require('fs')`, `fetch`, or `process.env` inside `compute`, that is the signal to switch
to bash.

## How `compute` behaves

- **Returns the last expression.** `const n = 2 ** 16; n * n` returns `4294967296`. Use `console.log(...)` for
  intermediate output - it is captured alongside the value.
- **Pass data via `input`.** Large or structured inputs go in the `input` argument and appear inside the sandbox as the
  global `input` (already parsed - no `JSON.parse` needed).
- **Bounded.** Calls are capped on wall-clock time, memory, and output size; an infinite loop is killed, not hung.
- **Deterministic and prompt-free.** No approval dialog, no side effects.

## Before / after

**Before (shells out, hits the permission dialog):**

```bash
python3 -c "import hashlib; print(hashlib.sha256(b'hello').hexdigest())"
```

**After (one `compute` call, no prompt):**

```js
sha256('hello');
```

**Before:**

```bash
node -e "const xs=[3,1,2]; console.log(xs.reduce((a,b)=>a+b,0))"
```

**After** - call `compute` with `code: "input.reduce((a, b) => a + b, 0)"` and `input: [3, 1, 2]`.

## Anti-patterns

- **Shelling out to an interpreter purely to calculate.** `python3 -c`, `node -e`, `bc`, `expr`, `echo $((...))` for a
  value with no I/O is exactly what `compute` is for.
- **Reaching for `compute` to do I/O.** It has no filesystem or network; do not try to read a file or fetch a URL
  through it. Use bash / `ai-fetch-web`.
- **Re-deriving a hash or base64 by hand** when `sha256`, `btoa`, or `atob` are already available in the sandbox.
- **Asking `compute` to run the project's tests or build.** That is bash's job - `compute` cannot spawn processes.
