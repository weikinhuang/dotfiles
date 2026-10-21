# `roleplay.ts` internals

Design rationale and mechanics for the [`roleplay`](./roleplay.md) extension: why each piece of injected state lives
where it does, how the rolling context window and recap work, how scene memory is stored and rehydrated, and which pure
helper module owns what. User-facing behavior, record formats, commands, configuration, and environment variables are in
[roleplay.md](./roleplay.md); this file assumes that reference.

## Tool gate timing

The activation gate removes the `roleplay` tool from the active-tools set when no `roleplay: true` persona is active, so
its `promptSnippet` and `promptGuidelines` never reach the system prompt. The gate runs at `session_start` /
`session_tree`, not only in `before_agent_start`: `setActiveTools` rebuilds the base prompt, and other autoinject
extensions (memory / scratchpad / todo) compose their additions off the prompt snapshot the runner takes before
`before_agent_start` handlers run. Removing the tool only inside `before_agent_start` would leak the lines on the first
turn. A `before_agent_start` backstop still handles a mid-session `/persona` switch from the following turn on.

## Cache stability

The leading system prompt is the most expensive prefix to invalidate (on llama.cpp a change re-prefills the whole
conversation). The extension sorts injected state by volatility:

- **System prompt (stable head).** The `## Roleplay scene` block with persona-declared, `pinned`, and POV sheets, plus
  the `## Roleplay — cast: <slug>` index. Membership changes only when the persona, the pinned set, or the store
  changes.
- **Reminders (per-run state).** Keyword-fired lore (`roleplay-lore`), name-triggered sheets (`roleplay-scene-fold`),
  merged depth-0 text (`roleplay-depth`), the repetition nudge (`roleplay-repetition`), and queued events
  (`roleplay-event`). `before_agent_start` computes them once per narrative run (so timing advances exactly once) and
  the first narrative `context` request emits them through
  [`context-reminder.ts`](../../../lib/node/pi/context-reminder.ts). Later requests in the run emit nothing new.
- **Conversation prefix.** The recap and timeline blocks are prepended to the first kept user message and stay
  byte-identical between rolls.

The default-on [`cache-reminders`](./cache-reminders.md) coordinator captures reminder blocks once per run, sorts their
IDs, and projects a branch-recoverable snapshot whose historical items stay byte-stable. Mid-run state changes do not
rewrite it. On later user runs only newly firing state is captured; historical lore and event snapshots remain context
history, not newly queued events. Operational custom runs keep the previous scene block and cast index without advancing
narrative timing. See [`AGENTS.md`](./AGENTS.md) § "Cache-safe reminder delivery".

Name-triggered sheets moved off the head because NPC churn (a character entering or leaving the sticky window) changed
the system prompt every few turns. In reminder delivery a sheet is re-sent only when it re-enters the active set, was
never delivered, or its last delivery is `sceneFoldRefreshTurns` old
([`selectFoldDeliveries`](../../../lib/node/pi/roleplay/scene-fold.ts)); otherwise the earlier snapshot still carries
it. With the rolling window on, the effective refresh is clamped to at most `keepTurns - 1` (min 1,
`effectiveFoldRefreshTurns`) so a still-active sheet is re-sent before the turn carrying it ages out of the verbatim
window. `session_compact` also resets the delivery memory (`resetSceneFoldDelivery`), so active sheets are re-sent after
a compaction. A sheet counts as delivered only when the cache-reminders coordinator captures a snapshot whose
`roleplay-scene-fold` spec carries the emitted body (the `cache-reminders:captured` listener commits the ids, mirroring
event consumption); a request aborted by the limiter or sanitizer leaves the sheet undelivered, so the next narrative
turn re-sends it. `sceneFoldDelivery: "system"`, or globally disabled reminders, restores head delivery so folds never
silently vanish.

Volatile macros would also churn the head. Head sheets therefore resolve against the session header's start timestamp
([`sessionMacroClock`](../../../lib/node/pi/roleplay/macros.ts); process start time under `--no-session`) and an rng
seeded from `<sessionId>\0<entryId>` ([`seededRng`](../../../lib/node/pi/roleplay/macros.ts): FNV-1a hash into
mulberry32), so `{{time}}`, `{{random}}`, and `{{roll}}` render the same bytes every turn and across resume or
`/reload`. Reminder, lore, depth, and author's-note text keeps a live clock and `Math.random`; they are captured once
per run anyway.

