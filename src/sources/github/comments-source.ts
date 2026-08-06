// Repo-wide GitHub issue-comments CommentSource (application/types.ts's CommentSource
// interface). Paginates until either the backlog is drained or a caller-supplied stop check
// (wired to the process-wide SafetyValve) trips -- in which case it returns whatever it has
// already fetched with `budgetStopped: true`, rather than either blocking forever or silently
// discarding the safety valve's decision.
//
// Two correctness properties this file is specifically responsible for (see the review that
// found both missing):
//
// 1. A page-1 ETag/304 is only ever a safe "nothing changed" signal when page 1 was, and still
//    is, the *entire* result. With `sort=updated&direction=asc`, any new comment always sorts
//    onto the LAST page, never page 1 -- so once a query has more than one page, page 1's
//    bytes can (and typically do) stay identical forever while new data keeps landing on later
//    pages that a page-1-only 304 short-circuit would never fetch. This module never caches an
//    etag from a multi-page fetch (see the `hadAdditionalPages` handling below); the checkpoint
//    layer (application/harvest.ts) then never has a stale, multi-page-derived etag to send in
//    the first place, so the dangerous 304 can't happen. See
//    test/unit/comments-source-pagination.test.ts's "page 1 unchanged, page 2 has new items"
//    case.
// 2. The safety valve must be consulted (and see a live, per-page-accurate request count)
//    *during* this function's own pagination loop, not only once before it starts and once
//    after it has already finished -- otherwise a single repository with a large backlog can
//    blow through --max-api-requests entirely within one call. `shouldStop` is invoked before
//    every page (including page 1) with how many pages this call has already fetched so far,
//    so the caller's SafetyValve.previewCheck can enforce the budget without this module
//    needing to know the limit's actual value.

import type {
  CommentSource,
  FetchCommentsParams,
  FetchCommentsResult,
  RawComment,
} from "../../application/types.js";
import type { GithubClient } from "./client.js";

export interface GithubCommentSourceOptions {
  readonly maxPages?: number;
  /** Returns true if the run should stop before fetching one more page, given how many pages
   * this call has *already* fetched (0 before page 1) and the most recently observed
   * rate-limit-remaining value (if GitHub reported one). Bound to
   * `SafetyValve.previewCheck(pagesFetchedSoFar, rateLimitRemaining).stop` by the caller
   * (src/cli) -- kept as a plain callback here so this module has no dependency on
   * SafetyValve's own type beyond this narrow contract. */
  readonly shouldStop?: (
    pagesFetchedSoFar: number,
    rateLimitRemaining: number | undefined,
  ) => boolean;
}

export class GithubCommentSource implements CommentSource {
  constructor(
    public readonly repository: string,
    private readonly client: GithubClient,
    private readonly options: GithubCommentSourceOptions = {},
  ) {}

  async fetchComments(params: FetchCommentsParams): Promise<FetchCommentsResult> {
    const firstUrl = this.client.buildFirstPageUrl(this.repository, params.since);
    const maxPages = this.options.maxPages ?? 20;

    if (this.options.shouldStop?.(0, undefined)) {
      return { comments: [], notModified: false, requestsUsed: 0, budgetStopped: true };
    }

    const first = await this.client.listIssueCommentsPage(firstUrl, params.etag);
    if (first.notModified) {
      // Only reachable when `params.etag` was set, which -- by the invariant maintained below
      // -- only ever happens when the checkpoint's stored etag came from a *single-page*
      // fetch. A 304 against that exact (unchanged) query therefore really does mean "the
      // complete result is unchanged," not just "page 1 is unchanged."
      return {
        comments: [],
        notModified: true,
        requestsUsed: first.requestsUsed,
        rateLimitRemaining: first.rateLimitRemaining,
      };
    }

    const comments: RawComment[] = [...first.comments];
    let requestsUsed = first.requestsUsed;
    let rateLimitRemaining = first.rateLimitRemaining;
    let nextUrl = first.nextUrl;
    let hadAdditionalPages = first.nextUrl !== null;
    let budgetStopped = false;
    let pages = 1;

    while (nextUrl !== null) {
      if (pages >= maxPages || this.options.shouldStop?.(pages, rateLimitRemaining)) {
        budgetStopped = true;
        break;
      }
      const page = await this.client.listIssueCommentsPage(nextUrl);
      comments.push(...page.comments);
      requestsUsed += page.requestsUsed;
      rateLimitRemaining = page.rateLimitRemaining;
      nextUrl = page.nextUrl;
      if (nextUrl !== null) hadAdditionalPages = true;
      pages++;
    }

    return {
      comments,
      notModified: false,
      // Never cache an etag derived from a multi-page (or budget-truncated, which implies
      // multi-page) fetch -- see the file header. `null` tells the checkpoint layer to clear
      // any etag it already has, not merely "no new value."
      newEtag: hadAdditionalPages ? null : first.newEtag,
      requestsUsed,
      rateLimitRemaining,
      budgetStopped,
    };
  }
}
