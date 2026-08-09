// Validation + projection for one raw aggregate line before it is ever appended to the
// `metrics-data` branch (spec: "余計なフィールドは落とす、禁止キーは reject してから append").
// This is the ONLY place that decision is made -- scripts/push-aggregate.mjs calls
// `projectAggregateRecord` and either appends the returned, already-narrowed record or refuses
// to touch git at all; src/dashboard's reader re-parses the same shapes but never re-derives
// this validation (a malformed line there is simply skipped, see dashboard/aggregates-reader.ts).
//
// The personal-dimension scan runs over the ORIGINAL raw input, before any projection --
// scanning only the already-narrowed output would miss a forbidden key that also happened to
// collide with a field name this schema keeps (there is no such collision today, but the scan
// exists precisely so a future field addition can't quietly reopen that gap).

import {
  FORBIDDEN_PERSONAL_DIMENSION_KEYS,
  scanPersonalDimensions,
} from "../protocol/personal-dimension.js";
import type {
  AggregateKind,
  AggregateRecord,
  AttributionAuditSummaryRecord,
  CalibrationPointRecord,
  HeartbeatRecord,
} from "./types.js";

export type ProjectionResult =
  | { readonly ok: true; readonly record: AggregateRecord }
  | { readonly ok: false; readonly errors: readonly string[] };

