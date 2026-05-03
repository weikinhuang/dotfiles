/**
 * Tests for lib/node/pi/deep-research-review-config.ts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { consentPath, readConsent, recordConsent } from '../../../../lib/node/pi/deep-research-review-config.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pi-dr-consent-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('deep-research-review-config', () => {
  test('consentPath lands under <root>/global/reference/', () => {
    const p = consentPath({ root: sandbox });

    expect(p).toBe(join(sandbox, 'global', 'reference', 'deep-research-review-auto-accept.md'));
  });

  test('readConsent returns consented=false when the file is missing', () => {
    const state = readConsent({ root: sandbox });

    expect(state).toEqual({ consented: false, at: null });
  });

  test('recordConsent writes a frontmatter file with acceptedAt', () => {
    const state = recordConsent({ root: sandbox, now: () => new Date('2025-04-05T06:07:08Z') });

    expect(state.consented).toBe(true);
    expect(state.at).toBe('2025-04-05T06:07:08.000Z');
    expect(existsSync(consentPath({ root: sandbox }))).toBe(true);

    const body = readFileSync(consentPath({ root: sandbox }), 'utf8');

    expect(body).toContain('type: reference');
    expect(body).toContain('acceptedAt: 2025-04-05T06:07:08.000Z');
  });

  test('readConsent round-trips the acceptedAt timestamp', () => {
    recordConsent({ root: sandbox, now: () => new Date('2025-04-05T06:07:08Z') });

    const state = readConsent({ root: sandbox });

    expect(state.consented).toBe(true);
    expect(state.at).toBe('2025-04-05T06:07:08.000Z');
  });

  test('readConsent treats a malformed file (no frontmatter) as NOT consented', () => {
    // Create a file with no frontmatter — parseFrontmatter returns
    // null, so readConsent reports the safer "not consented"
    // state. This prevents a stray text file from silently opting
    // a user into auto-accept.
    mkdirSync(join(sandbox, 'global', 'reference'), { recursive: true });
    writeFileSync(consentPath({ root: sandbox }), 'no frontmatter here\n');

    const state = readConsent({ root: sandbox });

    expect(state.consented).toBe(false);
    expect(state.at).toBeNull();
  });

  test('readConsent still consents when frontmatter lacks acceptedAt', () => {
    // A valid frontmatter stamp without `acceptedAt` is still a
    // consent signal — the timestamp is just missing metadata
    // (e.g. hand-edited by the user). The user clearly created
    // the file on purpose.
    mkdirSync(join(sandbox, 'global', 'reference'), { recursive: true });
    writeFileSync(
      consentPath({ root: sandbox }),
      '---\n' +
        'type: reference\n' +
        'name: auto accept\n' +
        'description: d\n' +
        '---\n\n' +
        'body only, no acceptedAt\n',
    );

    const state = readConsent({ root: sandbox });

    expect(state.consented).toBe(true);
    expect(state.at).toBeNull();
  });

  test('recordConsent is idempotent — second call updates the timestamp', () => {
    recordConsent({ root: sandbox, now: () => new Date('2025-04-05T06:07:08Z') });
    const second = recordConsent({ root: sandbox, now: () => new Date('2026-01-01T00:00:00Z') });

    expect(second.at).toBe('2026-01-01T00:00:00.000Z');
    expect(readConsent({ root: sandbox }).at).toBe('2026-01-01T00:00:00.000Z');
  });
});
