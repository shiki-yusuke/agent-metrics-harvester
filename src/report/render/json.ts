// JSON renderer (spec §1: "JSON が正本出力"). A thin, explicit (not generically-recursive)
// field-by-field mapping from the internal camelCase domain objects to the snake_case shape
// this protocol's other JSON (agent-metrics/v1 payloads) already uses -- hand-written rather
// than an automatic camelCase->snake_case converter so there is no risk of a generic converter
// mangling something it shouldn't (e.g. the free-form omission-reason keys in
// omission_counts_by_reason, which must pass through byte-for-byte).

import type { ComparisonResult, MetricComparison } from "../comparison.js";
import type { CostPerPrResult, HonestyFields, LeadTimeSummary } from "../cost-per-pr.js";
import type { Period } from "../period.js";

const REPORT_PROTOCOL_VERSION = "agent-metrics-report/v1";

function renderPeriod(period: Period) {
  return {
    kind: period.kind,
    label: period.label,
    timezone: period.timezone,
    start: { local: period.start.local, utc: period.start.utc },
    end: { local: period.end.local, utc: period.end.utc },
  };
}

function renderLeadTime(leadTime: LeadTimeSummary | null) {
  if (!leadTime) return null;
  return {
    median_hours: leadTime.medianHours,
    p90_hours: leadTime.p90Hours,
    sample_count: leadTime.sampleCount,
  };
}

function renderHonesty(h: HonestyFields) {
  return {
    merged_pr_with_any_snapshot_count: h.mergedPrWithAnySnapshotCount,
    merged_pr_without_snapshot_count: h.mergedPrWithoutSnapshotCount,
    snapshot_total_count: h.snapshotTotalCount,
    snapshot_status_counts: {
      complete: h.snapshotStatusCounts.complete,
      partial: h.snapshotStatusCounts.partial,
      no_data: h.snapshotStatusCounts.noData,
    },
    snapshots_linked_count: h.snapshotsLinkedCount,
    snapshots_unlinked_count: h.snapshotsUnlinkedCount,
    known_cost_usd_by_linkage: {
      linked: h.knownCostUsdByLinkage.linked,
      unlinked: h.knownCostUsdByLinkage.unlinked,
    },
    records_by_pricing_status: {
      priced: {
        count: h.recordsByPricingStatus.priced.count,
        tokens: h.recordsByPricingStatus.priced.tokens,
      },
      unpriced: {
        count: h.recordsByPricingStatus.unpriced.count,
        tokens: h.recordsByPricingStatus.unpriced.tokens,
      },
      unknown: {
        count: h.recordsByPricingStatus.unknown.count,
        tokens: h.recordsByPricingStatus.unknown.tokens,
      },
    },
    priced_missing_cost_count: h.pricedMissingCostCount,
    omission_counts_by_reason: h.omissionCountsByReason,
    metadata: {
      complete: h.metadata.complete,
      as_of: h.metadata.asOf,
      api_requests_used: h.metadata.apiRequestsUsed,
    },
    quality_status: h.qualityStatus,
    cost_basis: h.costBasis,
    allocation_basis: h.allocationBasis,
  };
}

export function renderJsonResult(result: CostPerPrResult) {
  return {
    period: renderPeriod(result.period),
    repositories: result.repositories,
    status: result.status,
    merged_pr_count: result.mergedPrCount,
    merged_pr_partial_count: result.mergedPrPartialCount,
    known_estimated_cost_usd: result.knownEstimatedCostUsd,
    estimated_cost_per_merged_pr_usd: result.estimatedCostPerMergedPrUsd,
    estimated_cost_per_merged_pr_lower_bound_usd: result.estimatedCostPerMergedPrLowerBoundUsd,
    credits_total: result.creditsTotal,
    lead_time: renderLeadTime(result.leadTime),
    min_sample_size: result.minSampleSize,
    input_fingerprint: result.inputFingerprint,
    honesty: renderHonesty(result.honesty),
  };
}

function renderMetricComparison(m: MetricComparison) {
  return {
    metric: m.metric,
    polarity: m.polarity,
    baseline_value: m.baselineValue,
    value: m.value,
    change_percent: m.changePercent,
    improvement_percent: m.improvementPercent,
    ...(m.nullReason ? { null_reason: m.nullReason } : {}),
  };
}

function renderComparison(comparison: ComparisonResult) {
  return {
    policy: {
      version: comparison.policy.version,
      min_sample_size: comparison.policy.minSampleSize,
    },
    sample_size_a: comparison.sampleSizeA,
    sample_size_b: comparison.sampleSizeB,
    estimated_cost_per_merged_pr_usd: renderMetricComparison(comparison.costPerMergedPr),
    merged_pr_count: renderMetricComparison(comparison.mergedPrCount),
    lead_time_median_hours: renderMetricComparison(comparison.leadTimeMedianHours),
  };
}

export function renderJsonReport(
  resultA: CostPerPrResult,
  resultB?: CostPerPrResult,
  comparison?: ComparisonResult,
) {
  if (!resultB || !comparison) {
    return {
      report: "cost-per-pr",
      protocol_version: REPORT_PROTOCOL_VERSION,
      ...renderJsonResult(resultA),
    };
  }
  return {
    report: "cost-per-pr-comparison",
    protocol_version: REPORT_PROTOCOL_VERSION,
    period_a: renderJsonResult(resultA),
    period_b: renderJsonResult(resultB),
    comparison: renderComparison(comparison),
  };
}
