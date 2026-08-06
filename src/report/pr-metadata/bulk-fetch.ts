// Exhaustive, bulk (never per-PR / N+1) merged-PR fetch for one repository over one UTC
// [startUtc, endUtc) window (spec §3). GitHub's Search API caps any single query at 1000
// total results, counted across all of that query's pages -- if `total_count` for the whole
// window exceeds that, this bisects the window and recurses on each half (each half re-checks
// `total_count` independently) until every leaf query is small enough to page through fully.
// Every leaf query still only takes as many requests as it has pages (ceil(total/100)), never
// one request per PR.
//
// Personal-data stripping happens exactly here, in `mapItem`: nothing from the raw GitHub
// response other than `number`, `created_at`, `updated_at`, and `pull_request.merged_at` is
// ever read out of the parsed JSON, so there is no later step that could leak a title/author/
// label into the cache even by accident -- the projection is structural, not a filter applied
// after the fact.

import type { GithubSearchClient } from "./github-search-client.js";
import type { PrMetadataRecord } from "./types.js";

export type ShouldStop = (
  pendingRequests: number,
  rateLimitRemaining: number | undefined,
) => boolean;

export interface FetchWindowResult {
  readonly records: readonly PrMetadataRecord[];
  /** True if any part of the window could not be exhaustively fetched (incomplete_results,
   * a query the safety valve stopped mid-page, or a >1000 sub-window that could no longer be
   * split). The caller MUST treat the whole window as unresolved, not partially resolved, when
   * this is true -- spec §3's fail-closed requirement. */
  readonly incomplete: boolean;
  readonly requestsUsed: number;
}

function mapItem(
  repository: string,
  item: {
    number: number;
    created_at: string;
    updated_at: string;
    pull_request?: { merged_at: string | null } | null;
  },
  fetchedAtIso: string,
): PrMetadataRecord | null {
  const mergedAt = item.pull_request?.merged_at;
  if (!mergedAt) return null; // defensive -- the query already filters is:merged
  return {
    repository,
    prNumber: item.number,
    openedAt: item.created_at,
    mergedAt,
    state: "merged",
    githubUpdatedAt: item.updated_at,
    fetchedAt: fetchedAtIso,
  };
}

const MIN_SPLITTABLE_WINDOW_MS = 2000; // below this, splitting further can't help (GitHub's date-qualifier granularity is ~1s)

async function fetchWindowExhaustive(
  client: GithubSearchClient,
  repository: string,
  startUtc: string,
  endUtc: string,
  shouldStop: ShouldStop,
  fetchedAtIso: string,
  depth: number,
  maxDepth: number,
): Promise<FetchWindowResult> {
  if (shouldStop(0, undefined)) {
    return { records: [], incomplete: true, requestsUsed: 0 };
  }

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  if (endMs <= startMs) return { records: [], incomplete: false, requestsUsed: 0 };

  // GitHub's merged: qualifier is inclusive on both ends; query up to 1s before the true
  // (exclusive) end and then re-filter exactly below, so [startUtc, endUtc) stays exact
  // regardless of GitHub's own date-qualifier granularity/inclusivity.
  const queryEndInclusive = new Date(Math.max(startMs, endMs - 1000)).toISOString();

  const firstUrl = client.buildQueryUrl(repository, startUtc, queryEndInclusive, 1);
  const first = await client.fetchPage(firstUrl);
  let requestsUsed = first.requestsUsed;

  if (first.incompleteResults) {
    return { records: [], incomplete: true, requestsUsed };
  }

  if (first.totalCount > 1000) {
    if (depth >= maxDepth || endMs - startMs < MIN_SPLITTABLE_WINDOW_MS) {
      // Cannot narrow further -- more than 1000 merged PRs in an unsplittable window.
      return { records: [], incomplete: true, requestsUsed };
    }
    const midMs = startMs + Math.floor((endMs - startMs) / 2);
    const midUtc = new Date(midMs).toISOString();
    const left = await fetchWindowExhaustive(
      client,
      repository,
      startUtc,
      midUtc,
      shouldStop,
      fetchedAtIso,
      depth + 1,
      maxDepth,
    );
    const right = await fetchWindowExhaustive(
      client,
      repository,
      midUtc,
      endUtc,
      shouldStop,
      fetchedAtIso,
      depth + 1,
      maxDepth,
    );
    return {
      records: [...left.records, ...right.records],
      incomplete: left.incomplete || right.incomplete,
      requestsUsed: requestsUsed + left.requestsUsed + right.requestsUsed,
    };
  }

  const items = [...first.items];
  let page = first;
  let pagesFetched = 1;
  while (page.nextUrl) {
    if (shouldStop(pagesFetched, page.rateLimitRemaining)) {
      return { records: [], incomplete: true, requestsUsed };
    }
    page = await client.fetchPage(page.nextUrl);
    requestsUsed += page.requestsUsed;
    pagesFetched++;
    if (page.incompleteResults) {
      return { records: [], incomplete: true, requestsUsed };
    }
    items.push(...page.items);
  }

  const records = items
    .map((item) => mapItem(repository, item, fetchedAtIso))
    .filter((r): r is PrMetadataRecord => r !== null)
    .filter((r) => {
      const mergedMs = Date.parse(r.mergedAt);
      return mergedMs >= startMs && mergedMs < endMs;
    });

  return { records, incomplete: false, requestsUsed };
}

export async function fetchMergedPrsBulk(
  client: GithubSearchClient,
  repository: string,
  startUtc: string,
  endUtc: string,
  shouldStop: ShouldStop,
  now: () => Date = () => new Date(),
): Promise<FetchWindowResult> {
  return fetchWindowExhaustive(
    client,
    repository,
    startUtc,
    endUtc,
    shouldStop,
    now().toISOString(),
    0,
    12,
  );
}
