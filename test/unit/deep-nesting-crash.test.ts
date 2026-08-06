// Regression coverage for a "must" finding in Codex (gpt-5.4) implementation review: a
// maliciously deeply nested comment body (~thousands of levels of `{"a":{"a":...}}`) used to
// crash the whole process with "RangeError: Maximum call stack size exceeded" -- thrown from
// deep inside the (previously recursive) depth check and personal-dimension walker, running
// unguarded and BEFORE the trust check, on a public repository where any commenter can post
// arbitrary comment bodies. Because harvest.ts's per-comment loop has no try/catch around an
// individual comment, one such comment used to take down the *entire* batch for that repo run
// (nothing in that batch ever reached commitBatch), not just itself -- and since the harvester
// naturally re-fetches the same comment via the overlap window on every subsequent run, this
// was a repeatable, remotely triggerable denial of service against harvesting a specific
// repository, not just a one-off crash.
//
// The fix makes both walkers iterative (no recursion) and runs the (now crash-safe) depth
// check before either of them, short-circuiting on payload_too_deep without ever handing the
// hostile structure to the walkers at all -- see protocol/limits.ts, protocol/personal-
// dimension.ts, and protocol/decode.ts.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { harvestRepository } from "../../src/application/harvest.js";
import { SafetyValve } from "../../src/application/safety-valve.js";
import type {
  CommentSource,
  FetchCommentsParams,
  FetchCommentsResult,
  RawComment,
} from "../../src/application/types.js";
import { decodeMarker, decodePayloadObject } from "../../src/protocol/decode.js";
import { MAX_DEPTH, checkLimits } from "../../src/protocol/limits.js";
import { scanPersonalDimensions } from "../../src/protocol/personal-dimension.js";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { makeComment, makeTokenUsagePayload, markerTextFor } from "../support/fixtures.js";

const DEPTH = 5000;

function buildDeeplyNestedValue(depth: number): unknown {
  let node: unknown = "leaf";
  for (let i = 0; i < depth; i++) node = { a: node };
  return node;
}

describe("deep nesting does not crash the process", () => {
  it("checkLimits itself does not overflow the call stack on ~5000 levels of nesting", () => {
    const hostile = buildDeeplyNestedValue(DEPTH);
    const violations = checkLimits(hostile, 100);
    assert.ok(violations.some((v) => v.code === "payload_too_deep"));
  });

  it("scanPersonalDimensions does not overflow the call stack on ~5000 levels of nesting, called directly (independent of checkLimits ordering)", () => {
    const hostile = buildDeeplyNestedValue(DEPTH);
    // Must simply return (empty or not), never throw a RangeError.
    const violations = scanPersonalDimensions(hostile);
    assert.ok(Array.isArray(violations));
  });

  it("checkPayload rejects a ~5000-level-deep payload as payload_too_deep instead of crashing", () => {
    const hostile = { schema: "token-usage/v1", data: buildDeeplyNestedValue(DEPTH) };
    const outcome = decodePayloadObject(hostile);
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") {
      assert.ok(outcome.reasons.some((r) => r.code === "payload_too_deep"));
    }
  });

  it("decodeMarker rejects a marker-wrapped ~5000-level-deep payload as payload_too_deep", () => {
    const hostile = { schema: "token-usage/v1", data: buildDeeplyNestedValue(DEPTH) };
    const marker = markerTextFor(hostile);
    const outcome = decodeMarker(marker);
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") {
      assert.ok(outcome.reasons.some((r) => r.code === "payload_too_deep"));
    }
  });

  it("a legitimate payload well within MAX_DEPTH is unaffected", () => {
    const payload = makeTokenUsagePayload();
    const violations = checkLimits(payload, JSON.stringify(payload).length);
    assert.deepEqual(violations, []);
    assert.ok(MAX_DEPTH >= 5); // sanity: legitimate payloads nest a handful of levels
  });

  it("a malicious deep-nesting comment does not poison the rest of its batch (repo traversal survives)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-harvester-deepnest-"));
    try {
      const store = await JsonlStore.open(path.join(dir, "store.jsonl"));

      const goodPayloadBefore = makeTokenUsagePayload({
        repository: "octo/example",
        subjectId: "before",
      });
      const goodPayloadAfter = makeTokenUsagePayload({
        repository: "octo/example",
        subjectId: "after",
      });
      const hostilePayload = { schema: "token-usage/v1", data: buildDeeplyNestedValue(DEPTH) };

      const comments: RawComment[] = [
        makeComment({
          id: 1,
          updatedAt: "2026-01-01T00:00:00Z",
          body: markerTextFor(goodPayloadBefore),
        }),
        makeComment({
          id: 2,
          updatedAt: "2026-01-01T00:01:00Z",
          body: markerTextFor(hostilePayload),
        }),
        makeComment({
          id: 3,
          updatedAt: "2026-01-01T00:02:00Z",
          body: markerTextFor(goodPayloadAfter),
        }),
      ];

      class FixedSource implements CommentSource {
        readonly repository = "octo/example";
        async fetchComments(_params: FetchCommentsParams): Promise<FetchCommentsResult> {
          return { comments, notModified: false, requestsUsed: 1 };
        }
      }

      const result = await harvestRepository(
        { source: new FixedSource(), store, safetyValve: new SafetyValve({}) },
        { lookbackDays: 1, auth: { allowedLogins: ["trusted-bot[bot]"] } },
      );

      assert.equal(
        result.accepted,
        2,
        "both legitimate comments (before and after the hostile one) must still be accepted",
      );
      assert.equal(
        result.rejected,
        1,
        "the hostile comment must be rejected, not crash the whole run",
      );

      const before = await store.readSnapshot(goodPayloadBefore.upsert_key);
      const after = await store.readSnapshot(goodPayloadAfter.upsert_key);
      assert.ok(
        before,
        "the legitimate comment before the hostile one must actually be committed to the store",
      );
      assert.ok(
        after,
        "the legitimate comment after the hostile one must actually be committed to the store",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
