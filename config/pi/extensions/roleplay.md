# `roleplay.ts`

A cast-keyed durable store for roleplay scenarios, deliberately **separate** from the coding-agent
[`memory`](./memory.md) extension so it can be turned off wholesale without touching the coding surface. Where `memory`
keys durable notes on cwd / session, `roleplay` keys on **cast** - a character or ensemble that travels with you across
workspaces. This implements Phases 1-5 + 7A-B of the roleplay design: the store + `character` records (Phase 1), the
keyword-triggered **lorebook** (`lore` records, Phase 2), the **SillyTavern card importer** (Phase 3), **depth
injection** (author's note + depth-tagged lore via the `context` event, Phase 4), persona **scene fold** (`characters` /
`pov`, Phase 5), the **relationship / summary / timeline** record kinds with affinity decay (Phase 7A), and
**auto-summarization** of evicted history at compaction (Phase 7B), now generalized into a **rolling bounded context
window** that owns threshold compaction on a small model (see below). The remaining phase adds avatar sprites (Phase 6).
Two additive, non-destructive features sit alongside the phase plan: a multi-turn **repetition / anti-slop nudge** and a
**scene-event system** (`/roleplay event`), both described below.

## Activation gate

The roleplay tool, cast scan, and `## Roleplay` system-prompt block are **dormant** unless the active
[`persona`](./persona.md) declares `roleplay: true` in its frontmatter. This keeps the feature off for coding personas
and for personas used as subagent implementations - you opt a persona in explicitly. With no qualifying persona active:

- the `roleplay` tool returns an error (`roleplay is inactive: activate a persona with roleplay: true …`);
- the `roleplay` tool is removed from the active-tools set, so its `promptSnippet` (the **Available tools** line) and
  `promptGuidelines` (the **Guidelines** bullets) are kept out of the system prompt entirely - not just made
  non-callable. This gate runs at `session_start` / `session_tree` (not only `before_agent_start`): `setActiveTools`
  rebuilds the base prompt, and doing it at session-lifecycle time keeps even the **first** turn's prompt clean.
  Removing the tool inside `before_agent_start` alone would leak the lines on turn 1, because other autoinject
  extensions (memory / scratchpad / todo) compose their additions off the pre-removal prompt snapshot the runner takes
  before handlers run;
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
    ├── summary/
    │   ├── auto.md              ← carry-over recap (scanned entry; cross-session seed for new trees)
    │   └── archive/<ts>.md      ← `/roleplay newscene`-archived prior carry-overs
    ├── timeline/
    │   ├── auto.md              ← carry-over timeline (append-log of dated beats)
    │   └── archive/<ts>.md
    └── facts/                   ← captured-facts carry-over sidecar (NOT a record kind; unscanned)
        ├── <slug>.md            ← one carry-over fact each (frontmatter name + description)
        └── archive/<ts>/        ← newscene-archived facts
```

The `summary` and `timeline` kinds are **branch-primary** (see
[Branch-primary scene memory](#branch-primary-scene-memory) below): the within-session / resume / fork store is pi's
**session log** (custom recap + timeline audit entries that travel with the conversation tree and carry the exact
coverage boundary), while the top-level `auto.md` is the scanned per-cast **carry-over** - the cross-session seed a
genuinely new tree inherits - and `archive/` holds newscene archives. `scanCast` reads only top-level `*.md` per kind,
so the `archive/` subdir - and the whole `facts/` sidecar - are skipped by the scan and never appear in
`formatRoleplayBlock`.

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
| `probability`   | `0`-`100`        | Chance the entry fires even when matched. Default `100` (always).                                     |
| `sticky`        | integer          | Once fired, stay active this many further turns without a re-match. Default `0`.                      |
| `cooldown`      | integer          | After its active window ends, cannot fire again for this many turns. Default `0`.                     |
| `delay`         | integer          | Not eligible to fire until this many turns into the chat. Default `0`.                                |
| `group`         | string           | Inclusion-group name; among fired members of a group only ONE survives per turn. Default `''`.        |
| `groupWeight`   | integer          | Relative weight for the group's weighted-random pick. Default `100`.                                  |

Keyword matching is **whole-word** (`RI` matches `RI` / `(RI)` but not `spring`) and case-insensitive; multi-word and
punctuation-bearing keys (`Northern Outpost`, `Dr. Vance`) match literally between token boundaries. Fired entries are
ranked by `order` (then name) and kept until `loreCharBudget` is reached - the single highest-priority entry is always
kept even if it alone exceeds the budget. Recursion is **off by default**, opt-in per entry, and hard-capped at
`maxRecursion` (ceiling 2) passes.

### Timed effects + inclusion groups

Keyword matching decides which entries _could_ fire; a timing pass
([`timing.ts`](../../../lib/node/pi/roleplay/timing.ts)) then decides what actually does, so World Info feels organic
instead of firing every time a keyword appears. The extension keeps a monotonic per-turn counter and a small in-memory
state map (reset on a cast switch), and applies, in order: `delay` (ineligible until turn N), `cooldown` (blocked for N
turns after the active window), `probability` (an rng gate on each fresh activation), `sticky` (force-active for N
further turns once fired, no re-roll), and `group` (among fired members of a named group, keep one, weighted by
`groupWeight`). A fresh fire arms the sticky+cooldown window in one shot; group losers do not arm any window. State is
in-memory only - it resets when pi restarts or the cast switches (chat-metadata persistence is deferred). The timing
pass applies to the system-prompt lorebook; depth-injected lore (entries with a `depth`) still uses plain matching in
v1.

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

## Scene: folding full character sheets (`characters` / `pov` / `pinned`)

The index above is deliberately lightweight (one line per record). To put a character's **whole sheet** in front of the
model - the SillyTavern "the character card is always in context" behaviour - a sheet folds into a `## Roleplay scene`
block from any of three sources:

