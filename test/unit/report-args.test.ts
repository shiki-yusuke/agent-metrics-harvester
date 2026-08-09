import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReportArgError, parseReportArgs } from "../../src/cli/report-args.js";

const BASE = [
  "cost-per-pr",
  "--store-path",
  "./data/store.jsonl",
  "--repo",
  "octo/example",
  "--month",
  "2026-07",
  "--metadata-cache",
  "./data/cache.json",
  "--format",
  "json",
];

describe("parseReportArgs", () => {
  it("parses a minimal valid invocation", () => {
    const opts = parseReportArgs(BASE);
    assert.equal(opts.command, "cost-per-pr");
    assert.deepEqual(opts.repos, ["octo/example"]);
    assert.equal(opts.periodKind, "month");
    assert.equal(opts.periodLabel, "2026-07");
    assert.equal(opts.timezone, "UTC");
    assert.equal(opts.metadataMode, "auto");
  });

  it("rejects an unrecognized command", () => {
    assert.throws(() => parseReportArgs(["not-a-command"]), ReportArgError);
    assert.throws(() => parseReportArgs([]), ReportArgError);
  });

  it("rejects both --repo and --team-config together", () => {
    assert.throws(() => parseReportArgs([...BASE, "--team-config", "./team.yaml"]), ReportArgError);
  });

  it("requires exactly one of --repo or --team-config", () => {
    const withoutRepo = [
      "cost-per-pr",
      "--store-path",
      "./data/store.jsonl",
      "--month",
      "2026-07",
      "--metadata-cache",
      "./data/cache.json",
      "--format",
      "json",
    ];
    assert.throws(() => parseReportArgs(withoutRepo), ReportArgError);
  });

  it("rejects --team without --team-config", () => {
    assert.throws(() => parseReportArgs([...BASE, "--team", "platform"]), ReportArgError);
  });

  it("rejects both --month and --week", () => {
    assert.throws(() => parseReportArgs([...BASE, "--week", "2026-W27"]), ReportArgError);
  });

  it("rejects --compare-week when the primary period is --month", () => {
    assert.throws(() => parseReportArgs([...BASE, "--compare-week", "2026-W26"]), ReportArgError);
  });

  it("accepts --compare-month alongside --month", () => {
    const opts = parseReportArgs([...BASE, "--compare-month", "2026-06"]);
    assert.equal(opts.comparePeriodLabel, "2026-06");
  });

  it("rejects a '..' segment in --store-path", () => {
    const args = BASE.map((a) => (a === "./data/store.jsonl" ? "../evil.jsonl" : a));
    assert.throws(() => parseReportArgs(args), ReportArgError);
  });

  it("rejects a '..' segment in --metadata-cache", () => {
    const args = BASE.map((a) => (a === "./data/cache.json" ? "../evil-cache.json" : a));
    assert.throws(() => parseReportArgs(args), ReportArgError);
  });

  it("rejects an invalid --format", () => {
    const args = BASE.map((a) => (a === "json" ? "yaml" : a));
    assert.throws(() => parseReportArgs(args), ReportArgError);
  });

  it("rejects an invalid --metadata-mode", () => {
    assert.throws(() => parseReportArgs([...BASE, "--metadata-mode", "sometimes"]), ReportArgError);
  });

  it("accepts --metadata-mode cache-only", () => {
    const opts = parseReportArgs([...BASE, "--metadata-mode", "cache-only"]);
    assert.equal(opts.metadataMode, "cache-only");
  });

  it("rejects an unrecognized flag", () => {
    assert.throws(() => parseReportArgs([...BASE, "--author", "someone"]), ReportArgError);
  });

  describe("should-1 regression: numeric flags reject NaN and negative values", () => {
    const numericFlags = [
      "--max-api-requests",
      "--rate-limit-floor",
      "--max-runtime-seconds",
      "--min-sample-size",
    ];

    for (const flag of numericFlags) {
      it(`${flag} rejects a non-numeric value`, () => {
        assert.throws(() => parseReportArgs([...BASE, flag, "abc"]), ReportArgError);
      });

      it(`${flag} rejects a negative value`, () => {
        assert.throws(() => parseReportArgs([...BASE, flag, "-1"]), ReportArgError);
      });

      it(`${flag} rejects an empty value`, () => {
        assert.throws(() => parseReportArgs([...BASE, flag, ""]), ReportArgError);
      });

      it(`${flag} rejects a decimal value`, () => {
        assert.throws(() => parseReportArgs([...BASE, flag, "1.5"]), ReportArgError);
      });

      it(`${flag} accepts zero`, () => {
        const opts = parseReportArgs([...BASE, flag, "0"]);
        const key = {
          "--max-api-requests": "maxApiRequests",
          "--rate-limit-floor": "rateLimitFloor",
          "--max-runtime-seconds": "maxRuntimeSeconds",
          "--min-sample-size": "minSampleSize",
        }[flag] as keyof typeof opts;
        assert.equal(opts[key], 0);
      });

      it(`${flag} accepts a positive integer`, () => {
        const opts = parseReportArgs([...BASE, flag, "42"]);
        const key = {
          "--max-api-requests": "maxApiRequests",
          "--rate-limit-floor": "rateLimitFloor",
          "--max-runtime-seconds": "maxRuntimeSeconds",
          "--min-sample-size": "minSampleSize",
        }[flag] as keyof typeof opts;
        assert.equal(opts[key], 42);
      });
    }

    it("--max-api-requests rejects a value past Number.MAX_SAFE_INTEGER (must-fix regression: Number.parseInt silently rounds it)", () => {
      assert.throws(
        () => parseReportArgs([...BASE, "--max-api-requests", "9007199254740993"]),
        ReportArgError,
      );
    });

    it("--max-api-requests error message is stable for users depending on its exact wording", () => {
      try {
        parseReportArgs([...BASE, "--max-api-requests", "abc"]);
        assert.fail("expected parseReportArgs to throw");
      } catch (err) {
        assert.equal(
          (err as Error).message,
          '--max-api-requests must be a non-negative integer, got "abc"',
        );
      }
    });
  });
});
