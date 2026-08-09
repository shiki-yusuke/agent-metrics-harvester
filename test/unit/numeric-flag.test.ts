import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNonNegativeIntFlag } from "../../src/cli/numeric-flag.js";

class TestFlagError extends Error {}

describe("parseNonNegativeIntFlag", () => {
  it("parses a positive integer", () => {
    assert.equal(parseNonNegativeIntFlag("42", "--x", TestFlagError), 42);
  });

  it("parses zero", () => {
    assert.equal(parseNonNegativeIntFlag("0", "--x", TestFlagError), 0);
  });

  it("throws the caller-supplied error type on a non-numeric value", () => {
    assert.throws(() => parseNonNegativeIntFlag("abc", "--x", TestFlagError), TestFlagError);
  });

  it("throws on an empty value", () => {
    assert.throws(() => parseNonNegativeIntFlag("", "--x", TestFlagError), TestFlagError);
  });

  it("throws on a negative value", () => {
    assert.throws(() => parseNonNegativeIntFlag("-1", "--x", TestFlagError), TestFlagError);
  });

  it("throws on a decimal value", () => {
    assert.throws(() => parseNonNegativeIntFlag("1.5", "--x", TestFlagError), TestFlagError);
  });

  it("throws on leading/trailing whitespace (not a bare digit string)", () => {
    assert.throws(() => parseNonNegativeIntFlag(" 1 ", "--x", TestFlagError), TestFlagError);
  });

  it("includes the flag name and the offending value in the error message", () => {
    try {
      parseNonNegativeIntFlag("abc", "--max-api-requests", TestFlagError);
      assert.fail("expected parseNonNegativeIntFlag to throw");
    } catch (err) {
      assert.match((err as Error).message, /--max-api-requests/);
      assert.match((err as Error).message, /"abc"/);
    }
  });

  describe("boundary values", () => {
    it("accepts a leading-zero digit string, parsing it as the base-10 value (existing behavior, pinned)", () => {
      assert.equal(parseNonNegativeIntFlag("007", "--x", TestFlagError), 7);
    });

    it("rejects a leading '+' sign (not a bare digit string)", () => {
      assert.throws(() => parseNonNegativeIntFlag("+5", "--x", TestFlagError), TestFlagError);
    });

    it("rejects exponential notation", () => {
      assert.throws(() => parseNonNegativeIntFlag("5e2", "--x", TestFlagError), TestFlagError);
    });

    it('rejects the literal string "Infinity"', () => {
      assert.throws(() => parseNonNegativeIntFlag("Infinity", "--x", TestFlagError), TestFlagError);
    });

    it("accepts Number.MAX_SAFE_INTEGER exactly", () => {
      assert.equal(
        parseNonNegativeIntFlag("9007199254740991", "--x", TestFlagError),
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("rejects Number.MAX_SAFE_INTEGER + 1 (would round to a safe integer via Number.isFinite alone)", () => {
      assert.throws(
        () => parseNonNegativeIntFlag("9007199254740992", "--x", TestFlagError),
        TestFlagError,
      );
    });

    it("rejects a value one past Number.MAX_SAFE_INTEGER that Number.parseInt silently rounds down to MAX_SAFE_INTEGER + 1 (must-fix regression)", () => {
      // "9007199254740993" is not representable as a double: Number.parseInt silently returns
      // 9007199254740992 (rounded to the nearest representable value), which passed the old
      // `Number.isFinite(n) && n >= 0` check even though it does not equal what the user typed.
      // Number.isSafeInteger is what actually catches this.
      assert.throws(
        () => parseNonNegativeIntFlag("9007199254740993", "--x", TestFlagError),
        TestFlagError,
      );
    });
  });
});