The lore budget charges the block heading and the "lore budget reached" trailer as well as each chunk and its separator
([`budget.ts`](../../../lib/node/pi/roleplay/budget.ts) shares the framing with `prompt.ts`), so the rendered block fits
`loreCharBudget` except when the always-kept top entry alone exceeds it. When the trailer would overflow, the
lowest-ranked kept chunks are evicted (never the first). Depth lore renders no heading, so `buildDepthLore` passes
`headerChars: 0`.

Scene folds and rolling context reduction can still legitimately move a prefix; the coordinator does not redesign them.

## Lore selection pipeline

Per narrative turn, `buildLoreInjection` runs over non-depth, non-empty lore:

1. `matchLore` - primary triggers plus the secondary gate ([`match.ts`](../../../lib/node/pi/roleplay/match.ts)).
2. `expandMatchedRecursive` - re-scan bodies of matched `recurse: true` entries against the rest of the pool, up to
   `maxRecursion` passes, returning the union of matched ids
   ([`recursion.ts`](../../../lib/node/pi/roleplay/recursion.ts)). The `isSource` predicate
   ([`timingAllows`](../../../lib/node/pi/roleplay/timing.ts)) drops sources the current timing state already rules out:
   `enabled: false`, `turn < delay`, or an active cooldown outside a sticky window. Probability and inclusion groups are
   rolled later, so a source that then fails its roll or loses its group still contributed its body to the scan; sticky
   carries that did not match this turn are not recursion sources.
3. `applyTiming` - one pass over every entry with `matched` set from the union
   ([`timing.ts`](../../../lib/node/pi/roleplay/timing.ts)). Probability rolls happen in entry order, then one group
   pick per contested group in sorted group-name order. A group resolved by a sticky incumbent consumes no rng draw, so
   the incumbent never loses its slot to a fresh weighted roll mid-window. Several incumbents tie-break by highest
   `groupWeight`, then id in code-unit (locale-independent) order.
4. `selectWithinBudget` - rank by `order`, name, id; evict to `loreCharBudget`.

Running recursion before timing keeps the timing pass single-shot per turn and makes recursive hits obey the same
`delay` / `cooldown` / `probability` / group rules as keyword hits. The legacy `expandRecursive` (recursion after
timing) remains exported for callers that want plain-match expansion.

Depth lore uses `matchLore` + `selectWithinBudget` over the frozen recent window with no recursion or timing.

## Depth injection delivery shape

By default every insertion becomes its **own `user`-role message**. For `depth: 0` that means N instruction-only user
messages after the user's real message, so the model's immediate stimulus before generation can be a stack of standing
instructions with the actual user message several messages back. On a chat template with no mid-conversation system role
that can read as an instruction handoff to acknowledge.

Historical measurements on `llama-cpp/gemma4-31b-fast`, using the earlier per-request standalone transport, found that
four `constant: true, depth: 0` records (~4.6 KB of second-person imperative prose) drew a `// [OOC: I've absorbed …]`
compliance preamble on 13.4% of replies; 23 of those 27 preambles named an injected `depth: 0` record. These
observations explain the delivery-shape option, not a benchmark of the current anchored transport.

