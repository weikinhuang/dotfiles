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
 *   - `{{roll:NdM}}` / `{{roll:M}}` -> dice sum (N d-M dice; N defaults to 1)
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
