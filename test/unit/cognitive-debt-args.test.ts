import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CognitiveDebtArgError, parseCognitiveDebtArgs } from "../../src/cognitive-debt/args.js";

const FULL = [
  "--release-ids",
  "ids.json",
  "--release-ledger",
  "re",
  "--ack",
  "ack.json",
  "--lane-repo",
  "lane",
  "--lane-evidence",
  "le",
  "--explanations",
  "corpus",
  "--evaluations",
  "evals",
  "--as-of",
  "2026-02-01T00:00:00Z",
  "--out",
  "out.json",
];

describe("parseCognitiveDebtArgs", () => {
  it("parses the design section 4 flag set with defaults", () => {
    const opts = parseCognitiveDebtArgs(FULL);
    assert.equal(opts.help, false);
    if (opts.help) return;
    assert.equal(opts.detail, false);
    assert.equal(opts.ledgerPath, "release-events.jsonl");
    assert.equal(opts.bundlesDir, "bundles");
    assert.equal(opts.asOf, "2026-02-01T00:00:00Z");
  });

  it("accepts --detail, --ledger-path and --bundles-dir", () => {
    const opts = parseCognitiveDebtArgs([
      ...FULL,
      "--detail",
      "--ledger-path",
      "x/events.jsonl",
      "--bundles-dir",
      "b/",
    ]);
    assert.ok(
      !opts.help && opts.detail && opts.ledgerPath === "x/events.jsonl" && opts.bundlesDir === "b",
    );
  });

  it("rejects every missing required flag", () => {
    for (let i = 0; i < FULL.length; i += 2) {
      const argv = [...FULL.slice(0, i), ...FULL.slice(i + 2)];
      assert.throws(() => parseCognitiveDebtArgs(argv), CognitiveDebtArgError, FULL[i]);
    }
  });

  it("rejects a non-UTC or unparseable --as-of", () => {
    for (const bad of ["2026-02-01", "2026-02-01T00:00:00+09:00", "yesterday"]) {
      const argv = FULL.map((a, i) => (FULL[i - 1] === "--as-of" ? bad : a));
      assert.throws(() => parseCognitiveDebtArgs(argv), CognitiveDebtArgError, bad);
    }
  });

  it("rejects unknown flags, repeated flags and escaping repo-relative paths", () => {
    assert.throws(() => parseCognitiveDebtArgs([...FULL, "--nope"]), CognitiveDebtArgError);
    assert.throws(() => parseCognitiveDebtArgs([...FULL, "--out", "x"]), CognitiveDebtArgError);
    assert.throws(
      () => parseCognitiveDebtArgs([...FULL, "--ledger-path", "../x"]),
      CognitiveDebtArgError,
    );
    assert.throws(
      () => parseCognitiveDebtArgs([...FULL, "--bundles-dir", "/abs"]),
      CognitiveDebtArgError,
    );
  });

  it("--help wins", () => {
    assert.deepEqual(parseCognitiveDebtArgs(["--help"]), { help: true });
  });
});
