import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AttributionAuditSummaryRecord,
  CalibrationPointRecord,
  HeartbeatRecord,
} from "../../src/aggregates/types.js";
import type { StoredSnapshot } from "../../src/application/types.js";
import { computeDashboardData } from "../../src/dashboard/compute.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

function snapshot(overrides: Partial<StoredSnapshot> = {}, payloadOpts = {}): StoredSnapshot {
  return {
    upsertKey: "key-1",
    repository: "octo/example",
    payload: makeTokenUsagePayload(payloadOpts),
    sourceCommentId: 1,
    sourceUpdatedAt: "2026-08-01T00:00:00Z",
    markerSha: "sha",
    ...overrides,
  };
}

const NOW = new Date("2026-08-15T00:00:00Z");

describe("computeDashboardData: empty inputs", () => {
  it("returns all-empty panels, never throwing, with null (not zero) missingRate", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.cost.meta.n, 0);
    assert.equal(data.cost.meta.missingRate, null);
    assert.deepEqual(data.cost.groups, []);

    assert.equal(data.calibration.meta.n, 0);
    assert.equal(data.calibration.meta.missingRate, null);
    assert.equal(data.calibration.sampleStatus, "insufficient_data");
    assert.equal(data.calibration.averageRatioToP50, null);

    assert.equal(data.attribution.meta.n, 0);
    assert.equal(data.attribution.latestResearchEligible, null);

    assert.equal(data.freshness.pipelineHeartbeatAt, null);
    assert.equal(data.freshness.lastValidEventAt, null);
    assert.equal(data.freshness.meta.missingRate, null);

    assert.equal(data.cohort.meta.n, 0);
    assert.deepEqual(data.cohort.groups, []);
    assert.match(data.cohort.caveat, /因果比較は不可/);
  });
});

