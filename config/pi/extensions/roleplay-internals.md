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
- **Conversation prefix.** The original pinned opener, when enabled, precedes the recap, timeline and retained
  continuation. Memory blocks stay byte-identical between rolls; they are not duplicated as lore.

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
Structural stability does not establish a provider cache hit. Only associated provider cache usage can support that
claim; the sanitized pi projection is not a guarantee of the final backend template.

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

The reduction is a non-destructive overlay: the `context` hook output is never persisted. Three transcript zones, oldest
to newest, before optional opener restoration and scene-memory projection:

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

Every drop boundary lands on a turn start: a user message or a custom input (pi sends a custom message as a user turn).
Coverage itself may end mid-turn (a char-bounded span, below), so `applyLayeredWindow` and the final limiter snap the
drop (`snapDropToUserBoundary`) down to the nearest turn start. When none precedes it the drop is cancelled, never moved
forward: moving forward would discard messages no recap covers. The reduced list therefore never opens on an assistant
turn or an orphaned tool result, and a partially covered turn stays in the request until coverage passes it.

### Pinned historical head and soft prompt target

[`retention-policy.ts`](../../../lib/node/pi/roleplay/retention-policy.ts) merges file defaults with the latest valid
per-field `roleplay-context-policy` overrides on the active branch. Scanning stops at a scene/cast boundary; explicit
zero/false values override enabled file defaults. `promptTokenTarget` defaults to 0 (off), with a 1024-token floor for
positive values. `pinSceneOpener` and `pinSceneOpenerReply` default to false; reply pinning requires opener pinning.
There are no new environment variables for these settings.

`sceneOpenerRange` selects the first genuine scene user input, excluding startup/custom/snapshot items. Reply pinning
extends only through a complete assistant/tool exchange; malformed or unfinished chains leave only the input pinned.
[`pinned-window.ts`](../../../lib/node/pi/roleplay/pinned-window.ts) restores original identity-stamped messages after
window reduction, deduplicating by stable keys. `projectSceneMemory` orders the projection as original pinned head,
recap, timeline, then retained continuation. It does not emit a new event or repeat memory as lore. Recap coverage
continues through the opener normally, making a later unpin safe.

The full projected prompt target includes the effective system prompt, tools, historical/pending reminders, memory,
pinned opener and tail. The final limiter independently checks physical context capacity and output reserves. Above the
soft target it aims for 90% of the target as hysteresis; unchanged under-target requests need no target-driven cut.
Coverage must justify every transcript drop. When only the soft target is blocked by mandatory context, protected
messages, or failed/unavailable recap work, a physically fitting request may overshoot safely with history retained.
Physical overflow still fails closed. With no usable model window the runtime injects memory but skips size cuts,
including target-driven cuts.

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
`recapChunk` when 0). Between rolls the condensed prefix and recap are byte-identical, making prefix reuse possible; a
roll can cause a reprocess spike. Actual cache reuse depends on provider behavior and reported usage, not structural
stability alone.

A roll summarizes `[recapCutoff, spanTo)` where
`spanTo = boundRollSpanTo(messages, recapCutoff, natural, recapMaxAdvance, summarizeMinMessages)`: at most
`recapMaxAdvance` messages, snapped down to the last user message in range that still leaves at least
`summarizeMinMessages` messages (or forward to the first user message past the bound when none does), never past
`natural`. The minimum span prevents a wedge: a short first turn followed by a turn longer than `recapMaxAdvance` used
to snap down to a span the summarizer refuses as trivial, so no candidate was ever produced and coverage never advanced.
Meaningful spans below `summarizeMinMessages` remain uncovered until enough text accumulates, even when `recapStride` is
smaller than that minimum. The bounded roll counts text rather than non-text tool frames and extends to a complete turn
meeting the minimum when necessary, so a small raw-message cap cannot stall coverage. Only spans containing no non-empty
text advance without a recap; their audit records carry `trivial: true, emptySpan: true`. Older unverified `trivial`
records are not trusted as coverage on reload, so the last genuinely accepted recap can recover the skipped text. Every
transcript kind reaches the summarizer, including pi's content-less ones (`messageSummaryText`): a `compactionSummary`
or `branchSummary` contributes its `summary`, a `!command` run its command and output. The roll drops them with the rest
of the span, and when a compaction side-write failed the compaction summary is the only record of that history. Bounding
the increment keeps the merge digestible; an unbounded span made a stalled recap re-summarize an ever-growing span,
collapse, and wedge (coverage pinned 190 turns behind in the field). After a roll that started a recap,
`committedCutoff` advances to `natural`; if an in-flight async recap blocked it, the boundary holds so the backlog
starts as soon as the in-flight one lands. Both the sync and async paths capture `recapGen` before awaiting the
summarizer and commit nothing when a reset / branch change / compaction bumped it meanwhile. Fact and timeline capture
re-check the same generation (and the abort signal) after their extractor resolves, before any write.

