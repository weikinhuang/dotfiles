/**
 * Redaction core for the `secret-redactor` extension. Pure - no pi
 * imports, no disk - so it carries the correctness load under vitest.
 *
 *   - `redactText` scans a string with the active rule set, skips
 *     allowlisted / guarded values, registers each surviving secret in a
 *     `SecretStore`, and substitutes the stable placeholder.
 *   - `rehydrateText` is the inverse used by the tool-call gate: it
 *     replaces `#handle` references (full placeholder or bare) with the
 *     real value, but only for handles a resolver approves.
 */

import {
  BUILTIN_ALLOWLIST,
  type CompiledRule,
  isEnvRef,
  isNetworkLocator,
  isPlaceholderValue,
  KEYWORD_RULES,
  PREFIXED_RULES,
} from './patterns.ts';
import { HANDLE_REF_RE, makePlaceholder, type SecretStore } from './store.ts';

/** Resolved, in-memory config the redactor runs against. */
export interface RedactorConfig {
  layers: { prefixed: boolean; keyword: boolean };
  /** User-supplied rules from config; augment the built-ins. */
  customRules: CompiledRule[];
  /** User allowlist regexes; checked alongside the built-in allowlist. */
  allowlist: RegExp[];
  /** Minimum value length for keyword-style matches. */
  keywordMinLength: number;
}

export const DEFAULT_CONFIG: RedactorConfig = {
  layers: { prefixed: true, keyword: true },
  customRules: [],
  allowlist: [],
  keywordMinLength: 8,
};

/** One redaction applied to a piece of text. */
export interface RedactHit {
  handle: string;
  label: string;
}

interface SpanHit {
  start: number;
  end: number;
  value: string;
  label: string;
  ruleIndex: number;
}

function activeRules(cfg: RedactorConfig): CompiledRule[] {
  const rules: CompiledRule[] = [];
  if (cfg.layers.prefixed) rules.push(...PREFIXED_RULES);
  if (cfg.layers.keyword) rules.push(...KEYWORD_RULES);
  rules.push(...cfg.customRules);
  return rules;
}

function isAllowlisted(value: string, cfg: RedactorConfig): boolean {
  for (const re of BUILTIN_ALLOWLIST) if (re.test(value)) return true;
  for (const re of cfg.allowlist) if (re.test(value)) return true;
  return false;
}

/** Collect every candidate secret span across the active rules. */
function collectSpans(text: string, rules: CompiledRule[], cfg: RedactorConfig): SpanHit[] {
  const spans: SpanHit[] = [];
  rules.forEach((rule, ruleIndex) => {
    for (const m of text.matchAll(rule.re)) {
      let start: number;
      let end: number;
      let value: string;
      if (rule.group === 0) {
        start = m.index;
        end = m.index + m[0].length;
        value = m[0];
      } else {
        const span = m.indices?.[rule.group];
        const captured = m[rule.group];
        if (!span || captured === undefined) continue;
        [start, end] = span;
        value = captured;
      }
      if (!value) continue;
      // Value guards apply to keyword-style rules (a captured value next
      // to a sensitive key); prefixed rules trust their own anchor.
      if (rule.kind === 'keyword') {
        if (value.length < cfg.keywordMinLength) continue;
        if (isEnvRef(value) || isPlaceholderValue(value) || isNetworkLocator(value)) continue;
      }
      if (isAllowlisted(value, cfg)) continue;
      spans.push({ start, end, value, label: rule.id, ruleIndex });
    }
  });
  return spans;
}

/**
 * Redact every detected secret in `text`, registering each in `store`
 * and replacing it with a stable placeholder. Returns the rewritten text
 * and the hits applied. Deterministic, so callers can memoize on `text`.
 */
export function redactText(
  text: string,
  store: SecretStore,
  cfg: RedactorConfig = DEFAULT_CONFIG,
): {
  text: string;
  hits: RedactHit[];
} {
  if (!text) return { text, hits: [] };

  // Resolve overlaps: earliest start wins; on a tie, the longer span,
  // then the earlier rule. Then drop any span that overlaps an
  // already-accepted one.
  const spans = collectSpans(text, activeRules(cfg), cfg).sort(
    (a, b) => a.start - b.start || b.end - a.end || a.ruleIndex - b.ruleIndex,
  );
  const accepted: SpanHit[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      accepted.push(s);
      lastEnd = s.end;
    }
  }
  if (accepted.length === 0) return { text, hits: [] };

  // Apply right-to-left so earlier indices stay valid. A handle the user
  // has approved (via reveal_secret / /unredact) is left as plaintext -
  // otherwise the next context pass would re-redact a value we were
  // explicitly told to reveal.
  const hits: RedactHit[] = [];
  let out = text;
  for (let i = accepted.length - 1; i >= 0; i--) {
    const s = accepted[i];
    const entry = store.register(s.value, s.label);
    if (store.isApproved(entry.handle)) continue;
    out = out.slice(0, s.start) + makePlaceholder(entry.label, entry.handle) + out.slice(s.end);
    hits.push({ handle: entry.handle, label: entry.label });
  }
  hits.reverse(); // report in left-to-right order
  return { text: out, hits };
}

/**
 * Replace `#handle` references (full placeholder or bare) in `text` with
 * the real value, but only where `resolve(handle)` returns one. Used by
 * the tool-call gate to rehydrate approved handles into a command just
 * before execution. Returns the rewritten text and the handles used.
 */
export function rehydrateText(
  text: string,
  resolve: (handle: string) => string | undefined,
): { text: string; used: string[] } {
  const used = new Set<string>();
  const out = text.replace(HANDLE_REF_RE, (whole, g1: string | undefined, g2: string | undefined) => {
    const handle = g1 ?? g2;
    if (!handle) return whole;
    const value = resolve(handle);
    if (value === undefined) return whole;
    used.add(handle);
    return value;
  });
  return { text: out, used: [...used] };
}
