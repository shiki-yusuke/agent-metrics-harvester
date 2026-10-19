// Release-chain negative fixtures (cognitive-debt-metrics/v0 design section 4): ambiguous
// bundle digest, bundle digest mismatch, lane_ref null, duplicated lane-evidence, and a lane whose
// only revisions were estimated after the release.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Revision, effectiveRevision } from "../../src/cognitive-debt/chain.js";
import { jcsDigest } from "../../src/cognitive-debt/jcs.js";
import { parseUtcTimestamp } from "../../src/cognitive-debt/time.js";
import {
  baseSpec,
  bundle,
  estimate,
  jsonl,
  laneEvidenceDoc,
  ledgerEvent,
  runSpec,
} from "../support/cognitive-debt-fixtures.js";

describe("cognitive-debt release chain", () => {
  it("ambiguous_bundle_digest: two events for one release with different digests", async () => {
    const spec = baseSpec();
    const b1 = bundle("R1", "L-1");
    const other = bundle("R1", "L-9");
    spec.ledger = [
      {
        date: "2026-01-10T00:00:00Z",
        files: {
          "bundles/r1.json": b1,
          "bundles/r1-other.json": other,
          "release-events.jsonl": jsonl([
            ledgerEvent("R1", jcsDigest(b1), 1),
            ledgerEvent("R1", jcsDigest(other), 2),
          ]),
        },
      },
    ];
    spec.releaseIds = ["R1"];
    const { code, report } = await runSpec(spec);
    assert.equal(code, 0);
    assert.deepEqual(report.missing.ambiguous_bundle_digest, { count: 1, unit: "release" });
    assert.equal(report.m2_prediction_error.population.resolved_releases, 0);
  });

  it("bundle digest mismatch: an event digest no bundle file hashes to is no_bundle", async () => {
    const spec = baseSpec();
    const b1 = bundle("R1", "L-1");
    spec.ledger = [
      {
        date: "2026-01-10T00:00:00Z",
        files: {
          // Same content, one extra key: the file's JCS digest differs from the event's digest.
          "bundles/r1.json": { ...b1, extra: true },
          "release-events.jsonl": jsonl([ledgerEvent("R1", jcsDigest(b1), 1)]),
        },
      },
    ];
    spec.releaseIds = ["R1"];
    const { report } = await runSpec(spec);
    assert.deepEqual(report.missing.no_bundle, { count: 1, unit: "release" });
    assert.equal(report.ack.population.resolved_releases, 0);
  });

  it("bundle_release_id_mismatch: the digest matches but the bundle names another release", async () => {
    const spec = baseSpec();
    const b = bundle("R-OTHER", "L-1");
    spec.ledger = [
      {
        date: "2026-01-10T00:00:00Z",
        files: {
          "bundles/x.json": b,
          "release-events.jsonl": jsonl([ledgerEvent("R1", jcsDigest(b), 1)]),
        },
      },
    ];
    spec.releaseIds = ["R1"];
    const { report } = await runSpec(spec);
    assert.deepEqual(report.missing.bundle_release_id_mismatch, { count: 1, unit: "release" });
  });

  it("lane_ref null: counted in M2 and coverage, not in the release-level missing", async () => {
    const spec = baseSpec();
    spec.releaseIds = ["R2"];
    const { report } = await runSpec(spec);
    for (const code of [
      "no_release_event",
      "ambiguous_bundle_digest",
      "no_bundle",
      "bundle_release_id_mismatch",
    ]) {
      assert.equal(report.missing[code].count, 0, code);
    }
    assert.deepEqual(report.m2_prediction_error.missing.no_lane_ref, { count: 1, unit: "release" });
    assert.equal(report.m2_prediction_error.population.release_lanes, 0);
    assert.equal(report.coverage.missing.releases_without_lane_scope.count, 1);
  });

  it("lane-evidence duplicated: two files with the same intent_id -> ambiguous_lane_evidence", async () => {
    const spec = baseSpec();
    spec.laneEvidence = (ctx) => ({
      "a.json": laneEvidenceDoc("L-1", ctx.laneShas[1] as string),
      "b.json": laneEvidenceDoc("L-1", ctx.laneShas[1] as string),
    });
    const { report } = await runSpec(spec, ["--detail"]);
    const m2 = report.m2_prediction_error;
    assert.deepEqual(m2.missing.ambiguous_lane_evidence, { count: 1, unit: "release" });
    assert.equal(m2.population.units_with_observation, 0);
    // The prediction side is independent of lane-evidence: the count level still computes.
    assert.equal(m2.population.units_with_prediction, 1);
    assert.equal(m2.population.units_with_count_level, 1);
    assert.deepEqual(m2.detail, []);
  });

  it("lane-evidence file names are not the join key", async () => {
    const spec = baseSpec();
    spec.laneEvidence = (ctx) => ({
      "L-1.json": laneEvidenceDoc("L-OTHER", ctx.laneShas[1] as string),
    });
    const { report } = await runSpec(spec);
    assert.deepEqual(report.m2_prediction_error.missing.no_lane_evidence, {
      count: 1,
      unit: "release",
    });
  });

  it("only revisions estimated after T_release -> no_revision_before_release, no lane scope", async () => {
    const spec = baseSpec();
    (spec.lane[0] as { files: Record<string, unknown> }).files["docs/spec/L-1/estimate.json"] =
      estimate("L-1", [{ estimated_at: "2026-01-20T00:00:00Z", candidate_paths: ["src/a.ts"] }]);
    const { report } = await runSpec(spec, ["--detail"]);
    const m2 = report.m2_prediction_error;
    assert.deepEqual(m2.missing.no_revision_before_release, { count: 1, unit: "release_lane" });
    assert.equal(m2.population.units_with_prediction, 0);
    assert.equal(m2.overall.sums.observed, 0);
    assert.equal(m2.detail[0].status, "no_revision_before_release");
    assert.deepEqual(m2.detail[0].hit, []);
    assert.equal(report.coverage.population.approvals_in_denominator, 0);
    assert.equal(report.coverage.missing.releases_without_lane_scope.count, 2);
  });

  it("estimate intent_id must equal the lane id", async () => {
    const spec = baseSpec();
    (spec.lane[0] as { files: Record<string, unknown> }).files["docs/spec/L-1/estimate.json"] =
      estimate(
        "L-1",
        [{ estimated_at: "2026-01-01T00:00:00Z", candidate_paths: ["src/a.ts"] }],
        "L-ELSEWHERE",
      );
    const { report } = await runSpec(spec);
    assert.deepEqual(report.m2_prediction_error.missing.estimate_intent_mismatch, {
      count: 1,
      unit: "release",
    });
  });

  it("an estimated_at without the trailing Z is not a time: the revision is not a candidate", async () => {
    const spec = baseSpec();
    (spec.lane[0] as { files: Record<string, unknown> }).files["docs/spec/L-1/estimate.json"] =
      estimate("L-1", [{ estimated_at: "2026-01-01T00:00:00", candidate_paths: ["src/a.ts"] }]);
    const { report } = await runSpec(spec);
    assert.deepEqual(report.m2_prediction_error.missing.no_revision_before_release, {
      count: 1,
      unit: "release_lane",
    });
  });

  it("an estimated_at that is not a real calendar time is not a candidate either", async () => {
    const spec = baseSpec();
    (spec.lane[0] as { files: Record<string, unknown> }).files["docs/spec/L-1/estimate.json"] =
      estimate("L-1", [
        { estimated_at: "2026-01-01T00:00:00Z", candidate_paths: ["src/a.ts"], digest: "early" },
        { estimated_at: "2026-01-09T24:00:00Z", candidate_paths: ["src/b.ts"], digest: "late" },
      ]);
    const { report } = await runSpec(spec, ["--detail"]);
    assert.deepEqual(report.m2_prediction_error.detail[0].hit, ["src/a.ts"]);
  });

  it("effectiveRevision takes the later estimated_at even when only the 9th fraction digit differs", () => {
    const revision = (index: number, estimated_at: string): Revision => ({
      index,
      estimatedAt: parseUtcTimestamp(estimated_at),
      snapshot: {
        repo_commit: "c".repeat(40),
        digest: `sha256:${"d".repeat(64)}`,
        candidate_paths: [],
      },
      risk_class: "low",
      files_touched_observed: null,
    });
    const revisions = [
      revision(0, "2026-01-15T00:00:00.000000001Z"),
      revision(1, "2026-01-15T00:00:00.000000000Z"),
    ];
    const tRelease = parseUtcTimestamp("2026-01-16T00:00:00Z");
    // As epoch-ms floats both times are equal, so the old reader fell to the later position (index 1).
    const rev = effectiveRevision({ lane_id: "L-1", intent_id: "L-1", revisions }, tRelease);
    assert.equal(rev?.index, 0);
  });
});
