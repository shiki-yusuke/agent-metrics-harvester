// Thin GitHub REST client: plain global fetch (spec section 3 -- "GitHub API は素の fetch"),
// repo-wide issue-comments pagination, per-URL ETag (304 short-circuit), and bounded backoff
// on 403 secondary-rate-limit / 429 responses. No octokit dependency by design.

import { boundedBackoffDelayMs, sleep } from "../../application/safety-valve.js";
import type { RawComment } from "../../application/types.js";

export interface GithubClientOptions {
  readonly token?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly backoff?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
  };
}

export interface GithubApiComment {
  readonly id: number;
  readonly body: string | null;
  readonly updated_at: string;
  readonly html_url: string;
  readonly issue_url: string;
  readonly user: { readonly login: string; readonly type: "User" | "Bot" | "Organization" } | null;
  readonly performed_via_github_app?: { readonly slug: string } | null;
}

export interface ListCommentsPageResult {
  readonly comments: readonly RawComment[];
  readonly nextUrl: string | null;
  readonly notModified: boolean;
  readonly newEtag?: string;
  readonly rateLimitRemaining?: number;
  readonly requestsUsed: number;
}

function issueNumberFromIssueUrl(issueUrl: string): number {
  const match = issueUrl.match(/\/issues\/(\d+)$/);
  return match ? Number.parseInt(match[1] as string, 10) : Number.NaN;
}

// The repo-wide issue-comments endpoint (`/repos/{owner}/{repo}/issues/comments`) returns
// comments on plain issues and on pull requests indiscriminately -- `issue_url` always reads
// `.../issues/{n}` for both kinds (GitHub models a PR as an issue internally), but `html_url`
// reliably differs: `.../pull/{n}#issuecomment-...` for a PR comment, `.../issues/{n}#...`
// for a plain issue comment. This is the only field on the comment itself (as opposed to a
// separate, extra lookup of the parent issue/PR) that distinguishes the two.
function isPullRequestFromHtmlUrl(htmlUrl: string): boolean {
  return /\/pull\/\d+/.test(htmlUrl);
}

function toRawComment(c: GithubApiComment): RawComment {
  return {
    id: c.id,
    body: c.body ?? "",
    updatedAt: c.updated_at,
    htmlUrl: c.html_url,
    issueNumber: issueNumberFromIssueUrl(c.issue_url),
    isPullRequest: isPullRequestFromHtmlUrl(c.html_url),
    authorLogin: c.user?.login ?? "",
    authorType: c.user?.type ?? "User",
    ...(c.performed_via_github_app?.slug
      ? { performedViaAppSlug: c.performed_via_github_app.slug }
      : {}),
  };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1] as string;
  }
  return null;
}

export class GithubClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoff: NonNullable<GithubClientOptions["backoff"]>;

  constructor(opts: GithubClientOptions = {}) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.github.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.backoff = opts.backoff ?? {};
  }

  /** GET a single page of a repo's issue comments, repo-wide (not PR-by-PR), sorted by
   * update time ascending -- spec section 3. Handles 403 secondary-rate-limit and 429 with
   * bounded backoff; throws once backoff attempts are exhausted rather than retrying forever. */
  private async getWithBackoff(url: string, etag?: string): Promise<Response> {
    let attempt = 0;
    while (true) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (etag) headers["If-None-Match"] = etag;

      const res = await this.fetchImpl(url, { headers });

      if (res.status === 403 || res.status === 429) {
        const delay = boundedBackoffDelayMs(attempt, this.backoff);
        if (delay === null) {
          throw new Error(
            `GitHub API rate-limited (status ${res.status}) at ${url}, backoff attempts exhausted`,
          );
        }
        await sleep(delay);
        attempt++;
        continue;
      }
      return res;
    }
  }

  async listIssueCommentsPage(url: string, etag?: string): Promise<ListCommentsPageResult> {
    const res = await this.getWithBackoff(url, etag);
    const rateLimitRemainingHeader = res.headers.get("x-ratelimit-remaining");
    const rateLimitRemaining = rateLimitRemainingHeader
      ? Number.parseInt(rateLimitRemainingHeader, 10)
      : undefined;

    if (res.status === 304) {
      return {
        comments: [],
        nextUrl: null,
        notModified: true,
        requestsUsed: 1,
        rateLimitRemaining,
      };
    }
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} at ${url}: ${await res.text()}`);
    }

    const body = (await res.json()) as GithubApiComment[];
    const nextUrl = parseNextLink(res.headers.get("link"));
    const newEtag = res.headers.get("etag") ?? undefined;

    return {
      comments: body.map(toRawComment),
      nextUrl,
      notModified: false,
      newEtag,
      rateLimitRemaining,
      requestsUsed: 1,
    };
  }

  buildFirstPageUrl(repositoryFullName: string, since: string): string {
    const url = new URL(`${this.baseUrl}/repos/${repositoryFullName}/issues/comments`);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("since", since);
    return url.toString();
  }
}
