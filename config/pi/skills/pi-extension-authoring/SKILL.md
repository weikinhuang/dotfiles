---
name: pi-extension-authoring
description:
  "WHAT: Conventions for adding or modifying a pi extension under config/pi/extensions/ in this repo - the .ts + .md
  pair, where pure helpers and unit tests live, how to wire it into settings-baseline.json, and how to smoke-test
  against the local qwen3 small model. WHEN: User asks to add a new pi extension, extract extension logic into a shared
  helper, or modify an existing extension's behavior. DO-NOT: Put business logic in the .ts extension file (extract to
  lib/node/pi/); skip the companion .md deep doc; forget to add the row to extensions/README.md; make the behavior
  tier-specific (small-model vs big-model branches)."
---

# Pi Extension Authoring

Pi extensions live under `config/pi/extensions/`. Each extension is a pair: a `.ts` file (the extension itself) and a
sibling `.md` file (the deep reference doc). Pure logic extracts into `lib/node/pi/` so it's unit-testable under
`tests/lib/node/pi/`. This skill captures the repo-specific conventions on top of pi's public extension API.

## When this applies

- Adding a new pi extension (new `.ts` + `.md` pair).
- Extracting logic from an extension into a shared helper.
- Modifying an extension's detection / nudge / guardrail behavior.
- Wiring (or unwiring) an extension in `settings-baseline.json`.

Skip this skill for config-only changes to `settings-baseline.json` that don't touch extension code.

## File trio

Every extension is three things:

| File                                                     | Purpose                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `config/pi/extensions/<name>.ts`                         | The extension itself. Hooks, tool registrations, minimal glue.             |
| `config/pi/extensions/<name>.md`                         | Deep reference: detection rules, config shape, env vars, hot-reload notes. |
| `lib/node/pi/<helper>.ts`                                | Pure helper(s) the extension calls into. Testable without pi's runtime.    |
| `tests/lib/node/pi/<helper>.spec.ts` (added with helper) | Vitest spec covering every branch of the helper.                           |

Wire the extension into `config/pi/settings-baseline.json` under the `extensions` array. Import paths are relative to
the baseline file.

## The layering rule

Keep extensions thin. Every non-trivial behavior belongs in a pure function under `lib/node/pi/`.

- **Extension `.ts`**: pi hooks (`session_start`, `agent_end`, tool registrations), plumbing, env var reads, and calls
  out to the helper. Aim for under 100 lines.
- **Helper `lib/node/pi/*.ts`**: the actual logic. Pure, deterministic, no pi API calls. One exported function per
  concern. These get vitest specs.
- **Helper spec `tests/lib/node/pi/*.spec.ts`**: covers every input/output pair the helper produces. Run with
  `npm test`.

This layering is what lets the test suite run without spinning up pi. If you find yourself mocking pi inside a vitest
spec, the logic probably wants to move down into a helper.

## Robustness, not tier switches

The robustness machinery in every extension carries the load across model tiers. Do NOT write `if (model.isSmall)` /
`if (tier === 'weak')` branches.

- Detection patterns (regex / heuristics) stay the same regardless of which model is running.
- Nudge text stays the same - don't "dumb down" for small models; a clear instruction is a clear instruction.
- When a feature genuinely needs a cheap model (e.g. a critic subagent's grader), use `modelOverride` on the subagent
  call site, not a tier switch inside the extension.
- See the companion memory `research-extensions-robustness-principle`.

## Tiny-model usage is opt-in and non-load-bearing

If the extension uses a local tiny model (e.g. `llama-cpp/qwen3-6-35b-a3b`) for a subtask:

- Route through `runOneShotAgent` (or a `tiny-helper` subagent) - never embed the model id directly.
- Gate via a setting that defaults off. When the tiny model is disabled or unavailable, the extension falls back to
  deterministic behavior - never errors out.
- The tiny model must never touch user-visible research content or verification verdicts. It's for plumbing (heuristic
  classification, phrase extraction) only.
