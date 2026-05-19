# Tests for pi extensions

Vitest unit tests for the pure helpers under [`../../../../lib/node/pi/`](../../../../lib/node/pi). Pi-coupled glue
(dialog options, `tool_call` handlers, command registration) stays in the top-level extension files under
[`../../../../config/pi/extensions/`](../../../../config/pi/extensions); anything that can run without the pi runtime
lives under `lib/node/pi/` so it can be tested here with zero ceremony and type-checked by the root `tsconfig.json`.

## Running

```bash
# All tests
npm test

# One file
npx vitest run tests/lib/node/pi/bash-permissions.spec.ts

# Watch mode for a single file
npx vitest tests/lib/node/pi/bash-permissions.spec.ts
```

## Design

- **Lib code is pure.** `lib/node/pi/*.ts` imports only from `node:*` - never from `@earendil-works/pi-coding-agent`.
  That keeps tests hermetic, lets the helpers be reused across extensions without pulling in pi types, and allows them
  to live under the repo's regular TypeScript project so they're type-checked on every `npm run tsc`.
- **Tests import from lib directly.** No mirroring, no jiti, no build step. If a helper's behavior changes the tests see
  it immediately.
- **Pi-coupled code stays in `config/pi/extensions/*.ts`.** Dialog flows, `pi.on('tool_call', …)` handlers, and command
  registration are too UI/runtime-bound to usefully unit-test without mocks; they're exercised manually by running pi.
- **Exception - extension command-surface specs.** Deep-research / autoresearch ship with
  [`tests/config/pi/extensions/*.spec.ts`](../../../../tests/config/pi/extensions) spec files that mirror their
  extension shells. Those specs still drive only pure helpers (no pi-runtime imports); the path lives under
  `tests/config/pi/extensions/` to document the extension command surface the helper backs, as called out in the
  per-phase handoff prompts in `plans/pi-deep-research.md` / `plans/pi-autoresearch.md`.
- **Only extensions are excluded from root `tsconfig.json` and the main oxlint type-aware rules** - they resolve
  `@earendil-works/*` via pi's globally-installed package, which the repo's TS project doesn't know about. The pure
  helpers under [`../../../../lib/node/pi/`](../../../../lib/node/pi) and these tests get the full type-aware treatment.
