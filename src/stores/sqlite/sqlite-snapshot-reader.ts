// Read-only SQLite SnapshotReader (report layer). Opens the store's database file with
// better-sqlite3's own `readonly: true` option -- SQLite itself, not just this class's
// discipline, refuses any write against the connection -- and issues one SELECT, which
// SQLite already wraps in an implicit transaction on its own (spec: "SQLite は単一 read tx").
// Reuses rowToStoredSnapshot (mapping.ts), the exact same row-mapping SqliteStore.readSnapshot
// uses, so the two can never disagree on how a row becomes a StoredSnapshot.

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { StoredSnapshot } from "../../application/types.js";
import type { SnapshotReader } from "../../report/snapshot-reader.js";
import { SNAPSHOT_COLUMNS, type SnapshotRow, rowToStoredSnapshot } from "./mapping.js";

export class SqliteSnapshotReader implements SnapshotReader {
  constructor(private readonly filePath: string) {}

  async listCurrentSnapshots(repositories: readonly string[]): Promise<readonly StoredSnapshot[]> {
    if (repositories.length === 0) return [];
    if (!existsSync(this.filePath)) return [];

    const db = new Database(this.filePath, { readonly: true, fileMustExist: true });
    try {
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'")
        .get();
      if (!tableExists) return [];

      const placeholders = repositories.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE repository IN (${placeholders})`)
        .all(...repositories) as SnapshotRow[];
      return rows.map(rowToStoredSnapshot);
    } finally {
      db.close();
    }
  }
}
