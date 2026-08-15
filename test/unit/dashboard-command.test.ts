// Wiring test for `runDashboard` (command.ts): a fixture JSONL store (built through the real
// JsonlStore, the same way test/unit/snapshot-reader.test.ts does) plus a fixture
// `aggregates/` directory, run end to end with no `--repo` flag -- proving the dashboard
// generator discovers every repository the store contains on its own (all-repositories-reader.ts),
// rather than requiring the caller to enumerate them.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runDashboard } from "../../src/dashboard/command.js";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

const NOW_ISO = "2026-08-15T00:00:00Z";

describe("runDashboard", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-dashboard-command-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("discovers every repository in the store automatically and writes index.html", async () => {
    const storePath = path.join(dir, "store.jsonl");
    const store = await JsonlStore.open(storePath);
    const payloadA = makeTokenUsagePayload({ repository: "octo/a", subjectId: "run-a" });
    const payloadB = makeTokenUsagePayload({ repository: "octo/b", subjectId: "run-b" });
    await store.commitBatch({
      source: "octo/a",
      expectedCheckpoint: null,
      nextCheckpoint: { updatedAt: "2026-08-01T00:00:00Z", commentId: 1 },
      snapshots: [
        {
          upsertKey: payloadA.upsert_key,
          repository: "octo/a",
          payload: payloadA,
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-08-01T00:00:00Z",
          markerSha: "a".repeat(64),
        },
      ],
      rejections: [],
    });
    await store.commitBatch({
      source: "octo/b",
      expectedCheckpoint: null,
      nextCheckpoint: { updatedAt: "2026-08-01T00:00:00Z", commentId: 1 },
      snapshots: [
        {
          upsertKey: payloadB.upsert_key,
          repository: "octo/b",
          payload: payloadB,
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-08-01T00:00:00Z",
          markerSha: "b".repeat(64),
        },
      ],
      rejections: [],
    });

    const aggregatesDir = path.join(dir, "aggregates");
    await mkdir(aggregatesDir, { recursive: true });
    await writeFile(
      path.join(aggregatesDir, "2026-08.jsonl"),
      `${JSON.stringify({ kind: "heartbeat", source: "workflow", at: "2026-08-14T00:00:00Z" })}\n`,
      "utf-8",
    );

    const outDir = path.join(dir, "out");
    const result = await runDashboard({
      storeKind: "jsonl",
      storePath,
      aggregatesDir,
      outDir,
      now: NOW_ISO,
    });

    assert.equal(result.outPath, path.join(outDir, "index.html"));
    const written = await readFile(result.outPath, "utf-8");
    assert.equal(written, result.html);

    const groups = result.data.cost.groups.map((g) => g.repo).sort();
    assert.deepEqual(groups, ["octo/a", "octo/b"], "both repos found without a --repo flag");
    assert.equal(result.data.freshness.pipelineHeartbeatAt, "2026-08-14T00:00:00Z");
  });

  it("is deterministic across two runs with the same --now, byte-identical output", async () => {
    const storePath = path.join(dir, "store2.jsonl");
    const store = await JsonlStore.open(storePath);
    const payload = makeTokenUsagePayload({ repository: "octo/example" });
    await store.commitBatch({
      source: "octo/example",
      expectedCheckpoint: null,
      nextCheckpoint: { updatedAt: "2026-08-01T00:00:00Z", commentId: 1 },
      snapshots: [
        {
          upsertKey: payload.upsert_key,
          repository: "octo/example",
          payload,
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-08-01T00:00:00Z",
          markerSha: "a".repeat(64),
        },
      ],
      rejections: [],
    });

    const aggregatesDir = path.join(dir, "aggregates-empty-2");
    const outDir1 = path.join(dir, "out2a");
    const outDir2 = path.join(dir, "out2b");

    const opts = { storeKind: "jsonl" as const, storePath, aggregatesDir, now: NOW_ISO };
    const run1 = await runDashboard({ ...opts, outDir: outDir1 });
    const run2 = await runDashboard({ ...opts, outDir: outDir2 });

    assert.equal(run1.html, run2.html);
  });

  it("succeeds on a completely empty store and missing aggregates dir, exit-clean with a full 5-panel dashboard", async () => {
    const storePath = path.join(dir, "does-not-exist.jsonl");
    const aggregatesDir = path.join(dir, "also-does-not-exist");
    const outDir = path.join(dir, "out-empty");

    const result = await runDashboard({
      storeKind: "jsonl",
      storePath,
      aggregatesDir,
      outDir,
      now: NOW_ISO,
    });
    assert.match(result.html, /<!doctype html>/);
    assert.equal(result.data.cost.meta.n, 0);
    assert.equal(result.data.calibration.meta.n, 0);
    assert.equal(result.data.attribution.meta.n, 0);
    assert.equal(result.data.cohort.meta.n, 0);
  });

  it("skips a corrupt/malformed aggregate line instead of crashing", async () => {
    const storePath = path.join(dir, "does-not-exist-3.jsonl");
    const aggregatesDir = path.join(dir, "aggregates-corrupt");
    await mkdir(aggregatesDir, { recursive: true });
    const corruptLine = "not even json";
    const missingFieldLine = JSON.stringify({ kind: "heartbeat", source: "workflow" }); // missing `at` -- invalid
    const validLine = JSON.stringify({
      kind: "heartbeat",
      source: "workflow",
      at: "2026-08-10T00:00:00Z",
    });
    await writeFile(
      path.join(aggregatesDir, "2026-08.jsonl"),
      `${corruptLine}\n${missingFieldLine}\n${validLine}\n`,
      "utf-8",
    );
    const outDir = path.join(dir, "out-corrupt");
    const result = await runDashboard({
      storeKind: "jsonl",
      storePath,
      aggregatesDir,
      outDir,
      now: NOW_ISO,
    });
    assert.equal(result.data.freshness.pipelineHeartbeatAt, "2026-08-10T00:00:00Z");
  });

  it("applies the operator's --empty-reason-config file to the rendered HTML", async () => {
    const storePath = path.join(dir, "does-not-exist-4.jsonl");
    const aggregatesDir = path.join(dir, "also-does-not-exist-4");
    const outDir = path.join(dir, "out-empty-reason");
    const configPath = path.join(dir, "empty-reasons.json");
    await writeFile(
      configPath,
      JSON.stringify({
        calibration: { code: "not_produced", note: "adopt が一度も実行されていません" },
        attribution: { code: "withheld", note: "global 集計に private repo を含むため" },
        cohort: { code: "insufficient_data" },
      }),
      "utf-8",
    );

    const result = await runDashboard({
      storeKind: "jsonl",
      storePath,
      aggregatesDir,
      outDir,
      now: NOW_ISO,
      emptyReasonConfigPath: configPath,
    });

    assert.match(result.html, /empty-notice-not_produced/);
    assert.match(result.html, /empty-notice-withheld/);
    assert.match(result.html, /empty-notice-insufficient_data/);
    assert.ok(result.html.includes("adopt が一度も実行されていません"));
    assert.ok(result.html.includes("global 集計に private repo を含むため"));
  });

  it("fails loudly when --empty-reason-config points at an invalid file, instead of silently falling back", async () => {
    const storePath = path.join(dir, "does-not-exist-5.jsonl");
    const aggregatesDir = path.join(dir, "also-does-not-exist-5");
    const outDir = path.join(dir, "out-bad-reason-config");
    const configPath = path.join(dir, "bad-empty-reasons.json");
    await writeFile(configPath, JSON.stringify({ calibration: { code: "bogus" } }), "utf-8");

    await assert.rejects(() =>
      runDashboard({
        storeKind: "jsonl",
        storePath,
        aggregatesDir,
        outDir,
        now: NOW_ISO,
        emptyReasonConfigPath: configPath,
      }),
    );
  });
});
