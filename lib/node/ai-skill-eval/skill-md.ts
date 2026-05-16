// SKILL.md frontmatter read + render helpers (R4).
//
// The optimizer needs to:
//
//   - read the current description out of a SKILL.md so it can seed the
//     improve loop,
//   - render a *modified* SKILL.md body (same file, different description)
//     to feed to the driver as each iteration's skill context, and
//   - (commit 2) rewrite the description in place with a `--write` flag.
//
// Validate.ts has its own lightweight frontmatter parser that only needs the
// scalar values. We deliberately keep this module separate: it also tracks
// the *line span* each key occupies so we can patch the description back
// without disturbing surrounding keys, comments, or the SKILL.md body.
//
// SPDX-License-Identifier: MIT

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import { joinFrontmatterScalar } from './frontmatter.ts';

/** Thrown when a file doesn't have a usable YAML frontmatter block. */
export class SkillMdParseError extends Error {}

/**
 * Parsed shape of a SKILL.md file. Line numbers are zero-indexed against
 * the raw file split on `\n`. `descriptionEndLine` is inclusive.
 */
export interface ParsedSkillMd {
  path: string;
  /** Full file contents (with `\r\n` normalised to `\n`). */
  raw: string;
  name: string;
  description: string;
  /** Body text AFTER the closing `---` fence (everything from the next line onward, joined with `\n`). */
  body: string;
  /** Line index of the opening `---`. Always 0 for valid files. */
  frontmatterOpenLine: number;
  /** Line index of the closing `---`. */
  frontmatterCloseLine: number;
  /** First line the description key occupies (the `description:` line itself). */
  descriptionStartLine: number;
  /** Last line the description key occupies (inclusive). */
  descriptionEndLine: number;
}

interface FrontmatterField {
  key: string;
  /** Zero-indexed line of the `key:` line. */
  start: number;
  /** Zero-indexed line of the last continuation line (inclusive). */
  end: number;
  /** Raw value fragments: the tail after `key:` plus each continuation line (trimmed). */
  valueFragments: string[];
}

const TOP_KEY_RE = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/;

/**
 * Walk the frontmatter header, grouping lines into top-level fields. A
 * "top-level" line is column-0, starts with a letter, and matches `key:`.
 * Anything else (indent, blank, `#`, list dash) is treated as a
 * continuation of the current field - blank lines inside a block scalar
 * get preserved in the field's span but their content is not appended to
 * `valueFragments`.
 */
function parseFrontmatterFields(lines: readonly string[], closeLine: number, path: string): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  let cur: FrontmatterField | null = null;
  const flush = (): void => {
    if (!cur) return;
    // Trim trailing blank lines off the field span so they don't get
    // swallowed when a caller later replaces the field in place.
    while (cur.end > cur.start && (lines[cur.end] ?? '').trim() === '') {
      cur.end -= 1;
    }
    fields.push(cur);
  };

  for (let i = 1; i < closeLine; i += 1) {
    const line = lines[i] ?? '';
    const topKeyMatch = /^[A-Za-z]/.test(line) ? TOP_KEY_RE.exec(line) : null;
    if (topKeyMatch) {
      flush();
      cur = { key: topKeyMatch[1] ?? '', start: i, end: i, valueFragments: [] };
      const tail = (topKeyMatch[2] ?? '').trim();
      if (tail) cur.valueFragments.push(tail);
      continue;
    }
    if (!cur) {
      // Leading blank / comment before any key: skip.
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      throw new SkillMdParseError(`${path}:${i + 1}: indented content before any frontmatter key`);
    }
    cur.end = i;
    const trimmed = line.trim();
    if (trimmed) cur.valueFragments.push(trimmed);
  }
  flush();
  return fields;
}

/**
 * Collapse a field's raw value fragments into a single scalar string.
 * Delegates to the shared {@link joinFrontmatterScalar} so this module
 * and `validate.ts` agree on YAML block-scalar + quoting semantics.
 */
function joinScalar(fragments: readonly string[]): string {
  return joinFrontmatterScalar(fragments);
}

