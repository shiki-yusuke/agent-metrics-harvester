// Wires a parsed CliOptions into the real production dependencies (GithubClient +
// GithubCommentSource per repo, a JSONL or SQLite Store, one process-wide SafetyValve) and
// runs harvestAll. Kept separate from main.ts so it stays testable without going through argv
// parsing or process.exit.

import { type HarvestAllResult, harvestAll } from "../application/harvest.js";
import { SafetyValve } from "../application/safety-valve.js";
import type { CommentSource, HarvestRepositoryOptions, Store } from "../application/types.js";
import { GithubClient } from "../sources/github/client.js";
import { GithubCommentSource } from "../sources/github/comments-source.js";
import { JsonlStore } from "../stores/jsonl/jsonl-store.js";
import { SqliteStore } from "../stores/sqlite/sqlite-store.js";
import type { CliOptions } from "./args.js";

async function openStore(opts: CliOptions): Promise<Store> {
  if (opts.storeKind === "sqlite") return SqliteStore.open(opts.storePath);
  return JsonlStore.open(opts.storePath);
}

export async function runHarvest(opts: CliOptions): Promise<HarvestAllResult> {
  const store = await openStore(opts);
  const safetyValve = new SafetyValve({
    maxApiRequests: opts.maxApiRequests,
    rateLimitFloor: opts.rateLimitFloor,
    maxRuntimeMs: opts.maxRuntimeSeconds !== undefined ? opts.maxRuntimeSeconds * 1000 : undefined,
  });
  const client = new GithubClient({ token: opts.githubToken, baseUrl: opts.githubBaseUrl });

  const harvestOptions: HarvestRepositoryOptions = {
    initialSince: opts.initialSince,
    lookbackDays: opts.lookbackDays,
    overlapSeconds: opts.overlapSeconds,
    auth: { allowedLogins: opts.allowedLogins, allowedAppSlugs: opts.allowedAppSlugs },
  };

  const repositories = opts.repos.map((repo) => {
    const source: CommentSource = new GithubCommentSource(repo, client, {
      maxPages: opts.maxPagesPerFetch,
      shouldStop: (rateLimitRemaining) => safetyValve.check(rateLimitRemaining).stop,
    });
    return { source, options: harvestOptions };
  });

  try {
    return await harvestAll(repositories, store, safetyValve);
  } finally {
    await store.close();
  }
}
