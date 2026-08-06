// Repo-wide GitHub issue-comments CommentSource (application/types.ts's CommentSource
// interface). Paginates until either the backlog is drained or a caller-supplied stop check
// (wired to the process-wide SafetyValve) trips -- in which case it returns whatever it has
// already fetched with `budgetStopped: true`, rather than either blocking forever or silently
// discarding the safety valve's decision.

import type {
  CommentSource,
  FetchCommentsParams,
  FetchCommentsResult,
  RawComment,
} from "../../application/types.js";
import type { GithubClient } from "./client.js";

export interface GithubCommentSourceOptions {
  readonly maxPages?: number;
  /** Returns true if the run should stop fetching further pages, given the most recent
   * observed rate-limit-remaining value (if GitHub reported one). Bound to SafetyValve.check
   * by the caller (src/cli) -- kept as a plain callback here so this module has no dependency
   * on SafetyValve's own type beyond this narrow contract. */
  readonly shouldStop?: (rateLimitRemaining: number | undefined) => boolean;
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

    const first = await this.client.listIssueCommentsPage(firstUrl, params.etag);
    if (first.notModified) {
      return {
        comments: [],
        notModified: true,
        newEtag: params.etag,
        requestsUsed: first.requestsUsed,
        rateLimitRemaining: first.rateLimitRemaining,
      };
    }

    const comments: RawComment[] = [...first.comments];
    let requestsUsed = first.requestsUsed;
    let rateLimitRemaining = first.rateLimitRemaining;
    let nextUrl = first.nextUrl;
    const newEtag = first.newEtag;
    let budgetStopped = false;
    let pages = 1;

    while (nextUrl !== null) {
      if (pages >= maxPages || this.options.shouldStop?.(rateLimitRemaining)) {
        budgetStopped = true;
        break;
      }
      const page = await this.client.listIssueCommentsPage(nextUrl);
      comments.push(...page.comments);
      requestsUsed += page.requestsUsed;
      rateLimitRemaining = page.rateLimitRemaining;
      nextUrl = page.nextUrl;
      pages++;
    }

    return {
      comments,
      notModified: false,
      newEtag,
      requestsUsed,
      rateLimitRemaining,
      budgetStopped,
    };
  }
}
