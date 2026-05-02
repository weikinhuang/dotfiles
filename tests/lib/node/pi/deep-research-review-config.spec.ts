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

  test('readConsent treats a malformed file as "not consented"', () => {
    // Create a file with no frontmatter — consented=true (file
    // exists) but at=null (no acceptedAt shape found).
    mkdirSync(join(sandbox, 'global', 'reference'), { recursive: true });
    writeFileSync(consentPath({ root: sandbox }), 'no frontmatter here\n');

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
