// M1: elapsed time of unresolved impact assertions (cognitive-debt-metrics/v0 design 2.1).
//
// The corpus repo is walked oldest-first along first parents up to the selected commit. An
// assertion is (explanation_id, path) with path in body.uncovered_paths; an episode is a maximal
// run of `uncovered` states. Only `explanations/EXP-<16 hex>.json` files are read. A file that
// does not parse at some commit is "state unknown" there: it neither continues nor ends anything,
// and is counted in `malformed`. A path that a parsed explanation lists in neither covered_paths
// nor uncovered_paths is "state unknown" too (but not malformed): `dropped` is reserved for an
// explanation whose file left the tree (design 2.1).

import { type Estimate, RISK_CLASSES, type Revision } from "./chain.js";
import { lsTree, revListFirstParent, showBlob } from "./git.js";
import { type SelectedCommit, isRecord, parseJson } from "./inputs.js";
import { byteCompare } from "./jcs.js";
import { elapsedDays, nearestRank } from "./stats.js";
import { type UtcInstant, compareUtc, formatUtcSeconds } from "./time.js";

const OLDEST_LIMIT = 10;

const EXPLANATION_FILE = /^explanations\/EXP-[0-9a-f]{16}\.json$/;

interface ParsedExplanation {
  readonly explanation_id: string;
  readonly repo_commit: string | null;
  readonly digest: string | null;
  readonly covered: ReadonlySet<string>;
  readonly uncovered: ReadonlySet<string>;
}

function parseExplanation(bytes: Buffer | null): ParsedExplanation | null {
  if (bytes === null) return null;
  const doc = parseJson(bytes);
  if (!isRecord(doc) || typeof doc.explanation_id !== "string" || !isRecord(doc.body)) return null;
  const { covered_paths, uncovered_paths } = doc.body;
  const isStrings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((p) => typeof p === "string");
  if (!isStrings(covered_paths) || !isStrings(uncovered_paths)) return null;
  const scope = isRecord(doc.scope) ? doc.scope : {};
  const snapshot = isRecord(scope.snapshot) ? scope.snapshot : {};
  return {
    explanation_id: doc.explanation_id,
    repo_commit: typeof snapshot.repo_commit === "string" ? snapshot.repo_commit : null,
    digest: typeof snapshot.digest === "string" ? snapshot.digest : null,
    covered: new Set(covered_paths),
    uncovered: new Set(uncovered_paths),
  };
}

type EndKind = "open" | "covered" | "dropped";

interface Episode {
  readonly explanation_id: string;
  readonly path: string;
  readonly startCt: number;
  readonly end: EndKind;
  /** Whole epoch seconds: the ending commit's committer date, or as_of's seconds for `open`. */
  readonly endSec: number;
}

export interface M1Result {
  readonly output: Record<string, unknown>;
  /** Episode count per risk_class value, for min_cell. */
  readonly rows: ReadonlyMap<string, { units: number; row: Record<string, unknown> }>;
  /** Explanation ids parsed at any walked commit. */
  readonly everSeen: ReadonlySet<string>;
  /** Explanation ids present in the tree of the selected commit. */
  readonly presentAtAsOf: ReadonlySet<string>;
}

/** Design 2.1 risk join: revisions (all lanes) whose impact_scan_snapshot matches BOTH
 * repo_commit and digest; total order estimated_at max -> lane_id byte-min -> index max. */
export function riskClassFor(
  explanation: { repo_commit: string | null; digest: string | null },
  estimates: readonly Estimate[],
): string {
  if (explanation.repo_commit === null || explanation.digest === null) return "unknown";
  let best: { lane_id: string; rev: Revision } | null = null;
  for (const est of estimates) {
    for (const rev of est.revisions) {
      const s = rev.snapshot;
      if (
        s === null ||
        s.repo_commit !== explanation.repo_commit ||
        s.digest !== explanation.digest
      ) {
        continue;
      }
      if (best === null) {
        best = { lane_id: est.lane_id, rev };
        continue;
      }
      // A revision without estimated_at is earlier than any revision with one.
      const a = rev.estimatedAt;
      const b = best.rev.estimatedAt;
      const timeOrder = a === null ? (b === null ? 0 : -1) : b === null ? 1 : compareUtc(a, b);
      const laneOrder = byteCompare(est.lane_id, best.lane_id);
      if (
        timeOrder > 0 ||
        (timeOrder === 0 && laneOrder < 0) ||
        (timeOrder === 0 && laneOrder === 0 && rev.index > best.rev.index)
      ) {
        best = { lane_id: est.lane_id, rev };
      }
    }
  }
  if (best === null) return "unknown";
  return (RISK_CLASSES as readonly string[]).includes(best.rev.risk_class)
    ? best.rev.risk_class
    : "unknown";
}