1. **Persona-declared** - the active persona lists on-stage members + the player POV:

   ```yaml
   roleplay: true
   characters: [Exusiai, Texas] # full bodies folded into the system prompt, in this order
   pov: Doctor # the character the human plays
   openers: ['Yo, Doctor!', '...'] # greeting lines, surfaced via `/persona opener`
   ```

2. **`pinned` character** - a card with `pinned: true` in its frontmatter folds **every turn**, no persona list needed
   (the character-card analogue of a `constant` lore entry - the "always present" lead, e.g. the player's own card).
3. **Name-triggered fold** - any character whose **name** (always keyed, zero-config), an authored **alias**, or an
   extra **trigger** keyword appears in the recent-message window folds in for the scene. This is what lets an NPC
   introduced mid-scene be voiced correctly on a later turn _without_ a `roleplay read`. Keying is **broad** (any
   mention, not only the active speaker), bounded by the sticky window + budget below.

Each folded character's body renders under a `### <Name>` heading (deduped), the block announces
`The user plays **<pov>**.`, and the POV character renders last tagged `(player character)`. Names are matched by record
id, then case-insensitive name, then name-slug; **unresolved persona names are warn-dropped** (a one-time notice naming
the missing set). A `pov` that is not in the cast still produces the announcement line (the player may be an off-screen
character).

**Precedence + budget.** The block is capped by `charBudget` (shared with the index). When folds exceed the cap they are
evicted in reverse precedence: **`pov` > `pinned` > name-triggered > index-only**. The POV sheet is never evicted;
persona-declared and `pinned` sheets are kept ahead of name-triggered ones; the lowest-precedence (name-triggered)
sheets drop first, reported with a trailer. When there is no POV sheet the first (highest-precedence) sheet is always
kept so a too-small budget can never blank the block.

### Character-fold metadata

All fields are optional frontmatter on a `character` record (also settable via the `roleplay` tool's `save` / `update`
for `aliases` / `pinned` / `triggers` / `order`). A bare card with no metadata still folds on its own **name** - the
zero-config default. Trigger + timing reuse the same machinery as the lorebook (whole-word case-insensitive matching;
sticky / cooldown / probability windows).

| Field         | Example              | Meaning                                                                                               |
| ------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `pinned`      | `true`/`false`       | Always fold this sheet (budget permitting), ignoring triggers - the card analogue of lore `constant`. |
| `aliases`     | `[Kal'tsit, Doctor]` | Extra names/nicknames the fold keys on (the entry `name` is always an implicit key).                  |
| `triggers`    | `[the surgeon]`      | Extra keywords (OR'd with name + aliases) that also fold the sheet in.                                |
| `order`       | `10`                 | Priority; higher survives budget eviction longer. Default `0`.                                        |
| `sticky`      | `3`                  | Once folded, stay folded this many further turns without a re-match (anti-flicker). Default `3`.      |
| `cooldown`    | `0`                  | After the sticky window ends, cannot fold again for this many turns. Default `0`.                     |
| `probability` | `100`                | 0-100 chance the fold fires on a fresh match. Default `100`.                                          |
| `delay`       | `0`                  | Not eligible to fold until this many turns into the chat. Default `0`.                                |

Author list fields with **inline** arrays (`[a, b]`) - pi's frontmatter parser does not accept block (`- item`) lists.
The recent-message scan window is the same `scanDepth` the depth-lore scan uses. Leave everything unset and a character
folds only when its name is mentioned (or the persona declares it) - backward compatible with pre-`pinned` casts.

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

## Rolling context window + recap (`summary/auto`)

On a small window (the target regime: a model whose context window is largely consumed by a big fixed system prompt,
leaving only a few thousand tokens of usable conversation space) pi's built-in threshold compaction **see-saws** - most
of the window is a non-compactible system prompt, so compaction fires on the small slice of conversation it can touch,
reclaims little, and each shrink resets any positional window. To stop that, the extension does its own **rolling
in-context reduction** in the `context` hook every turn and owns threshold compaction. Pure logic:
[`context-window.ts`](../../../lib/node/pi/roleplay/context-window.ts).

The reduction is a **non-destructive ephemeral overlay** - the `context` hook output is never persisted, so the full
prose stays in the session `.jsonl` and the user scrolls back through everything; the model is just sent less. Three
zones, oldest -> newest:

```text
[ dropped prefix ] [ condensed boundary (head+tail) ] [ verbatim tail: keepTurns turns ]
 (lives only in the recap)   (recap does not yet cover)      (the recent scene)
```

- **Verbatim tail.** The last `keepTurns` user-turns (default 8) and everything after them are sent untouched.
- **Condensed boundary.** Older messages the recap does not yet cover are condensed HEAD+TAIL (`truncateText`,
  `HEAD_FRACTION=0.6`) - RP "before I forget ..." facts cluster at the tail, so head-only truncation drops them.
- **Dropped prefix.** In recap mode the recap-covered prefix is **removed entirely**, so total prompt size is O(1) in
  scene length (bounded), not O(n). Both cutoffs land on user-message boundaries (`computeCutoff`) so a tool result is
  never orphaned from its call.

### Modes (one coherent switch)

- **`summarize on` (default) + context window on => bounded recap mode.** The recap is the primary mode because it is
  the only _size-bounded_ one (drops the covered prefix). The extension also **cancels pi's THRESHOLD auto-compaction**
  (`session_before_compact`, `reason === 'threshold'`) so it is the sole context manager - manual `/compact` and genuine
  overflow recovery still run as the safety net.
- **`summarize off` (`PI_ROLEPLAY_DISABLE_SUMMARIZE=1`) or context window off => condense-only floor.** The head+tail
  floor still trims attention-diluting old prose but **keeps every message** (not size-bounded), so it does **not** own
  compaction; pi's compaction stays the backstop. A legitimately lighter mode for a big-window model.
- **`PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW=1` => no rolling reduction at all.** Defers fully to pi and keeps the legacy
  compaction-time side-write below.

### The recap (`summary/auto`)

The recap is a thin **narrative** layer (recent events, mood, open threads), NOT a fact store - durable facts are pinned
separately (see [fact taxonomy](#fact-taxonomy-durable-facts-vs-narrative) below). It is generated by the
[`roleplay-summarizer`](../../../config/pi/agents/roleplay-summarizer.md) agent + the
[`summarize.ts`](../../../lib/node/pi/roleplay/summarize.ts) adapter (RP-native prose, NOT pi's `generateSummary`),
folded cumulatively into one rolling `summary/auto` record.

- **Roll cadence.** The frozen boundary advances only every `stride` aged messages (`stride` defaults to `recapChunk`,
  default 8). Between rolls the condensed prefix + recap are byte-identical, so the runtime reuses the prompt-prefix
  cache and only the new turn is prefilled - one reprocess spike per roll. Raise `recapChunk` to cut churn and
  re-emissions (less telephone drift); lower it for a fresher recap.
- **Span cap derived, not hardcoded.** The span fed to the summarizer is capped from the **recap model's context
  window** (`deriveMaxSpanChars`), not the historic hardcoded 8000 chars - so a large `recapChunk` is summarized
  losslessly instead of silently dropping its oldest half. The chars/token estimate is calibrated against the last
  turn's reported `usage`.
- **Collapse guard.** A degenerate recap (measured in the field: 3456 -> 95 chars) is rejected (`acceptRecap`, keep the
  candidate only when it retains >= 50% of the prior length or there is no prior), so a bad generation can't erase scene
  memory now that the recap is the only in-context record of dropped turns.
- **Neutral sampler pinned.** The summarizer runs at `temperature: 0.3` / `presence_penalty: 0`
  ([frontmatter `requestOptions`](../../../config/pi/agents/roleplay-summarizer.md), applied via an inline agent-gate
  factory since the child loads with `noExtensions`). Note: the active persona's `temperature: 1.5` /
  `presence_penalty: 1.5` does **not** leak into this subagent - the child session never registers persona's
  `before_provider_request` - so this is the correct default, not a fight against the persona merge.
- **Sync vs async.** The recap runs **sync** (blocking) when it inherits the session model (a single endpoint can't
  serve the recap and the main turn at once), and **async** (off the critical path) when a _distinct_ recap model is
  configured (`roleplay.summarizeModel` pointing at a separate small/fast endpoint => real concurrency). Force either
  with `PI_ROLEPLAY_RECAP_ASYNC=1|0`. **Caveat:** async only buys anything if the recap model is a genuinely separate
  endpoint; async on the same single-instance server is pointless or errors. During async lag the not-yet-dropped span
  stays condensed-but-present (the floor), so nothing is lost; the drop boundary just advances a roll or two later. An
  in-flight async recap is generation-guarded (`recapGen`) + aborted on reset / branch switch so a stale result can't
  clobber the current branch's recap.
- **Persistence + hydrate (branch-primary).** See [Branch-primary scene memory](#branch-primary-scene-memory) below: the
  within-session / resume / fork store is the **session log** - every roll appends a `roleplay-context-recap` custom
  entry (the audit) carrying the recap + exact coverage boundary, and that IS the primary store (no extra write). Each
  roll also refreshes the per-cast carry-over (`summary/auto.md`), the cross-session seed. On (re)load a **resume/fork**
  hydrates from the branch (`getBranch()`, active-path-only, so it is fork-correct and carries the exact `coveredTo`); a
  genuinely new tree **seeds** from the carry-over; a cold start begins empty. The `roleplay-context-recap` entry is
  written on both the sync and async paths.

### Legacy compaction-time side-write

When pi _does_ compact (manual `/compact` or genuine overflow - never cancelled), the `session_before_compact` handler
still folds the evicted span into `summary/auto` (same summarizer, `acceptRecap`-guarded) so continuity survives the
safety-net paths. Set `PI_ROLEPLAY_DISABLE_SUMMARIZE=1` to turn the whole recap path off even when a model is
configured; then only the condense-only floor (if the window is on) applies.

### Branch-primary scene memory

The recap, the captured facts, and the timeline each have two distinct jobs, matched to two stores:

- **Within-session (resume + fork continuity) -> the session log / branch is authoritative.** A recap / timeline / fact
  set is a pure function of the message prefix along a branch, so the branch is the only correct store for this job. pi
  stores a conversation as a **tree**; `getBranch()` returns only the entries on the currently active root-to-leaf path.
  So a recap entry is served to a branch only when it lies on that branch's path - fork-correct by construction (an edit
  / regenerate / fork continues ITS own recap, never a stale sibling's) - and it carries the exact `coveredTo` instead
  of guessing. Each roll appends a `roleplay-context-recap` entry (recap + `coveredFrom` + `coveredTo` + `applied`) and,
  when timeline is on, a `roleplay-timeline` entry stamping the cumulative timeline text; those custom entries are never
  sent to the LLM but travel with the tree. Captured facts' within-session store is the coding-`memory` session (`note`)
  tier (already session-keyed).
- **Cross-session carry-over (a NEW tree inherits the PREVIOUS scene) -> a per-cast file.** A fresh tree's `getBranch()`
  has nothing to hydrate, so this job needs a store outside any single tree. Every roll refreshes `summary/auto.md`
  (best-effort, last-writer-wins), appends to `timeline/auto.md`, and mirrors each written fact to a `facts/<slug>.md`
  sidecar. These are the durable per-cast seed a **future** session inherits; lossy / last-writer-wins by design.
- **Hydrate precedence (once per load).** 1) **PRIMARY:** if this branch carries an applied recap -> **resume/fork**
  from it (exact `recapCutoff = min(coveredTo, natural)`), timeline from the branch if present else the carry-over, and
  NO fact reseed; 2) else (genuinely new tree, or a fork with no recap on its path yet) **seed** from the carry-over
  (recap + timeline + fact sidecars seeded into this session's `memory` note tier), `recapCutoff = natural` as an
  accepted approximation; 3) else **cold start**.
- **`/roleplay newscene`** is the opt-out: it archives the recap / timeline carry-overs to `<kind>/archive/<ts>.md` and
  the fact sidecars to `facts/archive/<ts>/`, then clears in-memory scene state. The NEW scene runs on a fresh tree
  whose `getBranch()` carries no recap, so branch hydration finds nothing and the cleared carry-over yields a cold
  start.
- **With no session id (`--no-session`)** there is no branch to hydrate; only the carry-over is written and seeded
  (degraded legacy behavior).

The branch is the only store that is correct for the within-session path, and it adds no write cost (the recap audit was
already written every roll). The carry-over `auto.md` write still races between concurrent same-cast sessions (last roll
wins the _seed_); this is accepted as cosmetic because each session's within-session memory is its own branch. Belt: if
branch hydration finds nothing but `auto.md` exists, the ladder falls to the carry-over seed. Helpers:
[`paths.ts`](../../../lib/node/pi/roleplay/paths.ts) (`fileFor` / `readEntryBody` / `archiveCarryOver` / `factFile` /
`listFactSidecars` / `archiveFacts`); branch hydration lives in the extension (`hydrateRecapFromBranch` /
`hydrateTimelineFromBranch`).

### Fact taxonomy: durable facts vs narrative

Because the recap is thin and lossy by construction, durable facts must NOT live in it. They are routed to three tiers:

| Store                                       | Lifetime                                          | Holds                                           |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `memory` project / `roleplay` typed records | cross-scene, permanent                            | character + relationship **canon**              |
| `memory` **session (`note`)** tier          | this scene (survives resume, dies on fresh scene) | facts **established this scene**                |
| `facts/<slug>.md` carry-over sidecar        | per-cast, seeds new sessions (newscene-archived)  | pinned specifics carried across session bounds  |
| recap (`summary/auto`)                      | rolling, lossy                                    | recent **narrative / mood / open threads** only |

**Deterministic capture (default OFF, `PI_ROLEPLAY_CAPTURE=1`).** Because owning threshold compaction means `memory`'s
capture-assist no longer fires on the common path, the extension can capture facts itself on the roll: the
[`roleplay-fact-extractor`](../../../config/pi/agents/roleplay-fact-extractor.md) subagent reads the aged **span** (not
the prose recap) and returns a JSON array of self-contained `{name, description}` facts
([`capture.ts`](../../../lib/node/pi/roleplay/capture.ts) parses tolerantly), which are written **deterministically**
(no reliance on the model firing a `memory save` tool) to `memory`'s session (`note`) tier. Header-carried: a small
model won't `memory read` a body and the session tier injects only name + description, so the fact must be
self-contained in the name (e.g. `"<character> is allergic to shellfish"`). De-dups against session notes on disk
(fuzzy) + those written this process; degrades to a silent no-op under `--no-session` (no session id). Each written fact
is also mirrored to the per-cast `facts/<slug>.md` carry-over sidecar (deduped against existing sidecars); a fresh
session seeds those sidecars back into its `memory` note tier on hydrate (see
[Branch-primary scene memory](#branch-primary-scene-memory)), so a new session inherits the pinned specifics, not just
the narrative recap. **Known gap (validate before relying):** `memory.ts` injects from its cached index within a live
session, so a fact captured mid-scene surfaces in the injected index only after `memory` rebuilds (next session / a
`memory` tool call), not necessarily the same turn; cross-session resume picks it up on `memory`'s `session_start`
rescan. Default-OFF pending a small-window smoke that validates extraction quality and this coherence question.

### Timeline: additive anti-drift beats (default OFF, `PI_ROLEPLAY_TIMELINE=1`)

The timeline is the **anti-drift complement** to the recap. The recap is CONSOLIDATIVE
(`recap_n = summarize(span_n, recap_{n-1})`) and therefore drifts and sheds specifics; the timeline is ADDITIVE
(`timeline += extract(span_n)`) - dated beats are appended once and **never re-fed to a model**, so a beat's text is
byte-stable for the life of the scene. The recap answers "where are we now"; the timeline answers "what happened, in
order". On each roll (same span as the recap + capture, run **after** the recap resolves and **awaited** - it shares the
recap endpoint, so it must not run concurrently) the
[`roleplay-timeline-extractor`](../../../config/pi/agents/roleplay-timeline-extractor.md) subagent returns a JSON array
of `{when?, summary}` beats ([`timeline.ts`](../../../lib/node/pi/roleplay/timeline.ts) parses tolerantly), which are
**appended** (never rewritten) to the carry-over timeline log (`timeline/auto.md`) and folded into the in-memory
cumulative timeline that gets stamped into each `roleplay-timeline` branch entry (the within-session store). A compact
`## Recent timeline`-style block (most-recent beats, capped by `timelineMaxInjectChars`, default 1200) is injected as a
**separate** prefix from the recap (via `injectTimeline`) so a long timeline can't evict the recap or the hand-authored
`formatRoleplayBlock`. Each roll writes an auditable `roleplay-timeline` log entry (custom entry, never sent to the
LLM). Append-only means concurrent same-cast sessions just interleave distinct lines with no clobber.

## Repetition / anti-slop nudge

Sampler penalties (`presence_penalty` / `frequency_penalty`) only see token-level repeats within one response; they
cannot catch a model reusing the same multi-word cadence or stock sensory phrase **across consecutive replies** ("a
shiver runs down my spine", again, every turn). The extension scans the recent assistant replies for repeated word
n-grams and, when one crosses the threshold, injects a one-line "vary your phrasing" nudge via the `context` event under
the `roleplay-repetition` id. It is **additive only** - it never rewrites output, and rides the same cache-friendly
ephemeral-reminder seam as the todo / memory blocks ([`context-reminder.ts`](../../../lib/node/pi/context-reminder.ts)),
so it never busts the prompt-prefix cache.

It is **roleplay-aware**: n-grams that appear in the active cast's `character` bodies (speech tics, verbatim canon
lines) are excluded, so a signature catchphrase a persona is _supposed_ to repeat is never flagged. The exclusion set is
memoized per cast and rebuilt on any store change. Tuned by the `repetition*` config keys (below) and disabled with
`PI_ROLEPLAY_DISABLE_REPETITION=1`. Pure logic lives in [`repetition.ts`](../../../lib/node/pi/roleplay/repetition.ts).

## Event system (`/roleplay event`)

`/roleplay event [hint]` queues a one-shot in-world **complication** - a knock at the door, a revealed motive, a sudden
choice - injected as a private director note for the **next reply only** (consume-once: cleared at the following turn
boundary). Like the repetition nudge it rides the `context` event under the `roleplay-event` id and never rewrites the
transcript.

Source order:

- **LLM-generated by default** (and always when a `hint` is given): the
  [`roleplay-event`](../../../config/pi/agents/roleplay-event.md) agent is spawned once via `runOneShotAgent` with the
  recent scene, the cast's one-line descriptors, and - when `eventSeedThreads` is on - the cast's relationship
  `openThreads` so it can escalate a dangling thread instead of inventing one cold. The result is capped at
  `eventMaxChars` (default 280) and an empty / `null` response is treated as a miss.
- **Deck fallback**: when no event is generated (no agent installed, spawn failure, or `null`), one entry is drawn at
  random from the `events` deck in `roleplay.json`. With an empty deck and no generated event the command reports that
  nothing is available.

Unlike auto-summarization, the event generator stays enabled **without** an explicit model - it inherits the parent
session model. A separate `eventModel` (resolution order `<cwd>/.pi/roleplay-event.json` >
`~/.pi/agent/roleplay-event.json` > `~/.pi/agent/settings.json` `roleplay.eventModel`) lets a stronger model write the
complication while a small local model drives the scene. Disable the whole path with `PI_ROLEPLAY_DISABLE_EVENTS=1`.
Pure logic lives in [`event.ts`](../../../lib/node/pi/roleplay/event.ts).

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
may change only those fields); `save` / `update` of a `character` entry accept `aliases`, `pinned`, `triggers`, and
`order` (the scene-fold knobs - see [Scene](#scene-folding-full-character-sheets-characters--pov--pinned)). All actions
operate on the **active cast**.

## `/roleplay` command

- `/roleplay` (or `/roleplay list`) - show the active cast (or the dormant note).
- `/roleplay cast <name>` - set the active-cast override (effective once a `roleplay: true` persona is active).
- `/roleplay import <path.json|.png>` - import a SillyTavern character card into the active cast (see below).
- `/roleplay event [hint]` - queue a one-shot scene complication for your next reply (LLM-generated, or drawn from the
  `events` deck).
- `/roleplay newscene` - start a fresh scene: archive + clear the recap / timeline / captured-fact carry-overs so the
  next turn cold-starts (opt-out of the silent carry-over seed).
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
  "repetitionEnabled": true, // enable the multi-turn repetition nudge (default true)
  "repetitionNgram": 5, // word-n-gram length compared across replies (default 5, 2-12)
  "repetitionWindow": 6, // recent assistant replies scanned (default 6, 1-50)
  "repetitionMinCount": 2, // occurrences across the window before flagging (default 2, >=2)
  "events": [], // fallback complication deck for `/roleplay event` (default [])
  "eventMaxChars": 280, // cap on a generated / picked scene event (default 280, floor 40)
  "eventSeedThreads": true, // offer relationship openThreads to the event generator (default true)
  "keepTurns": 8, // recent user-turns kept verbatim in the rolling window (default 8, 1-200)
  "recapChunk": 8, // aged messages per roll = re-recap + drop-boundary cadence (default 8, 1-500)
  "windowAssistantChars": 200, // condense budget for older assistant text (default 200, floor 40)
  "windowUserChars": 400, // condense budget for older user text (default 400, floor 40)
  "recapStride": 0, // roll cadence in aged messages; 0 = follow recapChunk (default 0, 0-500)
  "recapAsync": null, // force async (true) / sync (false) recap; null = auto by endpoint (default null)
  "capture": false, // deterministic fact capture on the roll -> memory notes (default false)
  "timeline": false, // additive anti-drift timeline of dated beats on the roll (default false)
  "timelineMaxInjectChars": 1200, // cap on the injected `## Recent timeline` block (default 1200, floor 200)
}
```

The auto-summarization **model** is resolved separately (it is a credential / model choice, not a budget): set
`roleplay.summarizeModel` in `~/.pi/agent/settings.json`, or a `summarizeModel` key in `roleplay-summarize.json`
(project or user). With no model resolved, auto-summarization stays disabled. The scene-event **model** (`eventModel`)
is resolved the same way (`roleplay.eventModel` in `settings.json`, or a `roleplay-event.json`); unlike summarization it
is optional - with none set the event generator inherits the parent session model.

## Environment variables

- `PI_ROLEPLAY_DISABLED=1` - skip the extension entirely (no tool, no command, no injection).
- `PI_ROLEPLAY_DISABLE_AUTOINJECT=1` - keep the tool but skip the `## Roleplay` block.
- `PI_ROLEPLAY_DISABLE_LOREBOOK=1` - keep the cast-index injection but skip keyword-triggered lore.
- `PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1` - skip the `context`-event depth injection (author's note + depth-tagged lore).
- `PI_ROLEPLAY_DISABLE_SUMMARIZE=1` - drop recap mode (no `summary/auto` recap, no threshold ownership); the rolling
  window degrades to the condense-only floor.
- `PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW=1` - skip the rolling in-context reduction entirely and defer to pi (keeps only
  the legacy compaction-time side-write).
- `PI_ROLEPLAY_CONTEXT_TURNS=N` - recent user-turns kept verbatim (overrides config `keepTurns`; sits below the config
  files).
- `PI_ROLEPLAY_RECAP_CHUNK=N` - aged messages per roll (overrides config `recapChunk`).
- `PI_ROLEPLAY_RECAP_STRIDE=N` - roll cadence in aged messages (overrides config `recapStride`; 0/unset = follow
  `recapChunk`); raise to cut cache churn.
- `PI_ROLEPLAY_CONTEXT_ASSISTANT_CHARS=N` / `PI_ROLEPLAY_CONTEXT_USER_CHARS=N` - per-role condense budgets for the
  boundary zone.
- `PI_ROLEPLAY_RECAP_ASYNC=1|0` - force the recap off / on the critical path (overrides config `recapAsync`; default:
  async only when a distinct recap endpoint is configured).
- `PI_ROLEPLAY_CONTEXT_DEBUG=1` - append a per-turn `roleplay-context-window-debug` log entry (system / recap / sent vs
  full token estimates + the sawtooth); off by default, never sent to the LLM.
- `PI_ROLEPLAY_CAPTURE=1` - enable deterministic fact capture on the roll into `memory`'s session (`note`) tier (default
  OFF; requires recap mode + a session id; validate extraction quality in a smoke run before relying).
- `PI_ROLEPLAY_TIMELINE=1` - enable the additive anti-drift timeline on the roll (default OFF; requires recap mode;
  appends dated beats to `timeline/auto.md` + the `roleplay-timeline` branch entry and injects a compact
  `## Recent timeline` block).
- `PI_ROLEPLAY_DISABLE_REPETITION=1` - skip the multi-turn repetition / anti-slop nudge.
- `PI_ROLEPLAY_DISABLE_EVENTS=1` - disable `/roleplay event` scene complications.
- `PI_ROLEPLAY_DISABLE_PROMPT_OVERRIDES=1` - ignore every `prompts/<name>.md` guidance override and use the shipped
  default prompts.
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
- [`timing.ts`](../../../lib/node/pi/roleplay/timing.ts) - timed-effect + inclusion-group pass (delay / probability /
  sticky / cooldown / group) over matched lore.
- [`prompt.ts`](../../../lib/node/pi/roleplay/prompt.ts) - render the fired-lore system-prompt section.
- [`inject.ts`](../../../lib/node/pi/roleplay/inject.ts) - plan + apply depth insertions (author's note + depth lore)
  for the `context` event.
- [`scene.ts`](../../../lib/node/pi/roleplay/scene.ts) - resolve + fold full character sheets (`characters` / `pov`)
  into the `## Roleplay scene` block.
- [`scene-fold.ts`](../../../lib/node/pi/roleplay/scene-fold.ts) - name-keyed character-fold selection (`pinned` +
  name/alias/trigger match), reusing `hasKeyword` + `applyTiming` for the sticky/cooldown timing.
- [`macros.ts`](../../../lib/node/pi/roleplay/macros.ts) - `{{user}}` / `{{char}}` / `{{time}}` / `{{random}}` /
  `{{roll}}` substitution over injected text (deterministic via injectable clock + rng).
- [`relationship.ts`](../../../lib/node/pi/roleplay/relationship.ts) - toward-baseline affinity decay (`decayAffinity`,
  `daysElapsed`, `formatRelationshipLine`).
- [`summarize.ts`](../../../lib/node/pi/roleplay/summarize.ts) - auto-summarization: span rendering + trigger
  (`planSummarization`), settings resolver, and the `createSummarizer` adapter (null = fall back).
- [`context-window.ts`](../../../lib/node/pi/roleplay/context-window.ts) - rolling reduction: head+tail truncation,
  `computeCutoff` / `applyLayeredWindow` (drop + condense on user boundaries), `injectRecap`, `acceptRecap` collapse
  guard, `planRecap` roll cadence, and the sizing helpers (`deriveMaxSpanChars`, `updateCharsPerToken`,
  `deriveKeepTurns`, `estimateChars`).
- [`capture.ts`](../../../lib/node/pi/roleplay/capture.ts) - deterministic fact capture: fact-extraction task builder +
  tolerant `parseFactCandidates` (fenced / bare JSON array -> validated, clamped, de-duped `{name, description}`).
- [`timeline.ts`](../../../lib/node/pi/roleplay/timeline.ts) - additive anti-drift timeline: beat-extraction task
  builder + tolerant `parseTimelineBeats` (`{when?, summary}`), append-log formatters (`formatBeatLines`), and the
  injected-block renderer (`renderTimelineBlock`, most-recent + char-capped). Recovers the model's array via
  `extractBalancedArray` from the shared [`json-loose.ts`](../../../lib/node/pi/json-loose.ts) (the array sibling of
  `extractBalancedObject`), which `capture.ts` uses too.
- [`repetition.ts`](../../../lib/node/pi/roleplay/repetition.ts) - multi-turn n-gram repetition detection +
  character-sheet exclusion + nudge framing (`detectRepetition`, `buildExcludeSet`, `formatRepetitionNudge`).
- [`event.ts`](../../../lib/node/pi/roleplay/event.ts) - scene-event task builder, director framing, deck pick, settings
  resolver, and the `createEventGenerator` adapter (null = fall back to deck).
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
[`../../../lib/node/pi/roleplay/`](../../../lib/node/pi/roleplay/) and run `/reload`. Editing the
[`roleplay-summarizer`](../../../config/pi/agents/roleplay-summarizer.md) or
[`roleplay-fact-extractor`](../../../config/pi/agents/roleplay-fact-extractor.md) agent (incl. its sampler
`requestOptions`) is picked up on the next summarizer / extractor spawn without a reload. The rolling-window state
(frozen cutoffs, in-memory recap) is per-process and reset on `session_start` / `session_tree` / `session_shutdown`, so
`/reload` starts the window fresh and re-hydrates the recap from the durable `summary/auto` record.
