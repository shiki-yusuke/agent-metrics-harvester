// A/B period comparison (spec §4): a pure, additive combination of two already-computed
// CostPerPrResults -- comparison never re-derives anything from snapshots/metadata itself, it
// only compares numbers the single-period computation already produced. Each metric's
// null-gating looks at that metric's OWN single-period value/sample size, not the composite
// `status` field, since a cost-data gap (partial_cost) doesn't make merged_pr_count or
// lead_time any less trustworthy, and vice versa.

import type { CostPerPrResult } from "./cost-per-pr.js";

export class ComparisonIncompatibleError extends Error {}

export interface ComparisonPolicy {
  readonly version: string;
  readonly minSampleSize: number;
}

/** v1's comparison policy, versioned independently of the protocol/cache versions -- spec §4:
 * "policy に version/hash を持たせ実際の n と共に出力". Bump the version string (never mutate
 * the semantics of an existing one) if the min-sample-size default or sign convention ever
 * changes, so a stored/rendered comparison remains self-describing about which rules produced it. */
export const COMPARISON_POLICY: ComparisonPolicy = {
  version: "cost-per-pr-comparison-policy/v1",
  minSampleSize: 5,
};

export type MetricPolarity = "lower_is_better" | "higher_is_better";

export type ComparisonNullReason = "value_unavailable" | "baseline_zero" | "insufficient_sample";

export interface MetricComparison {
  readonly metric: string;
  readonly polarity: MetricPolarity;
  readonly baselineValue: number | null;
  readonly value: number | null;
  /** (value - baseline) / baseline. Sign is NOT normalized -- a decrease is always negative
   * here regardless of the metric's polarity. */
  readonly changePercent: number | null;
  /** Sign-normalized so positive always means "actually got better" (ai-metrics-platform-
   * template.md §4.4's convention): for a lower_is_better metric this is
   * (baseline-value)/baseline, i.e. -changePercent. */
  readonly improvementPercent: number | null;
  readonly nullReason?: ComparisonNullReason;
}

export interface ComparisonResult {
  readonly policy: ComparisonPolicy;
  readonly sampleSizeA: number | null;
  readonly sampleSizeB: number | null;
  readonly costPerMergedPr: MetricComparison;
  readonly mergedPrCount: MetricComparison;
  readonly leadTimeMedianHours: MetricComparison;
}

export interface CompareOptions {
  readonly teamConfigHashA?: string;
  readonly teamConfigHashB?: string;
  readonly policy?: ComparisonPolicy;
}

function sameRepositorySet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((r) => setA.has(r));
}

function assertComparable(a: CostPerPrResult, b: CostPerPrResult, options: CompareOptions): void {
  if (a.period.timezone !== b.period.timezone) {
    throw new ComparisonIncompatibleError(
      `timezone mismatch: "${a.period.timezone}" vs "${b.period.timezone}"`,
    );
  }
  if (a.period.kind !== b.period.kind) {
    throw new ComparisonIncompatibleError(
      `period kind mismatch: "${a.period.kind}" vs "${b.period.kind}"`,
    );
  }
  if (!sameRepositorySet(a.repositories, b.repositories)) {
    throw new ComparisonIncompatibleError(
      "repository set mismatch between the two periods being compared",
    );
  }
  if ((options.teamConfigHashA ?? null) !== (options.teamConfigHashB ?? null)) {
    throw new ComparisonIncompatibleError(
      "team-config hash mismatch between the two periods being compared",
    );
  }
}

function compareMetric(
  metric: string,
  polarity: MetricPolarity,
  baselineValue: number | null,
  value: number | null,
  sampleSizeA: number | null,
  sampleSizeB: number | null,
  minSampleSize: number,
): MetricComparison {
  if (baselineValue === null || value === null) {
    return {
      metric,
      polarity,
      baselineValue,
      value,
      changePercent: null,
      improvementPercent: null,
      nullReason: "value_unavailable",
    };
  }
  if (
    sampleSizeA === null ||
    sampleSizeB === null ||
    sampleSizeA < minSampleSize ||
    sampleSizeB < minSampleSize
  ) {
    return {
      metric,
      polarity,
      baselineValue,
      value,
      changePercent: null,
      improvementPercent: null,
      nullReason: "insufficient_sample",
    };
  }
  if (baselineValue === 0) {
    return {
      metric,
      polarity,
      baselineValue,
      value,
      changePercent: null,
      improvementPercent: null,
      nullReason: "baseline_zero",
    };
  }
  const changePercent = (value - baselineValue) / baselineValue;
  const improvementPercent = polarity === "lower_is_better" ? -changePercent : changePercent;
  return { metric, polarity, baselineValue, value, changePercent, improvementPercent };
}

/** `a` is the baseline ("period A"), `b` is the comparison ("period B"). Throws
 * ComparisonIncompatibleError (not a null field) when the two periods are not even
 * commensurable -- that is a caller mistake, not a data-quality gap. */
export function compareResults(
  a: CostPerPrResult,
  b: CostPerPrResult,
  options: CompareOptions = {},
): ComparisonResult {
  assertComparable(a, b, options);
  const policy = options.policy ?? COMPARISON_POLICY;

  return {
    policy,
    sampleSizeA: a.mergedPrCount,
    sampleSizeB: b.mergedPrCount,
    costPerMergedPr: compareMetric(
      "estimated_cost_per_merged_pr_usd",
      "lower_is_better",
      a.estimatedCostPerMergedPrUsd,
      b.estimatedCostPerMergedPrUsd,
      a.mergedPrCount,
      b.mergedPrCount,
      policy.minSampleSize,
    ),
    mergedPrCount: compareMetric(
      "merged_pr_count",
      "higher_is_better",
      a.mergedPrCount,
      b.mergedPrCount,
      a.mergedPrCount,
      b.mergedPrCount,
      policy.minSampleSize,
    ),
    leadTimeMedianHours: compareMetric(
      "lead_time_median_hours",
      "lower_is_better",
      a.leadTime?.medianHours ?? null,
      b.leadTime?.medianHours ?? null,
      a.leadTime?.sampleCount ?? a.mergedPrCount,
      b.leadTime?.sampleCount ?? b.mergedPrCount,
      policy.minSampleSize,
    ),
  };
}
