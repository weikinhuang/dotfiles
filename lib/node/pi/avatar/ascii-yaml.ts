/**
 * Minimal YAML parser for the `avatar` extension's `ascii.yaml` emote
 * frames. Handles exactly the three shapes those files use: top-level
 * scalars, one-level maps of scalars, and arrays of scalars. No general
 * YAML support and no dependency - pure and unit-testable.
 */

/** A parsed state entry: a single frame, an ordered list, or named frames. */
export type AsciiFrameValue = string | string[] | Record<string, string>;
export type AsciiFrameMap = Record<string, AsciiFrameValue>;

/** Strip a trailing CR and surrounding single/double quotes from a scalar. */
function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

/**
 * Parse `text` into a flat map of state -> frame value. Indentation
 * decides nesting: a `- item` line under a key builds an array, a
 * `key: value` line under a key builds a named-frame map, and an inline
 * `key: value` is a scalar.
 */
export function parseSimpleYaml(text: string): AsciiFrameMap {
  const result: AsciiFrameMap = {};
  let currentKey: string | null = null;
  let currentObj: Record<string, string> | null = null;
  let currentArr: string[] | null = null;

  const flush = (): void => {
    if (currentKey === null) return;
    if (currentArr) result[currentKey] = currentArr;
    else if (currentObj) result[currentKey] = currentObj;
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;

    const topMatch = /^(\w[\w-]*):\s*(.*)/.exec(line);
    if (topMatch) {
      flush();
      currentKey = topMatch[1];
      currentArr = null;
      currentObj = null;
      const value = unquote(topMatch[2]);
      if (value.length > 0) {
        result[currentKey] = value;
        currentKey = null;
      }
      continue;
    }

    if (currentKey === null) continue;

    const arrMatch = /^\s+-\s+(.+)/.exec(line);
    if (arrMatch) {
      currentArr ??= [];
      currentArr.push(unquote(arrMatch[1]));
      continue;
    }

    const nestedMatch = /^\s+(\w[\w-]*):\s+(.+)/.exec(line);
    if (nestedMatch) {
      currentObj ??= {};
      currentObj[nestedMatch[1]] = unquote(nestedMatch[2]);
      continue;
    }
  }

  flush();
  return result;
}
