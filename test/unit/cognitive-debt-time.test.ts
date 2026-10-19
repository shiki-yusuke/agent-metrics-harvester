import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareUtc, formatUtcSeconds, parseUtcTimestamp } from "../../src/cognitive-debt/time.js";

const at = (v: string) => {
  const t = parseUtcTimestamp(v);
  assert.ok(t !== null, v);
  return t;
};

describe("cognitive-debt parseUtcTimestamp", () => {
  it("accepts the strict form, any number of fraction digits, and leap days", () => {
    assert.deepEqual(parseUtcTimestamp("1970-01-01T00:00:00Z"), { sec: 0, frac: "" });
    assert.deepEqual(parseUtcTimestamp("2026-01-01T00:00:00Z"), { sec: 1767225600, frac: "" });
    assert.deepEqual(parseUtcTimestamp("2026-12-31T23:59:59.5Z"), {
      sec: 1798761599,
      frac: "5",
    });
    assert.deepEqual(parseUtcTimestamp("2026-01-01T00:00:00.000000001Z"), {
      sec: 1767225600,
      frac: "000000001",
    });
    assert.deepEqual(parseUtcTimestamp("2026-01-01T00:00:00.000Z"), { sec: 1767225600, frac: "" });
    assert.deepEqual(parseUtcTimestamp("2026-01-01T00:00:00.1200Z"), {
      sec: 1767225600,
      frac: "12",
    });
    assert.deepEqual(parseUtcTimestamp("2024-02-29T12:00:00Z"), { sec: 1709208000, frac: "" });
    assert.deepEqual(parseUtcTimestamp("2000-02-29T00:00:00Z"), { sec: 951782400, frac: "" });
    // Years 0000-0099 are not remapped to 19xx.
    assert.deepEqual(parseUtcTimestamp("0050-01-01T00:00:00Z"), { sec: -60589296000, frac: "" });
    const digits30 = "123456789012345678901234567891";
    assert.deepEqual(parseUtcTimestamp(`2026-01-01T00:00:00.${digits30}Z`), {
      sec: 1767225600,
      frac: digits30,
    });
  });

  it("refuses other forms and components out of range (no rollover)", () => {
    for (const bad of [
      "2026-01-01T00:00:00",
      "2026-01-01T00:00:00+00:00",
      "2026-01-01 00:00:00Z",
      "2026-01-01T00:00Z",
      "2026-01-01T00:00:00.Z",
      "2026-01-01",
      "2026-00-10T00:00:00Z",
      "2026-13-10T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:60Z",
      " 2026-01-01T00:00:00Z",
    ]) {
      assert.equal(parseUtcTimestamp(bad), null, bad);
    }
  });

  it("compareUtc orders by seconds, then by the fraction digits, never through a float", () => {
    // As epoch ms floats these two are equal (1e-6 ms is lost next to 1.7e12), so the old reader returned 0.
    assert.equal(
      compareUtc(at("2026-01-01T00:00:00.000000001Z"), at("2026-01-01T00:00:00.000000000Z")),
      1,
    );
    assert.equal(
      compareUtc(at("2026-01-01T00:00:00.000000000Z"), at("2026-01-01T00:00:00.000000001Z")),
      -1,
    );
    assert.equal(compareUtc(at("2026-01-01T00:00:00.1Z"), at("2026-01-01T00:00:00.10Z")), 0);
    assert.equal(
      compareUtc(at("2026-01-01T00:00:00.10Z"), at("2026-01-01T00:00:00.100000000000000000000Z")),
      0,
    );
    // 1e-21 s added to an epoch-ms float is lost entirely; the digit string keeps it.
    assert.equal(
      compareUtc(at("2026-01-01T00:00:00.000000000000000000001Z"), at("2026-01-01T00:00:00Z")),
      1,
    );
    assert.equal(compareUtc(at("2026-01-01T00:00:01Z"), at("2026-01-01T00:00:00.999999Z")), 1);
    assert.equal(compareUtc(at("2026-01-01T00:00:00.09Z"), at("2026-01-01T00:00:00.1Z")), -1);
  });

  it("formatUtcSeconds writes whole epoch seconds back in the strict form", () => {
    for (const v of ["1970-01-01T00:00:00Z", "2024-02-29T12:34:56Z", "2026-12-31T23:59:59Z"]) {
      assert.equal(formatUtcSeconds(at(v).sec), v);
    }
  });
});
