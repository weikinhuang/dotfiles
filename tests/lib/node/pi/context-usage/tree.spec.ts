/**
 * Tests for lib/node/pi/context-usage/tree.ts. Pure module.
 */

import { describe, expect, test } from 'vitest';

import {
  atRoot,
  back,
  breadcrumbLabels,
  currentChildren,
  enter,
  initNav,
  move,
  resolveNode,
  select,
} from '../../../../../lib/node/pi/context-usage/tree.ts';
import type { CategoryNode } from '../../../../../lib/node/pi/context-usage/types.ts';

const root: CategoryNode = {
  id: 'root',
  label: 'Context window',
  tokens: 200,
  children: [
    {
      id: 'sys',
      label: 'System prompt',
      tokens: 60,
      children: [
        { id: 'sys.core', label: 'Core', tokens: 40 },
        { id: 'sys.files', label: 'Files', tokens: 20, children: [{ id: 'f1', label: 'AGENTS.md', tokens: 20 }] },
      ],
    },
    { id: 'tools', label: 'Tools', tokens: 40 },
    { id: 'conv', label: 'Conversation', tokens: 100 },
  ],
};

describe('navigation', () => {
  test('initNav is at root, selection 0', () => {
    const s = initNav();
    expect(atRoot(s)).toBe(true);
    expect(s.sel).toBe(0);
    expect(currentChildren(root, s).map((c) => c.id)).toEqual(['sys', 'tools', 'conv']);
  });

  test('move clamps within child count', () => {
    let s = initNav();
    s = move(s, -1, 3);
    expect(s.sel).toBe(0);
    s = move(s, 5, 3);
    expect(s.sel).toBe(2);
  });

  test('select clamps to range', () => {
    expect(select(initNav(), 99, 3).sel).toBe(2);
    expect(select(initNav(), -1, 3).sel).toBe(0);
  });

  test('enter drills into a node with children and resets selection', () => {
    let s = initNav(); // sel 0 = sys (has children)
    s = enter(root, s);
    expect(s.path).toEqual([0]);
    expect(s.sel).toBe(0);
    expect(currentChildren(root, s).map((c) => c.id)).toEqual(['sys.core', 'sys.files']);
  });

  test('enter is a no-op on a leaf', () => {
    let s = select(initNav(), 1, 3); // tools (leaf)
    const before = s;
    s = enter(root, s);
    expect(s).toEqual(before);
  });

  test('back restores selection to the index drilled from', () => {
    let s = select(initNav(), 0, 3); // sys
    s = enter(root, s); // into sys, path [0]
    s = select(s, 1, 2); // select sys.files
    s = enter(root, s); // into files, path [0,1]
    expect(s.path).toEqual([0, 1]);
    s = back(s); // back to sys, sel restored to 1
    expect(s.path).toEqual([0]);
    expect(s.sel).toBe(1);
    s = back(s); // back to root, sel restored to 0
    expect(s.path).toEqual([]);
    expect(s.sel).toBe(0);
  });

  test('back at root is a no-op', () => {
    const s = initNav();
    expect(back(s)).toEqual(s);
  });

  test('resolveNode walks the path', () => {
    expect(resolveNode(root, [0, 1]).id).toBe('sys.files');
    expect(resolveNode(root, []).id).toBe('root');
  });

  test('breadcrumbLabels lists drilled labels', () => {
    expect(breadcrumbLabels(root, [0, 1])).toEqual(['System prompt', 'Files']);
    expect(breadcrumbLabels(root, [])).toEqual([]);
  });
});
