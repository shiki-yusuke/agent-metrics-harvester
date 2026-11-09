// M3 computed path over temp git repos (spec B7; design 1, 2.3, 4). Every pair is a golden
// upstream replay pair re-pointed at a fixture release with digests recomputed by the harvester's
// JCS (test/support/m3-pairs.ts). baseSpec: R1 and R2 resolve, R3 has no release event; as_of is
// 2026-02-01T00:00:00Z.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { serializeOutput } from "../../src/cognitive-debt/jcs.js";
import {
  type CommitSpec,
  type Scenario,
  buildScenario,
  runScenario,
} from "../support/cognitive-debt-fixtures.js";
import {
  EVAL_DATE,
  INVALID_CUTS,
  type Json,
  OTHER_DIGEST,
  type Pair,
  type PairOptions,
  R1_DIGEST,
  R2_DIGEST,
  VALID_CUTS,
  WRONG_DIGEST,
  expectedMissing,
  m3Spec,
  makePair,
  pairFiles,
  r2Valid,
} from "../support/m3-pairs.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed report under test
async function runM3(evaluations: CommitSpec[], dirty?: (s: Scenario) => void): Promise<any> {
  const s = buildScenario(m3Spec(evaluations));
  try {
    dirty?.(s);
    const r = await runScenario(s);
    assert.equal(r.code, 0, r.stderr.join("\n"));
    return r.report;
  } finally {
    s.cleanup();
  }
}

/** One commit: the R2 baseline valid pair plus `files`. */
function oneCommit(files: Record<string, unknown>): CommitSpec[] {
  return [
    {
      date: EVAL_DATE,
      files: { ...pairFiles("r2-valid", r2Valid()), ...(files as CommitSpec["files"]) },
    },
  ];
}

// biome-ignore lint/suspicious/noExplicitAny: parsed report under test
function assertOnly(report: any, code: string): void {
  const m3 = report.m3_abstain_reasons;
  assert.equal(m3.status, "computed");
  assert.deepEqual(m3.missing, expectedMissing({ [code]: 1 }));
  assert.deepEqual(m3.population, { resolved_releases: 2, evaluated_releases: 1, evaluations: 1 });
}

const r1 = (
  template: "evaluated" | "unknown" | "invalid_input" = "evaluated",
  opts: Partial<PairOptions> = {},
) => makePair(template, { bundleDigest: R1_DIGEST, cut: "2026-01-10T00:00:00Z", ...opts });

const extraField = (doc: Json) => {
  doc.not_a_field = 1;
};

