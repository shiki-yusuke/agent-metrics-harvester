// Acceptance criteria §8: "timezone・DST・月末・ISO週・[start,end)境界".

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidPeriodError, isWithinPeriod, resolvePeriod } from "../../src/report/period.js";

describe("resolvePeriod: month, UTC", () => {
  it("resolves a calendar month to a half-open UTC interval", () => {
    const p = resolvePeriod("2026-07", "UTC");
    assert.equal(p.start.utc, "2026-07-01T00:00:00.000Z");
    assert.equal(p.end.utc, "2026-08-01T00:00:00.000Z");
    assert.equal(p.start.local, p.start.utc.replace(".000Z", "+00:00"));
  });

  it("handles month-end length differences (28/29/30/31 days) via next-month rollover, not a hardcoded day count", () => {
    const feb2026 = resolvePeriod("2026-02", "UTC"); // non-leap: 28 days
    assert.equal(feb2026.end.utc, "2026-03-01T00:00:00.000Z");
    assert.equal(feb2026.endMs - feb2026.startMs, 28 * 86_400_000);

    const feb2028 = resolvePeriod("2028-02", "UTC"); // leap: 29 days
    assert.equal(feb2028.end.utc, "2028-03-01T00:00:00.000Z");
    assert.equal(feb2028.endMs - feb2028.startMs, 29 * 86_400_000);

    const dec2026 = resolvePeriod("2026-12", "UTC"); // year rollover
    assert.equal(dec2026.end.utc, "2027-01-01T00:00:00.000Z");
  });
});

describe("resolvePeriod: month, non-UTC timezone (no DST)", () => {
  it("Asia/Tokyo (UTC+9) shifts the UTC boundary by a fixed 9 hours", () => {
    const p = resolvePeriod("2026-07", "Asia/Tokyo");
    assert.equal(p.start.local, "2026-07-01T00:00:00+09:00");
    assert.equal(p.start.utc, "2026-06-30T15:00:00.000Z");
    assert.equal(p.end.local, "2026-08-01T00:00:00+09:00");
    assert.equal(p.end.utc, "2026-07-31T15:00:00.000Z");
  });
});

describe("resolvePeriod: month, DST-crossing timezone", () => {
  it("America/New_York: a month containing the spring-forward transition is 1 hour short of 31*24h", () => {
    // 2026 US DST starts 2026-03-08 (second Sunday of March): clocks spring forward, losing
    // one hour of *elapsed real time* within the month, even though the wall-clock month is
    // still exactly 31 calendar days start-to-end.
    const p = resolvePeriod("2026-03", "America/New_York");
    assert.equal(p.start.local, "2026-03-01T00:00:00-05:00"); // EST, before the transition
    assert.equal(p.end.local, "2026-04-01T00:00:00-04:00"); // EDT, after the transition
    assert.equal(p.endMs - p.startMs, (31 * 24 - 1) * 3_600_000);
  });

  it("America/New_York: a month containing the fall-back transition is 1 hour longer than 30*24h", () => {
    // 2026 US DST ends 2026-11-01 (first Sunday of November).
    const p = resolvePeriod("2026-11", "America/New_York");
    assert.equal(p.start.local, "2026-11-01T00:00:00-04:00"); // EDT, before the transition
    assert.equal(p.end.local, "2026-12-01T00:00:00-05:00"); // EST, after the transition
    assert.equal(p.endMs - p.startMs, (30 * 24 + 1) * 3_600_000);
  });

  it("round-trips: both local and utc strings parse back to the same instant", () => {
    const p = resolvePeriod("2026-03", "America/New_York");
    assert.equal(Date.parse(p.start.local), p.startMs);
    assert.equal(Date.parse(p.start.utc), p.startMs);
    assert.equal(Date.parse(p.end.local), p.endMs);
    assert.equal(Date.parse(p.end.utc), p.endMs);
  });
});

describe("resolvePeriod: ISO week (Monday start)", () => {
  it("every resolved week starts on a Monday (wall-clock, UTC timezone so this is unambiguous)", () => {
    for (const label of ["2020-W01", "2021-W01", "2026-W01", "2026-W27", "2026-W53"]) {
      const p = resolvePeriod(label, "UTC");
      assert.equal(new Date(p.startMs).getUTCDay(), 1, `${label}: start must be a Monday`);
      assert.equal(p.endMs - p.startMs, 7 * 86_400_000, `${label}: a UTC week is exactly 7*24h`);
    }
  });

  it("a week can start in the preceding Gregorian year (ISO week-year vs calendar-year mismatch)", () => {
    // ISO week 1 of 2026 actually starts Monday 2025-12-29 (2026-01-01 is a Thursday, so ISO
    // week 1 -- the week containing the year's first Thursday -- starts the Monday before it).
    const p = resolvePeriod("2026-W01", "UTC");
    assert.equal(p.start.utc, "2025-12-29T00:00:00.000Z");
  });

  it("DST-crossing week: exactly one early-2026 ISO week is 1 hour short of 7*24h in America/New_York", () => {
    // Whichever ISO week actually contains the 2026-03-08 spring-forward transition, it must
    // show the 1-hour shortfall; find it by scanning rather than hardcoding the week number.
    const shortWeeks = [];
    for (let week = 1; week <= 12; week++) {
      const wp = resolvePeriod(`2026-W${String(week).padStart(2, "0")}`, "America/New_York");
      const durationHours = (wp.endMs - wp.startMs) / 3_600_000;
      if (durationHours === 167) shortWeeks.push(week);
    }
    assert.equal(
      shortWeeks.length,
      1,
      `expected exactly one 167h week, found weeks: ${shortWeeks.join(",")}`,
    );
  });
});

describe("resolvePeriod: half-open [start, end) boundary", () => {
  it("the instant exactly at `end` is excluded; the instant exactly at `start` is included", () => {
    const p = resolvePeriod("2026-07", "UTC");
    assert.equal(isWithinPeriod(p.start.utc, p), true);
    assert.equal(isWithinPeriod(p.end.utc, p), false);
    assert.equal(isWithinPeriod(new Date(p.endMs - 1).toISOString(), p), true);
    assert.equal(isWithinPeriod(new Date(p.startMs - 1).toISOString(), p), false);
  });
});

describe("resolvePeriod: invalid input", () => {
  it("rejects a malformed month", () => {
    assert.throws(() => resolvePeriod("2026-13", "UTC"), InvalidPeriodError);
    assert.throws(() => resolvePeriod("2026-00", "UTC"), InvalidPeriodError);
    assert.throws(() => resolvePeriod("not-a-period", "UTC"), InvalidPeriodError);
  });

  it("rejects a malformed ISO week", () => {
    assert.throws(() => resolvePeriod("2026-W00", "UTC"), InvalidPeriodError);
    assert.throws(() => resolvePeriod("2026-W54", "UTC"), InvalidPeriodError);
  });

  it("rejects an invalid IANA timezone", () => {
    assert.throws(() => resolvePeriod("2026-07", "Not/A_Zone"), InvalidPeriodError);
  });
});
