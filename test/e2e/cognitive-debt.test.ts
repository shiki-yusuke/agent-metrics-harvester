// End-to-end: the real `agent-metrics-cognitive-debt` bin (dist/src/cognitive-debt/main.js) as a
// subprocess over the baseline synthetic fixture (test/support/cognitive-debt-fixtures.ts):
// R1 = full chain, R2 = lane_ref null, R3 = no release event. Offline; temp git repos only.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serializeOutput } from "../../src/cognitive-debt/jcs.js";
import { type Scenario, baseSpec, buildScenario } from "../support/cognitive-debt-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "..", "src", "cognitive-debt", "main.js");
const HARVESTER_BIN = path.join(HERE, "..", "..", "src", "cli", "main.js");

const DESIGN_LIMITS = [
  "M1 の起点は「解説が初めて uncovered と書いた commit」であって、負債が生じた時刻ではない。",
  "M2 と coverage の lane revision は `T_release` 以前の最新 snapshot で近似している。`lane_ref` は revision を pin しない。観測は merge_sha の first-parent 差分だけで、follow-up や別 PR は含まない。dir 候補の hit は `dir_width` と併読する。",
  "M3 は shadow 評価であり本番 receipt の verdict ではない。母集団は永続化された評価レコードだけで、現状は 0 件から始まり、`input_digest` が wrapper に入るまでは null。bucket の時刻は自己申告の `evaluation_cut`。",
  "coverage は lane の scope 集合を正とし、scope を記録しなかった release は分母に入らない。",
  "個人・チーム・モデルの評価に使えない。min_cell 抑制は再識別の完全な防止ではない。",
  "M3 は wrapper の `input_digest`（release-evidence 側の追加）が前提で、それまで null。`input_digest` が揃っても束縛は「評価器がこの入力 bytes を見た」ことまでで、評価器の実装が正しかったことの証明ではない。",
];