describe("cognitive-debt M3 computed: positive fixture (spec B7 正例)", () => {
  it("2 releases x 4 valid pairs: every field equals the hand-written expectation", async () => {
    // Spec B7 asks for 3 pairs (evaluated / unknown / invalid_input) that together carry an
    // abstained, a null and a non-abstained candidate_receipt. The vendored schema allows a
    // receipt only on `evaluated` (allOf: unknown / invalid_input -> candidate_receipt null), so
    // 3 pairs cannot carry both receipt kinds; a 2nd evaluated pair (verdict "ineligible")
    // makes it 4.
    const evaluatedAbstained = makePair("evaluated", {
      bundleDigest: R1_DIGEST,
      cut: "2025-12-20T00:00:00Z",
    });
    const unknown = makePair("unknown", { bundleDigest: R1_DIGEST, cut: "2026-01-10T00:00:00Z" });
    const invalidInput = makePair("invalid_input", {
      bundleDigest: R2_DIGEST,
      cut: "2026-01-15T00:00:00Z",
    });
    const evaluatedIneligible = makePair("evaluated", {
      bundleDigest: R2_DIGEST,
      cut: "2025-12-21T00:00:00Z",
      verdict: "ineligible",
      mutateEvaluation: (e) => {
        const o = e.predicate_observations.find(
          (p: Json) => p.predicate_id === "privilege_boundary",
        );
        o.applicability = "not_applicable";
        o.reason = { code: "not_applicable_by_policy", params: {} };
      },
    });
    const report = await runM3([
      {
        date: EVAL_DATE,
        files: {
          ...pairFiles("r1-evaluated", evaluatedAbstained),
          ...pairFiles("r1-unknown", unknown),
          ...pairFiles("r2-invalid-input", invalidInput),
          ...pairFiles("r2-evaluated", evaluatedIneligible),
        },
      },
    ]);
    assert.deepEqual(report.m3_abstain_reasons, {
      status: "computed",
      reason: null,
      population: { resolved_releases: 2, evaluated_releases: 2, evaluations: 4 },
      missing: expectedMissing(),
      evaluation_status: { evaluated: 2, invalid_input: 1, unknown: 1 },
      by_code_evaluation: {
        input_error: { digest_mismatch: 1, record_invalid: 0, unsupported_record_version: 0 },
        unknown: {
          lane_ref_omitted: 0,
          not_applicable_by_policy: 0,
          not_yet_recorded: 0,
          referent_unresolved: 0,
          unknown_structural: 1,
        },
      },
      by_predicate: {
        preview_verified: { unknown_structural: 2 },
        privilege_boundary: { unknown_structural: 1 },
        rollback_target_valid: { referent_unresolved: 2 },
      },
      not_applicable: { privilege_boundary: 1 },
      abstained: 1,
      no_candidate_receipt: 2,
      // Two months with 2 evaluations each: both rows are below min_cell (design section 0:
      // M3 by_month, unit = evaluation record).
      by_month: {},
    });
    const m3Suppressed = Object.fromEntries(
      Object.entries(report.suppressed_rows).filter(([k]) => k.startsWith("m3.")),
    );
    assert.deepEqual(m3Suppressed, {
      "m3.by_month.2025-12": { reason: "min_cell", unit: "evaluation", n_lt: 5 },
      "m3.by_month.2026-01": { reason: "min_cell", unit: "evaluation", n_lt: 5 },
    });
  });

  it("a month with >= 5 evaluations keeps its row; top level and month rows have the exact key sets", async () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      Object.assign(
        files,
        pairFiles(
          `jan-${i}`,
          r1(i % 2 === 0 ? "evaluated" : "invalid_input", { cut: `2026-01-1${i}T00:00:00Z` }),
        ),
      );
    }
    Object.assign(files, pairFiles("dec", r1("unknown", { cut: "2025-12-01T00:00:00Z" })));
    const report = await runM3([{ date: EVAL_DATE, files: files as CommitSpec["files"] }]);
    const m3 = report.m3_abstain_reasons;
    assert.deepEqual(Object.keys(m3.by_month), ["2026-01"]);
    assert.deepEqual(report.suppressed_rows["m3.by_month.2025-12"], {
      reason: "min_cell",
      unit: "evaluation",
      n_lt: 5,
    });
    const rowKeys = [
      "abstained",
      "by_code_evaluation",
      "by_predicate",
      "evaluation_status",
      "no_candidate_receipt",
      "not_applicable",
    ];
    const month = m3.by_month["2026-01"];
    assert.deepEqual(Object.keys(month), rowKeys);
    for (const row of [m3, month]) {
      assert.deepEqual(Object.keys(row.evaluation_status), [
        "evaluated",
        "invalid_input",
        "unknown",
      ]);
      assert.deepEqual(Object.keys(row.by_code_evaluation), ["input_error", "unknown"]);
      assert.deepEqual(Object.keys(row.by_code_evaluation.unknown), [
        "lane_ref_omitted",
        "not_applicable_by_policy",
        "not_yet_recorded",
        "referent_unresolved",
        "unknown_structural",
      ]);
      assert.deepEqual(Object.keys(row.by_code_evaluation.input_error), [
        "digest_mismatch",
        "record_invalid",
        "unsupported_record_version",
      ]);
    }
    assert.deepEqual(month.evaluation_status, { evaluated: 3, invalid_input: 2, unknown: 0 });
    assert.equal(month.abstained, 3);
    assert.equal(month.no_candidate_receipt, 2);
    assert.deepEqual(month.by_predicate, {
      preview_verified: { unknown_structural: 3 },
      privilege_boundary: { unknown_structural: 3 },
      rollback_target_valid: { referent_unresolved: 3 },
    });
    assert.deepEqual(m3.evaluation_status, { evaluated: 3, invalid_input: 2, unknown: 1 });
    assert.deepEqual(m3.population, {
      resolved_releases: 2,
      evaluated_releases: 1,
      evaluations: 6,
    });
    assert.deepEqual(m3.missing, expectedMissing({ no_evaluation: 1 }));
  });
});

