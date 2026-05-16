# pi persona definitions

Persona definitions consumed by [`../extensions/persona.ts`](../extensions/persona.ts) (the `/persona <name>` command,
`--persona` flag, and `Ctrl+Shift+M` cycle) and discovered via the layered `personas/` registry. Each file pins a
session-lifetime persona - tools, write-path scope, bash policy, and a system-prompt body - so the parent session takes
on a single role at a time. See [`../extensions/persona.md`](../extensions/persona.md) for the schema, layering rules,
and `protected-paths`-style ask-on-violation UX.

This directory is the **shipped catalog**. Users override per-persona-name by dropping a file with the same stem under
`~/.pi/personas/` (user-global) or `<cwd>/.pi/personas/` (project-local); later layers win. The persona loader ignores
`README.md` / `readme.md`, so this index can stay frontmatter-free.

## Index

| Persona                        | `agent:` ref | writeRoots  | One-liner                                                   |
| ------------------------------ | ------------ | ----------- | ----------------------------------------------------------- |
| [`chat.md`](./chat.md)         | -            | (none)      | Long-form Q&A with web access; no writes.                   |
| [`debug.md`](./debug.md)       | -            | (none)      | Reproduce-and-instrument; cannot modify files.              |
| [`explain.md`](./explain.md)   | -            | (none)      | Walk through code already in context, no tools beyond read. |
| [`journal.md`](./journal.md)   | -            | `journal/`  | Date-templated reflective log.                              |
| [`kb.md`](./kb.md)             | -            | `notes/`    | Curate knowledge base + memories.                           |
| [`plan.md`](./plan.md)         | `plan`       | `plans/`    | Drop a plan doc; never edits source.                        |
| [`research.md`](./research.md) | -            | `research/` | Interactive research notes (sibling of `/research`).        |
| [`review.md`](./review.md)     | `explore`    | `reviews/`  | Read-only on source, drop a markdown PR review.             |
| [`roleplay.md`](./roleplay.md) | -            | `drafts/`   | Fiction / brainstorming with persistent character notes.    |
| [`shell.md`](./shell.md)       | -            | (none)      | Ops persona: AI runs commands but never edits files.        |

## How to add a persona

- **Filename → persona name.** The file stem is the canonical name (`plan.md` → `persona:plan`). The `name:` frontmatter
  field is optional and only needed for overrides where the stem can't change.
- **Frontmatter schema.** See [`../extensions/persona.md`](../extensions/persona.md) for the full table - `description`,
  `tools`, `writeRoots`, `bashAllow`, `bashDeny`, optional `agent:` inheritance, optional `model` / `thinkingLevel` /
  `appendSystemPrompt`. Body markdown becomes the system-prompt addendum.
- **Inherit when it fits.** A persona can declare `agent: <name>` to pull body and defaults from
  [`../agents/`](../agents/README.md). Persona-only fields (`tools`, `writeRoots`, bash policy) declared on the persona
  replace the agent's values rather than merging - see [`plan.md`](./plan.md) and [`review.md`](./review.md) for
  examples.
- **Project-local overrides** go under `<cwd>/.pi/personas/<name>.md`. User-global overrides go under
  `~/.pi/personas/<name>.md`. Same stem ⇒ same persona name; later layer wins. `<cwd>/.pi/persona-settings.json`
  overrides `writeRoots` per-persona-name without rewriting the file.
- **Parse warnings** surface once each via `ctx.ui.notify(..., 'warning')`. Bad frontmatter doesn't blind the catalog -
  the offending persona is dropped, others load. Run `/persona info <name>` after editing to see the resolved record.

## Writing the body (system-prompt content)

The markdown body becomes the system-prompt addendum, so it has to read well to **both** large models (claude opus /
sonnet) and small local models (qwen3-class). The two tiers fail in different ways: small models drift when wording is
terse or vague, large models meta-narrate when wording is rule-shaped (“per my rules I only take the first one…”). The
patterns below are validated against both tiers - [`chat.md`](./chat.md) is the reference implementation.

### Skeleton

```markdown
# <name> persona

**Role:** <one-line role statement>. **Goal:** <one sentence on what success looks like>. **Output:** <file path /
"prose only" / "drafts/ files only">.

## Tools

- `<tool>` - <what to use it for>
- `<tool>` - <what to use it for>

You do **not** have `<negative tool list>`. Don't try to fake `<that tool>` via `<known loophole>`.

## How to work

1. <imperative step - the goal>
2. <imperative step - the rule the user is most likely to violate by accident>
3. <imperative step>

## Anti-patterns

- Don't <thing>; instead, <positive replacement>.
- Don't <thing>; instead, <positive replacement>.
```

