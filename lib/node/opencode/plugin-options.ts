/**
 * Layered option resolution for opencode plugins under
 * `config/opencode/plugins/`.
 *
 * opencode passes `{ package, options }` entries from `opencode.json(c)` to
 * the server part as `ctx.options` (an untyped JSON bag). Each knob may also
 * be overridden by an environment variable named after the option:
 * `<PREFIX><SCREAMING_SNAKE_KEY>`, e.g. option `minSeconds` with prefix
 * `OPENCODE_NOTIFY_` reads `OPENCODE_NOTIFY_MIN_SECONDS`.
 *
 * Precedence per key: env var (when it parses) > plugin option (when it
 * parses) > default. A value that fails to parse is ignored rather than
 * rejected, so a typo falls through to the next layer.
 *
 * Pure module - no opencode imports.
 */

/** The untyped options bag opencode hands a plugin (`ctx.options`). */
export type PluginOptionBag = Readonly<Record<string, unknown>>;

/** Environment-shaped lookup (`process.env`). */
export type EnvBag = Readonly<Record<string, string | undefined>>;

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/**
 * Tri-state boolean parse: real booleans pass through; strings in the
 * dotenv `1`/`true`/`yes`/`on` (or `0`/`false`/`no`/`off`) convention map to
 * `true` / `false`; anything else is `undefined` (not set).
 */
export function parseBoolish(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return undefined;
}

/**
 * Parse a finite, non-negative number from a JSON number or a numeric
 * string. Fractions are kept. Blank, negative, or non-numeric values are
 * `undefined`.
 */
export function parseNonNegativeNumber(raw: unknown): number | undefined {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw.trim());
  else return undefined;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Trimmed non-empty string, else `undefined`. */
export function parseNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** `minSeconds` -> `MIN_SECONDS`, `titlePrefix` -> `TITLE_PREFIX`. */
export function toEnvKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

/** Typed accessors over one plugin's options + env layer. */
export interface OptionReader {
  /** Resolve `key` with `parse`, returning `undefined` when no layer sets it. */
  get<T>(key: string, parse: (raw: unknown) => T | undefined): T | undefined;
  bool(key: string, fallback: boolean): boolean;
  number(key: string, fallback: number): number;
  string(key: string, fallback: string): string;
  optionalString(key: string): string | undefined;
  /** Env var name consulted for `key` (for docs and diagnostics). */
  envName(key: string): string;
}

/**
 * Build an {@link OptionReader} over `options` (from `ctx.options`) and
 * `env` (usually `process.env`), with env names `${envPrefix}${toEnvKey(key)}`.
 */
export function createOptionReader(options: PluginOptionBag | undefined, env: EnvBag, envPrefix: string): OptionReader {
  const bag: PluginOptionBag = options ?? {};
  const envName = (key: string): string => `${envPrefix}${toEnvKey(key)}`;
  function get<T>(key: string, parse: (raw: unknown) => T | undefined): T | undefined {
    const fromEnv = parse(env[envName(key)]);
    if (fromEnv !== undefined) return fromEnv;
    return Object.hasOwn(bag, key) ? parse(bag[key]) : undefined;
  }
  return {
    get,
    bool: (key, fallback) => get(key, parseBoolish) ?? fallback,
    number: (key, fallback) => get(key, parseNonNegativeNumber) ?? fallback,
    string: (key, fallback) => get(key, parseNonEmptyString) ?? fallback,
    optionalString: (key) => get(key, parseNonEmptyString),
    envName,
  };
}