const KINDS: ReadonlySet<string> = new Set([
  "attribution_audit_summary",
  "calibration_point",
  "heartbeat",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

const INTENT_DIGEST_RE = /^[0-9a-f]{16}$/;

function projectAttributionAuditSummary(
  raw: Record<string, unknown>,
  errors: string[],
): AttributionAuditSummaryRecord | undefined {
  const { generated_at, window, sessions, tokens, research_eligible, source_repo } = raw;

  if (!isString(generated_at)) errors.push("generated_at must be a non-empty string");
  if (!isPlainObject(window) || !isString(window.start) || !isString(window.end)) {
    errors.push("window must be { start: string, end: string }");
  }
  if (
    !isPlainObject(sessions) ||
    !isNonNegativeInteger(sessions.exactly_attributed) ||
    !isNonNegativeInteger(sessions.unbound) ||
    !isNonNegativeInteger(sessions.mixed) ||
    !isNonNegativeInteger(sessions.orphan)
  ) {
    errors.push(
      "sessions must be { exactly_attributed, unbound, mixed, orphan } as non-negative integers",
    );
  }
  if (
    !isPlainObject(tokens) ||
    !isNonNegativeInteger(tokens.exact_attributed) ||
    !isNonNegativeInteger(tokens.total_measured)
  ) {
    errors.push("tokens must be { exact_attributed, total_measured } as non-negative integers");
  }
  if (!isBoolean(research_eligible)) errors.push("research_eligible must be a boolean");
  if (!isString(source_repo)) errors.push("source_repo must be a non-empty string");

  if (errors.length > 0) return undefined;

  const w = window as Record<string, unknown>;
  const s = sessions as Record<string, unknown>;
  const t = tokens as Record<string, unknown>;
  return {
    kind: "attribution_audit_summary",
    generated_at: generated_at as string,
    window: { start: w.start as string, end: w.end as string },
    sessions: {
      exactly_attributed: s.exactly_attributed as number,
      unbound: s.unbound as number,
      mixed: s.mixed as number,
      orphan: s.orphan as number,
    },
    tokens: {
      exact_attributed: t.exact_attributed as number,
      total_measured: t.total_measured as number,
    },
    research_eligible: research_eligible as boolean,
    source_repo: source_repo as string,
  };
}

function projectCalibrationPoint(
  raw: Record<string, unknown>,
  errors: string[],
): CalibrationPointRecord | undefined {
  const {
    generated_at,
    intent_digest,
    predicted_p50,
    predicted_p80,
    actual_tokens,
    actual_cost_usd,
    decision_status,
    abstain_reasons,
    cohort_digest,
  } = raw;

  if (!isString(generated_at)) errors.push("generated_at must be a non-empty string");
  if (!isString(intent_digest) || !INTENT_DIGEST_RE.test(intent_digest)) {
    errors.push("intent_digest must be a 16-hex-character digest");
  }
  if (predicted_p50 !== null && !isFiniteNumber(predicted_p50)) {
    errors.push("predicted_p50 must be a finite number or null");
  }
  if (predicted_p80 !== null && !isFiniteNumber(predicted_p80)) {
    errors.push("predicted_p80 must be a finite number or null");
  }
  if (!isFiniteNumber(actual_tokens) || actual_tokens < 0) {
    errors.push("actual_tokens must be a non-negative finite number");
  }
  if (!isFiniteNumber(actual_cost_usd) || actual_cost_usd < 0) {
    errors.push("actual_cost_usd must be a non-negative finite number");
  }
  if (decision_status !== "predicted" && decision_status !== "abstained") {
    errors.push('decision_status must be "predicted" or "abstained"');
  }
  if (!isStringArray(abstain_reasons)) errors.push("abstain_reasons must be an array of strings");
  if (!isString(cohort_digest)) errors.push("cohort_digest must be a non-empty string");

  if (errors.length > 0) return undefined;

  return {
    kind: "calibration_point",
    generated_at: generated_at as string,
    intent_digest: intent_digest as string,
    predicted_p50: predicted_p50 as number | null,
    predicted_p80: predicted_p80 as number | null,
    actual_tokens: actual_tokens as number,
    actual_cost_usd: actual_cost_usd as number,
    decision_status: decision_status as "predicted" | "abstained",
    abstain_reasons: abstain_reasons as readonly string[],
    cohort_digest: cohort_digest as string,
  };
}

function projectHeartbeat(
  raw: Record<string, unknown>,
  errors: string[],
): HeartbeatRecord | undefined {
  const { source, at } = raw;
  if (source !== "local-push" && source !== "workflow") {
    errors.push('source must be "local-push" or "workflow"');
  }
  if (!isString(at)) errors.push("at must be a non-empty string");

  if (errors.length > 0) return undefined;

  return { kind: "heartbeat", source: source as "local-push" | "workflow", at: at as string };
}

/** Validates and narrows one raw parsed-JSON value into an `AggregateRecord`, or returns every
 * validation error found (never throws). Two independent things can make this reject:
 *   1. `kind` is not one of the three known kinds.
 *   2. `scanPersonalDimensions` finds a forbidden key anywhere in `raw` (protocol/
 *      personal-dimension.ts's 11-key list, reused rather than re-defined here per the spec's
 *      "この repo 既存の禁止キー実装を使う").
 * Fields not part of the target kind's shape are silently dropped from the returned `record`
 * (never surfaced as an error) -- only a missing/malformed REQUIRED field is an error. */
export function projectAggregateRecord(kind: unknown, raw: unknown): ProjectionResult {
  const errors: string[] = [];

  if (typeof kind !== "string" || !KINDS.has(kind)) {
    return {
      ok: false,
      errors: [
        `unsupported kind ${JSON.stringify(kind)} -- must be one of: ${[...KINDS].join(", ")}`,
      ],
    };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["input must be a JSON object"] };
  }

  const violations = scanPersonalDimensions(raw);
  if (violations.length > 0) {
    return {
      ok: false,
      errors: violations.map(
        (path) =>
          `forbidden personal-dimension key at "${path}" (see FORBIDDEN_PERSONAL_DIMENSION_KEYS: ${[...FORBIDDEN_PERSONAL_DIMENSION_KEYS].join(", ")})`,
      ),
    };
  }

  const typedKind = kind as AggregateKind;
  let record: AggregateRecord | undefined;
  if (typedKind === "attribution_audit_summary") {
    record = projectAttributionAuditSummary(raw, errors);
  } else if (typedKind === "calibration_point") {
    record = projectCalibrationPoint(raw, errors);
  } else {
    record = projectHeartbeat(raw, errors);
  }

  if (!record) return { ok: false, errors };
  return { ok: true, record };
}

/** The UTC calendar month (`YYYY-MM`) an already-projected record belongs to, i.e. which
 * `aggregates/YYYY-MM.jsonl` file it is appended to. Every kind has exactly one timestamp field
 * to derive this from (`generated_at` for the two data kinds, `at` for a heartbeat) -- there is
 * no separate "bucket" field in the schema itself. Throws if the timestamp does not parse; a
 * record that already passed `projectAggregateRecord` is a non-empty string but is not itself
 * re-validated as a parseable date there, since date-parseability is a git-append-time concern,
 * not a projection-time one. */
export function monthBucketOf(record: AggregateRecord): string {
  const iso = record.kind === "heartbeat" ? record.at : record.generated_at;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `cannot derive a month bucket -- unparseable timestamp: ${JSON.stringify(iso)}`,
    );
  }
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}
