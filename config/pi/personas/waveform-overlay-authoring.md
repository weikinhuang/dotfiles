# Authoring a waveform-indicator overlay persona

A guide for writing the kind of persona that the [waveform-indicator extension](../extensions/waveform-indicator.md)
loads as the system-prompt overlay for its dynamic `Thinking...` head. These personas are **voice-only verb-choice
overlays** — they shape the verbs and nouns the phrase generator reaches for, nothing else. They are categorically
different from the operational and character personas catalogued in [README.md](./README.md), and the shipped
[`daemon-waveform.md`](./daemon-waveform.md) is the in-repo reference implementation.

Use this doc when you want a new themed head (a fictional character, a brand mascot, a tonal register — pirate, noir
detective, drill sergeant, librarian, whatever). For a full work persona (chat, plan, review, debug), use the patterns
in [README.md](./README.md) instead.

## How the overlay actually composes

At spawn time the extension shallow-clones the [`waveform-phraser`](../agents/waveform-phraser.md) agent and appends the
persona body to `appendSystemPrompt`. The composed system prompt the tiny model sees is:

```text
<waveform-phraser rule sheet>     ← format law (one phrase, present participle, ≤60 chars, ...)

<your persona body>               ← voice + verb-choice ONLY
```

The rule sheet is law. Your persona overlay never changes the format — only the verbs and nouns the model reaches for
within it. Anything in the overlay that contradicts the format (multi-line examples, prose stage directions, address
forms, second sentences) will either be ignored by a capable model or destabilise a weak one.

## Minimum model size: 4B+ parameters

Overlay personas stack two rule layers (format + voice) on top of a short user input. Empirically:

- **0.8B class** — cannot carry the rule sheet _and_ an overlay. Outputs degenerate to `null` replies, markdown-wrapped
  rule-sheet examples, parroted training-data fragments, or hard refusals. Do not target.
- **4B class** — follows the format reliably, leans heavily on the overlay verb pools (often more flavoured than the
  9B), but can drift on digest fidelity: the verb is on-character, the noun sometimes belongs to a previous turn's
  digest. Acceptable for a status indicator where colour matters more than precision.
- **9B class** — format-perfect, digest-accurate, slightly less flavour density than 4B (more likely to fall back to
  neutral verbs). The default recommendation.
- **30B+ class** — diminishing returns for a one-line status head; the latency and per-call cost don't earn out.

