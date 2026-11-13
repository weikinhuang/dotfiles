/**
 * Text-level rewriting helpers for generated content inside hand-written
 * files. Both helpers edit only the owned span and leave every other
 * byte (comments, key order, formatting) untouched, so the result stays
 * `oxfmt`-clean as long as the inserted text is.
 */

import { LINE_WIDTH } from './shell-emitters.ts';

// ---------------------------------------------------------------------------
// Marker-delimited regions
// ---------------------------------------------------------------------------

export function beginMarker(name: string): string {
  return `BEGIN GENERATED ${name}`;
}

export function endMarker(name: string): string {
  return `END GENERATED ${name}`;
}

function markerLineIndex(lines: string[], marker: string, file: string): number {
  // A marker line contains the marker text followed by end of line, ':' or
  // whitespace (e.g. `// BEGIN GENERATED x: edit ...`), so `x` never matches `x-y`.
  const escaped = marker.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}(:|\\s|$)`);
  const hits = lines.flatMap((line, i) => (re.test(line) ? [i] : []));
  if (hits.length !== 1) {
    throw new Error(`${file}: expected exactly one "${marker}" line, found ${hits.length}`);
  }
  return hits[0];
}

/**
 * Replace the lines strictly between the `BEGIN GENERATED <name>` and
 * `END GENERATED <name>` marker lines with `body`. The marker lines
 * themselves are hand-written (in whatever comment syntax the file uses)
 * and kept as-is.
 */
export function replaceMarkedRegion(text: string, name: string, body: string[], file = '<text>'): string {
  const lines = text.split('\n');
  const begin = markerLineIndex(lines, beginMarker(name), file);
  const end = markerLineIndex(lines, endMarker(name), file);
  if (end <= begin) throw new Error(`${file}: "${endMarker(name)}" must come after "${beginMarker(name)}"`);
  return [...lines.slice(0, begin + 1), ...body, ...lines.slice(end)].join('\n');
}

// ---------------------------------------------------------------------------
// JSON array properties
// ---------------------------------------------------------------------------

interface MemberSpan {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

function skipWs(text: string, i: number): number {
  let j = i;
  while (j < text.length && /\s/.test(text[j])) j++;
  return j;
}

function scanString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  if (j >= text.length) throw new Error(`unterminated string at offset ${i}`);
  return j + 1;
}

function scanValue(text: string, i: number): number {
  const open = text[i];
  if (open === '"') return scanString(text, i);
  if (open !== '{' && open !== '[') {
    let j = i;
    while (j < text.length && !/[\s,\]}]/.test(text[j])) j++;
    return j;
  }
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '"') {
      j = scanString(text, j);
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    j++;
    if (depth === 0) return j;
  }
  throw new Error(`unterminated ${open} at offset ${i}`);
}

function objectMembers(text: string, start: number): MemberSpan[] {
  if (text[start] !== '{') throw new Error(`expected an object at offset ${start}`);
  const members: MemberSpan[] = [];
  let i = skipWs(text, start + 1);
  while (text[i] !== '}') {
    if (text[i] !== '"') throw new Error(`expected a key at offset ${i}`);
    const keyEnd = scanString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    const colon = skipWs(text, keyEnd);
    if (text[colon] !== ':') throw new Error(`expected ':' at offset ${colon}`);
    const valueStart = skipWs(text, colon + 1);
    const valueEnd = scanValue(text, valueStart);
    members.push({ key, keyStart: i, valueStart, valueEnd });
    i = skipWs(text, valueEnd);
    if (text[i] === ',') i = skipWs(text, i + 1);
  }
  return members;
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/**
 * Render a string array the way oxfmt / prettier prints it in JSON: on
 * one line when `<indent>"key": [...]` (plus a trailing comma when more
 * members follow) fits in {@link LINE_WIDTH}, otherwise one item per line.
 */
export function renderJsonStringArray(key: string, values: string[], indent: string, trailingComma: boolean): string {
  const items = values.map((v) => JSON.stringify(v));
  const inline = `[${items.join(', ')}]`;
  const head = `${indent}${JSON.stringify(key)}: `;
  if (head.length + inline.length + (trailingComma ? 1 : 0) <= LINE_WIDTH) return inline;
  const inner = `${indent}  `;
  return `[\n${items.map((item) => inner + item).join(',\n')}\n${indent}]`;
}

/**
 * Set string-array properties of the object at `path` (a chain of object
 * keys from the root) in a JSON document, editing only those values.
 * A key that does not exist yet is inserted right after `insertAfter`
 * (which must exist); a missing key whose new value is empty is not
 * inserted. Everything else in the document is preserved byte for byte.
 */
export function setJsonStringArrays(
  text: string,
  path: string[],
  values: Record<string, string[]>,
  insertAfter: string,
): string {
  let start = skipWs(text, 0);
  for (const segment of path) {
    const member = objectMembers(text, start).find((m) => m.key === segment);
    if (!member) throw new Error(`missing object "${path.join('.')}"`);
    start = member.valueStart;
  }
  const members = objectMembers(text, start);
  const anchor = members.find((m) => m.key === insertAfter);
  if (!anchor) throw new Error(`missing "${[...path, insertAfter].join('.')}"`);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const [key, list] of Object.entries(values)) {
    const index = members.findIndex((m) => m.key === key);
    if (index >= 0) {
      const member = members[index];
      const indent = lineIndentAt(text, member.keyStart);
      const rendered = renderJsonStringArray(key, list, indent, index < members.length - 1);
      edits.push({ start: member.valueStart, end: member.valueEnd, text: rendered });
    } else if (list.length > 0) {
      const indent = lineIndentAt(text, anchor.keyStart);
      const anchorIsLast = members.at(-1) === anchor;
      const rendered = renderJsonStringArray(key, list, indent, !anchorIsLast);
      edits.push({
        start: anchor.valueEnd,
        end: anchor.valueEnd,
        text: `,\n${indent}${JSON.stringify(key)}: ${rendered}`,
      });
    }
  }
  // Apply from the end so earlier offsets stay valid. An insertion after the
  // anchor sorts after an edit of the anchor value itself (same end offset).
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}