`depthLoreInlineTail: true` changes the **message structure**: everything resolving to depth 0 (the depth-0 lore, in
order, plus an author's note whose resolved depth is 0, last) is concatenated into one block joined by blank lines in
the initiating input's managed snapshot. Per-chunk `[Lore — <name>: …]` framing is unchanged, so the lore prose is the
same; `depth > 0` keeps the standalone path. Tradeoffs:

- The merged block uses `<system-reminder id="roleplay-depth">` framing, like keyword-fired lore, explained to
  non-Claude models by [`reminder-primer`](./reminder-primer.md). It also lets
  [`cache-breakpoint`](./cache-breakpoint.md) distinguish reminder blocks from ordinary conversation content.
- Chunk order is deterministic: selected depth-0 lore first, author's note last. The coordinator replays the same
  rendered snapshot rather than re-appending blocks on every request.
- Macro substitution and `loreCharBudget` selection stay upstream of the merge; the flag does not change which records
  match or their budget.
- `PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1` disables both shapes. Tool continuations only replay the existing snapshot.
- **Re-measure before adopting.** Earlier measurements found a tail-injected instruction reduced one prose tic from 17%
  to 3% and another from 62% to 19%, while the same wording in the system prompt did nothing. Standalone messages,
  reminder framing, and position in the rendered template can all change model behavior. Keep this an A/B choice.

## Turn-scoped selection and fixed placement

[`cache-reminders`](./cache-reminders.md) persists the rendered bodies and before/after message anchors alongside the
run's keyword lore, events, and repetition guidance. Depth-0 placement therefore gives:

```text
User message -> Lore snapshot -> Assistant tool call -> Tool result -> Assistant reply
```

Later tool requests only replay that snapshot. Tool-output keywords, changing lore files, and random/time macros cannot
select new lore or move its placement during the run. Original conversation messages are never rewritten; snapshots are
stored as branch-local metadata and projected into requests. No snapshot is freshly appended after a tool-result
continuation, including after recovery.

A new narrative input selects fresh lore and resolves fresh depth positions. Inserting farther back can reduce
prefix-cache reuse at that boundary. Initial request planning may try smaller windows before accepting the final
placement, without rereading bodies, rerolling macros, or advancing timing. Persisted session-entry IDs identify origins
and targets rather than mutable text hashes. Queued startup guidance stays after the initiating input and its depth-0
content.

Earlier snapshots remain unchanged until their anchors leave the active context. Compaction and branch restore retain
placements whose initiating input and targets survive; missing targets are omitted, not relocated. Final request sizing
counts historical and pending snapshot payloads, and final sanitization covers standalone depth messages as well as
framed blocks. If the latest input plus mandatory context cannot fit, the request aborts instead of sending an oversized
payload or consuming a queued event.

## Rolling context window

On a small window (a model whose context is largely consumed by a big fixed system prompt) pi's threshold compaction
see-saws: compaction fires on the small slice it can touch, reclaims little, and each shrink resets any positional
window. The extension instead reduces the conversation in the `context` hook every turn and owns threshold compaction
while a summarizer resolves. The per-turn arithmetic is [`window-pass.ts`](../../../lib/node/pi/roleplay/window-pass.ts)
over the primitives in [`context-window.ts`](../../../lib/node/pi/roleplay/context-window.ts); mutable state is grouped
in [`window-state.ts`](../../../lib/node/pi/roleplay/window-state.ts).

### Zones

The reduction is a non-destructive overlay: the `context` hook output is never persisted. Three zones, oldest to newest:

```text
[ dropped prefix ] [ condensed boundary (head+tail) ] [ verbatim tail: keepTurns turns ]
 (lives only in the recap)   (recap does not yet cover)      (the recent scene)
```

- **Verbatim tail.** The last `keepTurns` user turns and everything after them (`computeCutoff`, the `natural` cutoff).
- **Condensed boundary.** Older messages the recap does not yet cover are condensed HEAD+TAIL (`HEAD_FRACTION=0.6`)
  within `windowAssistantChars` / `windowUserChars`; "before I forget" facts cluster at the tail, so head-only
  truncation drops them.
- **Dropped prefix.** In recap mode the recap-covered prefix is removed entirely, so prompt size is O(1) in scene
  length.

Every drop boundary lands on a user message. `computeCutoff` and `boundRollSpanTo` produce user-message indices, and
`applyLayeredWindow` defensively snaps any other non-zero drop (`snapDropToUserBoundary`): down to the nearest user
message, or forward when none precedes it. The reduced list therefore never opens on an assistant turn or an orphaned
tool result.

### Modes

- **Recap mode** (summarize on + window on): layered drop + condense, then the recap and timeline prefixes. The
  extension cancels pi's `threshold` compaction in `session_before_compact` only when the lazily built summarizer
  resolves (`getSummarizer(ctx)?.isEnabled()`, no spawn); with none it lets pi compact so history is summarized rather
  than silently dropped by the safety floor. Manual `/compact` and overflow recovery always run.
- **Condense-only floor** (`PI_ROLEPLAY_DISABLE_SUMMARIZE=1`): condenses but keeps every message, so it does not own
  compaction.
- **Window off** (`PI_ROLEPLAY_DISABLE_CONTEXT_WINDOW=1`): no reduction.

### Roll cadence and span cap

`planRoll` fires when `natural` has advanced `stride` aged messages past `committedCutoff` (`stride` = `recapStride`, or
`recapChunk` when 0). Between rolls the condensed prefix and recap are byte-identical, so the prompt-prefix cache is
reused and only the new turn is prefilled - one reprocess spike per roll.

A roll summarizes `[recapCutoff, spanTo)` where
`spanTo = boundRollSpanTo(messages, recapCutoff, natural, recapMaxAdvance, summarizeMinMessages)`: at most
`recapMaxAdvance` messages, snapped down to the last user message in range that still leaves at least
`summarizeMinMessages` messages (or forward to the first user message past the bound when none does), never past
`natural`. The minimum span prevents a wedge: a short first turn followed by a turn longer than `recapMaxAdvance` used
to snap down to a span the summarizer refuses as trivial, so no candidate was ever produced and coverage never advanced.
As a backstop, a non-empty span whose summarization planning still returns null advances `recapCutoff` to `spanTo`
anyway and writes a `roleplay-context-recap` audit with `trivial: true` (hydrated as committed). pi `compactionSummary`
messages are filtered out of the span before it reaches the summarizer or extractors. Bounding the increment keeps the
merge digestible; an unbounded span made a stalled recap re-summarize an ever-growing span, collapse, and wedge
(coverage pinned 190 turns behind in the field). After a roll that started a recap, `committedCutoff` advances to
`natural`; if an in-flight async recap blocked it, the boundary holds so the backlog starts as soon as the in-flight one
lands. Both the sync and async paths capture `recapGen` before awaiting the summarizer and commit nothing when a reset /
branch change / compaction bumped it meanwhile. Fact and timeline capture re-check the same generation (and the abort
signal) after their extractor resolves, before any write.

The span text cap passed to the summarizer is derived from the recap model's context window (`deriveMaxSpanChars`), with
the chars/token estimate calibrated against the previous turn's reported usage (`updateCharsPerToken`).

### Collapse guard and wedge breaker

- **Collapse guard.** `acceptRecap` keeps a candidate only when there is no prior or it retains at least 50% of the
  prior length (a field collapse went 3456 -> 95 chars).
- **Over-cap candidates.** On the normal path an over-`summarizeMaxChars` candidate is dropped, not truncated
  (`validateSummary` returns `null`).
- **Wedge breaker.** When the uncovered lag (`natural - recapCutoff`) reaches `recapLagCeiling`, `shouldForceRecap`
  accepts the best candidate anyway; only on this forced path is an over-cap candidate salvaged by `clampSummary` at a
  sentence/word boundary. Coverage then advances to `spanTo`. A persistently collapsing or over-cap summarizer drains a
  bounded step per roll instead of pinning coverage while the safety floor silently drops the uncovered span.
- **Forced roll.** `/roleplay recap force` arms `forceRecap`; `planRoll` then rolls off-stride when there are uncovered
  aged messages, and `settleForcedRecap` clears the flag once a recap actually starts (an in-flight async roll keeps it
  armed for the next pass). A force with nothing to cover is dropped.

### Sync vs async

The recap runs **sync** when the recap model is the session model (one endpoint cannot serve the recap and the main turn
at once) and **async** when a distinct `summarizeModel` is configured. `recapAsync` / `PI_ROLEPLAY_RECAP_ASYNC` force
either. Async on the same single-instance server is pointless or errors. During async lag the uncovered span stays
condensed-but-present, so nothing is lost. An async recap is generation-guarded (`recapGen`) and aborted on reset or
branch switch so a stale result cannot clobber the current branch's recap. Fact capture and timeline extraction run
after the recap, sequentially and awaited, under the same abort controller, because they share the recap endpoint.

The summarizer runs at `temperature: 0.3` / `presence_penalty: 0` from its
[frontmatter `requestOptions`](../agents/roleplay-summarizer.md), applied through an inline agent-gate factory because
the child loads with `noExtensions`. The persona's sampler does not leak into the child session.

### Hard safety floor

`planWindowFloor` guarantees the reduced prompt fits the session model's window even when recap coverage cannot advance
(empty recap after a cold resume, dead recap endpoint). It fits the conversation into
`window - (system + injected recap/timeline) - 3072` tokens by dropping the oldest whole user turns. The floor is frozen
between rolls and only re-cut when holding it would leave less than 1024 tokens of output margin, so it does not creep
forward every turn. It is deliberately not re-cut on a roll: a session draining a recap backlog rolls often, and
re-cutting there would wiggle the drop boundary. The applied drop is `max(recapCutoff, floorCutoff)`. With recap mode
off and the floor engaged, the oldest turns are hard-dropped; otherwise the condense-only path runs.

### Compaction interplay

- **Threshold** compaction is cancelled in recap mode when a summarizer resolves; otherwise pi compacts normally.
- **Side-write.** On manual / overflow compaction (and threshold when not owned) `session_before_compact` folds the
  evicted span into the recap. The prior is the in-memory branch recap, falling back to `summary/auto.md` only when this
  process holds none. An accepted recap refreshes the carry-over file, upserts the `summary/auto` entry in the in-memory
  index without a cast rescan (which would reset lorebook timing), and appends a `roleplay-context-recap` entry with
  `mode: 'compact'` and `coveredTo: 0`.
- **After compaction** the message array is new and shorter, so `session_compact` calls `resetWindowCoverage`: recap and
  timeline text are kept; `recapCutoff`, `committedCutoff`, and the frozen floor go to 0; any in-flight async recap is
  invalidated. The first pass afterwards (`anchorAfterCompaction`) sets `committedCutoff = natural` without rolling
  (compaction already bounded the size) and keeps `recapCutoff` at 0, so the compaction summary and already-recapped
  kept messages are not re-summarized right away. `scanBranchForRecap` applies the same rule on reload: a recap entry
  followed on the branch by a pi `compaction` entry hydrates with `coveredTo: 0` and `compacted: true`, and the condense
  boundary anchors at `natural`.

### Debugging

`/roleplay context` formats the last pass snapshot
([`context-readout.ts`](../../../lib/node/pi/roleplay/context-readout.ts)). `PI_ROLEPLAY_CONTEXT_DEBUG=1` additionally
appends a `roleplay-context-window-debug` entry per turn.

## Branch-primary scene memory

The recap, captured facts, and timeline each have two jobs, matched to two stores:

- **Within-session (resume + fork) -> the session branch.** A recap / timeline / fact set is a function of the message
  prefix along a branch. pi stores a conversation as a tree and `getBranch()` returns only the active root-to-leaf path,
  so a recap entry is served only to the branch it lies on: an edit, regenerate, or fork continues its own recap, never
  a sibling's, with the exact `coveredTo`. Each roll appends a `roleplay-context-recap` entry (recap, `coveredFrom`,
  `coveredTo`, `applied`, `forced`, `mode`) and, with timeline on, a `roleplay-timeline` entry. These custom entries are
  never sent to the LLM. Captured facts' within-session store is `memory`'s session (`note`) tier.
