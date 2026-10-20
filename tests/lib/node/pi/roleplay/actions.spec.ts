import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planRemove, planSave, planSearch, planUpdate } from '../../../../../lib/node/pi/roleplay/actions.ts';
import {
  emptyLoreMeta,
  emptyRelationshipMeta,
  type RoleplayEntry,
  type RoleplayState,
} from '../../../../../lib/node/pi/roleplay/store.ts';

const ROOT = '/rp-root';
const castPath = (...parts: string[]): string => join(ROOT, 'casts', 'tide', ...parts);

beforeEach(() => {
  vi.stubEnv('PI_ROLEPLAY_ROOT', ROOT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function state(entries: RoleplayEntry[]): RoleplayState {
  return { cast: 'tide', entries };
}

const mira: RoleplayEntry = { id: 'mira', kind: 'character', name: 'Mira', description: 'the lead' };
const reef: RoleplayEntry = {
  id: 'reef',
  kind: 'lore',
  name: 'Reef',
  description: 'coral reef',
  lore: { ...emptyLoreMeta(), triggers: ['reef'] },
};
const noBody = (): string | null => null;
const bodyOf =
  (bodies: Record<string, string>) =>
  (e: RoleplayEntry): string | null =>
    bodies[`${e.kind}/${e.id}`] ?? null;

describe('planSave', () => {
  it('writes a new character under the kind dir and returns the next state + index text', () => {
    const plan = planSave(state([]), { action: 'save', name: ' Mira Vale ', description: ' lead ', body: ' BODY ' });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].path).toBe(castPath('character', 'mira-vale.md'));
    expect(plan.writes[0].content).toContain('name: Mira Vale');
    expect(plan.writes[0].content).toContain('BODY');
    expect(plan.removes).toEqual([]);
    expect(plan.entry).toMatchObject({ id: 'mira-vale', kind: 'character', name: 'Mira Vale', description: 'lead' });
    expect(plan.entry.character).toBeDefined();
    expect(plan.state.entries.map((e) => e.id)).toEqual(['mira-vale']);
    expect(plan.content.startsWith('Saved [tide/character] mira-vale - Mira Vale\n\n')).toBe(true);
  });

  it('dedupes the slug against existing entries', () => {
    const plan = planSave(state([mira]), { action: 'save', name: 'Mira', description: 'd', body: 'b' });
    expect(plan.ok && plan.entry.id).toBe('mira-2');
  });

  it.each([
    [{ action: 'save' as const, description: 'd', body: 'b' }, '`name` is required for `save`'],
    [{ action: 'save' as const, name: 'x', body: 'b' }, '`description` is required'],
    [{ action: 'save' as const, name: 'x', description: 'd', body: '  ' }, '`body` is required for `save`'],
    [
      {
        action: 'save' as const,
        kind: 'relationship' as const,
        name: 'x',
        description: 'd',
        body: 'b',
        lastInteraction: 'soon',
      },
      'lastInteraction',
    ],
  ])('rejects invalid params %#', (params, message) => {
    const plan = planSave(state([]), params);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain(message);
  });

  it.each(['summary', 'timeline'] as const)('rejects the reserved `auto` slug for %s', (kind) => {
    const plan = planSave(state([]), { action: 'save', kind, name: 'Auto', description: 'd', body: 'b' });
    expect(plan).toEqual({
      ok: false,
      error: `slug "auto" is reserved for the ${kind} carry-over record; choose a different \`name\``,
    });
  });

  it('allows `auto` for non-carry-over kinds', () => {
    expect(planSave(state([]), { action: 'save', kind: 'lore', name: 'Auto', description: 'd', body: 'b' }).ok).toBe(
      true,
    );
  });
});

describe('planUpdate', () => {
  it('requires a change, and kind-specific fields only count for their own kind', () => {
    const none = planUpdate(state([mira]), { action: 'update', id: 'mira' }, noBody);
    expect(!none.ok && none.error).toContain('requires at least one of');
    const wrongKind = planUpdate(state([mira]), { action: 'update', id: 'mira', affinity: 3 }, noBody);
    expect(wrongKind.ok).toBe(false);
    const ok = planUpdate(
      state([mira]),
      { action: 'update', id: 'mira', pinned: true },
      bodyOf({ 'character/mira': 'B' }),
    );
    expect(ok.ok && ok.entry.character?.pinned).toBe(true);
  });

  it('preserves the stored body when omitted and fails when unreadable or empty', () => {
    const kept = planUpdate(
      state([mira]),
      { action: 'update', id: 'mira', description: 'new' },
      bodyOf({ 'character/mira': ' OLD ' }),
    );
    if (!kept.ok) throw new Error(kept.error);
    expect(kept.writes[0].content).toContain('OLD');
    expect(kept.writes[0].path).toBe(castPath('character', 'mira.md'));
    expect(kept.removes).toEqual([]);
    const missing = planUpdate(state([mira]), { action: 'update', id: 'mira', description: 'new' }, noBody);
    expect(!missing.ok && missing.error).toContain('cannot preserve body');
    const empty = planUpdate(
      state([mira]),
      { action: 'update', id: 'mira', description: 'n' },
      bodyOf({ 'character/mira': ' ' }),
    );
    expect(!empty.ok && empty.error).toContain('is empty');
    const blank = planUpdate(state([mira]), { action: 'update', id: 'mira', body: ' ' }, noBody);
    expect(!blank.ok && blank.error).toContain('use `remove`');
    const noName = planUpdate(state([mira]), { action: 'update', id: 'mira', name: ' ' }, noBody);
    expect(!noName.ok && noName.error).toBe('`name` may not be empty');
  });

  it('renames: writes the new slug first, then removes the old file', () => {
    const plan = planUpdate(state([mira]), { action: 'update', id: 'mira', name: 'Mira Vale', body: 'B' }, noBody);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.writes.map((w) => w.path)).toEqual([castPath('character', 'mira-vale.md')]);
    expect(plan.removes).toEqual([castPath('character', 'mira.md')]);
    expect(plan.state.entries.map((e) => e.id)).toEqual(['mira-vale']);
    expect(plan.content.startsWith('Updated [tide/character] mira-vale - Mira Vale')).toBe(true);
  });

  it('never deletes the file it just wrote when the rename lands back on the same stem', () => {
    const foo2: RoleplayEntry = { id: 'foo-2', kind: 'character', name: 'Foo 2', description: 'd' };
    const foo: RoleplayEntry = { id: 'foo', kind: 'character', name: 'Foo', description: 'd' };
    const plan = planUpdate(state([foo, foo2]), { action: 'update', id: 'foo-2', name: 'Foo', body: 'B' }, noBody);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.entry.id).toBe('foo-2');
    expect(plan.removes).toEqual([]);
  });

  it('rejects a rename onto the reserved carry-over slug', () => {
    const summary: RoleplayEntry = { id: 'arc', kind: 'summary', name: 'Arc', description: 'd' };
    const plan = planUpdate(state([summary]), { action: 'update', id: 'arc', name: 'auto', body: 'B' }, noBody);
    expect(!plan.ok && plan.error).toContain('slug "auto" is reserved for the summary carry-over record');
  });

  it('keeps bundle lore inside its bundle dir across a rename and preserves unknown frontmatter', () => {
    const bundled: RoleplayEntry = { ...reef, bundle: 'deep/sea', extra: { mood: 'eerie', weight: 3 } };
    const plan = planUpdate(
      state([bundled]),
      { action: 'update', id: 'reef', name: 'Reef Wall', triggers: ['wall'] },
      bodyOf({ 'lore/reef': 'REEF BODY' }),
    );
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.writes[0].path).toBe(castPath('lore', 'deep', 'sea', 'reef-wall.md'));
    expect(plan.removes).toEqual([castPath('lore', 'deep', 'sea', 'reef.md')]);
    expect(plan.writes[0].content).toMatch(/^mood: eerie$/m);
    expect(plan.writes[0].content).toMatch(/^weight: 3$/m);
    expect(plan.writes[0].content).toContain('REEF BODY');
    expect(plan.entry).toMatchObject({
      id: 'reef-wall',
      bundle: 'deep/sea',
      extra: { mood: 'eerie', weight: 3 },
      lore: { triggers: ['wall'] },
    });
  });

  it('validates lastInteraction and layers relationship meta over the stored one', () => {
    const rel: RoleplayEntry = {
      id: 'mira-kai',
      kind: 'relationship',
      name: 'Mira & Kai',
      description: 'd',
      relationship: { ...emptyRelationshipMeta(), trust: 'wary' },
    };
    const bad = planUpdate(state([rel]), { action: 'update', id: 'mira-kai', lastInteraction: 'later' }, noBody);
    expect(bad.ok).toBe(false);
    const good = planUpdate(
      state([rel]),
      { action: 'update', id: 'mira-kai', affinity: 80 },
      bodyOf({ 'relationship/mira-kai': 'B' }),
    );
    expect(good.ok && good.entry.relationship).toEqual({ ...emptyRelationshipMeta(), trust: 'wary', affinity: 80 });
  });
});

