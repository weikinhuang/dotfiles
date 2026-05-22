/**
 * Tool-name matcher for the hook config. Five forms, in this order of
 * resolution:
 *
 *   - undefined / empty / "*"   → matches every tool name
 *   - "re:<regex>"              → JS regex (no flags). Bad regex never matches.
 *   - "a,b,c"                   → comma-separated list; any token matches
 *   - "<name>"                  → exact match
 *
 * Whitespace around tokens / regex bodies is trimmed. Tool names
 * themselves are compared exactly (no case folding), matching Claude
 * Code's matcher semantics.
 *
 * Patterned after `bash-match.ts`'s `matchesPattern`: small, pure,
 * vitest-friendly. The bash matcher additionally supports prefix
 * matches because shell commands are multi-word; tool names are
 * single tokens so we drop that form here.
 */

const warnedBadPatterns = new Set<string>();

function tryCompileMatcherRegex(pattern: string): RegExp | null | false {
  if (!pattern.startsWith('re:')) return null;
  try {
    return new RegExp(pattern.slice(3));
  } catch (e) {
    if (!warnedBadPatterns.has(pattern)) {
      warnedBadPatterns.add(pattern);
      console.warn(`[hooks] invalid regex matcher ${JSON.stringify(pattern)}: ${String(e)}`);
    }
    return false;
  }
}

/**
 * Returns true when `toolName` is selected by `matcher`. See the
 * module docstring for the supported forms.
 *
 * `matcher === undefined` is the "no tool dimension" case (used by
 * `UserPromptSubmit` / `Stop` / `SessionStart` configs) and matches
 * unconditionally.
 */
export function matchesMatcher(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined) return true;
  const m = matcher.trim();
  if (m.length === 0 || m === '*') return true;

  const regex = tryCompileMatcherRegex(m);
  if (regex === false) return false;
  if (regex) return regex.test(toolName);

  if (m.includes(',')) {
    for (const part of m.split(',')) {
      if (part.trim() === toolName) return true;
    }
    return false;
  }

  return m === toolName;
}
