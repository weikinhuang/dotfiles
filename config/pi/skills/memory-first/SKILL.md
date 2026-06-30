---
name: memory-first
description:
  Persist durable user preferences, validated approaches, project conventions, and reference pointers via the `memory`
  tool. Save when the user corrects your approach, expresses a preference, validates a non-obvious decision, or
  references an external system. Do NOT save code patterns, git history, or ephemeral task state - read the code or run
  `git log` instead. Applies across sessions and workspaces.
---

# Memory First

The `memory` tool is durable, cross-session storage, plus a session-scoped `note` layer for context that should live
only as long as the current session. Anything you save in the durable types survives session shutdown, context
compaction, and new projects; a `note` survives compaction but not the session. Every turn the MEMORY.md index is
injected into the system prompt under a `## Memory` header so you can see what's available without a tool call. Full
bodies are fetched on demand via `memory` action `read`.

This skill teaches WHEN to save, WHEN to recall, and WHAT NOT to save. The tool provides the mechanism; this doc
provides the policy.

## The four memory types

Each memory is a single markdown file with `name` + `description` + `type` frontmatter (plus `created` / `updated`
timestamps the tool stamps automatically - you never set those). Pick the type that describes the content, not the
trigger:

### `user` - who the user is, how they work

Role, expertise level, preferences, responsibilities, knowledge they already have. Memories here help you tailor
explanations and tool choice to the specific human you're working with.

Save when:

- They state their role or expertise: _"I'm a data scientist looking at logging"_ → user memory that they're a DS
  focused on observability.
- They state a preference in how they want to collaborate: _"prefer terse responses"_, _"don't summarise at the end"_,
  _"always ask before committing"_.
- They mention long-term context about their stack: _"I've written Go for ten years but this React codebase is new to
  me"_.

### `feedback` - corrections and validated approaches

Guidance they've given you about HOW to work. **Save both corrections AND validations** - if you only save corrections,
you drift toward over-caution and lose already-blessed approaches.

Body structure for `feedback`:

```markdown
<the rule itself>

**Why:** <the reason given - past incident, strong preference, etc.>

**How to apply:** <when this kicks in; edge cases it covers>
```

Save when:

- They correct your approach: _"don't mock the database here - we got burned last quarter when mocks passed and prod
  failed"_. Save the rule + why + when it applies.
- They validate a non-obvious call you made: _"yeah, the bundled PR was right here - splitting would've been churn"_.
  That's a confirmed judgment call worth keeping.
- They tell you to stop a habit: _"stop ending every response with a summary"_.

### `project` - what's happening in this workspace

Initiatives, decisions, incidents, deadlines, stakeholder asks. **Project-scoped by default** (only present when pi is
running in this repo's cwd). These decay fast. The tool now timestamps every memory automatically (and marks project
memories older than `PI_MEMORY_STALE_DAYS` with a `(Nd)` age nudge in the index), so file age is tracked for you - but
that is the age of the _note_, not of the facts inside it. Still convert relative _domain_ dates to absolute when saving
(deadlines, freeze windows, incident dates) so the body stays interpretable later regardless of when it was written.

Save when:

- They explain motivation behind ongoing work: _"we're ripping out the old auth middleware because legal flagged it for
  compliance"_.
- They mention a constraint or deadline: _"merge freeze after Thursday"_ → save as `freeze begins 2026-03-05`.
- They describe incident context you won't get from the code: _"the p99 spike last week was the DB connection pool;
  we're shipping the fix tomorrow"_.

### `reference` - pointers to external systems

Where things live outside the repo. Project-scoped by default.

Save when:

- They tell you which tracker to check: _"pipeline bugs live in Linear project INGEST"_.
- They point at a dashboard: _"grafana.internal/d/api-latency is what oncall watches"_.
- They name a Slack / docs / runbook location: _"#payments-eng is the channel for dispute escalations"_.

### `note` - working notes for this session only

Freeform context that matters _now_, in this session, and is not worth keeping once the session ends. Session-scoped:
keyed on the session id, only loaded for the session that wrote it, never seen by other sessions.

Save when:

- You want to stash mid-task context that should survive `/compact` but not leak into future sessions: _"the failing
  test is flaky under load, retrying with `--runInBand` for now"_.
- The user frames something as session-local: _"just for this run, treat the staging DB as read-only"_.

This is heavier than the branch-local `scratchpad` tool: a `note` survives compaction and shows up in the injected
index. Reach for `scratchpad` for throwaway jotting; reach for a `note` when the context should persist across the whole
session. If the fact should outlive the session, it is a `project` memory, not a `note`.

## Scope choice - global vs project vs session

- **`user` / `feedback`** default to `global` - cross-project truths. Override to `project` only when the rule genuinely
  only applies to this one workspace (e.g. "in this repo, prefer integration over unit tests").
- **`project` / `reference`** always `project` - a `freeze begins Thursday` memory from repo A means nothing in repo B.
- **`note`** always `session` - and only available when pi has an active session id. Without one (e.g. `--no-session`)
  session memory is disabled; use `project` instead.

