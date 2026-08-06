// Core cost-per-PR computation (spec §2, §5). A pure function of its inputs -- no clock reads,
// no I/O -- so the same inputs always produce the same output (spec §8: "同一 fingerprint か
// ら決定的結果"). Callers (report-command.ts) are responsible for resolving the period,
// reading snapshots, resolving PR metadata, and computing the input_fingerprint; this module
// only combines already-resolved data.
//
// Denominator (merged_pr_count) and numerator (known_estimated_cost_usd) are deliberately
// independent data sources checked against independent time windows (spec §2's note that a
// PR-unlinked, open-PR-linked, or different-period-merge-linked snapshot's cost still counts
// as long as its OWN generated_at is in period; and a merged PR with zero snapshots still
// counts in the denominator): the denominator only ever reads PrMetadataRecord.mergedAt, the
// numerator only ever reads StoredSnapshot.payload.generated_at. Neither can leak into the
// other's period check.

import { type Period, isWithinPeriod } from "./period.js";
import type { PrMetadataRecord } from "./pr-metadata/types.js";
import type { SnapshotReader } from "./snapshot-reader.js";

export type CostPerPrStatus =
  | "ok_observed"
  | "partial_cost"
  | "no_telemetry"
  | "metadata_incomplete"
  | "insufficient_sample"
  | "zero_denominator";

export interface MetadataSummary {
  readonly complete: boolean;
  readonly asOf: string;
  readonly apiRequestsUsed: number;
}

export interface HonestyFields {
  readonly mergedPrWithAnySnapshotCount: number;
  readonly mergedPrWithoutSnapshotCount: number;
  readonly snapshotTotalCount: number;
  readonly snapshotStatusCounts: {
    readonly complete: number;
    readonly partial: number;
    readonly noData: number;
  };
  readonly snapshotsLinkedCount: number;
  readonly snapshotsUnlinkedCount: number;
  readonly knownCostUsdByLinkage: { readonly linked: number; readonly unlinked: number };
  readonly recordsByPricingStatus: {
    readonly priced: { readonly count: number; readonly tokens: number };
    readonly unpriced: { readonly count: number; readonly tokens: number };
    readonly unknown: { readonly count: number; readonly tokens: number };
  };
  readonly pricedMissingCostCount: number;
  readonly omissionCountsByReason: Readonly<Record<string, number>>;
  readonly metadata: MetadataSummary;
  readonly qualityStatus: "not_measured";
  readonly costBasis: "emitted_estimate";
  readonly allocationBasis: "snapshot_generated_at";
}

export interface LeadTimeSummary {
  readonly medianHours: number;
  readonly p90Hours: number;
  readonly sampleCount: number;
}

export interface CostPerPrResult {
  readonly period: Period;
  readonly repositories: readonly string[];
  readonly status: CostPerPrStatus;
  /** null exactly when `honesty.metadata.complete` is false -- the true count is not known. */
  readonly mergedPrCount: number | null;
  /** Best-effort count of merged PRs actually seen, regardless of completeness. Never presented
   * as the headline metric -- see `mergedPrCount`. */
  readonly mergedPrPartialCount: number;
  readonly knownEstimatedCostUsd: number;
  /** null whenever `status` is not `ok_observed` (denominator unknown/zero, or the numerator
   * has a data-quality gap that makes the exact figure unrepresentable). */
  readonly estimatedCostPerMergedPrUsd: number | null;
  /** A safe lower bound on the true cost-per-merged-PR (known cost can only be undercounted,
   * never overcounted, by a data gap) -- null only when the denominator itself is unknown/zero. */
  readonly estimatedCostPerMergedPrLowerBoundUsd: number | null;
  /** Provider credits, kept in their own unit -- never implicitly converted to/mixed with USD. */
  readonly creditsTotal: number;
  /** null whenever metadata is incomplete or there are no merged PRs to measure. */
  readonly leadTime: LeadTimeSummary | null;
  readonly minSampleSize: number;
  readonly inputFingerprint: string;
  readonly honesty: HonestyFields;
}

