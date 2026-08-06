// Local/future-runner store (spec section 1): SQLite via better-sqlite3, the one non-trivial
// runtime dependency this repository takes (spec section 8 -- "sqlite は better-sqlite3 等1つ
// まで"). commitBatch = one BEGIN/COMMIT transaction wrapping the checkpoint CAS check,
// snapshot upserts, seen-marker inserts, and the checkpoint advance -- SQLite's own
// transaction atomicity is the mechanism behind "store 成功前に cursor が進まない" for this
// backend (if anything inside the transaction throws, better-sqlite3's `db.transaction()`
// wrapper rolls the whole thing back; see test/unit/crash-injection).

import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Checkpoint, CommitBatchInput, Store, StoredSnapshot } from "../../application/types.js";
import { CheckpointConflictError } from "../../application/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  source TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  etag TEXT
);
CREATE TABLE IF NOT EXISTS seen_markers (
  repository TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  marker_sha TEXT NOT NULL,
  PRIMARY KEY (repository, comment_id, marker_sha)
);
CREATE TABLE IF NOT EXISTS snapshots (
  upsert_key TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  payload TEXT NOT NULL,
  source_comment_id INTEGER NOT NULL,
  source_updated_at TEXT NOT NULL,
  marker_sha TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  comment_url TEXT,
  marker_sha TEXT,
  reasons TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
`;

function checkpointsEqual(a: Checkpoint | null, b: Checkpoint | null): boolean {
  if (a === null || b === null) return a === b;
  return a.updatedAt === b.updatedAt && a.commentId === b.commentId && a.etag === b.etag;
}

export class SqliteStore implements Store {
  readonly kind = "sqlite";

  private constructor(private readonly db: Database.Database) {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  static async open(filePath: string): Promise<SqliteStore> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const db = new Database(filePath);
    return new SqliteStore(db);
  }

  private readCheckpointSync(source: string): Checkpoint | null {
    const row = this.db
      .prepare("SELECT updated_at, comment_id, etag FROM checkpoints WHERE source = ?")
      .get(source) as { updated_at: string; comment_id: number; etag: string | null } | undefined;
    if (!row) return null;
    return { updatedAt: row.updated_at, commentId: row.comment_id, ...(row.etag ? { etag: row.etag } : {}) };
  }

  async readCheckpoint(source: string): Promise<Checkpoint | null> {
    return this.readCheckpointSync(source);
  }

  async hasSeenMarker(repository: string, commentId: number, markerSha: string): Promise<boolean> {
    const row = this.db
      .prepare("SELECT 1 FROM seen_markers WHERE repository = ? AND comment_id = ? AND marker_sha = ?")
      .get(repository, commentId, markerSha);
    return row !== undefined;
  }

  async readSnapshot(upsertKey: string): Promise<StoredSnapshot | null> {
    const row = this.db
      .prepare(
        "SELECT upsert_key, repository, payload, source_comment_id, source_updated_at, marker_sha FROM snapshots WHERE upsert_key = ?",
      )
      .get(upsertKey) as
      | {
          upsert_key: string;
          repository: string;
          payload: string;
          source_comment_id: number;
          source_updated_at: string;
          marker_sha: string;
        }
      | undefined;
    if (!row) return null;
    return {
      upsertKey: row.upsert_key,
      repository: row.repository,
      payload: JSON.parse(row.payload),
      sourceCommentId: row.source_comment_id,
      sourceUpdatedAt: row.source_updated_at,
      markerSha: row.marker_sha,
    };
  }

  async commitBatch(input: CommitBatchInput): Promise<void> {
    const run = this.db.transaction((batch: CommitBatchInput) => {
      const current = this.readCheckpointSync(batch.source);
      if (!checkpointsEqual(current, batch.expectedCheckpoint)) {
        throw new CheckpointConflictError(batch.source, batch.expectedCheckpoint, current);
      }

      const upsertSnapshot = this.db.prepare(
        `INSERT INTO snapshots (upsert_key, repository, payload, source_comment_id, source_updated_at, marker_sha)
         VALUES (@upsertKey, @repository, @payload, @sourceCommentId, @sourceUpdatedAt, @markerSha)
         ON CONFLICT(upsert_key) DO UPDATE SET
           repository = excluded.repository,
           payload = excluded.payload,
           source_comment_id = excluded.source_comment_id,
           source_updated_at = excluded.source_updated_at,
           marker_sha = excluded.marker_sha`,
      );
      const insertSeen = this.db.prepare(
        "INSERT OR IGNORE INTO seen_markers (repository, comment_id, marker_sha) VALUES (?, ?, ?)",
      );
      const insertRejection = this.db.prepare(
        `INSERT INTO rejections (repository, comment_id, comment_url, marker_sha, reasons, detected_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const upsertCheckpoint = this.db.prepare(
        `INSERT INTO checkpoints (source, updated_at, comment_id, etag)
         VALUES (@source, @updatedAt, @commentId, @etag)
         ON CONFLICT(source) DO UPDATE SET updated_at = excluded.updated_at, comment_id = excluded.comment_id, etag = excluded.etag`,
      );

      for (const s of batch.snapshots) {
        upsertSnapshot.run({
          upsertKey: s.upsertKey,
          repository: s.repository,
          payload: JSON.stringify(s.payload),
          sourceCommentId: s.sourceCommentId,
          sourceUpdatedAt: s.sourceUpdatedAt,
          markerSha: s.markerSha,
        });
        if (s.markerSha) insertSeen.run(s.repository, s.sourceCommentId, s.markerSha);
      }
      for (const r of batch.rejections) {
        insertRejection.run(r.repository, r.commentId, r.commentUrl ?? null, r.markerSha ?? null, JSON.stringify(r.reasons), r.detectedAt);
        if (r.markerSha) insertSeen.run(r.repository, r.commentId, r.markerSha);
      }
      upsertCheckpoint.run({
        source: batch.source,
        updatedAt: batch.nextCheckpoint.updatedAt,
        commentId: batch.nextCheckpoint.commentId,
        etag: batch.nextCheckpoint.etag ?? null,
      });
    });

    run(input);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