The span text cap passed to the summarizer is derived from the recap model's context window (`deriveMaxSpanChars`), with
the chars/token estimate calibrated against matched prompt-input usage (`updateCharsPerToken`, which admits dense
scripts down to 0.25 chars/token). `boundSpanByChars` then ends the span before its rendered transcript would exceed
that cap, so coverage only advances over text the summarizer actually reads; `renderSpan` never drops older lines of a
planned span. A char-bounded span may end mid-turn and plans with a one-message minimum; a single message larger than
the cap is condensed head+tail rather than wedging coverage.

Spans leave the process for a child session that loads no extensions, so they first pass through the provider-copy
sanitizer (`cache-reminders:sanitize`, e.g. `secret-redactor`). When a sanitizer is required but does not handle the
copy, the roll starts nothing and commits no coverage, and a safety recap aborts the request.

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
- **Immediate roll.** `/roleplay recap now` performs explicit model work on one bounded uncovered aged span immediately,
  without a narrative turn or waiting for the normal stride. It uses the same sanitization, recap validation and
  generation guard, commits only an accepted recap, then schedules/runs enabled extraction stages. With no aged span or
  configured summarizer it reports the blocker without advancing coverage.

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

### Memory-preserving token safety

Only committed recap coverage can drop the scene transcript. The early context pass no longer uses an independent hard
floor that can erase uncovered turns. The final reminder-budget pass sizes the effective system prompt, SDK `sections`
and `toolsAdded` declarations, historical snapshots, pending reminders, recap and rendered timeline.

A model window may fill before `keepTurns` ages any messages. In that case, the coordinator awaits a safety recap of
whole earlier turns before accepting the cut. Normal recaps remain asynchronous when configured; only a request that
cannot otherwise fit waits for an existing background chain or performs a foreground recap. Safety recaps accept short
meaningful spans even below the normal planning minimum, but rejected candidates do not justify dropping them. Failed or
unavailable summarization, cancellation, an unresolved boundary, or an oversized protected input aborts the request with
history intact. No snapshot is persisted or event consumed on failure.

Every budget preview includes scene memory. The accepted prefix follows the pinned historical opener, if any, and is
attached to the first retained continuation user turn (a user message or custom input). It never rides a system message:
pi replaces the provider head with the forced prompt the extension returns, which would discard it. With no retained
user turn a standalone user message carries it. The final limiter runs on every request under an active coordinator,
including models without a usable `contextWindow` (memory is injected, the size cut skipped). Without a coordinator the
context pass injects memory itself. The limiter prefers a 3072-token output reserve and may use a 1024-token hard margin
when a larger mandatory head makes the preferred reserve impossible. These remain token estimates, not exact
tokenization. pi-ai then clamps the reply to `contextWindow - its estimate - 4096` and often estimates at 3.5
chars/token, well above the real count on prose. A prompt that fit only the calibrated estimate left the reply 1 token
on a live 53k window. From a 16k window up, each candidate's footprint is therefore
`max(calibrated estimate, piFallbackTokens) + 4096` before those reserves apply; smaller windows cannot meet pi's margin
at all and keep the calibrated estimate alone.

Usage calibration pairs the complete projected request with its own `message_end` input/cache usage. It does not use
`getContextUsage()`, whose context estimate also includes output and trailing messages. Structured prompt sections and
tool additions/removals are counted; a forced effective prompt replaces section text rather than being double-counted.

### Reload-safe safety state

After an accepted final reminder projection, a compact version-2 `roleplay-context-window-state` custom entry
checkpoints accepted boundary anchors and the learned characters-per-token ratio. Version-1 state is ignored: its ratio
could be calibrated from a request estimate missing the system prompt, and its floor could drop uncovered scene history.
Recap audits carry a stable first-uncovered message anchor, so safety coverage ahead of the nominal `keepTurns` cutoff
survives the next turn and reload. Identical checkpoints are not repeated.
[`window-checkpoint.ts`](../../../lib/node/pi/roleplay/window-checkpoint.ts) restores the latest matching cast/model
checkpoint from the active branch before window planning, independently of recap availability. Anchors resolve against
the current message identities instead of replaying stale array offsets. Compaction invalidates older floors, and a
`roleplay-newscene` or `roleplay-cast-change` marker shadows older checkpoints. Missing anchors are recomputed by the
normal safety passes.

