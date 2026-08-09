// Dashboard-only repository discovery. `SnapshotReader` (report/snapshot-reader.ts) is
// deliberately one operation ("filter by a repository list I already know"); the dashboard
// generator's cost panel needs the OPPOSITE direction -- "what repositories does this store
// even contain" -- since its CLI (args.ts) takes no `--repo` flag at all (spec: every repo
// present in the store is covered automatically). Rather than growing SnapshotReader itself
// (an existing, additive, intentionally-minimal interface used by the report tool) a second
// operation it has never needed, this is a wholly separate, dashboard-scoped read path built
// from the same already-shared low-level primitives (`replayJsonlJournal` for JSONL, a plain
// read-only SELECT for SQLite) that JsonlSnapshotReader/SqliteSnapshotReader themselves use.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { replayJsonlJournal } from "../stores/jsonl/journal.js";

export interface AllRepositoriesReader {
  /** Every distinct `repository` with at least one current (latest-correction-only) snapshot in
   * the store, sorted ascending. Empty array for a missing/empty store -- never an error. */
  listAllRepositories(): Promise<readonly string[]>;
}

export class JsonlAllRepositoriesReader implements AllRepositoriesReader {
  constructor(private readonly filePath: string) {}

  async listAllRepositories(): Promise<readonly string[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = await readFile(this.filePath, "utf-8");
    const { snapshots } = replayJsonlJournal(raw);
    const repos = new Set<string>();
    for (const s of snapshots.values()) repos.add(s.repository);
    return [...repos].sort();
  }
}

export class SqliteAllRepositoriesReader implements AllRepositoriesReader {
  constructor(private readonly filePath: string) {}

  async listAllRepositories(): Promise<readonly string[]> {
    if (!existsSync(this.filePath)) return [];
    const db = new Database(this.filePath, { readonly: true, fileMustExist: true });
    try {
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'")
        .get();
      if (!tableExists) return [];
      const rows = db.prepare("SELECT DISTINCT repository FROM snapshots").all() as ReadonlyArray<{
        repository: string;
      }>;
      return rows.map((r) => r.repository).sort();
    } finally {
      db.close();
    }
  }
}
