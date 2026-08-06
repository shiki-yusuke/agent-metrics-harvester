// Per-repository harvest orchestration (spec sections 2-4). One call = one bounded fetch +
// decode + trust-check + Goodhart-recheck pass + one atomic commitBatch. Cursor state (the
// Checkpoint) only ever moves via a successful commitBatch -- see test/unit/crash-injection
// for the property this file depends on the Store implementations to uphold.

import { parseMarker } from "../protocol/envelope.js";
import { decodeMarker } from "../protocol/decode.js";
import { scanPersonalDimensions } from "../protocol/personal-dimension.js";
import type { RejectionReason } from "../protocol/types.js";
import { normalizeTokenUsagePayload } from "./normalize.js";
import { sortByGithubOrder } from "./order.js";
import type { SafetyValve } from "./safety-valve.js";
import { crossCheckRepositoryAndChange, isTrustedAuthor } from "./trust.js";
import {
  type Checkpoint,
  type CommentSource,
  type HarvestRepositoryOptions,
  type HarvestRepositoryResult,
  InitialRunRequiresBoundsError,
  type RawComment,
  type RejectionRecord,
  type Store,
  type StoredSnapshot,
} from "./types.js";

const ENVELOPE_LEVEL_CODES = new Set([
  "envelope_fields_missing",
  "envelope_base64_decode_failed",
  "envelope_hash_mismatch",
  "payload_not_valid_json",
]);

function isEnvelopeLevelFailure(reasons: readonly RejectionReason[]): boolean {
  return reasons.some((r) => ENVELOPE_LEVEL_CODES.has(r.code));
}

function computeSince(
  checkpoint: Checkpoint | null,
  opts: HarvestRepositoryOptions,
  repository: string,
  now: () => Date,
): string {
  if (checkpoint) {
    const overlapSeconds = opts.overlapSeconds ?? 300;
    const d = new Date(checkpoint.updatedAt);
    d.setUTCSeconds(d.getUTCSeconds() - overlapSeconds);
    return d.toISOString();
  }
  if (opts.initialSince) return opts.initialSince;
  if (opts.lookbackDays !== undefined) {
    const d = now();
    d.setUTCDate(d.getUTCDate() - opts.lookbackDays);
    return d.toISOString();
  }
  throw new InitialRunRequiresBoundsError(repository);
}

export interface HarvestDeps {
  readonly source: CommentSource;
  readonly store: Store;
  readonly safetyValve: SafetyValve;
  readonly now?: () => Date;
}

