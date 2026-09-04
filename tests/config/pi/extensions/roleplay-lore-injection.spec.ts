/**
 * Tests for the roleplay extension's keyword-fired-lore INJECTION SITE, plus
 * the DEPTH-INJECTION site that shares the same trailing message.
 *
 * Cache-correctness contract (see
 * `config/pi/extensions/AGENTS.md` § "Auto-injecting state every turn" and
 * `config/pi/extensions/cache-breakpoint.md`): keyword-fired lore is
 * VOLATILE per-turn state (its membership shifts on every topic change),
 * so it must NOT ride in the system prompt - there it would bust the
 * prompt-prefix cache on each shift. The extension computes the fired-lore
 * block ONCE per turn in `before_agent_start` (so the timing pass advances
 * exactly once), stashes it in a `pendingLore` slot, and the `context`
 * hook injects that slot as an ephemeral `<system-reminder id="roleplay-lore">`
 * on the trailing message. The stable POV/pinned scene block and cast
 * index stay at the head.
 *
 * Layout note: like `hooks.spec.ts` / `sandbox.spec.ts`, this spec sits
 * under `tests/config/pi/extensions/` to document the extension shell but
 * runs without a pi runtime (the shell imports `@earendil-works/*`, which
 * is not on the test path). It MIRRORS the exact lore-routing wiring from
 * `roleplay.ts` (the `pendingLore` slot, the `before_agent_start` compute,
 * the `context`-hook `applyContextReminder` call) while driving the REAL
 * pure helpers - `matchLore`, `applyTiming`, `formatLoreBlock`,
 * `selectWithinBudget`, `applyContextReminder`. If the real shell changes
 * where fired lore is computed or injected, mirror it here.
 *
 * The second describe block mirrors the `context`-hook DEPTH-INJECT block
 * (`buildInsertions` -> `planDepthTailMerge` -> `applyInsertions` /
 * `applyContextReminder`) and the opt-in `depthLoreInlineTail` config flag,
 * including the documented tail ORDER of the merged depth block relative to
 * `roleplay-lore`. One deliberate deviation from the shell: the mirror's
 * `makeMessage` omits the `timestamp: Date.now()` field, so outgoing arrays
 * are comparable across runs.
 */

import { describe, expect, test } from 'vitest';

import { selectWithinBudget, type LoreChunk } from '../../../../lib/node/pi/roleplay/budget.ts';
import {
  applyContextReminder,
  hasInjectableTail,
  type ReminderMessage,
} from '../../../../lib/node/pi/context-reminder.ts';
import {
  applyInsertions,
  buildInsertions,
  planDepthTailMerge,
  type LoreDepthChunk,
} from '../../../../lib/node/pi/roleplay/inject.ts';
import { coerceConfigLayer, mergeConfigLayers } from '../../../../lib/node/pi/roleplay/config.ts';
import { envTruthy } from '../../../../lib/node/pi/parse-env.ts';
import { matchLore } from '../../../../lib/node/pi/roleplay/match.ts';
import { formatLoreBlock } from '../../../../lib/node/pi/roleplay/prompt.ts';
import { applyTiming, type TimingState } from '../../../../lib/node/pi/roleplay/timing.ts';
import { emptyLoreMeta, type LoreMeta, type RoleplayEntry } from '../../../../lib/node/pi/roleplay/store.ts';

// ──────────────────────────────────────────────────────────────────────
// Synthetic fixture: two keyword-fired lore entries + one delayed entry.
// ──────────────────────────────────────────────────────────────────────

const loreEntry = (id: string, triggers: string[], body: string, meta: Partial<LoreMeta> = {}): RoleplayEntry => ({
  id,
  kind: 'lore',
  name: id,
  description: `${id} desc`,
  lore: { ...emptyLoreMeta(), triggers, ...meta },
});

const BODIES: Record<string, string> = {
  reef: 'The reef caverns glow with bioluminescent coral.',
  spire: 'The obsidian spire hums with stored lightning.',
  delayed: 'The buried vault only surfaces after the tide recedes.',
};

