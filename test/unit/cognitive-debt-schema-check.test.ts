import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { jcsDigest } from "../../src/cognitive-debt/jcs.js";
import { m3Mode } from "../../src/cognitive-debt/m3.js";
import {
  UnsupportedSchemaKeywordError,
  assertSupportedSchema,
  checkSchema,
  declaresInputDigest,
} from "../../src/cognitive-debt/schema-check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, "..", "contract", "vendor", "release-evidence");
const load = (f: string) => JSON.parse(readFileSync(path.join(VENDOR, f), "utf-8"));

const SHA = `sha256:${"c".repeat(64)}`;

function sampleEvaluation(): Record<string, unknown> {
  const record: Record<string, unknown> = {
    schema_version: "shadow-evaluation/v0",
    mode: "shadow_only",
    evaluation_cut: "2026-01-01T00:00:00Z",
    evaluator: { version: "0.1.0", playbook_contract_commit: "abc" },
    input_manifest: { records: [], digest: SHA },
    evaluation_status: "unknown",
    unknown_reasons: [{ code: "bundle_unresolved", params: {} }],
    input_errors: [],
    predicate_observations: [],
    candidate_receipt: null,
  };
  record.record_digest = jcsDigest(record);
  return record;
}

describe("cognitive-debt schema-check (vendored release-evidence pin)", () => {
  it("both vendored schemas use only supported keywords", () => {
    assertSupportedSchema(load("shadow-evaluation-input-v0.schema.json"));
    assertSupportedSchema(load("shadow-evaluation-v0.schema.json"));
  });

  it("an unsupported keyword is refused, not ignored", () => {
    assert.throws(
      () => assertSupportedSchema({ type: "object", properties: { a: { $ref: "#/x" } } }),
      UnsupportedSchemaKeywordError,
    );
    assert.throws(() => checkSchema({ uniqueItems: true }, []), UnsupportedSchemaKeywordError);
  });

  it("validates a wrapper record and reports a closed-object violation", () => {
    const schema = load("shadow-evaluation-v0.schema.json");
    const record = sampleEvaluation();
    const errors = checkSchema(schema, record);
    // unknown_reasons item shape is upstream's; only assert the structural verdicts this test owns.
    assert.ok(
      errors.every((e) => !e.includes("additional property")),
      errors.join("\n"),
    );
    const extra = checkSchema(schema, { ...record, input_digest: SHA });
    assert.ok(extra.some((e) => e.includes('additional property "input_digest"')));
    assert.ok(checkSchema(schema, { ...record, mode: "live" }).length > 0);
  });

  it("the pinned shadow-evaluation/v0 schema does not declare input_digest -> M3 not_computed", () => {
    const schema = load("shadow-evaluation-v0.schema.json");
    assert.equal(declaresInputDigest(schema), false);
    assert.equal(m3Mode(schema), "not_computed");
    const future = {
      ...schema,
      properties: { ...schema.properties, input_digest: { type: "string" } },
    };
    assert.equal(m3Mode(future), "computed");
  });
});