Ignoring unsafe older checkpoints re-admits the preserved transcript instead of making its historical hard drop
permanent. The final budget pass still requires recap coverage before any new cut. Request-size samples are deliberately
not restored: a projected request must be paired with its own later response, never earlier context-meter estimates.

### Compaction interplay

- **Threshold** compaction is cancelled only under an active roleplay persona, in recap mode with a resolved summarizer.
  Dormant coding sessions always retain pi's normal compaction.
- **Side-write.** On manual / overflow compaction (and threshold when not owned) `session_before_compact` folds the
  evicted span into the recap. The prior is the in-memory branch recap, falling back to `summary/auto.md` only when this
  process holds none. An accepted recap refreshes the carry-over file, upserts the `summary/auto` entry in the in-memory
  index without a cast rescan (which would reset lorebook timing), and appends a `roleplay-context-recap` entry with
  `mode: 'compact'` and `coveredTo: 0`. It first invalidates any in-flight background roll: that roll covers older
  history from an older prior, and landing after the fold would replace it. The span is sanitized like a roll's.
- **After compaction** the message array is new and shorter, so `session_compact` calls `resetWindowCoverage`: recap and
  timeline text are kept; `recapCutoff`, `committedCutoff`, and the frozen floor go to 0; any in-flight async recap is
  invalidated. The first pass afterwards (`anchorAfterCompaction`) sets `committedCutoff = natural` without rolling
  (compaction already bounded the size) and keeps `recapCutoff` at 0, so the compaction summary and already-recapped
  kept messages are not re-summarized right away. The next roll folds the compaction summary with the kept messages it
  drops. `scanBranchForRecap` applies the same rule on reload: a recap entry followed on the branch by a pi `compaction`
  entry hydrates with `coveredTo: 0` and `compacted: true`, and the condense boundary anchors at `natural`.

### Debugging

`/roleplay context` formats the last pass snapshot
([`context-readout.ts`](../../../lib/node/pi/roleplay/context-readout.ts)). `PI_ROLEPLAY_CONTEXT_DEBUG=1` additionally
appends a `roleplay-context-window-debug` entry per turn.

[`roleplay-diagnostics.ts`](../../../lib/node/pi/ext/roleplay-diagnostics.ts) observes the accepted sanitized pi
projection without mutating it. `before_provider_request` marks an attempt, and `message_end` associates outcome and
input/cache usage with the live request. This does not certify the provider's final rendered backend template.
[`request-report.ts`](../../../lib/node/pi/roleplay/request-report.ts) supplies allowlisted metadata, component
classification, bounded section snapshots, formatting and matched usage association. Content-free metadata persists as
`roleplay-request` entries; duplicate lifecycle snapshots reduce to the latest matching turn/request for inspection.

`request` and `debug` default to metadata, including `--json`. `--snippets` explicitly opts into bounded previews;
`--section system|tools|conversation|recap|timeline|lore|depth|scene-fold|memory|other-reminder|head|tail --content`
opts into one bounded text section. `--turn N` / `--request N` select captured ordinals, not a reconstruction from the
current transcript. Only the latest live request's text is transiently available by default; reset/reload/tree changes
clear it. `request capture on|off` persists a scene/branch-local opt-in for future sensitive content snapshots. Turning
it off does not remove prior captures. Sections default to 16 Ki characters, with truncation/unavailability explicit;
formatting escapes terminal controls and redacts headers. Supplemental recap/timeline snapshots are labeled and are not
additional budget charges. Uncaptured old text stays unavailable.

`debug` adds numeric/boolean/null config and source labels, effective policy, window state, safe job metadata and recent
request-size trends. It never treats stable structure as cache-hit evidence. `--json` remains metadata-only even with
text flags. Full local recap text is instead available explicitly through `summary`; `timeline [--all]` selects a capped
injection preview or the full retained memory log, and `facts --content` shows tracked active-scene captures. These
local readouts do not call a model or inject text into the scene.

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
   and `committedCutoff = natural`). A checkpointed condense anchor (`committedAnchor`) restores the live condensed
   prefix, so a reload neither re-admits it nor rolls again at once. The timeline comes from the branch; the shared
   carry-over is adopted only for a legacy branch that never recorded any timeline entry. No fact reseed.
