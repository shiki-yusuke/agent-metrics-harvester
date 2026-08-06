import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { harvestRepository, InitialRunRequiresBoundsError } from "../../src/application/index.js";
import { SafetyValve } from "../../src/application/safety-valve.js";
import type { CommentSource, FetchCommentsParams, FetchCommentsResult, RawComment } from "../../src/application/types.js";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { makeComment, makeTokenUsagePayload, markerTextFor } from "../support/fixtures.js";

class FixedCommentSource implements CommentSource {
  constructor(
    public readonly repository: string,
    private readonly pages: FetchCommentsResult[],
  ) {}
  private callIndex = 0;
  async fetchComments(_params: FetchCommentsParams): Promise<FetchCommentsResult> {
    const result = this.pages[Math.min(this.callIndex, this.pages.length - 1)] as FetchCommentsResult;
    this.callIndex++;
    return result;
  }
}

function page(comments: readonly RawComment[], extra: Partial<FetchCommentsResult> = {}): FetchCommentsResult {
  return { comments, notModified: false, requestsUsed: 1, ...extra };
}

describe("harvestRepository", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-harvester-harvest-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws InitialRunRequiresBoundsError on first run without initial-since/lookback-days", async () => {
    const store = await JsonlStore.open(path.join(dir, "no-bounds.jsonl"));
    const source = new FixedCommentSource("octo/example", [page([])]);
    const valve = new SafetyValve({});
    await assert.rejects(
      () => harvestRepository({ source, store, safetyValve: valve }, { auth: {} }),
      InitialRunRequiresBoundsError,
    );
  });

  it("accepts a trusted, well-formed marker and rejects an untrusted or mismatched one in the same batch", async () => {
    const store = await JsonlStore.open(path.join(dir, "mixed.jsonl"));

    const goodPayload = makeTokenUsagePayload({ repository: "octo/example", subjectId: "good" });
    const wrongRepoPayload = makeTokenUsagePayload({ repository: "octo/other", subjectId: "wrong-repo" });

    const comments: RawComment[] = [
      makeComment({ id: 1, updatedAt: "2026-01-01T00:00:00Z", body: "no marker here at all" }),
      makeComment({
        id: 2,
        updatedAt: "2026-01-01T00:01:00Z",
        body: markerTextFor(goodPayload),
        authorLogin: "trusted-bot[bot]",
      }),
      makeComment({
        id: 3,
        updatedAt: "2026-01-01T00:02:00Z",
        body: markerTextFor(goodPayload),
        authorLogin: "random-untrusted-user",
      }),
      makeComment({
        id: 4,
        updatedAt: "2026-01-01T00:03:00Z",
        body: markerTextFor(wrongRepoPayload),
        authorLogin: "trusted-bot[bot]",
      }),
    ];

    const source = new FixedCommentSource("octo/example", [page(comments)]);
    const valve = new SafetyValve({});
    const result = await harvestRepository(
      { source, store, safetyValve: valve },
      { lookbackDays: 1, auth: { allowedLogins: ["trusted-bot[bot]"] } },
    );

    assert.equal(result.ignored, 1);
    assert.equal(result.accepted, 1);
    assert.equal(result.rejected, 2); // untrusted author + repository_mismatch
    assert.equal(result.skippedSeen, 0);

    const stored = await store.readSnapshot(goodPayload.upsert_key);
    assert.ok(stored);
    assert.equal(stored?.sourceCommentId, 2);

    const checkpoint = await store.readCheckpoint("octo/example");
    assert.deepEqual(checkpoint, { updatedAt: "2026-01-01T00:03:00Z", commentId: 4 });
  });

  it("skips a comment whose (repository, commentId, verified sha) was already committed", async () => {
    const store = await JsonlStore.open(path.join(dir, "skip-seen.jsonl"));
    const payload = makeTokenUsagePayload({ repository: "octo/example", subjectId: "seen-test" });
    const comment = makeComment({ id: 1, updatedAt: "2026-01-01T00:00:00Z", body: markerTextFor(payload) });

    const auth = { allowedLogins: ["trusted-bot[bot]"] };
    const source1 = new FixedCommentSource("octo/example", [page([comment])]);
    const valve1 = new SafetyValve({});
    const first = await harvestRepository({ source: source1, store, safetyValve: valve1 }, { lookbackDays: 1, auth });
    assert.equal(first.accepted, 1);

    // Second run re-fetches the same comment (as an overlap window would) unchanged.
    const source2 = new FixedCommentSource("octo/example", [page([comment])]);
    const valve2 = new SafetyValve({});
    const second = await harvestRepository({ source: source2, store, safetyValve: valve2 }, { lookbackDays: 1, auth });
    assert.equal(second.accepted, 0);
    assert.equal(second.skippedSeen, 1);
  });

  it("short-circuits on a 304 Not Modified response without touching the store", async () => {
    const store = await JsonlStore.open(path.join(dir, "not-modified.jsonl"));
    const source = new FixedCommentSource("octo/example", [{ comments: [], notModified: true, requestsUsed: 1 }]);
    const valve = new SafetyValve({});
    const result = await harvestRepository({ source, store, safetyValve: valve }, { lookbackDays: 1, auth: {} });
    assert.equal(result.notModified, true);
    assert.equal(await store.readCheckpoint("octo/example"), null);
  });

  it("stops before making any request once the safety valve has already tripped", async () => {
    const store = await JsonlStore.open(path.join(dir, "pre-tripped.jsonl"));
    const source = new FixedCommentSource("octo/example", [page([])]);
    const valve = new SafetyValve({ maxApiRequests: 1 });
    valve.recordRequests(1);
    const result = await harvestRepository({ source, store, safetyValve: valve }, { lookbackDays: 1, auth: {} });
    assert.equal(result.stoppedReason, "max_api_requests_exceeded");
    assert.equal(result.requestsUsed, 0);
  });
});
