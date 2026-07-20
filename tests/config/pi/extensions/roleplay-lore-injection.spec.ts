/**
 * Tests for the roleplay extension's keyword-fired-lore INJECTION SITE.
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
 */

import { describe, expect, test } from 'vitest';

import { selectWithinBudget, type LoreChunk } from '../../../../lib/node/pi/roleplay/budget.ts';
import { applyContextReminder, type ReminderMessage } from '../../../../lib/node/pi/context-reminder.ts';
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
