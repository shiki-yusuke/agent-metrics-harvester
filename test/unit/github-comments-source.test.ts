// Regression coverage for two bugs found in Codex (gpt-5.4) implementation review:
//
// 1. (must) A page-1 ETag/304 short-circuit is only a safe "nothing new" signal when page 1 is
//    the entire result. With sort=updated&direction=asc, any new comment always lands on the
//    LAST page, so once a query spans more than one page, page 1's bytes (and therefore its
//    ETag) can stay identical forever while genuinely new data keeps arriving on later pages --
//    a page-1-only 304 short-circuit would then miss it, permanently, since the checkpoint
//    never advances and the same page-1 request recurs on every future run. The fix: never
//    cache/reuse an etag derived from a multi-page fetch (see comments-source.ts).
// 2. (must) The safety valve (--max-api-requests etc.) must be consulted *during* a single
//    repository's own pagination loop, not only once before it starts and once after it has
//    already finished -- otherwise one large-backlog repository can blow straight through the
//    configured request budget within a single fetchComments call.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SafetyValve } from "../../src/application/safety-valve.js";
import type { GithubApiComment } from "../../src/sources/github/client.js";
import { GithubClient } from "../../src/sources/github/client.js";
import { GithubCommentSource } from "../../src/sources/github/comments-source.js";

function jsonResponse(body: unknown, opts: { headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...opts.headers },
  });
}

function notModifiedResponse(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 304, headers });
}

function apiComment(id: number, overrides: Partial<GithubApiComment> = {}): GithubApiComment {
  return {
    id,
    body: "no marker here",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/octo/example/pull/1#issuecomment-${id}`,
    issue_url: "https://api.github.com/repos/octo/example/issues/1",
    user: { login: "trusted-bot[bot]", type: "Bot" },
    ...overrides,
  };
}

const PAGE1_URL =
  "https://api.github.com/repos/octo/example/issues/comments?sort=updated&direction=asc&per_page=100&since=2026-01-01T00%3A00%3A00.000Z";
const PAGE2_URL = "https://api.github.com/repos/octo/example/page2";
const PAGE3_URL = "https://api.github.com/repos/octo/example/page3";

describe("GithubCommentSource: page-1 304 vs multi-page correctness", () => {
  it("never caches/returns an etag from a fetch that spanned more than one page", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = url.toString();
      if (u === PAGE1_URL) {
        return jsonResponse([apiComment(1)], {
          headers: { etag: '"page1-etag"', link: `<${PAGE2_URL}>; rel="next"` },
        });
      }
      if (u === PAGE2_URL) {
        return jsonResponse([apiComment(2)], { headers: { etag: '"page2-etag"' } });
      }
      throw new Error(`unexpected URL in test fetch: ${u}`);
    }) as unknown as typeof fetch;

    const client = new GithubClient({ fetchImpl });
    const source = new GithubCommentSource("octo/example", client);

    const result = await source.fetchComments({ since: "2026-01-01T00:00:00.000Z" });

    assert.equal(result.comments.length, 2);
    assert.equal(
      result.newEtag,
      null,
      "a multi-page fetch must clear (null), never cache, its etag -- caching page 1's own etag would make a future run's page-1 304 look like 'nothing changed at all'",
    );
  });

  it("a single-page fetch still caches its etag (the common-case optimization is preserved)", async () => {
    const fetchImpl = (async () =>
      jsonResponse([apiComment(1)], {
        headers: { etag: '"single-page-etag"' },
      })) as unknown as typeof fetch;
    const client = new GithubClient({ fetchImpl });
    const source = new GithubCommentSource("octo/example", client);

    const result = await source.fetchComments({ since: "2026-01-01T00:00:00.000Z" });

    assert.equal(result.newEtag, '"single-page-etag"');
  });

  it("because the etag is never cached across a multi-page fetch, a follow-up call with no etag still reaches new data added to a later page", async () => {
    // Simulates exactly the buggy scenario end-to-end at this module's own level: two calls
    // with the SAME `since` and NO etag (i.e. the etag the checkpoint layer would actually
    // send, per the fix above) -- page 1's bytes stay byte-identical between the two calls
    // (as they always will once a query is genuinely multi-page and sort=asc), while page 2
    // gains a new comment between call 1 and call 2.
    let page2Comments = [apiComment(2)];

    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      const headers = new Headers(init?.headers);
      if (u === PAGE1_URL) {
        // A real server would 304 here if If-None-Match matched -- but the fixed caller never
        // sends an etag for a query that was previously multi-page, so this must always see a
        // plain, unconditional request.
        assert.equal(
          headers.get("if-none-match"),
          null,
          "must not send a stale multi-page-derived etag",
        );
        return jsonResponse([apiComment(1)], {
          headers: { etag: '"page1-etag"', link: `<${PAGE2_URL}>; rel="next"` },
        });
      }
      if (u === PAGE2_URL) {
        return jsonResponse(page2Comments, { headers: { etag: '"page2-etag"' } });
      }
      throw new Error(`unexpected URL in test fetch: ${u}`);
    }) as unknown as typeof fetch;

    const client = new GithubClient({ fetchImpl });
    const source = new GithubCommentSource("octo/example", client);

    const first = await source.fetchComments({
      since: "2026-01-01T00:00:00.000Z",
      etag: undefined,
    });
    assert.deepEqual(
      first.comments.map((c) => c.id),
      [1, 2],
    );
    assert.equal(first.newEtag, null);

    // Between "runs", a new comment (id 3) is appended to page 2 -- page 1 is untouched.
    page2Comments = [apiComment(2), apiComment(3)];

    const second = await source.fetchComments({
      since: "2026-01-01T00:00:00.000Z",
      etag: undefined,
    });
    assert.deepEqual(
      second.comments.map((c) => c.id),
      [1, 2, 3],
      "the new comment on page 2 must be found -- it would be silently missed if the caller had cached and resent page 1's etag",
    );
  });

  it("illustrates the failure mode a stale, multi-page-derived etag would cause, if a caller ignored the fix and resent one anyway", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      const headers = new Headers(init?.headers);
      if (u === PAGE1_URL) {
        if (headers.get("if-none-match") === '"page1-etag"') {
          return notModifiedResponse();
        }
        return jsonResponse([apiComment(1)], {
          headers: { etag: '"page1-etag"', link: `<${PAGE2_URL}>; rel="next"` },
        });
      }
      throw new Error(`unexpected URL in test fetch: ${u} (page 2 should never be reached here)`);
    }) as unknown as typeof fetch;

    const client = new GithubClient({ fetchImpl });
    const source = new GithubCommentSource("octo/example", client);

    const result = await source.fetchComments({
      since: "2026-01-01T00:00:00.000Z",
      etag: '"page1-etag"',
    });

    assert.equal(result.notModified, true);
    assert.equal(result.comments.length, 0);
    // This is exactly why comments-source.ts must never hand this etag back to the checkpoint
    // layer in the first place (the fix), rather than trying to detect/recover from it here.
  });
});

