/**
 * Tests for lib/node/opencode/secret-redactor.ts.
 *
 * Config tests touch disk (temp dirs only); paths and env are injected so
 * the host environment is never read.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildUnredactPermission,
  describeRedactorConfig,
  opencodeConfigDir,
  parseSecretRedactorRpcInput,
  parseSecretRedactorStatus,
  resolveSecretRedactorConfig,
  secretRedactorConfigFiles,
  SecretRedactorEngine,
  UNREDACT_ACTION,
  unredactAskRuleIndex,
} from '../../../../lib/node/opencode/secret-redactor.ts';
import { DEFAULT_CONFIG, type RedactorConfig } from '../../../../lib/node/pi/secret-redactor/redact.ts';

// Obviously fake, but shaped to match the github-token / aws-access-key rules.
const GH = 'ghp_FAKEfakeFAKEfake0123456789abcdefABCD';
const AWS = 'AKIAFAKEFAKEFAKE1234';

const userMessage = (text: string): { role: string; content: unknown[] } => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const request = (...texts: string[]): { system: unknown[]; messages: unknown[] } => ({
  system: [{ type: 'text', text: 'You are helpful.' }],
  messages: texts.map(userMessage),
});

const placeholderIn = (req: unknown): string => {
  const m = /\[REDACTED:[^\]]+#([0-9a-f]+)\]/.exec(JSON.stringify(req));
  if (!m) throw new Error('no placeholder');
  return m[1];
};

describe('config', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `oc-secret-redactor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, 'global'), { recursive: true });
    mkdirSync(join(root, 'proj', '.opencode'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('opencodeConfigDir follows OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(opencodeConfigDir({ OPENCODE_CONFIG_DIR: '/p' }, '/h')).toBe('/p');
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/opencode');
    expect(opencodeConfigDir({ XDG_CONFIG_HOME: ' ' }, '/h')).toBe('/h/.config/opencode');
  });

  test('secretRedactorConfigFiles: global first, then distinct project dirs', () => {
    expect(secretRedactorConfigFiles('/g', ['/repo', '/repo', '/repo/sub'])).toEqual([
      '/g/secret-redactor.json',
      '/repo/.opencode/secret-redactor.json',
      '/repo/sub/.opencode/secret-redactor.json',
    ]);
  });

  test('defaults with no options or files', () => {
    const cfg = resolveSecretRedactorConfig(undefined, {}, []);
    expect(cfg).toMatchObject({ enabled: true, rehydrate: true, trace: undefined, dump: undefined, warnings: [] });
    expect(cfg.redactor.layers).toEqual(DEFAULT_CONFIG.layers);
    expect(cfg.redactor.keywordMinLength).toBe(8);
  });

  test('options, then global file, then project file stack; rules and allowlist accumulate', () => {
    const files = secretRedactorConfigFiles(join(root, 'global'), [join(root, 'proj')]);
    writeFileSync(files[0], '{ "keywordMinLength": 10, "rules": [{ "id": "g", "pattern": "G-[0-9]{4}" }] }');
    writeFileSync(files[1], '// jsonc\n{ "layers": { "keyword": false }, "allowlist": ["^ok$"], }');
    const cfg = resolveSecretRedactorConfig(
      { keywordMinLength: 4, rules: [{ id: 'o', pattern: 'O-[0-9]{4}' }], trace: '/t.log' },
      {},
      files,
    );
    expect(cfg.redactor.keywordMinLength).toBe(10);
    expect(cfg.redactor.layers).toEqual({ prefixed: true, keyword: false });
    expect(cfg.redactor.customRules.map((r) => r.id)).toEqual(['o', 'g']);
    expect(cfg.redactor.allowlist).toHaveLength(1);
    expect(cfg.trace).toBe('/t.log');
    expect(cfg.warnings).toEqual([]);
  });

  test('env overrides scalar knobs over options and files', () => {
    const files = secretRedactorConfigFiles(join(root, 'global'), []);
    writeFileSync(files[0], '{ "keywordMinLength": 10 }');
    const cfg = resolveSecretRedactorConfig(
      { rehydrate: true },
      {
        OPENCODE_SECRET_REDACTOR_KEYWORD_MIN_LENGTH: '12',
        OPENCODE_SECRET_REDACTOR_REHYDRATE: '0',
        OPENCODE_SECRET_REDACTOR_ENABLED: 'no',
        OPENCODE_SECRET_REDACTOR_DUMP: '/d.jsonl',
      },
      files,
    );
    expect(cfg.redactor.keywordMinLength).toBe(12);
    expect(cfg.rehydrate).toBe(false);
    expect(cfg.enabled).toBe(false);
    expect(cfg.dump).toBe('/d.jsonl');
  });

  test('bad rules from options and files become warnings, never throws', () => {
    const files = secretRedactorConfigFiles(join(root, 'global'), []);
    writeFileSync(files[0], '{ not json');
    const cfg = resolveSecretRedactorConfig({ rules: [{ id: 'x', pattern: '(' }], allowlist: 'nope' }, {}, files);
    expect(cfg.warnings.map((w) => w.path)).toEqual(['plugin options', 'plugin options', files[0]]);
    expect(cfg.redactor.customRules).toEqual([]);
  });

  test('describeRedactorConfig summarizes without values', () => {
    const cfg = resolveSecretRedactorConfig(undefined, {}, []);
    expect(describeRedactorConfig(cfg)).toBe(
      'layers prefixed=true keyword=true, 0 custom rule(s), 0 allowlist pattern(s), keywordMinLength=8, rehydrate=ask',
    );
  });
});

describe('SecretRedactorEngine redaction', () => {
  test('redacts a request and reports distinct hits', () => {
    const engine = new SecretRedactorEngine(DEFAULT_CONFIG);
    const req = request(`token ${GH}`, `again ${GH}`, `aws ${AWS}`);
    const { changed, hits } = engine.redactRequest('root', req);
    expect(changed).toBe(3);
    expect(hits.map((h) => h.label)).toEqual(['github-token', 'aws-access-key']);
    const json = JSON.stringify(req);
    expect(json).not.toContain(GH);
    expect(json).not.toContain(AWS);
  });

  test('placeholders are deterministic across engines and requests', () => {
    const a = request(`x ${GH}`);
    const b = request(`x ${GH}`);
    const c = request(`x ${GH}`);
    const e1 = new SecretRedactorEngine(DEFAULT_CONFIG);
    e1.redactRequest('s1', a);
    e1.redactRequest('s1', b);
    new SecretRedactorEngine(DEFAULT_CONFIG).redactRequest('s2', c);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });

  test('built-in and custom allowlists win over rules', () => {
    const sha = 'a'.repeat(39) + 'b';
    const cfg: RedactorConfig = { ...DEFAULT_CONFIG, allowlist: [/^ghp_FAKE/] };
    const req = request(`token=${sha}`, GH);
    const { hits } = new SecretRedactorEngine(cfg).redactRequest('root', req);
    expect(hits).toEqual([]);
    expect(JSON.stringify(req)).toContain(sha);
    expect(JSON.stringify(req)).toContain(GH);
  });

  test('compaction-shaped transcript (tool call + tool result) is fully redacted', () => {
    const engine = new SecretRedactorEngine(DEFAULT_CONFIG);
    const req = {
      system: [{ type: 'text', text: 'summarize' }],
      messages: [
        userMessage('read the env'),
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'shell', input: { command: 'cat .env' } }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', id: 'c1', name: 'shell', result: { type: 'text', value: `T=${GH}` } }],
        },
        { role: 'assistant', content: [{ type: 'text', text: `found ${AWS}` }] },
      ],
    };
    engine.redactRequest('root', req);
    const json = JSON.stringify(req);
    expect(json).not.toContain(GH);
    expect(json).not.toContain(AWS);
    expect(json).toContain('[REDACTED:github-token#');
  });
});

describe('SecretRedactorEngine rehydration', () => {
  test('referencedSecrets resolves only handles seen in the scope', () => {
    const engine = new SecretRedactorEngine(DEFAULT_CONFIG);
    const req = request(GH);
    engine.redactRequest('root', req);
    const handle = placeholderIn(req);
    const input = { command: `echo [REDACTED:github-token#${handle}]` };
    expect(engine.referencedSecrets('root', input).pending.map((e) => e.handle)).toEqual([handle]);
    expect(engine.referencedSecrets('other', input).pending).toEqual([]);
    expect(engine.referencedSecrets('root', { command: 'echo #ffff' }).pending).toEqual([]);
  });

  test('rehydrate swaps approved placeholders and bare handles, deep in the input', () => {
    const engine = new SecretRedactorEngine(DEFAULT_CONFIG);
    const req = request(GH, AWS);
    engine.redactRequest('root', req);
    const [gh, aws] = [...JSON.stringify(req).matchAll(/#([0-9a-f]+)\]/g)].map((m) => m[1]);
    const input = { command: `X=[REDACTED:github-token#${gh}] Y=#${aws}`, env: { A: `#${gh}` } };
    const partial = engine.rehydrate(input, new Set([gh]));
    expect(partial.used).toEqual([gh]);
    expect(partial.input).toEqual({ command: `X=${GH} Y=#${aws}`, env: { A: GH } });
    expect(input.command).toContain('[REDACTED'); // original untouched
    const none = engine.rehydrate(input, new Set());
    expect(none.input).toBe(input);
    expect(none.used).toEqual([]);
  });

  test('reveal is scoped: plaintext in that scope only, and listed as revealed', () => {
    const engine = new SecretRedactorEngine(DEFAULT_CONFIG);
    const first = request(GH);
    engine.redactRequest('root', first);
    const handle = placeholderIn(first);
    expect(engine.reveal('root', `#${handle}`)?.label).toBe('github-token');
    expect(engine.reveal('root', 'ffff')).toBeUndefined();

    const again = request(GH);
    expect(engine.redactRequest('root', again).hits).toEqual([]);
    expect(JSON.stringify(again)).toContain(GH);

    const elsewhere = request(GH);
    engine.redactRequest('other', elsewhere);
    expect(JSON.stringify(elsewhere)).not.toContain(GH);

    expect(engine.status('root')).toEqual([{ handle, label: 'github-token', state: 'revealed' }]);
    expect(engine.status('other')).toEqual([{ handle, label: 'github-token', state: 'redacted' }]);
    const refs = engine.referencedSecrets('root', { command: `#${handle}` });
    expect(refs.revealed.map((e) => e.handle)).toEqual([handle]);
    expect(refs.pending).toEqual([]);

    engine.forget('root');
    expect(engine.status('root')).toEqual([]);
  });
});

describe('permission helpers', () => {
  test('buildUnredactPermission batches every secret as resource + save pattern', () => {
    const entries = [
      { handle: 'ab12', label: 'github-token', value: GH },
      { handle: 'cd34', label: 'aws-access-key', value: AWS },
    ];
    const p = buildUnredactPermission(entries, 'shell');
    expect(p).toEqual({
      action: UNREDACT_ACTION,
      resources: ['github-token#ab12', 'aws-access-key#cd34'],
      save: ['github-token#ab12', 'aws-access-key#cd34'],
      metadata: { tool: 'shell', secrets: ['github-token#ab12', 'aws-access-key#cd34'] },
    });
    expect(JSON.stringify(p)).not.toContain(GH);
  });

  test('unredactAskRuleIndex inserts after the base wildcard allow, before configured rules', () => {
    const base = [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'read', resource: '*.env', effect: 'ask' },
    ];
    expect(unredactAskRuleIndex(base)).toBe(1);
    expect(unredactAskRuleIndex([])).toBe(0);
    const inserted = [base[0], { action: UNREDACT_ACTION, resource: '*', effect: 'ask' }, base[1]];
    expect(unredactAskRuleIndex(inserted)).toBeUndefined();
  });
});

describe('rpc parsing', () => {
  test('parseSecretRedactorRpcInput', () => {
    expect(parseSecretRedactorRpcInput({ sessionID: 's' })).toEqual({ sessionID: 's' });
    expect(parseSecretRedactorRpcInput({ sessionID: 's', handle: ' #ab12 ' })).toEqual({
      sessionID: 's',
      handle: 'ab12',
    });
    expect(parseSecretRedactorRpcInput({ sessionID: 's', handle: '#' })).toBeUndefined();
    expect(parseSecretRedactorRpcInput({ sessionID: '' })).toBeUndefined();
    expect(parseSecretRedactorRpcInput(null)).toBeUndefined();
  });

  test('parseSecretRedactorStatus tolerates junk', () => {
    expect(
      parseSecretRedactorStatus({
        summary: 'x',
        secrets: [{ handle: 'ab12', label: 'l', state: 'revealed' }, { handle: 1 }, null, { handle: 'cd', label: 'm' }],
      }),
    ).toEqual({
      summary: 'x',
      secrets: [
        { handle: 'ab12', label: 'l', state: 'revealed' },
        { handle: 'cd', label: 'm', state: 'redacted' },
      ],
    });
    expect(parseSecretRedactorStatus(undefined)).toEqual({ summary: '', secrets: [] });
  });
});