describe('planRemove', () => {
  const loreMira: RoleplayEntry = { ...reef, id: 'mira', name: 'Mira lore' };

  it('demands a kind when the id is shared across kinds', () => {
    const plan = planRemove(state([mira, loreMira]), { action: 'remove', id: 'mira' });
    expect(!plan.ok && plan.error).toContain('ambiguous id "mira"');
  });

  it('removes only the requested kind and its file', () => {
    const plan = planRemove(state([mira, loreMira]), { action: 'remove', id: 'mira', kind: 'lore' });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.writes).toEqual([]);
    expect(plan.removes).toEqual([castPath('lore', 'mira.md')]);
    expect(plan.state.entries).toEqual([mira]);
    expect(plan.entry).toBe(loreMira);
    expect(plan.content.startsWith('Removed [tide/lore] mira\n\n')).toBe(true);
  });

  it('removes a bundle lore file from its bundle dir', () => {
    const plan = planRemove(state([{ ...reef, bundle: 'deep' }]), { action: 'remove', id: 'reef' });
    expect(plan.ok && plan.removes).toEqual([castPath('lore', 'deep', 'reef.md')]);
  });
});

describe('planSearch', () => {
  it('matches metadata first, then bodies, case-insensitively', () => {
    const reads: string[] = [];
    const read = (e: RoleplayEntry): string | null => {
      reads.push(e.id);
      return e.id === 'reef' ? 'Hidden KELP forest' : null;
    };
    const plan = planSearch(state([mira, reef]), { action: 'search', query: ' kelp ' }, read);
    expect(plan).toEqual({
      ok: true,
      matches: [reef],
      content: 'Matches for "kelp" (1):\n  [lore] reef - Reef: coral reef',
    });
    expect(planSearch(state([mira, reef]), { action: 'search', query: 'LEAD' }, read)).toMatchObject({
      matches: [mira],
    });
    expect(reads).toEqual(['mira', 'reef', 'reef']);
  });

  it('reports no matches and requires a query', () => {
    expect(planSearch(state([mira]), { action: 'search', query: 'zzz' }, noBody)).toEqual({
      ok: true,
      matches: [],
      content: 'No entries in cast "tide" match "zzz".',
    });
    expect(planSearch(state([]), { action: 'search' }, noBody)).toEqual({
      ok: false,
      error: '`query` is required for `search`',
    });
  });
});