- See the companion memory `research-tiny-model-non-load-bearing-rule`.

## Deep-doc (`.md`) shape

The `.md` file is the reference, not a tutorial. Mirror the shape of existing docs like `verify-before-claim.md`:

1. **One-sentence purpose** - what failure mode the extension addresses.
2. **Composition table** (when multiple extensions listen on the same hook) - how this extension distinguishes its
   signal from siblings.
3. **Detection** - the exact patterns / walks / heuristics. Link into the helper file.
4. **Rule / config shape** - with a JSONC example when the extension supports per-project overrides.
5. **Environment variables** - `PI_<NAME>_DISABLED`, `PI_<NAME>_VERBOSE`, `PI_<NAME>_TRACE=<path>`. Standard trio;
   include what applies.
6. **Hot reload** - which files trigger `/reload`, which require a session restart.

Update `config/pi/extensions/README.md`'s index table in the same commit.

## Smoke-testing against qwen3

After shipping a nudge / detection / guardrail, smoke-test against the local tiny model to confirm it behaves sensibly
when tool-call precision is weak:

```bash
unset HTTP_PROXY HTTPS_PROXY   # undici rejects socks5h:// during pi startup
pi -p "<scenario prompt>" --model llama-cpp/qwen3-6-35b-a3b --no-session
```

Scenarios to exercise:

- The detection positive case - does the extension fire?
- An explicit negative - confirm the check exempts legitimate work.
- The idempotency path - the sentinel-marker check means the same user message must NOT re-trigger the extension on a
  retry.

For visual / critic extensions that call a critic subagent, confirm the critic can attach images (`read <png>`
auto-attaches on recognized extensions - `png`, `jpg`, `gif`, `webp`).

See the memory `local-qwen3-6-35b-a3b-vision-model-for-pi-testing` for the full invocation including the proxy unset.

## Wiring into settings-baseline.json

Add an entry under `extensions`:

```jsonc
{
  "extensions": [
    // …existing…
    "./extensions/<name>.ts",
  ],
}
```

`settings-baseline.json` mirrors `~/.pi/agent/settings.json`; keep runtime-only keys out of the baseline (e.g.
`lastChangelogVersion`). Run `/reload` in a live pi session to pick up extension changes without restarting.

## Anti-patterns

- **Logic in the `.ts` extension file.** Tests can't reach it without spinning up pi. Extract to `lib/node/pi/`.
- **Tier-specific branches.** Small-model vs big-model code paths. Use robust detection + gentle nudges instead.
- **Tiny model on the hot path.** If the extension errors when the local model is unreachable, it's load-bearing -
  refactor to a deterministic fallback.
- **Skipping the deep `.md` doc.** The `.md` is the contract for future readers. The extension index in
  `extensions/README.md` links to it.
- **No `PI_<NAME>_DISABLED` escape hatch.** Every extension should be silenceable by env var.
- **Re-triggering on the extension's own nudge.** Use a sentinel marker (e.g. `⚠ [pi-<name>]`) on the injected message
  and short-circuit when it's present on the most recent user message.
- **Leaving the test gap - no `lib/node/pi/*.spec.ts` for the helper.** Small regressions in detection patterns destroy
  the guardrail's value; tests catch those.

## Checklist before finishing

1. `.ts` extension under `config/pi/extensions/` - thin, no business logic.
2. `.md` deep doc with detection + config + env vars + hot-reload sections.
3. Pure helpers extracted to `lib/node/pi/`.
4. Vitest spec under `tests/lib/node/pi/`. `npm test` passes.
5. Entry added to `extensions` array in `settings-baseline.json`.
6. Row added to `config/pi/extensions/README.md` index table.
7. `PI_<NAME>_DISABLED` env var supported; smoke-tested with qwen3.
8. `./dev/lint.sh` passes for any shell / statusline touched.
9. If a companion skill teaches WHEN to use this tool, add it under `config/pi/skills/<name>/SKILL.md` and cross-link
   from the `.md` and `README-skills.md`.
