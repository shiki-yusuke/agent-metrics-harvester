import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliArgError, parseArgs } from "../../src/cli/args.js";

describe("parseArgs", () => {
  it("parses a minimal valid invocation", () => {
    const opts = parseArgs([
      "--repo",
      "octo/example",
      "--store-path",
      "./data/store.jsonl",
      "--allowed-login",
      "trusted-bot[bot]",
      "--lookback-days",
      "7",
    ]);
    assert.deepEqual(opts.repos, ["octo/example"]);
    assert.equal(opts.storeKind, "jsonl");
    assert.equal(opts.storePath, "./data/store.jsonl");
    assert.equal(opts.lookbackDays, 7);
    assert.deepEqual(opts.allowedLogins, ["trusted-bot[bot]"]);
  });

  it("accumulates repeated --repo and --allowed-login flags", () => {
    const opts = parseArgs([
      "--repo",
      "octo/one",
      "--repo",
      "octo/two",
      "--store-path",
      "./s.jsonl",
      "--allowed-login",
      "a",
      "--allowed-login",
      "b",
    ]);
    assert.deepEqual(opts.repos, ["octo/one", "octo/two"]);
    assert.deepEqual(opts.allowedLogins, ["a", "b"]);
  });

  it("rejects a missing --repo", () => {
    assert.throws(() => parseArgs(["--store-path", "x", "--allowed-login", "a"]), CliArgError);
  });

  it("rejects a missing --store-path", () => {
    assert.throws(() => parseArgs(["--repo", "octo/example", "--allowed-login", "a"]), CliArgError);
  });

  it("rejects an invocation with no author allowlist at all", () => {
    assert.throws(() => parseArgs(["--repo", "octo/example", "--store-path", "x"]), CliArgError);
  });

  it("rejects an invalid --store value", () => {
    assert.throws(
      () => parseArgs(["--repo", "octo/example", "--store-path", "x", "--allowed-login", "a", "--store", "yaml"]),
      CliArgError,
    );
  });

  it("rejects an unrecognized flag", () => {
    assert.throws(() => parseArgs(["--nope"]), CliArgError);
  });
});
