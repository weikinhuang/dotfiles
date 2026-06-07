# `roleplay.ts`

A cast-keyed durable store for roleplay scenarios, deliberately **separate** from the coding-agent
[`memory`](./memory.md) extension so it can be turned off wholesale without touching the coding surface. Where `memory`
keys durable notes on cwd / session, `roleplay` keys on **cast** - a character or ensemble that travels with you across
workspaces. This implements Phases 1-5 + 7A-B of
[`plans/pi-roleplay-sillytavern.md`](../../../plans/pi-roleplay-sillytavern.md): the store + `character` records (Phase
1), the keyword-triggered **lorebook** (`lore` records, Phase 2), the **SillyTavern card importer** (Phase 3), **depth
injection** (author's note + depth-tagged lore via the `context` event, Phase 4), persona **scene fold** (`characters` /
`pov`, Phase 5), the **relationship / summary / timeline** record kinds with affinity decay (Phase 7A), and
**auto-summarization** of evicted history at compaction (Phase 7B). The remaining phase adds avatar sprites (Phase 6).

## Activation gate

The roleplay tool, cast scan, and `## Roleplay` system-prompt block are **dormant** unless the active
[`persona`](./persona.md) declares `roleplay: true` in its frontmatter. This keeps the feature off for coding personas
and for personas used as subagent implementations - you opt a persona in explicitly. With no qualifying persona active:

- the `roleplay` tool returns an error (`roleplay is inactive: activate a persona with roleplay: true …`);
- nothing is injected into the system prompt;
- `/roleplay` reports the dormant state.

The active cast slug is resolved as: `/roleplay cast <name>` override → the persona's `cast:` frontmatter →
`castSlug(persona.name)`. The resolved cast + the (future) POV character are published on a `globalThis` singleton
([`lib/node/pi/roleplay/active.ts`](../../../lib/node/pi/roleplay/active.ts)) so `persona` / `avatar` can read them.

## Store layout

```text
${PI_ROLEPLAY_ROOT:-~/.pi/agent/roleplay}/
└── casts/<cast-slug>/
    ├── INDEX.md            ← one-line-per-record index, tool-rebuilt; don't hand-edit
    ├── character/<slug>.md
    ├── lore/<slug>.md
    ├── relationship/<slug>.md
    ├── summary/<slug>.md
    └── timeline/<slug>.md
```

Each record is a markdown file with strict three-key frontmatter (`name`, `description`, `kind`) plus a markdown body;
`lore` records carry extra keyword/injection fields and `relationship` records carry affinity/trust fields (see below).
The coding `memory` tree (`~/.pi/agent/memory`) is a sibling and is never touched. Disk is the source of truth: on
`session_start` / `session_tree` the extension scans the active cast and rebuilds its in-memory index; tool writes go
straight to disk, then re-emit `INDEX.md`.

A `character` body holds voice, appearance, speech tics, hard constraints, first message, and example dialogue - the
SillyTavern character-card fields. A `lore` body holds the world detail injected when its keywords fire. `summary` and
`timeline` records are plain note records (a recap, a dated list of beats) with no extra frontmatter; `relationship`
records are described below.

## Lorebook (`lore` kind)

The SillyTavern "World Info" equivalent and the main scaling lever: instead of one giant always-injected blob, world
detail lives in `lore` records that inject **only when their keywords appear in the latest user message**. This lets a
large canon stay on disk and surface relevance-gated, a few entries at a time.

Lore frontmatter (all optional beyond the core three keys):

| Field           | Type             | Meaning                                                                                               |
| --------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `triggers`      | `[a, b, …]`      | Primary keywords, OR-combined. Any whole-word, case-insensitive hit fires the entry.                  |
| `secondaryKeys` | `[x, y, …]`      | Optional gate applied after a primary hit.                                                            |
| `secondaryMode` | `AND`/`OR`/`NOT` | How `secondaryKeys` combine: all present / any present / none present. Default `AND`.                 |
| `constant`      | `true`/`false`   | Always inject (budget permitting), ignoring triggers. Default `false`.                                |
| `order`         | integer          | Priority; higher wins when the char budget forces eviction. Default `0`.                              |
| `depth`         | integer          | Inserted at this depth in the message array via the `context` event (Phase 4), not the system prompt. |
| `recurse`       | `true`/`false`   | Opt in to having this entry's body re-scanned to trigger further lore. Default `false`.               |

