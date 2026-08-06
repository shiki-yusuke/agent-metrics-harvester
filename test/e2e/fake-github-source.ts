// Offline CommentSource double for the E2E suite (spec section 7: "offline E2E: fixture
// marker を返す fake GitHub source → JSONL/SQLite 両方で同一結果"). Implements the exact same
// CommentSource interface application/harvest.ts programs against -- no network, no GitHub
// API shape, just a fixed list of RawComment objects supplied by the test.

import type {
  CommentSource,
  FetchCommentsParams,
  FetchCommentsResult,
  RawComment,
} from "../../src/application/types.js";

export class FakeGithubCommentSource implements CommentSource {
  constructor(
    public readonly repository: string,
    private readonly comments: readonly RawComment[],
  ) {}

  async fetchComments(params: FetchCommentsParams): Promise<FetchCommentsResult> {
    const filtered = this.comments.filter((c) => c.updatedAt >= params.since);
    return { comments: filtered, notModified: false, requestsUsed: 1 };
  }
}