const FIXTURE: RoleplayEntry[] = [
  loreEntry('reef', ['reef'], BODIES.reef),
  loreEntry('spire', ['spire'], BODIES.spire),
  loreEntry('delayed', ['vault'], BODIES.delayed, { delay: 2 }),
];

// Stable head blocks (POV / pinned scene sheets + cast index). These never
// change turn-to-turn in these scenarios, so they exercise the byte-stable
// system-prompt invariant.
const SCENE_BLOCK = '## Roleplay scene\n\n### Nadia (POV)\nA cartographer.';
const INDEX_BLOCK = '## Roleplay\n- reef: reef desc\n- spire: spire desc';

const REMINDER_ID = 'roleplay-lore';

interface LoreHarness {
  beforeAgentStart: (event: { prompt?: string; systemPrompt: string }) => { systemPrompt: string };
  context: (messages: ReminderMessage[]) => ReminderMessage[];
  readonly pendingLore: string | null;
  readonly timingCalls: number;
}

/**
 * A faithful mirror of the roleplay extension's lore-routing wiring. Holds
 * the same per-process state the shell holds (`turnCount`, `timingState`,
 * `pendingLore`) and exposes the two hook entry points. `timingCalls`
 * counts real `applyTiming` invocations so the once-per-turn contract is
 * observable.
 */
function createHarness(entries: readonly RoleplayEntry[] = FIXTURE): LoreHarness {
  let turnCount = 0;
  let timingState: Record<string, TimingState> = {};
  let pendingLore: string | null = null;
  let timingCalls = 0;

  // Deterministic rng: probability defaults to 100, so the value is unused
  // for these fixtures; pin it anyway for reproducibility.
  const rng = (): number => 0;

  /** Mirror of `buildLoreInjection`: matchLore → applyTiming → budget → render. */
  const computeLore = (scanText: string): string | null => {
    const lore = entries.filter((e) => e.kind === 'lore' && e.lore?.depth === undefined);
    if (lore.length === 0) return null;
    const matchedIds = new Set(matchLore(lore, scanText).map((e) => e.id));
    timingCalls += 1;
    const timed = applyTiming(
      lore.map((e) => ({ id: e.id, meta: e.lore ?? emptyLoreMeta(), matched: matchedIds.has(e.id) })),
      turnCount,
      timingState,
      rng,
    );
    timingState = timed.nextState;
    const firedSet = new Set(timed.fired);
    const fired = lore.filter((e) => firedSet.has(e.id));
    const chunks: LoreChunk[] = fired
      .map((entry) => ({ entry, body: (BODIES[entry.id] ?? '').trim() }))
      .filter((c) => c.body.length > 0);
    if (chunks.length === 0) return null;
    return formatLoreBlock(selectWithinBudget(chunks, 4000));
  };

  /** Mirror of `before_agent_start`: compute lore once, stash it, head = scene+index only. */
  const beforeAgentStart = (event: { prompt?: string; systemPrompt: string }): { systemPrompt: string } => {
    turnCount += 1;
    pendingLore = computeLore(event.prompt ?? '');
    const additions = [SCENE_BLOCK, INDEX_BLOCK].filter((s): s is string => Boolean(s));
    return { systemPrompt: [event.systemPrompt, ...additions].join('\n\n') };
  };

  /** Mirror of the `context`-hook lore reminder: read the slot, inject via applyContextReminder. */
  const context = (messages: ReminderMessage[]): ReminderMessage[] =>
    applyContextReminder(messages, { id: REMINDER_ID, body: pendingLore });

  return {
    beforeAgentStart,
    context,
    get pendingLore() {
      return pendingLore;
    },
    get timingCalls() {
      return timingCalls;
    },
  };
}

const userTurn = (text: string): ReminderMessage[] => [{ role: 'user', content: text }];

