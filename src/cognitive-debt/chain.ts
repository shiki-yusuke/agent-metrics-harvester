// The release join chain (cognitive-debt-metrics/v0 design section 1):
//   release_id -> release-events.jsonl -> bundle_digest -> bundle file -> lane_ref.lane_id
//   -> estimate.json (effective revision) + lane-evidence (done_overlay.merge_sha)
// Release-level breaks (no_release_event / ambiguous_bundle_digest / no_bundle /
// bundle_release_id_mismatch) are the only top-level `missing` codes; lane-level breaks belong to
// M2 (section 2.2) and are carried here as statuses for m2.ts / ack.ts to count in their own unit.

import { logFirstParentForPath, lsTree, showBlob, showFile } from "./git.js";
import { CognitiveDebtInputError, type LaneEvidenceDoc, isRecord, parseJson } from "./inputs.js";
import { byteCompare, jcsDigest } from "./jcs.js";
import { type UtcInstant, compareUtc, parseUtcTimestamp } from "./time.js";

export const RELEASE_MISSING_CODES = [
  "no_release_event",
  "ambiguous_bundle_digest",
  "no_bundle",
  "bundle_release_id_mismatch",
] as const;
export type ReleaseMissingCode = (typeof RELEASE_MISSING_CODES)[number];

export const RISK_CLASSES = ["low", "medium", "high"] as const;

export interface ImpactScanSnapshot {
  readonly repo_commit: string;
  readonly digest: string;
  readonly candidate_paths: readonly string[];
}

export interface Revision {
  readonly index: number;
  readonly estimatedAt: UtcInstant | null;
  readonly snapshot: ImpactScanSnapshot | null;
  /** "low" | "medium" | "high", or "unknown" when the recorded value is none of those. */
  readonly risk_class: string;
  readonly files_touched_observed: number | null;
}

export interface Estimate {
  readonly lane_id: string;
  readonly intent_id: string | null;
  readonly revisions: readonly Revision[];
}

export type EstimateStatus =
  | { readonly kind: "estimate_intent_mismatch" }
  | { readonly kind: "no_revision_before_release" }
  | { readonly kind: "ok"; readonly revision: Revision };

export type ObservationSource =
  | { readonly kind: "no_lane_evidence" | "ambiguous_lane_evidence" | "done_overlay_null" }
  | { readonly kind: "merge_sha_null" }
  | { readonly kind: "merge_sha"; readonly merge_sha: string };

export interface LaneLink {
  readonly lane_id: string;
  readonly estimate: EstimateStatus;
  readonly observation: ObservationSource;
}

export interface ReleaseLink {
  readonly release_id: string;
  /** null = resolved (every release-level link held). */
  readonly missing: ReleaseMissingCode | null;
  readonly bundle_digest: string | null;
  /** Resolved releases only; null lane = `lane_ref: null` (M2 `no_lane_ref`). */
  readonly lane: LaneLink | null;
}

function parseRevision(raw: unknown, index: number): Revision {
  const r = isRecord(raw) ? raw : {};
  const snap = isRecord(r.impact_scan_snapshot) ? r.impact_scan_snapshot : null;
  const snapshot =
    snap !== null &&
    typeof snap.repo_commit === "string" &&
    typeof snap.digest === "string" &&
    Array.isArray(snap.candidate_paths) &&
    snap.candidate_paths.every((p) => typeof p === "string")
      ? {
          repo_commit: snap.repo_commit,
          digest: snap.digest,
          candidate_paths: snap.candidate_paths as string[],
        }
      : null;
  const predictors = isRecord(r.predictors) ? r.predictors : {};
  const risk = predictors.risk_class;
  const observed = predictors.files_touched_observed;
  return {
    index,
    // Not a strict UTC timestamp = no time: the revision can never be the effective one.
    estimatedAt: typeof r.estimated_at === "string" ? parseUtcTimestamp(r.estimated_at) : null,
    snapshot,
    risk_class: (RISK_CLASSES as readonly unknown[]).includes(risk) ? (risk as string) : "unknown",
    files_touched_observed:
      typeof observed === "number" && Number.isInteger(observed) && observed >= 0 ? observed : null,
  };
}

function parseEstimate(laneId: string, bytes: Buffer | null): Estimate | null {
  if (bytes === null) return null;
  const parsed = parseJson(bytes);
  if (!isRecord(parsed)) return null;
  return {
    lane_id: laneId,
    intent_id: typeof parsed.intent_id === "string" ? parsed.intent_id : null,
    revisions: Array.isArray(parsed.revisions)
      ? parsed.revisions.map((r, i) => parseRevision(r, i))
      : [],
  };
}

