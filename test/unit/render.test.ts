// Acceptance criteria §8: "JSON と Markdown が同一 domain result 由来" / "Markdown に n・
// coverage・as-of・相関注記が必ず出る" / "個人次元・PR 別コストが出ない" / "quality 未接続時に
// 「品質維持」文言を生成しない".

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredSnapshot } from "../../src/application/types.js";
import { scanPersonalDimensions } from "../../src/protocol/personal-dimension.js";
import { compareResults } from "../../src/report/comparison.js";
import { type CostPerPrResult, computeCostPerPr } from "../../src/report/cost-per-pr.js";
import { computeInputFingerprint } from "../../src/report/fingerprint.js";
import { resolvePeriod } from "../../src/report/period.js";
import type { PrMetadataRecord } from "../../src/report/pr-metadata/types.js";
import { renderJsonReport } from "../../src/report/render/json.js";
import { renderMarkdownReport } from "../../src/report/render/markdown.js";
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

function reader(snapshots: readonly StoredSnapshot[]): SnapshotReader {
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
  mergedCount: number,
  withSnapshot: boolean,
): Promise<CostPerPrResult> {
  const period = resolvePeriod(periodLabel, "UTC");
  const midPeriod = new Date(period.startMs + 3_600_000).toISOString();
  const snapshots: StoredSnapshot[] = withSnapshot
    ? (() => {
        const payload = makeTokenUsagePayload({
          repository: REPO,
          subjectId: `${periodLabel}-s`,
          generatedAt: midPeriod,
        });
        return [
          {
            upsertKey: payload.upsert_key,
            repository: REPO,
            payload,
            sourceCommentId: 1,
            sourceUpdatedAt: midPeriod,
            markerSha: "a".repeat(64),
          },
        ];
      })()
    : [];
  return computeCostPerPr({
    period,
    repositories: [REPO],
    snapshotReader: reader(snapshots),
    mergedPrRecordsByRepository: new Map([[REPO, mergedPrs(mergedCount, midPeriod, 24)]]),
    metadataComplete: true,
    metadataAsOf: "2026-09-01T00:00:00Z",
    metadataApiRequestsUsed: 3,
    inputFingerprint: FINGERPRINT,
  });
}

describe("renderJsonReport / renderMarkdownReport: single period", () => {
  it("both renderers read the same numbers from the same result", async () => {
    const result = await build("2026-07", 6, true);
    const json = renderJsonReport(result) as Record<string, unknown>;
    const markdown = renderMarkdownReport(result);

    assert.equal(json.merged_pr_count, result.mergedPrCount);
    assert.ok(markdown.includes(`Merged PRs (n): ${result.mergedPrCount}`));
    const displayedCost =
      result.estimatedCostPerMergedPrUsd ?? result.estimatedCostPerMergedPrLowerBoundUsd;
    assert.ok(
      displayedCost !== null,
      "this scenario is expected to have a displayable cost figure",
    );
    assert.ok(markdown.includes((displayedCost as number).toFixed(2)));
  });

  it("must-2 regression: both renderers show lead time as unavailable (not a median/p90) when status is insufficient_sample", async () => {
    const result = await build("2026-07", 2, true); // 2 merged PRs, below the default minSampleSize=5
    assert.equal(result.status, "insufficient_sample");
    assert.equal(result.leadTime, null);

    const json = renderJsonReport(result) as { lead_time: unknown; merged_pr_count: number };
    assert.equal(json.lead_time, null);
    assert.equal(json.merged_pr_count, 2, "merged_pr_count itself is still reported");

    const markdown = renderMarkdownReport(result);
    assert.ok(markdown.includes("PR lead time: n/a"));
    assert.ok(
      !/median \d/.test(markdown),
      "must not render a median/p90 computed from too few PRs",
    );
  });

  it("Markdown always shows n, a coverage summary, and the metadata as-of timestamp", async () => {
    const result = await build("2026-07", 6, true);
    const markdown = renderMarkdownReport(result);
    assert.ok(markdown.includes("Merged PRs (n):"));
    assert.ok(markdown.includes("### Coverage"));
    assert.ok(markdown.includes(result.honesty.metadata.asOf));
  });

  it("JSON always reports quality_status not_measured and never a 'quality maintained' claim anywhere", async () => {
    const result = await build("2026-07", 6, true);
    const json = renderJsonReport(result) as { honesty: { quality_status: string } };
    assert.equal(json.honesty.quality_status, "not_measured");
    const markdown = renderMarkdownReport(result);
    assert.ok(!markdown.includes("品質維持"));
    assert.ok(!/quality (was )?maintained/i.test(markdown));
  });

  it("neither rendered form contains a personal-dimension key or a per-PR-number breakdown", async () => {
    const result = await build("2026-07", 6, true);
    const json = renderJsonReport(result);
    assert.deepEqual(scanPersonalDimensions(json), []);
    assert.ok(!JSON.stringify(json).includes('"pr_number"'));
    const markdown = renderMarkdownReport(result);
    assert.ok(!/\bPR\s*#\d+\b/.test(markdown), "must not name an individual PR number");
  });
});

describe("renderJsonReport / renderMarkdownReport: comparison", () => {
  it("Markdown always includes the fixed correlation-caveat sentence when a comparison is rendered", async () => {
    const a = await build("2026-06", 6, true);
    const b = await build("2026-07", 8, true);
    const comparison = compareResults(a, b);
    const markdown = renderMarkdownReport(a, b, comparison);
    assert.ok(
      markdown.includes(
        "これは記述的な期間比較であり、AI利用による因果効果を示すものではない。品質は本レポートでは未測定。",
      ),
    );
  });

  it("the comparison JSON and Markdown reflect the exact same ComparisonResult", async () => {
    const a = await build("2026-06", 6, true);
    const b = await build("2026-07", 8, true);
    const comparison = compareResults(a, b);
    const json = renderJsonReport(a, b, comparison) as {
      comparison: { merged_pr_count: { change_percent: number | null } };
    };
    const markdown = renderMarkdownReport(a, b, comparison);
    if (json.comparison.merged_pr_count.change_percent !== null) {
      const pct = (json.comparison.merged_pr_count.change_percent * 100).toFixed(1);
      assert.ok(markdown.includes(`${pct}%`));
    }
  });

  it("still never generates a quality-maintained claim in a comparison, even though a summary sentence is auto-generated", async () => {
    const a = await build("2026-06", 6, true);
    const b = await build("2026-07", 8, true);
    const comparison = compareResults(a, b);
    const markdown = renderMarkdownReport(a, b, comparison);
    assert.ok(!markdown.includes("品質維持"));
    assert.ok(markdown.includes("品質は本レポートでは未測定"));
  });
});
