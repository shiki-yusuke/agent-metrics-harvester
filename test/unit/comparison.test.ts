// Acceptance criteria §8: "baseline 0 / ... / n 不足で null", plus the §4 compatibility guard
// (same timezone/bucket kind/repo set/team-config hash, or error).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredSnapshot } from "../../src/application/types.js";
import {
  COMPARISON_POLICY,
  ComparisonIncompatibleError,
  compareResults,
} from "../../src/report/comparison.js";
import { computeCostPerPr } from "../../src/report/cost-per-pr.js";
import { computeInputFingerprint } from "../../src/report/fingerprint.js";
import { resolvePeriod } from "../../src/report/period.js";
import type { PrMetadataRecord } from "../../src/report/pr-metadata/types.js";
import type { SnapshotReader } from "../../src/report/snapshot-reader.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

const REPO = "octo/example";
const FINGERPRINT = computeInputFingerprint({
  snapshots: [],
  periodStartUtc: "2026-01-01T00:00:00Z",
  periodEndUtc: "2026-02-01T00:00:00Z",
  repositories: [REPO],
  mergedPrs: [],
  cacheVersion: "pr-metadata-cache/v1",
  minSampleSize: 5,
});

function readerWithCost(totalCostUsd: number, count: number, generatedAt: string): SnapshotReader {
  const snapshots: StoredSnapshot[] = Array.from({ length: count }, (_, i) => {
    const payload = makeTokenUsagePayload({
      repository: REPO,
      subjectId: `s${i}`,
      generatedAt,
      estimatedCostUsd: totalCostUsd / count,
    });
    return {
      upsertKey: payload.upsert_key,
      repository: REPO,
      payload,
      sourceCommentId: i,
      sourceUpdatedAt: generatedAt,
      markerSha: "a".repeat(64),
    };
  });
  return {
    async listCurrentSnapshots() {
      return snapshots;
    },
  };
}

function mergedPrs(count: number, openedAt: string, openHours: number): PrMetadataRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    repository: REPO,
    prNumber: i + 1,
    openedAt,
    mergedAt: new Date(Date.parse(openedAt) + openHours * 3_600_000).toISOString(),
    state: "merged",
    githubUpdatedAt: openedAt,
    fetchedAt: openedAt,
  }));
}

async function build(
  periodLabel: string,
  totalCostUsd: number,
  mergedCount: number,
  openHours: number,
  metadataComplete = true,
) {
  const period = resolvePeriod(periodLabel, "UTC");
  const midPeriod = new Date(period.startMs + 3_600_000).toISOString(); // safely inside [start, end)
  return computeCostPerPr({
    period,
    repositories: [REPO],
    snapshotReader: readerWithCost(totalCostUsd, Math.max(mergedCount, 1), midPeriod),
    mergedPrRecordsByRepository: new Map([[REPO, mergedPrs(mergedCount, midPeriod, openHours)]]),
    metadataComplete,
    metadataAsOf: "2026-09-01T00:00:00Z",
    metadataApiRequestsUsed: 1,
    inputFingerprint: FINGERPRINT,
  });
}

describe("compareResults: improvement direction and sign normalization", () => {
  it("a cheaper, faster, higher-volume period B shows positive improvement on all three metrics", async () => {
    const a = await build("2026-06", 100, 10, 48); // $10/PR average, 48h lead time
    const b = await build("2026-07", 50, 20, 24); // $2.5/PR average, 24h lead time, more PRs

    const cmp = compareResults(a, b);
    assert.ok(
      (cmp.costPerMergedPr.improvementPercent ?? -1) > 0,
      "cheaper cost-per-PR must show positive improvement",
    );
    assert.ok(
      (cmp.mergedPrCount.improvementPercent ?? -1) > 0,
      "more merged PRs must show positive improvement",
    );
    assert.ok(
      (cmp.leadTimeMedianHours.improvementPercent ?? -1) > 0,
      "shorter lead time must show positive improvement",
    );
  });

  it("a more expensive, slower period B shows negative improvement", async () => {
    const a = await build("2026-06", 50, 10, 24);
    const b = await build("2026-07", 100, 10, 48);
    const cmp = compareResults(a, b);
    assert.ok((cmp.costPerMergedPr.improvementPercent ?? 1) < 0);
    assert.ok((cmp.leadTimeMedianHours.improvementPercent ?? 1) < 0);
  });
});