- **Cross-session carry-over -> per-cast files.** A new tree has nothing to hydrate, so every roll refreshes
  `summary/auto.md` (last-writer-wins), appends to `timeline/auto.md`, and mirrors each written fact to
  `facts/<slug>.md`. These are lossy by design.

### Hydration ladder

Hydration runs once per load, on the first context pass:

1. **Branch.** If the branch carries an applied (or forced) recap after the latest `roleplay-newscene` marker, resume
   from it: `recapCutoff = committedCutoff = min(coveredTo, natural)` (when a compaction follows it, `recapCutoff = 0`
   and `committedCutoff = natural`). The timeline comes from the branch, else the carry-over. No fact reseed.
2. **Carry-over seed.** Otherwise (fresh session, or a fork with no recap on its path) seed the recap **text** from
   `summary/auto.md` and the timeline from `timeline/auto.md`, with coverage left at 0. The carry-over came from another
   session and covers none of this session's messages; claiming `natural` on a resumed long session that never rolled
   would drop all aged history in favor of a foreign recap. The seed is still injected (injection keys on recap text,
   not coverage), and normal rolls fold into it. With capture on and a session id, carry-over fact sidecars are seeded
   into the session `memory` tier.
3. **Cold start.** Nothing to seed; the recap stays empty.