/** A lane id usable as one path segment of docs/spec/<lane_id>/estimate.json. */
function isSafeSegment(laneId: string): boolean {
  return laneId.length > 0 && laneId !== "." && laneId !== ".." && !/[/\\\0]/.test(laneId);
}

export async function loadEstimate(
  laneRepo: string,
  commit: string | null,
  laneId: string,
): Promise<Estimate | null> {
  if (commit === null || !isSafeSegment(laneId)) return null;
  return parseEstimate(
    laneId,
    await showFile(laneRepo, commit, `docs/spec/${laneId}/estimate.json`),
  );
}

/** Every docs/spec/<lane_id>/estimate.json at `commit`, lane_id byte order (M1's risk join
 * searches all lanes and all revisions). */
export async function loadAllEstimates(
  laneRepo: string,
  commit: string | null,
): Promise<Estimate[]> {
  if (commit === null) return [];
  const entries = await lsTree(laneRepo, commit, "docs/spec/", true);
  const estimates: Estimate[] = [];
  for (const e of entries) {
    const m = /^docs\/spec\/([^/]+)\/estimate\.json$/.exec(e.path);
    if (!m || e.type !== "blob") continue;
    const est = parseEstimate(m[1] as string, await showBlob(laneRepo, e.oid));
    if (est !== null) estimates.push(est);
  }
  return estimates.sort((a, b) => byteCompare(a.lane_id, b.lane_id));
}

/** Design section 1 "lane の有効 revision": has impact_scan_snapshot and estimated_at <=
 * T_release; the largest estimated_at, ties broken by the later position in revisions[]. */
export function effectiveRevision(
  estimate: Estimate,
  tRelease: UtcInstant | null,
): Revision | null {
  if (tRelease === null) return null;
  let best: Revision | null = null;
  for (const r of estimate.revisions) {
    const at = r.estimatedAt;
    if (r.snapshot === null || at === null || compareUtc(at, tRelease) > 0) continue;
    if (best === null || compareUtc(best.estimatedAt as UtcInstant, at) <= 0) best = r;
  }
  return best;
}

interface LedgerEvent {
  readonly release_id: string;
  readonly bundle_digest: string;
}

function parseLedger(bytes: Buffer, strict: boolean, where: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const lines = bytes.toString("utf-8").split("\n");
  lines.forEach((line, i) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (strict) {
        throw new CognitiveDebtInputError(`${where} line ${i + 1} is not valid JSON`);
      }
      return;
    }
    if (
      isRecord(parsed) &&
      typeof parsed.release_id === "string" &&
      typeof parsed.bundle_digest === "string"
    ) {
      events.push({ release_id: parsed.release_id, bundle_digest: parsed.bundle_digest });
    }
  });
  return events;
}

/** T_release per release id (design section 1): committer date of the first first-parent
 * commit (oldest first) whose ledger contains an event for that release id. Unix seconds. */
async function releaseTimes(
  repo: string,
  commit: string,
  ledgerPath: string,
  wanted: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  const commits = await logFirstParentForPath(repo, commit, ledgerPath, { reverse: true });
  for (const c of commits) {
    if (times.size === wanted.size) break;
    const bytes = await showFile(repo, c.sha, ledgerPath);
    if (bytes === null) continue;
    for (const e of parseLedger(bytes, false, ledgerPath)) {
      if (wanted.has(e.release_id) && !times.has(e.release_id)) times.set(e.release_id, c.ct);
    }
  }
  return times;
}

async function loadBundles(
  repo: string,
  commit: string,
  bundlesDir: string,
): Promise<Map<string, unknown>> {
  const byDigest = new Map<string, unknown>();
  const entries = (await lsTree(repo, commit, `${bundlesDir}/`, true))
    .filter((e) => e.type === "blob" && e.path.endsWith(".json"))
    .sort((a, b) => byteCompare(a.path, b.path));
  for (const e of entries) {
    const bytes = await showBlob(repo, e.oid);
    const parsed = bytes === null ? undefined : parseJson(bytes);
    if (parsed === undefined) continue;
    const digest = jcsDigest(parsed);
    if (!byDigest.has(digest)) byDigest.set(digest, parsed);
  }
  return byDigest;
}

