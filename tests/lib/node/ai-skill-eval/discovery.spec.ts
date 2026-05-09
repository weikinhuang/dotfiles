// Tests for lib/node/ai-skill-eval/discovery.ts.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  countEvals,
  DEFAULT_SCAN_ROOTS,
  discoverSkills,
  findSkillMdFiles,
  loadEvalsFile,
  resolveScanRoots,
} from '../../../../lib/node/ai-skill-eval/discovery.ts';

function makeSkill(root: string, name: string, withEvals = true): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
  if (withEvals) {
    mkdirSync(join(dir, 'evals'), { recursive: true });
    writeFileSync(
      join(dir, 'evals', 'evals.json'),
      JSON.stringify(
        {
          skill_name: name,
          evals: [
            { id: 'positive-1', should_trigger: true, prompt: 'p', expectations: ['e'] },
            { id: 'negative-1', should_trigger: false, prompt: 'p2', expectations: ['e2'] },
          ],
        },
        null,
        2,
      ),
    );
  }
  return dir;
}

describe('discovery', () => {
  let cwd: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'ai-skill-eval-discovery-'));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  describe('findSkillMdFiles', () => {
    test('returns empty array for a missing root', () => {
      expect(findSkillMdFiles('does-not-exist')).toEqual([]);
    });

    test('collects SKILL.md across nested directories in sorted order', () => {
      makeSkill('.agents/skills', 'beta', false);
      makeSkill('.agents/skills', 'alpha', false);
      const paths = findSkillMdFiles('.agents/skills');

      expect(paths.map((p) => p.replace(/\\/g, '/'))).toEqual([
        '.agents/skills/alpha/SKILL.md',
        '.agents/skills/beta/SKILL.md',
      ]);
    });

    test('returns an empty array when the root is a symlink (matches bash `find` semantics)', () => {
      makeSkill('real-root', 'alpha', false);
      symlinkSync('real-root', 'linked-root');

      expect(findSkillMdFiles('linked-root')).toEqual([]);
    });

    test('ignores files other than SKILL.md', () => {
      makeSkill('.agents/skills', 'one', false);
      writeFileSync('.agents/skills/one/README.md', 'readme');

      expect(findSkillMdFiles('.agents/skills').length).toBe(1);
    });
  });

  describe('discoverSkills', () => {
    test('populates evalsJson when the sibling evals/evals.json exists', () => {
      makeSkill('.agents/skills', 'has-evals', true);
      makeSkill('.agents/skills', 'no-evals', false);
      const skills = discoverSkills(['.agents/skills']);

      expect(skills.find((s) => s.name === 'has-evals')?.evalsJson).toContain('evals.json');
      expect(skills.find((s) => s.name === 'no-evals')?.evalsJson).toBeNull();
    });

    test('deduplicates when the same SKILL.md is reachable through two roots', () => {
      makeSkill('.agents/skills', 'sample', true);
      const skills = discoverSkills(['.agents/skills', '.agents/skills']);

      expect(skills).toHaveLength(1);
    });

    test('empty roots list yields an empty array', () => {
      expect(discoverSkills([])).toEqual([]);
    });
  });

  describe('resolveScanRoots', () => {
    test('returns the caller list unchanged when provided', () => {
      expect(resolveScanRoots(['custom-root'])).toEqual(['custom-root']);
    });

    test('filters DEFAULT_SCAN_ROOTS to those that exist', () => {
      makeSkill('.agents/skills', 'a', false);
      const resolved = resolveScanRoots([]);

      expect(resolved).toContain('.agents/skills');
      expect(resolved).not.toContain('config/pi/skills');
    });

    test('returns an empty array when no default root exists', () => {
      expect(resolveScanRoots([])).toEqual([]);
    });

    test('DEFAULT_SCAN_ROOTS covers the documented four tiers', () => {
      expect(DEFAULT_SCAN_ROOTS).toEqual([
        '.agents/skills',
        'config/agents/skills',
        'config/pi/skills',
        '.claude/skills',
      ]);
    });
  });

  describe('loadEvalsFile + countEvals', () => {
    test('loadEvalsFile returns evals array', () => {
      const dir = makeSkill('.agents/skills', 'sample', true);
      const path = join(dir, 'evals', 'evals.json');

      expect(loadEvalsFile(path).evals).toHaveLength(2);
    });

    test('loadEvalsFile preserves file-level `runs_per_query` so prompt.resolveRunsPerQuery can see it', () => {
      const dir = join(cwd, '.agents/skills/rpq-file');
      mkdirSync(join(dir, 'evals'), { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: rpq-file\n---\n');
      writeFileSync(
        join(dir, 'evals', 'evals.json'),
        JSON.stringify({
          skill_name: 'rpq-file',
          runs_per_query: 7,
          evals: [{ id: 'x', should_trigger: true, prompt: 'p', expectations: [] }],
        }),
      );

      const file = loadEvalsFile(join(dir, 'evals', 'evals.json'));

      expect(file.runs_per_query).toBe(7);
    });

    test('loadEvalsFile omits runs_per_query when the source file does not set it', () => {
      const dir = makeSkill('.agents/skills', 'no-rpq', true);
      const path = join(dir, 'evals', 'evals.json');

      expect(loadEvalsFile(path).runs_per_query).toBeUndefined();
    });

    test('countEvals returns 0 when the file is missing or malformed', () => {
      expect(countEvals('/tmp/does-not-exist.json')).toBe(0);

      const bad = join(cwd, 'bad.json');
      writeFileSync(bad, 'not json');

      expect(countEvals(bad)).toBe(0);
    });
  });
});
