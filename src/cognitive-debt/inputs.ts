// Input selection and provenance (cognitive-debt-metrics/v0 design sections 1 and 3).
//
// Git-managed inputs are read from ONE commit per repo, chosen by the single rule of design
// section 1 (r12): walk `git rev-list --first-parent HEAD` in its output order and take the first
// commit whose committer date is <= as_of. Non-git inputs are hashed byte-for-byte and listed in
// `inputs[].files[]` sorted by path (byte order). The working tree and index are never read.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isGitRepo, revListFirstParentFromHead } from "./git.js";
import { byteCompare, sha256Hex } from "./jcs.js";
import { type UtcInstant, parseUtcTimestamp } from "./time.js";

export class CognitiveDebtInputError extends Error {}

export interface SelectedCommit {
  readonly sha: string;
  /** Committer date, Unix seconds. */
  readonly ct: number;
}

/** Design section 1 "読む場所": first commit in first-parent order from HEAD with committer
 * date <= as_of. Null when the repo has no such commit (incl. no commits at all). The committer
 * date is whole seconds, so `ct <= asOf.sec` decides it whatever as_of's fraction is. */
export async function selectCommit(repo: string, asOf: UtcInstant): Promise<SelectedCommit | null> {
  if (!(await isGitRepo(repo))) {
    throw new CognitiveDebtInputError(`not a git repository: ${repo}`);
  }
  for (const c of await revListFirstParentFromHead(repo)) {
    if (c.ct <= asOf.sec) return c;
  }
  return null;
}

export interface HashedFile {
  /** Path as written into `inputs[].files[].path`. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export async function hashFile(filePath: string, reportedPath = filePath): Promise<HashedFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    throw new CognitiveDebtInputError(`cannot read ${filePath}: ${(err as Error).message}`);
  }
  return { path: reportedPath, sha256: sha256Hex(bytes), bytes };
}

/** Every `*.json` directly under `dir`, in file-name byte order. `path` is the file name (the
 * entry's `dir` carries the directory). */
export async function hashDirJson(dir: string): Promise<HashedFile[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name);
  } catch (err) {
    throw new CognitiveDebtInputError(`cannot list ${dir}: ${(err as Error).message}`);
  }
  names.sort(byteCompare);
  const files: HashedFile[] = [];
  for (const name of names) files.push(await hashFile(path.join(dir, name), name));
  return files;
}

