/**
 * Tests for the `secret-redactor` extension's command surface.
 *
 * Sits under `tests/config/pi/extensions/` to document the extension
 * shell, but - per project convention - only drives the pure lib helpers
 * the shell composes (`completePositional`, `isHelpArg`, the USAGE consts,
 * and `SecretStore` for the completion candidate source). The shell itself
 * pulls in `@earendil-works/*` and can't be imported under vitest, so the
 * `/unredact` completion and the two commands' help convention are
 * asserted against the exact shapes the shell builds.
 */

import { expect, test, vi } from 'vitest';

import { type CompletionItem, completePositional } from '../../../../lib/node/pi/commands/complete.ts';
import { isHelpArg } from '../../../../lib/node/pi/commands/help.ts';
import { SecretStore } from '../../../../lib/node/pi/secret-redactor/store.ts';
import { SECRET_REDACTOR_USAGE, UNREDACT_USAGE } from '../../../../lib/node/pi/secret-redactor/usage.ts';

// ──────────────────────────────────────────────────────────────────────
// Help convention - each command guards its handler with `isHelpArg`,
// notifying its USAGE const at info level.
// ──────────────────────────────────────────────────────────────────────

test('help: `/unredact --help` notifies UNREDACT_USAGE at info', () => {
  const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
  if (isHelpArg('--help')) notify(UNREDACT_USAGE, 'info');

  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(UNREDACT_USAGE, 'info');
  expect(UNREDACT_USAGE).toContain('/unredact');
});

test('help: `/unredact` (empty handle) reuses UNREDACT_USAGE at warning', () => {
  // The empty-arg path and the --help path share one source of truth,
  // so the warning text is byte-identical to the help text.
  const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
  const handle = ''.trim().replace(/^#/, '');
  if (!handle) notify(UNREDACT_USAGE, 'warning');

  expect(notify).toHaveBeenCalledWith(UNREDACT_USAGE, 'warning');
});

test('help: every help token routes to UNREDACT_USAGE', () => {
  for (const tok of ['help', '--help', '-h', '?']) expect(isHelpArg(tok)).toBe(true);
  // A real handle-shaped arg is NOT a help request.
  expect(isHelpArg('abcd')).toBe(false);
});

test('help: `/secret-redactor --help` notifies SECRET_REDACTOR_USAGE at info', () => {
  const notify = vi.fn<(msg: string, level: 'info' | 'warning' | 'error') => void>();
  if (isHelpArg('help')) notify(SECRET_REDACTOR_USAGE, 'info');

  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(SECRET_REDACTOR_USAGE, 'info');
  expect(SECRET_REDACTOR_USAGE).toContain('/secret-redactor');
});

// ──────────────────────────────────────────────────────────────────────
// `/unredact` argument completion (positional). The shell builds it as
// `completePositional(prefix.replace(/^#/, ''), () => store.entries()...)`.
// We mirror that exact call against a real SecretStore.
// ──────────────────────────────────────────────────────────────────────

function seededStore(): SecretStore {
  const store = new SecretStore();
  store.register('AKIAIOSFODNN7EXAMPLE', 'aws-access-key');
  store.register('ghp_' + 'a'.repeat(36), 'github-token');
  return store;
}

/** Mirror of `config/pi/extensions/secret-redactor.ts`'s getArgumentCompletions. */
const unredactCompletions = (prefix: string, store: SecretStore): CompletionItem[] | null =>
  completePositional(prefix.replace(/^#/, ''), () =>
    store.entries().map((e) => ({ value: e.handle, label: `${e.handle}  (${e.label})` })),
  );

test('completion: empty prefix lists every redacted handle with a `handle  (label)` label', () => {
  const store = seededStore();
  const handles = store.entries().map((e) => e.handle);
  const out = unredactCompletions('', store);

  expect(out?.map((c) => c.value)).toEqual(handles);
  for (const c of out ?? []) {
    const entry = store.lookup(c.value);
    expect(c.label).toBe(`${entry?.handle}  (${entry?.label})`);
  }
});

test('completion: filters by the typed handle prefix', () => {
  const store = seededStore();
  const target = store.entries()[0].handle;
  const out = unredactCompletions(target.slice(0, 3), store);

  expect(out?.every((c) => c.value.startsWith(target.slice(0, 3)))).toBe(true);
  expect(out?.some((c) => c.value === target)).toBe(true);
});

test('completion: a leading `#` in the typed prefix is stripped before matching', () => {
  const store = seededStore();
  const target = store.entries()[0].handle;
  const out = unredactCompletions(`#${target}`, store);

  expect(out?.map((c) => c.value)).toEqual([target]);
});

test('completion: returns null when nothing matches', () => {
  const store = seededStore();
  expect(unredactCompletions('zzzznomatch', store)).toBeNull();
  // ...and when the store is empty.
  expect(unredactCompletions('', new SecretStore())).toBeNull();
});