2. **Carry-over seed.** Otherwise (fresh session, or a fork with no recap on its path) seed the recap **text** from
   `summary/auto.md` and the timeline from `timeline/auto.md`, with coverage left at 0. The carry-over came from another
   session and covers none of this session's messages; claiming `natural` on a resumed long session that never rolled
   would drop all aged history in favor of a foreign recap. The seed is still injected (injection keys on recap text,
   not coverage), and normal rolls fold into it. Both seeds are stamped on the branch when adopted (a `mode: 'seed'`
   recap entry with coverage 0 and a v2 timeline `base`), so a resume rebuilds the exact text the live session had, not
   whatever another same-cast session has since written to the carry-over. With capture on and a session id, carry-over
   fact sidecars are seeded into the session `memory` tier.
3. **Cold start.** Nothing to seed; the recap stays empty.

`/roleplay newscene` archives the carry-overs (`summary/archive/<ts>.md`, `timeline/archive/<ts>.md`,
`facts/archive/<ts>/`), appends a `roleplay-newscene` marker, and resets scene timing, pending events, recaps and
extractors. The marker stores a persisted-message boundary (with a whole-turn identity fallback for in-memory callers).
The context hook excludes earlier conversation before recap planning, lore scans and final reminder projection,
including when the optional context window is off. It also blocks carry-over reseeding after a reset, so a concurrent
writer cannot revive the archived scene.

Cast switches use `roleplay-cast-change` boundaries, invalidate pending work and clear the previous cast's owned session
notes. A switch during `before_agent_start` includes its initiating input even though the marker follows that input on
the branch. Modern recap/timeline audits carry `cast`; hydration filters other casts and stops at scene boundaries.
Explicit cast overrides are restored from the active branch on reload/tree changes. Session history remains on disk.
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

New fact notes carry `roleplayFactCast` ownership metadata. `newscene` removes only notes owned by that cast in the
current session and rebuilds its memory index; unrelated notes and untagged legacy notes are preserved because they
cannot be attributed safely. The same cleanup runs when leaving a cast and emits a scoped `memory:changed` event,
invalidating memory's cached index before it can inject freshly captured old-cast facts into the first new-cast reply.
Ownership lives outside memory's public schema in [`fact-memory.ts`](../../../lib/node/pi/roleplay/fact-memory.ts).

The session note tier is shared by every branch of a session file, but captures are branch facts. Each
`roleplay-capture` entry records the notes it wrote (`facts: [{slug, name, description}]`, seeded sidecars too). On
`session_start` and `session_tree`, [`fact-branch.ts`](../../../lib/node/pi/roleplay/fact-branch.ts) plans the tier for
the active branch: notes only other branches captured are removed, notes this branch captured after its latest scene
boundary are restored, and notes no capture entry names (legacy, user-written) are never touched.

Fact capture writes during context preparation, after memory's pre-run rescan. Newly captured notes therefore surface on
the next agent run or memory tool call, not necessarily in the same request. Capture creates notes; memory's own
reminder/index pipeline injects them. The roleplay projection does not duplicate that content as lore, and disabling
capture does not suppress existing note injection. `facts` reports only branch-tracked active-scene counts;
`facts --content` explicitly shows their names/descriptions, excluding legacy untracked notes and sibling captures.
Capture stays default-off pending validation of extraction quality.

## Durable extraction jobs

[`extraction-jobs.ts`](../../../lib/node/pi/roleplay/extraction-jobs.ts) owns strict full-snapshot
`roleplay-extraction-job` entries. Jobs identify an accepted recap span by cast and stable from/to anchors, with a
source recap identity, optional turn ordinals, timestamps, and independent facts/timeline stages. They contain no
transcript, recap body, model output or arbitrary error text. Stages are `pending`, `running`, `complete`, `skipped`,
`failed`, or `interrupted`, with attempt counts and fixed reason enums (`restored-running`, `span-unavailable`,
`disabled`, `no-input`, `no-results`, `model-error`, `invalid-output`, `write-error`, `cancelled`).

