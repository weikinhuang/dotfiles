# pi persona definitions

Persona definitions consumed by [`../extensions/persona.ts`](../extensions/persona.ts) (the `/persona <name>` command,
`--persona` flag, and `Ctrl+Shift+M` cycle) and discovered via the layered `personas/` registry. Each file pins a
session-lifetime persona — tools, write-path scope, bash policy, and a system-prompt body — so the parent session takes
on a single role at a time. See [`../extensions/persona.md`](../extensions/persona.md) for the schema, layering rules,
and `protected-paths`-style ask-on-violation UX.

This directory is the **shipped catalog**. Users override per-persona-name by dropping a file with the same stem under
`~/.pi/personas/` (user-global) or `<cwd>/.pi/personas/` (project-local); later layers win. The persona loader ignores
`README.md` / `readme.md`, so this index can stay frontmatter-free.

## Index

| Persona                        | `agent:` ref | writeRoots  | One-liner                                                   |
| ------------------------------ | ------------ | ----------- | ----------------------------------------------------------- |
| [`chat.md`](./chat.md)         | —            | (none)      | Long-form Q&A with web access; no writes.                   |
| [`debug.md`](./debug.md)       | —            | (none)      | Reproduce-and-instrument; cannot modify files.              |
| [`explain.md`](./explain.md)   | —            | (none)      | Walk through code already in context, no tools beyond read. |
| [`journal.md`](./journal.md)   | —            | `journal/`  | Date-templated reflective log.                              |
| [`kb.md`](./kb.md)             | —            | `notes/`    | Curate knowledge base + memories.                           |
| [`plan.md`](./plan.md)         | `plan`       | `plans/`    | Drop a plan doc; never edits source.                        |
| [`research.md`](./research.md) | —            | `research/` | Interactive research notes (sibling of `/research`).        |
| [`review.md`](./review.md)     | `explore`    | `reviews/`  | Read-only on source, drop a markdown PR review.             |
| [`roleplay.md`](./roleplay.md) | —            | `drafts/`   | Fiction / brainstorming with persistent character notes.    |
| [`shell.md`](./shell.md)       | —            | (none)      | Ops persona: AI runs commands but never edits files.        |

## How to add a persona

- **Filename → persona name.** The file stem is the canonical name (`plan.md` → `persona:plan`). The `name:` frontmatter
  field is optional and only needed for overrides where the stem can't change.
- **Frontmatter schema.** See [`../extensions/persona.md`](../extensions/persona.md) for the full table — `description`,
  `tools`, `writeRoots`, `bashAllow`, `bashDeny`, optional `agent:` inheritance, optional `model` / `thinkingLevel` /
  `appendSystemPrompt`. Body markdown becomes the system-prompt addendum.
- **Inherit when it fits.** A persona can declare `agent: <name>` to pull body and defaults from
  [`../agents/`](../agents/README.md). Persona-only fields (`tools`, `writeRoots`, bash policy) declared on the persona
  replace the agent's values rather than merging — see [`plan.md`](./plan.md) and [`review.md`](./review.md) for
  examples.
- **Project-local overrides** go under `<cwd>/.pi/personas/<name>.md`. User-global overrides go under
  `~/.pi/personas/<name>.md`. Same stem ⇒ same persona name; later layer wins. `<cwd>/.pi/persona-settings.json`
  overrides `writeRoots` per-persona-name without rewriting the file.
- **Parse warnings** surface once each via `ctx.ui.notify(..., 'warning')`. Bad frontmatter doesn't blind the catalog —
  the offending persona is dropped, others load. Run `/persona info <name>` after editing to see the resolved record.

## Writing the body (system-prompt content)

The markdown body becomes the system-prompt addendum, so it has to read well to **both** large models (claude opus /
sonnet) and small local models (qwen3-class). The two tiers fail in different ways: small models drift when wording is
terse or vague, large models meta-narrate when wording is rule-shaped (“per my rules I only take the first one…”). The
patterns below are validated against both tiers — [`chat.md`](./chat.md) is the reference implementation.

### Skeleton

