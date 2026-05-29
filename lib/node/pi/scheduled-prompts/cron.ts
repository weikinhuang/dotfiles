/**
 * Hand-rolled 5-field cron parser + "next fire" computation.
 *
 * Fields, in order: minute (0-59), hour (0-23), day-of-month (1-31),
 * month (1-12), day-of-week (0-7, where both 0 and 7 are Sunday). Each
 * field supports:
 *   - star          every value
 *   - star then /n  every nth value from the field minimum
 *   - a-b           inclusive range
 *   - a-b/n         inclusive range, every nth
 *   - a,b,c         explicit list (segments may combine any of the above)
 *
 * Names (`mon`, `jan`) are intentionally NOT supported - numeric only -
 * to keep the parser small and unambiguous. The day-of-month vs
 * day-of-week interaction follows classic cron: when BOTH are
 * restricted (neither is `*`), a day matches if EITHER matches; when
 * only one is restricted, only that one must match.
 *
 * All computation is in local time (matching how a user reads
 * `0 9 * * *` as "9am my time"). No external dependency - we walk
 * forward day by day to find the next match.
 *
 * Pure module - no pi imports - so it is directly unit-testable.
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  /** True when the day-of-month field was something other than `*`. */
  domRestricted: boolean;
  /** True when the day-of-week field was something other than `*`. */
  dowRestricted: boolean;
}

function toInt(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  return Number(token);
}

/**
 * Parse a single cron field into the sorted, de-duplicated list of
 * values it matches. Returns `null` on any malformed segment or
 * out-of-range value.
 */
function parseField(spec: string, min: number, max: number): number[] | null {
  if (spec.length === 0) return null;
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    if (part.length === 0) return null;
    let rangePart = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      const stepInt = toInt(part.slice(slash + 1));
      if (stepInt === null || stepInt <= 0) return null;
      step = stepInt;
      rangePart = part.slice(0, slash);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      const loInt = toInt(a);
      const hiInt = toInt(b);
      if (loInt === null || hiInt === null) return null;
      lo = loInt;
      hi = hiInt;
    } else {
      const v = toInt(rangePart);
      if (v === null) return null;
      lo = v;
      // A bare value with a step (`5/10`) means "from 5 to max, every 10".
      hi = slash >= 0 ? max : v;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression. Returns `null` when the expression
 * does not have exactly five whitespace-separated fields or any field
 * is malformed.
 */
export function parseCron(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dowRaw = parseField(fields[4], 0, 7);
  if (minute === null || hour === null || dayOfMonth === null || month === null || dowRaw === null) {
    return null;
  }
  // Normalize 7 -> 0 (both mean Sunday) and de-dupe.
  const dayOfWeek = [...new Set(dowRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

function dayMatches(fields: CronFields, date: Date): boolean {
  if (!fields.month.includes(date.getMonth() + 1)) return false;
  const domOk = fields.dayOfMonth.includes(date.getDate());
  const dowOk = fields.dayOfWeek.includes(date.getDay());
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
}

// Bound the forward search so an impossible spec (e.g. Feb 30) can't
// loop forever. Eight years comfortably covers the worst legitimate gap
// (Feb 29 on a leap year is at most ~4 years out).
const MAX_SEARCH_DAYS = 366 * 8;

/**
 * Return the first `Date` strictly after `after` that matches `fields`,
 * computed in local time. Throws when no match exists within the
 * search horizon (only possible for impossible specs).
 */
export function cronNext(fields: CronFields, after: Date): Date {
  // Start at the next whole minute after `after`.
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const cursor = new Date(start.getTime());
  for (let day = 0; day <= MAX_SEARCH_DAYS; day++) {
    if (dayMatches(fields, cursor)) {
      const isStartDay = day === 0;
      for (const h of fields.hour) {
        if (isStartDay && h < start.getHours()) continue;
        for (const m of fields.minute) {
          if (isStartDay && h === start.getHours() && m < start.getMinutes()) continue;
          return new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, m, 0, 0);
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  throw new Error(`cronNext: no matching time within ${MAX_SEARCH_DAYS} days`);
}