Keyword matching is **whole-word** (`RI` matches `RI` / `(RI)` but not `spring`) and case-insensitive; multi-word and
punctuation-bearing keys (`Rhodes Island`, `Dr. Kal'tsit`) match literally between token boundaries. Fired entries are
ranked by `order` (then name) and kept until `loreCharBudget` is reached - the single highest-priority entry is always
kept even if it alone exceeds the budget. Recursion is **off by default**, opt-in per entry, and hard-capped at
`maxRecursion` (ceiling 2) passes.

> **Phase 2 scan window:** matching runs in `before_agent_start`, which only exposes the _latest user message_, so lore
> fires on the current prompt. Scanning the recent N turns and inserting at `depth` happens in the `context` event
> (Phase 4, below).

## Depth injection: author's note + depth-tagged lore

The `before_agent_start` block above appends to the **system prompt** (constant + non-depth lore). The SillyTavern
"insert at depth N" lever is different: text is spliced into the **message array** near the live turn and recomputed
every call. The extension does this in the `context` event, which hands a deep copy of the messages and lets the
extension return a replacement (non-persistent - it never touches the saved session). Two things ride this path:

- **Author's note** - a short standing instruction from the active persona's `authorNote` frontmatter, inserted at
  `authorNoteDepth` (default 4) messages from the end. Use it for tone / style / pacing reminders that should sit close
  to the model's next turn rather than fade at the top of a long system prompt.
- **Depth-tagged lore** - any `lore` entry with a `depth:` field. These are _excluded_ from the system-prompt lore block
  and instead fire against the **recent `scanDepth` messages** (default 10, not just the latest prompt) and splice in at
  their `depth`. Budgeted by `loreCharBudget` like the system-prompt lore.

Depth counts from the end: `depth: 0` appends after the last message, `depth: 1` inserts just before it, and a depth
larger than the history clamps to the start. Disable the whole path with `PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1`.

## Injected `## Roleplay` block

Each turn (under a roleplay persona) the active cast's **index** - one line per record, names + descriptions only - is
appended to the system prompt under a `## Roleplay — cast: <slug>` header, capped by `charBudget` (default 3000, floor
500). Full character bodies are fetched on demand via `roleplay read <id>`. Below the index, any **fired lore** for the
current turn is injected in full under a `## Roleplay lore` header (capped separately by `loreCharBudget`); this is the
one case where bodies are injected outright, since the point of keyword triggering is to put the relevant detail
in-context without a tool call. Once a cap is hit the block stops adding entries and emits a trailer. Returns nothing
when the cast is empty and no lore fired.

## Scene: folding full character sheets (`characters` / `pov`)

The index above is deliberately lightweight (one line per record). To put a character's **whole sheet** in front of the
model - the SillyTavern "the character card is always in context" behaviour - the active persona declares which cast
members are on stage:

```yaml
roleplay: true
characters: [Exusiai, Texas] # full bodies folded into the system prompt, in this order
pov: Doctor # the character the human plays
openers: ['Yo, Doctor!', '...'] # greeting lines, surfaced via `/persona opener`
```

When `characters` or `pov` is set, a `## Roleplay scene` block is appended above the cast index. It folds each named
character's full body under a `### <Name>` heading (deduped, in declared order), announces `The user plays **<pov>**.`,
and renders the POV character last tagged `(player character)`. Names are matched by record id, then case-insensitive
name, then name-slug; **unresolved names are warn-dropped** (a one-time notice naming the missing set). The block is
capped by `charBudget`: the first sheet is always kept, later sheets that would blow the cap are omitted with a trailer.
A `pov` that is not in the cast still produces the announcement line (the player may be an off-screen character).
Matching against names is the same logic the lorebook uses for tool-name handling.

