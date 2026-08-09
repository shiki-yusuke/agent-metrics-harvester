import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monthBucketOf, projectAggregateRecord } from "../../src/aggregates/schema.js";

const VALID_ATTRIBUTION = {
  generated_at: "2026-08-01T00:00:00Z",
  window: { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" },
  sessions: { exactly_attributed: 10, unbound: 2, mixed: 1, orphan: 0 },
  tokens: { exact_attributed: 5000, total_measured: 6000 },
  research_eligible: true,
  source_repo: "shiki-yusuke/spec-lane",
};

const VALID_CALIBRATION = {
  generated_at: "2026-08-01T00:00:00Z",
  intent_digest: "0123456789abcdef",
  predicted_p50: 1000,
  predicted_p80: 1500,
  actual_tokens: 1100,
  actual_cost_usd: 0.5,
  decision_status: "predicted",
  abstain_reasons: [],
  cohort_digest: "cohort-a",
};

const VALID_HEARTBEAT = { source: "workflow", at: "2026-08-01T00:00:00Z" };

describe("projectAggregateRecord", () => {
  it("accepts a well-formed attribution_audit_summary", () => {
    const result = projectAggregateRecord("attribution_audit_summary", VALID_ATTRIBUTION);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.record.kind, "attribution_audit_summary");
      assert.deepEqual(result.record, { kind: "attribution_audit_summary", ...VALID_ATTRIBUTION });
    }
  });

  it("accepts a well-formed calibration_point, including null predictions", () => {
    const input = { ...VALID_CALIBRATION, predicted_p50: null, predicted_p80: null };
    const result = projectAggregateRecord("calibration_point", input);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.record.kind, "calibration_point");
    }
  });

  it("accepts a well-formed heartbeat", () => {
    const result = projectAggregateRecord("heartbeat", VALID_HEARTBEAT);
    assert.equal(result.ok, true);
  });

  it("rejects an unsupported kind", () => {
    const result = projectAggregateRecord("something_else", VALID_HEARTBEAT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors[0] as string, /unsupported kind/);
  });

  it("rejects a non-object input", () => {
    const result = projectAggregateRecord("heartbeat", "not an object");
    assert.equal(result.ok, false);
  });

  it("rejects input containing a forbidden personal-dimension key, before projecting anything", () => {
    const tainted = { ...VALID_HEARTBEAT, author: "someone" };
    const result = projectAggregateRecord("heartbeat", tainted);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes("author")));
    }
  });

  it("rejects a forbidden key nested inside an object field", () => {
    const tainted = {
      ...VALID_ATTRIBUTION,
      window: { ...VALID_ATTRIBUTION.window, owner: "someone" },
    };
    const result = projectAggregateRecord("attribution_audit_summary", tainted);
    assert.equal(result.ok, false);
  });

  it("drops unrecognized fields instead of erroring", () => {
    const withExtra = { ...VALID_HEARTBEAT, extra_field: "should be dropped", another: 123 };
    const result = projectAggregateRecord("heartbeat", withExtra);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(Object.keys(result.record).sort(), ["at", "kind", "source"]);
    }
  });

  it("rejects a calibration_point with a malformed intent_digest", () => {
    const result = projectAggregateRecord("calibration_point", {
      ...VALID_CALIBRATION,
      intent_digest: "not-a-digest",
    });
    assert.equal(result.ok, false);
  });

  it("rejects a calibration_point with an invalid decision_status", () => {
    const result = projectAggregateRecord("calibration_point", {
      ...VALID_CALIBRATION,
      decision_status: "maybe",
    });
    assert.equal(result.ok, false);
  });

  it("rejects an attribution_audit_summary with a negative session count", () => {
    const result = projectAggregateRecord("attribution_audit_summary", {
      ...VALID_ATTRIBUTION,
      sessions: { ...VALID_ATTRIBUTION.sessions, orphan: -1 },
    });
    assert.equal(result.ok, false);
  });

  it("rejects a heartbeat with an invalid source", () => {
    const result = projectAggregateRecord("heartbeat", {
      source: "cron",
      at: "2026-08-01T00:00:00Z",
    });
    assert.equal(result.ok, false);
  });
});

describe("monthBucketOf", () => {
  it("derives YYYY-MM from generated_at for a data kind", () => {
    const result = projectAggregateRecord("attribution_audit_summary", VALID_ATTRIBUTION);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(monthBucketOf(result.record), "2026-08");
  });

  it("derives YYYY-MM from `at` for a heartbeat", () => {
    const result = projectAggregateRecord("heartbeat", {
      source: "workflow",
      at: "2026-12-31T23:59:59Z",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(monthBucketOf(result.record), "2026-12");
  });
});