`/roleplay newscene` archives the carry-overs (`summary/archive/<ts>.md`, `timeline/archive/<ts>.md`,
`facts/archive/<ts>/`), appends a `roleplay-newscene` marker that shadows every older recap and timeline entry on the
branch, and resets in-memory scene state. With no session id (`--no-session`) only the carry-over is written and seeded.
Concurrent same-cast sessions race on `summary/auto.md` (last roll wins the seed); this is cosmetic because each
session's within-session memory is its own branch.

Pure scanners live in [`branch-hydration.ts`](../../../lib/node/pi/roleplay/branch-hydration.ts); the carry-over file
helpers are in [`paths.ts`](../../../lib/node/pi/roleplay/paths.ts).

## Fact taxonomy and capture

Because the recap is thin and lossy, durable facts do not live in it:

| Store                                       | Lifetime                                          | Holds                                           |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `memory` project / `roleplay` typed records | cross-scene, permanent                            | character + relationship **canon**              |
| `memory` **session (`note`)** tier          | this scene (survives resume, dies on fresh scene) | facts **established this scene**                |
| `facts/<slug>.md` carry-over sidecar        | per-cast, seeds new sessions (newscene-archived)  | pinned specifics carried across session bounds  |
| recap (`summary/auto`)                      | rolling, lossy                                    | recent **narrative / mood / open threads** only |

