// Frontmatter linter for SKILL.md files.
// SPDX-License-Identifier: MIT
//
// Port of `~/.claude/skills/skill-creator/scripts/quick_validate.py`. Pure
// structural check — no driver is spawned. The rules below mirror the
// Python original so a skill that passes there also passes here.
//
// Rules:
//   - File starts with a `---` frontmatter fence and has a closing `---`.
//   - Allowed top-level keys: {name, description, license, allowed-tools,
//     metadata, compatibility}. Anything else is an error.
//   - `name` is required: kebab-case (`[a-z0-9-]+`), 1–64 chars, no
//     leading/trailing hyphen, no `--`.
//   - `description` is required: ≤1024 chars, no `<` or `>` characters.
//   - `compatibility` (optional): ≤500 chars.
//
// The parser understands a deliberately small YAML subset — enough to
// identify top-level keys and extract scalar string values for `name`,
// `description`, and `compatibility`. Nested content under `metadata:` or
// `allowed-tools:` is accepted without being examined, matching how
// `quick_validate.py` only inspects the keys it cares about.

import { readFileSync } from 'node:fs';

/** Keys permitted at the top level of SKILL.md frontmatter. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
  'compatibility',
]);

/** Symbolic id for each failure mode. Stable enough to assert on in tests. */
export type ValidationRule =
  | 'read-error'
  | 'frontmatter-fence'
  | 'frontmatter-parse'
  | 'duplicate-key'
  | 'unknown-key'
  | 'missing-field'
  | 'name-kebab-case'
  | 'name-hyphen-shape'
  | 'name-too-long'
  | 'description-angle-brackets'
  | 'description-too-long'
  | 'compatibility-too-long';

export interface ValidationSuccess {
  ok: true;
  path: string;
}

export interface ValidationFailure {
  ok: false;
  path: string;
  rule: ValidationRule;
  message: string;
  /** 1-indexed line within the SKILL.md file, when known. */
  line?: number;
  /** Offending value (e.g. the malformed name), when useful. */
  value?: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/** Format a failure as a single-line `path:line: [rule] message` diagnostic. */
export function formatFailure(r: ValidationFailure): string {
  const loc = r.line !== undefined ? `${r.path}:${r.line}` : r.path;
  return `${loc}: [${r.rule}] ${r.message}`;
}

interface Field {
  key: string;
  /** Zero-indexed line within the header (i.e. the frontmatter body between fences). */
  line: number;
  /** Raw text fragments collected from the key line's tail + indented continuations. */
  valueLines: string[];
}

const TOP_KEY_RE = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/;

/**
 * Split a frontmatter header into top-level fields. A "top-level" line
 * starts at column 0 with an ident character; anything indented or
 * list-dash-prefixed is attached to the preceding field as a continuation.
 */
function parseTopLevelFields(lines: readonly string[]): { fields: Field[] } | { error: string; line: number } {
  const fields: Field[] = [];
  let current: Field | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;

    // Top-level key: column 0 starts with a letter.
    if (/^[A-Za-z]/.test(line)) {
      const m = TOP_KEY_RE.exec(line);
      if (!m) {
        return { error: `malformed frontmatter line: ${line}`, line: i };
      }
      if (current) fields.push(current);
      current = { key: m[1] ?? '', line: i, valueLines: [] };
      const tail = m[2] ?? '';
      if (tail.length > 0) current.valueLines.push(tail);
      continue;
    }

    // Indented continuation — attach to the current field.
    if (!current) {
      return { error: `indented content before any key: ${line}`, line: i };
    }
    current.valueLines.push(trimmed);
  }
  if (current) fields.push(current);
  return { fields };
}

/**
 * Collapse a field's continuation lines into a single scalar string. Joins
 * fragments with a single space, strips one layer of surrounding single or
 * double quotes, and reverses the escapes a YAML double-quoted scalar would
 * emit (`\\` and `\"`). Good enough for the name / description /
 * compatibility length + shape checks; block scalars (`|` / `>`) are
 * stringified literally — their length check is conservative.
 */