/** Extract the injected `roleplay-lore` reminder text from the last message of a context result. */
const reminderText = (messages: ReminderMessage[]): string | undefined => {
  const last = messages[messages.length - 1];
  if (!Array.isArray(last.content)) return undefined;
  const block = last.content.find(
    (b): b is { type: 'text'; text: string } =>
      b.type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string' &&
      (b as { text: string }).text.startsWith('<system-reminder id="roleplay-lore">'),
  );
  return block?.text;
};

describe('roleplay fired-lore injection site', () => {
  test('(1) fired lore is NOT in the before_agent_start system prompt', () => {
    const h = createHarness();
    const out = h.beforeAgentStart({ prompt: 'we dive into the reef', systemPrompt: 'BASE' });

    // Lore fired this turn...
    expect(h.pendingLore).toContain(BODIES.reef);
    // ...but the system prompt carries only base + stable head blocks.
    expect(out.systemPrompt).toBe(`BASE\n\n${SCENE_BLOCK}\n\n${INDEX_BLOCK}`);
    expect(out.systemPrompt).not.toContain(BODIES.reef);
    expect(out.systemPrompt).not.toContain('## Roleplay lore');
  });

  test('(2) fired lore appears as <system-reminder id="roleplay-lore"> from the context path', () => {
    const h = createHarness();
    h.beforeAgentStart({ prompt: 'we dive into the reef', systemPrompt: 'BASE' });

    const injected = h.context(userTurn('we dive into the reef'));
    const text = reminderText(injected);
    expect(text).toBeDefined();
    expect(text).toContain('<system-reminder id="roleplay-lore">');
    expect(text).toContain('</system-reminder>');
    expect(text).toContain(BODIES.reef);
  });

  test('(3) timing gates the tail lore: a delayed entry does not fire until its delay elapses', () => {
    const h = createHarness();

    // Turn 1 (turnCount=1): "vault" matches, but the entry has delay=2
    // (eligible only once turnCount >= 2), so it must not fire - nothing on
    // the tail even though the keyword is present.
    h.beforeAgentStart({ prompt: 'the vault beckons', systemPrompt: 'BASE' });
    expect(h.pendingLore).toBeNull();
    expect(reminderText(h.context(userTurn('the vault beckons')))).toBeUndefined();

    // Turn 2 (turnCount=2): delay elapsed → the entry fires and its body
    // reaches the tail via the reminder path.
    h.beforeAgentStart({ prompt: 'the vault beckons', systemPrompt: 'BASE' });
    expect(h.pendingLore).toContain(BODIES.delayed);
    expect(reminderText(h.context(userTurn('the vault beckons')))).toContain(BODIES.delayed);
  });

  test('(4) timing advances once per turn regardless of context-hook re-fires', () => {
    const h = createHarness();

    h.beforeAgentStart({ prompt: 'we dive into the reef', systemPrompt: 'BASE' });
    // The context hook fires once per provider request - several times a turn.
    h.context(userTurn('we dive into the reef'));
    h.context(userTurn('we dive into the reef'));
    h.context(userTurn('we dive into the reef'));
    expect(h.timingCalls).toBe(1);

    h.beforeAgentStart({ prompt: 'we climb the spire', systemPrompt: 'BASE' });
    h.context(userTurn('we climb the spire'));
    h.context(userTurn('we climb the spire'));
    expect(h.timingCalls).toBe(2);
  });

  test('(5) system prompt is byte-stable across turns when only lore membership changes', () => {
    const h = createHarness();

    const t1 = h.beforeAgentStart({ prompt: 'we dive into the reef', systemPrompt: 'BASE' });
    const reef = reminderText(h.context(userTurn('we dive into the reef')));

    const t2 = h.beforeAgentStart({ prompt: 'we climb the spire', systemPrompt: 'BASE' });
    const spire = reminderText(h.context(userTurn('we climb the spire')));

    // Different lore fired each turn (membership changed)...
    expect(reef).toContain(BODIES.reef);
    expect(reef).not.toContain(BODIES.spire);
    expect(spire).toContain(BODIES.spire);
    expect(spire).not.toContain(BODIES.reef);

    // ...yet the system prompt is byte-identical: the volatile block moved
    // off the cached prefix onto the ephemeral tail.
    expect(t2.systemPrompt).toBe(t1.systemPrompt);
  });

  test('re-applying the context reminder within a turn is a fixpoint (no accumulation)', () => {
    const h = createHarness();
    h.beforeAgentStart({ prompt: 'we dive into the reef', systemPrompt: 'BASE' });

    const once = h.context(userTurn('we dive into the reef'));
    // A second context pass over the already-injected messages must yield the
    // same single reminder block (applyContextReminder strips its own id first).
    const twice = h.context(once);
    const last = twice[twice.length - 1];
    const reminderBlocks = Array.isArray(last.content)
      ? last.content.filter((b) => b.type === 'text' && (b as { text: string }).text.includes('id="roleplay-lore"'))
      : [];
    expect(reminderBlocks).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Depth-injection site + the opt-in `depthLoreInlineTail` delivery shape.
// ──────────────────────────────────────────────────────────────────────

const DEPTH_REMINDER_ID = 'roleplay-depth';

/** Depth-0 constant records, the shape that motivated the merged delivery. */
const DEPTH_CHUNKS: LoreDepthChunk[] = [
  { name: 'Apartment', body: 'The apartment layout: kitchen east, bed nook west.', depth: 0 },
  { name: 'Narration', body: 'Narration texture: concrete nouns, no dash-phrases.', depth: 0 },
];

interface DepthOpts {
  /** Config value under test (`RoleplayConfig.depthLoreInlineTail`). */
  inlineTail: boolean;
  authorNote?: string;
  authorNoteDepth?: number;
  /** The `pendingLore` slot the reminder pass reads. */
  pendingLore?: string | null;
}

/**
 * Mirror of the `context` hook's depth-inject block. Returns the messages
 * with depth insertions applied, either as standalone user messages (default)
 * or with everything at depth 0 merged into the trailing message.
 */
function depthPass(
  messages: readonly ReminderMessage[],
  chunks: readonly LoreDepthChunk[],
  opts: DepthOpts,
): ReminderMessage[] {
  // Same gate as the shell: the env kill-switch wins over the config flag.
  const depthInjectEnabled = !envTruthy(process.env.PI_ROLEPLAY_DISABLE_DEPTH_INJECT);
  let out = messages as ReminderMessage[];
  if (!depthInjectEnabled) return out;
  const insertions = buildInsertions({
    authorNote: opts.authorNote,
    authorNoteDepth: opts.authorNoteDepth,
    lore: chunks,
  });
  if (insertions.length === 0) return out;
  const plan =
    opts.inlineTail && hasInjectableTail(out) ? planDepthTailMerge(insertions) : { insertions, tailBlock: null };
  if (plan.insertions.length > 0) {
    out = applyInsertions(out, plan.insertions, (text) => ({ role: 'user' as const, content: text }));
  }
  if (plan.tailBlock) {
    out = applyContextReminder(out, { id: DEPTH_REMINDER_ID, body: plan.tailBlock });
  }
  return out;
}

/** Mirror of the full `context` transform: depth pass, then the reminder specs. */
function contextPass(
  messages: readonly ReminderMessage[],
  chunks: readonly LoreDepthChunk[],
  opts: DepthOpts,
): ReminderMessage[] {
  return applyContextReminder(depthPass(messages, chunks, opts), {
    id: REMINDER_ID,
    body: opts.pendingLore ?? null,
  });
}

/** A short history whose trailing message is the live user turn. */
const history = (): ReminderMessage[] => [
  { role: 'user', content: 'we head home' },
  { role: 'assistant', content: 'The stairwell light stutters.' },
  { role: 'user', content: 'I unlock the door' },
];

/** Every text block on the trailing message, in order. */
const tailTexts = (messages: readonly ReminderMessage[]): string[] => {
  const last = messages[messages.length - 1];
  if (!Array.isArray(last.content)) return typeof last.content === 'string' ? [last.content] : [];
  return last.content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        b.type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text);
};

describe('roleplay depth-lore delivery shape', () => {
  test('default-off: the outgoing array is identical with the flag absent and with it explicitly false', () => {
    const absent = mergeConfigLayers(coerceConfigLayer({}));
    const explicit = mergeConfigLayers(coerceConfigLayer({ depthLoreInlineTail: false }));
    expect(absent.depthLoreInlineTail).toBe(false);
    expect(explicit.depthLoreInlineTail).toBe(false);

    const withAbsent = contextPass(history(), DEPTH_CHUNKS, { inlineTail: absent.depthLoreInlineTail });
    const withExplicit = contextPass(history(), DEPTH_CHUNKS, { inlineTail: explicit.depthLoreInlineTail });

    // ...and both equal today's expected output: one standalone user message
    // per depth-0 chunk, appended after the user's real turn.
    expect(withAbsent).toStrictEqual([
      ...history(),
      { role: 'user', content: '[Lore — Apartment: The apartment layout: kitchen east, bed nook west.]' },
      { role: 'user', content: '[Lore — Narration: Narration texture: concrete nouns, no dash-phrases.]' },
    ]);
    expect(withExplicit).toStrictEqual(withAbsent);
  });

  test('flag on, only depth-0 chunks: one merged block on the trailing message, no added messages', () => {
    const out = depthPass(history(), DEPTH_CHUNKS, { inlineTail: true });
    expect(out).toHaveLength(history().length);
    expect(tailTexts(out)).toStrictEqual([
      'I unlock the door',
      [
        '<system-reminder id="roleplay-depth">',
        '[Lore — Apartment: The apartment layout: kitchen east, bed nook west.]',
        '',
        '[Lore — Narration: Narration texture: concrete nouns, no dash-phrases.]',
        '</system-reminder>',
      ].join('\n'),
    ]);
  });

  test('flag on, only depth-N chunks: byte-identical to the flag being off', () => {
    const chunks: LoreDepthChunk[] = [{ name: 'Rhodes', body: 'The org keeps ledgers.', depth: 2 }];
    expect(depthPass(history(), chunks, { inlineTail: true })).toStrictEqual(
      depthPass(history(), chunks, { inlineTail: false }),
    );
  });

  test('flag on, mixed depths: depth-N keeps the standalone path, depth-0 merges into the tail', () => {
    const chunks: LoreDepthChunk[] = [
      { name: 'Apartment', body: 'kitchen east', depth: 0 },
      { name: 'Rhodes', body: 'ledgers', depth: 2 },
    ];
    const out = depthPass(history(), chunks, { inlineTail: true });
    // The depth-2 chunk is still its own user message, spliced before the
    // assistant turn; the depth-0 chunk rides the trailing user message.
    expect(out.map((m) => m.role)).toStrictEqual(['user', 'user', 'assistant', 'user']);
    expect(out[1].content).toBe('[Lore — Rhodes: ledgers]');
    expect(tailTexts(out)[1]).toContain('[Lore — Apartment: kitchen east]');
    expect(tailTexts(out)[1]).not.toContain('ledgers');
  });

  test("flag on: an author's note at depth 0 joins the merged block after the lore", () => {
    const out = depthPass(history(), DEPTH_CHUNKS, { inlineTail: true, authorNote: 'stay terse', authorNoteDepth: 0 });
    expect(out).toHaveLength(history().length);
    const block = tailTexts(out)[1];
    expect(block.indexOf('[Lore — Apartment')).toBeLessThan(block.indexOf("[Author's note: stay terse]"));
    expect(block.indexOf('[Lore — Narration')).toBeLessThan(block.indexOf("[Author's note: stay terse]"));
  });

  test("flag on: an author's note at its default depth stays a standalone message", () => {
    const out = depthPass(history(), DEPTH_CHUNKS, { inlineTail: true, authorNote: 'stay terse' });
    // depth 4 clamps to the start of this 3-message history.
    expect(out[0].content).toBe("[Author's note: stay terse]");
    expect(tailTexts(out)[1]).not.toContain("Author's note");
  });

  test('flag on with a non-injectable trailing message: falls back to standalone messages', () => {
    const assistantTail: ReminderMessage[] = [
      { role: 'user', content: 'I unlock the door' },
      { role: 'assistant', content: 'The lock gives.' },
    ];
    const out = depthPass(assistantTail, DEPTH_CHUNKS, { inlineTail: true });
    // No chunk is dropped: both land as user messages, exactly as with the
    // flag off.
    expect(out).toStrictEqual(depthPass(assistantTail, DEPTH_CHUNKS, { inlineTail: false }));
    expect(out).toHaveLength(assistantTail.length + DEPTH_CHUNKS.length);
  });

  test('flag on with an empty chunk list is a no-op that preserves array identity', () => {
    const msgs = history();
    expect(depthPass(msgs, [], { inlineTail: true })).toBe(msgs);
    expect(depthPass(msgs, [], { inlineTail: false })).toBe(msgs);
  });

  test('flag on: the merged depth block precedes the roleplay-lore reminder, and re-applying is a fixpoint', () => {
    const opts: DepthOpts = { inlineTail: true, pendingLore: '## Roleplay lore\n\nThe reef glows.' };
    const once = contextPass(history(), DEPTH_CHUNKS, opts);
    const ids = tailTexts(once).map((t) => /^<system-reminder id="([^"]+)">/.exec(t)?.[1] ?? 'real-content');
    // Documented order on the trailing message: real user text, then the
    // merged depth block, then the keyword-fired lore reminder.
    expect(ids).toStrictEqual(['real-content', DEPTH_REMINDER_ID, REMINDER_ID]);

    // Re-running the whole transform over its own output changes nothing.
    const twice = contextPass(once, DEPTH_CHUNKS, opts);
    expect(twice).toStrictEqual(once);
    expect(contextPass(twice, DEPTH_CHUNKS, opts)).toStrictEqual(once);
  });

  test('flag on: PI_ROLEPLAY_DISABLE_DEPTH_INJECT=1 still disables the whole depth path', () => {
    const prev = process.env.PI_ROLEPLAY_DISABLE_DEPTH_INJECT;
    process.env.PI_ROLEPLAY_DISABLE_DEPTH_INJECT = '1';
    try {
      const out = contextPass(history(), DEPTH_CHUNKS, {
        inlineTail: true,
        authorNote: 'stay terse',
        authorNoteDepth: 0,
      });
      expect(out).toStrictEqual(history());
      expect(JSON.stringify(out)).not.toContain('Apartment');
      expect(JSON.stringify(out)).not.toContain(DEPTH_REMINDER_ID);
    } finally {
      if (prev === undefined) delete process.env.PI_ROLEPLAY_DISABLE_DEPTH_INJECT;
      else process.env.PI_ROLEPLAY_DISABLE_DEPTH_INJECT = prev;
    }
  });

  test('flag on: the merged block still obeys loreCharBudget (selection stays upstream of the merge)', () => {
    // Budgeting happens in `buildDepthLore` before the chunks ever reach the
    // merge, so the merged block can only shrink with the budget, never grow.
    const chunks: LoreChunk[] = [
      { entry: { id: 'a', kind: 'lore', name: 'Apartment', description: 'a' }, body: 'x'.repeat(40) },
      { entry: { id: 'b', kind: 'lore', name: 'Narration', description: 'b' }, body: 'y'.repeat(4000) },
    ];
    const { kept } = selectWithinBudget(chunks, 500);
    const depthChunks: LoreDepthChunk[] = kept.map((c) => ({ name: c.entry.name, body: c.body, depth: 0 }));
    const block = tailTexts(depthPass(history(), depthChunks, { inlineTail: true }))[1];
    expect(block).toContain('Apartment');
    expect(block).not.toContain('Narration');
  });
});
