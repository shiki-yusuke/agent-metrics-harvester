// End-to-end (but offline -- cache-only, no network) coverage for `runReport`, including
// acceptance criterion §8 "JSONL/SQLite が同一 fixture から byte-equivalent な report JSON".

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Store } from "../../src/application/types.js";
import { parseReportArgs } from "../../src/cli/report-args.js";
import { runReport } from "../../src/cli/report-command.js";
import { addCoverage, saveCache, upsertRecords } from "../../src/report/pr-metadata/cache.js";
import { emptyCache } from "../../src/report/pr-metadata/types.js";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { SqliteStore } from "../../src/stores/sqlite/sqlite-store.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

const REPO = "octo/example";

async function seedStore(store: Store, generatedAt: string): Promise<void> {
  const payload = makeTokenUsagePayload({ repository: REPO, subjectId: "run-1", generatedAt });
  await store.commitBatch({
    source: REPO,
    expectedCheckpoint: null,
    nextCheckpoint: { updatedAt: generatedAt, commentId: 1 },
    snapshots: [
      {
        upsertKey: payload.upsert_key,
        repository: REPO,
        payload,
        sourceCommentId: 1,
        sourceUpdatedAt: generatedAt,
        markerSha: "a".repeat(64),
      },
    ],
    rejections: [],
  });
}

async function seedMetadataCache(
  cachePath: string,
  startUtc: string,
  endUtc: string,
  mergedCount: number,
): Promise<void> {
  let cache = emptyCache();
  cache = upsertRecords(
    cache,
    Array.from({ length: mergedCount }, (_, i) => ({
      repository: REPO,
      prNumber: i + 1,
      openedAt: startUtc,
      mergedAt: new Date(Date.parse(startUtc) + 3_600_000).toISOString(),
      state: "merged" as const,
      githubUpdatedAt: startUtc,
      fetchedAt: startUtc,
    })),
  );
  cache = addCoverage(cache, REPO, { startUtc, endUtc });
  await saveCache(cachePath, cache);
}

