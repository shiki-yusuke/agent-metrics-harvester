// Proves the load-bearing invariant for the JSONL store (spec section 2): "store 成功前に
// cursor が進まない" -- the checkpoint (cursor) must never appear to have advanced past a
// batch that did not fully commit, even if some of that batch's lines were physically written
// to disk before the crash. This test does not rely on interrupting a live process; it directly
// constructs the on-disk state a real crash would leave (some snapshot/seen lines written,
// no trailing checkpoint line) and asserts that reloading the store from that file recovers to
// the pre-crash state, not a partially-applied one.

import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

describe("JsonlStore crash injection", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-harvester-jsonl-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a batch that never reached its checkpoint line is invisible after reload", async () => {
    const filePath = path.join(dir, "store.jsonl");
    const source = "octo/example";

    const store1 = await JsonlStore.open(filePath);

    const payload1 = makeTokenUsagePayload({ subjectId: "run-committed" });
    await store1.commitBatch({
      source,
      expectedCheckpoint: null,
      nextCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
      snapshots: [
        {
          upsertKey: payload1.upsert_key,
          repository: source,
          payload: payload1,
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-01-01T00:00:00Z",
          markerSha: "a".repeat(64),
        },
      ],
      rejections: [],
    });

    const checkpointAfterCommit = await store1.readCheckpoint(source);
    assert.deepEqual(checkpointAfterCommit, { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 });

    // Simulate a crash mid-batch: append what a second commitBatch WOULD have written for its
    // snapshot/seen lines, but omit the trailing checkpoint line entirely -- exactly what disk
    // state looks like if the process died between those writes.
    const payload2 = makeTokenUsagePayload({ subjectId: "run-crashed" });
    const crashedSha = "b".repeat(64);
    const crashedLines = [
      JSON.stringify({
        t: "snapshot",
        upsertKey: payload2.upsert_key,
        repository: source,
        payload: payload2,
        sourceCommentId: 2,
        sourceUpdatedAt: "2026-01-02T00:00:00Z",
        markerSha: crashedSha,
      }),
      JSON.stringify({ t: "seen", repository: source, commentId: 2, markerSha: crashedSha }),
      // NOTE: no checkpoint line here -- this is the crash point.
    ];
    await appendFile(filePath, `${crashedLines.join("\n")}\n`, "utf-8");

    // Reopen fresh, as a restarted process would.
    const store2 = await JsonlStore.open(filePath);

    const checkpointAfterCrash = await store2.readCheckpoint(source);
    assert.deepEqual(
      checkpointAfterCrash,
      { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
      "cursor must remain at the last fully-committed checkpoint, not the crashed batch's target",
    );

    const crashedSnapshot = await store2.readSnapshot(payload2.upsert_key);
    assert.equal(crashedSnapshot, null, "the crashed batch's snapshot must not be visible");

    const seenAfterCrash = await store2.hasSeenMarker(source, 2, crashedSha);
    assert.equal(seenAfterCrash, false, "the crashed batch's seen-marker must not be visible either");

    const originalSnapshot = await store2.readSnapshot(payload1.upsert_key);
    assert.ok(originalSnapshot, "the earlier, fully-committed snapshot must still be intact");

    // Retry after "crash recovery": the caller re-fetches comment #2 (since the store never
    // marked it seen or advanced its checkpoint) and successfully commits it against the
    // checkpoint the store actually has -- proving recovery, not just non-corruption.
    await store2.commitBatch({
      source,
      expectedCheckpoint: checkpointAfterCrash,
      nextCheckpoint: { updatedAt: "2026-01-02T00:00:00Z", commentId: 2 },
      snapshots: [
        {
          upsertKey: payload2.upsert_key,
          repository: source,
          payload: payload2,
          sourceCommentId: 2,
          sourceUpdatedAt: "2026-01-02T00:00:00Z",
          markerSha: crashedSha,
        },
      ],
      rejections: [],
    });

    const store3 = await JsonlStore.open(filePath);
    assert.deepEqual(await store3.readCheckpoint(source), { updatedAt: "2026-01-02T00:00:00Z", commentId: 2 });
    assert.ok(await store3.readSnapshot(payload2.upsert_key), "retried batch is now visible");
  });

  it("commitBatch rejects a stale expectedCheckpoint (CAS guard)", async () => {
    const filePath = path.join(dir, "store-cas.jsonl");
    const source = "octo/example";
    const store = await JsonlStore.open(filePath);
    const payload = makeTokenUsagePayload({ subjectId: "run-a" });
    await store.commitBatch({
      source,
      expectedCheckpoint: null,
      nextCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
      snapshots: [
        {
          upsertKey: payload.upsert_key,
          repository: source,
          payload,
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-01-01T00:00:00Z",
          markerSha: "c".repeat(64),
        },
      ],
      rejections: [],
    });

    await assert.rejects(
      () =>
        store.commitBatch({
          source,
          expectedCheckpoint: null, // stale -- the real current checkpoint is no longer null
          nextCheckpoint: { updatedAt: "2026-01-03T00:00:00Z", commentId: 3 },
          snapshots: [],
          rejections: [],
        }),
      /checkpoint conflict/,
    );
  });
});