describe("computeDashboardData: cost panel", () => {
  it("never treats an all-unpriced group's cost as $0 -- null instead", () => {
    const unpricedPayload = makeTokenUsagePayload({ generatedAt: "2026-08-05T00:00:00Z" });
    const baseRecord = unpricedPayload.data.records[0];
    assert.ok(baseRecord);
    // Override the single record to be unpriced instead of priced.
    const payload = {
      ...unpricedPayload,
      data: {
        ...unpricedPayload.data,
        records: [
          {
            activity: baseRecord.activity,
            agent: baseRecord.agent,
            model: baseRecord.model,
            token_kind: baseRecord.token_kind,
            tokens: baseRecord.tokens,
            pricing_status: "unpriced" as const,
          },
        ],
      },
    };
    const data = computeDashboardData({
      snapshots: [snapshot({ payload })],
      attributionAuditSummaries: [],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.cost.groups.length, 1);
    assert.equal(data.cost.groups[0]?.totalCostUsd, null);
    assert.equal(
      data.cost.groups[0]?.knownCostLowerBoundUsd,
      null,
      "nothing priced at all -- no lower bound either",
    );
    assert.equal(data.cost.groups[0]?.unpricedCount, 1);
    assert.equal(data.cost.meta.missingRate, 1);
  });

  it("never shows a partial priced sum as a complete total -- null total + a lower bound instead (must-2 regression)", () => {
    const basePayload = makeTokenUsagePayload({ generatedAt: "2026-08-05T00:00:00Z" });
    const baseRecord = basePayload.data.records[0];
    assert.ok(baseRecord);
    const payload = {
      ...basePayload,
      data: {
        ...basePayload.data,
        records: [
          {
            activity: baseRecord.activity,
            agent: baseRecord.agent,
            model: baseRecord.model,
            token_kind: baseRecord.token_kind,
            tokens: baseRecord.tokens,
            pricing_status: "priced" as const,
            estimated_cost_usd: 2,
          },
          {
            // priced, but missing its own cost figure -- the group's true total is unknown,
            // not "whatever the other record happened to sum to."
            activity: baseRecord.activity,
            agent: baseRecord.agent,
            model: baseRecord.model,
            token_kind: baseRecord.token_kind,
            tokens: baseRecord.tokens,
            pricing_status: "priced" as const,
          },
        ],
      },
    };
    const data = computeDashboardData({
      snapshots: [snapshot({ payload })],
      attributionAuditSummaries: [],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    const group = data.cost.groups[0];
    assert.ok(group);
    assert.equal(group.pricedCount, 2);
    assert.equal(group.pricedMissingCostCount, 1);
    assert.equal(
      group.totalCostUsd,
      null,
      "an incomplete priced sum must not be shown as the total",
    );
    assert.equal(
      group.knownCostLowerBoundUsd,
      2,
      "the known partial sum is still exposed, as a lower bound",
    );
  });

  it("groups by repo x month and sums only priced costs with a defined figure", () => {
    const s1 = snapshot(
      { repository: "octo/a", upsertKey: "a" },
      { generatedAt: "2026-08-01T00:00:00Z", estimatedCostUsd: 1 },
    );
    const s2 = snapshot(
      { repository: "octo/a", upsertKey: "b" },
      { generatedAt: "2026-08-20T00:00:00Z", estimatedCostUsd: 2 },
    );
    const s3 = snapshot(
      { repository: "octo/b", upsertKey: "c" },
      { generatedAt: "2026-09-01T00:00:00Z", estimatedCostUsd: 5 },
    );
    const data = computeDashboardData({
      snapshots: [s1, s2, s3],
      attributionAuditSummaries: [],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    const groups = data.cost.groups;
    assert.equal(groups.length, 2);
    const augustA = groups.find((g) => g.repo === "octo/a" && g.month === "2026-08");
    assert.ok(augustA);
    assert.equal(augustA?.totalCostUsd, 3);
    assert.equal(augustA?.recordCount, 2);
    const septemberB = groups.find((g) => g.repo === "octo/b" && g.month === "2026-09");
    assert.equal(septemberB?.totalCostUsd, 5);
  });
});

describe("computeDashboardData: calibration panel", () => {
  function point(overrides: Partial<CalibrationPointRecord>): CalibrationPointRecord {
    return {
      kind: "calibration_point",
      generated_at: "2026-08-01T00:00:00Z",
      intent_digest: "0123456789abcdef",
      predicted_p50: 1000,
      predicted_p80: 1500,
      actual_tokens: 1000,
      actual_cost_usd: 0.1,
      decision_status: "predicted",
      abstain_reasons: [],
      cohort_digest: "cohort-a",
      ...overrides,
    };
  }

  it("reports insufficient_data and withholds the average below the sample floor", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: [point({}), point({})],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.calibration.sampleStatus, "insufficient_data");
    assert.equal(data.calibration.averageRatioToP50, null);
    // The per-row table is still populated even though the aggregate is withheld.
    assert.equal(data.calibration.predictedRows.length, 2);
  });

  it("computes an average ratio once the sample floor is met", () => {
    const points = Array.from({ length: 5 }, () =>
      point({ predicted_p50: 1000, actual_tokens: 1000 }),
    );
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: points,
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.calibration.sampleStatus, "ok");
    assert.equal(data.calibration.averageRatioToP50, 1);
  });

  it("keeps abstained points out of predictedRows and tallies their reasons", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: [
        point({ decision_status: "abstained", abstain_reasons: ["low_confidence"] }),
        point({ decision_status: "abstained", abstain_reasons: ["low_confidence", "no_history"] }),
      ],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.calibration.predictedRows.length, 0);
    assert.equal(data.calibration.abstainedCount, 2);
    assert.deepEqual(data.calibration.abstainReasonCounts, {
      low_confidence: 2,
      no_history: 1,
    });
  });

  it("leaves ratioToP50 null (not a computed number) when predicted_p50 is null", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: [point({ predicted_p50: null })],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.calibration.predictedRows[0]?.ratioToP50, null);
    assert.equal(data.calibration.meta.missingRate, 1);
  });

  it("counts p50-missing and p80-missing rows independently, and meta.missingRate counts 'either' (should-1 regression)", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: [
        point({ predicted_p50: null, predicted_p80: 1500 }), // p50 missing, p80 present
        point({ predicted_p50: 1000, predicted_p80: null }), // p80 missing, p50 present
        point({ predicted_p50: 1000, predicted_p80: 1500 }), // both present
      ],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.calibration.missingP50Count, 1, "only the first row is missing p50");
    assert.equal(data.calibration.missingP80Count, 1, "only the second row is missing p80");
    // 2 of 3 rows are missing at least one of the two -- not derivable from either count alone
    // (1 + 1 would double-count if a row were missing both, and would undercount if it weren't
    // the same two rows -- this asserts the "either" definition directly).
    assert.equal(data.calibration.meta.missingRate, 2 / 3);
  });
});

