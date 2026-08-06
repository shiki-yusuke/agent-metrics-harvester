import type { RejectionReason, TokenUsagePayload } from "../protocol/types.js";

/** A repo-scoped watermark. `etag` folds the GitHub source's per-URL ETag into the same
 * cursor object rather than adding a fifth store operation -- sol's design review fixed the
 * store interface at four conceptual operations (see Store below); ETag is cursor state, not
 * a distinct concern, so it travels with the checkpoint through the same read/commit path. */
export interface Checkpoint {
  readonly updatedAt: string;
  readonly commentId: number;
  readonly etag?: string;
}

export interface StoredSnapshot {
  readonly upsertKey: string;
  readonly repository: string;
  readonly payload: TokenUsagePayload;
  readonly sourceCommentId: number;
  readonly sourceUpdatedAt: string;
  readonly markerSha: string;
}

export interface RejectionRecord {
  readonly repository: string;
  readonly commentId: number;
  readonly commentUrl?: string;
  readonly markerSha?: string;
  readonly reasons: readonly RejectionReason[];
  readonly detectedAt: string;
}

export interface CommitBatchInput {
  readonly source: string;
  readonly expectedCheckpoint: Checkpoint | null;
  readonly nextCheckpoint: Checkpoint;
  readonly snapshots: readonly StoredSnapshot[];
  readonly rejections: readonly RejectionRecord[];
}

/** Thrown by a Store's commitBatch when `expectedCheckpoint` does not match what the store
 * actually holds for `source` -- a concurrent-writer guard. The Action wrapper's concurrency
 * group (action/action.yml) is supposed to make this unreachable in practice; the store
 * enforces it anyway as defense in depth, never trusting the caller's read to still be current. */
export class CheckpointConflictError extends Error {
  constructor(
    public readonly source: string,
    public readonly expected: Checkpoint | null,
    public readonly actual: Checkpoint | null,
  ) {
    super(
      `checkpoint conflict for ${source}: expected ${JSON.stringify(expected)}, store has ${JSON.stringify(actual)}`,
    );
    this.name = "CheckpointConflictError";
  }
}

/** The store interface's four conceptual operations (sol's design review). `commitBatch` is
 * the one write path: snapshot upsert + cursor advance in the same transaction, so a store
 * implementation can never advance its cursor without the corresponding snapshots (and vice
 * versa) actually landing -- see test/unit/crash-injection for the property this exists to
 * guarantee. */
export interface Store {
  readonly kind: string;
  readCheckpoint(source: string): Promise<Checkpoint | null>;
  hasSeenMarker(repository: string, commentId: number, markerSha: string): Promise<boolean>;
  readSnapshot(upsertKey: string): Promise<StoredSnapshot | null>;
  commitBatch(input: CommitBatchInput): Promise<void>;
  close(): Promise<void>;
}

export interface RawComment {
  readonly id: number;
  readonly body: string;
  readonly updatedAt: string;
  readonly htmlUrl: string;
  readonly issueNumber: number;
  readonly authorLogin: string;
  readonly authorType: "User" | "Bot" | "Organization";
  readonly performedViaAppSlug?: string;
}

export interface FetchCommentsParams {
  readonly since: string;
  readonly etag?: string;
}

export interface FetchCommentsResult {
  readonly comments: readonly RawComment[];
  readonly notModified: boolean;
  readonly newEtag?: string;
  readonly requestsUsed: number;
  readonly rateLimitRemaining?: number;
  /** True if this fetch stopped early (mid-pagination) because a safety valve tripped. The
   * comments already returned are still safe to process; the next run picks up from the
   * checkpoint computed off the last comment actually returned. */
  readonly budgetStopped?: boolean;
}

/** Read-side of a comment source. GitHub is the only production implementation
 * (src/sources/github); test/e2e substitutes a fake one to keep the offline E2E suite
 * network-free while exercising the exact same application/harvest.ts orchestration code. */
export interface CommentSource {
  readonly repository: string;
  fetchComments(params: FetchCommentsParams): Promise<FetchCommentsResult>;
}

export interface AuthConfig {
  readonly allowedLogins?: readonly string[];
  readonly allowedAppSlugs?: readonly string[];
}

export interface HarvestRepositoryOptions {
  readonly initialSince?: string;
  readonly lookbackDays?: number;
  readonly overlapSeconds?: number;
  readonly auth: AuthConfig;
}

export interface HarvestRepositoryResult {
  readonly repository: string;
  readonly accepted: number;
  readonly rejected: number;
  readonly skippedSeen: number;
  readonly ignored: number;
  readonly requestsUsed: number;
  readonly stoppedReason?: string;
  readonly notModified: boolean;
}

/** Thrown when a repository has no checkpoint yet and the caller did not supply
 * `initialSince`/`lookbackDays` -- v1 forbids a silent full scan on first run (spec section 3). */
export class InitialRunRequiresBoundsError extends Error {
  constructor(public readonly repository: string) {
    super(
      `${repository}: no checkpoint exists and neither --initial-since nor --lookback-days was given; ` +
        "a first run must not silently full-scan a repository's entire comment history.",
    );
    this.name = "InitialRunRequiresBoundsError";
  }
}
