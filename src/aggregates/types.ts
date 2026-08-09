// Shapes for the `metrics-data` branch's `aggregates/` JSONL lines (M1 dashboard, D9 plan --
// "契約凍結はしない": this is a v0 internal format, not the agent-metrics/v1 protocol itself,
// and may still change shape across M-milestones). Three kinds share one append-only file per
// UTC month; a `kind` discriminant on every line is what lets a reader (src/dashboard) and a
// writer (scripts/push-aggregate.mjs) agree on which shape a given line is without a schema
// registry.
//
// Every kind is a deliberately-lossy PROJECTION of a richer local observation (lane's
// attribution audit, lane's calibration loop) down to counts/digests only -- session id lists,
// task names, and any other free-text or per-individual detail are never part of this shape in
// the first place, so there is nothing for the personal-dimension scan (schema.ts) to have to
// catch in practice; it runs anyway as defense in depth against a future field addition.

export type AggregateKind = "attribution_audit_summary" | "calibration_point" | "heartbeat";

export interface AttributionAuditSummaryRecord {
  readonly kind: "attribution_audit_summary";
  readonly generated_at: string;
  readonly window: { readonly start: string; readonly end: string };
  readonly sessions: {
    readonly exactly_attributed: number;
    readonly unbound: number;
    readonly mixed: number;
    readonly orphan: number;
  };
  readonly tokens: { readonly exact_attributed: number; readonly total_measured: number };
  readonly research_eligible: boolean;
  readonly source_repo: string;
}

export type CalibrationDecisionStatus = "predicted" | "abstained";

export interface CalibrationPointRecord {
  readonly kind: "calibration_point";
  readonly generated_at: string;
  /** sha256, truncated to 16 hex chars -- the caller (lane) digests the intent id before this
   * line is ever built; push-aggregate never sees (and so can never leak) the raw intent id. */
  readonly intent_digest: string;
  readonly predicted_p50: number | null;
  readonly predicted_p80: number | null;
  readonly actual_tokens: number;
  readonly actual_cost_usd: number;
  readonly decision_status: CalibrationDecisionStatus;
  readonly abstain_reasons: readonly string[];
  readonly cohort_digest: string;
}

export type HeartbeatSource = "local-push" | "workflow";

export interface HeartbeatRecord {
  readonly kind: "heartbeat";
  readonly source: HeartbeatSource;
  readonly at: string;
}

export type AggregateRecord =
  | AttributionAuditSummaryRecord
  | CalibrationPointRecord
  | HeartbeatRecord;
