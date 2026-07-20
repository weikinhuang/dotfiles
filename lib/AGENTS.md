# Lib

Pure TypeScript helpers shared across pi extensions, the Claude / Codex / opencode / pi session-usage CLIs, and the
clipboard-server. Nothing here imports the pi runtime or any agent-harness SDK - so every module is unit-testable with
vitest and type-checked by the root `tsconfig.json`. The one exception is [`node/pi/ext/`](./node/pi/ext/) (shared
pi-importing extension helpers); that pi-import policy lives in [`node/pi/AGENTS.md`](./node/pi/AGENTS.md).

See root [AGENTS.md](../AGENTS.md) for repo-wide conventions; this file only documents what is different here.

## Commands

- `npm test` - run the full vitest suite (covers every spec under [`../tests/lib/`](../tests/lib/)).
- `npx vitest run tests/lib/node/pi/<name>.spec.ts` - run a single spec.
- `npx vitest tests/lib/node/pi/<name>.spec.ts` - watch mode for a single spec.
- `npm run tsc` - type-check the whole lib surface (root `tsconfig.json`).
- `npm run format` - `oxfmt` on TypeScript files.

## Directory map

| Path                                                     | Purpose                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`node/pi/`](./node/pi/)                                 | Pure helpers backing pi extensions; import policy in [`node/pi/AGENTS.md`](./node/pi/AGENTS.md).        |
| [`node/pi/ext/`](./node/pi/ext/)                         | The carve-out: shared extension helpers that import `@earendil-works/*` (pi-tui widgets, dialog flows). |
| [`node/ai-tooling/`](./node/ai-tooling/)                 | Shared CLI harness (arg parsing, output rendering, JSONL loaders) used by every `session-usage.ts`.     |
| [`node/clipboard-server.ts`](./node/clipboard-server.ts) | Node implementation of the `clipboard-server` bin script.                                               |

## Key patterns

### Test mirror

- Specs mirror the source path: `lib/node/pi/todo-reducer.ts` → `tests/lib/node/pi/todo-reducer.spec.ts`. Add a spec for
  every new helper; the vitest suite is the expectation.
- See [`../tests/lib/node/pi/README.md`](../tests/lib/node/pi/README.md) for the spec index and which module each spec
  covers.
- Extension command-surface specs are the one exception: they live under
  [`../tests/config/pi/extensions/`](../tests/config/pi/extensions) because they document the extension shell on top of
  the helpers here. Those specs still drive only pure lib helpers (no pi imports).

### Module naming

- Kebab-case filenames (`iteration-loop-reducer.ts`, `bash-match.ts`). No `index.ts` barrels - each module is imported
  by its explicit filename so refactors are greppable.
- Related modules share a prefix (`iteration-loop-*`, `deep-research-*`, `todo-*`, `scratchpad-*`) so the lib tree stays
  navigable at 80+ files.

### Shared atomics

- Use [`node/pi/atomic-write.ts`](./node/pi/atomic-write.ts) for every filesystem write that could race (cache files,
  session-state snapshots, config rewrites). Do not roll your own `fs.writeFile` + rename.
- Use [`node/pi/shared.ts`](./node/pi/shared.ts)' `truncate`, `trimOrUndefined`, `byteLen`, `BYTE_ENCODER` instead of
  duplicating them per module.

## Boundaries

**Always**: add a spec under [`../tests/lib/node/pi/`](../tests/lib/node/pi) for every new module or behavioral change;
keep modules pure (pi-import policy in [`node/pi/AGENTS.md`](./node/pi/AGENTS.md)); run `npm test` and `npm run tsc`
before landing.

**Ask first**: adding a new top-level directory under `lib/` (e.g. a sibling to `node/`); pulling in a new runtime
dependency that ships to end-user shells; changing a module's public export shape when multiple extensions consume it.

**Never**: import `@earendil-works/*` or any agent-runtime SDK from a module outside `node/pi/ext/` (the lone carve-out,
see [`node/pi/AGENTS.md`](./node/pi/AGENTS.md)); import a third-party runtime dep from a pure module - the sole
sanctioned exception is `node/pi/shared/strict-frontmatter.ts` importing `yaml` (see
[`node/pi/AGENTS.md`](./node/pi/AGENTS.md)); commit generated artifacts or `.d.ts` bundles; suppress type errors with
`any` or `@ts-ignore` instead of fixing the type.

## References

- [`../tests/lib/node/pi/README.md`](../tests/lib/node/pi/README.md) - spec index covering every module here.
- [`../config/pi/extensions/README.md`](../config/pi/extensions/README.md) - downstream consumers of these helpers.
- [`../config/pi/README.md`](../config/pi/README.md) - pi config overview including which extensions import which lib
  modules.
