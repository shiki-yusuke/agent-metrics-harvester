// M3 pure parts: aggregation (`other:<code>` normalization, key sets) and classifyPair on single
// pairs (evaluation_cut boundaries, isBound only reached after the digest checks).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type M3Evaluation,
  type M3Schemas,
  aggregateM3,
  classifyPair,
} from "../../src/cognitive-debt/m3.js";
import { withoutRequiredInputDigest } from "../../src/cognitive-debt/schema-check.js";
import {
  GOLDEN_DIR,
  INVALID_CUTS,
  type Pair,
  R1_DIGEST,
  VALID_CUTS,
  WRONG_DIGEST,
  makePair,
} from "../support/m3-pairs.js";

const VENDOR = path.join(GOLDEN_DIR, "..");
const load = (f: string) => JSON.parse(readFileSync(path.join(VENDOR, f), "utf-8"));
const SCHEMAS: M3Schemas = {
  input: load("shadow-evaluation-input-v0.schema.json"),
  evaluation: withoutRequiredInputDigest(load("shadow-evaluation-v0.schema.json")),
};

function classify(pair: Pair, isBound: () => Promise<boolean> = async () => true) {
  const inputBytes = Buffer.from(`${JSON.stringify(pair.input, null, 2)}\n`);
  return classifyPair(
    {
      input: pair.input,
      inputBytes,
      evaluationBytes: Buffer.from(JSON.stringify(pair.evaluation)),
    },
    SCHEMAS,
    isBound,
  );
}

function evaluation(over: Partial<M3Evaluation>): M3Evaluation {
  return {
    evaluation_cut: "2026-01-10T00:00:00Z",
    evaluation_status: "evaluated",
    unknown_reasons: [],
    input_errors: [],
    predicate_observations: [],
    candidate_receipt: null,
    ...over,
  };
}

describe("cognitive-debt M3 aggregation", () => {
  it("codes outside the fixed closed sets become other:<code> in by_code_evaluation, by_predicate and by_month", () => {
    const evaluations: M3Evaluation[] = [
      evaluation({
        evaluation_status: "unknown",
        unknown_reasons: [{ code: "brand_new_reason" }, { code: "not_yet_recorded" }],
        predicate_observations: [
          {
            predicate_id: "preview_verified",
            status: "unknown",
            reason: { code: "brand_new_reason" },
          },
          {
            predicate_id: "preview_verified",
            status: "unknown",
            reason: { code: "lane_ref_omitted" },
          },
          { predicate_id: "artifact_identity", status: "satisfied" },
          {
            predicate_id: "privilege_boundary",
            status: "unknown",
            reason: { code: "not_applicable_by_policy" },
          },
        ],
      }),
      evaluation({
        evaluation_cut: "2026-02-01T00:00:00Z",
        evaluation_status: "invalid_input",
        input_errors: [{ code: "brand_new_error" }, { code: "digest_mismatch" }],
      }),
      evaluation({ candidate_receipt: { verdict: "abstained" } }),
      evaluation({ candidate_receipt: { verdict: "ready_for_approval" } }),
    ];
    const { overall, months } = aggregateM3(evaluations);
    assert.deepEqual(JSON.parse(JSON.stringify(overall)), {
      evaluation_status: { evaluated: 2, unknown: 1, invalid_input: 1 },
      by_code_evaluation: {
        unknown: {
          unknown_structural: 0,
          not_yet_recorded: 1,
          lane_ref_omitted: 0,
          referent_unresolved: 0,
          not_applicable_by_policy: 0,
          "other:brand_new_reason": 1,
        },
        input_error: {
          record_invalid: 0,
          digest_mismatch: 1,
          unsupported_record_version: 0,
          "other:brand_new_error": 1,
        },
      },
      by_predicate: {
        preview_verified: { "other:brand_new_reason": 1, lane_ref_omitted: 1 },
      },
      not_applicable: { privilege_boundary: 1 },
      abstained: 1,
      no_candidate_receipt: 2,
    });
    assert.deepEqual([...months.keys()], ["2026-01", "2026-02"]);
    const jan = months.get("2026-01");
    const feb = months.get("2026-02");
    assert.equal(jan?.units, 3);
    assert.equal(feb?.units, 1);
    const janRow = JSON.parse(JSON.stringify(jan?.row));
    const febRow = JSON.parse(JSON.stringify(feb?.row));
    assert.equal(janRow.by_code_evaluation.unknown["other:brand_new_reason"], 1);
    assert.deepEqual(janRow.by_predicate, {
      preview_verified: { "other:brand_new_reason": 1, lane_ref_omitted: 1 },
    });
    assert.equal(febRow.by_code_evaluation.input_error["other:brand_new_error"], 1);
    assert.deepEqual(Object.keys(febRow).sort(), Object.keys(janRow).sort());
    assert.equal(Object.keys(janRow).length, 6);
  });

  it("by_predicate / not_applicable keys are own keys even for __proto__ (null prototype)", () => {
    const { overall } = aggregateM3([
      evaluation({
        predicate_observations: [
          { predicate_id: "__proto__", status: "unknown", reason: { code: "unknown_structural" } },
          {
            predicate_id: "__proto__",
            status: "unknown",
            reason: { code: "not_applicable_by_policy" },
          },
        ],
      }),
    ]);
    assert.ok(Object.hasOwn(overall.by_predicate, "__proto__"));
    assert.ok(Object.hasOwn(overall.not_applicable, "__proto__"));
  });

  it("no evaluation: closed keys 0-filled, open maps empty", () => {
    const { overall, months } = aggregateM3([]);
    assert.deepEqual(JSON.parse(JSON.stringify(overall.evaluation_status)), {
      evaluated: 0,
      unknown: 0,
      invalid_input: 0,
    });
    assert.equal(Object.keys(overall.by_code_evaluation.unknown).length, 5);
    assert.equal(Object.keys(overall.by_code_evaluation.input_error).length, 3);
    assert.deepEqual(Object.keys(overall.by_predicate), []);
    assert.equal(months.size, 0);
  });
});

