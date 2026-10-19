// M2 negative fixtures: nested dir candidates, pattern candidates, merge_sha null, and the other
// observation failures (done_overlay null, unreachable merge_sha, root commit).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparePaths } from "../../src/cognitive-debt/m2.js";
import {
  baseSpec,
  estimate,
  laneEvidenceDoc,
  runSpec,
} from "../support/cognitive-debt-fixtures.js";

function withCandidates(candidates: string[], changed: Record<string, string>) {
  const spec = baseSpec();
  spec.lane = [
    {
      date: "2026-01-01T00:00:00Z",
      files: {
        "README.md": "consumer\n",
        "docs/spec/L-1/estimate.json": estimate("L-1", [
          { estimated_at: "2026-01-01T00:00:00Z", candidate_paths: candidates },
        ]),
      },
    },
    { date: "2026-01-03T00:00:00Z", files: changed },
  ];
  return spec;
}

describe("cognitive-debt M2", () => {
  it("nested dirs: an observation belongs only to its longest dir; a parent with only child-dir hits is dir_unused", async () => {
    const spec = withCandidates(["src/", "src/deep/"], { "src/deep/x.ts": "x\n" });
    const { report } = await runSpec(spec, ["--detail"]);
    const d = report.m2_prediction_error.detail[0];
    assert.equal(d.status, "ok");
    assert.deepEqual(d.dir_hit, ["src/deep/"]);
    assert.deepEqual(d.dir_unused, ["src/"]);
    assert.deepEqual(d.dir_width, [
      { dir: "src/", observed_count: 0 },
      { dir: "src/deep/", observed_count: 1 },
    ]);
    assert.deepEqual(d.missed, []);
    assert.deepEqual(report.m2_prediction_error.overall.dir_width, {
      dirs: 2,
      observed_count_max: 1,
    });
  });

  it("pattern candidates are classified first, counted as unmatched_pattern, and never match", async () => {
    const spec = withCandidates(["src/*.ts", "src/a.ts", "lib/[ab].ts/"], {
      "src/a.ts": "a\n",
      "src/b.ts": "b\n",
    });
    const { report } = await runSpec(spec, ["--detail"]);
    const d = report.m2_prediction_error.detail[0];
    assert.deepEqual(d.unmatched_pattern, ["lib/[ab].ts/", "src/*.ts"]);
    assert.deepEqual(d.hit, ["src/a.ts"]);
    assert.deepEqual(d.missed, ["src/b.ts"]);
    assert.deepEqual(d.dir_hit, []);
    const sums = report.m2_prediction_error.overall.sums;
    assert.equal(sums.candidate_file, 1);
    assert.equal(sums.candidate_dir, 0);
    assert.equal(sums.unmatched_pattern, 2);
    // Count level counts files + dirs only (patterns excluded): 1 predicted vs 3 observed.
    assert.deepEqual(report.m2_prediction_error.overall.count_level.signed_error, {
      p50: -2,
      p90: -2,
      max: -2,
    });
  });

  it("merge_sha null: no observation, the count level still computes", async () => {
    const spec = baseSpec();
    spec.laneEvidence = () => ({ "L-1.json": laneEvidenceDoc("L-1", null) });
    const { report } = await runSpec(spec, ["--detail"]);
    const m2 = report.m2_prediction_error;
    assert.deepEqual(m2.missing.merge_sha_null, { count: 1, unit: "release_lane" });
    assert.equal(m2.population.units_with_observation, 0);
    assert.equal(m2.population.units_with_count_level, 1);
    assert.equal(m2.overall.missed_ratio, null);
    assert.equal(m2.detail[0].status, "merge_sha_null");
    assert.deepEqual(m2.detail[0].dir_width, []);
  });

  it("done_overlay null, unreachable merge_sha and a root merge_sha each get their own code", async () => {
    const cases: Array<[string, (shas: readonly string[]) => Record<string, unknown>]> = [
      [
        "done_overlay_null",
        () => ({ ...laneEvidenceDoc("L-1", null), artifacts: { done_overlay: null } }),
      ],
      ["merge_sha_unreachable", () => laneEvidenceDoc("L-1", "0".repeat(40))],
      // Not a 40-hex object id: refused before git sees it, even though git would resolve it.
      ["merge_sha_unreachable", () => laneEvidenceDoc("L-1", "HEAD")],
      ["merge_sha_unreachable", (shas) => laneEvidenceDoc("L-1", (shas[1] as string).slice(0, 12))],
      [
        "merge_sha_unreachable",
        (shas) => laneEvidenceDoc("L-1", (shas[1] as string).toUpperCase()),
      ],
      ["merge_sha_unreachable", () => laneEvidenceDoc("L-1", "-C/tmp")],
      ["root_commit", (shas) => laneEvidenceDoc("L-1", shas[0] as string)],
    ];
    for (const [code, doc] of cases) {
      const spec = baseSpec();
      spec.laneEvidence = (ctx) => ({ "L-1.json": doc(ctx.laneShas) });
      const { report } = await runSpec(spec, ["--detail"]);
      assert.deepEqual(
        report.m2_prediction_error.missing[code],
        { count: 1, unit: "release_lane" },
        code,
      );
      assert.equal(report.m2_prediction_error.detail[0].status, code);
    }
  });

  it("files_touched_observed null is its own missing code and leaves the count level empty", async () => {
    const spec = baseSpec();
    (spec.lane[0] as { files: Record<string, unknown> }).files["docs/spec/L-1/estimate.json"] =
      estimate("L-1", [
        {
          estimated_at: "2026-01-01T00:00:00Z",
          candidate_paths: ["src/a.ts"],
          files_touched_observed: null,
        },
      ]);
    const { report } = await runSpec(spec);
    const m2 = report.m2_prediction_error;
    assert.equal(m2.missing.files_touched_observed_null.count, 1);
    assert.equal(m2.overall.count_level.units, 0);
    assert.equal(m2.overall.count_level.signed_error, null);
  });

  it("comparePaths de-duplicates and byte-sorts every array", () => {
    const r = comparePaths(["b", "a", "a", "d/"], ["d/x", "a", "c", "c"]);
    assert.deepEqual(r.hit, ["a"]);
    assert.deepEqual(r.unused, ["b"]);
    assert.deepEqual(r.missed, ["c"]);
    assert.equal(r.observed, 3);
  });
});
