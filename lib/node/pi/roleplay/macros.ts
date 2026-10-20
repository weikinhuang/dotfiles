/**
 * Pure SillyTavern-style macro substitution for the `roleplay` extension.
 *
 * Character cards and lorebooks routinely embed `{{user}}` / `{{char}}`
 * placeholders (and a handful of dynamic ones). Without substitution an
 * imported card injects those braces literally into the prompt, so this
 * module resolves them at injection time.
 *
 * Supported macros (the macro NAME is case-insensitive; any argument
 * after the first `:` keeps its original case):
 *
 *   - `{{user}}`              -> the POV / player-character name (`ctx.user`)
 *   - `{{char}}`              -> the in-context character name (`ctx.char`).
 *                               Resolved per-entry by the caller: a folded
 *                               character sheet passes that character; lore
 *                               passes the primary/face character.
 *   - `{{time}}`              -> `HH:MM` (24h, local) from `ctx.now`
 *   - `{{date}}`              -> `YYYY-MM-DD` from `ctx.now`
 *   - `{{weekday}}`           -> e.g. `Monday` from `ctx.now`
 *   - `{{random:a,b,c}}`      -> one comma-separated option, picked via `ctx.rng`
 *   - `{{roll:NdM}}` / `{{roll:M}}` -> dice sum (N d-M dice; N defaults to 1).
 *                               Capped at {@link MAX_ROLL_DICE} dice and
 *                               {@link MAX_ROLL_SIDES} sides; beyond the cap
 *                               the macro stays literal (an imported card
 *                               cannot hang the event loop).
 *   - `{{newline}}`           -> a literal newline
 *
 * Resolution rules:
 *   - `{{user}}` / `{{char}}` with no value in `ctx` are LEFT LITERAL
 *     (pass-through), so a misconfiguration is visible rather than
 *     silently mangling grammar with an empty string.
 *   - An UNKNOWN macro is left untouched (ST behavior), so unrelated
 *     `{{...}}` text survives.
 *   - Macros do not nest or recurse: a single left-to-right pass.
 *
 * Deterministic: time comes from `ctx.now` and randomness from `ctx.rng`
 * (both injectable), so the whole module is unit-testable without a real
 * clock or RNG. No pi imports.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export interface MacroContext {
  /** POV / player-character name for `{{user}}`. */
  user?: string;
  /** In-context character name for `{{char}}`. */
  char?: string;
  /** Clock source for `{{time}}` / `{{date}}` / `{{weekday}}`. Defaults to `new Date()`. */
  now?: Date;
  /** Randomness source for `{{random}}` / `{{roll}}` in `[0, 1)`. Defaults to `Math.random`. */
  rng?: () => number;
}

/** Max dice per `{{roll}}`; a larger count leaves the macro literal. */
export const MAX_ROLL_DICE = 100;
/** Max sides per die for `{{roll}}`; a larger value leaves the macro literal. */
export const MAX_ROLL_SIDES = 1_000_000;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** A whole integer in `[1, sides]` from a `[0, 1)` rng draw. */
function rollDie(sides: number, rng: () => number): number {
  return Math.floor(rng() * sides) + 1;
}

/**
 * Resolve one macro body (the text between the braces, e.g. `user` or
 * `random:a,b,c`). Returns the replacement string, or `null` to signal
 * "leave the original `{{...}}` literal untouched".
 */
function resolveMacro(body: string, ctx: MacroContext, now: Date, rng: () => number): string | null {
  const colon = body.indexOf(':');
  const rawName = colon === -1 ? body : body.slice(0, colon);
  const arg = colon === -1 ? '' : body.slice(colon + 1);
  const name = rawName.trim().toLowerCase();

  switch (name) {
    case 'user':
      return ctx.user && ctx.user.length > 0 ? ctx.user : null;
    case 'char':
      return ctx.char && ctx.char.length > 0 ? ctx.char : null;
    case 'time':
      return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    case 'date':
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    case 'weekday':
      return WEEKDAYS[now.getDay()];
    case 'newline':
      return '\n';
    case 'random': {
      const options = arg.split(',').map((o) => o.trim());
      if (options.length === 0 || (options.length === 1 && options[0].length === 0)) return null;
      const idx = Math.min(options.length - 1, Math.max(0, Math.floor(rng() * options.length)));
      return options[idx];
    }
    case 'roll': {
      const t = arg.trim().toLowerCase();
      let count = 1;
      let sides = 0;
      if (t.includes('d')) {
        const parts = t.split('d');
        if (parts.length !== 2) return null;
        count = parts[0].length > 0 ? Number.parseInt(parts[0], 10) : 1;
        sides = Number.parseInt(parts[1], 10);
      } else {
        sides = Number.parseInt(t, 10);
      }
      if (!Number.isFinite(count) || !Number.isFinite(sides) || count <= 0 || sides <= 0) return null;
      if (count > MAX_ROLL_DICE || sides > MAX_ROLL_SIDES) return null;
      let total = 0;
      for (let i = 0; i < count; i += 1) total += rollDie(sides, rng);
      return String(total);
    }
    default:
      return null;
  }
}

/**
 * Replace every `{{...}}` macro in `text` per {@link MacroContext}.
 * Unknown macros and unresolved `{{user}}` / `{{char}}` are left
 * literal. Pure: never mutates `ctx`.
 */
export function substituteMacros(text: string, ctx: MacroContext = {}): string {
  if (text.length === 0 || !text.includes('{{')) return text;
  const now = ctx.now ?? new Date();
  const rng = ctx.rng ?? Math.random;
  return text.replace(/\{\{([^{}]*)\}\}/g, (match, body: string) => {
    const replacement = resolveMacro(body, ctx, now, rng);
    return replacement ?? match;
  });
}

/** 32-bit FNV-1a hash of a string (UTF-16 code units). Pure, deterministic. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: a tiny deterministic `[0, 1)` generator for a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A deterministic rng seeded from a string key (e.g. `<sessionId>\0<entryId>`).
 * Used for text that lands in the cached system prompt, so `{{random}}` /
 * `{{roll}}` resolve byte-identically every turn of a session.
 */
export function seededRng(key: string): () => number {
  return mulberry32(hashString(key));
}
