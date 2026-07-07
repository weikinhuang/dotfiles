/**
 * Tests for lib/node/pi/secret-redactor/redact.ts.
 *
 * Pure module - no pi runtime needed. These carry the correctness load
 * for the extension: positive detection, allowlist + guard negatives,
 * capture-group value-only redaction, stable handles, and rehydration.
 */

import { describe, expect, test } from 'vitest';

import type { CompiledRule } from '../../../../../lib/node/pi/secret-redactor/patterns.ts';
import {
  DEFAULT_CONFIG,
  redactText,
  type RedactorConfig,
  rehydrateText,
} from '../../../../../lib/node/pi/secret-redactor/redact.ts';
import { SecretStore } from '../../../../../lib/node/pi/secret-redactor/store.ts';

const cfg = (over: Partial<RedactorConfig> = {}): RedactorConfig => ({ ...DEFAULT_CONFIG, ...over });

describe('redactText - prefixed (Layer A)', () => {
  test('redacts an AWS access key', () => {
    const store = new SecretStore();
    const { text, hits } = redactText('key is AKIAIOSFODNN7EXAMPLE done', store, cfg());

    expect(text).toMatch(/^key is \[REDACTED:aws-access-key#[0-9a-f]{4,}\] done$/);
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe('aws-access-key');
  });

  test('labels openai and anthropic keys distinctly', () => {
    const store = new SecretStore();
    const oa = redactText(`sk-${'A'.repeat(24)}`, store, cfg());
    const an = redactText(`sk-ant-${'A'.repeat(24)}`, store, cfg());

    expect(oa.hits[0].label).toBe('openai-key');
    expect(an.hits[0].label).toBe('anthropic-key');
  });

  test('redacts a PEM private key block', () => {
    const store = new SecretStore();
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----';
    const { text, hits } = redactText(`here:\n${pem}\nok`, store, cfg());

    expect(hits[0].label).toBe('private-key');
    expect(text).not.toContain('MIIBVgIBADANBg');
    expect(text).toContain('[REDACTED:private-key#');
  });
});

describe('redactText - keyword (Layer B)', () => {
  test('redacts only the value, leaving the key readable', () => {
    const store = new SecretStore();
    const { text } = redactText('password = "supersecret123"', store, cfg());

    expect(text).toMatch(/^password = "\[REDACTED:assigned-secret#[0-9a-f]{4,}\]"$/);
  });

  test('redacts only the password segment of a connection string', () => {
    const store = new SecretStore();
    const { text, hits } = redactText('postgres://admin:hunter2password@db.example.com:5432/app', store, cfg());

    expect(hits[0].label).toBe('connection-string');
    expect(text).toMatch(/^postgres:\/\/admin:\[REDACTED:connection-string#[0-9a-f]{4,}\]@db\.example\.com:5432\/app$/);
  });

  test('skips env-var references', () => {
    const store = new SecretStore();
    expect(redactText('api_key=$MY_KEY', store, cfg()).hits).toHaveLength(0);
    expect(redactText('password=process.env.SECRET', store, cfg()).hits).toHaveLength(0);
    expect(redactText('token=${GH_TOKEN}', store, cfg()).hits).toHaveLength(0);
  });

  test('skips placeholders and short values', () => {
    const store = new SecretStore();
    expect(redactText('secret=<your-secret-here>', store, cfg()).hits).toHaveLength(0);
    expect(redactText('password=xxxxxxxx', store, cfg()).hits).toHaveLength(0);
    expect(redactText('password=changeme', store, cfg()).hits).toHaveLength(0);
    expect(redactText('token=short', store, cfg()).hits).toHaveLength(0); // < 8
  });

  test('skips network locators (url / ip / host:port) assigned to a sensitive key', () => {
    const store = new SecretStore();
    expect(redactText('token=http://gpu.lan:19999/v1', store, cfg()).hits).toHaveLength(0);
    expect(redactText('secret: https://llm.s.huang.io/v1', store, cfg()).hits).toHaveLength(0);
    expect(redactText('access-key: 10.0.0.5:19999', store, cfg()).hits).toHaveLength(0);
    expect(redactText('api_key = gpu-box.lan:19999', store, cfg()).hits).toHaveLength(0);
    // a real secret next to the same key is still redacted.
    expect(redactText('token=hunter2password', store, cfg()).hits).toHaveLength(1);
  });
});

describe('redactText - allowlist', () => {
  test('does not redact a git SHA assigned to a sensitive key', () => {
    const store = new SecretStore();
    const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    expect(redactText(`token=${sha}`, store, cfg()).hits).toHaveLength(0);
  });

  test('does not redact a UUID', () => {
    const store = new SecretStore();
    expect(redactText('secret=550e8400-e29b-41d4-a716-446655440000', store, cfg()).hits).toHaveLength(0);
  });

  test('honors a user allowlist regex', () => {
    const store = new SecretStore();
    const c = cfg({ allowlist: [/^ACME-PUBLIC-/] });
    expect(redactText('token=ACME-PUBLIC-abcdefgh', store, c).hits).toHaveLength(0);
  });
});

describe('redactText - layers + custom rules', () => {
  test('keyword layer can be disabled', () => {
    const store = new SecretStore();
    const c = cfg({ layers: { prefixed: true, keyword: false } });
    expect(redactText('password=supersecret123', store, c).hits).toHaveLength(0);
  });

  test('custom prefixed rule augments the corpus', () => {
    const store = new SecretStore();
    const custom: CompiledRule = { id: 'acme-key', re: /\bACME-[0-9a-f]{8}\b/dg, group: 0, kind: 'prefixed' };
    const { hits } = redactText('use ACME-deadbeef now', store, cfg({ customRules: [custom] }));

    expect(hits[0].label).toBe('acme-key');
  });
});

describe('redactText - stability + determinism', () => {
  test('the same secret maps to the same placeholder', () => {
    const store = new SecretStore();
    const a = redactText('AKIAIOSFODNN7EXAMPLE', store, cfg());
    const b = redactText('again AKIAIOSFODNN7EXAMPLE', store, cfg());

    expect(b.text).toContain(a.text); // same placeholder reused
  });

  test('redacts multiple distinct secrets in one string', () => {
    const store = new SecretStore();
    const { hits } = redactText(`a=AKIAIOSFODNN7EXAMPLE b=ghp_${'a'.repeat(36)}`, store, cfg());

    expect(hits.map((h) => h.label).sort()).toEqual(['aws-access-key', 'github-token']);
  });

  test('text with no secrets is returned unchanged', () => {
    const store = new SecretStore();
    const input = 'just some ordinary text, see PR #123';
    expect(redactText(input, store, cfg()).text).toBe(input);
  });

  test('an approved handle is revealed (not re-redacted)', () => {
    const store = new SecretStore();
    const first = redactText('AKIAIOSFODNN7EXAMPLE', store, cfg());
    expect(first.hits).toHaveLength(1);
    store.approve(first.hits[0].handle);

    const after = redactText('AKIAIOSFODNN7EXAMPLE', store, cfg());
    expect(after.text).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(after.hits).toHaveLength(0);
  });
});

describe('rehydrateText', () => {
  test('replaces a full placeholder for an approved handle', () => {
    const store = new SecretStore();
    const { handle, label } = store.register('sk_live_realvalue', 'stripe-key');
    const cmd = `STRIPE=[REDACTED:${label}#${handle}] ./deploy.sh`;
    const { text, used } = rehydrateText(cmd, (h) => store.lookup(h)?.value);

    expect(text).toBe('STRIPE=sk_live_realvalue ./deploy.sh');
    expect(used).toEqual([handle]);
  });

  test('replaces a bare #handle reference', () => {
    const store = new SecretStore();
    const { handle } = store.register('secretval', 'k');
    const { text } = rehydrateText(`tok #${handle}`, (h) => store.lookup(h)?.value);

    expect(text).toBe('tok secretval');
  });

  test('leaves a reference untouched when the resolver declines', () => {
    const store = new SecretStore();
    const { handle, label } = store.register('v', 'k');
    const cmd = `X=[REDACTED:${label}#${handle}]`;
    const { text, used } = rehydrateText(cmd, () => undefined); // unapproved

    expect(text).toBe(cmd);
    expect(used).toEqual([]);
  });
});
