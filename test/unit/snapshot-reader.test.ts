// Acceptance criteria §8 coverage for the report layer's read-only SnapshotReader:
// - JSONL and SQLite agree on the current snapshot set for an identical operation sequence.
// - An incomplete (crashed, no trailing checkpoint line) JSONL batch is never counted.
// - A correction (same upsert_key, later content) counts only once, as its latest value.

import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { JsonlSnapshotReader } from "../../src/stores/jsonl/jsonl-snapshot-reader.js";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { SqliteSnapshotReader } from "../../src/stores/sqlite/sqlite-snapshot-reader.js";
import { SqliteStore } from "../../src/stores/sqlite/sqlite-store.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

const SOURCE = "octo/example";

describe("JsonlSnapshotReader / SqliteSnapshotReader", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-harvester-snapreader-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns [] when the store file does not exist yet", async () => {
    const jsonlReader = new JsonlSnapshotReader(path.join(dir, "does-not-exist.jsonl"));
    const sqliteReader = new SqliteSnapshotReader(path.join(dir, "does-not-exist.sqlite"));
    assert.deepEqual(await jsonlReader.listCurrentSnapshots([SOURCE]), []);
    assert.deepEqual(await sqliteReader.listCurrentSnapshots([SOURCE]), []);
  });

  it("both backends agree on the current snapshot set, including a correction resolving to only its latest value", async () => {
    const payloadA = makeTokenUsagePayload({ subjectId: "run-a", tokens: 10 });
    const payloadACorrected = makeTokenUsagePayload({ subjectId: "run-a", tokens: 999 }); // same upsert_key
    const payloadB = makeTokenUsagePayload({ subjectId: "run-b", tokens: 20 });

    const jsonlPath = path.join(dir, "parity.jsonl");
    const sqlitePath = path.join(dir, "parity.sqlite");
    const jsonlStore = await JsonlStore.open(jsonlPath);
    const sqliteStore = await SqliteStore.open(sqlitePath);

    for (const store of [jsonlStore, sqliteStore]) {
      await store.commitBatch({
        source: SOURCE,
        expectedCheckpoint: null,
        nextCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
        snapshots: [
          {
            upsertKey: payloadA.upsert_key,
            repository: SOURCE,
            payload: payloadA,
            sourceCommentId: 1,
            sourceUpdatedAt: "2026-01-01T00:00:00Z",
            markerSha: "a".repeat(64),
          },
        ],
        rejections: [],
      });
      await store.commitBatch({
        source: SOURCE,
        expectedCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
        nextCheckpoint: { updatedAt: "2026-01-02T00:00:00Z", commentId: 2 },
        snapshots: [
          {
            upsertKey: payloadB.upsert_key,
            repository: SOURCE,
            payload: payloadB,
            sourceCommentId: 2,
            sourceUpdatedAt: "2026-01-02T00:00:00Z",
            markerSha: "b".repeat(64),
          },
          {
            upsertKey: payloadACorrected.upsert_key, // same key as payloadA -- a correction
            repository: SOURCE,
            payload: payloadACorrected,
            sourceCommentId: 3,
            sourceUpdatedAt: "2026-01-02T00:00:01Z",
            markerSha: "c".repeat(64),
          },
        ],
        rejections: [],
      });
    }
    await sqliteStore.close();

    const jsonlReader = new JsonlSnapshotReader(jsonlPath);
    const sqliteReader = new SqliteSnapshotReader(sqlitePath);
    const fromJsonl = await jsonlReader.listCurrentSnapshots([SOURCE]);
    const fromSqlite = await sqliteReader.listCurrentSnapshots([SOURCE]);

    assert.equal(
      fromJsonl.length,
      2,
      "one row per upsert_key -- the correction must not double-count",
    );
    assert.equal(fromSqlite.length, 2);

    const byKeyJsonl = new Map(fromJsonl.map((s) => [s.upsertKey, s]));
    const byKeySqlite = new Map(fromSqlite.map((s) => [s.upsertKey, s]));
    assert.deepEqual(byKeyJsonl, byKeySqlite);

    const correctedFromJsonl = byKeyJsonl.get(payloadACorrected.upsert_key);
    assert.equal(
      correctedFromJsonl?.payload.data.records[0]?.tokens,
      999,
      "must resolve to the latest correction, not the original",
    );
  });

  it("filters by repository, and never counts an incomplete (uncommitted) trailing batch", async () => {
    const jsonlPath = path.join(dir, "incomplete-tail.jsonl");
    const store = await JsonlStore.open(jsonlPath);

    const committedPayload = makeTokenUsagePayload({
      repository: "octo/example",
      subjectId: "committed",
    });
    await store.commitBatch({
      source: "octo/example",
      expectedCheckpoint: null,
      nextCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
      snapshots: [
        {
          upsertKey: committedPayload.upsert_key,
          repository: "octo/example",
          payload: committedPayload,
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-01-01T00:00:00Z",
          markerSha: "a".repeat(64),
        },
      ],
      rejections: [],
    });

    // A different repository's snapshot, committed cleanly -- must be excluded when the
    // reader is asked only about "octo/example".
    const otherRepoPayload = makeTokenUsagePayload({
      repository: "octo/other",
      subjectId: "other-repo",
    });
    await store.commitBatch({
      source: "octo/other",
      expectedCheckpoint: null,
      nextCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
      snapshots: [
        {
          upsertKey: otherRepoPayload.upsert_key,
          repository: "octo/other",
          payload: otherRepoPayload,
          sourceCommentId: 1,
          sourceUpdatedAt: "2026-01-01T00:00:00Z",
          markerSha: "b".repeat(64),
        },
      ],
      rejections: [],
    });

    // Simulate a crash: append a snapshot line with no trailing checkpoint line.
    const uncommittedPayload = makeTokenUsagePayload({
      repository: "octo/example",
      subjectId: "uncommitted",
    });
    await appendFile(
      jsonlPath,
      `${JSON.stringify({
        t: "snapshot",
        upsertKey: uncommittedPayload.upsert_key,
        repository: "octo/example",
        payload: uncommittedPayload,
        sourceCommentId: 2,
        sourceUpdatedAt: "2026-01-02T00:00:00Z",
        markerSha: "c".repeat(64),
      })}\n`,
      "utf-8",
    );

    const reader = new JsonlSnapshotReader(jsonlPath);
    const results = await reader.listCurrentSnapshots(["octo/example"]);

    assert.deepEqual(
      results.map((s) => s.upsertKey),
      [committedPayload.upsert_key],
      "must include the cleanly-committed same-repo snapshot, exclude the other repo's, and exclude the uncommitted tail",
    );
  });
});
