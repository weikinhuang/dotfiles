/**
 * Small env-var coercion helpers shared across pi extensions.
 *
 * The same shape — "read a string from `process.env`, coerce to an
 * integer, fall back to a default when missing or malformed" — lived
 * inline in seven extensions (`edit-recovery`, `loop-breaker`,
 * `read-reread-detector`, `read-without-limit-nudge`, `stream-watchdog`,
 * `tool-arg-recovery`, `llama-thinking-budget`). Each copy applied
 * subtly different finite-check rules; consolidating here lets one
 * change in coercion policy land everywhere.
 *
 * Pure module - no pi imports - so it's directly unit-testable.
 */

/**
 * Parse `raw` as a positive integer, returning `fallback` when `raw`
 * is missing, blank, non-numeric, non-finite, or `<= 0`. Non-integer
 * strings (`"1.5"`, `"1e3"`) are accepted by `parseInt` per the same
 * semantic the per-extension copies used.
 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse `raw` as a non-negative integer, returning `fallback` when
 * `raw` is missing, blank, non-numeric, non-finite, or `< 0`. The
 * zero-allowed sibling of {@link parsePositiveInt}; used by
 * `stream-watchdog` for retry counts.
 */
export function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Loose-input variant of {@link parsePositiveInt}: accepts `unknown`
 * (number or string), returns `undefined` instead of a fallback when
 * the value is missing or invalid. Used where the caller wants to
 * distinguish "user did not set this" from "user set this to zero" -
 * e.g. `llama-thinking-budget` reads from a JSON config layer plus
 * `process.env` and needs to leave the slot untouched when nothing
 * was provided.
 */
export function parseOptionalPositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Truthy-string check for the dotenv-style `1`/`true`/`yes`/`on`
 * convention (case-insensitive). Empty / unset values are not truthy.
 * Anything else returns false. Matches the convention documented in
 * `README.md`'s configuration table.
 */
export function envTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Parse `raw` as a positive integer and clamp it to `>= min`. Falls back
 * to `fallback` when `raw` is missing / non-numeric / below `min`.
 * `min` defaults to `1` (matches `parsePositiveInt` semantics). Used by
 * `tool-output-condenser` where each tunable has a sane lower bound the
 * user shouldn't be able to undershoot.
 */
export function parseClampedPositiveInt(raw: string | undefined, fallback: number, min = 1): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Parse `raw` as a percentage in `[0, 100]`. Accepts decimals (e.g.
 * `"72.5"`) via `parseFloat`. Returns `fallback` when `raw` is missing,
 * non-finite, or outside the range. Pass `fallback = null` to express
 * "unset means feature disabled" without picking a sentinel number -
 * `context-budget` uses this for the auto-compaction threshold.
 */
export function parsePercent(raw: string | undefined, fallback: number): number;
export function parsePercent(raw: string | undefined, fallback: null): number | null;
export function parsePercent(raw: string | undefined, fallback: number | null): number | null {
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || n > 100) return fallback;
  return n;
}
