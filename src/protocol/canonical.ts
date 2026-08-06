// RFC 8785 JSON Canonicalization Scheme (JCS), minimal subset -- sufficient for this
// protocol's upsert-identity object: nested plain objects/arrays of strings and
// non-negative integers, no floats, no non-ASCII keys. Key ordering uses JS's default
// string comparison, which is UTF-16 code unit order -- exactly what RFC 8785 requires.
//
// This mirrors test/contract/vendor/verify-fixtures.mjs's `canonicalize` byte-for-byte
// (see docs/protocols/agent-metrics-v1.md section 5) so this implementation and the
// upstream reference oracle can never silently diverge on the one recipe every consumer
// of this protocol must derive identically.

import { createHash } from "node:crypto";
import type { Repository, Subject } from "./types.js";

export function canonicalizeJcs(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJcs).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJcs(record[k])}`).join(",")}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface UpsertIdentity {
  readonly schema: string;
  readonly repository: Repository;
  readonly subject: Subject;
}

/** identity = JCS({schema, repository, subject}); upsert_key = "am1_" + hex(sha256(identity)).
 * Deliberately excludes generated_at, change, token/cost values, and emitter.version -- a
 * re-measurement, a price-catalog update, or the change head moving are all corrections to
 * the *same* subject and MUST resolve to the same upsert_key (protocol doc section 5). */
export function computeUpsertKey(identity: UpsertIdentity): string {
  return `am1_${sha256Hex(canonicalizeJcs(identity))}`;
}