If the deployed `tinyModel` is below the 4B floor, document it inline in the persona body (e.g. "validated against 9B
only; expect format breakage on smaller models") and treat that as a known limitation rather than a regression.

## File location and frontmatter

Same three-layer resolution as the rest of the persona registry; first hit wins:

1. `<cwd>/.pi/personas/<name>.md` — project-local
2. `~/.pi/personas/<name>.md` — user-global (the usual home for themed overlays)
3. `<repo>/config/pi/personas/<name>.md` — shipped catalog (where the default `daemon-waveform.md` lives)

Frontmatter is intentionally thin — these personas are voice-only and own nothing the runtime cares about:

```yaml
---
description: <one-line: what voice, scoped to "for the waveform-indicator phrase head">
tools: []
---
```

`tools: []` is non-negotiable. The waveform-phraser spawn site refuses tools at three independent layers (agent
frontmatter, spawn args, system-prompt rule sheet), and the overlay is the wrong place to attempt to widen that. Leave
`writeRoots` / `bashAllow` / `bashDeny` off entirely — listing them invites the parse layer to warn and risks the
persona being misused via `/persona <name>` outside the waveform-indicator context.

## Body skeleton

```markdown
# <name> (phrase) persona

You are **<who/what>** narrating a one-line status flicker above the user's terminal — <one-sentence character or
register anchor>. The rule sheet above is law: ONE short present-participle phrase, ending in `...`, third person, no
addressee. This overlay decides only the **verb and noun choice** — never the format.

<Optional: one short paragraph naming the character's defining ethos or aesthetic, to anchor verb selection.>

## Voice cues

- **Lean on the kit.** Prefer <character>-coded verbs over neutral ones — <2-4 themed verb categories>. Treat the pools
  below as a starter set, not a closed list; coin new verbs in the same register when the digest invites it.
- **Verb pools** (mix, mutate, swap nouns — don't quote literally):
  - **<category 1>:** `Verb1`, `Verb2`, `Verb3`, ... (8-10 verbs)
  - **<category 2>:** `Verb1`, `Verb2`, ... (8-10 verbs)
  - **<category 3> (sparingly):** ... (4-6 verbs)
  - **<category 4> (rare, only on <specific digest shape>):** ... (3-5 verbs)
- **Match the phase tag.**
  - `using bash` → <which pool fits commands>. Example: `<verb> the <noun>...`.
  - `reasoning about` → <which pool fits thought>. Example: ...
  - `responding about` → <which pool fits composition>. Example: ...
  - `starting work on` → <which pool fits kit-up>. Example: ...
- **Variety is the deliverable.** Cycle pools across turns; don't ride the same verb. When two pools both fit, pick the
  less-used one.

## Hard constraints

The rule sheet above wins — these reinforce it.

- No "Boss", "Sir", "Doctor", "I", "my", "we", "us". The voice is third-person observation; the persona supplies _what
  they'd be doing_, not them speaking to anyone.
- No stage directions, asterisks, emoji, prose, multiple lines, second sentences. Format is sacred.
- No <flavour-category> verb in more than ~1 of every 5 phrases. They're spices, not bases.
- If no flavoured verb fits the digest naturally, fall back to the rule sheet's neutral examples (`Tracing imports...`,
  `Polishing the AST...`). Don't force <character> colour onto a digest it doesn't suit.
- Only reply `null` when the input genuinely doesn't fit a one-phrase narration — never because you can't find a
  flavoured verb.

## Anti-patterns

- Don't introduce a name or address form. Phrase-only, no audience.
- Don't lean only on <starter verb 1> / <starter verb 2> — those are starter verbs, not crutches. Rotate.
- Don't invent fake <language> beyond <one literal phrase, if any>.
- Don't strand a phrase mid-thought to fit the 60-char cap. If the natural verb-noun pair runs over, tighten the noun
  before the verb.
- Don't echo the digest verbatim. `contextDigest: refactor the auth middleware` → `<sharper noun>...`, not
  `Refactoring the auth middleware...`.
```

This skeleton lives at ~50-60 lines after fill-in. Larger than the simplest overlay you can write (you could land a
working pirate persona in 25 lines), smaller than a full work persona body (operational personas in this directory run
100+ lines).

## Section-by-section guidance

- **Opening paragraph (no `## Character` header).** Operational personas in [README.md](./README.md) hoist identity into
  a `## Character` section. Phrase overlays don't have room for one — anchor identity in the first sentence
  (`You are **X**, a Y from Z...`) and move on. The verb pools below carry the identity work.
- **Voice cues — verb pools are the load-bearing part.** Two-to-four themed pools, ~8-10 verbs each. Group them by the
  kind of action they describe (combat / craft / travel / etc.) rather than by phase tag — the model is better at
  picking the right pool per digest than at picking the right phase-tag-to-pool mapping. Smaller pools (3-5 verbs) are
  for spice categories that should land rarely.
- **Match the phase tag.** Four bullets, one per phase tag (`using bash`, `reasoning about`, `responding about`,
  `starting work on`). Each names which pool fits and gives one concrete example. This is the only place phase tags show
  up — the rule sheet already explains the tags to the model, you're just telling it which pool to draw from.
- **Variety is the deliverable.** State it explicitly. A status indicator that returns the same three phrases is worse
  than the static `Thinking...` fallback because it draws the user's eye and then disappoints. The phrase you shipped
  last is hidden from the model, so the only lever is making it less likely to keep reaching for the same starter verb.
- **Hard constraints.** Reinforce the rule sheet, don't replace it. The two constraints that matter most are (a) **no
  address forms** (the model will reflexively introduce a name if the source character has one — "Sniping for the
  Boss..." is a common drift) and (b) **rare-spice ratio** for the iconic-but-overused noun (apple pie, rum, the Queen,
  whatever the character can't shut up about) — without an explicit cap the model will reach for it every other turn.
- **Anti-patterns.** Every "Don't X" needs a positive replacement, same rule as the main persona authoring guide. Bare
  prohibitions don't redirect a drift-prone model; they need somewhere to land.

## What to leave out

- **Tool semantics.** The overlay has no tools. Don't describe what the persona "reads" or "looks up" — it can't.
- **Address forms.** The voice is third-person observation. Stating "you call the user X" reads as a permission to
  introduce names into the phrase and is the single most common drift source.
- **Prose stage directions.** Halo flickers, eye-rolls, sighs, asterisk-bracketed gestures — none of this survives the
  one-line format. Cut.
- **Backstory.** A two-sentence character anchor at the top is enough. Anything more is body weight the model carries
  for free without it shaping output.
- **`/persona <name>` redirects.** Operational personas redirect when invoked from the wrong context. Phrase overlays
  can't usefully — they have nothing to do in a real session and the user dropping them into one already broke the
  contract. If you want a sibling work persona, ship it as a separate file.

## Validation playbook

Validate against the **same** tiny model class the overlay will run under at runtime. Phrase overlays don't get a
"large-model probe" — the operating point IS the small model, and a 200B model meta-narrating the rules tells you
nothing about how the 9B will behave.

Compose the system prompt the way the extension does and probe it directly:

```bash
SYS=$(awk 'BEGIN{c=0} /^---$/{c++; next} c>=2{print}' \
  config/pi/agents/waveform-phraser.md)
OVERLAY=$(awk 'BEGIN{c=0} /^---$/{c++; next} c>=2{print}' \
  ~/.pi/personas/<your-name>.md)
printf '%s\n\n%s\n' "$SYS" "$OVERLAY" > /tmp/probe-system.txt

pi --provider llama-cpp --model qwen3-5-9b \
   --system-prompt "$(cat /tmp/probe-system.txt)" \
   --print 'phaseTag: reasoning about
contextDigest: figure out why the integration test stalled'
```

A useful probe set is 8 trials with two structural goals:

- **All four phase tags** (`using bash`, `reasoning about`, `responding about`, `starting work on`) at least once each,
  so you see the pool-per-tag mapping in action.
- **Four trials with the same phase tag and different digests**, so you can score variety. Three distinct verbs out of
  four is the bar; two distinct (or worse, three of the same root like `Pinning`/`Pinpointing`) is a fail and the fix is
  to tighten the "rotate" instruction or shrink the dominant pool.

What to score per trial:

| Check                     | Pass if                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| Format                    | One line, ends in `...`, ≤60 chars, third person, no markdown, no quotes |
| Digest fidelity           | The noun matches the input digest, not a previous trial's                |
| Pool flavour              | ~50% of trials use a verb from the overlay pools (target band: 40-70%)   |
| Variety (same-tag trials) | ≥3 distinct verbs out of 4                                               |

A typical 9B-class model lands all four cleanly on a well-shaped overlay. If pool flavour is below 40%, the verb pools
need more concrete examples or the "lean on the kit" instruction needs to be sharpened. If digest fidelity slips (common
on 4B), the fix is in the digest — that's outside the overlay's control — but you can hedge by adding the "don't echo
the digest verbatim" anti-pattern to push the model toward mutation rather than copy.

## Common failure modes and fixes

- **The same verb three turns in a row.** The pool is too short, or the leading verb is too memorable. Add 3-4 more
  verbs to that pool; remove the one the model keeps reaching for.
- **Address forms leak into the phrase** (`Sniping for the Doctor...`). The character has a canonical address form and
  the model is pattern-matching off it. Add an anti-pattern bullet enumerating the specific names to forbid, and
  re-state the positive replacement ("phrase-only, no audience").
- **Iconic-but-overused noun on every other turn** (apple pie, rum, the halo). The model is treating the
  character-defining detail as universal applicability. Add the "≤1 in 5" cap explicitly; move that noun's category to
  the "rare, only on `<specific digest shape>`" pool.
- **Neutral output — no overlay flavour at all.** The voice cues are too abstract. Verbs in the pools must be concrete
  enough that the model can drop them in as-is; "energetic, upbeat verbs" is not actionable — `Yeeting`, `Plinking`,
  `Air-dropping` are. Replace adjective-shaped guidance with verb-shaped examples.
- **Multi-line or prose output.** The overlay is fighting the rule sheet. Look for any example in the overlay that spans
  more than one line, any sentence with an address form, any stage direction. Remove and re-probe.
- **`null` replies on plausible inputs.** The overlay's "fall back to neutral" exit is too easy to take. Move the `null`
  rule to its own line, tighten the trigger ("only when the input genuinely doesn't fit a one-phrase narration"), and
  re-probe.

## Wiring an authored overlay

Once the persona file is in place at one of the three layers, point the extension config at it by setting
`dynamicLabel.persona` in [`.pi/waveform-indicator.json`](../extensions/waveform-indicator.md#configuration) (project)
or `~/.pi/waveform-indicator.json` (user-global) to the persona's filename stem. The extension hot-reloads the overlay
on file change — no restart needed. Set `persona: ""` to opt out and run the neutral system prompt only.

## Related docs

- [`./README.md`](./README.md) — persona registry, full work-persona authoring, the bootstrap prompt for spawning a
  persona-authoring agent session.
- [`./daemon-waveform.md`](./daemon-waveform.md) — the shipped reference overlay. Read this first when picking up the
  pattern.
- [`../extensions/waveform-indicator.md`](../extensions/waveform-indicator.md) — the extension that consumes these
  overlays (composition mechanism, three-layer tool-use guarantee, config knobs, environment variables).
- [`../agents/waveform-phraser.md`](../agents/waveform-phraser.md) — the agent whose `appendSystemPrompt` your overlay
  is concatenated onto. The rule sheet lives here.
