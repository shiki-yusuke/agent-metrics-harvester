// Period resolution (spec §2): a calendar month or an ISO week (Monday start), resolved in an
// IANA timezone, as a half-open interval [start, end). Internally everything is computed as a
// UTC instant (epoch ms); the output always carries BOTH the local wall-clock boundaries (in
// `timezone`) and their UTC equivalents, so a reader can audit exactly which instants a report
// covers without having to re-derive the timezone math themselves.
//
// No date/timezone library is used (dependency policy: only better-sqlite3 as a runtime
// dependency). Converting a timezone's wall-clock instant to UTC without one requires the
// "double adjustment" technique below -- Intl.DateTimeFormat can only go UTC -> local, never
// local -> UTC directly, so this refines a first guess against the timezone's actual offset at
// that guess, which is exact except within a DST transition's own gap/overlap second (never
// relevant for a month/week boundary at :00:00, which is what this module ever constructs).

export type PeriodKind = "month" | "week";

export interface PeriodBoundary {
  /** ISO 8601 in `timezone`'s own offset, e.g. "2026-07-01T00:00:00+09:00". */
  readonly local: string;
  /** The same instant, in UTC, e.g. "2026-06-30T15:00:00.000Z". */
  readonly utc: string;
}

export interface Period {
  readonly kind: PeriodKind;
  /** The original request string, e.g. "2026-07" or "2026-W27". */
  readonly label: string;
  readonly timezone: string;
  readonly start: PeriodBoundary;
  /** Exclusive -- an instant exactly equal to `end` is OUTSIDE this period. */
  readonly end: PeriodBoundary;
  readonly startMs: number;
  readonly endMs: number;
}

export class InvalidPeriodError extends Error {}

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) === 24 ? 0 : Number(get("hour")), // some locales render midnight as 24
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((asUtc - utcMs) / 60000);
}

/** Converts a wall-clock instant expressed in `timeZone` to its UTC epoch ms. Exact for any
 * wall-clock time that actually occurs exactly once in that timezone (i.e. not inside a DST
 * "spring forward" gap or "fall back" overlap) -- true for every boundary this module ever
 * constructs (always :00:00 on the 1st of a month or a Monday). */
function zonedWallClockToUtcMs(
  year: number,
  month1to12: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const guessUtcMs = Date.UTC(year, month1to12 - 1, day, hour, minute, second);
  const offset1 = offsetMinutesAt(guessUtcMs, timeZone);
  let utcMs = guessUtcMs - offset1 * 60000;
  const offset2 = offsetMinutesAt(utcMs, timeZone);
  if (offset2 !== offset1) {
    utcMs = guessUtcMs - offset2 * 60000;
  }
  return utcMs;
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function makeBoundary(
  year: number,
  month1to12: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): PeriodBoundary {
  const utcMs = zonedWallClockToUtcMs(year, month1to12, day, hour, minute, second, timeZone);
  const offsetMinutes = offsetMinutesAt(utcMs, timeZone);
  const local = `${pad(year, 4)}-${pad(month1to12)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${formatOffset(offsetMinutes)}`;
  const utcDate = new Date(utcMs);
  const utc = `${utcDate.toISOString().slice(0, 19)}.${String(utcDate.getUTCMilliseconds()).padStart(3, "0")}Z`;
  return { local, utc };
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new InvalidPeriodError(`invalid IANA timezone: "${timeZone}"`);
  }
}

/** ISO week date rules: week 1 is the week containing the year's first Thursday (equivalently,
 * the week containing Jan 4). Returns the calendar (year, month, day) of that week's Monday, in
 * a timezone-agnostic (pure calendar) sense -- the caller then interprets that date as a
 * wall-clock date in the report's own timezone. */