describe("compareResults: null gating", () => {
  it("nulls a metric when the baseline value is 0 (never divide by zero)", async () => {
    const a = await build("2026-06", 0, 10, 24);
    const b = await build("2026-07", 50, 10, 24);
    const cmp = compareResults(a, b);
    assert.equal(cmp.costPerMergedPr.changePercent, null);
    assert.equal(cmp.costPerMergedPr.nullReason, "baseline_zero");
  });

  it("nulls a metric when either side's sample size is below the policy minimum", async () => {
    const a = await build("2026-06", 50, 2, 24); // below default minSampleSize=5
    const b = await build("2026-07", 50, 10, 24);
    const cmp = compareResults(a, b);
    // merged_pr_count is always populated regardless of sample size (only metadata
    // completeness gates it), so its own comparison is the one that reaches the
    // sample-size gate directly.
    assert.equal(cmp.mergedPrCount.nullReason, "insufficient_sample");
    // cost-per-PR is already null at the single-period level once that period's own status
    // is insufficient_sample (estimatedCostPerMergedPrUsd is only non-null for ok_observed),
    // so its comparison is gated even earlier -- either way, the comparison must not report a
    // real change percent from too small a sample.
    assert.equal(cmp.costPerMergedPr.changePercent, null);
  });

  it("nulls a metric when either side's underlying value is unavailable (metadata incomplete)", async () => {
    const a = await build("2026-06", 50, 10, 24, false); // metadata incomplete
    const b = await build("2026-07", 50, 10, 24, true);
    const cmp = compareResults(a, b);
    assert.equal(cmp.mergedPrCount.nullReason, "value_unavailable");
  });

  it("exposes the policy version and actual sample sizes alongside every comparison", async () => {
    const a = await build("2026-06", 50, 10, 24);
    const b = await build("2026-07", 50, 10, 24);
    const cmp = compareResults(a, b);
    assert.equal(cmp.policy.version, COMPARISON_POLICY.version);
    assert.equal(cmp.sampleSizeA, 10);
    assert.equal(cmp.sampleSizeB, 10);
  });
});

describe("compareResults: compatibility guard", () => {
  it("throws on a timezone mismatch", async () => {
    const a = await build("2026-06", 50, 10, 24);
    const bPeriod = resolvePeriod("2026-07", "Asia/Tokyo");
    const b = { ...(await build("2026-07", 50, 10, 24)), period: bPeriod };
    assert.throws(() => compareResults(a, b), ComparisonIncompatibleError);
  });

  it("throws on a period-kind mismatch (month vs week)", async () => {
    const a = await build("2026-06", 50, 10, 24);
    const bPeriod = resolvePeriod("2026-W27", "UTC");
    const b = { ...(await build("2026-07", 50, 10, 24)), period: bPeriod };
    assert.throws(() => compareResults(a, b), ComparisonIncompatibleError);
  });

  it("throws on a repository-set mismatch", async () => {
    const a = await build("2026-06", 50, 10, 24);
    const b = { ...(await build("2026-07", 50, 10, 24)), repositories: ["octo/other"] };
    assert.throws(() => compareResults(a, b), ComparisonIncompatibleError);
  });

  it("throws on a team-config hash mismatch", async () => {
    const a = await build("2026-06", 50, 10, 24);
    const b = await build("2026-07", 50, 10, 24);
    assert.throws(
      () => compareResults(a, b, { teamConfigHashA: "hash-a", teamConfigHashB: "hash-b" }),
      ComparisonIncompatibleError,
    );
  });

  it("does not throw when both sides omit a team-config hash", async () => {
    const a = await build("2026-06", 50, 10, 24);
    const b = await build("2026-07", 50, 10, 24);
    assert.doesNotThrow(() => compareResults(a, b));
  });
});
