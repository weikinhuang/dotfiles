// Tests for lib/node/ai-skill-eval/validate.ts.
//
// The validator is pure: it reads a SKILL.md from disk and returns a
// structured result. We build fixtures under a fresh temp dir per test so
// the rules are exercised in isolation from the host repo's real skills.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  ALLOWED_KEYS,
  formatFailure,
  validateSkillMd,
  type ValidationFailure,
} from '../../../../lib/node/ai-skill-eval/validate.ts';

interface Fixture {
  dir: string;
  write: (body: string) => string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ai-skill-eval-validate-'));
  const write = (body: string): string => {
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, body);
    return path;
  };
  return { dir, write };
}

/** Shorthand to coerce to failure and satisfy the exhaustive `ok: false` narrow. */
function asFailure(r: ReturnType<typeof validateSkillMd>): ValidationFailure {
  if (r.ok) throw new Error(`expected failure, got success on ${r.path}`);
  return r;
}

describe('validateSkillMd - happy path', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('minimal valid frontmatter passes', () => {
    const p = fx.write(`---\nname: sample\ndescription: 'A tiny sample skill.'\n---\n\n# body\n`);

    expect(validateSkillMd(p)).toEqual({ ok: true, path: p });
  });

  test('all allowed keys present passes', () => {
    const p = fx.write(
      [
        '---',
        'name: kitchen-sink',
        "description: 'Docs.'",
        'license: MIT',
        'allowed-tools:',
        '  - read',
        '  - bash',
        'metadata:',
        '  author: someone',
        '  version: 1',
        "compatibility: '>=1.0'",
        '---',
        '',
        '# body',
      ].join('\n'),
    );

    expect(validateSkillMd(p).ok).toBe(true);
  });

  test('CRLF line endings are tolerated', () => {
    const p = fx.write(`---\r\nname: sample\r\ndescription: 'crlf'\r\n---\r\n`);

    expect(validateSkillMd(p).ok).toBe(true);
  });

  test('description split across indented continuation lines joins for the length check', () => {
    const p = fx.write(['---', 'name: multi', 'description:', "  'line one", "  line two'", '---', ''].join('\n'));

    expect(validateSkillMd(p).ok).toBe(true);
  });

  test('ALLOWED_KEYS is frozen/accurate', () => {
    // Guard against someone silently expanding the whitelist without
    // updating the validator.
    expect([...ALLOWED_KEYS].sort()).toEqual(
      ['allowed-tools', 'compatibility', 'description', 'license', 'metadata', 'name'].sort(),
    );
  });
});

describe('validateSkillMd - fence errors', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('missing opening fence fails with frontmatter-fence', () => {
    const p = fx.write(`# no frontmatter here\n`);
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('frontmatter-fence');
    expect(r.line).toBe(1);
    expect(r.message).toMatch(/no YAML frontmatter/);
  });

  test('missing closing fence fails with frontmatter-fence', () => {
    const p = fx.write(`---\nname: sample\ndescription: 'x'\n`);
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('frontmatter-fence');
    expect(r.message).toMatch(/missing closing/);
  });

  test('unreadable path fails with read-error', () => {
    const r = asFailure(validateSkillMd(join(fx.dir, 'does-not-exist.md')));

    expect(r.rule).toBe('read-error');
  });
});

describe('validateSkillMd - key shape', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('unknown top-level key fails with unknown-key', () => {
    const p = fx.write(['---', 'name: sample', "description: 'x'", 'bogus: value', '---', ''].join('\n'));
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('unknown-key');
    expect(r.message).toMatch(/bogus/);
    // Points at SKILL.md line 4 (1-indexed): --- / name / description / bogus
    expect(r.line).toBe(4);
  });

  test('duplicate key fails with duplicate-key at the second occurrence', () => {
    const p = fx.write(['---', 'name: sample', "description: 'x'", 'name: again', '---', ''].join('\n'));
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('duplicate-key');
    expect(r.line).toBe(4);
  });

  test('missing name fails with missing-field', () => {
    const p = fx.write(['---', "description: 'x'", '---', ''].join('\n'));
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('missing-field');
    expect(r.message).toMatch(/'name'/);
  });

  test('missing description fails with missing-field', () => {
    const p = fx.write(['---', 'name: sample', '---', ''].join('\n'));
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('missing-field');
    expect(r.message).toMatch(/'description'/);
  });

  test('malformed non-indented line fails with frontmatter-parse', () => {
    const p = fx.write(['---', 'name sample', "description: 'x'", '---', ''].join('\n'));
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('frontmatter-parse');
  });
});