describe("cognitive-debt M3 computed: design section 4 evaluation-pair negatives", () => {
  it("評価ペア欠落: R1 has no pair -> no_evaluation 1 (release unit)", async () => {
    const report = await runM3(oneCommit({}));
    assertOnly(report, "no_evaluation");
  });

  it("evaluation.json 欠落: input.json attributed to R1 alone -> no_evaluation_output", async () => {
    assertOnly(
      await runM3(oneCommit(pairFiles("p", r1(), { evaluation: false }))),
      "no_evaluation_output",
    );
  });

  it("別 commit 導入: input.json and evaluation.json added in different commits -> evaluation_pair_unbound", async () => {
    const pair = r1();
    const report = await runM3([
      ...oneCommit(pairFiles("p", pair, { evaluation: false })),
      { date: "2026-01-06T00:00:00Z", files: pairFiles("p", pair, { input: false }) },
    ]);
    assertOnly(report, "evaluation_pair_unbound");
  });

  it("導入後の変更: evaluation.json re-committed with whitespace only -> every digest passes, evaluation_pair_unbound", async () => {
    const pair = r1();
    const report = await runM3([
      ...oneCommit(pairFiles("p", pair)),
      {
        date: "2026-01-06T00:00:00Z",
        files: pairFiles("p", pair, {
          input: false,
          evaluation: `${JSON.stringify(pair.evaluation)}\n`,
        }),
      },
    ]);
    assertOnly(report, "evaluation_pair_unbound");
  });

  it("record_digest 不一致 -> evaluation_record_digest_mismatch", async () => {
    const pair = r1("evaluated", {
      afterRecordDigest: (e: Json) => {
        e.record_digest = WRONG_DIGEST;
      },
    });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_record_digest_mismatch");
  });

  for (const [field, value] of [
    ["bundle_digest", OTHER_DIGEST],
    ["selection_manifest_digest", OTHER_DIGEST],
    ["target", "staging"],
  ] as const) {
    it(`subject 不一致 (candidate_receipt.subject.${field}) -> evaluation_subject_mismatch`, async () => {
      const pair = r1("evaluated", {
        mutateEvaluation: (e: Json) => {
          e.candidate_receipt.subject[field] = value;
        },
      });
      assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_subject_mismatch");
    });
  }

  it("cut 不一致 -> evaluation_cut_mismatch", async () => {
    const pair = r1("evaluated", {
      mutateEvaluation: (e: Json) => {
        e.evaluation_cut = "2026-01-11T00:00:00Z";
      },
    });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_cut_mismatch");
  });

  it("contract_pin 不一致 -> contract_pin_mismatch", async () => {
    const pair = r1("evaluated", {
      mutateEvaluation: (e: Json) => {
        e.evaluator.playbook_contract_commit = "0000000000000000000000000000000000000000";
      },
    });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "contract_pin_mismatch");
  });
});