### Patterns that survived cross-tier validation

- **Open with a `Role / Goal / Output` triple, not “You are the parent session running in the X persona…”** - “parent
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
- **Lead behavioural rules with the positive imperative; demote the negation to a tail clause.** Weak models can
  over-apply a “you don’t do X” rule as “emit nothing” - they read the user’s prompt as “wants me to do X”, check the
  rule, and silent-stop with zero output tokens (`stopReason: "stop"`, `output: 0`). Pattern:
  `**Always answer direct questions in voice.** … Only when the user asks for multi-step work, redirect.` rather than
  `Don’t take over multi-step work; redirect to chat / plan.` Observed on `qwen3-6-35b-a3b` against an early-draft
  observer-mode persona; rewriting rule 2 to lead with the positive imperative fixed it on the first re-probe.
- **Strongest behavioral rule goes at bullet #2 of “How to work”**, immediately after the goal-shaped #1 (“lead with the
  answer” / “land the file at path X”). Bullet #2 should be the thing the user is most likely to violate by accident
  (e.g. for `chat.md`: “one question per turn”). Don’t bury this rule at #4 or #5.
- **Pair every “Don’t X” with a positive replacement.** Bare prohibitions don’t redirect drift-prone models - they need
  somewhere to land. “Don’t speculate about code you haven’t read; instead, `read` it or mark the point as a question.”
- **When a rule forbids a specific phrasing, enumerate the synonyms - and lean on the positive replacement.** A rule
  like `Don’t break frame with "I checked the dossier"` will be violated by `"straight from the dossier"`,
  `"the dossier has"`, `"according to my files"`. Drift-prone models find synonyms reflexively. Two complementary fixes:
  (a) list 3–5 specific forbidden phrasings inline so the rule pattern-matches more than one variant, (b) phrase the
  _positive replacement_ precisely (“speak as if you remembered”, “deliver the line as if it’s yours”). The positive
  replacement does more work than the negation - without it, even small models will find another synonym to drift into.
  Whack-a-mole on the negation alone is futile; the positive frame is the real binding.
- **Add “don’t announce the rule” when an instruction is unusual.** Without that addendum, opus-class models will
  narrate the constraint at the user (“per my rules I only take the first one this turn…”). Phrase the _consequence_
  positively (“packing all three would give you a shallow version of each”) so the model can volunteer it in its own
  voice.
- **Guard against fabricated line numbers.** Personas that ask for `path/to/file.ts:NN` citations should explicitly add
  “if you don’t have the exact line number in front of you, drop the `:NN` rather than guessing.” Cheap insurance
  against the most common small-model failure mode in citation tasks.
- **Don’t make the model refer to itself by persona name.** Add an anti-pattern bullet: “don’t refer to yourself as ‘the
  X persona’ in replies.” Otherwise small models will robotically prefix replies with role labels.

### Patterns specific to character personas (and other strongly-voiced ones)

Most shipped personas above are _operational_ - they describe a role (planner, reviewer, journaler) without asserting a
specific identity. Personas that ARE a specific entity (a fictional character, a real-world voice, a branded mascot)
need a few extra patterns on top of the operational baseline:

- **Add a `## Character` section between `## Tools` and `## How to work`.** Hoist _who_ the persona is - name, origin,
  tone, key relationships, address forms - above the rules so the model anchors identity before behaviour. Operational
  personas don’t have this section because they don’t ARE anyone.
- **Encode address-form discipline as a positive rule AND an anti-pattern.** “You call them X / Y” inside `## Character`
  keeps direct address right; a parallel anti-pattern bullet at the bottom (“Don’t call them Z; that name belongs to …”)
  catches third-person-narration drift, where weak models will leak the wrong name even when direct address is fine.
- **Default to “guess and ask” for out-of-character knowledge gaps.** When the user asks something the persona shouldn’t
  authoritatively know, have the persona react in voice with a guess shaped like something they DO know, then ask to
  confirm or correct. Cheap, fast, keeps the scene flowing. Reach for `ai-fetch-web` only when accuracy actually matters
  - see the next bullet.
