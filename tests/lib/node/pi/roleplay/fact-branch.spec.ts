import { describe, expect, it } from 'vitest';

import { CAPTURE_ENTRY_TYPE, planFactReconcile } from '../../../../../lib/node/pi/roleplay/fact-branch.ts';

const capture = (cast: string, ...slugs: string[]): Record<string, unknown> => ({
  type: 'custom',
  customType: CAPTURE_ENTRY_TYPE,
  data: { cast, facts: slugs.map((slug) => ({ slug, name: `name ${slug}`, description: `desc ${slug}` })) },
});

describe('planFactReconcile', () => {
  it('keeps the active branch captures and removes only other-branch captures', () => {
    const shared = capture('mira', 'shared');
    const mine = capture('mira', 'mine');
    const theirs = capture('mira', 'theirs');
    const plan = planFactReconcile([shared, theirs, mine], [shared, mine], 'mira');
    expect(plan.keep.map((fact) => fact.slug)).toEqual(['shared', 'mine']);
    expect([...plan.remove]).toEqual(['theirs']);
  });

  it('ignores other casts, legacy audits without facts, and captures before the latest scene boundary', () => {
    const old = capture('mira', 'old');
    const boundary = { type: 'custom', customType: 'roleplay-newscene', data: {} };
    const legacy = { type: 'custom', customType: CAPTURE_ENTRY_TYPE, data: { cast: 'mira', wrote: 2 } };
    const other = capture('juno', 'juno-fact');
    const plan = planFactReconcile([old, boundary, legacy, other], [old, boundary, legacy, other], 'mira');
    expect(plan.keep).toEqual([]);
    expect([...plan.remove]).toEqual(['old']);
  });
});

describe('clearRoleplayFacts only-set', () => {
  it('removes only the named owned notes', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { atomicWriteFile } = await import('../../../../../lib/node/pi/atomic-write.ts');
    const { fileFor } = await import('../../../../../lib/node/pi/memory-paths.ts');
    const { clearRoleplayFacts, serializeRoleplayFact } =
      await import('../../../../../lib/node/pi/roleplay/fact-memory.ts');
    const root = mkdtempSync(join(tmpdir(), 'fact-only-'));
    const previous = process.env.PI_MEMORY_ROOT;
    process.env.PI_MEMORY_ROOT = root;
    try {
      const note = (slug: string): void =>
        atomicWriteFile(
          fileFor('session', 'note', slug, root, 's1'),
          serializeRoleplayFact({ cast: 'mira', name: slug, description: slug, body: slug, created: '', updated: '' }),
        );
      note('keep-me');
      note('drop-me');
      expect(clearRoleplayFacts(root, 's1', 'mira', { only: new Set(['drop-me']) })).toBe(1);
      expect(clearRoleplayFacts(root, 's1', 'mira')).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.PI_MEMORY_ROOT;
      else process.env.PI_MEMORY_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