describe("cognitive-debt M3 computed: the remaining missing codes", () => {
  it("input.json fails the vendored input schema -> evaluation_input_invalid_shape", async () => {
    const pair = r1("evaluated", { mutateInput: extraField });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_input_invalid_shape");
  });

  it("evaluation.json fails the vendored wrapper schema -> evaluation_invalid_shape", async () => {
    const pair = r1("evaluated", { mutateEvaluation: extraField });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_invalid_shape");
  });

  it("evaluation.json does not parse -> evaluation_invalid_shape", async () => {
    const files = pairFiles("p", r1(), { evaluation: "{not json\n" });
    assertOnly(await runM3(oneCommit(files)), "evaluation_invalid_shape");
  });

  it("wrapper without input_digest (record_digest recomputed) -> evaluation_input_digest_absent, not a shape failure", async () => {
    const pair = r1("evaluated", {
      afterInputDigest: (e: Json) => {
        Reflect.deleteProperty(e, "input_digest");
      },
    });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_input_digest_absent");
  });

  it("input_digest of other bytes -> evaluation_input_digest_mismatch", async () => {
    const pair = r1("evaluated", {
      afterInputDigest: (e: Json) => {
        e.input_digest = WRONG_DIGEST;
      },
    });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_input_digest_mismatch");
  });

  it("input_manifest.digest not the recomputation -> input_manifest_digest_mismatch", async () => {
    const pair = r1("evaluated", {
      afterInputDigest: (e: Json) => {
        e.input_manifest.digest = WRONG_DIGEST;
      },
    });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "input_manifest_digest_mismatch");
  });

  it("a manifest record absent from input.records -> evaluation_manifest_not_subset", async () => {
    const pair = r1("evaluated", {
      mutateEvaluation: (e: Json) => {
        e.input_manifest.records.push({ kind: "other", digest: OTHER_DIGEST });
      },
    });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_manifest_not_subset");
  });

  it("evaluation_cut 2026-02-30 in both documents (digests recomputed) -> evaluation_cut_invalid", async () => {
    const pair = r1("evaluated", { cut: "2026-02-30T00:00:00Z" });
    assertOnly(await runM3(oneCommit(pairFiles("p", pair))), "evaluation_cut_invalid");
  });

  it("削除後の再追加: added, deleted, re-added -> evaluation_pair_unbound", async () => {
    const pair = r1();
    const report = await runM3([
      ...oneCommit(pairFiles("p", pair)),
      {
        date: "2026-01-06T00:00:00Z",
        files: {
          "shadow-evaluations/p/input.json": null,
          "shadow-evaluations/p/evaluation.json": null,
        },
      },
      { date: "2026-01-07T00:00:00Z", files: pairFiles("p", pair) },
    ]);
    assertOnly(report, "evaluation_pair_unbound");
  });
});

// Adjacent codes of the fixed check order (spec B5). Each row's pair violates both codes; only
// the first may be counted. `split` commits evaluation.json one commit after input.json.
interface PrecedenceRow {
  readonly first: string;
  readonly second: string;
  readonly pair?: () => Pair;
  readonly noEvaluation?: boolean;
  readonly split?: boolean;
}