Leave both unset and the extension keeps the index-only behaviour (backward compatible). Author the three fields with
**inline** arrays (`[a, b]`) - pi's frontmatter parser does not accept block (`- item`) lists.

`/persona opener [n]` prints the active persona's greeting lines (all numbered, or just entry `n`); see
[`persona.md`](./persona.md).

## Macros (`{{user}}` / `{{char}}` / ...)

SillyTavern character cards and lorebooks routinely embed `{{user}}` / `{{char}}` placeholders, so injected text is run
through [`macros.ts`](../../../lib/node/pi/roleplay/macros.ts) at the moment a body is read. Substitution happens before
the budget math, so the char-count cap sees the resolved text. Macro names are case-insensitive; any argument after the
first `:` keeps its case.

| Macro                         | Resolves to                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `{{user}}`                    | the persona `pov` (player character) name                                                              |
| `{{char}}`                    | the in-context character: a folded sheet uses **that** character, lore/note the primary face character |
| `{{time}}` / `{{date}}`       | `HH:MM` (24h, local) / `YYYY-MM-DD`                                                                    |
| `{{weekday}}`                 | e.g. `Sunday`                                                                                          |
| `{{random:a,b,c}}`            | one comma-separated option, picked at random (options trimmed)                                         |
| `{{roll:NdM}}` / `{{roll:M}}` | sum of `N` `M`-sided dice (`N` defaults to 1)                                                          |
| `{{newline}}`                 | a literal newline                                                                                      |

Resolution is forgiving: an unknown macro, or `{{user}}` / `{{char}}` with no value in context, is **left literal**
rather than blanked - a misconfiguration stays visible instead of mangling grammar. Macros are applied to folded
character sheets, fired lore bodies (system-prompt and depth-injected), and the author's note. They do not nest or
recurse (a single left-to-right pass). Openers are surfaced by `persona` and are not macro-substituted.

## Relationship state (`relationship` kind)

A `relationship` record tracks how a pair feels about each other so a scene can resume where it left off. Extra
frontmatter:

```yaml
kind: relationship
affinity: 72 # 0-100 warmth/closeness; model-rewritten as scenes evolve
trust: high # free-form qualitative label
lastInteraction: 2026-06-07 # ISO date of the last shared scene; the decay anchor
openThreads: [the unanswered dinner invite, her curiosity about the Doctor's past]
```

Affinity is not static. Left untouched it **drifts toward a neutral baseline** (default 50): a neglected warm bond
cools, an old grudge softens. The drift is computed deterministically from wall-clock dates by
[`relationship.ts`](../../../lib/node/pi/roleplay/relationship.ts) - `decayPerDay * whole-days-since(lastInteraction)`,
clamped to `[0, 100]` and never overshooting the baseline. No decay applies when `lastInteraction` is missing,
unparseable, or in the future, so the stored value is returned verbatim. The decay is a read-time projection; the stored
`affinity` on disk only changes when the model rewrites the record.

`summary` and `timeline` records are plain note records (no extra frontmatter): a `summary` body is a recap of a span; a
`timeline` body is a dated list of beats. All three kinds surface in the cast index and are loaded on demand via
`roleplay read <id>` like any other record. The `summary/auto` record is special: it is the rolling recap written by
auto-summarization (below).

## Auto-summarization (`summary/auto`)

When a long scene grows past pi's context window, pi **compacts** - it summarizes and drops the oldest turns. On the
`session_before_compact` event the extension is handed exactly the span pi is about to evict, and folds it into a single
rolling `summary/auto` record so scene continuity survives the drop. This is opt-in, off by default, and a strict
side-write: it **never** overrides or cancels pi's own compaction, so a failure here is invisible to the rest of pi.

The path mirrors the research extensions' `tiny`-model adapter
([`summarize.ts`](../../../lib/node/pi/roleplay/summarize.ts)):

