// Read-only counterpart to the harvest CLI's 4-operation Store (application/types.ts). This
// interface is intentionally NOT part of that Store contract -- adding a 5th operation to
// Store was explicitly ruled out by sol's design review for the harvester, and the report
// layer must not reopen that (spec: "harvest CLI・4操作Store・Actionの契約は一切変更しない").
// SnapshotReader is a separate, additive, read-only capability with exactly one operation.

import type { StoredSnapshot } from "../application/types.js";

export interface SnapshotReader {
  /** Returns every *current* (latest-correction-only, never an incomplete/uncommitted tail)
   * snapshot whose `repository` is in `repositories`. Order is unspecified -- callers that
   * need determinism sort themselves. */
  listCurrentSnapshots(repositories: readonly string[]): Promise<readonly StoredSnapshot[]>;
}