const PRECEDENCE: PrecedenceRow[] = [
  {
    first: "no_evaluation_output",
    second: "evaluation_input_invalid_shape",
    pair: () => r1("evaluated", { mutateInput: extraField }),
    noEvaluation: true,
  },
  {
    first: "evaluation_input_invalid_shape",
    second: "evaluation_invalid_shape",
    pair: () => r1("evaluated", { mutateInput: extraField, mutateEvaluation: extraField }),
  },
  {
    first: "evaluation_invalid_shape",
    second: "evaluation_record_digest_mismatch",
    pair: () =>
      r1("evaluated", {
        mutateEvaluation: extraField,
        afterRecordDigest: (e) => {
          e.record_digest = WRONG_DIGEST;
        },
      }),
  },
  {
    first: "evaluation_record_digest_mismatch",
    second: "evaluation_input_digest_absent",
    // record_digest was computed with input_digest present, so dropping it afterwards breaks both.
    pair: () =>
      r1("evaluated", {
        afterRecordDigest: (e) => {
          Reflect.deleteProperty(e, "input_digest");
        },
      }),
  },
  // evaluation_input_digest_absent -> evaluation_input_digest_mismatch: not constructible. "absent"
  // means the wrapper has no input_digest; "mismatch" compares the stored input_digest with the
  // recomputation, which needs a stored value. No pair can violate both.
  {
    first: "evaluation_input_digest_mismatch",
    second: "evaluation_pair_unbound",
    pair: () =>
      r1("evaluated", {
        afterInputDigest: (e) => {
          e.input_digest = WRONG_DIGEST;
        },
      }),
    split: true,
  },
  {
    first: "evaluation_pair_unbound",
    second: "evaluation_cut_mismatch",
    pair: () =>
      r1("evaluated", {
        mutateEvaluation: (e) => {
          e.evaluation_cut = "2026-01-11T00:00:00Z";
        },
      }),
    split: true,
  },
  {
    first: "evaluation_cut_mismatch",
    second: "contract_pin_mismatch",
    pair: () =>
      r1("evaluated", {
        mutateEvaluation: (e) => {
          e.evaluation_cut = "2026-01-11T00:00:00Z";
          e.evaluator.playbook_contract_commit = "0000000000000000000000000000000000000000";
        },
      }),
  },
  {
    first: "contract_pin_mismatch",
    second: "input_manifest_digest_mismatch",
    pair: () =>
      r1("evaluated", {
        mutateEvaluation: (e) => {
          e.evaluator.playbook_contract_commit = "0000000000000000000000000000000000000000";
        },
        afterInputDigest: (e) => {
          e.input_manifest.digest = WRONG_DIGEST;
        },
      }),
  },
  {
    first: "input_manifest_digest_mismatch",
    second: "evaluation_manifest_not_subset",
    pair: () =>
      r1("evaluated", {
        mutateEvaluation: (e) => {
          e.input_manifest.records.push({ kind: "other", digest: OTHER_DIGEST });
        },
        afterInputDigest: (e) => {
          e.input_manifest.digest = WRONG_DIGEST;
        },
      }),
  },
  {
    first: "evaluation_manifest_not_subset",
    second: "evaluation_subject_mismatch",
    pair: () =>
      r1("evaluated", {
        mutateEvaluation: (e) => {
          e.input_manifest.records.push({ kind: "other", digest: OTHER_DIGEST });
          e.candidate_receipt.subject.target = "staging";
        },
      }),
  },
  {
    first: "evaluation_subject_mismatch",
    second: "evaluation_cut_invalid",
    pair: () =>
      r1("evaluated", {
        cut: "2026-02-30T00:00:00Z",
        mutateEvaluation: (e) => {
          e.candidate_receipt.subject.target = "staging";
        },
      }),
  },
];

describe("cognitive-debt M3 computed: check order, every adjacent pair (spec B5 / B7)", () => {
  for (const row of PRECEDENCE) {
    it(`${row.first} wins over ${row.second}`, async () => {
      const pair = (row.pair as () => Pair)();
      const evaluations: CommitSpec[] = row.noEvaluation
        ? oneCommit(pairFiles("p", pair, { evaluation: false }))
        : row.split
          ? [
              ...oneCommit(pairFiles("p", pair, { evaluation: false })),
              { date: "2026-01-06T00:00:00Z", files: pairFiles("p", pair, { input: false }) },
            ]
          : oneCommit(pairFiles("p", pair));
      assertOnly(await runM3(evaluations), row.first);
    });
  }

  it("the table covers the 12 adjacent pairs of the 13-step order except the one that cannot exist", () => {
    const order = [
      "no_evaluation_output",
      "evaluation_input_invalid_shape",
      "evaluation_invalid_shape",
      "evaluation_record_digest_mismatch",
      "evaluation_input_digest_absent",
      "evaluation_input_digest_mismatch",
      "evaluation_pair_unbound",
      "evaluation_cut_mismatch",
      "contract_pin_mismatch",
      "input_manifest_digest_mismatch",
      "evaluation_manifest_not_subset",
      "evaluation_subject_mismatch",
      "evaluation_cut_invalid",
    ];
    const adjacent = order.slice(1).map((c, i) => `${order[i]}>${c}`);
    const covered = PRECEDENCE.map((r) => `${r.first}>${r.second}`);
    assert.deepEqual(
      adjacent.filter((a) => !covered.includes(a)),
      ["evaluation_input_digest_absent>evaluation_input_digest_mismatch"],
    );
  });
});

