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
      () =>
        parseArgs([
          "--repo",
          "octo/example",
          "--store-path",
          "x",
          "--allowed-login",
          "a",
          "--store",
          "yaml",
        ]),
      CliArgError,
    );
  });

  it("rejects an unrecognized flag", () => {
    assert.throws(() => parseArgs(["--nope"]), CliArgError);
  });

  describe("--store-path path traversal (should-5 regression)", () => {
    const base = ["--repo", "octo/example", "--allowed-login", "a"];

    it("rejects a leading ../ segment", () => {
      assert.throws(() => parseArgs([...base, "--store-path", "../evil.jsonl"]), CliArgError);
    });

    it("rejects a .. segment buried in the middle of the path", () => {
      assert.throws(
        () => parseArgs([...base, "--store-path", "data/../../../etc/passwd"]),
        CliArgError,
      );
    });

    it("rejects a .. segment using a backslash separator", () => {
      assert.throws(
        () => parseArgs([...base, "--store-path", "data\\..\\..\\evil.jsonl"]),
        CliArgError,
      );
    });

    it("accepts an ordinary relative path", () => {
      const opts = parseArgs([...base, "--store-path", "data/store.jsonl"]);
      assert.equal(opts.storePath, "data/store.jsonl");
    });

    it("accepts an absolute path (not a traversal -- an explicit, non-escaping choice)", () => {
      const opts = parseArgs([...base, "--store-path", "/var/data/store.jsonl"]);
      assert.equal(opts.storePath, "/var/data/store.jsonl");
    });

    it("does not false-positive on a filename that merely contains '..' as a substring, not a full segment", () => {
      const opts = parseArgs([...base, "--store-path", "data/my..file.jsonl"]);
      assert.equal(opts.storePath, "data/my..file.jsonl");
    });
  });

  describe("G5 regression: numeric flags reject NaN and negative values", () => {
    const base = ["--repo", "octo/example", "--store-path", "x", "--allowed-login", "a"];
    const numericFlags = [
      "--lookback-days",
      "--overlap-seconds",
      "--max-api-requests",
      "--rate-limit-floor",
      "--max-runtime-seconds",
      "--max-pages-per-fetch",
    ];
    const optionKeys: Record<string, string> = {
      "--lookback-days": "lookbackDays",
      "--overlap-seconds": "overlapSeconds",
      "--max-api-requests": "maxApiRequests",
      "--rate-limit-floor": "rateLimitFloor",
      "--max-runtime-seconds": "maxRuntimeSeconds",
      "--max-pages-per-fetch": "maxPagesPerFetch",
    };

    for (const flag of numericFlags) {
      it(`${flag} rejects a non-numeric value (was: silently NaN, safety valve fails open)`, () => {
        assert.throws(() => parseArgs([...base, flag, "abc"]), CliArgError);
      });

      it(`${flag} rejects a negative value`, () => {
        assert.throws(() => parseArgs([...base, flag, "-1"]), CliArgError);
      });

      it(`${flag} rejects an empty value`, () => {
        assert.throws(() => parseArgs([...base, flag, ""]), CliArgError);
      });

      it(`${flag} rejects a decimal value`, () => {
        assert.throws(() => parseArgs([...base, flag, "1.5"]), CliArgError);
      });

      it(`${flag} accepts zero`, () => {
        const opts = parseArgs([...base, flag, "0"]);
        const key = optionKeys[flag] as keyof typeof opts;
        assert.equal(opts[key], 0);
      });

      it(`${flag} accepts a positive integer`, () => {
        const opts = parseArgs([...base, flag, "42"]);
        const key = optionKeys[flag] as keyof typeof opts;
        assert.equal(opts[key], 42);
      });
    }

    it("a NaN --max-api-requests does not leave the SafetyValve silently disabled (fails at arg-parse time instead)", () => {
      // Before the fix, `Number.parseInt("abc", 10)` produced NaN, which parseArgs happily
      // returned as `maxApiRequests`. SafetyValve.previewCheck's own guard
      // (`this.requestCount + pendingRequests >= this.opts.maxApiRequests`) is `false` for any
      // NaN operand, so the valve never tripped -- a typo'd flag silently disabled the budget
      // instead of rejecting the run. Asserting the CliArgError above is the real regression
      // guard; this test documents *why* that matters end-to-end.
      assert.throws(() => parseArgs([...base, "--max-api-requests", "abc"]), CliArgError);
    });

    it("--max-api-requests rejects a value past Number.MAX_SAFE_INTEGER (must-fix regression: Number.parseInt silently rounds it)", () => {
      assert.throws(
        () => parseArgs([...base, "--max-api-requests", "9007199254740993"]),
        CliArgError,
      );
    });
  });
});
