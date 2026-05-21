---
name: oxlint-typescript-conventions
description:
  "WHAT: Write TypeScript under `lib/node/`, `tests/`, and `config/pi/` that passes the repo's strict `oxlint
  --type-aware` configuration on the first try, so the husky pre-commit hook (`oxlint && oxfmt --check`) does not reject
  the commit. WHEN: User asks to add or edit a `.ts` / `.spec.ts` file anywhere outside `config/pi/extensions/` (the
  extensions tree has a relaxed override in `oxlint.config.ts`). DO-NOT: Write async arrow-function test stubs that have
  no `await`; use `/literal/.test(s)` when `s.includes(literal)` would do; declare functions below their first call
  site; cast through a generic `Record` to silence `no-unsafe-assignment` without thinking about whether the cast is
  actually safe; bypass the rules with `// oxlint-disable` instead of fixing the code."
---

# oxlint TypeScript conventions

This repo runs `oxlint --type-aware` with `correctness: error` and `perf: error` plus the full `typescript` plugin (see
[`oxlint.config.ts`](../../../oxlint.config.ts)). The husky pre-commit hook runs `lint-staged`, which invokes `oxlint`
against every staged `.ts` and rejects the commit on any error. The rules are non-trivially strict; new code that passes
`tsc` will routinely fail oxlint unless it is written with these patterns from the start.

The `config/pi/extensions/**` tree has a relaxed override (most `no-unsafe-*` and `require-await` rules turned off)
because those files import from `@earendil-works/*` which the root `tsconfig.json` does not type-check. **This skill
applies to everything else** — `lib/node/**`, `tests/**`, `config/pi/*.ts` (e.g. `session-usage.ts`), and any future
top-level `*.ts`.

## When to use this skill

Apply whenever the user asks to:

- Add or edit a `.ts` file under `lib/node/`.
- Add or edit a `.spec.ts` under `tests/lib/`, `tests/config/`, or anywhere else vitest picks up.
- Add a TypeScript helper that other extensions consume.

Skip this skill for `.ts` files inside `config/pi/extensions/` (different rule set), `*.d.ts` type shims, and generated
files. The `commit-message` and `lint-and-test-gate` skills are still the final word on subject lines and verification —
this one only governs the source style.

## The pre-commit gate

```sh
$ git commit ...
✖ Task killed: oxlint-tsgolint
✖ Task killed: oxfmt --no-error-on-unmatched-pattern
husky - pre-commit script failed (code 1)
```

Run `npx oxlint --type-aware <file-or-dir>` against your changes BEFORE `git commit`. The pre-commit hook does the same
thing; running it manually saves the round trip.

For format issues separately: `npx oxfmt --check <files>` (and `npx oxfmt <files>` to fix in place).

## Patterns that trip the gate

### `typescript/require-await` — async stubs without `await`

Tests routinely install async callbacks for type compatibility, then never `await`. oxlint flags this; rewrite as a
non-async `() => Promise.resolve(...)`.

```ts
// ✗ Fails: async with no await.
installSandboxWrapper(async (cmd) => ({ command: `srt -- ${cmd}`, wrapped: true }));

// ✓ Use Promise.resolve so the function stays non-async.
installSandboxWrapper((cmd) => Promise.resolve({ command: `srt -- ${cmd}`, wrapped: true }));
```

The rule is keyed off the literal `async` keyword; an async function with NO `await` is the trigger. A real async helper
that genuinely uses `await` passes.

### `typescript/prefer-includes` — `.test(literal)` on a substring

`x.includes('foo')` is preferred over `/foo/.test(x)` whenever the regex is just a literal substring with no
metacharacters. oxlint flags the `.test()` form even inside test assertions.

```ts
// ✗ Fails: regex carries no metacharacters.
expect(warnings.find((w) => /silently drop/.test(w.reason))).toBeDefined();

// ✓ Substring match.
expect(warnings.find((w) => w.reason.includes('silently drop'))).toBeDefined();
```

A real regex (anchors, character classes, alternation) is fine — keep `/^foo$/.test(s)` as-is.

### `eslint/no-use-before-define` — declare before first use

Function and variable declarations must precede their first reference in source order. ESLint's `no-use-before-define`
is on with the default config, which means the standard "helpers at the bottom" Python style does not work.

```ts
// ✗ Fails: uniqueSorted used before defined.
export function compileLinuxRules(...) {
  return { paths: uniqueSorted([...paths]), ... };
}

function uniqueSorted(input: string[]): string[] {
  return [...new Set(input)].sort();
}

// ✓ Define helpers above their first call.
function uniqueSorted(input: string[]): string[] {
  return [...new Set(input)].sort();
}

export function compileLinuxRules(...) {
  return { paths: uniqueSorted([...paths]), ... };
}
```

### `typescript/explicit-function-return-type` — annotate test helpers

