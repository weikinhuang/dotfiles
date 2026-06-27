# session cost / caching doctor

A cross-harness diagnostic that ingests one session log from any supported harness (pi, claude, codex, opencode),
reconstructs the per-turn token/cost series, and flags **cost explosions** and **prompt-caching pathologies** with the
offending turn range, dollars attributed, and a remediation hint.

It is the **detection** counterpart to the pi-only `cache-breakpoint` extension (which _fixes_ the tail-poisoning trap):
this tool _diagnoses_ any session - including non-pi ones - and tells you _why_ it was expensive.

Invoke it via the [`ai-cost-doctor`](../../../dotenv/bin/ai-cost-doctor) bin wrapper, which execs the executable
[`session-doctor.ts`](./session-doctor.ts) entry. It mirrors the ergonomics of `ai-tool-usage <tool> session <id>`: the
harness is the first positional and the session is an id/prefix (or path), defaulting to your latest session.

```sh
ai-cost-doctor pi                      # your latest pi session
ai-cost-doctor pi 019f0109             # by id prefix, resolved in the pi session store
ai-cost-doctor pi 019f0109 --turns     # + a per-turn cacheRead/cacheWrite/cost table
ai-cost-doctor claude                  # latest claude session in this project
ai-cost-doctor opencode ses_2ee7 --json
ai-cost-doctor ~/.pi/agent/sessions/<proj>/<ts>_<uuid>.jsonl   # bare path -> harness auto-detected
```

Session resolution (`session-locator.ts`): an id/prefix is matched within the harness's session store; with no selector,
the newest session is used (claude prefers the current project's slug dir). A bare existing path skips resolution and
auto-detects the harness from the file signature.

## Architecture

Reuses the shared `ai-tooling` harness (`pricing.ts`, `jsonl.ts`, `format.ts`, `paths.ts`); it does **not** fork a
parallel CLI stack. All logic is pure and unit-tested; `session-doctor.ts` is the thin I/O shell (file / DB reading, arg
parsing, printing).

| Module                                           | Role                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `analyze/turn-model.ts`                          | Provider-neutral `NormalizedTurn` / `NormalizedSession` model + `classifyCachingModel`.       |
| `analyze/detectors.ts`                           | The four pure detectors (below) + `runDetectors`. Branch on `cachingModel`, never on harness. |
| `analyze/pricing-fill.ts`                        | Backfills per-turn cost from tokens (claude/codex/opencode) via the LiteLLM pricing table.    |
| `analyze/report.ts`                              | Renders the text report + `--json` object.                                                    |
| `analyze/detect-harness.ts`                      | Auto-detects the harness from the path extension + first JSONL lines.                         |
| `adapters/{pi,claude,codex,opencode}-adapter.ts` | Raw per-harness records → `NormalizedSession` (pure).                                         |

### The normalized model

Adapters absorb every per-harness format difference so detectors see only normalized turns:

- **pi** (JSONL) precomputes cost; cache fields are camelCase `cacheRead` / `cacheWrite`.
- **claude** (JSONL) splits one response across entries (deduped by `message.id`); snake_case
  `cache_creation_input_tokens` / `cache_read_input_tokens`; no cost → pricing backfill.
- **codex** (JSONL) is OpenAI-style: `token_count` events carry `info.last_token_usage`; `input_tokens` is the grand
  total, `cached_input_tokens` the cached read; no cache-write line; no cost → backfill.
- **opencode** (SQLite) records a scalar cost but not the read/write split, so the breakdown is re-derived from tokens;
  caching model comes from `providerID` (local `llama.cpp` → `none`).

`cachingModel` is `anthropic` | `openai` | `none`, set by name first (provider/model substring) and then refined from
the data: model names are user-chosen, so any model first classed `none` that is ever observed reporting a cache read
(`cacheRead > 0`) is upgraded to `openai` for its whole run. That is how a local OpenAI-compatible backend
(llama.cpp/ollama/vllm/lmstudio, which report `cached_tokens` with no cache-write metric) gets read-side detection,
while a genuinely cache-blind backend stays `none`. The decision is per-model, not per-turn, so the cold eviction turn
(where `cacheRead` drops back to 0) stays `openai` and the read-side detectors still see it. Detectors key off
`cachingModel`, so the same logic works for a Claude model served via Bedrock (pi) or via the Anthropic API (claude)
without any harness branching.

## v1 detectors

| id                     | signature                                                                                | remediation                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `cache-poisoning`      | `cacheRead` frozen across ≥4 turns while `cacheWrite` re-writes a median >50% of context | move volatile/ephemeral content off the cache breakpoint                    |
| `cache-write-dominant` | session cacheWrite cost / total cost > 0.7                                               | most spend is re-writing cache; check for poisoning or TTL churn            |
| `ttl-expiry`           | `cacheRead` → 0 after an idle gap longer than the cache TTL (5 min)                      | idle gap blew the TTL; unavoidable, or use 1 h retention if you pause often |
| `large-context-carry`  | per-turn context sustained > 150k tokens over ≥8 turns                                   | context is large; `/compact` or branch a fresh session                      |

Thresholds live in `DEFAULT_DETECTOR_CONFIG`. Detectors are **overlapping lenses** (a poisoned stretch is also counted
by `cache-write-dominant`), so the report lists per-finding dollars without summing them.

## Per-turn drill-down (`--turns` / `-t`)

Appends a table with one row per assistant turn (index, clock, idle gap, cacheRead, cacheWrite, output, context, and
per-turn cost), tagging each turn that falls inside a localized finding (`poison` / `ttl` / `large-ctx`; the
session-wide `cache-write-dominant` lens is not tagged per-turn). It is the drill-down behind the findings - you can
watch cacheRead freeze and cacheWrite ramp across the poisoned stretch. `--json` includes the same series under
`perTurn` when `--turns` is set.

### Validation

Tuned against two real pi case-study sessions (kept local-only; the spec skips when absent):

- `019f0109` (poisoned, ~$32): `cache-poisoning` flags turns 16-55 (~$28), `cache-write-dominant` at 90%, healthy
  opening turns 0-9 untouched.
- `019f01b7` (mixed): `cache-poisoning` flags exactly turns 59-87 (~$25), `cache-write-dominant` correctly silent (65%),
  `ttl-expiry` catches the idle-gap re-writes (including the overnight resume), `large-context-carry` surfaces the
  expensive late-session tail.

See [`tests/lib/node/ai-tooling/analyze/`](../../../tests/lib/node/ai-tooling/analyze/) for the synthetic fixtures and
the real-case-study spec.
