/**
 * Tests for lib/node/pi/mode/snapshot.ts.
 */

import { describe, expect, test } from 'vitest';

import {
  restoreSession,
  snapshotSession,
  type PersonaThinkingLevel,
  type SnapshotApi,
} from '../../../../../lib/node/pi/persona/snapshot.ts';

interface FakeApi extends SnapshotApi {
  state: {
    model: string | undefined;
    thinkingLevel: PersonaThinkingLevel | undefined;
    activeTools: string[];
  };
}

function makeApi(initial: { model?: string; thinkingLevel?: PersonaThinkingLevel; activeTools?: string[] }): FakeApi {
  const state = {
    model: initial.model,
    thinkingLevel: initial.thinkingLevel,
    activeTools: initial.activeTools ?? [],
  };
  return {
    state,
    getModel: () => state.model,
    setModel: (v) => {
      state.model = v;
    },
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (v) => {
      state.thinkingLevel = v;
    },
    getActiveTools: () => state.activeTools,
    setActiveTools: (v) => {
      state.activeTools = v;
    },
  };
}

describe('snapshotSession / restoreSession', () => {
  test('round-trip restores mutated session to the snapshotted state', () => {
    const api = makeApi({
      model: 'anthropic/claude-3',
      thinkingLevel: 'medium',
      activeTools: ['read', 'write'],
    });

    const snap = snapshotSession(api);

    api.state.model = 'openai/gpt-5';
    api.state.thinkingLevel = 'high';
    api.state.activeTools = ['bash'];

    restoreSession(api, snap);

    expect(api.state.model).toBe('anthropic/claude-3');
    expect(api.state.thinkingLevel).toBe('medium');
    expect(api.state.activeTools).toEqual(['read', 'write']);
  });

  test('preserves activeTools order, no dedup or sort', () => {
    const api = makeApi({ activeTools: ['c', 'a', 'b', 'a'] });

    const snap = snapshotSession(api);

    expect(snap.activeTools).toEqual(['c', 'a', 'b', 'a']);

    api.state.activeTools = [];
    restoreSession(api, snap);

    expect(api.state.activeTools).toEqual(['c', 'a', 'b', 'a']);
  });

  test('undefined model survives the round-trip', () => {
    const api = makeApi({ model: undefined, activeTools: ['read'] });

    const snap = snapshotSession(api);

    expect(snap.model).toBeUndefined();

    api.state.model = 'something/else';
    restoreSession(api, snap);

    expect(api.state.model).toBeUndefined();
  });

  test('currentAddendum passes through into SnapshotState verbatim', () => {
    const api = makeApi({ activeTools: [] });

    const snap = snapshotSession(api, 'You are concise.');

    expect(snap.systemPromptAddendum).toBe('You are concise.');
  });

  test('currentAddendum omitted yields undefined addendum', () => {
    const api = makeApi({ activeTools: [] });

    const snap = snapshotSession(api);

    expect(snap.systemPromptAddendum).toBeUndefined();
  });
});
