// The one timestamp reader of cognitive-debt-metrics/v0 (`--as-of`, lane `estimated_at`, ack
// `occurred_at`, and M3's `evaluation_cut` once phase 2 reads it). Design section 2.3: the string
// must match the regular expression below AND each component must be in range (month 1-12, day
// within that month, hour < 24, minute and second < 60, any number of fraction digits, trailing
// `Z`). The built-in date parser is never used: it accepts local-time forms and rolls over out-of-range
// components (`T24:00:00Z` -> the next day). The fraction is kept as its digit string, never as a
// float, so two instants that differ only in a late fraction digit still compare in time order
// (docs/cognitive-debt-decisions.md #35).

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Days from 1970-01-01 to y-m-d in the proleptic Gregorian calendar (H. Hinnant's
 * days_from_civil). Plain arithmetic, so years 0000-0099 are not remapped the way Date.UTC
 * remaps them. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** A UTC instant: whole epoch seconds plus the fraction digits with trailing `0`s removed (`""`
 * for no fraction). Equal instants have equal fields. */
export interface UtcInstant {
  readonly sec: number;
  readonly frac: string;
}

/** Inverse of daysFromCivil (H. Hinnant's civil_from_days). */
function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** `YYYY-MM-DDTHH:MM:SSZ` of whole epoch seconds (a git committer date), by arithmetic. */
export function formatUtcSeconds(sec: number): string {
  const days = Math.floor(sec / 86400);
  const rest = sec - days * 86400;
  const [y, m, d] = civilFromDays(days);
  const time = `${pad(Math.floor(rest / 3600), 2)}:${pad(Math.floor((rest % 3600) / 60), 2)}:${pad(rest % 60, 2)}`;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${time}Z`;
}

/** The instant of a strict `YYYY-MM-DDTHH:MM:SS(.f+)Z` string, or null when the string has
 * another form or names a time that does not exist. */
export function parseUtcTimestamp(value: string): UtcInstant | null {
  const m = UTC_TIMESTAMP.exec(value);
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  return {
    sec: daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s,
    frac: (m[7] ?? "").replace(/0+$/, ""),
  };
}

/** Time order of two instants: seconds first, then the fraction digits right-padded with `0` to
 * the same length and compared as strings (equal length, digits only = numeric order). */
export function compareUtc(a: UtcInstant, b: UtcInstant): -1 | 0 | 1 {
  if (a.sec !== b.sec) return a.sec < b.sec ? -1 : 1;
  const len = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(len, "0");
  const fb = b.frac.padEnd(len, "0");
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}
