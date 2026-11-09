// Parity of the harvester's M3 digest recomputation with upstream release-evidence (spec B2 / B7).
// The golden pairs under test/contract/vendor/release-evidence/golden/ were written by upstream
// `release-evidence-shadow replay` at the pinned commit (UPSTREAM.md); the harvester imports no
// upstream code and recomputes record_digest / input_digest / input_manifest.digest with its own
// JCS (src/cognitive-debt/jcs.ts) and manifest sort (src/cognitive-debt/m3.ts).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { jcsDigest } from "../../src/cognitive-debt/jcs.js";
import {
  INPUT_ERROR_CODES,
  UNKNOWN_REASON_CODES,
  classifyPair,
  inputDigest,
  inputManifestDigest,
  recordDigest,
} from "../../src/cognitive-debt/m3.js";
import { checkSchema, withoutRequiredInputDigest } from "../../src/cognitive-debt/schema-check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "vendor", "release-evidence");
const GOLDEN = path.join(VENDOR, "golden");
const loadJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const inputSchema = loadJson(path.join(VENDOR, "shadow-evaluation-input-v0.schema.json"));
const evaluationSchema = loadJson(path.join(VENDOR, "shadow-evaluation-v0.schema.json"));
const schemas = { input: inputSchema, evaluation: withoutRequiredInputDigest(evaluationSchema) };

function golden(name: string) {
  const inputBytes = readFileSync(path.join(GOLDEN, name, "input.json"));
  return {
    inputBytes,
    input: JSON.parse(inputBytes.toString("utf-8")),
    evaluationBytes: readFileSync(path.join(GOLDEN, name, "evaluation.json")),
    evaluation: loadJson(path.join(GOLDEN, name, "evaluation.json")),
  };
}

const NAMES = readdirSync(GOLDEN).sort();

describe("M3 golden parity with upstream replay output", () => {
  it("the golden set covers all three evaluation_status values and a non-null candidate_receipt", () => {
    assert.ok(NAMES.length >= 2);
    const statuses = new Set(NAMES.map((n) => golden(n).evaluation.evaluation_status));
    assert.deepEqual([...statuses].sort(), ["evaluated", "invalid_input", "unknown"]);
    assert.ok(NAMES.some((n) => golden(n).evaluation.candidate_receipt !== null));
  });

  for (const name of NAMES) {
    it(`${name}: record_digest, input_digest and input_manifest.digest recompute to upstream's values`, () => {
      const g = golden(name);
      assert.equal(recordDigest(g.evaluation), g.evaluation.record_digest);
      assert.equal(inputDigest(g.inputBytes), g.evaluation.input_digest);
      assert.equal(
        inputManifestDigest(g.evaluation.input_manifest.records),
        g.evaluation.input_manifest.digest,
      );
    });

    it(`${name}: passes both vendored schemas and is a valid pair for the population`, async () => {
      const g = golden(name);
      assert.deepEqual(checkSchema(inputSchema, g.input), []);
      assert.deepEqual(checkSchema(evaluationSchema, g.evaluation), []);
      const v = await classifyPair(
        { input: g.input, inputBytes: g.inputBytes, evaluationBytes: g.evaluationBytes },
        schemas,
        async () => true,
      );
      assert.equal(v.code, null);
    });
  }

  it("input_digest keeps records[] order: the records-reversed input has its own (different) upstream digest", () => {
    const forward = golden("lane-backed");
    const reversed = golden("lane-backed-records-reversed");
    assert.deepEqual(reversed.input.records, [...forward.input.records].reverse());
    assert.equal(inputDigest(forward.inputBytes), forward.evaluation.input_digest);
    assert.equal(inputDigest(reversed.inputBytes), reversed.evaluation.input_digest);
    assert.notEqual(forward.evaluation.input_digest, reversed.evaluation.input_digest);
    // A harvester that sorted records before hashing would make the two equal.
    const sortRecords = (i: { records: { digest: string }[] }) => ({
      ...i,
      records: [...i.records].sort((a, b) => (a.digest < b.digest ? -1 : 1)),
    });
    assert.equal(jcsDigest(sortRecords(forward.input)), jcsDigest(sortRecords(reversed.input)));
  });

  it("input_manifest.digest sorts by (kind, digest) first: a wrapper with input_manifest.records reversed (record_digest recomputed) stays valid", async () => {
    const g = golden("lane-backed");
    const records = g.evaluation.input_manifest.records;
    assert.ok(records.length >= 2);
    const evaluation = {
      ...g.evaluation,
      input_manifest: { ...g.evaluation.input_manifest, records: [...records].reverse() },
    };
    evaluation.record_digest = recordDigest(evaluation);
    // Without the sort the digest would differ.
    assert.notEqual(jcsDigest([...records].reverse()), g.evaluation.input_manifest.digest);
    const v = await classifyPair(
      {
        input: g.input,
        inputBytes: g.inputBytes,
        evaluationBytes: Buffer.from(JSON.stringify(evaluation)),
      },
      schemas,
      async () => true,
    );
    assert.equal(v.code, null);
  });

  it("the fixed closed code sets are contained in the vendored schema enums", () => {
    const p = evaluationSchema.properties;
    const unknownEnum: string[] = p.unknown_reasons.items.properties.code.enum;
    const inputErrorEnum: string[] = p.input_errors.items.properties.code.enum;
    const predicateEnum: string[] =
      p.predicate_observations.items.properties.reason.properties.code.enum;
    for (const code of UNKNOWN_REASON_CODES) {
      assert.ok(unknownEnum.includes(code), code);
      assert.ok(predicateEnum.includes(code), code);
    }
    for (const code of INPUT_ERROR_CODES) assert.ok(inputErrorEnum.includes(code), code);
    assert.equal(UNKNOWN_REASON_CODES.length, 5);
    assert.equal(INPUT_ERROR_CODES.length, 3);
  });

  it("the vendored wrapper schema declares input_digest (and requires it; the harvester relaxes that)", () => {
    assert.deepEqual(evaluationSchema.properties.input_digest, {
      type: "string",
      pattern: "^sha256:[0-9a-f]{64}$",
    });
    assert.ok(evaluationSchema.required.includes("input_digest"));
  });
});
