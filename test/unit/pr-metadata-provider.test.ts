import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addCoverage, upsertRecords } from "../../src/report/pr-metadata/cache.js";
import { GithubSearchClient } from "../../src/report/pr-metadata/github-search-client.js";
import { resolveMetadata } from "../../src/report/pr-metadata/metadata-provider.js";
import { emptyCache } from "../../src/report/pr-metadata/types.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveMetadata", () => {
  it("serves a fully-covered, fully-past period entirely from cache -- zero network calls", async () => {
    let cache = emptyCache();
    cache = upsertRecords(cache, [
      {
        repository: "octo/example",
        prNumber: 1,
        openedAt: "2026-01-01T00:00:00Z",
        mergedAt: "2026-01-15T00:00:00Z",
        state: "merged",
        githubUpdatedAt: "2026-01-15T00:00:00Z",
        fetchedAt: "2026-01-16T00:00:00Z",
      },
    ]);
    cache = addCoverage(cache, "octo/example", {
      startUtc: "2026-01-01T00:00:00Z",
      endUtc: "2026-02-01T00:00:00Z",
    });

    const client = new GithubSearchClient({
      fetchImpl: (async () => {
        throw new Error("network must not be called for a fully-covered past period");
      }) as unknown as typeof fetch,
    });

    const result = await resolveMetadata(
      client,
      cache,
      ["octo/example"],
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      {
        mode: "auto",
        shouldStop: () => false,
        now: () => new Date("2026-06-01T00:00:00Z"), // period is well in the past relative to "now"
      },
    );

    assert.equal(result.complete, true);
    assert.equal(result.apiRequestsUsed, 0);
    assert.equal(result.recordsByRepository.get("octo/example")?.length, 1);
  });

  it("never trusts cache coverage alone for a current/open period -- still fetches", async () => {
    let cache = emptyCache();
    cache = addCoverage(cache, "octo/example", {
      startUtc: "2026-01-01T00:00:00Z",
      endUtc: "2026-02-01T00:00:00Z",
    });

    let requestCount = 0;
    const client = new GithubSearchClient({
      fetchImpl: (async () => {
        requestCount++;
        return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
      }) as unknown as typeof fetch,
    });

    const result = await resolveMetadata(
      client,
      cache,
      ["octo/example"],
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      {
        mode: "auto",
        shouldStop: () => false,
        now: () => new Date("2026-01-15T00:00:00Z"), // "now" is INSIDE the period -- still open
      },
    );

    assert.equal(
      requestCount,
      1,
      "a current period must always be (re)fetched, never trusted from stale coverage alone",
    );
    assert.equal(result.complete, true);
  });

  it("cache-only mode never calls the network, and is incomplete when coverage is insufficient", async () => {
    const cache = emptyCache(); // no coverage at all
    const result = await resolveMetadata(
      null,
      cache,
      ["octo/example"],
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      {
        mode: "cache-only",
        shouldStop: () => false,
        now: () => new Date("2026-06-01T00:00:00Z"),
      },
    );
    assert.equal(result.complete, false);
    assert.equal(result.apiRequestsUsed, 0);
  });

  it("a successful fetch updates the cache with new records and coverage for a past period", async () => {
    const cache = emptyCache();
    const client = new GithubSearchClient({
      fetchImpl: (async () =>
        jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              number: 1,
              state: "closed",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-15T00:00:00Z",
              pull_request: { merged_at: "2026-01-15T00:00:00Z" },
            },
          ],
        })) as unknown as typeof fetch,
    });

    const result = await resolveMetadata(
      client,
      cache,
      ["octo/example"],
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      {
        mode: "auto",
        shouldStop: () => false,
        now: () => new Date("2026-06-01T00:00:00Z"),
      },
    );

    assert.equal(result.complete, true);
    assert.equal(result.recordsByRepository.get("octo/example")?.length, 1);
    assert.ok(Object.keys(result.cache.records).length === 1);
    assert.ok((result.cache.coverage["octo/example"] ?? []).length === 1);
  });

  it("marks the whole result incomplete if any one of several repositories fails, without dropping the others' successful records", async () => {
    const cache = emptyCache();
    let call = 0;
    const client = new GithubSearchClient({
      fetchImpl: (async () => {
        call++;
        if (call === 1) {
          return jsonResponse({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                number: 1,
                state: "closed",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-15T00:00:00Z",
                pull_request: { merged_at: "2026-01-15T00:00:00Z" },
              },
            ],
          });
        }
        return jsonResponse({ total_count: 1, incomplete_results: true, items: [] });
      }) as unknown as typeof fetch,
    });

    const result = await resolveMetadata(
      client,
      cache,
      ["octo/good", "octo/bad"],
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      {
        mode: "auto",
        shouldStop: () => false,
        now: () => new Date("2026-06-01T00:00:00Z"),
      },
    );

    assert.equal(
      result.complete,
      false,
      "one repository's incomplete_results makes the whole result incomplete",
    );
    assert.equal(
      result.recordsByRepository.get("octo/good")?.length,
      1,
      "the other repository's successful fetch is still returned",
    );
  });
});
