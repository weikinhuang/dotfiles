---
name: plan-first
description:
  Plan multi-step work up front with the `todo` tool so the plan survives context compaction and stays visible every
  turn. Use whenever the user's request has two or more distinct steps, touches multiple files, mixes change + verify
  phases (e.g. "fix the bug and add a test", "refactor X and update docs"), or is exploratory work where the steps
  aren't fully known at the start. Do NOT use for single-tool-call asks, trivial one-shot questions you can answer
  inline, or work that's already scoped by an active `check` iteration-loop task.
---

# Plan First

Write the plan before doing the work. The `todo` tool is your external memory - anything you record there stays visible
on every future turn, even after context compaction, and lets the user see exactly where you are in a multi-step task.

## When to plan

Trigger planning when ANY of these are true:

- The request has 2+ distinct goals ("add X and update Y").
- The request has change + verify steps ("fix the bug and run the tests").
- You'll need to touch 3+ files.
- You're starting exploratory work where you don't yet know all the steps.

Skip planning for trivial single-step asks: "what does this file export?", "show me line 40", "rename this variable". No
plan needed when the whole request is one tool call.

## Workflow

**1. Draft the plan.** Call `todo` with `action: "add"` and an `items` array containing one short, verifiable step per
entry. Each step should be something you can clearly tell is "done" or "not done". Prefer 3–8 items; fewer if the task
is small, more only if it's genuinely complex.

```json
{
  "action": "add",
  "items": [
    "Read foo.ts and bar.ts to locate the bug",
    "Write a failing test that reproduces it",
    "Apply the fix",
    "Run the test suite",
    "Update CHANGELOG.md"
  ]
}
```

**2. Start one item.** Call `todo` with `action: "start"` and the id of the first item:

```json
{ "action": "start", "id": 1 }
```

Only one todo may be `in_progress` at a time - this is enforced by the tool. Trying to start a second one while another
is active will return an error.

**3. Do the work.** Use other tools (read / bash / edit / write / grep / etc.) to execute the current item. Stay focused
on the one thing that's `in_progress`.

**4. Park in review for verification.** When the change is written but you haven't yet confirmed it works, move the item
to the `review` column:

```json
{ "action": "review", "id": 1, "note": "fix applied - need to run tests" }
```

`review` can only be entered from `in_progress`, and at most one item may be in review at a time (separate limit from
`in_progress` - you can have one `in_progress` and one `review` simultaneously, e.g. tests running on item A while you
start coding item B). The `note` is optional but helpful as a reminder of what still needs verifying.

**5. Verify.** Actually check the outcome matches what the step promised:

- "Run tests" → the last `bash` call must have shown the tests passing.
- "Apply fix" → the `edit` or `write` succeeded and the change is visible in the file.
- "Read foo.ts" → you've actually read it, not just searched for it.

If verification reveals more work is needed, move the item back to in_progress with `action: "start"`, fix it, and
return to `review`.

**6. Complete.** Once verified:

```json
{ "action": "complete", "id": 1 }
```

From `review`, the note is optional - the review step was the verification parking, so the tool trusts that verification
happened. You can add a final note (`"note": "all 47 tests pass"`) if it's worth recording.

If verification is immediate (e.g., you ran the tests as part of doing the work and don't need a separate parking step),
you can skip `review` and go straight from `in_progress` to `complete` - but the tool will then **require** a `note`
describing what verified the outcome:

```json
{ "action": "complete", "id": 1, "note": "bash call in previous turn showed 47/47 passing" }
```

This is the forcing function: either the plan shows you parked for verification (review step), or you spell out what
evidence makes you confident it's done.

**7. Next item.** Call `start` on the next pending todo. Repeat.

**8. Handle obstacles.** If you can't make progress - missing info, broken env, failing test you can't diagnose, unclear
spec - don't silently move on. Call `block` with a `note` explaining the blocker:

```json
{ "action": "block", "id": 3, "note": "The test harness requires FOO_TOKEN which isn't in the env" }
```

Then surface the blocker to the user. They can unblock you or repivot.

**9. Adapt as you learn.** The initial plan won't always be right:

- New work surfaces mid-task: `add` more items.
- A step turns out to be unnecessary: `complete` it with a note like "not needed, handler already supports this".
- The whole direction needs to change: `clear` and start over.

## Anti-patterns

- **Don't mark items complete you haven't verified.** "I think that's done" is not complete. Either park it in `review`,
  verify, then complete; or complete directly with a `note` spelling out the evidence.
- **Don't skip planning because "this will only take a second."** If you were wrong, the plan costs you nothing and
  saves a derailed session.
- **Don't start a second item while one is `in_progress`.** Finish (or `review`, or `block`) the first. The tool will
  reject the second `start`.
- **Don't stack items in `review`.** One review slot; verify and `complete` (or `start` again to revise) before parking
  another.
- **Don't claim you're "done" while `in_progress`, `review`, or `pending` todos remain.** Either finish them or mark
  them blocked and explain why. The harness will catch and re-prompt you if you try - save the round trip by
  self-checking first.
- **Don't over-decompose.** "Open file", "read line 10", "close file" is too fine-grained. One verifiable outcome per
  todo.
- **Don't forget to `add` items that emerge mid-task.** A plan that doesn't reflect reality is worse than no plan.

## Full example

User: _"Please add a rate-limiter to the /api/search endpoint and write tests for it."_

Good opening move:

```json
{
  "action": "add",
  "items": [
    "Read src/api/search.ts to find the handler entry point",
    "Design the rate-limiter shape (sliding window, per-IP)",
    "Implement src/lib/rate-limit.ts",
    "Wire it into the search handler",
    "Add unit tests for rate-limit.ts",
    "Run the test suite and verify green"
  ]
}
```

Then `{ "action": "start", "id": 1 }` and begin.

After reading the file:

```json
{ "action": "complete", "id": 1, "note": "entry point at searchHandler() in search.ts:42" }
{ "action": "start", "id": 2 }
```

For later items that need verification (like running tests), park first:

```json
{ "action": "review", "id": 6, "note": "invoked npm test; waiting on output" }
```

...then after seeing green output:

```json
{ "action": "complete", "id": 6 }
```

...and so on until the final `complete`, at which point you tell the user the task is done.

## Quick reference

| Action     | Required          | Optional | Purpose                                                                                                                             |
| ---------- | ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list`     | -                 | -        | Print the current plan.                                                                                                             |
| `add`      | `text` OR `items` | -        | Append one (or many) pending todos.                                                                                                 |
| `start`    | `id`              | -        | Mark a todo `in_progress`. At most one at a time. Also used to move a `review` item back to `in_progress` when more work is needed. |
| `review`   | `id`              | `note`   | Move an `in_progress` item to `review` (verification parking). At most one at a time.                                               |
| `complete` | `id`              | `note`¹  | Mark a todo done. ¹**Required** when transitioning directly from `in_progress`; optional from `review` or other states.             |
| `block`    | `id`, `note`      | -        | Flag a blocker; `note` is required.                                                                                                 |
| `reopen`   | `id`              | -        | Return a completed or blocked todo to `pending`.                                                                                    |
| `clear`    | -                 | -        | Wipe the plan. Use when pivoting direction entirely.                                                                                |
