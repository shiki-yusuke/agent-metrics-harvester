// M3 computed path: git-history edges of the pair binding (design section 1 "評価ペアの束縛":
// `git log --first-parent`, literal pathspecs) and per-element counting of reason codes
// (design 2.3). Same fixtures as cognitive-debt-m3.test.ts (baseSpec: R1 and R2 resolve, as_of
// 2026-02-01T00:00:00Z).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { logFirstParentForPath } from "../../src/cognitive-debt/git.js";
import {
  type CommitSpec,
  type Scenario,
  buildScenario,
  runScenario,
} from "../support/cognitive-debt-fixtures.js";
import {
  EVAL_DATE,
  type Json,
  R1_DIGEST,
  expectedMissing,
  m3Spec,
  makePair,
  pairFiles,
  r2Valid,
} from "../support/m3-pairs.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

/** Runs git in `repo`; with `isoDate`, author and committer dates are fixed to it. */
function git(repo: string, args: readonly string[], isoDate?: string): string {
  const env =
    isoDate === undefined
      ? GIT_ENV
      : (() => {
          const date = `@${Math.floor(Date.parse(isoDate) / 1000)} +0000`;
          return { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
        })();
  return execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf-8" }).trim();
}

/** Builds the scenario, lets `extend` add history to the evaluations repo, runs the command and
 * hands the report (and the scenario, still on disk) to `check`. */
async function withM3(
  evaluations: CommitSpec[],
  extend: (repo: string) => void,
  // biome-ignore lint/suspicious/noExplicitAny: parsed report under test
  check: (report: any, s: Scenario) => Promise<void>,
): Promise<void> {
  const s = buildScenario(m3Spec(evaluations));
  try {
    extend(s.repos.evaluations);
    const r = await runScenario(s);
    assert.equal(r.code, 0, r.stderr.join("\n"));
    await check(r.report, s);
  } finally {
    s.cleanup();
  }
}

const r1 = (cut: string) => makePair("evaluated", { bundleDigest: R1_DIGEST, cut });

const P_INPUT = "shadow-evaluations/p/input.json";
const P_EVALUATION = "shadow-evaluations/p/evaluation.json";

const shas = (log: readonly { sha: string }[]) => log.map((c) => c.sha);

describe("cognitive-debt M3 computed: first-parent binding (design section 1)", () => {
  it("pair on main, evaluation.json changed only on a side branch, merged --no-ff -> the merge commit is in the first-parent log; unbound", async () => {
    const pair = r1("2026-01-10T00:00:00Z");
    let introduced = "";
    let sideCommit = "";
    let merge = "";
    await withM3(
      [
        {
          date: EVAL_DATE,
          files: { ...pairFiles("r2-valid", r2Valid()), ...pairFiles("p", pair) },
        },
      ],
      (repo) => {
        introduced = git(repo, ["rev-parse", "HEAD"]);
        git(repo, ["checkout", "-q", "-b", "side"]);
        // Whitespace only: every digest still passes, so only the binding can fail.
        writeFileSync(path.join(repo, P_EVALUATION), `${JSON.stringify(pair.evaluation)}\n`);
        git(
          repo,
          ["commit", "-q", "-am", "side: reformat evaluation.json"],
          "2026-01-06T00:00:00Z",
        );
        sideCommit = git(repo, ["rev-parse", "HEAD"]);
        git(repo, ["checkout", "-q", "main"]);
        git(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], "2026-01-07T00:00:00Z");
        merge = git(repo, ["rev-parse", "HEAD"]);
      },
      async (report, s) => {
        const repo = s.repos.evaluations;
        const opts = { literalPathspec: true } as const;
        // Expected from git's own first-parent log: with --first-parent a merge is compared with
        // its first parent only, and evaluation.json differs between `introduced` and the merge,
        // so the merge commit is listed; the side commit is not (it is off the first-parent
        // line). Without --first-parent, default history simplification finds the merge TREESAME
        // to its side parent, drops the merge and follows the side branch: [side, introduced].
        assert.deepEqual(shas(await logFirstParentForPath(repo, merge, P_EVALUATION, opts)), [
          merge,
          introduced,
        ]);
        assert.notEqual(sideCommit, merge);
        assert.deepEqual(shas(await logFirstParentForPath(repo, merge, P_INPUT, opts)), [
          introduced,
        ]);
        // The newest first-parent commit of evaluation.json is the merge, not the commit that
        // added the pair -> evaluation_pair_unbound (design section 1).
        const m3 = report.m3_abstain_reasons;
        assert.deepEqual(m3.missing, expectedMissing({ evaluation_pair_unbound: 1 }));
        assert.deepEqual(m3.population, {
          resolved_releases: 2,
          evaluated_releases: 1,
          evaluations: 1,
        });
      },
    );
  });

  it("pair introduced and then changed on a side branch, merged --no-ff -> both files are added by the merge on the first-parent line; bound", async () => {
    const pair = r1("2026-01-10T00:00:00Z");
    await withM3(
      [{ date: EVAL_DATE, files: pairFiles("r2-valid", r2Valid()) }],
      (repo) => {
        git(repo, ["checkout", "-q", "-b", "side"]);
        mkdirSync(path.join(repo, "shadow-evaluations", "p"), { recursive: true });
        writeFileSync(path.join(repo, P_INPUT), `${JSON.stringify(pair.input, null, 2)}\n`);
        writeFileSync(
          path.join(repo, P_EVALUATION),
          `${JSON.stringify(pair.evaluation, null, 2)}\n`,
        );
        git(repo, ["add", "-A"]);
        git(repo, ["commit", "-q", "-m", "side: add pair"], "2026-01-06T00:00:00Z");
        writeFileSync(path.join(repo, P_EVALUATION), `${JSON.stringify(pair.evaluation)}\n`);
        git(
          repo,
          ["commit", "-q", "-am", "side: reformat evaluation.json"],
          "2026-01-07T00:00:00Z",
        );
        git(repo, ["checkout", "-q", "main"]);
        git(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], "2026-01-08T00:00:00Z");
      },
      async (report, s) => {
        const repo = s.repos.evaluations;
        const merge = git(repo, ["rev-parse", "HEAD"]);
        // Expected from git's first-parent log: the side commits are off the first-parent line,
        // and the merge compared with its first parent adds both files (`--diff-filter=A` lists
        // the merge alone) and is also the newest commit touching each -> bound. The side-only
        // change of evaluation.json does not appear. Without --first-parent the two files are
        // added by the first side commit and evaluation.json was last changed by the second,
        // which would make the pair evaluation_pair_unbound.
        for (const file of ["input.json", "evaluation.json"]) {
          const p = `shadow-evaluations/p/${file}`;
          const opts = { literalPathspec: true } as const;
          assert.deepEqual(
            shas(await logFirstParentForPath(repo, merge, p, { ...opts, diffFilter: "A" })),
            [merge],
          );
          assert.deepEqual(shas(await logFirstParentForPath(repo, merge, p, opts)), [merge]);
        }
        const m3 = report.m3_abstain_reasons;
        assert.deepEqual(m3.missing, expectedMissing());
        assert.deepEqual(m3.population, {
          resolved_releases: 2,
          evaluated_releases: 2,
          evaluations: 2,
        });
      },
    );
  });
});

