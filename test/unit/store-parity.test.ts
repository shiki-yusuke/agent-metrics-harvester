// Spec section 2: "JSONL と SQLite が同じ論理結果を返すことを同一テストスイートで検証（store
// 差し替え式）". Runs the identical sequence of Store operations against a fresh JsonlStore and
// a fresh SqliteStore and asserts every read (checkpoint, snapshot, seen-marker) agrees --
// proving application code can swap one Store implementation for the other with no observable
// difference, which is the whole point of Store being an interface application/harvest.ts
// programs against rather than a concrete backend.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { CommitBatchInput, Store } from "../../src/application/types.js";
import { JsonlStore } from "../../src/stores/jsonl/jsonl-store.js";
import { SqliteStore } from "../../src/stores/sqlite/sqlite-store.js";
import { makeTokenUsagePayload } from "../support/fixtures.js";

const SOURCE = "octo/example";

function buildBatches(): CommitBatchInput[] {
  const payloadA = makeTokenUsagePayload({ subjectId: "run-a" });
  const payloadB = makeTokenUsagePayload({ subjectId: "run-b" });
  const payloadACorrected = makeTokenUsagePayload({ subjectId: "run-a", tokens: 999 }); // same upsert_key as A

  return [
    {
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
      rejections: [
        {
          repository: SOURCE,
          commentId: 1,
          reasons: [{ code: "unsupported_schema_kind" }],
          detectedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
    {
      source: SOURCE,
      expectedCheckpoint: { updatedAt: "2026-01-01T00:00:00Z", commentId: 1 },
      nextCheckpoint: { updatedAt: "2026-01-02T00:00:00Z", commentId: 2, etag: "W/\"etag-2\"" },
      snapshots: [
        {
          upsertKey: payloadB.upsert_key,
          repository: SOURCE,
          payload: payloadB,
          sourceCommentId: 2,
          sourceUpdatedAt: "2026-01-02T00:00:00Z",
          markerSha: "b".repeat(64),
        },
        // A correction to payload A's upsert_key, arriving in a later batch: must upsert over
        // the original, not create a second row.
        {
          upsertKey: payloadACorrected.upsert_key,
          repository: SOURCE,
          payload: payloadACorrected,
          sourceCommentId: 3,
          sourceUpdatedAt: "2026-01-02T00:00:01Z",
          markerSha: "c".repeat(64),
        },
      ],
      rejections: [],
    },
  ];
}

async function applyAll(store: Store, batches: readonly CommitBatchInput[]): Promise<void> {
  for (const batch of batches) await store.commitBatch(batch);
}

describe("JSONL / SQLite store parity", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agent-metrics-harvester-parity-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("both backends agree on checkpoint, snapshots (including corrections), and seen-markers", async () => {
    const batches = buildBatches();
    const jsonlStore = await JsonlStore.open(path.join(dir, "parity.jsonl"));
    const sqliteStore = await SqliteStore.open(path.join(dir, "parity.sqlite"));

    await applyAll(jsonlStore, batches);
    await applyAll(sqliteStore, batches);

    const jsonlCheckpoint = await jsonlStore.readCheckpoint(SOURCE);
    const sqliteCheckpoint = await sqliteStore.readCheckpoint(SOURCE);
    assert.deepEqual(jsonlCheckpoint, sqliteCheckpoint);
    assert.deepEqual(jsonlCheckpoint, { updatedAt: "2026-01-02T00:00:00Z", commentId: 2, etag: 'W/"etag-2"' });

    const allUpsertKeys = new Set<string>();
    for (const batch of batches) for (const s of batch.snapshots) allUpsertKeys.add(s.upsertKey);

    for (const upsertKey of allUpsertKeys) {
      const fromJsonl = await jsonlStore.readSnapshot(upsertKey);
      const fromSqlite = await sqliteStore.readSnapshot(upsertKey);
      assert.deepEqual(fromJsonl, fromSqlite, `snapshot mismatch for ${upsertKey}`);
    }

    // The corrected snapshot's payload (tokens: 999) must be what both backends now hold --
    // proving upsert-over-correction, not a leftover duplicate, in both backends identically.
    const correctedKey = batches[1]?.snapshots[1]?.upsertKey;
    assert.ok(correctedKey);
    const correctedFromJsonl = await jsonlStore.readSnapshot(correctedKey);
    const correctedFromSqlite = await sqliteStore.readSnapshot(correctedKey);
    assert.equal(correctedFromJsonl?.payload.data.records[0]?.tokens, 999);
    assert.equal(correctedFromSqlite?.payload.data.records[0]?.tokens, 999);

    for (const batch of batches) {
      for (const s of batch.snapshots) {
        const jsonlSeen = await jsonlStore.hasSeenMarker(s.repository, s.sourceCommentId, s.markerSha);
        const sqliteSeen = await sqliteStore.hasSeenMarker(s.repository, s.sourceCommentId, s.markerSha);
        assert.equal(jsonlSeen, true);
        assert.equal(sqliteSeen, true);
      }
    }

    await sqliteStore.close();
  });
});