Owning threshold compaction means `memory`'s capture-assist no longer fires on the common path, so capture (default off)
runs on the roll: the [`roleplay-fact-extractor`](../agents/roleplay-fact-extractor.md) reads the aged span (not the
recap) and returns a JSON array of `{name, description}` facts, parsed tolerantly by
[`capture.ts`](../../../lib/node/pi/roleplay/capture.ts) and written deterministically to the session tier. Facts must
be self-contained in the name (`"<character> is allergic to shellfish"`) because a small model will not `memory read` a
body and the session tier injects only name + description. Writes de-dup against session notes on disk (fuzzy) and those
written this process, and mirror to `facts/<slug>.md` (deduped against existing sidecars).

**Known gap.** `memory.ts` injects from its cached index within a live session, so a fact captured mid-scene surfaces in
the injected index only after `memory` rebuilds (next session or a `memory` tool call). Capture stays default-off
pending a small-window smoke that validates extraction quality and this coherence question.

## Timeline mechanics

The recap is consolidative (`recap_n = summarize(span_n, recap_{n-1})`) and drifts; the timeline is additive
(`timeline += extract(span_n)`): beats are appended once and never re-fed to a model, so their text is byte-stable for
the life of the scene. On each roll, after the recap resolves and fact capture finishes, the
[`roleplay-timeline-extractor`](../agents/roleplay-timeline-extractor.md) returns `{when?, summary}` beats
([`timeline.ts`](../../../lib/node/pi/roleplay/timeline.ts)), which are de-duplicated against the target store
(`dedupeNewBeats`, exact match on normalized text) and then:

- **Carry-over file.** `appendTimelineCarryOver` truly appends the new lines to `timeline/auto.md` (`appendFileSync`;
  the file is created atomically with frontmatter on first write), so concurrent same-cast sessions interleave lines
  rather than clobbering. When the file then exceeds `timelineFileMaxChars`, it is re-read (keeping lines another
  session appended since the de-dup read), the older half of its beat lines moves to
  `timeline/archive/<ts>-<pid>-<rand>-rotated.md` (the suffix keeps same-second rotations from colliding), and `auto.md`
  is atomically rewritten with the newer half. New lines are de-duped against the live log only, not the archived half,
  so a beat rotated out can be appended again.
- **In memory.** New lines fold into `timelineText`, capped by `capBeatLog` to the newest whole lines within
  `timelineMemoryMaxChars` (the newest line always survives).
