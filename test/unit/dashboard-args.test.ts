import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DashboardArgError, parseDashboardArgs } from "../../src/dashboard/args.js";

const BASE_ARGS = ["--store-path", "store.jsonl", "--aggregates-dir", "aggregates", "--out", "out"];

describe("parseDashboardArgs: --empty-reason-config", () => {
  it("is undefined when not passed (legacy behavior, unaffected by this feature)", () => {
    const opts = parseDashboardArgs(BASE_ARGS);
    assert.equal(opts.emptyReasonConfigPath, undefined);
  });

  it("accepts a path and carries it through untouched", () => {
    const opts = parseDashboardArgs([...BASE_ARGS, "--empty-reason-config", "reasons.json"]);
    assert.equal(opts.emptyReasonConfigPath, "reasons.json");
  });

  it("rejects a path-traversal attempt, same as the other path flags", () => {
    assert.throws(
      () => parseDashboardArgs([...BASE_ARGS, "--empty-reason-config", "../outside.json"]),
      DashboardArgError,
    );
  });

  it("requires a value", () => {
    assert.throws(
      () => parseDashboardArgs([...BASE_ARGS, "--empty-reason-config"]),
      DashboardArgError,
    );
  });
});
