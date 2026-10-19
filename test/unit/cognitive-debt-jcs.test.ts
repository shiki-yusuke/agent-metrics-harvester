import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  byteCompare,
  canonicalize,
  jcsDigest,
  normalizeOutputNumber,
  serializeOutput,
} from "../../src/cognitive-debt/jcs.js";
import { canonicalizeJcs } from "../../src/protocol/canonical.js";

describe("cognitive-debt jcs", () => {
  it("orders object keys exactly like src/protocol/canonical.ts canonicalizeJcs (UTF-16 code units)", () => {
    const samples: unknown[] = [
      { b: 1, a: 2, "10": 3, "2": 4, "": 5 },
      { "�": 1, "😀": 2, é: 3, z: 4, Z: 5 },
      { nested: { y: [3, { d: 1, c: 2 }], x: null }, arr: ["b", "a"], t: true, f: false },
      [{ k2: "v", k1: "v" }, "s", 0, null],
    ];
    for (const s of samples) assert.equal(canonicalize(s), canonicalizeJcs(s));
  });

  it("key order is UTF-16 code unit order, which differs from byte order", () => {
    // U+FFFD sorts after the surrogate pair of U+1F600 in UTF-16, before it in UTF-8 bytes.
    assert.equal(serializeOutput({ "�": 1, "😀": 2 }), '{"😀":2,"�":1}');
    assert.ok(byteCompare("�", "😀") < 0);
  });

  it("integer-like keys are not emitted in JS enumeration order", () => {
    assert.equal(serializeOutput({ "2": "a", "10": "b" }), '{"10":"b","2":"a"}');
  });

  it("output numbers: integers kept, decimals truncated to 2 places, -0 / NaN / Infinity -> null", () => {
    assert.equal(normalizeOutputNumber(3), 3);
    assert.equal(normalizeOutputNumber(0.333333), 0.33);
    assert.equal(normalizeOutputNumber(0.29), 0.29);
    assert.equal(normalizeOutputNumber(1.999), 1.99);
    assert.equal(normalizeOutputNumber(-1.999), -1.99);
    assert.equal(normalizeOutputNumber(-0), null);
    assert.equal(normalizeOutputNumber(Number.NaN), null);
    assert.equal(normalizeOutputNumber(Number.POSITIVE_INFINITY), null);
    assert.equal(
      serializeOutput({ a: -0, b: Number.NaN, c: 2.5678 }),
      '{"a":null,"b":null,"c":2.56}',
    );
  });

  it("plain canonicalize refuses non-finite numbers instead of inventing one", () => {
    assert.throws(() => canonicalize({ a: Number.NaN }), RangeError);
  });

  it("jcsDigest is the release-evidence form: sha256: prefix + hex of the JCS bytes", () => {
    assert.match(jcsDigest({ b: 1, a: 2 }), /^sha256:[0-9a-f]{64}$/);
    assert.equal(jcsDigest({ b: 1, a: 2 }), jcsDigest({ a: 2, b: 1 }));
  });

  it("a lone surrogate (high or low, value or key) is refused; a paired one is not", () => {
    for (const bad of [{ a: "\uD800" }, { a: "x\uDC00" }, { "\uD800": 1 }, ["\uDBFFz"]]) {
      assert.throws(() => serializeOutput(bad), /non-well-formed string/);
      assert.throws(() => canonicalize(bad), /non-well-formed string/);
    }
    assert.equal(serializeOutput({ a: "\uD83D\uDE00" }), '{"a":"\uD83D\uDE00"}');
  });
});