function joinScalar(field: Field): string {
  const joined = field.valueLines.join(' ').trim();
  if (joined.length >= 2) {
    const first = joined[0];
    const last = joined[joined.length - 1];
    if (first === '"' && last === '"') {
      return joined.slice(1, -1).replace(/\\([\\"])/g, '$1');
    }
    if (first === "'" && last === "'") {
      // YAML single-quoted scalars escape `'` as `''`.
      return joined.slice(1, -1).replace(/''/g, "'");
    }
  }
  return joined;
}

/** Validate a SKILL.md file. Returns the first rule violation, or success. */
export function validateSkillMd(path: string): ValidationResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path, rule: 'read-error', message: `cannot read ${path}: ${msg}` };
  }

  const src = raw.replace(/\r\n/g, '\n');
  const lines = src.split('\n');

  if (lines[0] !== '---') {
    return {
      ok: false,
      path,
      rule: 'frontmatter-fence',
      message: 'no YAML frontmatter found (file must start with `---`)',
      line: 1,
    };
  }

  let closeLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      closeLine = i;
      break;
    }
  }
  if (closeLine === -1) {
    return {
      ok: false,
      path,
      rule: 'frontmatter-fence',
      message: 'missing closing `---` frontmatter fence',
      line: 1,
    };
  }

  const headerLines = lines.slice(1, closeLine);
  const parsed = parseTopLevelFields(headerLines);
  if ('error' in parsed) {
    return {
      ok: false,
      path,
      rule: 'frontmatter-parse',
      message: parsed.error,
      // headerLines[0] corresponds to SKILL.md line 2, so offset by 2.
      line: parsed.line + 2,
    };
  }

  // Duplicate-key detection before whitelist to point at the second
  // occurrence's line.
  const seen = new Set<string>();
  for (const f of parsed.fields) {
    if (seen.has(f.key)) {
      return {
        ok: false,
        path,
        rule: 'duplicate-key',
        message: `duplicate frontmatter key '${f.key}'`,
        line: f.line + 2,
      };
    }
    seen.add(f.key);
  }

  // Whitelist check.
  for (const f of parsed.fields) {
    if (!ALLOWED_KEYS.has(f.key)) {
      const allowed = [...ALLOWED_KEYS].sort().join(', ');
      return {
        ok: false,
        path,
        rule: 'unknown-key',
        message: `unexpected frontmatter key '${f.key}' (allowed: ${allowed})`,
        line: f.line + 2,
      };
    }
  }

  const byKey = new Map<string, Field>();
  for (const f of parsed.fields) byKey.set(f.key, f);

  // Required fields. `quick_validate.py` fails when either key is absent
  // from the frontmatter.
  if (!byKey.has('name')) {
    return { ok: false, path, rule: 'missing-field', message: "missing required field 'name'" };
  }
  if (!byKey.has('description')) {
    return { ok: false, path, rule: 'missing-field', message: "missing required field 'description'" };
  }

  // name: kebab-case, ≤64 chars. The Python original only checks shape when
  // the stripped value is non-empty; mirror that so an explicitly empty
  // `name:` passes silently (same as upstream).
  const nameField = byKey.get('name')!;
  const name = joinScalar(nameField);
  if (name.length > 0) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        ok: false,
        path,
        rule: 'name-kebab-case',
        message: `name '${name}' must be kebab-case (lowercase letters, digits, and hyphens only)`,
        line: nameField.line + 2,
        value: name,
      };
    }
    if (name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
      return {
        ok: false,
        path,
        rule: 'name-hyphen-shape',
        message: `name '${name}' cannot start/end with hyphen or contain consecutive hyphens`,
        line: nameField.line + 2,
        value: name,
      };
    }
    if (name.length > 64) {
      return {
        ok: false,
        path,
        rule: 'name-too-long',
        message: `name is ${name.length} characters (max 64)`,
        line: nameField.line + 2,
        value: name,
      };
    }
  }

  // description: ≤1024 chars, no `<` or `>`. Same "only when non-empty"
  // guard as upstream.
  const descField = byKey.get('description')!;
  const description = joinScalar(descField);
  if (description.length > 0) {
    if (description.includes('<') || description.includes('>')) {
      return {
        ok: false,
        path,
        rule: 'description-angle-brackets',
        message: 'description cannot contain angle brackets (< or >)',
        line: descField.line + 2,
      };
    }
    if (description.length > 1024) {
      return {
        ok: false,
        path,
        rule: 'description-too-long',
        message: `description is ${description.length} characters (max 1024)`,
        line: descField.line + 2,
      };
    }
  }

  // compatibility: ≤500 chars (optional).
  const compatField = byKey.get('compatibility');
  if (compatField) {
    const compatibility = joinScalar(compatField);
    if (compatibility.length > 500) {
      return {
        ok: false,
        path,
        rule: 'compatibility-too-long',
        message: `compatibility is ${compatibility.length} characters (max 500)`,
        line: compatField.line + 2,
      };
    }
  }

  return { ok: true, path };
}
