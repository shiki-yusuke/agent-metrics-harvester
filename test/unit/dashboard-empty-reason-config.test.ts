// Validates empty-reason-config.ts's strict, fail-loud parsing of the operator-authored
// `--empty-reason-config` JSON file: valid shapes accepted verbatim, any malformed shape
// rejected with a clear error rather than silently degrading to the legacy plain notice.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  EmptyReasonConfigError,
  parseEmptyReasonConfig,
  readEmptyReasonConfig,
} from "../../src/dashboard/empty-reason-config.js";

describe("parseEmptyReasonConfig", () => {
  it("accepts an empty object (no panel classified)", () => {
    assert.deepEqual(parseEmptyReasonConfig({}), {});
  });

  it("accepts all three panel keys with all three reason codes", () => {
    const config = parseEmptyReasonConfig({
      calibration: { code: "not_produced", note: "no adopted estimate yet" },
      attribution: { code: "withheld", note: "cross-repo audit scope" },
      cohort: { code: "insufficient_data" },
    });
    assert.deepEqual(config, {
      calibration: { code: "not_produced", note: "no adopted estimate yet" },
      attribution: { code: "withheld", note: "cross-repo audit scope" },
      cohort: { code: "insufficient_data" },
    });
  });

  it("accepts a reason with no note (note is optional)", () => {
    const config = parseEmptyReasonConfig({ calibration: { code: "not_produced" } });
    assert.deepEqual(config, { calibration: { code: "not_produced" } });
  });

  it("rejects a non-object top level", () => {
    assert.throws(() => parseEmptyReasonConfig("not an object"), EmptyReasonConfigError);
    assert.throws(() => parseEmptyReasonConfig(null), EmptyReasonConfigError);
    assert.throws(() => parseEmptyReasonConfig([1, 2, 3]), EmptyReasonConfigError);
  });

  it("rejects an unrecognized panel key (e.g. cost/freshness, deliberately not configurable)", () => {
    assert.throws(
      () => parseEmptyReasonConfig({ cost: { code: "withheld" } }),
      EmptyReasonConfigError,
    );
    assert.throws(
      () => parseEmptyReasonConfig({ freshness: { code: "withheld" } }),
      EmptyReasonConfigError,
    );
  });

  it("rejects an invalid reason code", () => {
    assert.throws(
      () => parseEmptyReasonConfig({ calibration: { code: "not_a_real_code" } }),
      EmptyReasonConfigError,
    );
  });

  it("rejects a non-string note", () => {
    assert.throws(
      () => parseEmptyReasonConfig({ calibration: { code: "withheld", note: 12345 } }),
      EmptyReasonConfigError,
    );
  });

  it("rejects an entry with unrecognized fields", () => {
    assert.throws(
      () =>
        parseEmptyReasonConfig({
          calibration: { code: "withheld", note: "ok", extra: "not allowed" },
        }),
      EmptyReasonConfigError,
    );
  });

  it("rejects a non-object entry", () => {
    assert.throws(
      () => parseEmptyReasonConfig({ calibration: "withheld" }),
      EmptyReasonConfigError,
    );
  });
});

describe("readEmptyReasonConfig", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-empty-reason-config-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads and parses a valid file from disk", async () => {
    const file = path.join(dir, "valid.json");
    await writeFile(
      file,
      JSON.stringify({ attribution: { code: "withheld", note: "cross-repo scope" } }),
      "utf-8",
    );
    const config = await readEmptyReasonConfig(file);
    assert.deepEqual(config, { attribution: { code: "withheld", note: "cross-repo scope" } });
  });

  it("fails loudly (never silently) on a missing file", async () => {
    await assert.rejects(
      () => readEmptyReasonConfig(path.join(dir, "does-not-exist.json")),
      EmptyReasonConfigError,
    );
  });

  it("fails loudly on malformed JSON", async () => {
    const file = path.join(dir, "malformed.json");
    await writeFile(file, "{ not valid json", "utf-8");
    await assert.rejects(() => readEmptyReasonConfig(file), EmptyReasonConfigError);
  });

  it("fails loudly on a validly-JSON but invalid-shape file", async () => {
    const file = path.join(dir, "invalid-shape.json");
    await writeFile(file, JSON.stringify({ calibration: { code: "bogus" } }), "utf-8");
    await assert.rejects(() => readEmptyReasonConfig(file), EmptyReasonConfigError);
  });
});
