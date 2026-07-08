/**
 * Tests for the `custom-header` extension's command surface.
 *
 * Sits under `tests/config/pi/extensions/` to document the `/header`
 * command shell, but - per project convention - only drives the pure lib
 * helpers the shell composes (`completeSubverbs`, `isHelpArg`,
 * `HEADER_USAGE`). The shell itself pulls in `@earendil-works/*` and can't
 * be imported under vitest, so we mirror the exact `completeSubverbs` spec
 * the shell builds.
 */

import { expect, test, vi } from 'vitest';

import { completeSubverbs, type SubverbSpec } from '../../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import { HEADER_USAGE } from '../../../../lib/node/pi/custom-header/usage.ts';

// ──────────────────────────────────────────────────────────────────────
// Help convention - the handler guards with `isHelpArg`, notifying
// HEADER_USAGE at info level.
// ──────────────────────────────────────────────────────────────────────

test('help: `/header --help` notifies HEADER_USAGE', () => {
  const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
  if (isHelpArg('--help')) notify(HEADER_USAGE, 'info');

  expect(notify).toHaveBeenCalledTimes(1);
  const [msg, level] = notify.mock.calls[0];
  expect(level).toBe('info');
  expect(msg).toBe(HEADER_USAGE);
  expect(HEADER_USAGE).toContain('/header');
});

// ──────────────────────────────────────────────────────────────────────
// Argument completion (§4.1). The shell builds a `completeSubverbs` spec
// of the two terminal source verbs (`builtin`, `custom`), each with its
// description. We mirror that exact spec.
// ──────────────────────────────────────────────────────────────────────

/** Mirror of `config/pi/extensions/custom-header.ts`'s getArgumentCompletions spec. */
const HEADER_SPEC: SubverbSpec = {
  builtin: { description: "Restore pi's default mascot + keybinding-hints header" },
  custom: { description: 'Install the compact single-line header strip' },
};

const headerCompletions = (prefix: string): { value: string; label: string; description?: string }[] | null =>
  completeSubverbs(prefix, HEADER_SPEC);

test('completion: empty prefix lists both source verbs with descriptions', () => {
  const out = headerCompletions('');
  expect(out?.map((c) => c.value)).toEqual(['builtin', 'custom']);
  expect(out?.find((c) => c.value === 'builtin')?.description).toBe(
    "Restore pi's default mascot + keybinding-hints header",
  );
  expect(out?.find((c) => c.value === 'custom')?.description).toBe('Install the compact single-line header strip');
});

test('completion: filters by the typed prefix', () => {
  expect(headerCompletions('b')?.map((c) => c.value)).toEqual(['builtin']);
  expect(headerCompletions('cus')?.map((c) => c.value)).toEqual(['custom']);
});

test('completion: returns null when nothing matches', () => {
  expect(headerCompletions('zzz')).toBeNull();
});

test('completion: both verbs are terminal (no level-2 args)', () => {
  expect(headerCompletions('builtin ')).toBeNull();
  expect(headerCompletions('custom ')).toBeNull();
});
