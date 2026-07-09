# lib/node/pi

Pure helpers backing the pi extensions under [`../../../config/pi/extensions/`](../../../config/pi/extensions). See
[`../../AGENTS.md`](../../AGENTS.md) for lib-wide conventions (module naming, shared atomics, the test mirror); this
file covers only the **pi-import policy** specific to this subtree.

## Commands

- `npx vitest run tests/lib/node/pi/<name>.spec.ts` - run one helper's spec.
- `npx vitest run tests/lib/node/pi/ext/` - run the pi-importing `ext/` specs.
- `npm run tsc` - type-check this subtree (and the rest of lib) under the root project.

## Directory map

| Path                                   | Purpose                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`ext/`](./ext)                        | The carve-out: shared extension helpers that import `@earendil-works/*` (pi-tui widgets, dialogs).     |
| [`shared.ts`](./shared.ts)             | Cross-helper utilities (`truncate`, `trimOrUndefined`, `byteLen`, `BYTE_ENCODER`).                     |
| [`atomic-write.ts`](./atomic-write.ts) | Race-safe filesystem writes; use instead of a raw `fs.writeFile` + rename.                             |
| [`comfyui/`](./comfyui)                | Example per-extension pure-helper package (one dir per extension: `deep-research/`, `todo/`, …).       |
| [`bg-bash/`](./bg-bash)                | Leaf adapters for `bg_bash`; engine lives in top-level `bg-bash-*.ts` ([README](./bg-bash/README.md)). |

## Key patterns

### Pure by default; `ext/` is the carve-out

- **Pure modules (everything directly under `lib/node/pi/`).** Import from `node:*` and peer `lib/node/**` only - never
  from `@earendil-works/pi-coding-agent`, any pi runtime, or other third-party runtime deps. Keeps them under the root
  `tsconfig.json` and unit-testable without mocks; reach for `ext/` only when a pure module genuinely can't express it.
- **`ext/` is the exception (extension-runtime-coupled helpers).** Shared code needing a runtime import a pure module
  can't take - the pi runtime (`@earendil-works/pi-tui` widgets, `pi-coding-agent` dialogs), another runtime-only dep
  (e.g. `sharp`), or logic extracted to shrink an oversized extension `.ts` for a smaller model - lives under
  [`ext/`](./ext). Still type-checked by the root `tsconfig.json` and mirror-spec'd under
  [`tests/lib/node/pi/ext/`](../../../tests/lib/node/pi/ext), but under the **relaxed oxlint override** (`no-unsafe-*` /
  `require-await` off). Anchors: [`ext/multi-select-list.ts`](./ext/multi-select-list.ts),
  [`ext/drop-confirm.ts`](./ext/drop-confirm.ts), [`ext/external-editor.ts`](./ext/external-editor.ts).
- **A single extension's own glue stays in its `.ts`.** Per-extension `pi.on('tool_call', …)` handlers and tool/UI
  wiring belong in [`../../../config/pi/extensions/<name>.ts`](../../../config/pi/extensions) - `ext/` is for
  cross-extension logic or shrinking a file, not a second home for one shell.

### Reuse the shared helpers - don't re-roll

Before writing a small utility, check whether a canonical helper exists; re-rolling one (a second message-to-text walk,
a hand-built `globalThis` slot, another `truncate`) is a review red flag. When a caller needs a variation, **extend the
shared helper with an optional parameter (default preserving behaviour)** and keep consumer-specific extras at the call
site - don't fork a copy. Alongside the atomics in the directory map (and `pi-paths` / `parse-env` / completion helpers
documented in the extensions guide), reuse:

- **Pure:** [`message-text.ts`](./message-text.ts) `extractContentText` (content → text), [`shared.ts`](./shared.ts)
  `truncate`, [`shared/bytes.ts`](./shared/bytes.ts) `byteLen` / `sliceUtf8Suffix` (codepoint-safe byte trim),
  [`shared/strict-frontmatter.ts`](./shared/strict-frontmatter.ts) `parseFencedFrontmatter`,
  [`shared/guards.ts`](./shared/guards.ts) `isTextPart`, [`global-slot.ts`](./global-slot.ts) `createGlobalSlot` (never
  hand-build a `globalThis` slot), [`fuzzy-match.ts`](./fuzzy-match.ts) `fuzzyMatch` (higher = better),
  [`scroll-window.ts`](./scroll-window.ts) scroll math, [`slugify.ts`](./slugify.ts) `slugifyAscii` (fs-safe slug;
  opt-in fold / cap / fallback), [`prompt-section.ts`](./prompt-section.ts) `appendSectionByHeading` /
  `appendSectionOnce` (idempotent prompt-section append), [`png/binary.ts`](./png/binary.ts) `hasPngSignature` /
  `readUint32BE` (raw PNG byte primitives).
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
