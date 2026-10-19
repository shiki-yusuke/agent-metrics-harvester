// M1 negative fixtures: a reopened assertion, non-monotonic committer dates, a dropped
// explanation, and a malformed file that must neither continue nor end an episode.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXP_1, baseSpec, explanation, runSpec } from "../support/cognitive-debt-fixtures.js";

const FILE = `explanations/${EXP_1}.json`;

describe("cognitive-debt M1", () => {
  it("re-appearance: uncovered -> covered -> uncovered is two episodes, reopened_count 1", async () => {
    const spec = baseSpec();
    spec.corpus = [
      { date: "2026-01-02T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p"], []) } },
      { date: "2026-01-03T00:00:00Z", files: { [FILE]: explanation(EXP_1, [], ["p"]) } },
      { date: "2026-01-05T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p"], []) } },
    ];
    const { report } = await runSpec(spec);
    const m1 = report.m1_open_assertions.overall;
    assert.equal(m1.population.episodes, 2);
    assert.equal(m1.population.assertions, 1);
    assert.equal(m1.reopened_count, 1);
    assert.equal(m1.covered, 1);
    assert.equal(m1.open, 1);
    assert.deepEqual(m1.oldest, [
      { explanation_id: EXP_1, path: "p", since: "2026-01-05T00:00:00Z" },
    ]);
    assert.deepEqual(m1.open_age_days, { p50: 27, p90: 27, max: 27 });
  });

  it("non-monotonic dates: an end before its start is counted and kept out of the age distribution", async () => {
    const spec = baseSpec();
    spec.asOf = "2026-01-04T00:00:00Z";
    spec.corpus = [
      // Committed with a date AFTER as_of, under a HEAD dated before it.
      { date: "2026-01-06T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p", "q"], []) } },
      { date: "2026-01-03T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["q"], ["p"]) } },
    ];
    const { report } = await runSpec(spec);
    const m1 = report.m1_open_assertions.overall;
    assert.equal(m1.population.episodes, 2);
    assert.equal(m1.covered, 1);
    assert.equal(m1.open, 1);
    assert.equal(m1.excluded_non_monotonic, 2);
    assert.equal(m1.open_age_days, null);
  });

  it("an explanation removed from the tree ends its episodes as dropped (censored)", async () => {
    const spec = baseSpec();
    spec.corpus = [
      { date: "2026-01-02T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p"], []) } },
      { date: "2026-01-03T00:00:00Z", files: { [FILE]: null, "explanations/.keep": "" } },
    ];
    const { report } = await runSpec(spec);
    const m1 = report.m1_open_assertions.overall;
    assert.equal(m1.dropped, 1);
    assert.equal(m1.open, 0);
    // The ack scope references EXP_1, which existed before as_of but is absent at as_of.
    assert.equal(report.ack.overall.explanation_missing.explanation_absent_at_as_of, 1);
    assert.equal(report.ack.overall.explanation_missing.explanation_never_existed, 0);
  });

  it("a malformed file is state-unknown: counted, and it neither ends nor continues an episode", async () => {
    const spec = baseSpec();
    spec.corpus = [
      { date: "2026-01-02T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p"], []) } },
      { date: "2026-01-03T00:00:00Z", files: { [FILE]: "{not json" } },
      { date: "2026-01-04T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p"], []) } },
    ];
    const { report } = await runSpec(spec);
    const m1 = report.m1_open_assertions;
    assert.deepEqual(m1.malformed, { files: 1, commits: 1 });
    assert.equal(m1.overall.population.episodes, 1);
    assert.equal(m1.overall.dropped, 0);
    assert.deepEqual(m1.overall.oldest[0].since, "2026-01-02T00:00:00Z");
  });

  it("an ack scope naming an explanation the corpus never had is explanation_never_existed", async () => {
    const spec = baseSpec();
    spec.corpus = [{ date: "2026-01-02T00:00:00Z", files: { "README.md": "empty corpus\n" } }];
    const { report } = await runSpec(spec);
    assert.equal(report.m1_open_assertions.overall.population.episodes, 0);
    assert.equal(report.m1_open_assertions.overall.open_age_days, null);
    assert.equal(report.ack.overall.explanation_missing.explanation_never_existed, 1);
  });

  it("a path that leaves both lists of a present explanation is state-unknown, never dropped", async () => {
    const spec = baseSpec();
    spec.corpus = [
      { date: "2026-01-02T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p", "q"], []) } },
      { date: "2026-01-03T00:00:00Z", files: { [FILE]: explanation(EXP_1, [], []) } },
      { date: "2026-01-04T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["p"], []) } },
    ];
    const { report } = await runSpec(spec);
    const m1 = report.m1_open_assertions;
    assert.deepEqual(m1.malformed, { files: 0, commits: 0 });
    assert.equal(m1.overall.dropped, 0);
    assert.equal(m1.overall.covered, 0);
    // p continues through the unknown commit; q is never resolved either way, so it stays open.
    assert.equal(m1.overall.population.episodes, 2);
    assert.equal(m1.overall.open, 2);
    assert.equal(m1.overall.reopened_count, 0);
    assert.deepEqual(m1.overall.oldest, [
      { explanation_id: EXP_1, path: "p", since: "2026-01-02T00:00:00Z" },
      { explanation_id: EXP_1, path: "q", since: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("only explanations/EXP-<16 hex>.json files are read; other .json files are not even malformed", async () => {
    const spec = baseSpec();
    spec.corpus = [
      {
        date: "2026-01-02T00:00:00Z",
        files: {
          [FILE]: explanation(EXP_1, ["p"], []),
          "explanations/notes.json": "{not json",
          "explanations/EXP-000000000000000A.json": explanation("EXP-000000000000000a", ["q"], []),
          "explanations/other.json": explanation("EXP-0000000000000002", ["r"], []),
        },
      },
    ];
    const { report } = await runSpec(spec);
    const m1 = report.m1_open_assertions;
    assert.deepEqual(m1.malformed, { files: 0, commits: 0 });
    assert.equal(m1.overall.population.episodes, 1);
    assert.equal(m1.overall.population.explanations_seen, 1);
  });

  it("a non-well-formed string reaching the output stops the run: exit 1, one stderr line, no file", async () => {
    const spec = baseSpec();
    spec.corpus = [
      { date: "2026-01-02T00:00:00Z", files: { [FILE]: explanation(EXP_1, ["\uD800"], []) } },
    ];
    const { code, stderr, bytes } = await runSpec(spec);
    assert.equal(code, 1);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0] as string, /non-well-formed string/);
    assert.equal(bytes, null);
  });
});
