# lib/node/pi

Pure helpers backing the pi extensions under [`../../../config/pi/extensions/`](../../../config/pi/extensions). See
[`../../AGENTS.md`](../../AGENTS.md) for lib-wide conventions (module naming, shared atomics, the test mirror); this
file covers only the **pi-import policy** specific to this subtree.

## Commands

- `npx vitest run tests/lib/node/pi/<name>.spec.ts` - run one helper's spec.
- `npx vitest run tests/lib/node/pi/ext/` - run the pi-importing `ext/` specs.
- `npm run tsc` - type-check this subtree (and the rest of lib) under the root project.

## Directory map

| Path                                   | Purpose                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`ext/`](./ext)                        | The carve-out: shared extension helpers that import `@earendil-works/*` (pi-tui widgets, dialogs). |
| [`shared.ts`](./shared.ts)             | Cross-helper utilities (`truncate`, `trimOrUndefined`, `byteLen`, `BYTE_ENCODER`).                 |
| [`atomic-write.ts`](./atomic-write.ts) | Race-safe filesystem writes; use instead of a raw `fs.writeFile` + rename.                         |
| [`comfyui/`](./comfyui)                | Example per-extension pure-helper package (one dir per extension: `deep-research/`, `todo/`, …).   |

## Key patterns

### Pure by default; `ext/` is the carve-out

- **Pure modules (everything directly under `lib/node/pi/`).** Import from `node:*` and peer `lib/node/**` only - never
  from `@earendil-works/pi-coding-agent`, any pi runtime, or any other third-party runtime dependency. That keeps the
  code under the root `tsconfig.json` and unit-testable without mocks. This is the default; only reach for `ext/` when a
  pure module genuinely can't express the helper.
- **`ext/` is the exception (extension-runtime-coupled helpers).** Shared extension code that needs a runtime import a
  pure module can't take - the pi runtime (`@earendil-works/pi-tui` widgets, `pi-coding-agent` dialog flows) or another
  runtime-only dependency (e.g. `sharp` for image work) - or logic extracted to shrink an oversized extension `.ts` so a
  smaller model can work on it - lives under [`ext/`](./ext). It is still type-checked by the root `tsconfig.json`
  (`@earendil-works/*` resolves from `node_modules`) and still gets a mirrored spec under
  [`../../../tests/lib/node/pi/ext/`](../../../tests/lib/node/pi/ext), but it runs under the **relaxed oxlint override**
  shared with the extensions tree (`no-unsafe-*` / `require-await` off). Anchors:
  [`ext/multi-select-list.ts`](./ext/multi-select-list.ts), [`ext/drop-confirm.ts`](./ext/drop-confirm.ts),
  [`ext/external-editor.ts`](./ext/external-editor.ts).
- **A single extension's own glue stays in its `.ts`.** Per-extension `pi.on('tool_call', …)` handlers, command
  registration, and tool/UI wiring belong in [`../../../config/pi/extensions/<name>.ts`](../../../config/pi/extensions)
  - `ext/` is for logic shared across extensions or extracted to shrink a file, not a second home for one shell. If a
    pure helper grows a pi import, keep it pure if you can, otherwise move it to `ext/`.

### Reuse the shared helpers - don't re-roll

Before writing a small utility, check whether a canonical helper exists; re-rolling one (a second message-to-text walk,
a hand-built `globalThis` slot, another `truncate`) is a review red flag. When a caller needs a variation, **extend the
shared helper with an optional parameter (default preserving behaviour)** and keep consumer-specific extras at the call
site - don't fork a copy. Alongside the atomics in the directory map (and `pi-paths` / `parse-env` / completion helpers
documented in the extensions guide), reuse:

- **Pure:** [`message-text.ts`](./message-text.ts) `extractContentText` (content → text; `message-extract.ts`
  re-exports), [`shared.ts`](./shared.ts) `truncate`, [`shared/strict-frontmatter.ts`](./shared/strict-frontmatter.ts)
  `parseFencedFrontmatter` (domain validation layered on top), [`shared/guards.ts`](./shared/guards.ts) `isTextPart`,
  [`global-slot.ts`](./global-slot.ts) `createGlobalSlot` (never hand-build a `globalThis[Symbol.for(…)]` slot),
  [`fuzzy-match.ts`](./fuzzy-match.ts) `fuzzyMatch` (higher = better; not pi-tui's inverted score),
  [`scroll-window.ts`](./scroll-window.ts) scroll math.
- **`ext/` glue:** [`ext/pi-session.ts`](./ext/pi-session.ts) `piCreateAgentSession`,
  [`ext/tool-path.ts`](./ext/tool-path.ts) `getToolCallPathInput`, [`ext/deferred-nudge.ts`](./ext/deferred-nudge.ts)
  `deliverDeferredNudge`, [`ext/overlay-window.ts`](./ext/overlay-window.ts) `assembleWindowedBody`,
  [`ext/context-edit-runtime.ts`](./ext/context-edit-runtime.ts).

## Boundaries

**Always**: keep modules directly under `lib/node/pi/` pure; put pi-importing shared helpers in `ext/` with a mirrored
spec under `tests/lib/node/pi/ext/`; reuse a canonical helper (extend it with an optional param) instead of re-rolling.

**Ask first**: promoting a widely-imported pure helper into `ext/` (it gains a pi dependency every caller inherits);
depending on an `@earendil-works/*` package not already used here.

**Never**: import `@earendil-works/*` (or any agent-runtime SDK) from a module outside `ext/` - that is the only place
pi imports are allowed in this subtree.

## References

- [`../../../config/pi/extensions/AGENTS.md`](../../../config/pi/extensions/AGENTS.md) - the extension-shell side of the
  same boundary (where per-extension glue lives).
- [`../../../tests/lib/node/pi/README.md`](../../../tests/lib/node/pi/README.md) - spec index plus the pure / `ext` test
  split.