When in doubt, prefer `project` over `session` (a `note` vanishes with the session) and `project` over `global` (a
misplaced global memory pollutes every future session; a misplaced project memory just goes quiet when you leave the
workspace).

## When NOT to save

These live elsewhere and memory-copies rot the moment the original changes.

- **Code patterns, conventions, architecture, file paths, project structure.** These are in the code. Read it. Pi's
  `grep-before-read` skill is how you find them.
- **Git history / who-changed-what / recent commits.** `git log` and `git blame` are authoritative.
- **Debugging fixes or recipes.** The fix is in the code; the commit message has the context.
- **Anything already in `CLAUDE.md` / `AGENTS.md` at the repo root.** Pi loads these automatically.
- **Ephemeral task state.** Use the `todo` and `scratchpad` tools - they're branch-aware and don't persist.
- **One-shot summaries of "what I just did".** The diff already says that.
- **Secrets, credentials, or tokens as values.** Memory bodies persist to disk across sessions, so a captured secret is
  a durable leak. Store a _reference_ to where the value lives (env var name, vault path) - never the value itself.
  (Secret-shaped content is gated upstream by the `secret-redactor` extension before it reaches the tool.)

When asked to save ephemeral-looking material, push back: _"what was surprising or non-obvious about this that future
sessions would need? That's what I should keep."_

## Save before compaction

When the harness is about to compact the conversation it surfaces a short reminder ("About to compact … save it now").
That is your cue to sweep this session for durable facts that surfaced but were never saved - a preference, a
correction, a project decision, an external pointer - and `save` them before compaction summarizes them away. It is a
_timing_ nudge, not a new rule: apply the same when-to-save / when-NOT-to-save judgment above. If nothing durable is
outstanding, ignore it - do not manufacture a memory just because compaction is near.

## Recall

Indices are injected every turn so you always see what's available. On top of that, the harness now surfaces the
memories most relevant to the current prompt: by default a one-line reminder names the best-matching ids ("Most relevant
saved memories for this request: `…`"); when body injection is enabled it drops their full bodies under a
`## Relevant memory` heading. Treat those as a ranked shortlist, not an instruction - **reading is still your call.** If
a surfaced description looks relevant, `read` it (cheap); if it clearly isn't, skip it. And the harness only ranks
lexically, so it can miss a relevant memory or over-rank a coincidental keyword match - scan the full index too when the
shortlist looks off.

Before acting on memory content, **verify it** (this applies just as much to a recall-surfaced or body-injected memory
as to one you fetched yourself):

- Memory names a file or function? Grep or stat before recommending it - it may have been renamed or removed.
- Memory claims "X exists"? That was true when the memory was written, not necessarily now.
- Memory summarises repo state (activity logs, architecture)? It's frozen in time - prefer `git log` or a fresh read
  over the snapshot when the user asks about _current_ or _recent_ state.

If a memory conflicts with what you observe, trust the observation and `update` (or `remove`) the memory rather than
acting on stale info. A project entry tagged with a `(Nd)` age marker in the index is overdue for exactly this check -
treat the marker as a prompt to re-verify before relying on it.

## Keep memories accurate

- **Duplicate first, write second.** Before `save`, call `list` (or check the injected index) for an existing memory you
  should `update` instead. `save` also runs an automatic similarity check (same scope+type) and prefixes the result with
  a note when the new memory looks like a duplicate - treat that as a prompt to `update` the named entry rather than
  saving a second copy.
- **`update` when facts change.** A memory about a deadline that passed, or a preference that reversed, is worse than no
  memory.
- **`remove` when a memory is flat-out wrong or no longer applies.** Stale memories poison future sessions.

## Anti-patterns

- Writing memory bodies inline into `MEMORY.md`. The index is one-line-per-memory; full content lives in the per-memory
  `.md` file. Let the `memory` tool manage both - never hand-edit MEMORY.md.
- Saving a memory for every user message. Most utterances are transient task context, not durable knowledge. Filter
  hard.
- Saving the same rule with slightly different wording. Prefer `update` over a second `save`.
- Writing a memory phrased as a judgement of the user ("user keeps forgetting to …"). Describe behaviour neutrally or
  phrase as a preference ("user prefers I ask before deleting files").

## Quick reference

| Action   | Required                                    | Optional        | Purpose                                                                |
| -------- | ------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `list`   | -                                           | -               | Print all indices (global + project + session).                        |
| `read`   | `id`                                        | `type`, `scope` | Load a memory's full body.                                             |
| `save`   | `type`, `name`, `description`, `body`       | `scope`         | Create a new memory.                                                   |
| `update` | `id` + at least one of `name`/`desc`/`body` | `type`, `scope` | Rewrite fields on an existing memory.                                  |
| `remove` | `id`, `scope`                               | `type`          | Delete a memory + drop it from MEMORY.md.                              |
| `search` | `query`                                     | -               | Fuzzy + substring match over name/description/body, ranked best-first. |