describe("runReport: offline (cache-only), JSONL vs SQLite parity", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-report-cmd-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("produces byte-equivalent report JSON from an equivalent JSONL vs SQLite store", async () => {
    const generatedAt = "2026-07-10T00:00:00Z";
    const jsonlStore = await JsonlStore.open(path.join(dir, "store.jsonl"));
    await seedStore(jsonlStore, generatedAt);
    const sqliteStore = await SqliteStore.open(path.join(dir, "store.sqlite"));
    await seedStore(sqliteStore, generatedAt);
    await sqliteStore.close();

    const jsonlCachePath = path.join(dir, "cache-jsonl.json");
    const sqliteCachePath = path.join(dir, "cache-sqlite.json");
    await seedMetadataCache(jsonlCachePath, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", 5);
    await seedMetadataCache(sqliteCachePath, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", 5);

    const jsonlOpts = parseReportArgs([
      "cost-per-pr",
      "--store",
      "jsonl",
      "--store-path",
      path.join(dir, "store.jsonl"),
      "--repo",
      REPO,
      "--month",
      "2026-07",
      "--metadata-cache",
      jsonlCachePath,
      "--metadata-mode",
      "cache-only",
      "--format",
      "json",
    ]);
    const sqliteOpts = parseReportArgs([
      "cost-per-pr",
      "--store",
      "sqlite",
      "--store-path",
      path.join(dir, "store.sqlite"),
      "--repo",
      REPO,
      "--month",
      "2026-07",
      "--metadata-cache",
      sqliteCachePath,
      "--metadata-mode",
      "cache-only",
      "--format",
      "json",
    ]);

    const fixedNow = () => new Date("2026-09-01T00:00:00Z");
    const jsonlRun = await runReport(jsonlOpts, fixedNow);
    const sqliteRun = await runReport(sqliteOpts, fixedNow);

    assert.equal(
      jsonlRun.output,
      sqliteRun.output,
      "byte-equivalent report JSON from equivalent JSONL vs SQLite stores",
    );
    assert.equal(jsonlRun.resultA.status, "ok_observed");
  });

  it("renders markdown when --format markdown is given, from the same underlying result", async () => {
    const generatedAt = "2026-07-10T00:00:00Z";
    const store = await JsonlStore.open(path.join(dir, "store-md.jsonl"));
    await seedStore(store, generatedAt);
    const cachePath = path.join(dir, "cache-md.json");
    await seedMetadataCache(cachePath, "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", 5);

    const opts = parseReportArgs([
      "cost-per-pr",
      "--store-path",
      path.join(dir, "store-md.jsonl"),
      "--repo",
      REPO,
      "--month",
      "2026-07",
      "--metadata-cache",
      cachePath,
      "--metadata-mode",
      "cache-only",
      "--format",
      "markdown",
    ]);
    const run = await runReport(opts, () => new Date("2026-09-01T00:00:00Z"));
    assert.ok(run.output.startsWith("# Cost per merged PR"));
    assert.ok(run.output.includes("Merged PRs (n): 5"));
  });

  it("runs an A/B comparison end to end when --compare-month is given", async () => {
    const store = await JsonlStore.open(path.join(dir, "store-cmp.jsonl"));
    await seedStore(store, "2026-06-10T00:00:00Z");
    await store.commitBatch({
      source: REPO,
      expectedCheckpoint: { updatedAt: "2026-06-10T00:00:00Z", commentId: 1 },
      nextCheckpoint: { updatedAt: "2026-07-10T00:00:00Z", commentId: 2 },
      snapshots: [
        (() => {
          const payload = makeTokenUsagePayload({
            repository: REPO,
            subjectId: "run-2",
            generatedAt: "2026-07-10T00:00:00Z",
          });
          return {
            upsertKey: payload.upsert_key,
            repository: REPO,
            payload,
            sourceCommentId: 2,
            sourceUpdatedAt: "2026-07-10T00:00:00Z",
            markerSha: "b".repeat(64),
          };
        })(),
      ],
      rejections: [],
    });

    const cachePath = path.join(dir, "cache-cmp.json");
    let cache = emptyCache();
    cache = upsertRecords(cache, [
      ...Array.from({ length: 5 }, (_, i) => ({
        repository: REPO,
        prNumber: i + 1,
        openedAt: "2026-06-01T00:00:00Z",
        mergedAt: "2026-06-05T00:00:00Z",
        state: "merged" as const,
        githubUpdatedAt: "2026-06-05T00:00:00Z",
        fetchedAt: "2026-06-05T00:00:00Z",
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        repository: REPO,
        prNumber: 100 + i,
        openedAt: "2026-07-01T00:00:00Z",
        mergedAt: "2026-07-05T00:00:00Z",
        state: "merged" as const,
        githubUpdatedAt: "2026-07-05T00:00:00Z",
        fetchedAt: "2026-07-05T00:00:00Z",
      })),
    ]);
    cache = addCoverage(cache, REPO, {
      startUtc: "2026-06-01T00:00:00Z",
      endUtc: "2026-07-01T00:00:00Z",
    });
    cache = addCoverage(cache, REPO, {
      startUtc: "2026-07-01T00:00:00Z",
      endUtc: "2026-08-01T00:00:00Z",
    });
    await saveCache(cachePath, cache);

    const opts = parseReportArgs([
      "cost-per-pr",
      "--store-path",
      path.join(dir, "store-cmp.jsonl"),
      "--repo",
      REPO,
      "--month",
      "2026-07",
      "--compare-month",
      "2026-06",
      "--metadata-cache",
      cachePath,
      "--metadata-mode",
      "cache-only",
      "--format",
      "json",
    ]);
    const run = await runReport(opts, () => new Date("2026-09-01T00:00:00Z"));
    const parsed = JSON.parse(run.output) as {
      report: string;
      comparison: { merged_pr_count: { baseline_value: number; value: number } };
    };
    assert.equal(parsed.report, "cost-per-pr-comparison");
    assert.equal(parsed.comparison.merged_pr_count.baseline_value, 5);
    assert.equal(parsed.comparison.merged_pr_count.value, 6);
  });
});