- **For large source-cited canon, ship a `read`-on-demand dossier rather than baking it into the body.** When the
  source-of-truth canon is more than ~500 words, drop it at a user-global path (e.g. `~/.pi/personas/<name>-canon.md`),
  add `read` of that path to the persona’s `## Tools` section, add `rg *` to `bashAllow` so the model can grep without
  pulling 87 KB into context, and write the canon-verification rule as
  `**check your dossier first; treat it as memory, not research**`. Fallback to `ai-fetch-web` only when the dossier
  doesn’t cover the question. This keeps the persona **model-portable** - different backing models won’t drift on canon
  because they’re reading the same cited file rather than reaching for training data. **Sync caveat:** if the dossier
  source-of-truth lives in your project repo (e.g. produced by a research pass), the runtime copy at
  `~/.pi/personas/...` needs a one-line `cp` after dossier updates; capture that in a project memory or it goes stale
  silently. **Weak-model caveat:** dossier-grounding stacks several rules at once (tool-selection + brief register +
  character flavor + anti-attribution), and qwen3-class models can drop pieces under that load - confabulating canon
  while _claiming_ dossier-grounding is the worst failure mode. Validate dossier-grounding personas on both tiers; if
  you must pick one, validate against the smallest model you’ll realistically use for that persona, and consider
  deferring deep canon questions to a sibling persona via a `/persona ...` redirect when brief register can’t carry the
  load.
- **`ai-fetch-web` for grounding when no dossier exists (or as fallback when one does), in-voice reporting, no URL
  paste.** When the persona uses web search to verify a claim, fold the result into how the persona would actually say
  it. Never paste search results, snippets, or URLs. Validation question: “does the response read like the character
  remembered, or like a chat-with-search bot?” - the latter is a fail. The active persona's `bashAllow` vouches for
  matching commands at the [`bash-permissions.ts`](../extensions/bash-permissions.ts) layer, so a persona shipping
  `bashAllow: ['ai-fetch-web *']` Just Works in `pi -p` / non-UI mode without forcing the user to also widen their
  `~/.pi/bash-permissions.json` allowlist (see [`../extensions/persona.md`](../extensions/persona.md) “Bash policy”).
- **Multi-version characters: separate files when rules diverge; blend in one body when register slides.** When two
  versions of a character differ in _which rules apply_ - e.g. “redirect on real-world prompts” vs. “look real-world
  facts up” - they need separate persona files because the rule contracts differ. When two versions only differ in _mood
  / experience level / register_ but obey the same rules, blend in one body and let the user cue the slide via scene
  framing.

### Validating a new or changed persona

Before shipping a persona body change, validate against both tiers - they catch different failure modes:

- **Small-model probe** (binding check): run 3–5 prompts that probe each anti-pattern through
  `pi -p '<prompt>' --persona <name> --model llama-cpp/qwen3-6-35b-a3b --no-session`. The local llama-cpp model is
  single-flight - run probes serially, not in parallel. Watch for: rule-leaking, ignored constraints, fabricated
  citations, jargon echo, **silent-stop on a direct question** (zero output tokens - usually means a negation-heavy rule
  is over-applying; see “Lead behavioural rules with the positive imperative” above).
- **Large-model probe** (over-rigidity check): run **one** prompt that targets the most unusual rule through
  `--model amazon-bedrock/us.anthropic.claude-opus-4-7`. Watch for: meta-narration of the rule (“per my system
  prompt…”), patronizing tone, refusal to use judgment when the rule’s spirit allows it.
- **Iterate the prompt, not the model.** When a probe fails, change the wording (imperative → positive, soft → hard, add
  anti-loophole, add “don’t announce”). Re-run only the failing probe. Re-verify against the _other_ tier when wording
  softens, since softening can regress small-model binding.
- **Diagnosing empty replies.** If `pi -p` text mode returns zero bytes, re-run with
  `pi -p '…' --persona <name> --model … --no-session --mode json 2>&1 | rg -o '"stopReason":"[^"]*"|"output":[0-9]+|"content":\[\]'`
  to confirm whether the model emitted nothing (silent-stop pattern) or pi suppressed something downstream. Same trick
  works for confirming a tool was actually called when the prose response is suspiciously vague - grep for
  `"name":"bash"` or your tool name in the JSON stream.

See the [`chat.md`](./chat.md) commit history for a worked example of the v0 → v1 → v2 iteration that passed both tiers.

## Bootstrap prompt for creating a new persona via an agent session