describe("agent-metrics-cognitive-debt (bin, e2e)", () => {
  let scenario: Scenario;
  let out: string;
  let bytes: Buffer;
  // biome-ignore lint/suspicious/noExplicitAny: parsed report under test
  let report: any;

  before(() => {
    scenario = buildScenario(baseSpec());
    out = path.join(scenario.root, "out.json");
    execFileSync("node", [BIN, ...scenario.args(out)], { stdio: ["ignore", "ignore", "pipe"] });
    bytes = readFileSync(out);
    report = JSON.parse(bytes.toString("utf-8"));
  });
  after(() => scenario.cleanup());

  it("--help exits 0 and lists every flag", () => {
    const r = spawnSync("node", [BIN, "--help"], { encoding: "utf-8" });
    assert.equal(r.status, 0);
    for (const flag of [
      "--release-ids",
      "--release-ledger",
      "--ack",
      "--lane-repo",
      "--lane-evidence",
      "--explanations",
      "--evaluations",
      "--as-of",
      "--out",
      "--detail",
      "--ledger-path",
      "--bundles-dir",
    ]) {
      assert.ok(r.stdout.includes(flag), `help mentions ${flag}`);
    }
  });

  it("a missing required flag exits 2 with exactly one stderr line", () => {
    const args = scenario
      .args(out)
      .filter((_, i, all) => all[i] !== "--ack" && all[i - 1] !== "--ack");
    const r = spawnSync("node", [BIN, ...args], { encoding: "utf-8" });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trimEnd().split("\n").length, 1);
    assert.match(r.stderr, /--ack/);
  });

  it("the envelope has exactly the design section 3 keys", () => {
    assert.deepEqual(Object.keys(report).sort(), [
      "ack",
      "as_of",
      "authority",
      "coverage",
      "generator",
      "inputs",
      "limits",
      "m1_open_assertions",
      "m2_prediction_error",
      "m3_abstain_reasons",
      "missing",
      "population",
      "schema_version",
      "suppressed_rows",
    ]);
    assert.equal(report.schema_version, "cognitive-debt-metrics/v0");
    assert.equal(report.authority, "none");
    assert.equal(report.as_of, scenario.asOf);
    assert.deepEqual(report.generator.options, { detail: false });
  });

  it("top-level population: requested release ids and the ones the chain resolved to a bundle", () => {
    assert.deepEqual(report.population, { requested_releases: 3, resolved_releases: 2 });
  });

  it("`agent-metrics-harvester cognitive-debt ...` writes the same bytes as the separate bin", () => {
    const viaSubcommand = path.join(scenario.root, "out-subcommand.json");
    const r = spawnSync(
      "node",
      [HARVESTER_BIN, "cognitive-debt", ...scenario.args(viaSubcommand)],
      {
        encoding: "utf-8",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(viaSubcommand), bytes);
  });

  it("limits are the design section 5 sentences, verbatim and in order", () => {
    assert.deepEqual(report.limits, DESIGN_LIMITS);
  });

  it("release chain: R3 has no release event, R2 has lane_ref null", () => {
    assert.deepEqual(report.missing.no_release_event, { count: 1, unit: "release" });
    assert.equal(report.missing.ambiguous_bundle_digest.count, 0);
    assert.equal(report.missing.no_bundle.count, 0);
    assert.equal(report.missing.bundle_release_id_mismatch.count, 0);
    assert.deepEqual(report.m2_prediction_error.missing.no_lane_ref, { count: 1, unit: "release" });
    assert.equal(report.m2_prediction_error.population.resolved_releases, 2);
  });

  it("M1: two episodes, one covered and one open", () => {
    const m1 = report.m1_open_assertions.overall;
    assert.equal(m1.population.episodes, 2);
    assert.equal(m1.open, 1);
    assert.equal(m1.covered, 1);
    assert.equal(m1.dropped, 0);
    assert.deepEqual(m1.open_age_days, { p50: 30, p90: 30, max: 30 });
    assert.deepEqual(m1.oldest, [
      { explanation_id: "EXP-0000000000000001", path: "src/b.ts", since: "2026-01-02T00:00:00Z" },
    ]);
  });

  it("M2: one release-lane unit with hit / unused / missed / dir_hit", () => {
    const m2 = report.m2_prediction_error;
    assert.equal(m2.population.release_lanes, 1);
    assert.equal(m2.overall.units, 1);
    assert.deepEqual(m2.overall.sums, {
      observed: 3,
      candidate_file: 2,
      candidate_dir: 1,
      hit: 1,
      unused: 1,
      missed: 1,
      dir_hit: 1,
      dir_unused: 0,
      unmatched_pattern: 0,
    });
    assert.equal(m2.overall.missed_ratio, 0.33);
    assert.equal(m2.overall.unused_ratio, 0.5);
    assert.equal(m2.overall.high_risk_units_with_missed, 1);
    assert.equal(m2.detail, null);
  });

  it("M3 is not_computed with every other field null", () => {
    const m3 = report.m3_abstain_reasons;
    assert.equal(m3.status, "not_computed");
    assert.equal(m3.reason, "awaiting_input_digest");
    assert.equal(Object.keys(m3).length, 11);
    for (const [k, v] of Object.entries(m3)) {
      if (k !== "status" && k !== "reason") assert.equal(v, null, k);
    }
  });

  it("ack and coverage join through the approval event", () => {
    assert.equal(report.ack.population.approvals, 1);
    assert.equal(report.ack.population.approvals_with_ack, 1);
    assert.deepEqual(report.coverage.population, {
      approvals_in_denominator: 1,
      approvals_in_denominator_high: 1,
    });
    assert.equal(report.coverage.covered, 1);
    assert.equal(report.coverage.ratio, 1);
    assert.equal(report.coverage.missing.releases_without_lane_scope.count, 1);
  });

  it("the file is the JCS bytes themselves (re-canonicalizing changes nothing, no newline)", () => {
    assert.equal(serializeOutput(report), bytes.toString("utf-8"));
    assert.notEqual(bytes[bytes.length - 1], 0x0a);
  });

  it("inputs[] are kind-ordered with commits for git inputs and files[] for the rest", () => {
    const kinds = report.inputs.map((i: { kind: string }) => i.kind);
    assert.deepEqual(kinds, [
      "ack_composite",
      "evaluations",
      "explanations",
      "lane_estimates",
      "lane_evidence",
      "release_ids",
      "release_ledger",
    ]);
    for (const entry of report.inputs) {
      if ("repo" in entry) {
        assert.match(entry.commit, /^[0-9a-f]{40}$/, entry.kind);
      } else {
        assert.ok(entry.files.length >= 1, entry.kind);
        for (const f of entry.files) {
          assert.equal(typeof f.path, "string");
          assert.match(f.sha256, /^[0-9a-f]{64}$/);
        }
      }
    }
    const ids = report.inputs.find((i: { kind: string }) => i.kind === "release_ids");
    assert.equal(ids.count, 3);
  });
});
