# `questionnaire.ts`

Structured Q&A TUI tool the model calls to ask the user clarifying questions. Overrides the bundled example at
`examples/extensions/questionnaire.ts` with multi-kind questions, per-option previews, notes, and a chat escape hatch.

## What it does

The model calls `questionnaire` with an array of questions. Pi pauses the turn and opens a full-screen TUI
(`ctx.ui.custom`) showing a tab bar of question labels + a `✓ Submit` tab, the current question's prompt, and its
options (or an editor for free-text). The user navigates, answers each question, reviews the summary, and submits; the
tool returns a flat text block of answers plus structured `details` back as the tool result.

Question kinds:

- **single** — radio list; pressing `Enter` (or a digit `1`-`9`) selects and auto-advances to the next tab.
- **multi** — checkbox list with `[ ]` / `[x]` rows and a trailing `→ Next` terminator that commits the selection once
  `minSelect` is satisfied.
- **free** — no option list; typing drops straight into an `Editor` instance and `Enter` (editor-submit) saves the
  answer.

Every option row can ship a `preview` string (ASCII art / code / diff) rendered in a bordered side pane beside the
highlighted option when the terminal is ≥100 cols wide (`PREVIEW_MIN_WIDTH`), stacked below the options otherwise. Each
question can opt into a `Type something.` row (`allowOther`, default on) whose row _is_ the live input field — printable
keys flow into it, `Enter` commits it as a custom answer, and the buffer is persisted per-question across tab
navigation. Each question can also opt into notes via `n` (`allowNotes`, default on), which opens the editor and
attaches a `note` string to the answer. Finally, `c` triggers the "Chat about this" escape hatch: cancels the
questionnaire and returns `chatRequested: true` plus the question id the user was on so the model continues in prose.

## Tool: `questionnaire`

Top-level params:

- `questions: Question[]` — required, non-empty.
- `allowChat?: boolean` — show the `c` escape hatch + footer hint. Default `true`.

Per question:

| Field        | Type                            | Notes                                                                    |
| ------------ | ------------------------------- | ------------------------------------------------------------------------ |
| `id`         | `string`                        | Required, unique. Used as the answer key and `chatContextId`.            |
| `prompt`     | `string`                        | Required. Full question text shown above the options.                    |
| `label`      | `string?`                       | Short tab-bar label. Defaults to `Q1`, `Q2`, …                           |
| `kind`       | `'single' \| 'multi' \| 'free'` | Default `single`.                                                        |
| `options`    | `QuestionOption[]?`             | Required for `single` / `multi`, ignored for `free`.                     |
| `allowOther` | `boolean?`                      | Default `true`. Appends a `Type something.` inline-input row.            |
| `allowNotes` | `boolean?`                      | Default `true`. Enables `n` to open a notes editor.                      |
| `minSelect`  | `integer?`                      | Multi only. `Next` stays disabled until `≥ minSelect` boxes are checked. |
| `maxSelect`  | `integer?`                      | Multi only. Further toggles are ignored once `maxSelect` is reached.     |

Per option:

- `value: string` — returned as the answer's `value`.
- `label: string` — display label.
- `description?: string` — muted sub-line below the label.
- `preview?: string` — multi-line; rendered in the side/bottom preview pane when highlighted.

Answer shape returned to the model (one per question in `details.answers`):

- Common: `id`, `kind`, optional `note`.
- Single: `value`, `label`, `index` (1-based); with `wasCustom: true` + `customText` when the user picked
  `Type something.`.
- Multi: `values[]`, `labels[]`, `indices[]` (1-based, sorted).
- Free: `customText`, `label`, `value` all set to the trimmed editor buffer, `wasCustom: true`.

The text `content` is a human-readable flattening (`<label>: user selected: 2. Foo (note: …)`). On cancel or
chat-request the `content` is a one-line summary and `details.cancelled` / `details.chatRequested` are set. If
`ctx.hasUI` is false the tool returns an error asking the model to ask the question in chat instead.

## TUI affordances

- `↑` / `↓` — navigate options (no `j`/`k` alias).
- `1`-`9` — jump to option N. On `single`, also auto-confirms unless the target is the `Type something.` row. On
  `multi`, only moves the cursor — `Space` is still required to toggle.
- `Space` — toggle checkbox on `multi`. No-op on `Next` / `Type something.` rows.
- `Enter` — select (single) / toggle (multi, alias for Space) / commit `Next` / commit `Type something.` / submit the
  editor in `free` + `note` modes.
- `Tab` / `Shift+Tab` / `←` / `→` — switch question tabs (only when there is more than one question); wraps through the
  trailing `✓ Submit` review tab.
- `n` — open the notes editor for the current question (when `allowNotes`). Submitting stores the note; submitting empty
  clears it.
- `c` — "Chat about this" escape hatch (when `allowChat`, and not while focused on the `Type something.` row).
- `Esc` — cancel the questionnaire. On a non-empty `Type something.` row, first press clears the buffer; second press
  cancels.
- Tab bar — each question renders as `☐ Label` (unanswered, muted) or `■ Label` (answered, success color), with the
  active tab reverse-video; the trailing `✓ Submit` tab lights up once every question has an answer.
- Review tab — lists every answer (or `(unanswered)`) with notes, warns about missing answers, and offers a
  `Submit answers` / `Cancel` picker. `Submit answers` is disabled until all questions are answered.
- Footer — dynamic help line reflecting the current mode (editor vs options vs review, multi vs single, whether notes /
  chat are enabled).

## Environment variables

None. The tool has no env-var knobs; behaviour is fully driven by the per-call `questions` / `allowChat` parameters.

## Hot reload

Edit [`extensions/questionnaire.ts`](./questionnaire.ts) and run `/reload` in an interactive pi session to pick up
changes without restarting.