describe("cognitive-debt M3 classifyPair", () => {
  for (const cut of VALID_CUTS) {
    it(`evaluation_cut ${cut} is a real UTC time -> valid`, async () => {
      const v = await classify(makePair("evaluated", { bundleDigest: R1_DIGEST, cut }));
      assert.equal(v.code, null);
    });
  }
  for (const cut of INVALID_CUTS) {
    it(`evaluation_cut ${cut} matches the schema regex but does not exist -> evaluation_cut_invalid`, async () => {
      const v = await classify(makePair("evaluated", { bundleDigest: R1_DIGEST, cut }));
      assert.equal(v.code, "evaluation_cut_invalid");
    });
  }

  it("the git binding check runs only after the digest checks pass", async () => {
    let calls = 0;
    const isBound = async () => {
      calls++;
      return false;
    };
    const stale = makePair("evaluated", {
      bundleDigest: R1_DIGEST,
      afterInputDigest: (e) => {
        e.input_digest = WRONG_DIGEST;
      },
    });
    assert.equal((await classify(stale, isBound)).code, "evaluation_input_digest_mismatch");
    assert.equal(calls, 0);
    const ok = makePair("evaluated", { bundleDigest: R1_DIGEST });
    assert.equal((await classify(ok, isBound)).code, "evaluation_pair_unbound");
    assert.equal(calls, 1);
  });

  it("an input whose JCS form does not exist (a number JSON.parse makes Infinity) is input_digest_mismatch, not a crash", async () => {
    // records[].content is schema-free, so the input passes its shape check and only the digest
    // step meets the unrepresentable number.
    const inRecord = makePair("evaluated", { bundleDigest: R1_DIGEST });
    const bytes = Buffer.from(
      JSON.stringify(inRecord.input).replace('"content":{', '"content":{"huge":1e400,'),
    );
    const v2 = await classifyPair(
      {
        input: JSON.parse(bytes.toString("utf-8")),
        inputBytes: bytes,
        evaluationBytes: Buffer.from(JSON.stringify(inRecord.evaluation)),
      },
      SCHEMAS,
      async () => true,
    );
    assert.equal(v2.code, "evaluation_input_digest_mismatch");
  });
});