- **Disabled unless configured.** A `summarizeModel` (a `provider/model-id` string) must resolve from, in order,
  `<cwd>/.pi/roleplay-summarize.json`, `~/.pi/agent/roleplay-summarize.json`, or `~/.pi/agent/settings.json` under
  `roleplay.summarizeModel`. With none set the adapter is permanently disabled and nothing runs.
- **Trigger.** The evicted span must hold at least `summarizeMinMessages` non-empty messages (default 4); below that the
  span is left alone.
- **One rolling record.** The [`roleplay-summarizer`](../../../config/pi/agents/roleplay-summarizer.md) agent is spawned
  once via `runOneShotAgent` with the evicted span plus the existing `summary/auto` body (it consolidates, it does not
  append), and the result overwrites `summary/auto`. The body is capped at `summarizeMaxChars` (default 1500); an
  over-cap or empty response is dropped.
- **Non-load-bearing fallback.** Any failure - model not resolvable, agent missing, spawn error, timeout, empty / `null`
  response - results in no record write and pi's compaction proceeds untouched. Set `PI_ROLEPLAY_DISABLE_SUMMARIZE=1` to
  turn the whole path off even when a model is configured.

The rolling recap rides the cast-index injection like any other record, so the model keeps a one-line pointer to the
running scene summary across sessions; the full recap is loaded on demand via `roleplay read auto`.

## The `roleplay` tool

| Action   | Required                                  | Optional | Purpose                                        |
| -------- | ----------------------------------------- | -------- | ---------------------------------------------- |
| `list`   | -                                         | -        | Dump the active cast index.                    |
| `read`   | `id`                                      | `kind`   | Load a record's full body.                     |
| `save`   | `name`, `description`, `body`             | `kind`   | Write a new record + rebuild `INDEX.md`.       |
| `update` | `id` + one of `name`/`description`/`body` | `kind`   | Rewrite fields; renames change the slug.       |
| `remove` | `id`                                      | `kind`   | Delete a record + drop it from `INDEX.md`.     |
| `search` | `query`                                   | -        | Case-insensitive match over name/desc/id/body. |

`kind` defaults to `character`; pass `kind: lore` to target / create a lorebook entry. When a slug exists under more
than one kind, `read` / `update` / `remove` need an explicit `kind` to disambiguate. `save` / `update` of a `lore` entry
also accept `triggers`, `secondaryKeys`, `secondaryMode`, `constant`, `order`, `depth`, and `recurse` (a `lore` update
may change only those fields). All actions operate on the **active cast**.

## `/roleplay` command

- `/roleplay` (or `/roleplay list`) - show the active cast (or the dormant note).
- `/roleplay cast <name>` - set the active-cast override (effective once a `roleplay: true` persona is active).
- `/roleplay import <path.json|.png>` - import a SillyTavern character card into the active cast (see below).
- `/roleplay dir` - print the store root + active cast dir.
- `/roleplay rescan` - re-read the active cast from disk.
- `/roleplay casts` - list every cast directory on disk.
- `--help` / `-h` / `?` prints USAGE.

## Importing SillyTavern cards

`/roleplay import <path>` ingests a SillyTavern / TavernAI **character card** into the active cast. It accepts:

- `.json` - a Character Card V1 (flat), V2 (`chara_card_v2`), or V3 (`chara_card_v3`) export; and
- `.png` - a card image with the JSON embedded in a `chara` (V2) or `ccv3` (V3) `tEXt` chunk (base64). V3 wins when both
  chunks are present.

The importer writes:

- **one `character` record** whose body folds the card's `description`, `personality`, `scenario`, `first_mes`,
  `mes_example`, `system_prompt`, `post_history_instructions`, and `alternate_greetings` into labelled sections (so
  nothing is lost; routing `system_prompt`/greetings into persona fields is Phase 5 work); and
- **one `lore` record per enabled `character_book` entry** - `keys` -> `triggers`, `secondary_keys` (when the entry is
  `selective`) -> `secondaryKeys`, `selectiveLogic` -> `secondaryMode` (0 = OR, 1/2 = NOT, 3 = AND), `constant` and
  `insertion_order` -> `order` preserved.

