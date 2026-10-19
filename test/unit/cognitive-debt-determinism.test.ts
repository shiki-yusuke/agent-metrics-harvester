// Determinism (cognitive-debt-metrics/v0 design section 3): same inputs[] + as_of + version +
// options.detail => identical bytes, regardless of input order or working-tree state.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { serializeOutput } from "../../src/cognitive-debt/jcs.js";
import {
  EVENT_1,
  SHA_A,
  SHA_B,
  ackRecord,
  approvalEvent,
  baseSpec,
  buildScenario,
  bundle,
  laneEvidenceDoc,
  runScenario,
} from "../support/cognitive-debt-fixtures.js";

// biome-ignore lint/suspicious/noExplicitAny: parsed report
const withoutInputs = (report: any): string => serializeOutput({ ...report, inputs: null });

describe("cognitive-debt determinism", () => {
  it("the same fixture twice gives identical bytes", async () => {
    const s = buildScenario(baseSpec());
    try {
      const a = await runScenario(s, [], "a.json");
      const b = await runScenario(s, [], "b.json");
      assert.equal(a.code, 0);
      assert.ok(a.bytes && b.bytes && a.bytes.equals(b.bytes));
    } finally {
      s.cleanup();
    }
  });

  it("reversing release_ids, lane-evidence file names and ack_records order changes nothing but input hashes", async () => {
    const build = (reversed: boolean) => {
      const spec = baseSpec();
      spec.releaseIds = reversed ? ["R3", "R2", "R1"] : ["R1", "R2", "R3"];
      spec.laneEvidence = (ctx) => {
        const docs = [
          laneEvidenceDoc("L-1", ctx.laneShas[1] as string),
          laneEvidenceDoc("L-2", null),
        ];
        const [x, y] = reversed ? [docs[1], docs[0]] : [docs[0], docs[1]];
        return { "a.json": x as Record<string, unknown>, "b.json": y as Record<string, unknown> };
      };
      spec.ack = (ctx) => {
        const records = [
          ackRecord(SHA_A, EVENT_1, { occurred_at: "2026-01-11T00:00:00Z", self_report: "held" }),
          ackRecord(SHA_B, EVENT_1, {
            occurred_at: "2026-01-11T00:00:00Z",
            self_report: "acknowledged",
          }),
        ];
        return {
          approval_events: [approvalEvent(EVENT_1, ctx.digest(bundle("R1", "L-1")))],
          ack_records: reversed ? records.reverse() : records,
        };
      };
      return buildScenario(spec);
    };
    const forward = build(false);
    const backward = build(true);
    try {
      const a = await runScenario(forward);
      const b = await runScenario(backward);
      assert.equal(withoutInputs(a.report), withoutInputs(b.report));
      // Git inputs are content-addressed with fixed dates: identical commits in both builds.
      const commits = (r: typeof a) =>
        r.report.inputs
          .filter((i: { commit?: string }) => "commit" in i)
          .map((i: { commit: string }) => i.commit);
      assert.deepEqual(commits(a), commits(b));
      // Tie on occurred_at -> the byte-order last record_id (SHA_B, "acknowledged") is adopted.
      assert.deepEqual(a.report.ack.overall.self_report, { acknowledged: 1, held: 0, rejected: 0 });
      assert.equal(a.report.ack.missing.duplicate_ack_records.count, 1);
      assert.equal(a.report.ack.missing.approvals_with_duplicate_ack.count, 1);
    } finally {
      forward.cleanup();
      backward.cleanup();
    }
  });

  it("uncommitted working-tree and index changes in every repo do not change the bytes", async () => {
    const s = buildScenario(baseSpec());
    try {
      const before = await runScenario(s, [], "before.json");
      writeFileSync(path.join(s.repos.lane, "docs/spec/L-1/estimate.json"), "{}");
      writeFileSync(path.join(s.repos.corpus, "explanations/EXP-0000000000000001.json"), "{broken");
      writeFileSync(path.join(s.repos.corpus, "explanations/EXP-00000000000000ff.json"), "{}");
      appendFileSync(path.join(s.repos.ledger, "release-events.jsonl"), "not json\n");
      writeFileSync(path.join(s.repos.ledger, "bundles/new.json"), "{}");
      writeFileSync(path.join(s.repos.evaluations, "README.md"), "dirty\n");
      const after = await runScenario(s, [], "after.json");
      assert.ok(before.bytes && after.bytes && before.bytes.equals(after.bytes));
    } finally {
      s.cleanup();
    }
  });

  it("--detail is recorded in generator.options.detail and adds m2 detail rows", async () => {
    const s = buildScenario(baseSpec());
    try {
      const plain = await runScenario(s, [], "plain.json");
      const detailed = await runScenario(s, ["--detail"], "detail.json");
      assert.deepEqual(plain.report.generator.options, { detail: false });
      assert.deepEqual(detailed.report.generator.options, { detail: true });
      assert.equal(plain.report.m2_prediction_error.detail, null);
      assert.equal(detailed.report.m2_prediction_error.detail.length, 1);
    } finally {
      s.cleanup();
    }
  });

  it("commit selection: the first first-parent commit at or before as_of, never a later one", async () => {
    const spec = baseSpec();
    spec.asOf = "2026-01-02T12:00:00Z";
    const s = buildScenario(spec);
    try {
      const r = await runScenario(s);
      const lane = r.report.inputs.find((i: { kind: string }) => i.kind === "lane_estimates");
      assert.equal(lane.commit, s.laneShas[0]);
      // The ledger's only commit (2026-01-10) is after as_of: no commit, every release unresolved.
      const ledger = r.report.inputs.find((i: { kind: string }) => i.kind === "release_ledger");
      assert.equal(ledger.commit, null);
      assert.equal(r.report.missing.no_commit_at_as_of.count, 1);
      assert.equal(r.report.missing.no_release_event.count, 3);
    } finally {
      s.cleanup();
    }
  });

  it("refuses a non-git repo argument with exit 1", async () => {
    const s = buildScenario(baseSpec());
    try {
      const notGit = mkdtempSync(path.join(tmpdir(), "cd-notgit-"));
      const stderr: string[] = [];
      const { runCognitiveDebt } = await import("../../src/cognitive-debt/run.js");
      const args = s
        .args(path.join(s.root, "x.json"))
        .map((a, i, all) => (all[i - 1] === "--evaluations" ? notGit : a));
      const code = await runCognitiveDebt(args, {
        stdout: () => {},
        stderr: (l) => stderr.push(l),
      });
      assert.equal(code, 1);
      assert.match(stderr.join("\n"), /not a git repository/);
    } finally {
      s.cleanup();
    }
  });
});