export function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf-8"));
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Personal-dimension keys (docs/cognitive-debt-decisions.md #30) that must never appear as an
 * output key. test/unit/cognitive-debt-guards.test.ts checks its own copy against this one. */
export const PERSONAL_DIMENSION_KEYS: readonly string[] = [
  "author",
  "reviewer",
  "assignee",
  "user_id",
  "email",
  "slack_id",
  "owner",
  "principal",
  "user",
  "actor",
  "login",
  "name",
];

const PROTOTYPE_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** A release_id becomes an `ack.by_release` key as is (design 2.4), so one that is a prototype
 * key or, lower-cased, a personal-dimension key is refused (decisions #40). */
function refusedReleaseId(id: string): boolean {
  return PROTOTYPE_KEYS.includes(id) || PERSONAL_DIMENSION_KEYS.includes(id.toLowerCase());
}

/** `--release-ids`: a JSON array whose elements are release id strings or objects carrying a
 * string `release_id`. Returned de-duplicated, in byte order (the population is a set). */
export function parseReleaseIds(file: HashedFile): string[] {
  const parsed = parseJson(file.bytes);
  if (!Array.isArray(parsed)) {
    throw new CognitiveDebtInputError(`--release-ids ${file.path}: expected a JSON array`);
  }
  const ids = new Set<string>();
  for (const item of parsed) {
    const id = typeof item === "string" ? item : isRecord(item) ? item.release_id : undefined;
    if (typeof id !== "string" || id.length === 0) {
      throw new CognitiveDebtInputError(
        `--release-ids ${file.path}: every element must be a non-empty string or {"release_id": string}`,
      );
    }
    if (refusedReleaseId(id)) {
      throw new CognitiveDebtInputError(
        `--release-ids ${file.path}: release_id "${id}" cannot be used as an output key (prototype or personal-dimension key)`,
      );
    }
    ids.add(id);
  }
  return [...ids].sort(byteCompare);
}

export interface ApprovalEvent {
  readonly event_id: string;
  readonly kind: string;
  readonly bundle_digest: string | null;
}

export interface AckScope {
  readonly scope_digest: string | null;
  readonly risk_class: string | null;
  readonly explanation_id: string | null;
  readonly explanation_present: boolean | null;
}

export interface AckRecord {
  readonly record_id: string;
  readonly approval_event_id: string;
  /** `occurred_at` (records whose occurred_at is not a real UTC time are not kept at all). */
  readonly occurredAt: UtcInstant;
  readonly self_report: string;
  readonly scopes: readonly AckScope[];
}

export interface AckComposite {
  readonly approvalEvents: readonly ApprovalEvent[];
  readonly ackRecords: readonly AckRecord[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `--ack`: the F2 composite. Entries without the string identifiers the join needs cannot be
 * joined to anything and are left out, and so are ack records whose `occurred_at` fails the
 * strict timestamp check (docs/cognitive-debt-decisions.md #28). */
export function parseAckComposite(file: HashedFile): AckComposite {
  const parsed = parseJson(file.bytes);
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.approval_events) ||
    !Array.isArray(parsed.ack_records)
  ) {
    throw new CognitiveDebtInputError(
      `--ack ${file.path}: expected an object with approval_events[] and ack_records[]`,
    );
  }
  const approvalEvents: ApprovalEvent[] = [];
  for (const e of parsed.approval_events) {
    if (!isRecord(e) || typeof e.event_id !== "string" || typeof e.kind !== "string") continue;
    const subject = isRecord(e.subject) ? e.subject : {};
    approvalEvents.push({
      event_id: e.event_id,
      kind: e.kind,
      bundle_digest: str(subject.bundle_digest),
    });
  }
  const ackRecords: AckRecord[] = [];
  for (const r of parsed.ack_records) {
    if (
      !isRecord(r) ||
      typeof r.record_id !== "string" ||
      typeof r.approval_event_id !== "string" ||
      typeof r.occurred_at !== "string" ||
      typeof r.self_report !== "string" ||
      !Array.isArray(r.scopes)
    ) {
      continue;
    }
    const occurredAt = parseUtcTimestamp(r.occurred_at);
    if (occurredAt === null) continue;
    ackRecords.push({
      record_id: r.record_id,
      approval_event_id: r.approval_event_id,
      occurredAt,
      self_report: r.self_report,
      scopes: r.scopes.filter(isRecord).map((s) => ({
        scope_digest: str(s.scope_digest),
        risk_class: str(s.risk_class),
        explanation_id: str(s.explanation_id),
        explanation_present:
          typeof s.explanation_present === "boolean" ? s.explanation_present : null,
      })),
    });
  }
  return { approvalEvents, ackRecords };
}

export interface LaneEvidenceDoc {
  readonly intent_id: string;
  /** undefined = no `artifacts.done_overlay` key at all; treated the same as null. */
  readonly done_overlay: { readonly merge_sha: string | null } | null;
}

/** lane-evidence:v1 files. A file that does not parse to an object with a string `intent_id`
 * can match no lane and is left out of the join (it stays listed in `inputs[].files[]`). The
 * file name is never used for the join (design section 1, r3). */
export function parseLaneEvidence(files: readonly HashedFile[]): LaneEvidenceDoc[] {
  const docs: LaneEvidenceDoc[] = [];
  for (const f of files) {
    const parsed = parseJson(f.bytes);
    if (!isRecord(parsed) || typeof parsed.intent_id !== "string") continue;
    const artifacts = isRecord(parsed.artifacts) ? parsed.artifacts : {};
    const overlay = isRecord(artifacts.done_overlay) ? artifacts.done_overlay : null;
    docs.push({
      intent_id: parsed.intent_id,
      done_overlay: overlay === null ? null : { merge_sha: str(overlay.merge_sha) },
    });
  }
  return docs;
}

export interface RepoInputEntry {
  readonly kind: "evaluations" | "explanations" | "lane_estimates" | "release_ledger";
  readonly repo: string;
  readonly commit: string | null;
  readonly [extra: string]: unknown;
}

export interface FileInputEntry {
  readonly kind: "ack_composite" | "lane_evidence" | "release_ids";
  readonly dir: string | null;
  readonly files: readonly HashedFile[];
  readonly count?: number;
}

/** `inputs[]` in `kind` byte order (design section 3). */
export function buildInputs(
  repos: readonly RepoInputEntry[],
  files: readonly FileInputEntry[],
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [
    ...repos.map((r) => ({ ...r })),
    ...files.map((f) => {
      const entry: Record<string, unknown> = {
        kind: f.kind,
        dir: f.dir,
        files: [...f.files]
          .sort((a, b) => byteCompare(a.path, b.path))
          .map((h) => ({ path: h.path, sha256: h.sha256 })),
      };
      if (f.count !== undefined) entry.count = f.count;
      return entry;
    }),
  ];
  return entries.sort((a, b) => byteCompare(a.kind as string, b.kind as string));
}