Disabled or empty-content book entries are skipped with a warning; the summary lists every record written. The import is
dormant-gated like the rest of the extension - activate a `roleplay: true` persona first. Decoding/normalization is pure
([`lib/node/pi/card-import/`](../../../lib/node/pi/card-import/)); the command just reads the file and writes the
resulting records.

## Configuration

Budgets + recursion are preferences, exposed via a `roleplay.json` config layer
([`lib/node/pi/roleplay/config.ts`](../../../lib/node/pi/roleplay/config.ts)), resolution order
`project (<cwd>/.pi/roleplay.json)` > `user (~/.pi/agent/roleplay.json)` > `PI_ROLEPLAY_MAX_INJECTED_CHARS` env >
built-in default.

```jsonc
{
  "charBudget": 4000, // cast-index block cap (default 3000, floor 500)
  "loreCharBudget": 4000, // fired-lore section cap (default 3000, floor 500)
  "maxRecursion": 1, // lorebook recursion passes, 0 = off (default 0, ceiling 2)
  "scanDepth": 10, // recent messages scanned for depth-tagged lore (default 10, max 100)
  "relationshipDecayPerDay": 1, // affinity points drifted toward baseline per idle day (default 1, >=0)
  "relationshipBaseline": 50, // neutral resting affinity decay converges to (default 50, 0-100)
  "summarizeMinMessages": 4, // min evicted messages before auto-summarization fires (default 4, >=1)
  "summarizeMaxChars": 1500, // cap on the generated auto-summary body (default 1500, floor 200)
}
```

The auto-summarization **model** is resolved separately (it is a credential / model choice, not a budget): set
`roleplay.summarizeModel` in `~/.pi/agent/settings.json`, or a `summarizeModel` key in `roleplay-summarize.json`
(project or user). With no model resolved, auto-summarization stays disabled.

## Environment variables

- `PI_ROLEPLAY_DISABLED=1` - skip the extension entirely (no tool, no command, no injection).
- `PI_ROLEPLAY_DISABLE_AUTOINJECT=1` - keep the tool but skip the `## Roleplay` block.
- `PI_ROLEPLAY_DISABLE_LOREBOOK=1` - keep the cast-index injection but skip keyword-triggered lore.
- `PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1` - skip the `context`-event depth injection (author's note + depth-tagged lore).
- `PI_ROLEPLAY_DISABLE_SUMMARIZE=1` - skip auto-summarization on compaction (no `summary/auto` side-write).
- `PI_ROLEPLAY_DISABLE_AVATAR=1` - stop driving the [`avatar`](./avatar.md) face from the active cast (Phase 6).
- `PI_ROLEPLAY_DISABLE_SCENEGEN=1` - stop mirroring generated scene images into the avatar's `scene` banner (Phase 6C).
- `PI_ROLEPLAY_MAX_INJECTED_CHARS=N` - soft cap on the injected cast-index block (default 3000, floor 500). Below the
  config files.
- `PI_ROLEPLAY_ROOT=<path>` - override `~/.pi/agent/roleplay` (useful for testing / per-host profiles).

## Composition with other extensions

| Extension                    | Interaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`persona.ts`](./persona.md) | The master gate. `roleplay: true` (+ optional `cast:`) in persona frontmatter activates this extension; `authorNote` / `authorNoteDepth` drive the depth-injected author's note; the resolved persona is read via the singleton.                                                                                                                                                                                                                                                              |
| [`memory.ts`](./memory.md)   | Independent. Coding memory is untouched; roleplay has its own root, tool, and injected block. Both can be active at once.                                                                                                                                                                                                                                                                                                                                                                     |
| [`avatar.ts`](./avatar.md)   | Phase 6: roleplay publishes the active character's sprite-set into the avatar-input slot ([`avatar/input.ts`](../../../lib/node/pi/avatar/input.ts)) so the avatar shows the _character_. If a `portraits/<slug>.png` exists for the active character it is pushed as the avatar's override image (static portrait wins over the animated sprite). Gated by `PI_ROLEPLAY_DISABLE_AVATAR`.                                                                                                     |
| [`comfyui.ts`](./comfyui.md) | Phase 6C: roleplay subscribes to comfyui's neutral image-generated bus ([`comfyui/events.ts`](../../../lib/node/pi/comfyui/events.ts)) and, while a scene is active, mirrors the latest `generate_image` render into the avatar's `scene` banner. Image prompting stays model-driven (the active image-prompting skill); roleplay only routes the saved PNG. comfyui has no dependency on roleplay or the avatar. Gated by `PI_ROLEPLAY_DISABLE_SCENEGEN` (and `PI_ROLEPLAY_DISABLE_AVATAR`). |

