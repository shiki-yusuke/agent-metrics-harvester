// must-3 regression: input_fingerprint must actually change whenever any input that changes
// the cost-per-pr result changes -- period boundaries, repository set, the merged-PR set (the
// denominator/lead-time input), and the min-sample-size policy -- not just the snapshot set.
// "Same fingerprint" is only a sound proxy for "same result" if every branch/sum the
// computation depends on is covered.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FingerprintInput, computeInputFingerprint } from "../../src/report/fingerprint.js";

const BASE: FingerprintInput = {
  snapshots: [{ upsertKey: "am1_abc", markerSha: "a".repeat(64) }],
  periodStartUtc: "2026-07-01T00:00:00Z",
  periodEndUtc: "2026-08-01T00:00:00Z",
  repositories: ["octo/example"],
  mergedPrs: [{ repository: "octo/example", prNumber: 1, mergedAt: "2026-07-05T00:00:00Z" }],
  cacheVersion: "pr-metadata-cache/v1",
  minSampleSize: 5,
};

describe("computeInputFingerprint: determinism", () => {
  it("is deterministic for identical input, regardless of array order", () => {
    const a = computeInputFingerprint(BASE);
    const b = computeInputFingerprint({
      ...BASE,
      snapshots: [...BASE.snapshots],
      mergedPrs: [...BASE.mergedPrs],
      repositories: [...BASE.repositories],
    });
    assert.equal(a, b);
  });

  it("is order-independent across snapshots, merged PRs, and repositories", () => {
    const reordered: FingerprintInput = {
      ...BASE,
      snapshots: [{ upsertKey: "am1_zzz", markerSha: "b".repeat(64) }, ...BASE.snapshots],
      repositories: ["octo/zzz", ...BASE.repositories],
      mergedPrs: [
        { repository: "octo/zzz", prNumber: 9, mergedAt: "2026-07-06T00:00:00Z" },
        ...BASE.mergedPrs,
      ],
    };
    const forward = computeInputFingerprint(reordered);
    const backward = computeInputFingerprint({
      ...reordered,
      snapshots: [...reordered.snapshots].reverse(),
      repositories: [...reordered.repositories].reverse(),
      mergedPrs: [...reordered.mergedPrs].reverse(),
    });
    assert.equal(forward, backward);
  });
});

describe("computeInputFingerprint: sensitivity (must actually change when the input does)", () => {
  it("changes when the resolved period boundaries change", () => {
    const a = computeInputFingerprint(BASE);
    const b = computeInputFingerprint({ ...BASE, periodStartUtc: "2026-06-01T00:00:00Z" });
    assert.notEqual(a, b);
  });

  it("changes when the repository set changes", () => {
    const a = computeInputFingerprint(BASE);
    const b = computeInputFingerprint({ ...BASE, repositories: ["octo/other"] });
    assert.notEqual(a, b);
  });

  it("changes when the merged-PR set changes (a different denominator)", () => {
    const a = computeInputFingerprint(BASE);
    const b = computeInputFingerprint({
      ...BASE,
      mergedPrs: [
        ...BASE.mergedPrs,
        { repository: "octo/example", prNumber: 2, mergedAt: "2026-07-06T00:00:00Z" },
      ],
    });
    assert.notEqual(a, b);
  });

  it("changes when the min-sample-size policy changes", () => {
    const a = computeInputFingerprint(BASE);
    const b = computeInputFingerprint({ ...BASE, minSampleSize: 10 });
    assert.notEqual(a, b);
  });

  it("changes when the snapshot set changes", () => {
    const a = computeInputFingerprint(BASE);
    const b = computeInputFingerprint({
      ...BASE,
      snapshots: [{ upsertKey: "am1_different", markerSha: "c".repeat(64) }],
    });
    assert.notEqual(a, b);
  });

  it("changes when the cache version changes", () => {
    const a = computeInputFingerprint(BASE);
    const b = computeInputFingerprint({ ...BASE, cacheVersion: "pr-metadata-cache/v2" });
    assert.notEqual(a, b);
  });

  it("changes when the team-config hash changes (and differs from omitting it entirely)", () => {
    const withoutTeamConfig = computeInputFingerprint(BASE);
    const withTeamConfigA = computeInputFingerprint({ ...BASE, teamConfigHash: "hash-a" });
    const withTeamConfigB = computeInputFingerprint({ ...BASE, teamConfigHash: "hash-b" });
    assert.notEqual(withoutTeamConfig, withTeamConfigA);
    assert.notEqual(withTeamConfigA, withTeamConfigB);
  });
});