```markdown
# <name> persona

**Role:** <one-line role statement>. **Goal:** <one sentence on what success looks like>. **Output:** <file path /
"prose only" / "drafts/ files only">.

## Tools

- `<tool>` — <what to use it for>
- `<tool>` — <what to use it for>

You do **not** have `<negative tool list>`. Don't try to fake `<that tool>` via `<known loophole>`.

## How to work

1. <imperative step — the goal>
2. <imperative step — the rule the user is most likely to violate by accident>
3. <imperative step>

## Anti-patterns

- Don't <thing>; instead, <positive replacement>.
- Don't <thing>; instead, <positive replacement>.
```

### Patterns that survived cross-tier validation

- **Open with a `Role / Goal / Output` triple, not “You are the parent session running in the X persona…”** — “parent
  session” is harness jargon that small models echo back awkwardly. The triple gives both tiers a stable anchor in the
  first three lines of the prompt.
- **Tools go in an allowlist bullet block, then a single negative line.** Mixed-polarity prose paragraphs (“you have X,
  no Y, only Z under bash, no edits”) are the biggest small-model drift source. Lead with positives, end with one short
  “you do **not** have W; don’t fake it via `<loophole>`” sentence.
- **Hoist the output contract.** Personas with a deliverable (file path + structure) must surface the path on a single
  `**Output:**` line near the top. Burying “land the plan as `plans/<slug>.md`” mid-prose means small models often act
  before reading it.
- **Imperative bullets, not declarative ones.** “Write files as markdown with kebab-case names” binds; “Files are
  markdown, kebab-case names” reads as worldbuilding.
- **Strongest behavioral rule goes at bullet #2 of “How to work”**, immediately after the goal-shaped #1 (“lead with the
  answer” / “land the file at path X”). Bullet #2 should be the thing the user is most likely to violate by accident
  (e.g. for `chat.md`: “one question per turn”). Don’t bury this rule at #4 or #5.
- **Pair every “Don’t X” with a positive replacement.** Bare prohibitions don’t redirect drift-prone models — they need
  somewhere to land. “Don’t speculate about code you haven’t read; instead, `read` it or mark the point as a question.”
- **Add “don’t announce the rule” when an instruction is unusual.** Without that addendum, opus-class models will
  narrate the constraint at the user (“per my rules I only take the first one this turn…”). Phrase the _consequence_
  positively (“packing all three would give you a shallow version of each”) so the model can volunteer it in its own
  voice.
- **Guard against fabricated line numbers.** Personas that ask for `path/to/file.ts:NN` citations should explicitly add
  “if you don’t have the exact line number in front of you, drop the `:NN` rather than guessing.” Cheap insurance
  against the most common small-model failure mode in citation tasks.
- **Don’t make the model refer to itself by persona name.** Add an anti-pattern bullet: “don’t refer to yourself as ‘the
  X persona’ in replies.” Otherwise small models will robotically prefix replies with role labels.

### Validating a new or changed persona

Before shipping a persona body change, validate against both tiers — they catch different failure modes:

- **Small-model probe** (binding check): run 3–5 prompts that probe each anti-pattern through
  `pi -p '<prompt>' --persona <name> --model llama-cpp/qwen3-6-35b-a3b --no-session`. The local llama-cpp model is
  single-flight — run probes serially, not in parallel. Watch for: rule-leaking, ignored constraints, fabricated
  citations, jargon echo.
- **Large-model probe** (over-rigidity check): run **one** prompt that targets the most unusual rule through
  `--model amazon-bedrock/us.anthropic.claude-opus-4-7`. Watch for: meta-narration of the rule (“per my system
  prompt…”), patronizing tone, refusal to use judgment when the rule’s spirit allows it.
- **Iterate the prompt, not the model.** When a probe fails, change the wording (imperative → positive, soft → hard, add
  anti-loophole, add “don’t announce”). Re-run only the failing probe. Re-verify against the _other_ tier when wording
  softens, since softening can regress small-model binding.

See the [`chat.md`](./chat.md) commit history for a worked example of the v0 → v1 → v2 iteration that passed both tiers.

## Related docs

- [../extensions/persona.ts](../extensions/persona.ts) — the extension shell that loads this directory.
- [../extensions/persona.md](../extensions/persona.md) — deep doc: schema, layering, ask-on-violation UX, env vars,
  composition with `preset` / `protected-paths` / `bash-permissions`.
- [../agents/README.md](../agents/README.md) — the agent format `agent:`-ref personas inherit from.
