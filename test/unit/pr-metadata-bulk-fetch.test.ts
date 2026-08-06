// Acceptance criteria §8: "bulk 取得で N+1 なし" / "安全弁超過で fail-closed", plus the
// personal-dimension stripping spec §6 mandates structurally (not as an after-the-fact filter).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchMergedPrsBulk } from "../../src/report/pr-metadata/bulk-fetch.js";
import { GithubSearchClient } from "../../src/report/pr-metadata/github-search-client.js";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeItem(
  number: number,
  mergedAt: string,
  extraPersonalFields: Record<string, unknown> = {},
) {
  return {
    number,
    state: "closed",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: mergedAt,
    pull_request: { merged_at: mergedAt },
    // Fields a real GitHub search result would also carry -- must never survive into a
    // PrMetadataRecord (spec §6: personal data stripped before it ever reaches the cache).
    user: { login: "some-person" },
    title: "some PR title",
    labels: [{ name: "bug" }],
    ...extraPersonalFields,
  };
}

describe("fetchMergedPrsBulk: N+1 avoidance", () => {
  it("pages through a moderately large result set with one request per page, not one per PR", async () => {
    let requestCount = 0;
    const totalItems = 250; // 3 pages at per_page=100
    const allItems = Array.from({ length: totalItems }, (_, i) =>
      makeItem(i + 1, "2026-01-15T00:00:00Z"),
    );

    const fetchImpl = (async (url: string | URL) => {
      requestCount++;
      const u = new URL(url.toString());
      const page = Number(u.searchParams.get("page"));
      const pageItems = allItems.slice((page - 1) * 100, page * 100);
      const hasNext = page * 100 < totalItems;
      return jsonResponse(
        { total_count: totalItems, incomplete_results: false, items: pageItems },
        hasNext
          ? { link: `<https://api.github.com/search/issues?page=${page + 1}>; rel="next"` }
          : {},
      );
    }) as unknown as typeof fetch;

    const client = new GithubSearchClient({ fetchImpl });
    const result = await fetchMergedPrsBulk(
      client,
      "octo/example",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      () => false,
    );

    assert.equal(
      requestCount,
      3,
      "must make exactly one request per page (3), not one per PR (250)",
    );
    assert.equal(result.records.length, totalItems);
    assert.equal(result.incomplete, false);
  });

  it("strips every field except the allowed set -- no author/title/label reaches a PrMetadataRecord", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [makeItem(1, "2026-01-15T00:00:00Z")],
      })) as unknown as typeof fetch;
    const client = new GithubSearchClient({ fetchImpl });
    const result = await fetchMergedPrsBulk(
      client,
      "octo/example",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      () => false,
    );

    assert.equal(result.records.length, 1);
    const record = result.records[0] as unknown as Record<string, unknown>;
    assert.deepEqual(
      new Set(Object.keys(record)),
      new Set([
        "repository",
        "prNumber",
        "openedAt",
        "mergedAt",
        "state",
        "githubUpdatedAt",
        "fetchedAt",
      ]),
    );
  });
});

describe("fetchMergedPrsBulk: >1000-result window splitting", () => {
  it("bisects a window whose total_count exceeds 1000, and combines both halves' results", async () => {
    // Relies on fetchWindowExhaustive's sequential await order (outer, then left branch fully,
    // then right branch fully) -- documented in bulk-fetch.ts's recursion. A queue of canned
    // responses in that exact order is simpler and just as faithful as parsing the query
    // string back out of each URL.
    const leftItems = Array.from({ length: 150 }, (_, i) =>
      makeItem(i + 1, "2026-01-08T00:00:00Z"),
    );
    const rightItems = Array.from({ length: 150 }, (_, i) =>
      makeItem(1000 + i + 1, "2026-01-24T00:00:00Z"),
    );

    const responses: Response[] = [
      jsonResponse({ total_count: 1500, incomplete_results: false, items: [] }), // outer: too big, triggers split
      jsonResponse(
        { total_count: 150, incomplete_results: false, items: leftItems.slice(0, 100) },
        { link: '<https://api.github.com/x?page=2>; rel="next"' },
      ),
      jsonResponse({ total_count: 150, incomplete_results: false, items: leftItems.slice(100) }),
      jsonResponse(
        { total_count: 150, incomplete_results: false, items: rightItems.slice(0, 100) },
        { link: '<https://api.github.com/x?page=2>; rel="next"' },
      ),
      jsonResponse({ total_count: 150, incomplete_results: false, items: rightItems.slice(100) }),
    ];
    let requestCount = 0;
    const fetchImpl = (async () => {
      const res = responses[requestCount];
      requestCount++;
      if (!res) throw new Error(`unexpected extra request #${requestCount}`);
      return res;
    }) as unknown as typeof fetch;

    const client = new GithubSearchClient({ fetchImpl });
    const result = await fetchMergedPrsBulk(
      client,
      "octo/example",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      () => false,
    );

    assert.equal(requestCount, 5, "1 outer + 2 pages per half = 5 requests total");
    assert.equal(result.records.length, 300);
    assert.equal(result.incomplete, false);
  });
});

describe("fetchMergedPrsBulk: fail-closed", () => {
  it("incomplete_results anywhere marks the whole fetch incomplete, with no partial records", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        total_count: 1,
        incomplete_results: true,
        items: [],
      })) as unknown as typeof fetch;
    const client = new GithubSearchClient({ fetchImpl });
    const result = await fetchMergedPrsBulk(
      client,
      "octo/example",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      () => false,
    );
    assert.equal(result.incomplete, true);
    assert.deepEqual(result.records, []);
  });

  it("a safety-valve stop marks the fetch incomplete instead of returning a partial page set", async () => {
    let requestCount = 0;
    const fetchImpl = (async () => {
      requestCount++;
      return jsonResponse(
        {
          total_count: 250,
          incomplete_results: false,
          items: [makeItem(1, "2026-01-15T00:00:00Z")],
        },
        { link: '<https://api.github.com/x?page=2>; rel="next"' },
      );
    }) as unknown as typeof fetch;
    const client = new GithubSearchClient({ fetchImpl });

    // Stop after the very first page.
    const result = await fetchMergedPrsBulk(
      client,
      "octo/example",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      (pending) => pending >= 1,
    );

    assert.equal(result.incomplete, true);
    assert.deepEqual(result.records, []);
    assert.equal(requestCount, 1, "must not fetch page 2 once the valve says stop");
  });

  it("stops before making even the first request if the valve is already tripped", async () => {
    let requestCount = 0;
    const fetchImpl = (async () => {
      requestCount++;
      return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
    }) as unknown as typeof fetch;
    const client = new GithubSearchClient({ fetchImpl });
    const result = await fetchMergedPrsBulk(
      client,
      "octo/example",
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      () => true,
    );
    assert.equal(result.incomplete, true);
    assert.equal(requestCount, 0);
  });
});
