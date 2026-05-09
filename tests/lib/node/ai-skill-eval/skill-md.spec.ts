// SPDX-License-Identifier: MIT
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  parseSkillMd,
  parseSkillMdText,
  renderFoldedDescription,
  renderSkillWithDescription,
  SkillMdParseError,
} from '../../../../lib/node/ai-skill-eval/skill-md.ts';

function tmpSkill(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-md-'));
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, body);
  return path;
}

describe('parseSkillMdText', () => {
  test('parses a single-line single-quoted description', () => {
    const src = `---
name: foo
description: 'Use foo when bar. Do not use foo when baz.'
---

# foo

Body.
`;
    const p = parseSkillMdText('mem', src);

    expect(p.name).toBe('foo');
    expect(p.description).toBe('Use foo when bar. Do not use foo when baz.');
    expect(p.descriptionStartLine).toBe(2);
    expect(p.descriptionEndLine).toBe(2);
    expect(p.frontmatterCloseLine).toBe(3);
    expect(p.body).toBe('\n# foo\n\nBody.\n');
  });

  test('parses a folded block scalar description spanning multiple lines', () => {
    const src = `---
name: foo
description: >-
  WHAT: Use foo when bar happens.
  WHEN: Any time the user says "foo".
  DO-NOT: Run foo against prod.
---
body
`;
    const p = parseSkillMdText('mem', src);

    expect(p.name).toBe('foo');
    // Folded block joins fragments with spaces.
    expect(p.description).toContain('WHAT: Use foo when bar happens.');
    expect(p.description).toContain('WHEN: Any time');
    expect(p.descriptionStartLine).toBe(2);
    expect(p.descriptionEndLine).toBe(5);
  });

  test('parses a multi-line flow-style single-quoted scalar', () => {
    const src = `---
name: foo
description:
  'WHAT: thing. WHEN: thing. DO-NOT: other thing.'
---
body
`;
    const p = parseSkillMdText('mem', src);

    expect(p.description).toBe('WHAT: thing. WHEN: thing. DO-NOT: other thing.');
    expect(p.descriptionStartLine).toBe(2);
    expect(p.descriptionEndLine).toBe(3);
  });

  test('throws when the file has no opening fence', () => {
    expect(() => parseSkillMdText('mem', 'no frontmatter here\n')).toThrowError(SkillMdParseError);
  });

  test('throws when the closing fence is missing', () => {
    expect(() => parseSkillMdText('mem', '---\nname: foo\ndescription: bar\n')).toThrowError(SkillMdParseError);
  });

  test('throws when name or description is missing', () => {
    expect(() => parseSkillMdText('mem', '---\nname: foo\n---\n')).toThrowError(/description/);
    expect(() => parseSkillMdText('mem', '---\ndescription: foo\n---\n')).toThrowError(/name/);
  });
});

describe('parseSkillMd (filesystem)', () => {
  test('reads a file and returns the parsed structure', () => {
    const path = tmpSkill(`---
name: real
description: 'A real file.'
---
hi
`);
    const p = parseSkillMd(path);

    expect(p.path).toBe(path);
    expect(p.description).toBe('A real file.');
  });
});

describe('renderFoldedDescription', () => {
  test('emits `description: >-` with a 2-space indent', () => {
    const out = renderFoldedDescription('hello world');

    expect(out).toBe('description: >-\n  hello world');
  });

  test('wraps at ~100 columns on word boundaries', () => {
    const text =
      'WHAT: Use the tool to do a thing. WHEN: Whenever the user asks for a thing. ' +
      'DO-NOT: Skip the thing. Do not forget the thing. Do not call it twice.';
    const out = renderFoldedDescription(text, { wrapAt: 60 });
    const lines = out.split('\n');

    expect(lines[0]).toBe('description: >-');

    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i].length).toBeLessThanOrEqual(60);
      expect(lines[i].startsWith('  ')).toBe(true);
    }
  });

  test('places over-wide single words on their own line without splitting', () => {
    const longWord = 'a'.repeat(120);
    const out = renderFoldedDescription(`lead ${longWord} trail`, { wrapAt: 30 });
    const lines = out.split('\n');

    // The long word gets its own line, unbroken.
    expect(lines.some((l) => l.trim() === longWord)).toBe(true);
  });

  test('collapses repeated whitespace in the input', () => {
    const out = renderFoldedDescription('  hello\n\n  world  ');

    expect(out).toBe('description: >-\n  hello world');
  });
});

describe('renderSkillWithDescription', () => {
  test('replaces a single-line description without touching the body or other keys', () => {
    const src = `---
name: foo
description: 'old'
license: MIT
---

# foo

Body line 1
Body line 2
`;
    const parsed = parseSkillMdText('mem', src);
    const out = renderSkillWithDescription(parsed, 'new description value');

    expect(out).toContain('name: foo');
    expect(out).toContain('license: MIT');
    expect(out).toContain('description: >-\n  new description value');
    expect(out).toContain('# foo\n\nBody line 1\nBody line 2\n');
    expect(out).not.toContain("'old'");
  });

  test('replaces a block-scalar description in place', () => {
    const src = `---
name: foo
description: >-
  Original
  value spans
  three lines.
license: MIT
---
body
`;
    const parsed = parseSkillMdText('mem', src);
    const out = renderSkillWithDescription(parsed, 'brand new');

    expect(out).toContain('description: >-\n  brand new\n');
    expect(out).toContain('license: MIT');
    expect(out).not.toContain('Original');
    expect(out).not.toContain('three lines');
  });

  test('round-trips when the replacement is the same as the original', () => {
    const src = `---
name: foo
description: 'same'
---
body
`;
    const parsed = parseSkillMdText('mem', src);
    const out = renderSkillWithDescription(parsed, 'same');
    const reparsed = parseSkillMdText('mem', out);

    expect(reparsed.description).toBe('same');
    expect(reparsed.name).toBe('foo');
    expect(reparsed.body).toBe(parsed.body);
  });
});