`allowExpressions: true` is set, so arrow functions passed inline (`map((x) => x + 1)`) are fine. Top-level declarations
and named factory helpers in tests are NOT, even when the return type is inferable.

```ts
// ✗ Fails: top-level helper.
function makeUI(over = {}) {
  return { hasUI: true, ... };
}

// ✓ Annotate the return type.
function makeUI(over: Partial<UIBridge> = {}): UIBridge {
  return { hasUI: true, ... };
}

// ✗ Fails: test-local factory.
const noop = () => undefined;

// ✓ Annotate.
const noop = (): undefined => undefined;
```

### `typescript/no-unsafe-assignment` / `no-unsafe-member-access` — narrow `unknown` properly

`Array.isArray(value)` narrows to `any[]`, and `JSON.parse(...)` returns `any`. Either widens to a typed shape with an
explicit `as unknown[]` / `as Record<string, unknown>` step before iterating, or parses through a typed schema.

```ts
// ✗ Fails: `value` after Array.isArray() is `any[]`, item is `any`.
if (!Array.isArray(value)) return;
for (let i = 0; i < value.length; i++) {
  const item = value[i];
  if (typeof item !== 'string') continue;
  out.push(item);
}

// ✓ Re-cast through unknown[] so item is `unknown`.
if (!Array.isArray(value)) return;
const arr = value as unknown[];
for (let i = 0; i < arr.length; i++) {
  const item = arr[i];
  if (typeof item !== 'string') continue;
  out.push(item);
}

// ✗ Fails: JSON.parse returns any, .command access is unsafe.
expect(JSON.parse(line).command).toBe('first');

// ✓ Type the parse target.
const rec = JSON.parse(line) as { command: string };
expect(rec.command).toBe('first');
```

### `typescript/consistent-indexed-object-style` — prefer `Record<K, V>`

`{ [k: symbol]: unknown }` index signatures are flagged in favor of `Record<symbol, unknown>`.

```ts
// ✗ Fails.
const g = globalThis as unknown as { [k: symbol]: unknown };

// ✓
const g = globalThis as unknown as Record<symbol, unknown>;
```

### `eslint/no-empty-function` — sentinel for `let cb = () => {}`

A bare `() => {}` placeholder for a callback that's about to be reassigned trips the rule. Either use a named sentinel
function (with a comment explaining the unreachability) or restructure to avoid the placeholder.

```ts
// ✗ Fails.
let resolveFn: () => void = () => {};
const next = new Promise<void>((resolve) => {
  resolveFn = resolve;
});
return resolveFn;

// ✓ Named sentinel.
function noopResolve(): void {
  /* unreachable - reassigned by Promise ctor */
}
let resolveFn: () => void = noopResolve;
const next = new Promise<void>((resolve) => {
  resolveFn = resolve;
});
return resolveFn;
```

### `eslint/no-unused-vars` — drop unused imports

Particularly easy to hit when refactoring: an `import { foo, bar }` line where one of the names is no longer referenced.
The rule respects the `^_` ignore prefix for arguments and destructured elements but NOT for imports — drop the unused
name from the import list.

## Workflow

1. Write the code naturally; run `npm run tsc` first to confirm types are sound.
2. Run `npx oxlint --type-aware <changed-paths>` (paths or directories — both work).
3. Fix every error reported. The patterns above cover ~95% of what trips on a fresh helper.
4. Run `npx oxfmt --check <changed-paths>`; run without `--check` to format if it complained.
5. Stage and commit. The pre-commit hook re-runs both — your local pass guarantees a clean commit.

## Anti-patterns

- **Disabling rules with `// oxlint-disable-next-line ...`.** Almost never the right answer in this repo; the rules
  above all have a clean-code form. Reach for the disable comment only when a third- party type forces the unsafe
  pattern, and document why in the disable comment.
- **Casting through `Record<string, unknown>` reflexively.** The `as unknown[]` / explicit-shape approach narrows
  correctly without adding a load-bearing assertion. Casts that hide a real bug are a real maintenance hazard — when in
  doubt, validate the shape with a guard.
- **Skipping `oxlint` locally** because "the pre-commit hook will catch it." It will, by aborting your commit
  mid-message-typing. Run it yourself first.
- **Matching the relaxed `config/pi/extensions/` posture in `lib/`** because "extensions get away with it." Lib helpers
  are the typed surface that extensions consume; tightening lib while extensions stay loose is the deliberate boundary.

## References

- [`oxlint.config.ts`](../../../oxlint.config.ts) — every rule in force, plus the `config/pi/extensions/**` override.
- [oxlint TypeScript rules index](https://oxc.rs/docs/guide/usage/linter/rules.html) — the upstream rule docs for the
  messages above.
- [`lint-and-test-gate`](../lint-and-test-gate/SKILL.md) — when to run lint vs tests vs both.
- [`commit-message`](../commit-message/SKILL.md) — what to put in the commit subject after the gate is green.
