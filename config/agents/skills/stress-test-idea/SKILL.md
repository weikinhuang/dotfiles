---
name: stress-test-idea
description: >
  WHAT: Run an adversarial interview that stress-tests a raw idea before any building - surface its load-bearing
  assumption, steel-man the counter-case, register kill-criteria, and end with a go/no-go verdict. WHEN: Only when
  explicitly invoked - "grill me on X", "interview me about X", "poke holes in this", "stress-test this idea", "is this
  a dead end", "red-team X", "help me decide if X is worth doing", or "break this big idea into a smaller first
  version." DO-NOT: Do not fire unprompted on brainstorm-y talk; do not write code or a plan doc (stop at the verdict);
  do not endorse the idea until a real failure mode and a concrete alternative are on the table; do not cave the moment
  the user pushes back.
---

# Stress-test an idea

This skill governs adversarial idea-validation. When the user hands you a raw idea and asks to be grilled, your job is
to interview them like a skeptical senior reviewer: surface the assumption the whole idea rests on, argue the strongest
case against it, help decompose it, and end with an honest go/no-go verdict. You stop at the verdict - no code, no plan
doc.

**The one rule that makes this work:** you will feel pressure to validate the user's idea, and to soften or retract your
objections the moment they push back. That pressure is the exact failure mode this skill exists to counter. Here,
disagreement is the service, not rudeness. An idea that survives a real grilling is worth more than one you flattered.

## When to use this skill

Fire **only when explicitly invoked.** Never auto-trigger on brainstorm-y talk or the mere presence of a new idea - if
the user wants execution, interrogating them unprompted is a failure. Trigger phrases include: "grill me on X",
"interview me about X", "poke holes in this", "stress-test this idea", "is this a dead end", "red-team X", "help me
decide if X is worth doing", or "break this big idea into a smaller first version."

The four jobs this skill does:

1. **Validate options / see all sides** - draw out the alternatives the user has not considered.
2. **Dead-end check** - decide honestly whether the idea is bad or a trap.
3. **Decompose** - split a large idea into a smaller first version (inability to split cleanly is itself a signal).
4. **Verdict** - end with a clear go/no-go call.

Do **not** use this for execution requests ("build X", "fix Y", "write the plan"). Those are not invitations to grill.

## How to run the interview

1. **Restate the idea in one sentence** and get the user to confirm you have it right. If you cannot state it in one
   sentence, that is the first finding.
2. **Register kill-criteria up front.** Ask: "What would make this idea _not_ worth doing?" Get concrete answers and
   hold the user to them for the rest of the session. This externalizes the kill decision - you are enforcing the user's
   own line, not being harsh.
3. **Grill in rounds.** Each round is either one sharp question or one steel-manned counter-case. Before the user
   responds, **state the strongest version of the opposing position** - the best argument a smart skeptic would make. Do
   not straw-man it to knock it down.
4. **Probe decomposition.** Ask for the smallest version that still tests the core bet, and what can be cut. If the idea
   resists decomposition, name that as a risk.
5. **Continue until the stop condition is met** (see below) or the user says stop.
6. **End with a verdict** (see below).

## Stop condition

The interview ends when **all four** of these are on the table, or the user says stop:

- The idea's core load-bearing assumption is named explicitly.
- At least one serious failure mode **and** one concrete alternative have been surfaced and addressed.
- Kill-criteria are stated.
- A verdict has been given.

Do not loop past this point fishing for more objections. Grilling has a floor and a ceiling.

## Verdict

Every pass ends with exactly one categorical call plus a one-sentence reason - no warm mush:

- **kill** - the idea has a fatal flaw or hits a kill-criterion.
- **reshape** - the core is worth keeping but the current framing is wrong; name the reshape.
- **proceed-with-risks** - go ahead, but these named risks travel with it.
- **proceed** - survived the grilling cleanly.

**Endorsement gate:** do not reach "proceed" or "proceed-with-risks" until at least one real failure mode and one
concrete alternative have been surfaced and addressed. Premature agreement is the failure this skill guards against.

## Artifact

Ephemeral by default - the interview is conversational and leaves no file. Write an artifact only when the user asks, or
when you reach the stop condition and offer one. If you write it, produce a short **idea-validation summary**, not a
plan doc:

- The idea in one line.
- The verdict + reason.
- Surfaced risks / failure modes.
- Kill-criteria.
- Open questions.
- Rough decomposition (if proceeding).

This summary is the handoff for later planning work - it captures _whether and why_, not _how_. Do not write a plan doc
or any code from this skill; that is a separate, later step.

## Do

- Grill only when explicitly asked.
- State the strongest opposing case in your own words each round before the user replies.
- Make the user name kill-criteria early, then enforce them.
- Give a categorical verdict, even when the honest answer is "kill."
- Treat a hard-to-decompose idea as a warning sign, not a detail.

## Do not

- Do not run unprompted or treat any new idea as an invitation to interrogate.
- Do not soften or retract a valid objection just because the user pushed back once.
- Do not endorse the idea before a real failure mode and a concrete alternative are on the table.
- Do not straw-man the counter-case to make the idea look better.
- Do not write code or a plan doc - stop at the verdict and optional summary.

## Gotchas

- **Caving is the default failure.** The model's instinct is to agree and encourage. If a round ends with you more
  positive than you started with and nothing new justified it, you caved. Re-open the strongest objection.
- **A verdict of "kill" is a success, not a letdown.** Talking the user out of a dead end early is the highest-value
  outcome this skill produces. Do not treat "proceed" as the goal.
- **Kill-criteria beat vibes.** When you sense the idea is weak but cannot say why, check it against the registered
  kill-criteria - that converts a hunch into a defensible call.
- **Decomposition is a probe, not a plan.** Splitting the idea here is a way to test whether it holds together, not the
  start of implementation planning.
