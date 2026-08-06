import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  addCoverage,
  loadCache,
  mergeCoverageRange,
  rangeCoversFully,
  recordsForRepositoryInRange,
  saveCache,
  upsertRecords,
} from "../../src/report/pr-metadata/cache.js";
import { type PR_METADATA_CACHE_VERSION, emptyCache } from "../../src/report/pr-metadata/types.js";

describe("rangeCoversFully", () => {
  it("is true for an exact single covering range", () => {
    const ranges = [{ startUtc: "2026-01-01T00:00:00Z", endUtc: "2026-02-01T00:00:00Z" }];
    assert.equal(rangeCoversFully(ranges, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), true);
  });

  it("is true when several ranges together cover the window", () => {
    const ranges = [
      { startUtc: "2026-01-01T00:00:00Z", endUtc: "2026-01-15T00:00:00Z" },
      { startUtc: "2026-01-15T00:00:00Z", endUtc: "2026-02-01T00:00:00Z" },
    ];
    assert.equal(rangeCoversFully(ranges, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), true);
  });

  it("is false when there is a gap", () => {
    const ranges = [
      { startUtc: "2026-01-01T00:00:00Z", endUtc: "2026-01-10T00:00:00Z" },
      { startUtc: "2026-01-20T00:00:00Z", endUtc: "2026-02-01T00:00:00Z" },
    ];
    assert.equal(rangeCoversFully(ranges, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), false);
  });

  it("is false when the covered range is narrower than requested", () => {
    const ranges = [{ startUtc: "2026-01-05T00:00:00Z", endUtc: "2026-01-25T00:00:00Z" }];
    assert.equal(rangeCoversFully(ranges, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), false);
  });
});

describe("mergeCoverageRange", () => {
  it("coalesces an overlapping addition into one range", () => {
    const existing = [{ startUtc: "2026-01-01T00:00:00Z", endUtc: "2026-01-15T00:00:00Z" }];
    const merged = mergeCoverageRange(existing, {
      startUtc: "2026-01-10T00:00:00Z",
      endUtc: "2026-02-01T00:00:00Z",
    });
    assert.deepEqual(merged, [
      { startUtc: "2026-01-01T00:00:00Z", endUtc: "2026-02-01T00:00:00Z" },
    ]);
  });

  it("keeps disjoint ranges separate", () => {
    const existing = [{ startUtc: "2026-01-01T00:00:00Z", endUtc: "2026-01-10T00:00:00Z" }];
    const merged = mergeCoverageRange(existing, {
      startUtc: "2026-02-01T00:00:00Z",
      endUtc: "2026-02-10T00:00:00Z",
    });
    assert.equal(merged.length, 2);
  });
});

describe("upsertRecords / recordsForRepositoryInRange", () => {
  it("filters by repository and by mergedAt half-open range", () => {
    let cache = emptyCache();
    cache = upsertRecords(cache, [
      {
        repository: "octo/example",
        prNumber: 1,
        openedAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-01-05T00:00:00Z",
        state: "merged",
        githubUpdatedAt: "2026-01-05T00:00:00Z",
        fetchedAt: "2026-01-06T00:00:00Z",
      },
      {
        repository: "octo/example",
        prNumber: 2,
        openedAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-02-01T00:00:00Z",
        state: "merged",
        githubUpdatedAt: "2026-02-01T00:00:00Z",
        fetchedAt: "2026-02-02T00:00:00Z",
      }, // outside range
      {
        repository: "octo/other",
        prNumber: 1,
        openedAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-01-10T00:00:00Z",
        state: "merged",
        githubUpdatedAt: "2026-01-10T00:00:00Z",
        fetchedAt: "2026-01-11T00:00:00Z",
      }, // different repo
    ]);
    const records = recordsForRepositoryInRange(
      cache,
      "octo/example",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
    );
    assert.deepEqual(
      records.map((r) => r.prNumber),
      [1],
    );
  });

  it("upserting the same (repository, prNumber) replaces the previous record", () => {
    let cache = emptyCache();
    cache = upsertRecords(cache, [
      {
        repository: "octo/example",
        prNumber: 1,
        openedAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-01-05T00:00:00Z",
        state: "merged",
        githubUpdatedAt: "2026-01-05T00:00:00Z",
        fetchedAt: "2026-01-06T00:00:00Z",
      },
    ]);
    cache = upsertRecords(cache, [
      {
        repository: "octo/example",
        prNumber: 1,
        openedAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-01-06T00:00:00Z",
        state: "merged",
        githubUpdatedAt: "2026-01-06T00:00:00Z",
        fetchedAt: "2026-01-07T00:00:00Z",
      },
    ]);
    assert.equal(Object.keys(cache.records).length, 1);
    assert.equal(Object.values(cache.records)[0]?.mergedAt, "2026-01-06T00:00:00Z");
  });
});

describe("addCoverage", () => {
  it("adds and coalesces coverage for a repository", () => {
    let cache = emptyCache();
    cache = addCoverage(cache, "octo/example", {
      startUtc: "2026-01-01T00:00:00Z",
      endUtc: "2026-02-01T00:00:00Z",
    });
    assert.equal(
      rangeCoversFully(
        cache.coverage["octo/example"] ?? [],
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
      ),
      true,
    );
  });
});

describe("loadCache / saveCache", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-report-cache-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty cache when the file does not exist", async () => {
    const cache = await loadCache(path.join(dir, "missing.json"));
    assert.deepEqual(cache, emptyCache());
  });

  it("round-trips a saved cache", async () => {
    const filePath = path.join(dir, "cache.json");
    let cache = emptyCache();
    cache = upsertRecords(cache, [
      {
        repository: "octo/example",
        prNumber: 1,
        openedAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-01-05T00:00:00Z",
        state: "merged",
        githubUpdatedAt: "2026-01-05T00:00:00Z",
        fetchedAt: "2026-01-06T00:00:00Z",
      },
    ]);
    cache = addCoverage(cache, "octo/example", {
      startUtc: "2026-01-01T00:00:00Z",
      endUtc: "2026-02-01T00:00:00Z",
    });
    await saveCache(filePath, cache);
    const reloaded = await loadCache(filePath);
    assert.deepEqual(reloaded, cache);
  });

  it("discards a cache with an unrecognized cacheVersion, treating it as empty", async () => {
    const filePath = path.join(dir, "stale-version.json");
    await saveCache(filePath, {
      ...emptyCache(),
      cacheVersion: "pr-metadata-cache/v0" as typeof PR_METADATA_CACHE_VERSION,
    });
    const reloaded = await loadCache(filePath);
    assert.deepEqual(reloaded, emptyCache());
  });

  it("discards an unparsable cache file, treating it as empty", async () => {
    const filePath = path.join(dir, "corrupt.json");
    await saveCache(filePath, emptyCache());
    const fs = await import("node:fs/promises");
    await fs.writeFile(filePath, "{not valid json", "utf-8");
    const reloaded = await loadCache(filePath);
    assert.deepEqual(reloaded, emptyCache());
  });
});
