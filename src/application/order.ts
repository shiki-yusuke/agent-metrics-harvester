// Correction conflict order (spec: "訂正の競合順序は payload の generated_at ではなく GitHub の
// (comment.updated_at, comment.id)"). A payload's own `generated_at` is never used to decide
// which of two markers for the same upsert_key wins -- only where the *comment carrying it*
// sits in GitHub's own timeline, so a slow/backdated emitter can't out-rank a later comment by
// claiming an earlier generated_at.

import type { RawComment } from "./types.js";

export function compareByGithubOrder(a: RawComment, b: RawComment): number {
  if (a.updatedAt < b.updatedAt) return -1;
  if (a.updatedAt > b.updatedAt) return 1;
  return a.id - b.id;
}

export function sortByGithubOrder(comments: readonly RawComment[]): RawComment[] {
  return [...comments].sort(compareByGithubOrder);
}
