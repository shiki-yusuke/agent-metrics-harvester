// Shapes defined by docs/protocols/agent-metrics-v1.md (see test/contract/vendor/UPSTREAM.md
// for the exact upstream commit this repository conforms to). Kept intentionally close to the
// JSON Schemas vendored in test/contract/vendor/*.schema.json -- this file is the TypeScript
// mirror a harvester's own code programs against; the schemas remain the source of truth for
// conformance and are re-validated against by test/contract.

export interface Emitter {
  readonly name: string;
  readonly version: string;
}

export interface Subject {
  readonly namespace: string;
  readonly type: string;
  readonly id: string;
}

export interface Repository {
  readonly provider: string;
  readonly id: string;
}

export interface Change {
  readonly type?: string;
  readonly number?: number;
  readonly url?: string;
  readonly head_sha?: string;
}

export type TokenKind =
  | "input_nocache"
  | "cache_read"
  | "cache_write_5m"
  | "cache_write_1h"
  | "cache_write_unknown"
  | "output";

export type PricingStatus = "priced" | "unpriced" | "unknown";

export interface TokenUsageRecord {
  readonly activity: { readonly namespace: string; readonly name: string };
  readonly agent: string;
  readonly model: string;
  readonly token_kind: TokenKind;
  readonly tokens: number;
  readonly priced_tokens?: number;
  readonly unpriced_tokens?: number;
  readonly estimated_cost_usd?: number;
  readonly credits?: number;
  readonly pricing_status: PricingStatus;
}

export type CoverageStatus = "complete" | "partial" | "no_data";

export interface CoverageOmission {
  readonly entry_id: string;
  readonly reason: string;
  readonly detail?: string;
}

export interface Coverage {
  readonly status: CoverageStatus;
  readonly eligible_entries: number;
  readonly measured_entries: number;
  readonly excluded_entries: number;
  readonly omissions?: readonly CoverageOmission[];
}

export interface TokenUsageData {
  readonly mode: "snapshot";
  readonly records: readonly TokenUsageRecord[];
  readonly coverage: Coverage;
}

/** The envelope-level fields common to every agent-metrics/v1 payload, regardless of `schema`. */
export interface EnvelopeCommon {
  readonly protocol_version: "agent-metrics/v1";
  readonly schema: string;
  readonly upsert_key: string;
  readonly emitter: Emitter;
  readonly subject: Subject;
  readonly repository: Repository;
  readonly change?: Change;
  readonly generated_at: string;
  readonly data: unknown;
}

/** A payload whose `schema` is the one kind this harvester understands. */
export interface TokenUsagePayload extends EnvelopeCommon {
  readonly schema: "token-usage/v1";
  readonly data: TokenUsageData;
}

/** Reason codes a harvester can attach to a rejected/ignored comment. Names match the
 * `reason_code` values in test/contract/vendor/fixtures/expected-results.json exactly, plus
 * additional codes this implementation needs beyond what the fixture set exercises: trust-model
 * checks that are transport-level, not payload-level (protocol doc section 7), and
 * "internal_error" -- a last-resort backstop (application/harvest.ts) for an unforeseen
 * exception while processing one comment, so that comment is rejected instead of the exception
 * propagating and poisoning the rest of its batch. */
export type RejectionCode =
  | "envelope_ignored_not_agent_metrics"
  | "envelope_fields_missing"
  | "envelope_base64_decode_failed"
  | "envelope_hash_mismatch"
  | "payload_not_valid_json"
  | "schema_validation_failed"
  | "upsert_key_mismatch"
  | "personal_dimension_forbidden_key"
  | "unsupported_schema_kind"
  | "payload_too_large"
  | "payload_too_deep"
  | "author_not_trusted"
  | "repository_mismatch"
  | "change_mismatch"
  | "change_type_mismatch"
  | "internal_error";

export interface RejectionReason {
  readonly code: RejectionCode;
  readonly detail?: string;
}

export type DecodeOutcome =
  | { readonly kind: "ignored" }
  | { readonly kind: "accepted"; readonly payload: TokenUsagePayload; readonly rawBytes: Buffer }
  | { readonly kind: "rejected"; readonly reasons: readonly RejectionReason[] };