function buildRow(episodes: readonly Episode[], explanationsSeen: number): Record<string, unknown> {
  const assertions = new Map<string, number>();
  for (const e of episodes) {
    const key = `${e.explanation_id}\0${e.path}`;
    assertions.set(key, (assertions.get(key) ?? 0) + 1);
  }
  let reopened = 0;
  for (const n of assertions.values()) reopened += n - 1;
  const nonMonotonic = (e: Episode) => e.endSec < e.startCt;
  const open = episodes.filter((e) => e.end === "open");
  const ages = open.filter((e) => !nonMonotonic(e)).map((e) => elapsedDays(e.startCt, e.endSec));
  const oldest = [...open]
    .sort(
      (a, b) =>
        a.startCt - b.startCt ||
        byteCompare(a.explanation_id, b.explanation_id) ||
        byteCompare(a.path, b.path),
    )
    .slice(0, OLDEST_LIMIT)
    .map((e) => ({
      explanation_id: e.explanation_id,
      path: e.path,
      since: formatUtcSeconds(e.startCt),
    }));
  return {
    population: {
      episodes: episodes.length,
      assertions: assertions.size,
      explanations_seen: explanationsSeen,
    },
    open: open.length,
    covered: episodes.filter((e) => e.end === "covered").length,
    dropped: episodes.filter((e) => e.end === "dropped").length,
    excluded_non_monotonic: episodes.filter(nonMonotonic).length,
    reopened_count: reopened,
    open_age_days: nearestRank(ages),
    oldest,
  };
}

interface AssertionState {
  openSinceCt: number | null;
}

export async function computeM1(
  corpusRepo: string,
  commit: SelectedCommit | null,
  asOf: UtcInstant,
  estimates: readonly Estimate[],
): Promise<M1Result> {
  const episodes: Episode[] = [];
  const states = new Map<string, Map<string, AssertionState>>();
  const latest = new Map<string, ParsedExplanation>();
  const lastPathOf = new Map<string, string>();
  const parseCache = new Map<string, ParsedExplanation | null>();
  let malformedFiles = 0;
  let malformedCommits = 0;
  let presentAtAsOf = new Set<string>();

  const walk = commit === null ? [] : (await revListFirstParent(corpusRepo, commit.sha)).reverse();
  for (const c of walk) {
    const entries = (await lsTree(corpusRepo, c.sha, "explanations/", false))
      .filter((e) => e.type === "blob" && EXPLANATION_FILE.test(e.path))
      .sort((a, b) => byteCompare(a.path, b.path));
    const present = new Map<string, ParsedExplanation>();
    const malformedPaths = new Set<string>();
    for (const e of entries) {
      if (!parseCache.has(e.oid))
        parseCache.set(e.oid, parseExplanation(await showBlob(corpusRepo, e.oid)));
      const parsed = parseCache.get(e.oid) ?? null;
      if (parsed === null) {
        malformedPaths.add(e.path);
        continue;
      }
      if (present.has(parsed.explanation_id)) continue;
      present.set(parsed.explanation_id, parsed);
      lastPathOf.set(parsed.explanation_id, e.path);
      latest.set(parsed.explanation_id, parsed);
    }
    if (malformedPaths.size > 0) {
      malformedFiles += malformedPaths.size;
      malformedCommits++;
    }

    const end = (id: string, path: string, s: AssertionState, kind: EndKind) => {
      if (s.openSinceCt === null) return;
      episodes.push({
        explanation_id: id,
        path,
        startCt: s.openSinceCt,
        end: kind,
        endSec: c.ct,
      });
      s.openSinceCt = null;
    };

    for (const [id, parsed] of present) {
      let byPath = states.get(id);
      if (byPath === undefined) {
        byPath = new Map();
        states.set(id, byPath);
      }
      for (const path of parsed.uncovered) {
        const s = byPath.get(path) ?? { openSinceCt: null };
        byPath.set(path, s);
        if (s.openSinceCt === null) s.openSinceCt = c.ct;
      }
      for (const [path, s] of byPath) {
        // In neither list: state unknown, the episode neither continues nor ends here.
        if (parsed.covered.has(path)) end(id, path, s, "covered");
      }
    }
    for (const [id, byPath] of states) {
      if (present.has(id)) continue;
      const lastPath = lastPathOf.get(id);
      if (lastPath !== undefined && malformedPaths.has(lastPath)) continue;
      for (const [path, s] of byPath) end(id, path, s, "dropped");
    }

    presentAtAsOf = new Set(present.keys());
    for (const [id, p] of lastPathOf) if (malformedPaths.has(p)) presentAtAsOf.add(id);
  }

  for (const [id, byPath] of states) {
    for (const [path, s] of byPath) {
      if (s.openSinceCt !== null) {
        episodes.push({
          explanation_id: id,
          path,
          startCt: s.openSinceCt,
          end: "open",
          endSec: asOf.sec,
        });
      }
    }
  }

  const riskOf = new Map<string, string>();
  for (const [id, parsed] of latest) riskOf.set(id, riskClassFor(parsed, estimates));

  const groups = new Map<string, Episode[]>();
  for (const e of episodes) {
    const risk = riskOf.get(e.explanation_id) ?? "unknown";
    const list = groups.get(risk) ?? [];
    list.push(e);
    groups.set(risk, list);
  }
  const rows = new Map<string, { units: number; row: Record<string, unknown> }>();
  for (const [risk, list] of groups) {
    const seen = [...riskOf.values()].filter((r) => r === risk).length;
    rows.set(risk, { units: list.length, row: buildRow(list, seen) });
  }

  return {
    output: {
      overall: buildRow(episodes, latest.size),
      malformed: { files: malformedFiles, commits: malformedCommits },
    },
    rows,
    everSeen: new Set(latest.keys()),
    presentAtAsOf,
  };
}