describe('validateSkillMd - name rules', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  const withName = (name: string): string =>
    fx.write(['---', `name: ${name}`, "description: 'x'", '---', ''].join('\n'));

  test('uppercase letters fail name-kebab-case', () => {
    const r = asFailure(validateSkillMd(withName('Sample')));

    expect(r.rule).toBe('name-kebab-case');
    expect(r.value).toBe('Sample');
  });

  test('underscores fail name-kebab-case', () => {
    const r = asFailure(validateSkillMd(withName('sample_name')));

    expect(r.rule).toBe('name-kebab-case');
  });

  test('spaces fail name-kebab-case', () => {
    const r = asFailure(validateSkillMd(withName("'sample name'")));

    expect(r.rule).toBe('name-kebab-case');
  });

  test('leading hyphen fails name-hyphen-shape', () => {
    const r = asFailure(validateSkillMd(withName('-sample')));

    expect(r.rule).toBe('name-hyphen-shape');
  });

  test('trailing hyphen fails name-hyphen-shape', () => {
    const r = asFailure(validateSkillMd(withName('sample-')));

    expect(r.rule).toBe('name-hyphen-shape');
  });

  test('consecutive hyphens fail name-hyphen-shape', () => {
    const r = asFailure(validateSkillMd(withName('sam--ple')));

    expect(r.rule).toBe('name-hyphen-shape');
  });

  test('>64 chars fails name-too-long', () => {
    const r = asFailure(validateSkillMd(withName('a'.repeat(65))));

    expect(r.rule).toBe('name-too-long');
  });

  test('exactly 64 chars passes', () => {
    expect(validateSkillMd(withName('a'.repeat(64))).ok).toBe(true);
  });

  test('digits-only name passes', () => {
    expect(validateSkillMd(withName('42')).ok).toBe(true);
  });
});

describe('validateSkillMd - description rules', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  const withDesc = (desc: string): string =>
    fx.write(['---', 'name: sample', `description: ${desc}`, '---', ''].join('\n'));

  test('angle bracket < fails description-angle-brackets', () => {
    const r = asFailure(validateSkillMd(withDesc("'use <bracket>'")));

    expect(r.rule).toBe('description-angle-brackets');
  });

  test('angle bracket > alone still fails description-angle-brackets', () => {
    const r = asFailure(validateSkillMd(withDesc("'arrow > here'")));

    expect(r.rule).toBe('description-angle-brackets');
  });

  test('>1024 chars fails description-too-long', () => {
    const long = 'a'.repeat(1025);
    const r = asFailure(validateSkillMd(withDesc(`'${long}'`)));

    expect(r.rule).toBe('description-too-long');
    expect(r.message).toMatch(/1025/);
  });

  test('exactly 1024 chars passes', () => {
    const bound = 'a'.repeat(1024);

    expect(validateSkillMd(withDesc(`'${bound}'`)).ok).toBe(true);
  });

  test('folded block scalar (>-) does NOT false-trigger description-angle-brackets', () => {
    // Regression: the validate joiner used to keep `>-` as the first
    // character of the joined scalar, which tripped the angle-brackets
    // rule on every SKILL.md that used YAML's folded block form.
    const p = fx.write(
      ['---', 'name: sample', 'description: >-', '  WHAT: do a thing. WHEN: always. DO-NOT: never.', '---', ''].join(
        '\n',
      ),
    );

    expect(validateSkillMd(p).ok).toBe(true);
  });

  test('literal block scalar (|) does NOT false-trigger description-angle-brackets', () => {
    const p = fx.write(
      ['---', 'name: sample', 'description: |', '  WHAT: line one.', '  WHEN: line two.', '---', ''].join('\n'),
    );

    expect(validateSkillMd(p).ok).toBe(true);
  });
});

describe('validateSkillMd - compatibility rules', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.dir, { recursive: true, force: true });
  });

  test('>500 chars fails compatibility-too-long', () => {
    const long = 'a'.repeat(501);
    const p = fx.write(['---', 'name: sample', "description: 'x'", `compatibility: '${long}'`, '---', ''].join('\n'));
    const r = asFailure(validateSkillMd(p));

    expect(r.rule).toBe('compatibility-too-long');
  });

  test('exactly 500 chars passes', () => {
    const bound = 'a'.repeat(500);
    const p = fx.write(['---', 'name: sample', "description: 'x'", `compatibility: '${bound}'`, '---', ''].join('\n'));

    expect(validateSkillMd(p).ok).toBe(true);
  });

  test('angle brackets in compatibility are allowed (e.g. ">=1.0")', () => {
    const p = fx.write(['---', 'name: sample', "description: 'x'", "compatibility: '>=1.0'", '---', ''].join('\n'));

    expect(validateSkillMd(p).ok).toBe(true);
  });
});

describe('formatFailure', () => {
  test('includes path, line, rule and message in a single line', () => {
    const f: ValidationFailure = {
      ok: false,
      path: '/tmp/SKILL.md',
      rule: 'name-kebab-case',
      message: "name 'Foo' must be kebab-case",
      line: 2,
    };

    expect(formatFailure(f)).toBe(`/tmp/SKILL.md:2: [name-kebab-case] name 'Foo' must be kebab-case`);
  });

  test('omits the line suffix when not known', () => {
    const f: ValidationFailure = {
      ok: false,
      path: '/tmp/SKILL.md',
      rule: 'missing-field',
      message: "missing required field 'name'",
    };

    expect(formatFailure(f)).toBe(`/tmp/SKILL.md: [missing-field] missing required field 'name'`);
  });
});
