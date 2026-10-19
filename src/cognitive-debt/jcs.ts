// RFC 8785 JSON Canonicalization Scheme for cognitive-debt-metrics/v0 (design section 3).
//
// Two entry points on purpose:
// - `canonicalize` is the plain RFC 8785 recipe, used to recompute upstream digests
//   (release-evidence `bundleDigest()` = "sha256:" + hex(sha256(JCS(bundle)))). It never rewrites
//   a number, and refuses non-finite ones instead of inventing a value.
// - `serializeOutput` is what writes the report bytes: every number is first normalized to an
//   integer or a value truncated to 2 decimals, and `-0` / `NaN` / `Infinity` become `null`
//   (design section 3). The report file is exactly these bytes -- never `JSON.stringify` of a
//   key-sorted object, which would emit integer-like keys ("2", "10") in JS enumeration order.
//
// Object key order is UTF-16 code unit order (`Array.prototype.sort` default), the same rule as
// src/protocol/canonical.ts `canonicalizeJcs` (test/unit/cognitive-debt-jcs.test.ts pins that).
// Array element order is the caller's: every array in the report is sorted explicitly by byte
// order (`byteCompare`) before it gets here.

import { createHash } from "node:crypto";

/** Thrown for a string RFC 8785 cannot represent (a lone UTF-16 surrogate has no UTF-8 form). */
export class NonWellFormedStringError extends Error {
  constructor() {
    super("non-well-formed string");
  }
}

// In a `u` regex a valid surrogate pair is one code point above U+FFFF, so only lone halves match.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new NonWellFormedStringError();
  return JSON.stringify(value);
}

function serialize(value: unknown, normalizeNumber: (n: number) => number | null): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return serializeString(value);
    case "number": {
      const n = normalizeNumber(value);
      if (n === null) return "null";
      // ECMAScript Number::toString is the RFC 8785 number form; `-0` serializes as "0".
      return JSON.stringify(n);
    }
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize a value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v === undefined ? null : v, normalizeNumber)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${serializeString(k)}:${serialize(record[k], normalizeNumber)}`).join(",")}}`;
}

function strictNumber(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`JCS cannot represent the number ${n}`);
  return n;
}

/** Truncates toward zero to 2 decimals. A value that is already a 2-decimal number (e.g. 0.29,
 * whose float times 100 is 28.999999999999996) keeps its value instead of losing a hundredth. */
export function truncate2(n: number): number {
  const scaled = n * 100;
  const nearest = Math.round(scaled);
  const hundredths = Math.abs(scaled - nearest) < 1e-7 ? nearest : Math.trunc(scaled);
  return hundredths / 100;
}

/** Output number rule (design section 3): integers pass through, other finite numbers are
 * truncated to 2 decimals, and `-0` / `NaN` / `Infinity` are written as `null`. */
export function normalizeOutputNumber(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const v = Number.isInteger(n) ? n : truncate2(n);
  if (Object.is(v, -0)) return null;
  return v;
}

/** Plain RFC 8785 canonical form (for recomputing upstream digests). */
export function canonicalize(value: unknown): string {
  return serialize(value, strictNumber);
}

/** The report's bytes: RFC 8785 serialization of the normalized value, no trailing newline. */
export function serializeOutput(value: unknown): string {
  return serialize(value, normalizeOutputNumber);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** "sha256:" + hex(sha256(JCS(value))) -- the release-evidence digest form, prefix included. */
export function jcsDigest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

/** Byte order (design section 3): UTF-8 bytes compared unsigned, i.e. `Buffer.compare`. Used for
 * every array sort; object keys use JCS order instead. */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}