describe("cognitive-debt M3 computed: literal pathspecs (design section 1)", () => {
  it("a pair dir named `a*` is bound even when a dir `abc` it would glob-match is added in a later commit", async () => {
    await withM3(
      [
        {
          date: EVAL_DATE,
          files: {
            ...pairFiles("r2-valid", r2Valid()),
            ...pairFiles("a*", r1("2026-01-10T00:00:00Z")),
          },
        },
        { date: "2026-01-06T00:00:00Z", files: pairFiles("abc", r1("2026-01-11T00:00:00Z")) },
      ],
      () => {},
      async (report) => {
        // As a glob, `shadow-evaluations/a*/input.json` also matches abc/input.json, so the
        // `--diff-filter=A` log of `a*` would have two lines and `a*` would be unbound.
        const m3 = report.m3_abstain_reasons;
        assert.deepEqual(m3.missing, expectedMissing());
        assert.deepEqual(m3.population, {
          resolved_releases: 2,
          evaluated_releases: 2,
          evaluations: 3,
        });
      },
    );
  });
});

describe("cognitive-debt M3 computed: reason codes count per element (design 2.3)", () => {
  it("the same code repeated inside one evaluation counts once per element, top level and by_month", async () => {
    // The vendored schema keeps unknown_reasons, input_errors and predicate reasons on different
    // evaluation_status values (unknown / invalid_input / evaluated), so each position gets its
    // repeats in its own evaluation. 5 evaluations in 2026-01 keep the month row (min_cell 5).
    const repeat = (list: Json[], index: number, times: number) => {
      for (let i = 1; i < times; i++) list.push(structuredClone(list[index]));
    };
    const at = (e: Json, id: string) =>
      e.predicate_observations.findIndex((o: Json) => o.predicate_id === id);
    const unknown = (cut: string) =>
      makePair("unknown", {
        bundleDigest: R1_DIGEST,
        cut,
        mutateEvaluation: (e) => repeat(e.unknown_reasons, 0, 3),
      });
    const invalidInput = makePair("invalid_input", {
      bundleDigest: R1_DIGEST,
      cut: "2026-01-12T00:00:00Z",
      mutateEvaluation: (e) => repeat(e.input_errors, 0, 2),
    });
    const evaluated = (cut: string, notApplicable: boolean) =>
      makePair("evaluated", {
        bundleDigest: R1_DIGEST,
        cut,
        mutateEvaluation: (e) => {
          const obs = e.predicate_observations;
          if (notApplicable) {
            const o = obs[at(e, "privilege_boundary")];
            o.applicability = "not_applicable";
            o.reason = { code: "not_applicable_by_policy", params: {} };
            repeat(obs, at(e, "privilege_boundary"), 2);
          }
          repeat(obs, at(e, "preview_verified"), 2);
          repeat(obs, at(e, "rollback_target_valid"), 2);
        },
      });
    await withM3(
      [
        {
          date: EVAL_DATE,
          files: {
            ...pairFiles("u1", unknown("2026-01-10T00:00:00Z")),
            ...pairFiles("u2", unknown("2026-01-11T00:00:00Z")),
            ...pairFiles("i1", invalidInput),
            ...pairFiles("e1", evaluated("2026-01-13T00:00:00Z", false)),
            ...pairFiles("e2", evaluated("2026-01-14T00:00:00Z", true)),
          },
        },
      ],
      () => {},
      async (report) => {
        const row = {
          evaluation_status: { evaluated: 2, invalid_input: 1, unknown: 2 },
          by_code_evaluation: {
            input_error: { digest_mismatch: 2, record_invalid: 0, unsupported_record_version: 0 },
            unknown: {
              lane_ref_omitted: 0,
              not_applicable_by_policy: 0,
              not_yet_recorded: 0,
              referent_unresolved: 0,
              unknown_structural: 6,
            },
          },
          by_predicate: {
            preview_verified: { unknown_structural: 4 },
            privilege_boundary: { unknown_structural: 1 },
            rollback_target_valid: { referent_unresolved: 4 },
          },
          not_applicable: { privilege_boundary: 2 },
          abstained: 2,
          no_candidate_receipt: 3,
        };
        assert.deepEqual(report.m3_abstain_reasons, {
          status: "computed",
          reason: null,
          population: { resolved_releases: 2, evaluated_releases: 1, evaluations: 5 },
          missing: expectedMissing({ no_evaluation: 1 }),
          ...row,
          by_month: { "2026-01": row },
        });
      },
    );
  });
});
