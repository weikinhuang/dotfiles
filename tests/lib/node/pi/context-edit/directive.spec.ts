/**
 * Tests for lib/node/pi/context-edit/directive.ts.
 *
 * Pure module - no pi runtime needed.
 */

import { describe, expect, test } from 'vitest';

import {
  addCollapse,
  addEdit,
  addTrim,
  clearDirectives,
  type ContextEditState,
  emptyState,
  isContextEditStateShape,
  reduceBranch,
  removeDirective,
} from '../../../../../lib/node/pi/context-edit/directive.ts';
import type { Target } from '../../../../../lib/node/pi/context-edit/target.ts';
import { assertErr, assertOk } from '../helpers.ts';

const CUSTOM_TYPE = 'context-trim-state';
const msgTarget: Target = { by: 'message', role: 'user', timestamp: 100 };

describe('addTrim', () => {
  test('appends a trim directive and bumps nextId', () => {
    const r = addTrim(emptyState(), msgTarget, 'too big', 1000);
    assertOk(r);
    expect(r.state.directives).toHaveLength(1);
    expect(r.state.directives[0].kind).toBe('trim');
    expect(r.state.nextId).toBe(2);
  });

  test('is idempotent for the same target', () => {
    const r1 = addTrim(emptyState(), msgTarget, undefined, 1);
    assertOk(r1);
    const r2 = addTrim(r1.state, msgTarget, undefined, 2);
    assertOk(r2);
    expect(r2.state.directives).toHaveLength(1);
  });

  test('persists an image description on the directive', () => {
    const r = addTrim(emptyState(), msgTarget, 'big image', 1000, 'a red fox in snow');
    assertOk(r);
    const d = r.state.directives[0];
    expect(d.kind === 'trim' && d.description).toBe('a red fox in snow');
    // The description survives the shape guard (round-trips through persistence).
    expect(isContextEditStateShape(r.state)).toBe(true);
  });

  test('description is optional (size-only trims omit it)', () => {
    const r = addTrim(emptyState(), msgTarget, undefined, 1);
    assertOk(r);
    expect(r.state.directives[0].kind === 'trim' && r.state.directives[0].description).toBeUndefined();
  });
});

describe('addEdit', () => {
  test('replaces an existing edit on the same target in place', () => {
    const r1 = addEdit(emptyState(), msgTarget, 'first', undefined, 1);
    assertOk(r1);
    const r2 = addEdit(r1.state, msgTarget, 'second', undefined, 2);
    assertOk(r2);
    expect(r2.state.directives).toHaveLength(1);
    const d = r2.state.directives[0];
    expect(d.kind === 'edit' && d.text).toBe('second');
  });
});

describe('addCollapse', () => {
  test('appends and is idempotent per toolCallId', () => {
    const r1 = addCollapse(emptyState(), 'c1', 'bg', 1);
    assertOk(r1);
    const r2 = addCollapse(r1.state, 'c1', 'bg', 2);
    assertOk(r2);
    expect(r2.state.directives).toHaveLength(1);
  });
});

describe('removeDirective / clearDirectives', () => {
  test('removeDirective drops by id, errors on unknown id', () => {
    const added = addTrim(emptyState(), msgTarget, undefined, 1);
    assertOk(added);
    const id = added.state.directives[0].id;
    const removed = removeDirective(added.state, id);
    assertOk(removed);
    expect(removed.state.directives).toHaveLength(0);
    assertErr(removeDirective(added.state, 9999));
  });

  test('clearDirectives by kind keeps other kinds', () => {
    let state: ContextEditState = emptyState();
    const a = addTrim(state, msgTarget, undefined, 1);
    assertOk(a);
    state = a.state;
    const b = addCollapse(state, 'c1', undefined, 2);
    assertOk(b);
    state = b.state;
    const cleared = clearDirectives(state, 'trim');
    assertOk(cleared);
    expect(cleared.state.directives).toHaveLength(1);
    expect(cleared.state.directives[0].kind).toBe('collapse');
  });
});

describe('isContextEditStateShape', () => {
  test('accepts a valid serialized state', () => {
    const r = addTrim(emptyState(), msgTarget, undefined, 1);
    assertOk(r);
    expect(isContextEditStateShape(r.state)).toBe(true);
  });

  test('rejects junk', () => {
    expect(isContextEditStateShape(null)).toBe(false);
    expect(isContextEditStateShape({ directives: 'no', nextId: 1 })).toBe(false);
    expect(isContextEditStateShape({ directives: [{ kind: 'bogus', id: 1, createdAt: 1 }], nextId: 2 })).toBe(false);
  });

  test('rejects a non-string description', () => {
    const bad = {
      directives: [{ kind: 'trim', id: 1, target: msgTarget, description: 42, createdAt: 1 }],
      nextId: 2,
    };
    expect(isContextEditStateShape(bad)).toBe(false);
  });
});

describe('reduceBranch', () => {
  test('picks the latest custom-entry snapshot', () => {
    const older = addTrim(emptyState(), msgTarget, undefined, 1);
    assertOk(older);
    const newer = addCollapse(older.state, 'c2', undefined, 2);
    assertOk(newer);
    const branch = [
      { type: 'custom', customType: CUSTOM_TYPE, data: older.state },
      { type: 'message', message: { role: 'user' } },
      { type: 'custom', customType: CUSTOM_TYPE, data: newer.state },
    ];
    const reduced = reduceBranch(branch, CUSTOM_TYPE);
    expect(reduced.directives).toHaveLength(2);
  });

  test('returns emptyState when no snapshot exists', () => {
    expect(reduceBranch([{ type: 'message', message: { role: 'user' } }], CUSTOM_TYPE).directives).toHaveLength(0);
  });

  test('ignores snapshots under a different customType', () => {
    const r = addTrim(emptyState(), msgTarget, undefined, 1);
    assertOk(r);
    const branch = [{ type: 'custom', customType: 'some-other-state', data: r.state }];
    expect(reduceBranch(branch, CUSTOM_TYPE).directives).toHaveLength(0);
  });
});