/** Same as {@link parseSkillMd} but takes the raw text instead of a path. Exposed for tests + `rewriteDescription`. */
export function parseSkillMdText(path: string, raw: string): ParsedSkillMd {
  const src = raw.replace(/\r\n/g, '\n');
  const lines = src.split('\n');

  if (lines[0] !== '---') {
    throw new SkillMdParseError(`${path}: no YAML frontmatter (file must start with \`---\`)`);
  }
  let closeLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      closeLine = i;
      break;
    }
  }
  if (closeLine < 0) {
    throw new SkillMdParseError(`${path}: missing closing \`---\` frontmatter fence`);
  }

  const fields = parseFrontmatterFields(lines, closeLine, path);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const nameField = byKey.get('name');
  const descField = byKey.get('description');
  if (!nameField) throw new SkillMdParseError(`${path}: missing required frontmatter field 'name'`);
  if (!descField) throw new SkillMdParseError(`${path}: missing required frontmatter field 'description'`);

  return {
    path,
    raw: src,
    name: joinScalar(nameField.valueFragments),
    description: joinScalar(descField.valueFragments),
    body: lines.slice(closeLine + 1).join('\n'),
    frontmatterOpenLine: 0,
    frontmatterCloseLine: closeLine,
    descriptionStartLine: descField.start,
    descriptionEndLine: descField.end,
  };
}

/** Parse a SKILL.md from disk. Throws {@link SkillMdParseError} on any structural problem. */
export function parseSkillMd(path: string): ParsedSkillMd {
  return parseSkillMdText(path, readFileSync(path, 'utf8'));
}

/**
 * Render a description value as a YAML folded block scalar (`>-`). The
 * folded style converts single line breaks to spaces at parse time, so we
 * can word-wrap the text for readability without changing the semantic
 * value. `-` strips trailing newlines so the scalar doesn't end with an
 * extra `\n` after folding.
 *
 *   description: >-
 *     WHAT: ... WHEN: ... DO-NOT: ...
 *
 * Wrapping target is 100 columns (including the leading indent), matching
 * the width oxfmt / prettier use for long prose. Words that exceed the
 * wrap width on their own get placed on their own line rather than being
 * broken mid-token.
 */
export function renderFoldedDescription(
  description: string,
  options: { indent?: number; wrapAt?: number } = {},
): string {
  const indent = options.indent ?? 2;
  const wrapAt = options.wrapAt ?? 100;
  const pad = ' '.repeat(indent);
  const words = description
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const out: string[] = ['description: >-'];
  if (words.length === 0) {
    out.push(pad);
    return out.join('\n');
  }
  let cur = pad + words[0];
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (cur.length + 1 + w.length <= wrapAt) {
      cur += ` ${w}`;
    } else {
      out.push(cur);
      cur = pad + w;
    }
  }
  out.push(cur);
  return out.join('\n');
}

/**
 * Produce the full SKILL.md text with the description replaced. Every other
 * line (frontmatter keys, body, trailing newline) is preserved verbatim;
 * the original `description:` span is swapped for a freshly-rendered folded
 * block scalar.
 */
export function renderSkillWithDescription(parsed: ParsedSkillMd, description: string): string {
  const lines = parsed.raw.split('\n');
  const before = lines.slice(0, parsed.descriptionStartLine);
  const after = lines.slice(parsed.descriptionEndLine + 1);
  const replacement = renderFoldedDescription(description).split('\n');
  return [...before, ...replacement, ...after].join('\n');
}

export interface RewriteResult {
  /** Previous description (verbatim, unescaped scalar value). */
  previous: string;
  /** New file contents that were written to `path`. */
  written: string;
}

/**
 * Rewrite a SKILL.md in place, replacing only the `description:` frontmatter
 * value with a folded block scalar carrying `newDescription`. Preserves
 * every other byte of the file.
 *
 * Returns the previous description alongside the new file contents so
 * callers can snapshot history and print diffs without re-parsing.
 * Writes atomically (tmpfile + rename) so an interrupted rewrite can't
 * leave a half-formed SKILL.md behind.
 */
export function rewriteDescription(path: string, newDescription: string): RewriteResult {
  const parsed = parseSkillMd(path);
  const written = renderSkillWithDescription(parsed, newDescription);
  const tmp = `${path}.ai-skill-eval.tmp`;
  writeFileSync(tmp, written);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  return { previous: parsed.description, written };
}

/**
 * Produce a compact unified diff describing the description swap. Only the
 * description field is shown (bookended by `--- description (before)` /
 * `+++ description (after)` headers), since the rest of the file is
 * identical. Useful for stdout-ing before committing a `--write`.
 */
export function renderDescriptionDiff(previous: string, next: string): string {
  if (previous === next) return 'description: (unchanged)\n';
  const out: string[] = ['--- description (before)', '+++ description (after)'];
  const prevLines = previous.split('\n');
  const nextLines = next.split('\n');
  for (const line of prevLines) out.push(`- ${line}`);
  for (const line of nextLines) out.push(`+ ${line}`);
  out.push('');
  return out.join('\n');
}