function isoWeekMonday(
  isoYear: number,
  isoWeek: number,
): { year: number; month: number; day: number } {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7; // Mon=1 .. Sun=7
  const week1MondayMs = jan4.getTime() - (jan4Weekday - 1) * 86_400_000;
  const targetMs = week1MondayMs + (isoWeek - 1) * 7 * 86_400_000;
  const d = new Date(targetMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** ISO week number of a given UTC-midnight date, via the standard algorithm (shift to that
 * week's Thursday, then count weeks from that Thursday's year's own week 1). Used only to
 * determine how many ISO weeks a year has (see isoWeeksInYear) -- not exposed. */
function isoWeekNumberOf(year: number, month1to12: number, day: number): number {
  const d = new Date(Date.UTC(year, month1to12 - 1, day));
  const dayNum = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to this week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** How many ISO weeks `isoYear` actually has -- 52 for most years, 53 for a year whose Jan 1
 * is a Thursday, or a leap year whose Jan 1 is a Wednesday. Dec 28 is always inside the last
 * ISO week of its year (ISO week 1 of the *next* year never starts before Dec 29), so its own
 * ISO week number is exactly that count. */
function isoWeeksInYear(isoYear: number): number {
  return isoWeekNumberOf(isoYear, 12, 28);
}

function addCalendarDays(
  year: number,
  month1to12: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  // Deliberately built from the same UTC-based pure-calendar arithmetic as isoWeekMonday --
  // this computes a calendar date offset, not a fixed-duration (24h) offset; the wall-clock
  // date it produces is then independently converted to UTC in the target timezone, which is
  // what makes a week spanning a DST transition correctly last other-than-168 real hours.
  const d = new Date(Date.UTC(year, month1to12 - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function resolvePeriod(label: string, timezone: string): Period {
  assertValidTimeZone(timezone);

  const monthMatch = label.match(MONTH_RE);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) {
      throw new InvalidPeriodError(`invalid --month "${label}": month must be 01-12`);
    }
    const start = makeBoundary(year, month, 1, 0, 0, 0, timezone);
    const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    const end = makeBoundary(nextMonth.year, nextMonth.month, 1, 0, 0, 0, timezone);
    return finishPeriod("month", label, timezone, start, end);
  }

  const weekMatch = label.match(WEEK_RE);
  if (weekMatch) {
    const isoYear = Number(weekMatch[1]);
    const isoWeek = Number(weekMatch[2]);
    if (isoWeek < 1 || isoWeek > 53) {
      throw new InvalidPeriodError(`invalid --week "${label}": ISO week must be 01-53`);
    }
    const maxWeek = isoWeeksInYear(isoYear);
    if (isoWeek > maxWeek) {
      throw new InvalidPeriodError(
        `invalid --week "${label}": ISO year ${isoYear} only has ${maxWeek} weeks`,
      );
    }
    const monday = isoWeekMonday(isoYear, isoWeek);
    const nextMonday = addCalendarDays(monday.year, monday.month, monday.day, 7);
    const start = makeBoundary(monday.year, monday.month, monday.day, 0, 0, 0, timezone);
    const end = makeBoundary(nextMonday.year, nextMonday.month, nextMonday.day, 0, 0, 0, timezone);
    return finishPeriod("week", label, timezone, start, end);
  }

  throw new InvalidPeriodError(
    `unrecognized period "${label}" -- expected "YYYY-MM" (month) or "YYYY-Www" (ISO week)`,
  );
}

function finishPeriod(
  kind: PeriodKind,
  label: string,
  timezone: string,
  start: PeriodBoundary,
  end: PeriodBoundary,
): Period {
  const startMs = Date.parse(start.utc);
  const endMs = Date.parse(end.utc);
  return { kind, label, timezone, start, end, startMs, endMs };
}

/** Half-open [start, end) membership test, in epoch ms terms. */
export function isWithinPeriod(isoTimestamp: string, period: Period): boolean {
  const ms = Date.parse(isoTimestamp);
  return ms >= period.startMs && ms < period.endMs;
}
