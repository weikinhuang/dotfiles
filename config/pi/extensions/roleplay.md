# `roleplay.ts`

A cast-keyed durable store for roleplay scenarios, deliberately **separate** from the coding-agent
[`memory`](./memory.md) extension so it can be turned off wholesale without touching the coding surface. Where `memory`
keys durable notes on cwd / session, `roleplay` keys on **cast** - a character or ensemble that travels with you across
workspaces.

The extension provides:

- a store of `character`, `lore`, `relationship`, `summary`, and `timeline` records per cast, with a `roleplay` tool and
  a `/roleplay` command;
- a keyword-triggered **lorebook** (SillyTavern "World Info") with timed effects, inclusion groups, optional recursion,
  and optional named lore bundles;
- **depth injection** of an author's note and depth-tagged lore near the live turn;
- **scene folds** that put whole character sheets in front of the model;
- **macros** (`{{user}}`, `{{char}}`, `{{roll}}`, ...);
- a **rolling bounded context window** with a narrative recap, opt-in fact capture, and an opt-in anti-drift timeline;
- a multi-turn **repetition nudge** and one-shot **scene events**;
- **SillyTavern card import and export**, and a **scene image** interface built on [`comfyui`](./comfyui.md).

This file is the user-facing reference. Design rationale, cache-stability notes, the recap/window mechanics, and the
pure helper module index live in [roleplay-internals.md](./roleplay-internals.md).

## Activation gate

The roleplay tool, cast scan, and `## Roleplay` system-prompt block are **dormant** unless the active
[`persona`](./persona.md) declares `roleplay: true` in its frontmatter. This keeps the feature off for coding personas
and for personas used as subagent implementations - you opt a persona in explicitly. With no qualifying persona active:

- the `roleplay` tool returns an error (`roleplay is inactive: activate a persona with roleplay: true …`);
- the `roleplay` tool is removed from the active-tools set, so its **Available tools** line and **Guidelines** bullets
  are kept out of the system prompt entirely, starting with the first turn (see
  [roleplay-internals.md](./roleplay-internals.md#tool-gate-timing) for why the gate runs at session-lifecycle time);
- nothing is injected into the system prompt;
- `/roleplay` reports the dormant state, and the cast-scoped verbs (`lore`, `recap`, `relationships`, `import`,
  `export`, `event`, `newscene`) refuse to run.

The active cast slug is resolved as: `/roleplay cast <name>` override → the persona's `cast:` frontmatter →
`castSlug(persona.name)`. The resolved cast + POV character are published on a `globalThis` singleton
([`lib/node/pi/roleplay/active.ts`](../../../lib/node/pi/roleplay/active.ts)) so `persona` / `avatar` can read them.

## Store layout

```text
${PI_ROLEPLAY_ROOT:-~/.pi/agent/roleplay}/
├── prompts/<name>.md         ← optional user-scope prompt-guidance overrides
└── casts/<cast-slug>/
    ├── INDEX.md            ← one-line-per-record index, tool-rebuilt; don't hand-edit
    ├── character/<slug>.md
    ├── lore/<slug>.md           ← always-on BASE lore (top-level)
    ├── lore/<bundle>/<slug>.md  ← optional NAMED lore bundle (inert unless activated)
    ├── relationship/<slug>.md
    ├── summary/
    │   ├── auto.md              ← carry-over recap (cross-session seed for new trees)
    │   └── archive/<ts>.md      ← `/roleplay newscene`-archived prior carry-overs
    ├── timeline/
    │   ├── auto.md              ← carry-over timeline (append-only log of dated beats)
    │   └── archive/
    │       ├── <ts>.md          ← `/roleplay newscene` archive
    │       └── <ts>-<pid>-<rand>-rotated.md ← older half rotated out past timelineFileMaxChars
    └── facts/                   ← captured-facts carry-over sidecar (NOT a record kind; unscanned)
        ├── <slug>.md            ← one carry-over fact each (frontmatter name + description)
        └── archive/<ts>/        ← newscene-archived facts
```

Each record is a markdown file with three required frontmatter keys (`name`, `description`, `kind`) plus a markdown
body; `lore`, `character`, and `relationship` records carry extra fields described below. The coding `memory` tree
(`~/.pi/agent/memory`) is a sibling and is never touched. Disk is the source of truth: on `session_start` /
`session_tree` the extension scans the active cast and rebuilds its in-memory index; tool writes go straight to disk,
then re-emit `INDEX.md`.

`scanCast` reads only top-level `*.md` per kind, so `archive/` subdirs and the whole `facts/` sidecar never appear in
the injected index. The exception is `lore/`, which also reads activated **bundle** subfolders (see
[Optional lore bundles](#optional-lore-bundles)).

Store identity and write rules:

- **Records are keyed on kind + id.** The same slug may exist under two kinds (for example `character/mira.md` and
  `lore/mira.md`, both hand-authored); both load and both appear in the index. `read` / `update` / `remove` need an
  explicit `kind` when the id is ambiguous. New slugs chosen by `save` and import never collide with any existing id.
- **Unknown frontmatter keys survive rewrites.** Keys a kind does not consume are carried through and re-emitted after
  the known keys on `update`, so hand-authored or future fields are not dropped.
- **Renames write before deleting.** An `update` whose new `name` slugifies differently writes the new file first, then
  removes the old one. Bundle lore stays inside its bundle directory on rename.
- **`auto` is reserved** for the `summary` and `timeline` carry-over files; `save` / `update` reject a name that would
  slugify to `auto` in those kinds.

The `summary` and `timeline` carry-over files serve cross-session continuity only. Within a session, resume, or fork,
scene memory lives on pi's session branch (see [Recap, timeline, and captured facts](#recap-timeline-and-captured-facts)
and [roleplay-internals.md](./roleplay-internals.md#branch-primary-scene-memory)).

## Record kinds

### `character`

The body holds voice, appearance, speech tics, hard constraints, first message, and example dialogue - the SillyTavern
character-card fields. Optional frontmatter controls how the sheet folds into the scene (see
[Scene folds](#scene-folds-characters--pov--pinned)):

| Field         | Example              | Meaning                                                                                               |
| ------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `pinned`      | `true`/`false`       | Always fold this sheet (budget permitting), ignoring triggers - the card analogue of lore `constant`. |
| `aliases`     | `[Kal'tsit, Doctor]` | Extra names/nicknames the fold keys on (the entry `name` is always an implicit key).                  |
| `triggers`    | `[the surgeon]`      | Extra keywords (OR'd with name + aliases) that also fold the sheet in.                                |
| `order`       | `10`                 | Eviction priority within a fold tier; higher is kept longer when a budget evicts. Default `0`.        |
| `sticky`      | `3`                  | Once folded, stay folded this many further turns without a re-match (anti-flicker). Default `3`.      |
| `cooldown`    | `0`                  | After the sticky window ends, cannot fold again for this many turns. Default `0`.                     |
| `probability` | `100`                | 0-100 chance the fold fires on a fresh match. Default `100`.                                          |
| `delay`       | `0`                  | Not eligible to fold until this many turns into the chat. Default `0`.                                |

These fields are read from disk on every scan (hand-authored values take effect after `/roleplay rescan` or the next
session start), and `save` / `update` can set `aliases`, `pinned`, `triggers`, and `order`. A bare card with no metadata
still folds on its own **name**. Matching reuses the lorebook rules (whole-word, case-insensitive, no-space scripts
matched without word boundaries) and timing machinery.

> Note: within the `pinned` tier and the name-triggered tier, sheets are ranked by `order` (highest first, ties by cast
> id), and both fold budgets evict from the end of that ranking. Persona-declared `characters` keep their listed order,
> and the POV sheet is never evicted.

Author list fields with **inline** arrays (`[a, b]`) - pi's frontmatter parser does not accept block (`- item`) lists.

### `lore`

The SillyTavern "World Info" equivalent and the main scaling lever: world detail lives in `lore` records that inject
**when their keywords appear in the latest narrative prompt**, or in the frozen recent window for depth-tagged records.
A large canon stays on disk and surfaces relevance-gated, a few entries at a time.

| Field           | Type                       | Meaning                                                                                                     |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `triggers`      | `[a, b, …]`                | Primary keywords, OR-combined. Any whole-word, case-insensitive hit fires the entry.                        |
| `secondaryKeys` | `[x, y, …]`                | Optional gate applied after a primary hit.                                                                  |
| `secondaryMode` | `AND`/`OR`/`NOT`/`NOT_ALL` | All present / any present / none present / not every one present (fires unless all are). Default `AND`.     |
| `constant`      | `true`/`false`             | Always inject (budget permitting), ignoring triggers. Default `false`.                                      |
| `order`         | integer                    | Priority; higher wins when the char budget forces eviction. Default `0`.                                    |
| `depth`         | integer                    | Insert this many messages from the end at the narrative boundary (see [Depth injection](#depth-injection)). |
| `recurse`       | `true`/`false`             | Opt in to having this entry's body re-scanned to trigger further lore. Default `false`.                     |
| `probability`   | `0`-`100`                  | Chance the entry fires when matched. Default `100`.                                                         |
| `sticky`        | integer                    | Once fired, stay active this many further turns without a re-match. Default `0`.                            |
| `cooldown`      | integer                    | After its active window ends, cannot fire again for this many turns. Default `0`.                           |
| `delay`         | integer                    | Not eligible to fire until this many turns into the chat. Default `0`.                                      |
| `group`         | string                     | Inclusion-group name; among fired members of a group only ONE survives per turn. Default `''`.              |
| `groupWeight`   | integer                    | Relative weight for the group's weighted-random pick. Default `100`.                                        |
| `enabled`       | `true`/`false`             | Author kill-switch. `false` silences the entry (never fires, never injects). Default `true`.                |

**Keyword matching.** Matching is whole-word and case-insensitive: `RI` matches `RI` / `(RI)` but not `spring`, and
multi-word or punctuation-bearing keys (`Northern Outpost`, `Dr. Vance`) match literally between token boundaries.
Letters, digits, and combining marks count as word characters. Scripts written without spaces (Han, Hiragana, Katakana,
Thai, Lao, Khmer, Myanmar) have no token boundaries, so the boundary is not required on a keyword edge whose character
is in one of those scripts (`阿米娅` fires in `阿米娅说`), and such a neighbor also counts as a boundary for other
keywords (`RI` fires in `罗德岛RI基地`). Hangul uses spaces and keeps strict boundaries.

**Selection.** Each narrative turn runs keyword matching, then optional recursion, then the timing pass, then the
budget:

1. **Recursion** (off by default, opt-in per entry with `recurse: true`, capped at `maxRecursion` passes, ceiling 2)
   re-scans matched bodies for further keyword hits. It runs **before** timing, so recursively matched entries obey
   `delay`, `cooldown`, `probability`, `sticky`, and inclusion groups exactly like direct matches.
2. **Timing** decides which matched entries actually fire: `delay` (ineligible until turn N), `cooldown` (blocked for N
   turns after the active window), `probability` (a roll on each fresh activation), `sticky` (stay active N further
   turns without a re-roll), and `group` (keep one fired member per group). A sticky entry still inside its window is
   the **incumbent** in its inclusion group and wins without a roll (several incumbents: highest `groupWeight`, then
   id); otherwise the winner is a `groupWeight`-weighted random pick. Group losers do not arm sticky or cooldown
   windows.
3. **Budget** ranks fired entries by `order` (then name) and keeps them until `loreCharBudget` is reached. The budget is
   measured against the whole rendered block, including its heading and the "lore budget reached" trailer. The single
   highest-priority entry is always kept even if it alone exceeds the budget.

Timing state is in memory only: it resets when pi restarts or the cast switches. Depth-tagged lore uses plain recent
window matching without the timing pass. Matching runs against the initiating user prompt or a `scheduled-prompt` custom
message; background completions, guardrail nudges, and retry notices do not select lore or advance timing.

`enabled: false` silences an entry in place without deleting or moving the file. It is **file-authored only**: it is not
a `roleplay` tool parameter, so the model cannot toggle canon on or off. Injected bodies are whitespace-normalized
(trailing whitespace stripped, blank-line runs collapsed), and an entry whose body is empty after normalization is
dropped before matching, so it can never win an inclusion group and starve a real sibling.

### `relationship`

A `relationship` record tracks how a pair feels about each other so a scene can resume where it left off:

```yaml
kind: relationship
affinity: 72 # 0-100 warmth/closeness; model-rewritten as scenes evolve
trust: high # free-form qualitative label
lastInteraction: 2026-06-07 # YYYY-MM-DD of the last shared scene; the decay anchor
openThreads: [the unanswered dinner invite, her curiosity about the Doctor's past]
```

Affinity **drifts toward a neutral baseline** (`relationshipBaseline`, default 50) while idle:
`relationshipDecayPerDay * whole-days-since(lastInteraction)`, clamped to `[0, 100]` and never overshooting the
baseline. No decay applies when `lastInteraction` is missing, unparseable, or in the future. Decay is a read-time
projection ([`relationship.ts`](../../../lib/node/pi/roleplay/relationship.ts)); the stored `affinity` only changes when
the record is rewritten. `/roleplay relationships` shows stored and projected values.

Through the tool, `affinity` clamps to 0-100 and `lastInteraction` must be a real calendar date in `YYYY-MM-DD` form, or
`""` to clear it; any other value is rejected.

### `summary` and `timeline`

Plain note records with no extra frontmatter: a `summary` body is a recap of a span, a `timeline` body is a dated list
of beats. The `auto` slug in each kind is the reserved carry-over file written by the recap and timeline machinery.
Every kind surfaces in the cast index and loads on demand via `roleplay read <id>`.

## Optional lore bundles

A cast's `lore/` dir is a two-tier store. Top-level `lore/*.md` is the always-on **base** lore. Alongside it, `lore/`
may hold any number of **named bundles** as subfolders (`lore/<bundle-name>/*.md`) - interchangeable groups of lore for
alternate settings, seasons, story arcs, or any other variant axis. A bundle is a generic named group with no hardcoded
domain (a cast might keep `apartment-loft` and `apartment-cabin` bundles and swap which is live per playthrough).
Bundles may be flat (`lore/<name>/*.md` -> `<name>`) or nested under grouping dirs to arbitrary depth
(`lore/<group>/<name>/*.md` -> `<group>/<name>`); a bundle is any dir under `lore/` that directly holds `*.md`. A pure
grouping dir with no `*.md` of its own is not itself a bundle.

**A bundle is inert unless activated.** Activation happens once at launch via `PI_ROLEPLAY_LORE_BUNDLES`, a
comma-separated list of bundle names (e.g. `PI_ROLEPLAY_LORE_BUNDLES=apartment-loft,winter-arc`). It is parsed with
[`parseLoreBundleSelection`](../../../lib/node/pi/roleplay/paths.ts) (split on commas, trim, drop blanks, dedupe keeping
the first occurrence).

**Precedence is deterministic.** Base lore loads first, then each activated bundle in listed order; later writes win on
the same id:

```text
base lore/*.md  <  bundles[0]  <  bundles[1]  <  …
```

An activated bundle file overrides a base file with the same id, and a later bundle overrides an earlier one. Bundles
add their non-colliding records on top of base. Unlisted bundles and incidental subfolders are never read. An activated
name with no matching subfolder is reported once as a scan warning and skipped.

Tool writes are bundle-aware: `read`, `update`, and `remove` on a bundle-sourced record act on `lore/<bundle>/<id>.md`,
and a rename keeps the file in the same bundle directory.

**`INDEX.md` is a complete map.** The generated index is a human/agent-facing artifact (never read at runtime) and lists
base lore plus **every** bundle on disk, not just the active selection. Base lore lists under `## Lore`; each bundle
gets a `### Lore bundle: <name>` subsection linking the real `lore/<bundle>/<id>.md` path. Runtime loading still reads
only the active selection. Regenerate with `/roleplay rescan` after direct on-disk edits; every tool `save` / `update` /
`remove` rewrites it too.

## What gets injected

Under a roleplay persona, each narrative turn delivers:

| Content                                                      | Where                                                 | Budget                  |
| ------------------------------------------------------------ | ----------------------------------------------------- | ----------------------- |
| `## Roleplay scene` (persona-declared, `pinned`, POV sheets) | System prompt                                         | `charBudget`            |
| `## Roleplay — cast: <slug>` index (one line per record)     | System prompt                                         | `charBudget`            |
| Name-triggered character sheets                              | `roleplay-scene-fold` reminder                        | `charBudget` (separate) |
| Keyword-fired lore (`## Roleplay lore …`)                    | `roleplay-lore` reminder                              | `loreCharBudget`        |
| Author's note + depth-tagged lore                            | Messages at their depth, or `roleplay-depth` reminder | `loreCharBudget` (lore) |
| Repetition nudge                                             | `roleplay-repetition` reminder                        | one line                |
| Queued scene event                                           | `roleplay-event` reminder                             | `eventMaxChars` (model) |
| Recap and timeline                                           | Prefix of the reduced conversation                    | see Configuration       |

The scene block and cast index are stable head state; full character bodies beyond the scene are fetched with
`roleplay read <id>`. Reminder blocks are emitted once per narrative run and captured by the default-on
[`cache-reminders`](./cache-reminders.md) coordinator, which replays the same snapshot through tool continuations. When
reminders are globally disabled (`PI_CACHE_REMINDERS_DISABLED=1`), lore, depth injection, repetition, and events are
off, and name-triggered sheets fall back into the system-prompt scene block. See
[roleplay-internals.md](./roleplay-internals.md#cache-stability) for why each piece lives where it does.

## Depth injection

The SillyTavern "insert at depth N" lever positions standing instructions in the **message array** near the live turn:

- **Author's note** - a short standing instruction from the active persona's `authorNote` frontmatter, inserted at
  `authorNoteDepth` (default 4) messages from the end. Use it for tone / style / pacing reminders that should sit close
  to the model's next turn.
- **Depth-tagged lore** - any `lore` entry with a `depth:` field. These are excluded from the keyword-fired block and
  match the **prior `scanDepth` messages** (default 10) plus the initiating narrative prompt. They are budgeted by
  `loreCharBudget`, skip the timing pass, and a `constant` depth record fires on every narrative turn.

`depth: 0` appends after the initiating input, `depth: 1` inserts just before it, and a depth larger than the history
clamps to the start. A depth that would split an assistant's tool-call/result batch moves before that batch. Placement
is fixed for the whole run: tool continuations replay it and never select new lore. By default each insertion is its own
`user`-role message; `depthLoreInlineTail: true` merges everything at depth 0 into one `roleplay-depth` reminder block
instead. Measurements and tradeoffs for that switch are in
[roleplay-internals.md](./roleplay-internals.md#depth-injection-delivery-shape). Disable the whole path with
`PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1`.

## Scene folds (`characters` / `pov` / `pinned`)

The cast index is deliberately lightweight. To put a character's **whole sheet** in front of the model, a sheet folds in
from any of three sources:

1. **Persona-declared** - the active persona lists on-stage members + the player POV:

   ```yaml
   roleplay: true
   characters: [Exusiai, Texas] # full bodies folded into the system prompt, in this order
   pov: Doctor # the character the human plays
   openers: ['Yo, Doctor!', '...'] # greeting lines, surfaced via `/persona opener`
   ```

2. **`pinned` character** - a card with `pinned: true` folds every turn, no persona list needed.
3. **Name-triggered** - any character whose name, alias, or extra trigger appears in the recent window (`scanDepth`
   messages plus the current prompt) folds in for the scene, kept alive by its `sticky` window. This lets an NPC
   introduced mid-scene be voiced correctly on a later turn without a `roleplay read`.

**Delivery.** Persona-declared, `pinned`, and POV sheets are stable and stay in the system-prompt `## Roleplay scene`
block. Name-triggered sheets go to a separate `roleplay-scene-fold` reminder (`## Roleplay scene: on-stage characters`)
so NPCs entering and leaving the window do not rewrite the cached system prompt. A sheet already in the head is never
sent again in the reminder. A name-triggered sheet is (re)sent when it enters the active set, has never been delivered,
or was last delivered `sceneFoldRefreshTurns` (default 6) or more narrative turns ago; otherwise the earlier reminder
snapshot still carries it. With the rolling context window on, the refresh is clamped to at most `keepTurns - 1` so a
sheet is re-sent before the turn carrying it ages out of the verbatim window, and a compaction re-sends every active
sheet. Set `sceneFoldDelivery: "system"` to restore the legacy behavior of folding name-triggered sheets into the head
block; the same fallback applies automatically when reminders are globally disabled.

**Rendering.** Each sheet renders under a `### <Name>` heading (deduped). The head block announces
`The user plays **<pov>**.` and renders the POV sheet last, tagged `(player character)`. Names resolve by record id,
then case-insensitive name, then name slug. Unresolved persona names are dropped with a one-time warning. A `pov` that
is not in the cast still produces the announcement line.

**Precedence and eviction.** Each block has its own `charBudget` cap.

- Head block: persona-declared sheets (listed order), then `pinned`, then (in `system` delivery only) name-triggered
  sheets, with POV last. The `pinned` and name-triggered tiers are each ranked by `order` descending, ties by cast id.
  Eviction drops from the tail of that order; the POV sheet is never evicted, and when there is no POV sheet the first
  sheet is always kept.
- Reminder block: name-triggered sheets ranked by `order` descending, ties by cast id; the first is always kept, later
  ones drop with a trailer.

**Macro stability.** Sheets in the system-prompt head resolve macros against the session's start time and a random
source seeded per session and entry, so `{{time}}`, `{{random}}`, and `{{roll}}` stay byte-identical across turns,
resume, and `/reload`. Reminder sheets, lore, depth text, and the author's note keep live macros.

`/persona opener [n]` prints the active persona's greeting lines (all numbered, or just entry `n`); see
[`persona.md`](./persona.md).

## Macros

SillyTavern cards and lorebooks routinely embed `{{user}}` / `{{char}}`, so injected text runs through
[`macros.ts`](../../../lib/node/pi/roleplay/macros.ts) when a body is read. Substitution happens before the budget math.
Macro names are case-insensitive; any argument after the first `:` keeps its case.

| Macro                         | Resolves to                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{{user}}`                    | the persona `pov` (player character) name                                                                    |
| `{{char}}`                    | the in-context character: a folded sheet uses **that** character, lore/notes the primary persona character   |
| `{{time}}` / `{{date}}`       | `HH:MM` (24h, local) / `YYYY-MM-DD`                                                                          |
| `{{weekday}}`                 | e.g. `Sunday`                                                                                                |
| `{{random:a,b,c}}`            | one comma-separated option, picked at random (options trimmed)                                               |
| `{{roll:NdM}}` / `{{roll:M}}` | sum of `N` `M`-sided dice (`N` defaults to 1); more than 100 dice or more than 1,000,000 sides stays literal |
| `{{newline}}`                 | a literal newline                                                                                            |

Resolution is forgiving: an unknown macro, an out-of-range roll, or `{{user}}` / `{{char}}` with no value in context is
**left literal** rather than blanked. Macros apply to folded sheets, fired lore bodies, and the author's note, in a
single non-recursive pass. Openers are surfaced by `persona` and are not macro-substituted.

## Recap, timeline, and captured facts

On a small context window, pi's threshold compaction see-saws: most of the window is a fixed system prompt, so each
compaction reclaims little. Instead the extension reduces the conversation itself in the `context` hook every turn. The
reduction is a non-destructive overlay: the full transcript stays in the session file, the model is just sent less.

From oldest to newest, the model sees: a narrative **recap** of dropped history, older uncovered messages **condensed**
head+tail, and the last `keepTurns` user turns (default 8) **verbatim**. Drop boundaries always land on a user message,
so an assistant tool call is never separated from its result.

| Mode                | When                                         | Behavior                                                                                                                     |
| ------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bounded recap mode  | summarize on (default) and context window on | Covered history is dropped and replaced by the recap; pi's **threshold** compaction is cancelled when a summarizer resolves. |
| Condense-only floor | `PI_ROLEPLAY_DISABLE_SUMMARIZE=1`            | Older prose is condensed but kept; pi's compaction remains the backstop.                                                     |
| Off                 | `PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW=1`       | No reduction; only the compaction-time side-write below runs.                                                                |

Recaps are generated only when a summarize model (see [Configuration](#configuration)) and the summarizer agent resolve.
Recap mode cancels pi's threshold compaction only while a summarizer resolves; without one it covers nothing, so pi's
threshold compaction runs normally and summarizes the history instead. In every mode with the window on, a hard safety
floor drops the oldest whole turns if the reduced prompt would still overflow the session model's context window.

**The recap** is a thin narrative layer (recent events, mood, open threads) written by the
[`roleplay-summarizer`](../agents/roleplay-summarizer.md) agent. It rolls every `recapStride` aged messages (default:
`recapChunk`, 8), merging at most `recapMaxAdvance` messages per roll. Rejected or over-length candidates are held back,
and once coverage lags `recapLagCeiling` or more messages the best candidate is force-accepted so coverage cannot stall
forever. `/roleplay recap` shows the current recap and coverage; `/roleplay recap force` makes the next context pass
roll regardless of the stride. The recap runs synchronously on the session model, or asynchronously when a distinct
`summarizeModel` is configured (override with `recapAsync` / `PI_ROLEPLAY_RECAP_ASYNC`).

**Persistence.** Each roll stamps the recap and its exact coverage on the session branch, so resume, fork, and tree
navigation continue the right recap. Each roll also refreshes the per-cast carry-over `summary/auto.md`. A genuinely new
session seeds its recap text from that carry-over without treating any of its own messages as covered.
`/roleplay newscene` archives the carry-overs and starts the next turn cold.

**Compaction.** Threshold compaction is cancelled in recap mode when a summarizer resolves (otherwise pi compacts
normally); manual `/compact` and overflow recovery still run. On those paths the evicted span is folded into the current
branch recap and stamped on the branch as a `compact` audit entry, without resetting lorebook timing. After any
successful compaction, recap coverage resets to 0 (the old message indices no longer apply) while the recap and timeline
text are kept, and the next turn does not roll: the compaction summary is never fed back into the recap.

**Timeline** (opt-in, `timeline: true` or `PI_ROLEPLAY_TIMELINE=1`, requires recap mode) appends dated story beats
extracted from each rolled span. Beats are never re-summarized, so they do not drift. Beats append to `timeline/auto.md`
(rotating its older half into `timeline/archive/<ts>-<pid>-<rand>-rotated.md` past `timelineFileMaxChars`), and a
compact recent-beats block capped at `timelineMaxInjectChars` is injected as its own prefix beside the recap.

**Fact capture** (opt-in, `capture: true` or `PI_ROLEPLAY_CAPTURE=1`, requires recap mode and a session id) extracts
self-contained facts from each rolled span into `memory`'s session (`note`) tier and mirrors them to `facts/<slug>.md`,
which seeds future sessions.

Mechanics (zones, roll cadence, span cap, collapse guard, wedge breaker, hydration ladder, fact taxonomy) are in
[roleplay-internals.md](./roleplay-internals.md#rolling-context-window).

## Repetition nudge

The extension scans the recent assistant replies for repeated word n-grams and, when one crosses `repetitionMinCount`,
injects a one-line "vary your phrasing" `roleplay-repetition` reminder. It never rewrites output. N-grams that appear in
the cast's `character` bodies (speech tics, canon lines) are excluded, so a signature catchphrase is never flagged. Tune
with the `repetition*` config keys; disable with `PI_ROLEPLAY_DISABLE_REPETITION=1`.

## Scene events (`/roleplay event`)

`/roleplay event [hint]` queues a one-shot in-world **complication** - a knock at the door, a revealed motive, a sudden
choice - injected as a private director note (`roleplay-event` reminder) for the **next narrative reply only**. It is
acknowledged once the reminder coordinator captures it, then cleared at the following narrative boundary. Operational
notifications and events queued during a tool loop do not consume it.

Source order:

- **LLM-generated by default** (and always when a `hint` is given): the [`roleplay-event`](../agents/roleplay-event.md)
  agent receives the recent scene, the cast's one-line descriptors, and, when `eventSeedThreads` is on, relationship
  `openThreads` to escalate. The result is truncated to `eventMaxChars`. An empty response or a `null` / `None` sentinel
  (any case, ignoring surrounding quotes and punctuation) counts as no event.
- **Deck fallback**: when nothing is generated, one entry is drawn at random from the `events` deck in `roleplay.json`
  and queued, truncated to `eventMaxChars`. With an empty deck the command reports that nothing is available.

The generator inherits the parent session model unless `eventModel` is set (resolution order
`<cwd>/.pi/roleplay-event.json` > `~/.pi/agent/roleplay-event.json` > `~/.pi/agent/settings.json`
`roleplay.eventModel`). Disable with `PI_ROLEPLAY_DISABLE_EVENTS=1`.

## The `roleplay` tool

| Action   | Required                               | Optional | Purpose                                        |
| -------- | -------------------------------------- | -------- | ---------------------------------------------- |
| `list`   | -                                      | -        | Dump the active cast index.                    |
| `read`   | `id`                                   | `kind`   | Load a record's full body.                     |
| `save`   | `name`, `description`, `body`          | `kind`   | Write a new record + rebuild `INDEX.md`.       |
| `update` | `id` + a field (core or kind-specific) | `kind`   | Rewrite fields; renames change the slug.       |
| `remove` | `id`                                   | `kind`   | Delete a record + drop it from `INDEX.md`.     |
| `search` | `query`                                | -        | Case-insensitive match over name/desc/id/body. |

`kind` defaults to `character` for `save`. When an id exists under more than one kind, `read` / `update` / `remove` need
an explicit `kind`. Kind-specific parameters:

| Kind           | Parameters                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `lore`         | `triggers`, `secondaryKeys`, `secondaryMode` (`AND`/`OR`/`NOT`/`NOT_ALL`), `constant`, `order`, `depth`, `recurse` |
| `character`    | `aliases`, `pinned`, `triggers`, `order`                                                                           |
| `relationship` | `affinity` (clamped 0-100), `trust`, `lastInteraction` (`YYYY-MM-DD`, or `""` to clear), `openThreads`             |

An `update` may change only kind-specific fields; an omitted `body` is preserved from disk. A negative `depth` clears
it. `update` and `remove` act on the record's real file, including bundle lore. `save` and renames reject the reserved
`auto` slug in `summary` / `timeline`. All actions operate on the **active cast**.

## Scene images: simple, full, or off

`/roleplay images` shows the current interface. `/roleplay images simple|full|off` changes it for this session,
persisted on the selected branch across resume, reload, and tree navigation. Set `imageMode` in the normal project/user
configuration for a persistent default; the session override wins. The shipped default is `full`.

| Mode     | Model-facing interface                                                     | Behavior                                                                                               |
| -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `simple` | `roleplay_image({ "prompt": "Illustrate Mira beside the rainy window." })` | One scene description, automatic identity context, required prompt writer, foreground ephemeral image. |
| `full`   | Existing `generate_image` and allowlisted `image_jobs`                     | Existing workflow, reference, reuse, background, and refinement controls.                              |
| `off`    | Neither image interface                                                    | Roleplay continues without model-callable image generation.                                            |

A persona with an explicit tool allowlist must include `generate_image` or `roleplay_image` to grant image access; the
mode selects the interface, not permission. Include `image_jobs` too if full-mode background collection is wanted. An
explicit allowlist omitting both image tools remains image-free in every mode; without an allowlist, registered image
interfaces are available. Coding personas keep their normal ComfyUI tools and never receive `roleplay_image`. The facade
requires the enabled/configured ComfyUI extension.

```jsonc
// roleplay.json, user-global or project-local
{
  "imageMode": "simple",
  "imageWorkflow": "qwen-image-edit-2.1", // optional; otherwise use ComfyUI's defaultWorkflow
}
```

Simple mode hides the full tool schema and skips ComfyUI's main-agent usage-guidance files. The roleplay model describes
subjects, actions, and mood in ordinary language. The existing `comfyui-enhance` agent writes the selected workflow's
native protocol using its global/per-workflow guidance; illustration/anime style does not imply Danbooru tags, and
tag-shaped input is translated when the workflow expects natural language. Model selection and timeout remain
`enhanceModel` / `enhanceTimeoutMs` in ComfyUI configuration. A missing, disabled, timed-out, or unsuccessful writer
fails without submitting the raw prompt; full mode retains its existing best-effort fallback.

The facade shares ComfyUI's executor and gallery, image-generated event, cancellation, and ephemeral collapse state.
Only mapped generation defaults apply; unsupported negative prompts are ignored. Simple mode uses a named still-image
workflow with no supplied references, forces foreground ephemeral output, and disables automatic refinement. Use full
mode for reference-dependent workflows, video, background jobs, and direct workflow files. Ephemeral images appear to
the user but never enter the roleplay model's context. The saved full-resolution files remain available in the gallery.

### Authored visual identities

Put compact, workflow-independent appearance prose inside named blocks in a persona body (including its inherited body,
addendum, or system-prompt override), character sheet, or active lore entry:

```xml
<visual-identity character="Mira">
Mira is an adult woman with shoulder-length silver hair, green eyes,
and a lean build. A small scar cuts through her left eyebrow.
Her usual outfit is a dark red jacket, black trousers, and leather boots.
The jacket is usual clothing, not a permanent identity feature.
</visual-identity>
```

Tags must occupy their own lines and names must use double quotes. Multiple named blocks are allowed. Keep each body at
or below 2000 characters; empty, malformed, nested, unclosed, and oversized blocks are skipped with local diagnostics.
No block means no whole-persona/sheet fallback. Write plain visual facts, not Danbooru tags, quality tokens, workflow
instructions, or a finished prompt. These blocks do not reduce the persona text sent to the roleplay model itself.

Persona blocks are extracted at activation. Character-sheet blocks are read from the active cast at image-call time;
normal macros are resolved. Only lore selected for the current narrative snapshot contributes blocks, respecting enabled
flags, active bundles, and the normal injection budgets. Image requests never activate dormant lore.

Character names, ids, and aliases in the image request select identities. Without named subjects, recent scene mentions
and persona-declared characters/POV provide background candidates, not a command to depict the whole cast. Conflicts
resolve by **active lore > character sheet > persona**, then first source in selection order; identical duplicates are
silent and conflicting sources produce a local diagnostic. This is whole-block replacement: an overriding lore identity
should include the complete appearance, not just a clothing fragment. Current scene clothing, pose, injuries, and
expression remain separate temporary state, and deliberate alternate-appearance requests can override canon.

The writer receives only the scene request, relevant extracted identities, up to 2000 characters of recent
user/assistant scene text, and workflow guidance. The continuity context has a strict 6000-character total cap; whole
identities take priority over dialogue. It never includes entire persona files or unselected lore, and does not append
ComfyUI's independently captured conversation. Missing identities and budget omissions are reported locally, not
injected into the roleplay conversation.

Extraction/context planning lives in [`visual-identity.ts`](../../../lib/node/pi/roleplay/visual-identity.ts); tool
selection and branch-mode restoration live in [`image-tools.ts`](../../../lib/node/pi/roleplay/image-tools.ts).

## `/roleplay` command

| Verb                                | Effect                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none) / `list`                     | Show the active cast index (or the dormant note).                                                                                                                     |
| `context` (aliases `ctx`, `window`) | Show the last context-window pass: message counts, cutoffs, which boundary binds, recap size, token estimates, prefix-cache reuse, and backlog drain.                 |
| `lore`                              | Show the last narrative turn's lore selection (keyword lore kept / dropped by budget, depth lore kept / dropped), active bundles, and live sticky / cooldown windows. |
| `recap [show]`                      | Show recap mode, recap model, coverage cutoffs, in-flight / forced status, the recap text, and a preview of the injected timeline block.                              |
| `recap force`                       | Arm a forced roll: the next context pass rolls the recap regardless of the stride (waits for an in-flight async roll). Refused when recap mode is off.                |
| `relationships` (alias `rel`)       | List relationship records sorted by name with stored and decayed affinity, trust, last interaction (and days since), and open threads.                                |
| `cast <name>`                       | Set the active-cast override (effective once a `roleplay: true` persona is active). With no name, print the active cast.                                              |
| `import <path.json\|.png>`          | Import a SillyTavern card into the active cast (see below).                                                                                                           |
| `export [character] [path]`         | Export a character + the active lore as a Character Card V2 JSON (see below).                                                                                         |
| `event [hint]`                      | Queue a one-shot scene complication for your next reply.                                                                                                              |
| `images [simple\|full\|off]`        | Show or change the image interface.                                                                                                                                   |
| `newscene`                          | Archive the recap / timeline / captured-fact carry-overs, mark the branch, and clear in-memory scene state so the next turn starts cold.                              |
| `dir`                               | Print the store root + active cast dir.                                                                                                                               |
| `rescan`                            | Re-read the active cast from disk and rebuild `INDEX.md` from the complete on-disk inventory (base + every lore bundle).                                              |
| `casts`                             | List every cast directory on disk (active one marked `*`).                                                                                                            |
| `help` / `--help` / `-h` / `?`      | Print USAGE.                                                                                                                                                          |

Argument completion covers verbs, `cast` names, `recap` modes, `images` modes, and `export` character ids.

## Importing SillyTavern cards

`/roleplay import <path>` ingests a SillyTavern / TavernAI **character card** into the active cast. The path may be
quoted (one pair of matching `"` or `'`), may start with `~` or `~/`, and resolves relative paths against the session
cwd. It accepts:

- `.json` - a Character Card V1 (flat), V2 (`chara_card_v2`), or V3 (`chara_card_v3`) export; and
- `.png` - a card image with the JSON embedded in a `chara` (V2) or `ccv3` (V3) `tEXt` chunk (base64). V3 wins when both
  chunks are present.

The importer writes:

- **one `character` record** whose body folds `description`, `personality`, `scenario`, `first_mes`, `mes_example`,
  `system_prompt`, `post_history_instructions`, and `alternate_greetings` into labelled sections. The record description
  comes from `creator_notes`, then `personality`, then `description`. A V3 `nickname` that differs from the name becomes
  an `aliases` entry; and
- **one `lore` record per non-empty `character_book` entry**, mapped as follows (knobs are read from the entry's
  `extensions` with a flat fallback, as SillyTavern does):

| Card field                                                                                             | Lore field                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `keys`                                                                                                 | `triggers`                                                         |
| `secondary_keys` (when `selective`)                                                                    | `secondaryKeys`                                                    |
| `selectiveLogic` 0 (default) / 1 / 2 / 3                                                               | `secondaryMode` `OR` / `NOT_ALL` / `NOT` / `AND`                   |
| `constant`, `insertion_order`                                                                          | `constant`, `order`                                                |
| `extensions.position` 4 ("at depth")                                                                   | `depth` from `extensions.depth` (default 4); other positions unset |
| `probability` (unless `useProbability: false`), `sticky`, `cooldown`, `delay`, `group`, `group_weight` | same-named lore fields                                             |
| `enabled: false`                                                                                       | `enabled: false` (imported, not skipped)                           |

`recurse` stays off: SillyTavern has no per-entry recursion opt-in. Warnings list empty entries (skipped), disabled
entries (imported with `enabled: false`), entries with no keys that are not constant, and knobs the store cannot honor:
regex-shaped keys (`/pattern/flags`, matched as literal text), `case_sensitive: true`, and `match_whole_words: false`
(matching stays case-insensitive and whole-word). The summary lists every record written. Decoding and mapping are pure
([`lib/node/pi/card-import/`](../../../lib/node/pi/card-import/)).

## Exporting a card

`/roleplay export [character] [path]` writes a SillyTavern **Character Card V2** JSON:

- **Character.** A leading token that resolves to a cast character (id, name, or name slug) selects it. Otherwise the
  default is the persona's primary character (first non-POV `characters` entry), then the first character record. A
  leading token that does not resolve and does not look like a path (no `.`, `/`, `~`, or `\`) is an error.
- **Path.** Defaults to `<session cwd>/<character-id>.card.json`. Quoting, `~` expansion, and relative resolution follow
  the import rules. The export **never overwrites** an existing file.
- **Lore.** Every lore record loaded for the active cast is included as `character_book` entries: base lore plus the
  activated bundles (after bundle overrides), depth lore included, and disabled entries with `enabled: false`. The book
  is omitted when the cast has no lore.

Field mapping is the inverse of the importer. When the character body uses the importer's labelled-section layout, each
section maps back to its card field (alternate greetings split from the numbered list); otherwise the whole body becomes
`description`. The record's one-line `description` goes to `creator_notes`, so a re-import restores it. Lore maps
`triggers` -> `keys`, `secondaryKeys` -> `secondary_keys` (`selective` when non-empty), `secondaryMode` ->
`extensions.selectiveLogic` (OR=0, NOT_ALL=1, NOT=2, AND=3), `order` -> `insertion_order`, `depth` ->
`extensions.position: 4` + `extensions.depth`, and `probability` / `sticky` / `cooldown` / `delay` / `group` /
`groupWeight` to their `extensions` counterparts. Character fold metadata (`aliases`, `pinned`, ...) is not exported.

## Configuration

Budgets and dials are preferences, exposed via a `roleplay.json` config layer
([`lib/node/pi/roleplay/config.ts`](../../../lib/node/pi/roleplay/config.ts)). Resolution order:
`project (<cwd>/.pi/roleplay.json)` > `user (~/.pi/agent/roleplay.json)` > env knobs > built-in default. Out-of-range
values are clamped to the bounds below; wrong types are ignored.

```jsonc
{
  "imageMode": "full", // full (default), simple, or off
  "imageWorkflow": "qwen-image-edit-2.1", // optional simple-mode workflow; absent = ComfyUI default
  "charBudget": 3000, // cast-index block cap, also each scene-fold block (default 3000, floor 500)
  "loreCharBudget": 3000, // fired-lore block cap, also depth lore (default 3000, floor 500)
  "maxRecursion": 0, // lorebook recursion passes, 0 = off (default 0, max 2)
  "scanDepth": 10, // recent messages scanned for depth lore, folds, and events (default 10, 1-100)
  "depthLoreInlineTail": false, // merge depth-0 chunks into one roleplay-depth reminder (default false)
  "relationshipDecayPerDay": 1, // affinity points drifted toward baseline per idle day (default 1, >= 0)
  "relationshipBaseline": 50, // neutral resting affinity (default 50, 0-100)
  "summarizeMinMessages": 4, // min messages in a span before a recap or extraction runs (default 4, >= 1)
  "summarizeMaxChars": 1500, // cap on a recap body (default 1500, floor 200)
  "repetitionEnabled": true, // multi-turn repetition nudge (default true)
  "repetitionNgram": 5, // word-n-gram length compared across replies (default 5, 2-12)
  "repetitionWindow": 6, // recent assistant replies scanned (default 6, 1-50)
  "repetitionMinCount": 2, // occurrences across the window before flagging (default 2, >= 2)
  "events": [], // fallback complication deck for `/roleplay event` (default [])
  "eventMaxChars": 280, // cap on a generated or deck-picked scene event (default 280, floor 40)
  "eventSeedThreads": true, // offer relationship openThreads to the event generator (default true)
  "keepTurns": 8, // recent user turns kept verbatim (default 8, 1-200)
  "recapChunk": 8, // aged messages per roll when recapStride is 0 (default 8, 1-500)
  "windowAssistantChars": 200, // condense budget for older assistant text (default 200, floor 40)
  "windowUserChars": 400, // condense budget for older user text (default 400, floor 40)
  "recapStride": 0, // roll cadence in aged messages; 0 = follow recapChunk (default 0, 0-500)
  "recapMaxAdvance": 24, // max messages one roll adds to recap coverage; 0 = unbounded (default 24, 0-5000)
  "recapLagCeiling": 96, // force-accept a recap once coverage lags this many messages; 0 = off (default 96, 0-5000)
  "recapAsync": null, // force async (true) / sync (false) recap; null = auto by endpoint (default null)
  "capture": false, // deterministic fact capture on the roll -> memory notes (default false)
  "timeline": false, // additive timeline of dated beats on the roll (default false)
  "timelineMaxInjectChars": 1200, // cap on the injected timeline block (default 1200, floor 200)
  "timelineFileMaxChars": 65536, // rotate timeline/auto.md past this size (default 65536, floor 4096)
  "timelineMemoryMaxChars": 32768, // cap on the in-memory timeline log, newest lines kept (default 32768, floor 1024)
  "sceneFoldDelivery": "reminder", // name-triggered sheets: reminder (default) or system
  "sceneFoldRefreshTurns": 6, // re-send a still-active name-triggered sheet after N turns (default 6, 1-100)
}
```

The recap **model** is resolved separately: set `roleplay.summarizeModel` in `~/.pi/agent/settings.json`, or a
`summarizeModel` key in `roleplay-summarize.json` (project or user). With no model resolved, no recap is generated and
the compaction side-write is skipped. The fact and timeline extractors use the same model. The scene-event **model**
(`eventModel`) resolves the same way (`roleplay.eventModel` in `settings.json`, or a `roleplay-event.json`) but is
optional.

Prompt guidance for the summary, timeline, facts, and event agents can be overridden with a markdown file at
`<cwd>/.pi/roleplay/prompts/<name>.md` (project) or `<roleplay root>/prompts/<name>.md` (user), where `<name>` is
`summary`, `timeline`, `facts`, or `event`. Only the editable guidance section is replaced; the output contract stays
fixed.

## Environment variables

Env knobs that mirror config keys sit below both config files.

- `PI_ROLEPLAY_DISABLED=1` - skip the extension entirely (no tool, no command, no injection).
- `PI_CACHE_REMINDERS_DISABLED=1` - suppress managed reminders globally: lore, depth injection, repetition, and events
  turn off, and name-triggered sheets fall back into the system-prompt scene block. Scene/index prompts and context
  window management remain.
- `PI_ROLEPLAY_DISABLE_AUTOINJECT=1` - keep the tool but skip the `## Roleplay` blocks and lore selection.
- `PI_ROLEPLAY_DISABLE_LOREBOOK=1` - keep the cast-index injection but skip keyword and depth lore.
- `PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1` - skip depth-tagged lore and author's-note placements.
- `PI_ROLEPLAY_DISABLE_SUMMARIZE=1` - drop recap mode and the compaction side-write; the window degrades to the
  condense-only floor.
- `PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW=1` - skip the rolling reduction entirely and defer to pi.
- `PI_ROLEPLAY_CONTEXT_TURNS=N` - `keepTurns`.
- `PI_ROLEPLAY_RECAP_CHUNK=N` - `recapChunk`.
- `PI_ROLEPLAY_RECAP_STRIDE=N` - `recapStride` (0 = follow `recapChunk`).
- `PI_ROLEPLAY_RECAP_MAX_ADVANCE=N` - `recapMaxAdvance` (0 = unbounded).
- `PI_ROLEPLAY_RECAP_LAG_CEILING=N` - `recapLagCeiling` (0 = disabled).
- `PI_ROLEPLAY_CONTEXT_ASSISTANT_CHARS=N` / `PI_ROLEPLAY_CONTEXT_USER_CHARS=N` - `windowAssistantChars` /
  `windowUserChars`.
- `PI_ROLEPLAY_RECAP_ASYNC=1|0` - `recapAsync` (default: async only when a distinct recap endpoint is configured).
- `PI_ROLEPLAY_CONTEXT_DEBUG=1` - append a per-turn `roleplay-context-window-debug` session entry (token estimates and
  cutoffs); never sent to the LLM.
- `PI_ROLEPLAY_CAPTURE=1` - `capture` (requires recap mode + a session id).
- `PI_ROLEPLAY_TIMELINE=1` - `timeline` (requires recap mode).
- `PI_ROLEPLAY_DISABLE_REPETITION=1` - skip the repetition nudge.
- `PI_ROLEPLAY_DISABLE_EVENTS=1` - disable `/roleplay event`.
- `PI_ROLEPLAY_DISABLE_PROMPT_OVERRIDES=1` - ignore every `prompts/<name>.md` override.
- `PI_ROLEPLAY_LORE_BUNDLES=nameA,nameB` - activate lore bundles at launch, ascending precedence. See
  [Optional lore bundles](#optional-lore-bundles).
- `PI_ROLEPLAY_DISABLE_AVATAR=1` - stop driving the [`avatar`](./avatar.md) face from the active cast.
- `PI_ROLEPLAY_DISABLE_SCENEGEN=1` - stop mirroring generated scene images into the avatar's `scene` banner.
- `PI_ROLEPLAY_MAX_INJECTED_CHARS=N` - `charBudget` (floor 500).
- `PI_ROLEPLAY_ROOT=<path>` - override `~/.pi/agent/roleplay` (useful for testing / per-host profiles).

## Composition with other extensions

| Extension                                    | Interaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`persona.ts`](./persona.md)                 | The master gate. `roleplay: true` (+ optional `cast:`) activates this extension; `characters` / `pov` declare scene folds; `authorNote` / `authorNoteDepth` supply the author's note; `openers` feed `/persona opener`.                                                                                                                                                                                                                                                                         |
| [`memory.ts`](./memory.md)                   | Independent store and tool. Fact capture writes into `memory`'s session (`note`) tier. Both can be active at once.                                                                                                                                                                                                                                                                                                                                                                              |
| [`cache-reminders.ts`](./cache-reminders.md) | Captures the `roleplay-*` reminder blocks once per run and replays them through tool continuations; `PI_CACHE_REMINDERS_DISABLED` turns the reminder-delivered features off.                                                                                                                                                                                                                                                                                                                    |
| [`avatar.ts`](./avatar.md)                   | Roleplay publishes the active character's sprite-set into the avatar-input slot ([`avatar/input.ts`](../../../lib/node/pi/avatar/input.ts)). The set slug resolves as: persona `avatarSet` > first non-POV `characters` entry > first `characters` entry > `cast` slug. `avatarSet` decouples the face from the cast store (e.g. `cast: exusiai-isekai` + `avatarSet: exusiai`). A `portraits/<slug>.png` for the active character overrides the sprite. Gated by `PI_ROLEPLAY_DISABLE_AVATAR`. |
| [`comfyui.ts`](./comfyui.md)                 | Roleplay subscribes to comfyui's image-generated bus ([`comfyui/events.ts`](../../../lib/node/pi/comfyui/events.ts)) and mirrors the latest render into the avatar's `scene` banner while a scene is active. Simple image mode delegates prompt writing with bounded visual identities. comfyui has no dependency on roleplay. Gated by `PI_ROLEPLAY_DISABLE_SCENEGEN` (and `PI_ROLEPLAY_DISABLE_AVATAR`).                                                                                      |

## Hot reload

Edit [`roleplay.ts`](./roleplay.ts) or any helper under
[`../../../lib/node/pi/roleplay/`](../../../lib/node/pi/roleplay/) and run `/reload`. Agent edits
([`roleplay-summarizer`](../agents/roleplay-summarizer.md),
[`roleplay-fact-extractor`](../agents/roleplay-fact-extractor.md),
[`roleplay-timeline-extractor`](../agents/roleplay-timeline-extractor.md),
[`roleplay-event`](../agents/roleplay-event.md), including sampler `requestOptions`) apply on the next spawn without a
reload. Rolling-window state is per-process and reset on `session_start` / `session_tree` / `session_shutdown`; the next
context pass re-hydrates the recap from the session branch, falling back to the `summary/auto.md` carry-over.

## Related docs

- [roleplay-internals.md](./roleplay-internals.md) - design rationale, cache-stability notes, recap mechanics, and the
  pure helper module index.
- [persona.md](./persona.md) - persona frontmatter that activates and shapes roleplay.
- [cache-reminders.md](./cache-reminders.md) - reminder snapshot delivery used by lore, scene folds, events, and depth
  blocks.