describe("cognitive-debt M3 computed: attribution (spec B5)", () => {
  const r1Pair = () => r1();
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "input.json 欠落 (evaluation.json and a notes file)",
      {
        ...pairFiles("p", r1Pair(), { input: false }),
        "shadow-evaluations/p/notes.md": "notes\n",
      },
    ],
    ["evaluation.json だけの dir", pairFiles("p", r1Pair(), { input: false })],
    ["input.json does not parse", pairFiles("p", r1Pair(), { input: "{not json\n" })],
    [
      "subject.bundle_digest missing",
      (() => {
        const pair = r1Pair();
        Reflect.deleteProperty(pair.input.subject, "bundle_digest");
        return pairFiles("p", pair);
      })(),
    ],
    [
      "subject.bundle_digest not a string",
      (() => {
        const pair = r1Pair();
        pair.input.subject.bundle_digest = 42;
        return pairFiles("p", pair);
      })(),
    ],
    ["a dir with auxiliary files only", { "shadow-evaluations/p/README.md": "aux\n" }],
  ];
  for (const [label, files] of cases) {
    it(`(iii) ${label}: counted nowhere; R1 is no_evaluation`, async () => {
      assertOnly(await runM3(oneCommit(files)), "no_evaluation");
    });
  }

  it("(ii) a bundle_digest no resolved release has, and a nested dir, are counted nowhere", async () => {
    const elsewhere = makePair("evaluated", {
      bundleDigest: OTHER_DIGEST,
      cut: "2026-01-10T00:00:00Z",
    });
    const nested = r1();
    const files = {
      ...pairFiles("elsewhere", elsewhere),
      "shadow-evaluations/group/nested/input.json": nested.input,
      "shadow-evaluations/group/nested/evaluation.json": nested.evaluation,
    };
    assertOnly(await runM3(oneCommit(files)), "no_evaluation");
  });

  it("an attributed pair counts toward its release even when invalid (no_evaluation stays 0)", async () => {
    const report = await runM3([
      { date: EVAL_DATE, files: pairFiles("p", r1(), { evaluation: false }) },
    ]);
    assert.deepEqual(
      report.m3_abstain_reasons.missing,
      expectedMissing({ no_evaluation: 1, no_evaluation_output: 1 }),
    );
    assert.deepEqual(report.m3_abstain_reasons.population, {
      resolved_releases: 2,
      evaluated_releases: 0,
      evaluations: 0,
    });
  });
});

describe("cognitive-debt M3 computed: commit selection", () => {
  it("no evaluations commit at as_of: pairs are not read, every resolved release is no_evaluation", async () => {
    const report = await runM3([
      {
        date: "2026-03-01T00:00:00Z",
        files: { ...pairFiles("r2-valid", r2Valid()), ...pairFiles("p", r1()) },
      },
    ]);
    const m3 = report.m3_abstain_reasons;
    assert.deepEqual(m3.population, {
      resolved_releases: 2,
      evaluated_releases: 0,
      evaluations: 0,
    });
    assert.deepEqual(m3.missing, expectedMissing({ no_evaluation: 2 }));
    assert.deepEqual(report.missing.no_commit_at_as_of, { count: 1, unit: "repo" });
    const evaluations = report.inputs.find((i: Json) => i.kind === "evaluations");
    assert.equal(evaluations.commit, null);
  });

  it("pairs added or changed after as_of, uncommitted edits and untracked pair dirs do not affect the output", async () => {
    const r2 = r2Valid();
    const history: CommitSpec[] = [
      { date: EVAL_DATE, files: pairFiles("r2-valid", r2) },
      {
        date: "2026-03-01T00:00:00Z",
        files: {
          ...pairFiles("late", r1()),
          ...pairFiles("r2-valid", r2, { input: false, evaluation: "{broken\n" }),
        },
      },
    ];
    const clean = await runM3([history[0] as CommitSpec]);
    const report = await runM3(history, (s) => {
      const repo = s.repos.evaluations;
      writeFileSync(path.join(repo, "shadow-evaluations", "late", "evaluation.json"), "{dirty\n");
      const untracked = path.join(repo, "shadow-evaluations", "untracked");
      mkdirSync(untracked, { recursive: true });
      const pair = r1();
      writeFileSync(path.join(untracked, "input.json"), JSON.stringify(pair.input));
      writeFileSync(path.join(untracked, "evaluation.json"), JSON.stringify(pair.evaluation));
    });
    assertOnly(report, "no_evaluation");
    // inputs[] carries the temp repo paths, so compare the parts the evaluations repo feeds.
    assert.equal(
      serializeOutput(report.m3_abstain_reasons),
      serializeOutput(clean.m3_abstain_reasons),
    );
    assert.equal(serializeOutput(report.suppressed_rows), serializeOutput(clean.suppressed_rows));
    const commitOf = (r: Json) => r.inputs.find((i: Json) => i.kind === "evaluations").commit;
    assert.equal(commitOf(report), commitOf(clean));
  });
});

