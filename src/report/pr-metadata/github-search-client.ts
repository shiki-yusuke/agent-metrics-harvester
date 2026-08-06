// Thin GitHub Search API client for merged-PR metadata, deliberately separate from
// src/sources/github/client.ts (the harvest CLI's own GitHub client) even though the two share
// a similar shape -- the report layer must not touch anything under src/sources/github/ (spec
// boundary: harvest CLI's contract is unchanged), so this is its own small client rather than
// an added method on the harvester's. It reuses the generic backoff helpers from
// application/safety-valve.ts (boundedBackoffDelayMs/sleep), which are already a
// non-harvest-specific utility.
//
// GitHub's Search API caps any single query at 1000 total results, even across pagination --
// see bulk-fetch.ts for how a wide date range is bisected to stay under that cap without ever
// falling back to a per-PR (N+1) fetch.

import { boundedBackoffDelayMs, sleep } from "../../application/safety-valve.js";

export interface GithubSearchClientOptions {
  readonly token?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly backoff?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
  };
}

export interface GithubSearchIssueItem {
  readonly number: number;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly pull_request?: { readonly merged_at: string | null } | null;
}

export interface SearchIssuesResponseBody {
  readonly total_count: number;
  readonly incomplete_results: boolean;
  readonly items: readonly GithubSearchIssueItem[];
}

export interface SearchPageResult {
  readonly items: readonly GithubSearchIssueItem[];
  readonly totalCount: number;
  readonly incompleteResults: boolean;
  readonly nextUrl: string | null;
  readonly requestsUsed: number;
  readonly rateLimitRemaining?: number;
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1] as string;
  }
  return null;
}

export class GithubSearchClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoff: NonNullable<GithubSearchClientOptions["backoff"]>;

  constructor(opts: GithubSearchClientOptions = {}) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.backoff = opts.backoff ?? {};
  }

  buildQueryUrl(
    repository: string,
    sinceUtc: string,
    untilUtcInclusive: string,
    page: number,
  ): string {
    const q = `repo:${repository} is:pr is:merged merged:${sinceUtc}..${untilUtcInclusive}`;
    const url = new URL(`${this.baseUrl}/search/issues`);
    url.searchParams.set("q", q);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "created");
    url.searchParams.set("order", "asc");
    return url.toString();
  }

  private async getWithBackoff(url: string): Promise<Response> {
    let attempt = 0;
    while (true) {
      const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await this.fetchImpl(url, { headers });
      if (res.status === 403 || res.status === 429) {
        const delay = boundedBackoffDelayMs(attempt, this.backoff);
        if (delay === null) {
          throw new Error(
            `GitHub Search API rate-limited (status ${res.status}) at ${url}, backoff attempts exhausted`,
          );
        }
        await sleep(delay);
        attempt++;
        continue;
      }
      return res;
    }
  }

  async fetchPage(url: string): Promise<SearchPageResult> {
    const res = await this.getWithBackoff(url);
    const rateLimitRemainingHeader = res.headers.get("x-ratelimit-remaining");
    const rateLimitRemaining = rateLimitRemainingHeader
      ? Number.parseInt(rateLimitRemainingHeader, 10)
      : undefined;
    if (!res.ok) {
      throw new Error(`GitHub Search API error ${res.status} at ${url}: ${await res.text()}`);
    }
    const body = (await res.json()) as SearchIssuesResponseBody;
    return {
      items: body.items,
      totalCount: body.total_count,
      incompleteResults: body.incomplete_results,
      nextUrl: parseNextLink(res.headers.get("link")),
      requestsUsed: 1,
      rateLimitRemaining,
    };
  }
}