describe("computeDashboardData: attribution panel", () => {
  function summary(
    overrides: Partial<AttributionAuditSummaryRecord>,
  ): AttributionAuditSummaryRecord {
    return {
      kind: "attribution_audit_summary",
      generated_at: "2026-08-01T00:00:00Z",
      window: { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" },
      sessions: { exactly_attributed: 8, unbound: 1, mixed: 1, orphan: 0 },
      tokens: { exact_attributed: 900, total_measured: 1000 },
      research_eligible: true,
      source_repo: "octo/example",
      ...overrides,
    };
  }

  it("computes a null (not zero) token ratio when total_measured is 0", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [summary({ tokens: { exact_attributed: 0, total_measured: 0 } })],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.attribution.timeSeries[0]?.exactAttributedTokenRatio, null);
    assert.equal(data.attribution.meta.missingRate, 1);
  });

  it("reports the chronologically-latest research_eligible", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [
        summary({ generated_at: "2026-08-01T00:00:00Z", research_eligible: true }),
        summary({ generated_at: "2026-08-10T00:00:00Z", research_eligible: false }),
      ],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.attribution.latestResearchEligible, false);
  });
});

describe("computeDashboardData: freshness panel", () => {
  function heartbeat(overrides: Partial<HeartbeatRecord>): HeartbeatRecord {
    return { kind: "heartbeat", source: "workflow", at: "2026-08-14T00:00:00Z", ...overrides };
  }

  it("takes the max workflow heartbeat as pipelineHeartbeatAt, ignoring local-push", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: [],
      heartbeats: [
        heartbeat({ at: "2026-08-01T00:00:00Z" }),
        heartbeat({ at: "2026-08-10T00:00:00Z" }),
        heartbeat({ source: "local-push", at: "2026-08-20T00:00:00Z" }),
      ],
      now: NOW,
    });
    assert.equal(data.freshness.pipelineHeartbeatAt, "2026-08-10T00:00:00Z");
  });

  it("keeps lastValidEventAt independent of pipelineHeartbeatAt", () => {
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [
        {
          kind: "attribution_audit_summary",
          generated_at: "2026-08-12T00:00:00Z",
          window: { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" },
          sessions: { exactly_attributed: 1, unbound: 0, mixed: 0, orphan: 0 },
          tokens: { exact_attributed: 1, total_measured: 1 },
          research_eligible: true,
          source_repo: "octo/example",
        },
      ],
      calibrationPoints: [],
      heartbeats: [],
      now: NOW,
    });
    assert.equal(data.freshness.pipelineHeartbeatAt, null);
    assert.equal(data.freshness.lastValidEventAt, "2026-08-12T00:00:00Z");
  });
});

describe("computeDashboardData: cohort panel", () => {
  it("groups by cohort_digest and always carries the fixed caveat", () => {
    const point = (cohort: string, cost: number): CalibrationPointRecord => ({
      kind: "calibration_point",
      generated_at: "2026-08-01T00:00:00Z",
      intent_digest: "0123456789abcdef",
      predicted_p50: 1000,
      predicted_p80: 1500,
      actual_tokens: 1000,
      actual_cost_usd: cost,
      decision_status: "predicted",
      abstain_reasons: [],
      cohort_digest: cohort,
    });
    const data = computeDashboardData({
      snapshots: [],
      attributionAuditSummaries: [],
      calibrationPoints: [point("cohort-a", 1), point("cohort-a", 2), point("cohort-b", 5)],
      heartbeats: [],
      now: NOW,
    });
    assert.deepEqual(
      data.cohort.groups.map((g) => [g.cohortDigest, g.recordCount, g.totalActualCostUsd]),
      [
        ["cohort-a", 2, 3],
        ["cohort-b", 1, 5],
      ],
    );
    assert.match(data.cohort.caveat, /因果比較は不可/);
  });
});