export async function harvestRepository(
  deps: HarvestDeps,
  opts: HarvestRepositoryOptions,
): Promise<HarvestRepositoryResult> {
  const { source, store, safetyValve } = deps;
  const now = deps.now ?? (() => new Date());
  const repository = source.repository;

  const preCheck = safetyValve.check();
  if (preCheck.stop) {
    return {
      repository,
      accepted: 0,
      rejected: 0,
      skippedSeen: 0,
      ignored: 0,
      requestsUsed: 0,
      stoppedReason: preCheck.reason,
      notModified: false,
    };
  }

  const checkpoint = await store.readCheckpoint(repository);
  const since = computeSince(checkpoint, opts, repository, now);

  const fetchResult = await source.fetchComments({ since, etag: checkpoint?.etag });
  safetyValve.recordRequests(fetchResult.requestsUsed);

  if (fetchResult.notModified) {
    return {
      repository,
      accepted: 0,
      rejected: 0,
      skippedSeen: 0,
      ignored: 0,
      requestsUsed: fetchResult.requestsUsed,
      notModified: true,
    };
  }

  const ordered = sortByGithubOrder(fetchResult.comments);

  const snapshotsByKey = new Map<string, StoredSnapshot>();
  const rejections: RejectionRecord[] = [];
  let accepted = 0;
  let rejected = 0;
  let skippedSeen = 0;
  let ignored = 0;
  let lastProcessed: RawComment | null = null;

  for (const comment of ordered) {
    const parsed = parseMarker(comment.body);
    if (parsed.ignored) {
      ignored++;
      continue;
    }

    const declaredSha = parsed.fields.sha256;
    if (declaredSha && (await store.hasSeenMarker(repository, comment.id, declaredSha))) {
      // Cheap skip (protocol doc section 2): this exact (repository, commentId, verified sha)
      // triple was already parsed and stored (or rejected-post-verification) by a previous
      // run's commitBatch -- re-parsing/re-validating it again would reach the same verdict.
      // The watermark still advances past it below via `lastProcessed`.
      skippedSeen++;
      lastProcessed = comment;
      continue;
    }

    const outcome = decodeMarker(comment.body);

    if (outcome.kind === "ignored") {
      ignored++;
      lastProcessed = comment;
      continue;
    }

    if (outcome.kind === "rejected") {
      rejected++;
      const recordableSha = isEnvelopeLevelFailure(outcome.reasons) ? undefined : declaredSha;
      rejections.push({
        repository,
        commentId: comment.id,
        commentUrl: comment.htmlUrl,
        markerSha: recordableSha,
        reasons: outcome.reasons,
        detectedAt: now().toISOString(),
      });
      lastProcessed = comment;
      continue;
    }

    // Protocol-level checks passed. Trust model (protocol doc section 7) runs next --
    // independently of anything the payload itself claims.
    if (!isTrustedAuthor(comment, opts.auth)) {
      rejected++;
      rejections.push({
        repository,
        commentId: comment.id,
        commentUrl: comment.htmlUrl,
        markerSha: declaredSha,
        reasons: [{ code: "author_not_trusted", detail: `login=${comment.authorLogin}` }],
        detectedAt: now().toISOString(),
      });
      lastProcessed = comment;
      continue;
    }

    const crossCheck = crossCheckRepositoryAndChange(outcome.payload, {
      repositoryFullName: repository,
      comment,
    });
    if (!crossCheck.ok) {
      rejected++;
      rejections.push({
        repository,
        commentId: comment.id,
        commentUrl: comment.htmlUrl,
        markerSha: declaredSha,
        reasons: [{ code: crossCheck.code as NonNullable<typeof crossCheck.code>, detail: crossCheck.detail }],
        detectedAt: now().toISOString(),
      });
      lastProcessed = comment;
      continue;
    }

    // Goodhart re-check: a second, independent personal-dimension scan right before this
    // record is queued for storage (spec section 4 -- "decode 後・store 前に Goodhart
    // 再検査（emitter と独立の二重目）"). checkPayload already ran this scan inside
    // decodeMarker; this call site exists specifically so that invariant survives even if a
    // future refactor of decode.ts's internals were to drop it there.
    const goodhartViolations = scanPersonalDimensions(outcome.payload);
    if (goodhartViolations.length > 0) {
      rejected++;
      rejections.push({
        repository,
        commentId: comment.id,
        commentUrl: comment.htmlUrl,
        markerSha: declaredSha,
        reasons: goodhartViolations.map((v) => ({
          code: "personal_dimension_forbidden_key" as const,
          detail: v,
        })),
        detectedAt: now().toISOString(),
      });
      lastProcessed = comment;
      continue;
    }

    const normalized = normalizeTokenUsagePayload(outcome.payload);
    accepted++;
    // Last-write-wins within this batch: `ordered` is ascending by (updated_at, id), so a
    // later correction for the same upsert_key naturally overwrites an earlier one here.
    snapshotsByKey.set(normalized.upsert_key, {
      upsertKey: normalized.upsert_key,
      repository,
      payload: normalized,
      sourceCommentId: comment.id,
      sourceUpdatedAt: comment.updatedAt,
      markerSha: declaredSha ?? "",
    });
    lastProcessed = comment;
  }

  const resolvedEtag = fetchResult.newEtag ?? checkpoint?.etag;
  const nextCheckpoint: Checkpoint = lastProcessed
    ? { updatedAt: lastProcessed.updatedAt, commentId: lastProcessed.id, ...(resolvedEtag !== undefined ? { etag: resolvedEtag } : {}) }
    : checkpoint
      ? { ...checkpoint, ...(resolvedEtag !== undefined ? { etag: resolvedEtag } : {}) }
      : { updatedAt: since, commentId: 0, ...(resolvedEtag !== undefined ? { etag: resolvedEtag } : {}) };

  const etagChanged = fetchResult.newEtag !== undefined && fetchResult.newEtag !== checkpoint?.etag;
  const hasWork = snapshotsByKey.size > 0 || rejections.length > 0 || lastProcessed !== null || etagChanged;

  if (hasWork) {
    await store.commitBatch({
      source: repository,
      expectedCheckpoint: checkpoint,
      nextCheckpoint,
      snapshots: [...snapshotsByKey.values()],
      rejections,
    });
  }

  return {
    repository,
    accepted,
    rejected,
    skippedSeen,
    ignored,
    requestsUsed: fetchResult.requestsUsed,
    stoppedReason: fetchResult.budgetStopped ? "budget_stopped_mid_pagination" : undefined,
    notModified: false,
  };
}

/** Runs harvestRepository across many repositories, isolating failures per-repo (spec: "1
 * repo の失敗が他 repo を巻き戻さない") -- a thrown error (e.g. CheckpointConflictError, a
 * network failure) in one repository's harvest is caught and reported without stopping the
 * others, and without partially applying that repository's own batch (commitBatch is atomic;
 * a throw before it completes means nothing was written for that repo this run). */
export interface HarvestAllResult {
  readonly results: readonly HarvestRepositoryResult[];
  readonly errors: ReadonlyMap<string, unknown>;
}

export async function harvestAll(
  repositories: readonly { readonly source: CommentSource; readonly options: HarvestRepositoryOptions }[],
  store: Store,
  safetyValve: SafetyValve,
  now?: () => Date,
): Promise<HarvestAllResult> {
  const results: HarvestRepositoryResult[] = [];
  const errors = new Map<string, unknown>();

  for (const { source, options } of repositories) {
    const stop = safetyValve.check();
    if (stop.stop) {
      results.push({
        repository: source.repository,
        accepted: 0,
        rejected: 0,
        skippedSeen: 0,
        ignored: 0,
        requestsUsed: 0,
        stoppedReason: stop.reason,
        notModified: false,
      });
      continue;
    }
    try {
      const result = await harvestRepository({ source, store, safetyValve, now }, options);
      results.push(result);
    } catch (err) {
      errors.set(source.repository, err);
    }
  }

  return { results, errors };
}
