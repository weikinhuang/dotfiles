/**
 * Detection corpus for the `secret-redactor` extension. Pure data + small
 * predicates - no pi imports, unit-testable under vitest.
 *
 * Two rule families:
 *
 *   - PREFIXED (Layer A): provider tokens with a fixed prefix / structure.
 *     The whole match IS the secret (`group: 0`). Near-zero false positive
 *     because the prefix anchors them.
 *   - KEYWORD (Layer B): `<sensitive-key> <sep> <value>`. Only the VALUE
 *     capture group is the secret (`group: 1`), so the key stays readable.
 *     Higher recall, so it's paired with the value guards below
 *     (`isEnvRef` / `isPlaceholderValue` / a length floor) to keep the
 *     precision bias.
 *
 * All regexes carry the `g` and `d` flags: `g` so `matchAll` works, `d`
 * so the redactor can read the capture group's byte span (`.indices`).
 *
 * Layer C (entropy) is intentionally absent from this corpus - it ships
 * disabled and is documented as reserved in secret-redactor.md.
 */

export type RuleKind = 'prefixed' | 'keyword';

export interface CompiledRule {
  /** Stable id, used as the placeholder label (e.g. `github-token`). */
  id: string;
  /** Global (`g`) + indices (`d`) regex. */
  re: RegExp;
  /** Capture group holding the secret; `0` = whole match. */
  group: number;
  kind: RuleKind;
}

/** Layer A - prefixed provider tokens. The whole match is the secret. */
export const PREFIXED_RULES: readonly CompiledRule[] = [
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/dg, group: 0, kind: 'prefixed' },
  // openai excludes the anthropic prefix so `sk-ant-…` is labelled correctly.
  { id: 'openai-key', re: /\bsk-(?:proj-)?(?!ant-)[A-Za-z0-9_-]{20,}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'pypi-token', re: /\bpypi-[A-Za-z0-9_-]{16,}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{34}\b/dg, group: 0, kind: 'prefixed' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/dg, group: 0, kind: 'prefixed' },
  {
    id: 'private-key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/dg,
    group: 0,
    kind: 'prefixed',
  },
];

/** Layer B - keyword=value. Only group 1 (the value) is the secret. */
export const KEYWORD_RULES: readonly CompiledRule[] = [
  {
    id: 'assigned-secret',
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credentials?)\b\s*[:=]\s*["']?([^\s"']{8,})["']?/dgi,
    group: 1,
    kind: 'keyword',
  },
  {
    id: 'authorization-header',
    re: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/dgi,
    group: 1,
    kind: 'keyword',
  },
  {
    // scheme://user:PASSWORD@host - redact only the password segment.
    id: 'connection-string',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s:@/]{4,})@/dgi,
    group: 1,
    kind: 'keyword',
  },
];

/**
 * Built-in allowlist: high-entropy shapes that are routinely NOT secrets.
 * Tested against the matched value with a full-string anchor so a longer
 * string that merely contains a SHA isn't exempted wholesale.
 */
export const BUILTIN_ALLOWLIST: readonly RegExp[] = [
  /^[0-9a-f]{40}$/i, // git sha-1
  /^[0-9a-f]{64}$/i, // git sha-256
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // iso-8601 timestamp
  /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/, // lockfile integrity hash
];

/**
 * Value looks like an environment-variable reference, not a literal
 * secret - `$X`, `${X}`, `process.env.X`, `os.environ[...]`. Redacting
 * these would be a pure false positive (the secret isn't here).
 */
export function isEnvRef(value: string): boolean {
  const v = value.trim();
  if (v.startsWith('$')) return true;
  if (v.startsWith('process.env.')) return true;
  if (v.startsWith('os.environ')) return true;
  return false;
}

/**
 * Value is an obvious placeholder / example, not a real secret -
 * `<your-key>`, `xxxx`, `changeme`, `REDACTED`, all-one-char, `...`.
 */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (/^<.*>$/.test(v)) return true;
  if (v.includes('...') || v.includes('…')) return true;
  if (/REDACTED/i.test(v)) return true;
  if (/^(?:changeme|example|examples?|dummy|sample|placeholder|none|null|true|false|your[-_].*)$/i.test(v)) return true;
  if (/^(.)\1+$/.test(v)) return true; // all the same char (xxxx, 0000)
  return false;
}