function observationFor(
  laneId: string,
  laneEvidence: readonly LaneEvidenceDoc[],
): ObservationSource {
  const matches = laneEvidence.filter((d) => d.intent_id === laneId);
  if (matches.length === 0) return { kind: "no_lane_evidence" };
  if (matches.length > 1) return { kind: "ambiguous_lane_evidence" };
  const overlay = (matches[0] as LaneEvidenceDoc).done_overlay;
  if (overlay === null) return { kind: "done_overlay_null" };
  if (overlay.merge_sha === null) return { kind: "merge_sha_null" };
  return { kind: "merge_sha", merge_sha: overlay.merge_sha };
}

export interface ChainInputs {
  readonly releaseIds: readonly string[];
  readonly ledgerRepo: string;
  readonly ledgerCommit: string | null;
  readonly ledgerPath: string;
  readonly bundlesDir: string;
  readonly laneRepo: string;
  readonly laneCommit: string | null;
  readonly laneEvidence: readonly LaneEvidenceDoc[];
}

export interface ChainResult {
  readonly releases: readonly ReleaseLink[];
  /** Resolved releases only, release_id byte order. */
  readonly resolved: readonly ReleaseLink[];
}

export async function resolveChain(input: ChainInputs): Promise<ChainResult> {
  let events: LedgerEvent[] = [];
  let bundles = new Map<string, unknown>();
  let times = new Map<string, number>();
  if (input.ledgerCommit !== null) {
    const ledgerBytes = await showFile(input.ledgerRepo, input.ledgerCommit, input.ledgerPath);
    events = ledgerBytes === null ? [] : parseLedger(ledgerBytes, true, input.ledgerPath);
    bundles = await loadBundles(input.ledgerRepo, input.ledgerCommit, input.bundlesDir);
    times = await releaseTimes(
      input.ledgerRepo,
      input.ledgerCommit,
      input.ledgerPath,
      new Set(input.releaseIds),
    );
  }

  const estimateCache = new Map<string, Estimate | null>();
  const releases: ReleaseLink[] = [];
  for (const releaseId of input.releaseIds) {
    const digests = new Set(
      events.filter((e) => e.release_id === releaseId).map((e) => e.bundle_digest),
    );
    const fail = (missing: ReleaseMissingCode, digest: string | null = null): ReleaseLink => ({
      release_id: releaseId,
      missing,
      bundle_digest: digest,
      lane: null,
    });
    if (digests.size === 0) {
      releases.push(fail("no_release_event"));
      continue;
    }
    if (digests.size > 1) {
      releases.push(fail("ambiguous_bundle_digest"));
      continue;
    }
    const digest = [...digests][0] as string;
    const bundle = bundles.get(digest);
    if (bundle === undefined) {
      releases.push(fail("no_bundle", digest));
      continue;
    }
    if (!isRecord(bundle) || bundle.release_id !== releaseId) {
      releases.push(fail("bundle_release_id_mismatch", digest));
      continue;
    }
    const laneRef = isRecord(bundle.lane_ref) ? bundle.lane_ref : null;
    const laneId = laneRef !== null && typeof laneRef.lane_id === "string" ? laneRef.lane_id : null;
    let lane: LaneLink | null = null;
    if (laneId !== null) {
      if (!estimateCache.has(laneId)) {
        estimateCache.set(laneId, await loadEstimate(input.laneRepo, input.laneCommit, laneId));
      }
      const estimate = estimateCache.get(laneId) ?? null;
      const tRelease = times.get(releaseId);
      let estimateStatus: EstimateStatus;
      if (estimate !== null && estimate.intent_id !== laneId) {
        estimateStatus = { kind: "estimate_intent_mismatch" };
      } else {
        const rev =
          estimate === null
            ? null
            : effectiveRevision(
                estimate,
                tRelease === undefined ? null : { sec: tRelease, frac: "" },
              );
        estimateStatus =
          rev === null ? { kind: "no_revision_before_release" } : { kind: "ok", revision: rev };
      }
      lane = {
        lane_id: laneId,
        estimate: estimateStatus,
        observation: observationFor(laneId, input.laneEvidence),
      };
    }
    releases.push({ release_id: releaseId, missing: null, bundle_digest: digest, lane });
  }
  return { releases, resolved: releases.filter((r) => r.missing === null) };
}

export function releaseMissingCounts(
  releases: readonly ReleaseLink[],
): Record<ReleaseMissingCode, number> {
  const counts = Object.fromEntries(RELEASE_MISSING_CODES.map((c) => [c, 0])) as Record<
    ReleaseMissingCode,
    number
  >;
  for (const r of releases) if (r.missing !== null) counts[r.missing]++;
  return counts;
}
