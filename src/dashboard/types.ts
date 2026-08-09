// Domain shapes for the M1 dashboard's five panels (D9 plan). `computeDashboardData`
// (compute.ts) is the only producer of these; `renderDashboardHtml` (render.ts) is the only
// consumer -- the same domain-object/renderer split report/cost-per-pr.ts and report/render/
// already use, so the HTML output can never show numbers the domain object didn't actually
// compute.
//
// Every panel carries the same `PanelMeta` (spec: "すべてに N・欠測率・quality status
// 表示"). `missingRate` is `null` -- never `0` -- when `n` is 0: an empty panel has no
// meaningful missing-rate denominator, and collapsing "no data at all" into "0% missing" would
// read as "fully measured," the exact null/zero conflation the D9 plan rules out.

export interface PanelMeta {
  readonly n: number;
  readonly missingRate: number | null;
  readonly qualityStatus: "not_measured";
}

export interface CostGroup {
  readonly repo: string;
  /** UTC calendar month, `YYYY-MM`, derived from each record's own `generated_at`. */
  readonly month: string;
  readonly recordCount: number;
  readonly pricedCount: number;
  readonly unpricedCount: number;
  readonly unknownCount: number;
  readonly pricedMissingCostCount: number;
  /** Sum of `estimated_cost_usd` over this group's priced records that HAVE that field. `null`
   * when `pricedCount` is 0 -- there is nothing priced to sum, which is a different fact than
   * "measured cost was $0" (spec: "unpriced を$0にしない"). */
  readonly totalCostUsd: number | null;
}

export interface CostPanel {
  readonly meta: PanelMeta;
  /** Sorted by repo, then month, ascending. */
  readonly groups: readonly CostGroup[];
}

export interface CalibrationRow {
  readonly generatedAt: string;
  readonly cohortDigest: string;
  /** Treated as predicted TOKENS (not USD) -- this v0 schema carries exactly one
   * predicted-quantity pair (`predicted_p50`/`predicted_p80`) alongside two actuals
   * (`actual_tokens`, `actual_cost_usd`); tokens is the more primitive of the two (cost is
   * tokens x a pricing table that can itself change), so the ratio bar below compares predicted
   * tokens against actual tokens. Not itself spec-frozen (v0). */
  readonly predictedP50: number | null;
  readonly predictedP80: number | null;
  readonly actualTokens: number;
  readonly actualCostUsd: number;
  /** `actualTokens / predictedP50`, or `null` when `predictedP50` is `null`/0. 1.0 = exact. */
  readonly ratioToP50: number | null;
}

export interface CalibrationPanel {
  readonly meta: PanelMeta;
  /** Sorted by generatedAt, ascending. Only `decision_status: "predicted"` points. */
  readonly predictedRows: readonly CalibrationRow[];
  readonly abstainedCount: number;
  readonly abstainReasonCounts: Readonly<Record<string, number>>;
  /** "insufficient_data" whenever `predictedRows.length` is below the sample-size floor -- no
   * interval/CI math is ever computed regardless (M1 DoD); this only gates whether
   * `averageRatioToP50` is reported at all, never the per-row table itself. */
  readonly sampleStatus: "ok" | "insufficient_data";
  readonly averageRatioToP50: number | null;
}

export interface AttributionPoint {
  readonly generatedAt: string;
  readonly sourceRepo: string;
  readonly exactlyAttributed: number;
  readonly unbound: number;
  readonly mixed: number;
  readonly orphan: number;
  /** `tokens.exact_attributed / tokens.total_measured`, or `null` when `total_measured` is 0. */
  readonly exactAttributedTokenRatio: number | null;
  readonly researchEligible: boolean;
}

export interface AttributionPanel {
  readonly meta: PanelMeta;
  /** Sorted by generatedAt, ascending. */
  readonly timeSeries: readonly AttributionPoint[];
  /** `researchEligible` of the chronologically-latest point, or `null` with no points at all. */
  readonly latestResearchEligible: boolean | null;
}

export interface FreshnessPanel {
  readonly meta: PanelMeta;
  /** Max `at` among `heartbeat` records with `source: "workflow"` -- the runner's own
   * "I executed" signal, deliberately independent of whether it found any new data. `null` if
   * no workflow heartbeat has ever been recorded. */
  readonly pipelineHeartbeatAt: string | null;
  /** Max `generated_at` among attribution_audit_summary + calibration_point records -- the data
   * pipeline's own "I found something new" signal, independent of whether the runner itself is
   * still alive. `null` if there is no such record. Kept deliberately separate from
   * `pipelineHeartbeatAt` (spec: "「新しいタスクが無い」と「pipeline が止まった」を区別する") --
   * a stale `lastValidEventAt` with a fresh `pipelineHeartbeatAt` means "the runner is fine,
   * there's simply nothing new to report," while a stale `pipelineHeartbeatAt` means the
   * scheduled runner itself may have stopped executing. */
  readonly lastValidEventAt: string | null;
  /** This dashboard generation's own timestamp (`--now`, or real "now" if omitted) -- embedded
   * so the client-side freshness banner (render.ts) can compare the VIEWER's current clock
   * against these three timestamps, not a value baked in at generation time. */
  readonly generatedAt: string;
}

export interface CohortGroup {
  readonly cohortDigest: string;
  readonly recordCount: number;
  readonly totalActualCostUsd: number;
}

export interface CohortPanel {
  readonly meta: PanelMeta;
  /** Sorted by cohortDigest, ascending. */
  readonly groups: readonly CohortGroup[];
  /** Fixed, always-present text (spec: "固定注記"). Not derived from data -- present even when
   * `groups` is empty, so an empty panel still carries the caveat once cohort data does start
   * flowing in. */
  readonly caveat: string;
}

export interface DashboardData {
  readonly generatedAt: string;
  readonly cost: CostPanel;
  readonly calibration: CalibrationPanel;
  readonly attribution: AttributionPanel;
  readonly freshness: FreshnessPanel;
  readonly cohort: CohortPanel;
}