The runtime queues committed recap spans only when at least one extraction feature is enabled, persists running and
result snapshots, and checks generation/cancellation before commits. Reload/tree recovery scans only the active scene
branch and cast, retaining all unfinished jobs plus the latest 20 fully terminal jobs. Restored running stages become
interrupted, so interruption does not silently mark work complete. Completed/skipped stages are immutable, including
stages deliberately skipped while disabled; enabling a feature later does not reopen those stages. Pending/failed/
interrupted stages remain retryable. Stable-anchor span resolution fails closed if either boundary is missing or
ambiguous; it does not guess from turn numbers.

[`roleplay-controls.ts`](../../../lib/node/pi/ext/roleplay-controls.ts) provides safe `jobs` status and explicit
`jobs retry facts|timeline|all` / `jobs drain` model work. Both select existing retryable queue stages only, re-sanitize
the original span and run facts then timeline as applicable. They do not infer missing jobs from recap coverage or
backfill legacy spans. `recap now` is another explicit model-work path, not a narrative prompt. Policy changes and
summary/timeline/fact inspection never run a model.

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
  `applyLayeredWindow`, `snapDropToUserBoundary`, `boundRollSpanTo`, `boundSpanByChars`, `messageSummaryText`,
  `freezeFloorCutoff`, `injectRecap` / `injectTimeline`, `acceptRecap`, `shouldForceRecap`, `planRecap`, and sizing
  helpers (`deriveMaxSpanChars`, `updateCharsPerToken`, `deriveKeepTurns`, `estimateChars`).
- [`window-pass.ts`](../../../lib/node/pi/roleplay/window-pass.ts) - `planWindowFloor` and `applyWindowPass`; normal
  runtime reduction drops only committed recap coverage, retaining uncovered condensed history.
- [`retention-policy.ts`](../../../lib/node/pi/roleplay/retention-policy.ts) - `readRoleplayPolicyOverrides`,
  `effectiveRoleplayPolicy`, `sceneOpenerRange` / `sceneOpenerKeys`, `preserveSceneOpener`, and `planTokenTarget`.
- [`pinned-window.ts`](../../../lib/node/pi/roleplay/pinned-window.ts) - `pinnedKeys`, `isPinned`, `restorePinnedHead`,
  and `projectSceneMemory` (historical head before recap/timeline/continuation).
- [`request-report.ts`](../../../lib/node/pi/roleplay/request-report.ts) - `captureRoleplayRequest`,
  `readRoleplayRequestMetadata`, `formatRoleplayRequest`, and `associateRoleplayRequestUsage`.
- [`extraction-jobs.ts`](../../../lib/node/pi/roleplay/extraction-jobs.ts) - `createExtractionJob`,
  `updateExtractionStage`, `scanExtractionJobs`, `pendingExtractionJobs`, `resolveExtractionSpan`,
  `extractionJobMetadata`, and `formatExtractionJobs`.
- [`window-state.ts`](../../../lib/node/pi/roleplay/window-state.ts) - grouped window state with `resetWindowState`,
  `resetWindowCoverage` (post-compaction), `invalidateRecap`, `armForcedRecap`, `planRoll`, `settleForcedRecap`.
- [`branch-hydration.ts`](../../../lib/node/pi/roleplay/branch-hydration.ts) - cast-filtered `scanBranchForRecap`
  (compaction zeroes coverage) and `scanBranchForTimeline` (legacy base + v2 deltas).
- [`scene-state.ts`](../../../lib/node/pi/roleplay/scene-state.ts) - persisted scene boundaries, message scoping,
  carry-over seed policy and cast-override restoration.
- [`fact-memory.ts`](../../../lib/node/pi/roleplay/fact-memory.ts) - ownership-tagged fact notes and selective cleanup.
- [`fact-branch.ts`](../../../lib/node/pi/roleplay/fact-branch.ts) - `planFactReconcile`: which captured notes the
  active branch keeps or removes after resume / fork / `/tree`.
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

Pi-importing helpers (under [`../../../lib/node/pi/ext/`](../../../lib/node/pi/ext/)):

- [`roleplay-diagnostics.ts`](../../../lib/node/pi/ext/roleplay-diagnostics.ts) - `createRoleplayDiagnostics`: sanitized
  projection capture, lifecycle observation, metadata/text inspection and explicit capture policy.
- [`roleplay-controls.ts`](../../../lib/node/pi/ext/roleplay-controls.ts) - `createRoleplayControls`: local memory
  inspection, branch policy controls and explicit recap/queued extraction work.

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
