/**
 * Tests for lib/node/pi/hooks/list.ts.
 */

import { describe, expect, test } from 'vitest';

import type { Hook, HookEvent } from '../../../../../lib/node/pi/hooks/config.ts';
import { HOOK_EVENTS } from '../../../../../lib/node/pi/hooks/config.ts';
import { formatHooksList, type HookListSource } from '../../../../../lib/node/pi/hooks/list.ts';

function emptyMerged(): Record<HookEvent, Hook[]> {
  return {
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
    SessionStart: [],
  };
}

const SOURCES: HookListSource[] = [
  { scope: 'session', where: '(in-memory)' },
  { scope: 'project', where: '/work/repo/.pi/hooks.json' },
  { scope: 'user', where: '/home/tester/.pi/agent/hooks.json' },
];

describe('formatHooksList', () => {
  test('all layers empty renders an (empty) line per source', () => {
    const out = formatHooksList(emptyMerged(), SOURCES, HOOK_EVENTS);
    expect(out).toBe(
      [
        '[session] (in-memory)',
        '  (empty)',
        '[project] /work/repo/.pi/hooks.json',
        '  (empty)',
        '[user] /home/tester/.pi/agent/hooks.json',
        '  (empty)',
      ].join('\n'),
    );
  });

  test('renders event groups with matcher, timeout, and sandboxed annotations', () => {
    const merged = emptyMerged();
    merged.PreToolUse = [
      { command: 'guard.sh', matcher: 'bash', timeout: 5000, sandboxed: true, scope: 'project' },
      { command: 'plain.sh', scope: 'project' },
    ];
    const out = formatHooksList(merged, SOURCES, HOOK_EVENTS);
    expect(out).toContain('[project] /work/repo/.pi/hooks.json');
    expect(out).toContain('  PreToolUse:');
    expect(out).toContain('    guard.sh matcher="bash" timeout=5000ms sandboxed');
    expect(out).toContain('    plain.sh');
  });

  test('only lists hooks whose scope matches the source block', () => {
    const merged = emptyMerged();
    merged.Stop = [{ command: 'user-stop.sh', scope: 'user' }];
    const out = formatHooksList(merged, SOURCES, HOOK_EVENTS);
    // The session/project blocks stay empty; the user block lists it.
    expect(out).toContain('[session] (in-memory)\n  (empty)');
    expect(out).toContain('[user] /home/tester/.pi/agent/hooks.json\n  Stop:\n    user-stop.sh');
  });
});