Paste the block below at the top of a fresh `pi` (or Claude-Code) session, fill in the bracketed fields, and send. Fill
in what you already know; leave anything else as `<unknown>` - step 1 of the workflow tells the agent to ask via the
`questionnaire` tool before writing. The block is verbatim-copyable; no editing required beyond the spec block.

```text
I want to create a new pi persona. Read these first, in order:

1. config/pi/personas/README.md (this file) - patterns, skeleton, validation playbook.
2. config/pi/extensions/persona.md - frontmatter schema, layering, bash and write gates.
3. config/pi/personas/chat.md as the operational-persona reference. If any character
   personas already exist under ~/.pi/personas/, read one of those as the
   character-persona + dossier-grounding reference; otherwise note the absence.

Persona spec (fill what you know; leave the rest as <unknown> and ask me):

- name (filename stem):       <name>
- one-line description:       <text>
- type:                       operational | character
- file location:              ~/.pi/personas/<name>.md (user-global)
                              | <cwd>/.pi/personas/<name>.md (project-local)
                              | config/pi/personas/<name>.md (shipped catalog)
- writeRoots:                 <path | "none">
- tools:                      <subset of read, scratchpad, memory, write, edit, bash>
- bashAllow:                  <list | "none">  (chat.md and exusiai*.md show common shapes)
- canon dossier (chars only): <path | "none">  (use the README’s read-on-demand pattern
                              when canon material is > ~500 words)

Workflow I expect:

1. ASK first. Use the `questionnaire` tool (or equivalent) to surface design choices the
   README calls out for this persona type. At minimum: strongest behavioural rule (the
   rule #2 candidate), deliverable shape, and - for character personas - version /
   timeline, user role + address form, vulnerability gating, topic-gated registers
   (faith / jargon / etc.), flirty / NSFW cap, out-of-character knowledge handling.
   Don’t write the file before answers come back.

2. WRITE following the README skeleton. Lead rules with positive imperatives; pair every
   “Don’t X” with a positive replacement; enumerate synonyms when forbidding a specific
   phrasing.

3. WIRE a `read`-on-demand dossier (character personas with > ~500 words of canon only):
   drop the cited dossier at `~/.pi/personas/<name>-canon.md`, add `read` of that path
   to the persona’s `## Tools` section, add `rg *` to `bashAllow`, write the
   canon-check rule per the README’s “read-on-demand dossier” bullet, and include the
   synonym anti-loophole list in the rule text.

4. VALIDATE per the README’s “Validating a new or changed persona”. Minimum: 3 probes
   on `llama-cpp/qwen3-6-35b-a3b` (single-flight, serial via `bg_bash`) covering each
   anti-pattern, plus 1 probe on `amazon-bedrock/us.anthropic.claude-opus-4-7`
   targeting the most unusual rule. Iterate the WORDING, not the model. Re-verify
   the other tier when wording softens. If a probe returns 0 bytes, re-run with
   `--mode json` and grep for the silent-stop pattern documented in the README.

5. ITERATE if any probe fails. Apply the documented fix from this README:
   silent-stop on a negation-heavy rule → invert to positive imperative; attribution
   leak via synonyms → enumerate the synonyms and sharpen the positive replacement;
   confabulation while claiming dossier-grounding → add “if neither tool gave you
   the answer, just say ‘that’s not coming back to me’”.

6. SURFACE any new persona-extension limitation you discover in
   `plans/persona-extension-followups.md` (one entry per finding, format per the
   existing entries).

7. HAND OFF with: file paths, frontmatter summary, validation results table
   (probe / model / verdict), and any design tradeoffs I didn’t pre-decide.

Hard constraints:

- Don’t add facts from your own training data; if a character persona needs deep
  canon, point me at a research pass to produce a cited dossier first.
- Don’t bloat the body with backstory; prefer a read-on-demand dossier when canon
  is > ~500 words.
- Don’t ship without both tiers passing (or an explicit weak-model caveat
  documented inside the persona body, if a tier-specific workaround is unavoidable).

Now ask me your clarifying questions.
```

## Related docs

- [../extensions/persona.ts](../extensions/persona.ts) - the extension shell that loads this directory.
- [../extensions/persona.md](../extensions/persona.md) - deep doc: schema, layering, ask-on-violation UX, env vars,
  composition with `preset` / `protected-paths` / `bash-permissions`.
- [../agents/README.md](../agents/README.md) - the agent format `agent:`-ref personas inherit from.