- **Branch entry.** Each roll appends a `roleplay-timeline` entry `{version: 2, beats, ...audit}` carrying only that
  roll's new lines, so the session file grows linearly. Deltas are de-duped against the in-memory timeline, which on a
  fresh tree was seeded from `timeline/auto.md`, so the first v2 entry of such a session also carries `base` (the seed
  text); otherwise a resume would rebuild only the deltas and lose the seed. `scanBranchForTimeline` rebuilds the
  timeline from the newest base (a legacy entry's full cumulative `timeline` text, or a v2 `base`) plus every later v2
  delta, stopping at a `roleplay-newscene` marker. Hydration then applies the in-memory cap.

The injected block (`renderTimelineBlock`, most-recent beats capped at `timelineMaxInjectChars`) is a separate prefix
from the recap, so a long timeline cannot evict the recap or the cast index. The safety floor reserves against the
rendered block, not the cumulative log.

## Repetition internals

Sampler penalties only see token-level repeats within one response; they cannot catch a multi-word cadence reused across
consecutive replies. [`repetition.ts`](../../../lib/node/pi/roleplay/repetition.ts) collects the last `repetitionWindow`
assistant replies, counts word `repetitionNgram`-grams, and flags those reaching `repetitionMinCount`. The exclusion set
(n-grams from the cast's `character` bodies) is memoized per cast and n-gram length and rebuilt on any store change.

## Pure helper module index

Pure logic lives under [`../../../lib/node/pi/roleplay/`](../../../lib/node/pi/roleplay/) so it is vitest-testable
without the pi runtime; the extension shell holds pi-coupled glue and disk I/O. Specs mirror each module under
[`../../../tests/lib/node/pi/roleplay/`](../../../tests/lib/node/pi/roleplay/).

Store, scan, and tool:

- [`store.ts`](../../../lib/node/pi/roleplay/store.ts) - types, frontmatter parse/serialize (lore / character /
  relationship metadata plus unknown-key passthrough on `extra`), kind+id index CRUD (`upsertEntry`, `removeEntry`,
  `resolveEntry`), slugs, `INDEX.md` + injected-block renderers, `SECONDARY_MODES`, `isIsoDate` /
  `lastInteractionError`, `CARRY_OVER_SLUG` / `isReservedSlug`.
- [`paths.ts`](../../../lib/node/pi/roleplay/paths.ts) - on-disk layout + scan/read/write (node:fs only): `scanCast`,
  `scanCastComplete`, `listLoreBundles`, `entryFilePath` (bundle-aware record path), `readEntryBody`,
  `archiveCarryOver`, `appendTimelineCarryOver` (append + rotation), fact sidecars, `resolveImportPath` (quotes, `~`,
  cwd-relative).
- [`tool-params.ts`](../../../lib/node/pi/roleplay/tool-params.ts) - structural view of the tool params plus
  `buildLoreMeta` / `buildCharacterMeta` / `buildRelationshipMeta` layered over existing metadata.
- [`actions.ts`](../../../lib/node/pi/roleplay/actions.ts) - `planSave` / `planUpdate` / `planRemove` / `planSearch`:
  validation, reserved slugs, renames (write-first, then remove), bundle-preserving paths, next state, and result text.
- [`config.ts`](../../../lib/node/pi/roleplay/config.ts) - the `roleplay.json` layer: defaults, clamps, env layer.
- [`active.ts`](../../../lib/node/pi/roleplay/active.ts) - the cross-extension active-cast singleton.
- [`usage.ts`](../../../lib/node/pi/roleplay/usage.ts) - `/roleplay` USAGE string and subverb completion spec.

Lore and scene:

- [`match.ts`](../../../lib/node/pi/roleplay/match.ts) - whole-word keyword matching (no-space script edges), lore
  firing with AND / OR / NOT / NOT_ALL secondaries.
- [`recursion.ts`](../../../lib/node/pi/roleplay/recursion.ts) - `expandMatchedRecursive` (pre-timing) and legacy
  `expandRecursive`.
- [`timing.ts`](../../../lib/node/pi/roleplay/timing.ts) - delay / probability / sticky / cooldown / inclusion groups
  with sticky incumbents.
- [`cast-timing.ts`](../../../lib/node/pi/roleplay/cast-timing.ts) - per-cast turn counter, lore and fold timing state,
  fold delivery bookkeeping, and their resets.
- [`budget.ts`](../../../lib/node/pi/roleplay/budget.ts) - rank + evict to the lore budget; shared block framing
  (`LORE_BLOCK_HEADER`, `LORE_BLOCK_SEPARATOR`, `renderLoreChunk`, `formatLoreTrailer`).
- [`prompt.ts`](../../../lib/node/pi/roleplay/prompt.ts) - render the fired-lore block.
- [`inject.ts`](../../../lib/node/pi/roleplay/inject.ts) - narrative eligibility, depth planning/framing, depth-0 merge,
  and placement anchors.
- [`scene.ts`](../../../lib/node/pi/roleplay/scene.ts) - `composeSceneBlock` (head) and `composeSceneFoldBlock`
  (name-triggered reminder block, own budget).
- [`scene-fold.ts`](../../../lib/node/pi/roleplay/scene-fold.ts) - `planCharacterFold` (pinned + name/alias/trigger
  match with timing, each tier ranked by `rankByCharacterOrder`: `order` descending, ties by cast id) and
  `selectFoldDeliveries` (refresh rule).
- [`macros.ts`](../../../lib/node/pi/roleplay/macros.ts) - macro substitution, `{{roll}}` caps (`MAX_ROLL_DICE`,
  `MAX_ROLL_SIDES`), and `hashString` / `mulberry32` / `seededRng` for session-stable head text.
- [`text.ts`](../../../lib/node/pi/roleplay/text.ts) - `clampWords`, `normalizeInjectedBody`.
- [`lore-readout.ts`](../../../lib/node/pi/roleplay/lore-readout.ts) - per-turn lore selection snapshot and the
  `/roleplay lore` formatter.

Context window and scene memory:

- [`context-window.ts`](../../../lib/node/pi/roleplay/context-window.ts) - head+tail truncation, `computeCutoff`,
  `applyLayeredWindow`, `snapDropToUserBoundary`, `boundRollSpanTo`, `freezeFloorCutoff`, `injectRecap` /
  `injectTimeline`, `acceptRecap`, `shouldForceRecap`, `planRecap`, and sizing helpers (`deriveMaxSpanChars`,
  `updateCharsPerToken`, `deriveKeepTurns`, `estimateChars`).
- [`window-pass.ts`](../../../lib/node/pi/roleplay/window-pass.ts) - `planWindowFloor` (frozen safety floor with
  overflow valve) and `applyWindowPass` (recap / hard-drop / condense-only).
- [`window-state.ts`](../../../lib/node/pi/roleplay/window-state.ts) - grouped window state with `resetWindowState`,
  `resetWindowCoverage` (post-compaction), `invalidateRecap`, `armForcedRecap`, `planRoll`, `settleForcedRecap`.
- [`branch-hydration.ts`](../../../lib/node/pi/roleplay/branch-hydration.ts) - `scanBranchForRecap` (compaction zeroes
  coverage) and `scanBranchForTimeline` (legacy base + v2 deltas).
- [`summarize.ts`](../../../lib/node/pi/roleplay/summarize.ts) - span rendering, `planSummarization`, settings,
  `validateSummary` / `clampSummary`, and the `createSummarizer` adapter.
- [`capture.ts`](../../../lib/node/pi/roleplay/capture.ts) - fact-extraction task + tolerant `parseFactCandidates`.
- [`timeline.ts`](../../../lib/node/pi/roleplay/timeline.ts) - beat-extraction task, `parseTimelineBeats`,
  `dedupeNewBeats`, `appendBeatBody`, `capBeatLog`, `splitBeatLogHalves`, `renderTimelineBlock`. Array recovery uses
  `extractBalancedArray` from the shared [`json-loose.ts`](../../../lib/node/pi/json-loose.ts).
- [`context-readout.ts`](../../../lib/node/pi/roleplay/context-readout.ts) - `/roleplay context` formatter.
- [`recap-readout.ts`](../../../lib/node/pi/roleplay/recap-readout.ts) - `/roleplay recap` formatter and
  `recapUnavailableReason`.

Relationships, events, and subagents:

- [`relationship.ts`](../../../lib/node/pi/roleplay/relationship.ts) - affinity decay (`decayAffinity`, `daysElapsed`,
  `formatRelationshipLine`).
- [`relationship-readout.ts`](../../../lib/node/pi/roleplay/relationship-readout.ts) - `/roleplay relationships`
  formatter.
- [`repetition.ts`](../../../lib/node/pi/roleplay/repetition.ts) - `detectRepetition`, `buildExcludeSet`,
  `formatRepetitionNudge`.
- [`event.ts`](../../../lib/node/pi/roleplay/event.ts) - event task builder, director framing, `pickDeckEvent` (capped
  at `eventMaxChars`), `isNullEventSentinel` / `validateEvent`, settings, and the `createEventGenerator` adapter.
- [`one-shot.ts`](../../../lib/node/pi/roleplay/one-shot.ts) - shared child-model settings cascade and one-shot adapter
  scaffolding.
- [`prompt-override.ts`](../../../lib/node/pi/roleplay/prompt-override.ts) - `prompts/<name>.md` guidance overrides.
- [`image-tools.ts`](../../../lib/node/pi/roleplay/image-tools.ts) /
  [`visual-identity.ts`](../../../lib/node/pi/roleplay/visual-identity.ts) - image-mode tool selection and visual
  identity extraction.

Pi-importing helper (under [`../../../lib/node/pi/ext/`](../../../lib/node/pi/ext/)):

- [`roleplay-child-session.ts`](../../../lib/node/pi/ext/roleplay-child-session.ts) - `runRoleplayChild` for the
  summarizer, event generator, and extractors: persisted child `SessionManager` under the parent's subagent tree
  (in-memory fallback for `--no-session`), `loadRoleplayAgent`, and `requestOptionsGateFactory` to pin agent samplers.

Card import/export (under [`../../../lib/node/pi/card-import/`](../../../lib/node/pi/card-import/)):

- [`parse-png-chara.ts`](../../../lib/node/pi/card-import/parse-png-chara.ts) - PNG `tEXt` reader + base64 decode of the
  `chara` / `ccv3` chunk.
- [`card-to-records.ts`](../../../lib/node/pi/card-import/card-to-records.ts) - normalize V1/V2/V3 card JSON and map it
  to `character` + `lore` records with fidelity warnings.
- [`records-to-card.ts`](../../../lib/node/pi/card-import/records-to-card.ts) - inverse mapping to a Character Card V2
  (`recordsToCard`, `parseCharacterSections`, `splitGreetings`).

## Related docs

- [roleplay.md](./roleplay.md) - user-facing reference.
- [cache-reminders.md](./cache-reminders.md) - reminder snapshot coordinator.
- [AGENTS.md](./AGENTS.md) - extension conventions, including cache-safe reminder delivery.
