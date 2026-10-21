/**
 * Tests for the subagent extension's `/agents` command surface: argument
 * completion (via the shared `agentsSubverbSpec` the shell hands to
 * `completeSubverbs`) and argument parsing (`parseAgentsCommand`). Both
 * helpers live in `lib/node/pi/subagent/usage.ts`, so the shell and these
 * specs use the same objects. All code under test is pure.
 */

import { describe, expect, test } from 'vitest';

import { completeSubverbs, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';
import { AGENTS_USAGE, agentsSubverbSpec, parseAgentsCommand } from '../../../../lib/node/pi/subagent/usage.ts';

describe('/agents argument completion', () => {
  const nameOrder = ['explore', 'plan', 'review'];
  const descriptions: Record<string, string> = {
    explore: 'Read-only discovery',
    plan: 'Implementation planning',
    review: 'Code review',
  };
  const spec = (): SubverbSpec => agentsSubverbSpec(nameOrder, (n) => descriptions[n] ?? '');

  test('level-1 lists running (default), list, show, reload with their descriptions', () => {
    expect(completeSubverbs('', spec())).toEqual([
      { value: 'running', label: 'running', description: 'Live overlay of background sub-agents (default)' },
      { value: 'list', label: 'list', description: 'List loaded agent definitions' },
      { value: 'show', label: 'show', description: 'Show full frontmatter + body for an agent' },
      { value: 'reload', label: 'reload', description: 'Re-scan agent directories and report what loaded' },
    ]);
  });

  test('level-1 filters by the partial verb', () => {
    expect(completeSubverbs('sh', spec())?.map((c) => c.value)).toEqual(['show']);
    expect(completeSubverbs('r', spec())?.map((c) => c.value)).toEqual(['running', 'reload']);
    expect(completeSubverbs('l', spec())?.map((c) => c.value)).toEqual(['list']);
  });

  test('unknown verb returns null', () => {
    expect(completeSubverbs('nope', spec())).toBeNull();
  });

  test('running, list, and reload are terminal (no deeper args)', () => {
    expect(completeSubverbs('running ', spec())).toBeNull();
    expect(completeSubverbs('list ', spec())).toBeNull();
    expect(completeSubverbs('reload ', spec())).toBeNull();
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

describe('/agents argument parsing', () => {
  test('bare /agents shows running children', () => {
    expect(parseAgentsCommand(undefined)).toEqual({ verb: 'running' });
    expect(parseAgentsCommand('')).toEqual({ verb: 'running' });
    expect(parseAgentsCommand('   ')).toEqual({ verb: 'running' });
  });

  test('running stays an explicit alias for the default', () => {
    expect(parseAgentsCommand('running')).toEqual({ verb: 'running' });
  });

  test('list is required to list loaded agent definitions', () => {
    expect(parseAgentsCommand('list')).toEqual({ verb: 'list' });
    expect(parseAgentsCommand(' list ')).toEqual({ verb: 'list' });
  });

  test('reload and show <name>', () => {
    expect(parseAgentsCommand('reload')).toEqual({ verb: 'reload' });
    expect(parseAgentsCommand('show explore')).toEqual({ verb: 'show', name: 'explore' });
    expect(parseAgentsCommand('show   plan')).toEqual({ verb: 'show', name: 'plan' });
  });

  test('anything else is invalid', () => {
    expect(parseAgentsCommand('show')).toEqual({ verb: 'invalid' });
    expect(parseAgentsCommand('show a b')).toEqual({ verb: 'invalid' });
    expect(parseAgentsCommand('lists')).toEqual({ verb: 'invalid' });
    expect(parseAgentsCommand('nope')).toEqual({ verb: 'invalid' });
  });

  test('usage text documents the default and every verb', () => {
    expect(AGENTS_USAGE.split('\n')[0]).toBe('Usage: /agents [running|list|show <name>|reload]');
    expect(AGENTS_USAGE).toContain('With no args (or `running`)');
    expect(AGENTS_USAGE).toContain('`list` shows the loaded agent');
  });
});