describe("cognitive-debt M3 computed: determinism", () => {
  const pairs = () => ({
    a: r1("evaluated", { cut: "2026-01-10T00:00:00Z" }),
    b: makePair("unknown", { bundleDigest: R2_DIGEST, cut: "2025-11-03T00:00:00Z" }),
    c: r1("invalid_input", { cut: "2025-12-31T23:59:59Z" }),
  });

  it("the same input twice gives identical bytes", async () => {
    const p = pairs();
    const files = { ...pairFiles("a", p.a), ...pairFiles("b", p.b), ...pairFiles("c", p.c) };
    const s = buildScenario(m3Spec([{ date: EVAL_DATE, files }]));
    try {
      const first = await runScenario(s, [], "first.json");
      const second = await runScenario(s, [], "second.json");
      assert.equal(first.code, 0);
      assert.ok(first.bytes?.equals(second.bytes as Buffer));
    } finally {
      s.cleanup();
    }
  });

  it("permuting which dir name holds which pair leaves M3 and suppressed_rows byte-identical", async () => {
    const p = pairs();
    const forward = await runM3([
      {
        date: EVAL_DATE,
        files: { ...pairFiles("a", p.a), ...pairFiles("b", p.b), ...pairFiles("c", p.c) },
      },
    ]);
    const permuted = await runM3([
      {
        date: EVAL_DATE,
        files: { ...pairFiles("c", p.a), ...pairFiles("a", p.b), ...pairFiles("b", p.c) },
      },
    ]);
    assert.equal(forward.m3_abstain_reasons.population.evaluations, 3);
    assert.equal(
      serializeOutput(forward.m3_abstain_reasons),
      serializeOutput(permuted.m3_abstain_reasons),
    );
    assert.equal(
      serializeOutput(forward.suppressed_rows),
      serializeOutput(permuted.suppressed_rows),
    );
  });
});

describe("cognitive-debt M3 computed: evaluation_cut validity (spec B7)", () => {
  it("9 valid cuts are in the population, 9 non-existent ones are evaluation_cut_invalid", async () => {
    const files: Record<string, unknown> = {};
    [...VALID_CUTS, ...INVALID_CUTS].forEach((cut, i) => {
      Object.assign(
        files,
        pairFiles(`cut-${String(i).padStart(2, "0")}`, r1("evaluated", { cut })),
      );
    });
    const report = await runM3([{ date: EVAL_DATE, files: files as CommitSpec["files"] }]);
    const m3 = report.m3_abstain_reasons;
    assert.deepEqual(m3.missing, expectedMissing({ no_evaluation: 1, evaluation_cut_invalid: 9 }));
    assert.equal(m3.population.evaluations, 9);
    // 2026-01 holds six valid cuts (>= min_cell); 2028-02, 2000-02, 2026-12 are suppressed.
    assert.deepEqual(Object.keys(m3.by_month), ["2026-01"]);
    assert.equal(m3.by_month["2026-01"].evaluation_status.evaluated, 6);
    for (const month of ["2000-02", "2026-12", "2028-02"]) {
      assert.ok(report.suppressed_rows[`m3.by_month.${month}`], month);
    }
  });

  // Each cut on its own: test/unit/cognitive-debt-m3-aggregate.test.ts (classifyPair).
});
