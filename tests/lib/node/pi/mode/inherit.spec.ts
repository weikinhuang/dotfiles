/**
 * Tests for lib/node/pi/mode/inherit.ts.
 */

import { describe, expect, test } from 'vitest';

import { mergeAgentInheritance, type AgentRecord } from '../../../../../lib/node/pi/mode/inherit.ts';
import { type ParsedMode } from '../../../../../lib/node/pi/mode/parse.ts';

function baseMode(over: Partial<ParsedMode> = {}): ParsedMode {
  return {
    name: 'plan',
    writeRoots: [],
    bashAllow: [],
    bashDeny: [],
    body: '',
    source: '/modes/plan.md',
    ...over,
  };
}

function baseAgent(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'planner',
    tools: ['read'],
    body: 'agent body',
    ...over,
  };
}

describe('mergeAgentInheritance', () => {
  test('no agent ref returns mode with same field values', () => {
    const mode = baseMode({ tools: ['read', 'write'], body: 'mode body' });
    const out = mergeAgentInheritance(mode, baseAgent());

    expect(out.tools).toEqual(['read', 'write']);
    expect(out.body).toBe('mode body');
    expect(out.name).toBe('plan');
  });

  test('mode tools override agent tools when both present', () => {
    const mode = baseMode({ agent: 'planner', tools: ['read', 'write'], body: 'm' });
    const agent = baseAgent({ tools: ['read'] });

    const out = mergeAgentInheritance(mode, agent);

    expect(out.tools).toEqual(['read', 'write']);
  });

  test('mode tools undefined inherits agent tools', () => {
    const mode = baseMode({ agent: 'planner', body: 'm' });
    const agent = baseAgent({ tools: ['read', 'grep'] });

    const out = mergeAgentInheritance(mode, agent);

    expect(out.tools).toEqual(['read', 'grep']);
  });

  test('mode model overrides agent model; mode thinkingLevel overrides agent thinkingLevel', () => {
    const mode = baseMode({
      agent: 'planner',
      model: 'anthropic/claude-3',
      thinkingLevel: 'high',
      body: 'm',
    });
    const agent = baseAgent({ model: 'anthropic/claude-2', thinkingLevel: 'low' });

    const out = mergeAgentInheritance(mode, agent);

    expect(out.model).toBe('anthropic/claude-3');
    expect(out.thinkingLevel).toBe('high');
  });

  test('non-empty mode body wins over agent body', () => {
    const mode = baseMode({ agent: 'planner', body: 'mode wins' });
    const agent = baseAgent({ body: 'agent loses' });

    expect(mergeAgentInheritance(mode, agent).body).toBe('mode wins');
  });

  test('empty/whitespace mode body inherits agent body', () => {
    const mode = baseMode({ agent: 'planner', body: '   \n  ' });
    const agent = baseAgent({ body: 'inherited body' });

    expect(mergeAgentInheritance(mode, agent).body).toBe('inherited body');
  });

  test('writeRoots from mode survives agent inheritance', () => {
    const mode = baseMode({
      agent: 'planner',
      writeRoots: ['docs/plans/'],
      body: 'm',
    });
    const agent = baseAgent();

    const out = mergeAgentInheritance(mode, agent);

    expect(out.writeRoots).toEqual(['docs/plans/']);
  });

  test('bashAllow / bashDeny / appendSystemPrompt pass through unchanged', () => {
    const mode = baseMode({
      agent: 'planner',
      bashAllow: ['rg', 'fd'],
      bashDeny: ['rm'],
      appendSystemPrompt: 'plan in markdown',
      body: 'm',
    });
    const agent = baseAgent();

    const out = mergeAgentInheritance(mode, agent);

    expect(out.bashAllow).toEqual(['rg', 'fd']);
    expect(out.bashDeny).toEqual(['rm']);
    expect(out.appendSystemPrompt).toBe('plan in markdown');
  });
});
