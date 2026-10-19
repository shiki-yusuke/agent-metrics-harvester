// Guards: no personal-dimension key anywhere in the output, no authority other than "none" in
// src/cognitive-debt, and the M3 computed path stops with exit 3 instead of degrading silently.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PERSONAL_DIMENSION_KEYS as SRC_PERSONAL_DIMENSION_KEYS } from "../../src/cognitive-debt/inputs.js";
import { DEFAULT_VENDOR_DIR } from "../../src/cognitive-debt/run.js";
import {
  baseSpec,
  buildScenario,
  runScenario,
  runSpec,
} from "../support/cognitive-debt-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/test/unit -> <repo>/src/cognitive-debt (the TypeScript sources, not the build output).
const SRC_DIR = path.join(HERE, "..", "..", "..", "src", "cognitive-debt");

// lane packages/core/src/goodhart.ts PERSONAL_DIMENSION_KEYS (lane design.md §3.6) plus the
// instruction's fixed set; "name" is allowed only at generator.name, which design section 3
// mandates (docs/cognitive-debt-decisions.md).
const PERSONAL_DIMENSION_KEYS = new Set([
  "author",
  "reviewer",
  "assignee",
  "user_id",
  "email",
  "slack_id",
  "owner",
  "principal",
  "user",
  "actor",
  "login",
  "name",
]);
const ALLOWED_PATHS = new Set(["generator.name"]);

function personalKeyPaths(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => personalKeyPaths(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = at ? `${at}.${k}` : k;
    const own = PERSONAL_DIMENSION_KEYS.has(k) && !ALLOWED_PATHS.has(here) ? [here] : [];
    return [...own, ...personalKeyPaths(v, here)];
  });
}

describe("cognitive-debt guards", () => {
  it("no output key (recursively) is a personal-dimension key, although the inputs carry principal/actor", async () => {
    const s = buildScenario(baseSpec());
    try {
      const r = await runScenario(s, ["--detail"]);
      assert.ok(readFileSync(s.ackFile, "utf-8").includes('"principal"'));
      assert.deepEqual(personalKeyPaths(r.report), []);
      assert.ok(!r.bytes?.toString("utf-8").includes("release-captain-04"));
    } finally {
      s.cleanup();
    }
  });

  it('src/cognitive-debt contains no authority value other than "none"', () => {
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length >= 10);
    const values: string[] = [];
    for (const f of files) {
      const text = readFileSync(path.join(SRC_DIR, f), "utf-8");
      for (const m of text.matchAll(/["']?authority["']?\s*:\s*([^,\n}]+)/g))
        values.push((m[1] as string).trim());
    }
    assert.ok(values.length >= 1);
    assert.deepEqual([...new Set(values)], ['"none"']);
  });

  it("a vendored schema that declares input_digest stops the run with exit 3 and writes nothing", async () => {
    const vendorDir = mkdtempSync(path.join(tmpdir(), "cd-vendor-"));
    cpSync(DEFAULT_VENDOR_DIR, vendorDir, { recursive: true });
    const file = path.join(vendorDir, "shadow-evaluation-v0.schema.json");
    const schema = JSON.parse(readFileSync(file, "utf-8"));
    schema.properties.input_digest = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
    writeFileSync(file, JSON.stringify(schema));
    const s = buildScenario(baseSpec());
    try {
      const r = await runScenario(s, [], "out.json", { vendorDir });
      assert.equal(r.code, 3);
      assert.deepEqual(r.stderr, ["cognitive-debt: m3 computed path not implemented (phase 2)"]);
      assert.equal(r.bytes, null);
    } finally {
      s.cleanup();
    }
  });

  it("the shipped vendored pin keeps M3 not_computed", async () => {
    const s = buildScenario(baseSpec());
    try {
      const r = await runScenario(s);
      assert.equal(r.code, 0);
      assert.equal(r.report.m3_abstain_reasons.status, "not_computed");
    } finally {
      s.cleanup();
    }
  });

  it("src PERSONAL_DIMENSION_KEYS (the release_id refusal set) equals this test's set", () => {
    assert.deepEqual([...SRC_PERSONAL_DIMENSION_KEYS].sort(), [...PERSONAL_DIMENSION_KEYS].sort());
  });

  for (const refused of ["principal", "__proto__"]) {
    it(`--release-ids containing "${refused}" stops on the input-error path and writes nothing`, async () => {
      const spec = baseSpec();
      spec.releaseIds = ["R1", refused];
      const r = await runSpec(spec);
      // Without the refusal, "principal" would run to exit 0 as an ack.by_release key candidate.
      assert.equal(r.code, 1);
      assert.equal(r.bytes, null);
      assert.ok(r.stderr.some((l) => l.includes(`"${refused}"`)));
    });
  }
});