export interface ComputeCostPerPrInput {
  readonly period: Period;
  readonly repositories: readonly string[];
  readonly snapshotReader: SnapshotReader;
  readonly mergedPrRecordsByRepository: ReadonlyMap<string, readonly PrMetadataRecord[]>;
  readonly metadataComplete: boolean;
  readonly metadataAsOf: string;
  readonly metadataApiRequestsUsed: number;
  readonly inputFingerprint: string;
  readonly minSampleSize?: number;
}

function median(sortedAscending: readonly number[]): number {
  const n = sortedAscending.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0
    ? ((sortedAscending[mid - 1] as number) + (sortedAscending[mid] as number)) / 2
    : (sortedAscending[mid] as number);
}

/** Nearest-rank p90: the actual observed value at rank ceil(0.9n), never a linear
 * interpolation -- matches the convention already established in this ecosystem's metrics
 * template (docs/ai-metrics-platform-template.md §4.3) for the same reason: it never implies
 * more precision than a small sample supports. */
function nearestRankP90(sortedAscending: readonly number[]): number {
  const n = sortedAscending.length;
  const rank = Math.min(n, Math.ceil(0.9 * n));
  return sortedAscending[rank - 1] as number;
}

export async function computeCostPerPr(input: ComputeCostPerPrInput): Promise<CostPerPrResult> {
  const minSampleSize = input.minSampleSize ?? 5;

  const allMergedPrs: PrMetadataRecord[] = [];
  for (const repo of input.repositories) {
    allMergedPrs.push(...(input.mergedPrRecordsByRepository.get(repo) ?? []));
  }
  const mergedPrKeySet = new Set(allMergedPrs.map((r) => `${r.repository}#${r.prNumber}`));
  const mergedPrPartialCount = mergedPrKeySet.size;
  const mergedPrCount = input.metadataComplete ? mergedPrPartialCount : null;

  const allSnapshots = await input.snapshotReader.listCurrentSnapshots(input.repositories);
  const inPeriodSnapshots = allSnapshots.filter((s) =>
    isWithinPeriod(s.payload.generated_at, input.period),
  );

  let knownEstimatedCostUsd = 0;
  let creditsTotal = 0;
  let snapshotsLinkedCount = 0;
  let snapshotsUnlinkedCount = 0;
  let knownCostLinked = 0;
  let knownCostUnlinked = 0;
  const snapshotStatusCounts = { complete: 0, partial: 0, noData: 0 };
  const recordsByPricingStatus = {
    priced: { count: 0, tokens: 0 },
    unpriced: { count: 0, tokens: 0 },
    unknown: { count: 0, tokens: 0 },
  };
  let pricedMissingCostCount = 0;
  const omissionCountsByReason: Record<string, number> = {};

  for (const snapshot of inPeriodSnapshots) {
    const { payload } = snapshot;
    const { coverage } = payload.data;
    if (coverage.status === "complete") snapshotStatusCounts.complete++;
    else if (coverage.status === "partial") snapshotStatusCounts.partial++;
    else snapshotStatusCounts.noData++;

    for (const omission of coverage.omissions ?? []) {
      omissionCountsByReason[omission.reason] = (omissionCountsByReason[omission.reason] ?? 0) + 1;
    }

    const isLinked = payload.change?.number !== undefined;
    if (isLinked) snapshotsLinkedCount++;
    else snapshotsUnlinkedCount++;

    let thisSnapshotCost = 0;
    for (const record of payload.data.records) {
      if (record.pricing_status === "priced") {
        recordsByPricingStatus.priced.count++;
        recordsByPricingStatus.priced.tokens += record.tokens;
        if (record.estimated_cost_usd !== undefined) {
          knownEstimatedCostUsd += record.estimated_cost_usd;
          thisSnapshotCost += record.estimated_cost_usd;
        } else {
          pricedMissingCostCount++;
        }
      } else if (record.pricing_status === "unpriced") {
        recordsByPricingStatus.unpriced.count++;
        recordsByPricingStatus.unpriced.tokens += record.tokens;
      } else {
        recordsByPricingStatus.unknown.count++;
        recordsByPricingStatus.unknown.tokens += record.tokens;
      }
      if (record.credits !== undefined) creditsTotal += record.credits;
    }
    if (isLinked) knownCostLinked += thisSnapshotCost;
    else knownCostUnlinked += thisSnapshotCost;
  }

  // "merged_pr_with_any_snapshot_count" is a coverage signal about the denominator's PRs, not
  // a period-scoped cost figure -- it looks at ALL current snapshots (any generated_at), not
  // just the in-period ones, since a PR's snapshot can legitimately have been generated in a
  // different period than the one the PR happened to merge in.
  const linkedPrKeysAnySnapshot = new Set<string>();
  for (const snapshot of allSnapshots) {
    const changeNumber = snapshot.payload.change?.number;
    if (changeNumber !== undefined)
      linkedPrKeysAnySnapshot.add(`${snapshot.repository}#${changeNumber}`);
  }
  const mergedPrWithAnySnapshotCount = [...mergedPrKeySet].filter((k) =>
    linkedPrKeysAnySnapshot.has(k),
  ).length;
  const mergedPrWithoutSnapshotCount = mergedPrKeySet.size - mergedPrWithAnySnapshotCount;

  const snapshotTotalCount = inPeriodSnapshots.length;
  const hasDataQualityGap =
    snapshotStatusCounts.partial > 0 ||
    snapshotStatusCounts.noData > 0 ||
    recordsByPricingStatus.unpriced.count > 0 ||
    recordsByPricingStatus.unknown.count > 0 ||
    pricedMissingCostCount > 0;

  // Status precedence (documented, not itself normative text from the spec -- the spec
  // mandates the enum, not this ordering): metadata trustworthiness first, then denominator
  // magnitude, then telemetry presence, then telemetry quality.
  let status: CostPerPrStatus;
  if (!input.metadataComplete) status = "metadata_incomplete";
  else if (mergedPrCount === 0) status = "zero_denominator";
  else if ((mergedPrCount as number) < minSampleSize) status = "insufficient_sample";
  else if (snapshotTotalCount === 0) status = "no_telemetry";
  else if (hasDataQualityGap) status = "partial_cost";
  else status = "ok_observed";

  const estimatedCostPerMergedPrLowerBoundUsd =
    mergedPrCount !== null && mergedPrCount > 0 ? knownEstimatedCostUsd / mergedPrCount : null;
  const estimatedCostPerMergedPrUsd =
    status === "ok_observed" ? estimatedCostPerMergedPrLowerBoundUsd : null;

  let leadTime: LeadTimeSummary | null = null;
  if (input.metadataComplete && allMergedPrs.length > 0) {
    const hours = allMergedPrs
      .map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.openedAt)) / 3_600_000)
      .sort((a, b) => a - b);
    leadTime = {
      medianHours: median(hours),
      p90Hours: nearestRankP90(hours),
      sampleCount: hours.length,
    };
  }

  return {
    period: input.period,
    repositories: input.repositories,
    status,
    mergedPrCount,
    mergedPrPartialCount,
    knownEstimatedCostUsd,
    estimatedCostPerMergedPrUsd,
    estimatedCostPerMergedPrLowerBoundUsd,
    creditsTotal,
    leadTime,
    minSampleSize,
    inputFingerprint: input.inputFingerprint,
    honesty: {
      mergedPrWithAnySnapshotCount,
      mergedPrWithoutSnapshotCount,
      snapshotTotalCount,
      snapshotStatusCounts,
      snapshotsLinkedCount,
      snapshotsUnlinkedCount,
      knownCostUsdByLinkage: { linked: knownCostLinked, unlinked: knownCostUnlinked },
      recordsByPricingStatus,
      pricedMissingCostCount,
      omissionCountsByReason,
      metadata: {
        complete: input.metadataComplete,
        asOf: input.metadataAsOf,
        apiRequestsUsed: input.metadataApiRequestsUsed,
      },
      qualityStatus: "not_measured",
      costBasis: "emitted_estimate",
      allocationBasis: "snapshot_generated_at",
    },
  };
}
