# Tests for pi extensions

Unit tests for the pure helpers under
[`../extensions/lib/`](../extensions/lib). Pi-coupled glue (dialog options,
`tool_call` handlers, command registration) stays in the top-level extension
files; anything that can run without the pi runtime lives in `lib/` so it can
be tested here with zero ceremony.

## Running

```bash
# All tests (shell-glob form)
node --test config/pi/tests/extensions/*.test.ts

# Or from inside the tests dir (node auto-discovers *.test.ts)
cd config/pi/tests && node --test

# One file
node --test config/pi/tests/extensions/bash-permissions.test.ts
```

Node 24's native TypeScript type-stripping means no toolchain is needed —
`.ts` files load directly.

## Layout

| Path | Tests |
| --- | --- |
| [`extensions/bash-permissions.test.ts`](./extensions/bash-permissions.test.ts) | `splitCompound`, `matchesPattern`, `checkHardcodedDeny`, `maskQuotedRegions`, `commandTokens`, `twoTokenPattern` from [`../extensions/lib/bash-match.ts`](../extensions/lib/bash-match.ts) |
| [`extensions/jsonc.test.ts`](./extensions/jsonc.test.ts) | `stripJsonComments`, `parseJsonc` from [`../extensions/lib/jsonc.ts`](../extensions/lib/jsonc.ts) |
| [`extensions/protected-paths.test.ts`](./extensions/protected-paths.test.ts) | `expandTilde`, `globToRegex`, `basenameOf`, `isInsideWorkspace`, `containsNodeModules`, `classify` from [`../extensions/lib/paths.ts`](../extensions/lib/paths.ts) |

## Design

- **Lib code is pure.** `config/pi/extensions/lib/*.ts` imports only from `node:*`
  — never from `@mariozechner/pi-coding-agent`. That keeps tests hermetic and
  lets the helpers be reused across extensions without pulling in pi types.
- **Tests import from lib directly.** No mirroring, no jiti, no build step. If
  a helper's behavior changes the tests see it immediately.
- **Pi-coupled code stays in `config/pi/extensions/*.ts`.** Dialog flows,
  `pi.on('tool_call', …)` handlers, and command registration are too
  UI/runtime-bound to usefully unit-test without mocks; they're exercised
  manually by running pi.
- **Excluded from root `tsconfig.json` and the main eslint type-aware rules.**
  These files resolve `@mariozechner/*` via pi's globally-installed package,
  which the repo's TS project doesn't know about. The tests dir is covered by
  the same ESLint override as the extensions dir in [`eslint.config.mjs`](../../../eslint.config.mjs).
