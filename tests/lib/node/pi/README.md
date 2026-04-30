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

## Layout

| Spec                                                         | Tests                                                                                                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`bash-permissions.spec.ts`](./bash-permissions.spec.ts)     | `splitCompound`, `matchesPattern`, `checkHardcodedDeny`, `maskQuotedRegions`, `commandTokens`, `twoTokenPattern`, `decideSubcommand` from [`bash-match.ts`](../../../../lib/node/pi/bash-match.ts) |
| [`branch-state.spec.ts`](./branch-state.spec.ts)             | `stateFromEntryGeneric`, `findLatestStateInBranch` from [`branch-state.ts`](../../../../lib/node/pi/branch-state.ts) — the generic scaffolding shared by the todo / scratchpad reducers            |
| [`btw.spec.ts`](./btw.spec.ts)                               | `buildSideQuestionUserContent`, `parseModelSpec`, `extractAnswerText`, `formatTokens`, `formatDuration`, `formatFooter`, `BTW_USAGE` from [`btw.ts`](../../../../lib/node/pi/btw.ts)               |
| [`context-budget.spec.ts`](./context-budget.spec.ts)         | `formatTokens`, `formatBudgetLine`, `shouldAutoCompact` from [`context-budget.ts`](../../../../lib/node/pi/context-budget.ts)                                                                      |
| [`git-prompt.spec.ts`](./git-prompt.spec.ts)                 | `resolveGitPromptScript` from [`git-prompt.ts`](../../../../lib/node/pi/git-prompt.ts)                                                                                                             |
| [`git-worktree.spec.ts`](./git-worktree.spec.ts)             | `resolveWorktreeInfo` from [`git-worktree.ts`](../../../../lib/node/pi/git-worktree.ts)                                                                                                            |
| [`jsonc.spec.ts`](./jsonc.spec.ts)                           | `stripJsonComments`, `parseJsonc` from [`jsonc.ts`](../../../../lib/node/pi/jsonc.ts)                                                                                                              |
| [`output-condense.spec.ts`](./output-condense.spec.ts)       | `splitLines`, `condense`, `parseToolList` from [`output-condense.ts`](../../../../lib/node/pi/output-condense.ts)                                                                                  |
| [`protected-paths.spec.ts`](./protected-paths.spec.ts)       | path helpers and `classify` / `classifyRead` / `classifyWrite` from [`paths.ts`](../../../../lib/node/pi/paths.ts)                                                                                 |
| [`scratchpad-prompt.spec.ts`](./scratchpad-prompt.spec.ts)   | `formatWorkingNotes` from [`scratchpad-prompt.ts`](../../../../lib/node/pi/scratchpad-prompt.ts)                                                                                                   |
| [`scratchpad-reducer.spec.ts`](./scratchpad-reducer.spec.ts) | reducer + pure action handlers from [`scratchpad-reducer.ts`](../../../../lib/node/pi/scratchpad-reducer.ts)                                                                                       |
| [`session-flags.spec.ts`](./session-flags.spec.ts)           | `isBashAutoEnabled`, `setBashAutoEnabled` from [`session-flags.ts`](../../../../lib/node/pi/session-flags.ts); regression-guards the `globalThis` singleton across duplicate module records        |
| [`shared.spec.ts`](./shared.spec.ts)                         | `truncate`, `trimOrUndefined`, `byteLen`, `BYTE_ENCODER` from [`shared.ts`](../../../../lib/node/pi/shared.ts) — small utilities shared across every other lib module                              |
| [`stall-detect.spec.ts`](./stall-detect.spec.ts)             | stall classification + retry-message helpers from [`stall-detect.ts`](../../../../lib/node/pi/stall-detect.ts)                                                                                     |
| [`subdir-agents.spec.ts`](./subdir-agents.spec.ts)           | `candidateContextPaths`, `capContent`, `displayPath`, `formatBytes`, `formatContextInjection`, `isInsideCwd`, `normalizeAbs` from [`subdir-agents.ts`](../../../../lib/node/pi/subdir-agents.ts)   |
| [`todo-prompt.spec.ts`](./todo-prompt.spec.ts)               | `formatActivePlan`, `looksLikeCompletionClaim` from [`todo-prompt.ts`](../../../../lib/node/pi/todo-prompt.ts)                                                                                     |
| [`todo-reducer.spec.ts`](./todo-reducer.spec.ts)             | reducer + pure action handlers from [`todo-reducer.ts`](../../../../lib/node/pi/todo-reducer.ts)                                                                                                   |
| [`verify-detect.spec.ts`](./verify-detect.spec.ts)           | claim extraction, command matching, and steer formatting from [`verify-detect.ts`](../../../../lib/node/pi/verify-detect.ts)                                                                       |

## Design

- **Lib code is pure.** `lib/node/pi/*.ts` imports only from `node:*` — never from `@mariozechner/pi-coding-agent`. That
  keeps tests hermetic, lets the helpers be reused across extensions without pulling in pi types, and allows them to
  live under the repo's regular TypeScript project so they're type-checked on every `npm run tsc`.
- **Tests import from lib directly.** No mirroring, no jiti, no build step. If a helper's behavior changes the tests see
  it immediately.
- **Pi-coupled code stays in `config/pi/extensions/*.ts`.** Dialog flows, `pi.on('tool_call', …)` handlers, and command
  registration are too UI/runtime-bound to usefully unit-test without mocks; they're exercised manually by running pi.
- **Only extensions are excluded from root `tsconfig.json` and the main eslint type-aware rules** — they resolve
  `@mariozechner/*` via pi's globally-installed package, which the repo's TS project doesn't know about. The pure
  helpers under [`../../../../lib/node/pi/`](../../../../lib/node/pi) and these tests get the full type-aware treatment.
