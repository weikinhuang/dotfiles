/**
 * Tests for the subagent extension's `/agents` command completion surface.
 *
 * The extension shell (`config/pi/extensions/subagent.ts`) builds its
 * `getArgumentCompletions` over the shared `completeSubverbs` helper, with
 * the `show` verb's resolver reading loaded agent names off `loadResult`.
 * This block mirrors that exact spec object so the two stay in lockstep (the
 * shell can't be imported under vitest). All code under test is pure.
 */

import { describe, expect, test } from 'vitest';

import { completeSubverbs, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';

/**
 * Rebuilds the same spec object `subagent.ts` passes to `completeSubverbs`,
 * bound to a synthetic loaded-agent registry (name order + descriptions).
 */
const specFor = (nameOrder: string[], descriptions: Record<string, string>): SubverbSpec => ({
  show: {
    description: 'Show full frontmatter + body for an agent',
    args: (tail) =>
      nameOrder.filter((n) => n.startsWith(tail)).map((n) => ({ label: n, description: descriptions[n] ?? '' })),
  },
  running: { description: 'List active background sub-agents' },
});

describe('/agents argument completion', () => {
  const nameOrder = ['explore', 'plan', 'review'];
  const descriptions = { explore: 'Read-only discovery', plan: 'Implementation planning', review: 'Code review' };
  const spec = (): SubverbSpec => specFor(nameOrder, descriptions);

  test('level-1 lists show + running with their descriptions', () => {
    expect(completeSubverbs('', spec())).toEqual([
      { value: 'show', label: 'show', description: 'Show full frontmatter + body for an agent' },
      { value: 'running', label: 'running', description: 'List active background sub-agents' },
    ]);
  });

  test('level-1 filters by the partial verb', () => {
    expect(completeSubverbs('sh', spec())?.map((c) => c.value)).toEqual(['show']);
    expect(completeSubverbs('r', spec())?.map((c) => c.value)).toEqual(['running']);
  });

  test('unknown verb returns null', () => {
    expect(completeSubverbs('nope', spec())).toBeNull();
  });

  test('running is terminal (no deeper args)', () => {
    expect(completeSubverbs('running ', spec())).toBeNull();
  });

  test('show <Tab> lists agent names, value carrying the verb prefix', () => {
    const out = completeSubverbs('show ', spec());
    expect(out).toContainEqual({ value: 'show explore', label: 'explore', description: 'Read-only discovery' });
    expect(out?.map((c) => c.value)).toEqual(['show explore', 'show plan', 'show review']);
  });

  test('show filters agent names by the partial tail', () => {
    expect(completeSubverbs('show pl', spec())?.map((c) => c.value)).toEqual(['show plan']);
  });
});