describe("GithubCommentSource: safety valve enforcement during pagination", () => {
  it("stops mid-pagination once the shared SafetyValve's budget is (about to be) exhausted, instead of draining the whole backlog first", async () => {
    let requestsMade = 0;
    const fetchImpl = (async (url: string | URL) => {
      requestsMade++;
      const u = url.toString();
      if (u === PAGE1_URL) {
        return jsonResponse([apiComment(1)], { headers: { link: `<${PAGE2_URL}>; rel="next"` } });
      }
      if (u === PAGE2_URL) {
        return jsonResponse([apiComment(2)], { headers: { link: `<${PAGE3_URL}>; rel="next"` } });
      }
      if (u === PAGE3_URL) {
        return jsonResponse([apiComment(3)]);
      }
      throw new Error(`unexpected URL in test fetch: ${u}`);
    }) as unknown as typeof fetch;

    const client = new GithubClient({ fetchImpl });
    const safetyValve = new SafetyValve({ maxApiRequests: 2 });
    const source = new GithubCommentSource("octo/example", client, {
      shouldStop: (pagesFetchedSoFar, rateLimitRemaining) =>
        safetyValve.previewCheck(pagesFetchedSoFar, rateLimitRemaining).stop,
    });

    const result = await source.fetchComments({ since: "2026-01-01T00:00:00.000Z" });

    assert.equal(
      requestsMade,
      2,
      "must stop after exactly 2 requests (the configured budget), not fetch page 3 too",
    );
    assert.deepEqual(
      result.comments.map((c) => c.id),
      [1, 2],
    );
    assert.equal(result.budgetStopped, true);
    assert.equal(result.requestsUsed, 2);
  });

  it("stops before making even the first request if the budget is already exhausted from prior calls", async () => {
    let requestsMade = 0;
    const fetchImpl = (async () => {
      requestsMade++;
      return jsonResponse([apiComment(1)]);
    }) as unknown as typeof fetch;

    const client = new GithubClient({ fetchImpl });
    const safetyValve = new SafetyValve({ maxApiRequests: 1 });
    safetyValve.recordRequests(1); // simulates a prior repository having already used the budget
    const source = new GithubCommentSource("octo/example", client, {
      shouldStop: (pagesFetchedSoFar, rateLimitRemaining) =>
        safetyValve.previewCheck(pagesFetchedSoFar, rateLimitRemaining).stop,
    });

    const result = await source.fetchComments({ since: "2026-01-01T00:00:00.000Z" });

    assert.equal(requestsMade, 0);
    assert.equal(result.budgetStopped, true);
    assert.deepEqual(result.comments, []);
  });
});