## Pure helpers

Pure logic lives under [`../../../lib/node/pi/roleplay/`](../../../lib/node/pi/roleplay/) so it is vitest-testable
without the pi runtime; this file holds only the pi-coupled glue + disk I/O.

- [`store.ts`](../../../lib/node/pi/roleplay/store.ts) - types, frontmatter parse/serialize (incl. `lore` +
  `relationship` metadata), index CRUD, `INDEX.md` + injected-block renderers, slugs.
- [`paths.ts`](../../../lib/node/pi/roleplay/paths.ts) - on-disk layout + scan/read/write (node:fs only).
- [`match.ts`](../../../lib/node/pi/roleplay/match.ts) - whole-word keyword matching + lore firing (triggers +
  AND/OR/NOT secondaries).
- [`budget.ts`](../../../lib/node/pi/roleplay/budget.ts) - rank fired lore by `order` and evict to the char budget.
- [`recursion.ts`](../../../lib/node/pi/roleplay/recursion.ts) - bounded, opt-in re-scan of fired lore bodies.
- [`prompt.ts`](../../../lib/node/pi/roleplay/prompt.ts) - render the fired-lore system-prompt section.
- [`inject.ts`](../../../lib/node/pi/roleplay/inject.ts) - plan + apply depth insertions (author's note + depth lore)
  for the `context` event.
- [`scene.ts`](../../../lib/node/pi/roleplay/scene.ts) - resolve + fold full character sheets (`characters` / `pov`)
  into the `## Roleplay scene` block.
- [`macros.ts`](../../../lib/node/pi/roleplay/macros.ts) - `{{user}}` / `{{char}}` / `{{time}}` / `{{random}}` /
  `{{roll}}` substitution over injected text (deterministic via injectable clock + rng).
- [`relationship.ts`](../../../lib/node/pi/roleplay/relationship.ts) - toward-baseline affinity decay (`decayAffinity`,
  `daysElapsed`, `formatRelationshipLine`).
- [`summarize.ts`](../../../lib/node/pi/roleplay/summarize.ts) - auto-summarization: span rendering + trigger
  (`planSummarization`), settings resolver, and the `createSummarizer` adapter (null = fall back).
- [`config.ts`](../../../lib/node/pi/roleplay/config.ts) - the `roleplay.json` config layer.
- [`active.ts`](../../../lib/node/pi/roleplay/active.ts) - the cross-extension active-cast singleton.
- [`usage.ts`](../../../lib/node/pi/roleplay/usage.ts) - the `/roleplay` USAGE string.

Card import lives under [`../../../lib/node/pi/card-import/`](../../../lib/node/pi/card-import/):

- [`parse-png-chara.ts`](../../../lib/node/pi/card-import/parse-png-chara.ts) - PNG `tEXt` chunk reader + base64 decode
  of the `chara`/`ccv3` card chunk.
- [`card-to-records.ts`](../../../lib/node/pi/card-import/card-to-records.ts) - normalize V1/V2/V3 card JSON and map it
  to `character` + `lore` records.

## Hot reload

Edit [`extensions/roleplay.ts`](./roleplay.ts) or any helper under
[`../../../lib/node/pi/roleplay/`](../../../lib/node/pi/roleplay/) and run `/reload`.
