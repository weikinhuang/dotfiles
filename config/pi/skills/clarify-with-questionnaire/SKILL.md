---
name: clarify-with-questionnaire
description:
  "WHAT: Decide when to stop and ask the user a structured clarifying question with the `questionnaire` tool versus
  inferring and proceeding, and how to shape good single / multi / free questions with mutually-exclusive options. WHEN:
  A decision is genuinely the user's to make and the wrong guess is costly to undo. DO-NOT: Ask what you can read from
  the code, ask trivia with a sensible default, or stack questions for things you should just decide."
---

# Clarify with questionnaire

The `questionnaire` tool pauses the turn and opens a full-screen TUI: a tab bar of questions plus a `Submit` tab, each
question rendering radio options (`single`), checkboxes (`multi`), or a free-text editor (`free`). It returns both a
human-readable answer block and structured `details.answers`. It is the right way to ask when a decision is the user's
to make - and the wrong way to offload choices you should make yourself. This skill is the policy for ask-vs-infer and
for phrasing questions the user can answer in one keystroke.

## When to use this skill

Ask with `questionnaire` when ALL of these hold:

- **The answer is genuinely the user's call** - a product preference, a scope decision, a trade-off only they can weigh
  (budget, risk tolerance, which of two valid designs).
- **You cannot resolve it from the request, the code, or a sensible default.** If reading a file or `git log` settles
  it, do that instead.
- **A wrong guess is costly** - hard to undo, or it would send you down a long path the user did not want.

Infer and proceed (do NOT ask) when:

- **The code or repo answers it.** Read it. Asking what you could grep wastes the user's attention.
- **There is an obvious default.** Pick it, state the assumption in your reply, and move on. "I used X; say the word if
  you'd rather Y" beats a blocking dialog.
- **The choice is reversible and cheap.** Just do it; course-correct if the user objects.
- **You are asking to cover yourself**, not because the answer changes what you do next.

The bar: ask only when the answer changes your next action and you genuinely cannot supply it yourself.

## Workflow

1. **Confirm the question is worth a tool call.** Run it past the ask-vs-infer test above. One sharp question beats
   three reflexive ones.
2. **Pick the kind per question:**
   - `single` - mutually-exclusive choice. Pressing a digit `1`-`9` or `Enter` selects and auto-advances. Default kind.
   - `multi` - independent options that can combine. Requires `Space` to toggle; set `minSelect` / `maxSelect` to bound
     the selection.
   - `free` - no good closed option set; drops the user straight into an editor.
3. **Write the prompt and options:**
   - Make `single` options **truly mutually exclusive** - if two could both be chosen, it is a `multi`.
   - Give each option a short `label` and, when the trade-off is not obvious, a `description` sub-line.
   - Lead with your recommended option when you have one, and say so in its label or description.
   - Use `preview` (multi-line ASCII / code / diff) when the user needs to compare concrete artifacts side by side; the
     pane renders beside the option on wide terminals.
4. **Keep `allowOther` and `allowNotes` on** (both default `true`) so the user can type a custom answer or annotate -
   you rarely enumerate every option perfectly.
5. **Read the structured answer.** `details.answers` carries `value` / `label` / `index` for `single`, `values[]` /
   `labels[]` / `indices[]` for `multi`, and `customText` + `wasCustom` when the user picked `Type something.`. Branch
   on the structured fields, not the prose.
6. **Handle the escape hatches.** `c` ("Chat about this") returns `chatRequested: true` with the question id - continue
   in prose instead of forcing the form. A cancel sets `details.cancelled`. If `ctx.hasUI` is false the tool errors and
   asks you to put the question in chat - so in headless runs, just ask inline.

## Phrasing options well

- **One axis per question.** Do not fold "which approach AND which scope" into one option list - split into two
  questions (separate tabs).
- **Exhaustive within reason.** Cover the realistic answers; `allowOther` catches the rest. Do not pad with
  near-duplicates.
- **No leading or loaded labels** unless you are explicitly recommending - then mark the recommendation openly.
- **`multi` needs a clear floor.** Set `minSelect: 1` if at least one choice is mandatory, so the user cannot submit an
  empty selection.

## Common pitfalls

- **Asking what you could read.** The most common misuse. Grep first.
- **`single` options that overlap.** The user cannot express "both" - that is a `multi`.
- **Stacking questions to seem thorough.** Each question is a context switch for the user. Ask the few that matter.
- **Ignoring `wasCustom`.** A custom `Type something.` answer will not match any option `value` - check `wasCustom` /
  `customText` before assuming the answer is one of your options.
- **Forgetting `minSelect` on a mandatory `multi`.** Without it the user can submit nothing checked.
- **Blocking in a headless session.** No UI means the tool errors - ask in prose when `ctx.hasUI` is false.

## Related docs

- [`questionnaire.md`](../../extensions/questionnaire.md) - full tool reference: question kinds, per-option fields,
  answer shapes, TUI keybindings.
- [`deep-research-when`](../deep-research-when/SKILL.md) - clarify scope with this tool before launching an expensive
  research run.
