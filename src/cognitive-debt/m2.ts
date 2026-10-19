// M2: impact-scan prediction error per release-lane (cognitive-debt-metrics/v0 design 2.2).
//
// Prediction = effective revision's impact_scan_snapshot.candidate_paths; observation =
// `git diff --name-only --no-renames -z <merge_sha>^1 <merge_sha>` in the lane repo, only when
// merge_sha is an ancestor of the lane repo's selected commit (r13). The unit is the
// (release_id, lane_id) pair; rows are micro sums plus per-unit nearest-rank distributions.

import type { ReleaseLink, Revision } from "./chain.js";
import { diffNames, isAncestor, isObjectId, parentsOf } from "./git.js";
import { byteCompare } from "./jcs.js";
import { missingEntry, nearestRank, ratio2 } from "./stats.js";

export const M2_STATUSES = [
  "ok",
  "no_revision_before_release",
  "done_overlay_null",
  "merge_sha_null",
  "merge_sha_unreachable",
  "root_commit",
] as const;
type M2Status = (typeof M2_STATUSES)[number];

type ObservationCode =
  | "no_lane_evidence"
  | "ambiguous_lane_evidence"
  | "done_overlay_null"
  | "merge_sha_null"
  | "merge_sha_unreachable"
  | "root_commit";

interface PathResult {
  readonly hit: string[];
  readonly unused: string[];
  readonly missed: string[];
  readonly dir_hit: string[];
  readonly dir_unused: string[];
  readonly unmatched_pattern: string[];
  readonly dir_width: { dir: string; observed_count: number }[];
  readonly observed: number;
  readonly candidate_file: number;
  readonly candidate_dir: number;
}

export interface M2Unit {
  readonly release_id: string;
  readonly lane_id: string;
  readonly revision: Revision | null;
  readonly estimateCode: "estimate_intent_mismatch" | "no_revision_before_release" | null;
  readonly observationCode: ObservationCode | null;
  readonly observed: readonly string[] | null;
  readonly paths: PathResult | null;
}

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(byteCompare);

export interface ClassifiedCandidates {
  readonly files: string[];
  readonly dirs: string[];
  readonly patterns: string[];
}

/** Exclusive classification after de-duplication: `*` `?` `[` -> pattern, then trailing `/` ->
 * dir, else file. */
