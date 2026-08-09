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
});
