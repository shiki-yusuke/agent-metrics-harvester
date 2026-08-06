// Proves the same "store 成功前に cursor が進まない" invariant for the SQLite store, but by a
// different, backend-appropriate mechanism: commitBatch runs inside a single
// better-sqlite3 transaction, so if anything inside it throws -- even after some rows were
// already written by earlier statements in the same call -- the whole transaction rolls back
// atomically. We force a throw partway through a real commitBatch call (JSON.stringify on a
// BigInt throws) and assert nothing from that batch, including rows written before the throw,
// survives.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SqliteStore } from "../../src/stores/sqlite/sqlite-store.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

describe("SqliteStore crash injection (transaction rollback)", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-harvester-sqlite-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a mid-transaction throw rolls back everything the batch had already written", async () => {
    const dbPath = path.join(dir, "store.sqlite");
    const source = "octo/example";
    const store = await SqliteStore.open(dbPath);

    const payload1 = makeTokenUsagePayload({ subjectId: "run-committed" });
    await store.commitBatch({
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

    const payload2 = makeTokenUsagePayload({ subjectId: "run-should-roll-back" });
    // A rejection record whose `reasons` contains a BigInt: JSON.stringify(r.reasons) inside
    // commitBatch's real rejection-insert path throws "Do not know how to serialize a BigInt",
    // after the snapshot above it has already been written by upsertSnapshot.run(...) in the
    // same transaction call.
    const poisonedRejections = [
      {
        repository: source,
        commentId: 3,
        reasons: [{ code: "schema_validation_failed", detail: 1n as unknown as string }],
        detectedAt: "2026-01-02T00:00:00Z",
      },
    ];

    await assert.rejects(() =>
      store.commitBatch({
        source,
        expectedCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
        nextCheckpoint: { updatedAt: "2026-01-02T00:00:00Z", commentId: 2 },
        snapshots: [
          {
            upsertKey: payload2.upsert_key,
            repository: source,
            payload: payload2,
            sourceCommentId: 2,
            sourceUpdatedAt: "2026-01-02T00:00:00Z",
            markerSha: "b".repeat(64),
          },
        ],
        // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed to force a mid-transaction throw
        rejections: poisonedRejections as any,
      }),
    );

    // The checkpoint must still be exactly where the first, successful batch left it.
    assert.deepEqual(await store.readCheckpoint(source), {
      updatedAt: "2026-01-01T00:00:00Z",
      commentId: 1,
    });
    // The second batch's snapshot -- written by a statement that ran *before* the throw inside
    // the same transaction -- must not be visible: the whole transaction rolled back.
    assert.equal(await store.readSnapshot(payload2.upsert_key), null);
    // The first batch's snapshot must still be intact (rollback of batch 2 must not touch it).
    assert.ok(await store.readSnapshot(payload1.upsert_key));

    await store.close();
  });

  it("commitBatch rejects a stale expectedCheckpoint (CAS guard)", async () => {
    const dbPath = path.join(dir, "store-cas.sqlite");
    const source = "octo/example";
    const store = await SqliteStore.open(dbPath);
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
          expectedCheckpoint: null,
          nextCheckpoint: { updatedAt: "2026-01-03T00:00:00Z", commentId: 3 },
          snapshots: [],
          rejections: [],
        }),
      /checkpoint conflict/,
    );

    await store.close();
  });
});