export function classifyCandidates(candidates: readonly string[]): ClassifiedCandidates {
  const files: string[] = [];
  const dirs: string[] = [];
  const patterns: string[] = [];
  for (const c of sortedUnique(candidates)) {
    if (/[*?[]/.test(c)) patterns.push(c);
    else if (c.endsWith("/")) dirs.push(c);
    else files.push(c);
  }
  return { files, dirs, patterns };
}

/** Design 2.2 set algebra. Each observed path belongs to its single longest matching dir; a dir
 * is `dir_hit` only when at least one observation belongs to it directly. */
export function comparePaths(
  candidates: readonly string[],
  observedPaths: readonly string[],
): PathResult {
  const { files, dirs, patterns } = classifyCandidates(candidates);
  const observed = sortedUnique(observedPaths);
  const fileSet = new Set(files);
  const observedSet = new Set(observed);
  const direct = new Map<string, number>(dirs.map((d) => [d, 0]));
  const underDir = new Set<string>();
  for (const o of observed) {
    let longest: string | null = null;
    for (const d of dirs) {
      if (o.startsWith(d) && (longest === null || d.length > longest.length)) longest = d;
    }
    if (longest !== null) {
      direct.set(longest, (direct.get(longest) ?? 0) + 1);
      underDir.add(o);
    }
  }
  return {
    hit: files.filter((f) => observedSet.has(f)),
    unused: files.filter((f) => !observedSet.has(f)),
    missed: observed.filter((o) => !fileSet.has(o) && !underDir.has(o)),
    dir_hit: dirs.filter((d) => (direct.get(d) ?? 0) > 0),
    dir_unused: dirs.filter((d) => (direct.get(d) ?? 0) === 0),
    unmatched_pattern: patterns,
    dir_width: dirs.map((d) => ({ dir: d, observed_count: direct.get(d) ?? 0 })),
    observed: observed.length,
    candidate_file: files.length,
    candidate_dir: dirs.length,
  };
}

/** Design 2.2 observation for one merge_sha. Anything but a 40-hex object id (`HEAD`, a short
 * sha, upper case, a leading `-`) is `merge_sha_unreachable` without starting git. */
export async function observe(
  laneRepo: string,
  laneCommit: string | null,
  mergeSha: string,
): Promise<{ code: ObservationCode } | { paths: string[] }> {
  if (
    !isObjectId(mergeSha) ||
    laneCommit === null ||
    !(await isAncestor(laneRepo, mergeSha, laneCommit))
  ) {
    return { code: "merge_sha_unreachable" };
  }
  const parents = await parentsOf(laneRepo, mergeSha);
  if (parents.length === 0) return { code: "root_commit" };
  return { paths: await diffNames(laneRepo, parents[0] as string, mergeSha) };
}

export async function buildM2Units(
  resolved: readonly ReleaseLink[],
  laneRepo: string,
  laneCommit: string | null,
): Promise<M2Unit[]> {
  const units: M2Unit[] = [];
  for (const r of resolved) {
    if (r.lane === null) continue;
    const est = r.lane.estimate;
    const revision = est.kind === "ok" ? est.revision : null;
    const estimateCode = est.kind === "ok" ? null : est.kind;
    let observationCode: ObservationCode | null = null;
    let observed: string[] | null = null;
    const src = r.lane.observation;
    if (src.kind === "merge_sha") {
      const o = await observe(laneRepo, laneCommit, src.merge_sha);
      if ("code" in o) observationCode = o.code;
      else observed = o.paths;
    } else {
      observationCode = src.kind;
    }
    const paths =
      revision !== null && observed !== null
        ? comparePaths(
            (revision.snapshot as { candidate_paths: readonly string[] }).candidate_paths,
            observed,
          )
        : null;
    units.push({
      release_id: r.release_id,
      lane_id: r.lane.lane_id,
      revision,
      estimateCode,
      observationCode,
      observed,
      paths,
    });
  }
  return units.sort(
    (a, b) => byteCompare(a.release_id, b.release_id) || byteCompare(a.lane_id, b.lane_id),
  );
}

const RELEASE_LEVEL_OBSERVATION: ReadonlySet<string> = new Set([
  "no_lane_evidence",
  "ambiguous_lane_evidence",
]);

/** `detail[].status`, or null for a unit broken at a release-level link (those units are
 * counted in `missing` only; the closed status set has no value for them). */
function detailStatus(u: M2Unit): M2Status | null {
  if (u.estimateCode === "estimate_intent_mismatch") return null;
  if (u.observationCode !== null && RELEASE_LEVEL_OBSERVATION.has(u.observationCode)) return null;
  if (u.estimateCode === "no_revision_before_release") return "no_revision_before_release";
  if (u.observationCode !== null) return u.observationCode as M2Status;
  return "ok";
}

function predictedCount(rev: Revision): number {
  const c = classifyCandidates(
    (rev.snapshot as { candidate_paths: readonly string[] }).candidate_paths,
  );
  return c.files.length + c.dirs.length;
}

export function m2Row(units: readonly M2Unit[]): Record<string, unknown> {
  const ok = units.filter((u) => u.paths !== null);
  const sum = (f: (p: PathResult) => number) =>
    ok.reduce((acc, u) => acc + f(u.paths as PathResult), 0);
  const sums = {
    observed: sum((p) => p.observed),
    candidate_file: sum((p) => p.candidate_file),
    candidate_dir: sum((p) => p.candidate_dir),
    hit: sum((p) => p.hit.length),
    unused: sum((p) => p.unused.length),
    missed: sum((p) => p.missed.length),
    dir_hit: sum((p) => p.dir_hit.length),
    dir_unused: sum((p) => p.dir_unused.length),
    unmatched_pattern: sum((p) => p.unmatched_pattern.length),
  };
  const missedRatios: number[] = [];
  const unusedRatios: number[] = [];
  const widths: number[] = [];
  for (const u of ok) {
    const p = u.paths as PathResult;
    const mr = ratio2(p.missed.length, p.observed);
    const ur = ratio2(p.unused.length, p.candidate_file);
    if (mr !== null) missedRatios.push(mr);
    if (ur !== null) unusedRatios.push(ur);
    for (const w of p.dir_width) widths.push(w.observed_count);
  }
  const counted = units.filter(
    (u) => u.revision !== null && u.revision.files_touched_observed !== null,
  );
  const predicted = counted.map((u) => predictedCount(u.revision as Revision));
  const observedCounts = counted.map(
    (u) => (u.revision as Revision).files_touched_observed as number,
  );
  const signed = predicted.map((p, i) => p - (observedCounts[i] as number));
  return {
    units: units.length,
    lanes_distinct: new Set(units.map((u) => u.lane_id)).size,
    units_with_prediction: units.filter((u) => u.revision !== null).length,
    units_with_observation: units.filter((u) => u.observed !== null).length,
    high_risk_units_with_missed: ok.filter(
      (u) => u.revision?.risk_class === "high" && (u.paths as PathResult).missed.length > 0,
    ).length,
    sums,
    missed_ratio: ratio2(sums.missed, sums.observed),
    unused_ratio: ratio2(sums.unused, sums.candidate_file),
    per_lane: {
      missed_ratio: nearestRank(missedRatios),
      unused_ratio: nearestRank(unusedRatios),
    },
    dir_width: {
      dirs: widths.length,
      observed_count_max: widths.length === 0 ? null : Math.max(...widths),
    },
    count_level: {
      units: counted.length,
      sums: {
        predicted: predicted.reduce((a, b) => a + b, 0),
        observed: observedCounts.reduce((a, b) => a + b, 0),
      },
      signed_error: nearestRank(signed),
      abs_error: nearestRank(signed.map((s) => Math.abs(s))),
    },
  };
}

export interface M2Result {
  readonly output: Record<string, unknown>;
  readonly rows: ReadonlyMap<string, { units: number; row: Record<string, unknown> }>;
}

export function computeM2(
  units: readonly M2Unit[],
  resolved: readonly ReleaseLink[],
  detail: boolean,
): M2Result {
  const count = (pred: (u: M2Unit) => boolean) => units.filter(pred).length;
  const obs = (code: ObservationCode) => count((u) => u.observationCode === code);
  const missing = {
    no_lane_ref: missingEntry(resolved.filter((r) => r.lane === null).length, "release"),
    no_lane_evidence: missingEntry(obs("no_lane_evidence"), "release"),
    ambiguous_lane_evidence: missingEntry(obs("ambiguous_lane_evidence"), "release"),
    estimate_intent_mismatch: missingEntry(
      count((u) => u.estimateCode === "estimate_intent_mismatch"),
      "release",
    ),
    no_revision_before_release: missingEntry(
      count((u) => u.estimateCode === "no_revision_before_release"),
      "release_lane",
    ),
    done_overlay_null: missingEntry(obs("done_overlay_null"), "release_lane"),
    merge_sha_null: missingEntry(obs("merge_sha_null"), "release_lane"),
    merge_sha_unreachable: missingEntry(obs("merge_sha_unreachable"), "release_lane"),
    root_commit: missingEntry(obs("root_commit"), "release_lane"),
    files_touched_observed_null: missingEntry(
      count((u) => u.revision !== null && u.revision.files_touched_observed === null),
      "release_lane",
    ),
  };
  const population = {
    resolved_releases: resolved.length,
    release_lanes: units.length,
    lanes_distinct: new Set(units.map((u) => u.lane_id)).size,
    units_with_prediction: count((u) => u.revision !== null),
    units_with_observation: count((u) => u.observed !== null),
    units_with_count_level: count(
      (u) => u.revision !== null && u.revision.files_touched_observed !== null,
    ),
  };

  const groups = new Map<string, M2Unit[]>();
  for (const u of units) {
    if (u.revision === null) continue;
    const list = groups.get(u.revision.risk_class) ?? [];
    list.push(u);
    groups.set(u.revision.risk_class, list);
  }
  const rows = new Map<string, { units: number; row: Record<string, unknown> }>();
  for (const [risk, list] of groups) rows.set(risk, { units: list.length, row: m2Row(list) });

  let detailRows: Record<string, unknown>[] | null = null;
  if (detail) {
    detailRows = [];
    for (const u of units) {
      const status = detailStatus(u);
      if (status === null) continue;
      const p = status === "ok" ? (u.paths as PathResult) : null;
      detailRows.push({
        release_id: u.release_id,
        lane_id: u.lane_id,
        status,
        hit: p?.hit ?? [],
        unused: p?.unused ?? [],
        missed: p?.missed ?? [],
        dir_hit: p?.dir_hit ?? [],
        dir_unused: p?.dir_unused ?? [],
        unmatched_pattern: p?.unmatched_pattern ?? [],
        dir_width: p?.dir_width ?? [],
      });
    }
  }

  return {
    output: { population, missing, overall: m2Row(units), detail: detailRows },
    rows,
  };
}
