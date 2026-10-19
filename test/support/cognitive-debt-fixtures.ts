// Synthetic, fully offline fixtures for agent-metrics-cognitive-debt (cognitive-debt-metrics/v0
// design section 4): four temp git repos (release-evidence ledger, lane consumer repo,
// evidence-docs corpus, evaluations) built with fixed author/committer identity and dates, plus
// the non-git inputs (release ids, lane-evidence dir, ack composite). Same content + same dates
// => same commit shas, so two scenarios built in different temp dirs share every git input.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jcsDigest } from "../../src/cognitive-debt/jcs.js";
import { runCognitiveDebt } from "../../src/cognitive-debt/run.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

function git(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf-8" }).trim();
}

export function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);
}

export type FileContent = string | Record<string, unknown> | unknown[] | null;

function writeFiles(dir: string, files: Record<string, FileContent>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  }
}

/** Writes (or deletes, for null) `files`, stages everything, and commits with both dates fixed
 * to `isoDate`. Returns the new commit sha. */
export function commitFiles(
  dir: string,
  files: Record<string, FileContent>,
  isoDate: string,
  message = `commit at ${isoDate}`,
): string {
  writeFiles(dir, files);
  const date = `@${Math.floor(Date.parse(isoDate) / 1000)} +0000`;
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", message], {
    ...GIT_ENV,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(dir, ["rev-parse", "HEAD"]);
}

export interface CommitSpec {
  readonly date: string;
  readonly files: Record<string, FileContent>;
}

export interface BuildContext {
  /** Lane repo commit shas, in spec order. */
  readonly laneShas: readonly string[];
  readonly digest: (bundle: unknown) => string;
}

export interface ScenarioSpec {
  asOf: string;
  releaseIds: unknown[];
  ledger: CommitSpec[];
  lane: CommitSpec[];
  corpus: CommitSpec[];
  evaluations: CommitSpec[];
  laneEvidence: (ctx: BuildContext) => Record<string, FileContent>;
  ack: (ctx: BuildContext) => Record<string, unknown>;
}

export const SHA_A = `sha256:${"a".repeat(64)}`;
export const SHA_B = `sha256:${"b".repeat(64)}`;
export const EVENT_1 = `sha256:${"1".repeat(64)}`;
export const EXP_1 = "EXP-0000000000000001";

export function bundle(releaseId: string, laneId: string | null): Record<string, unknown> {
  return {
    schema_version: "release-evidence/v0",
    release_id: releaseId,
    lane_ref: laneId === null ? null : { lane_id: laneId, repo: "octo/consumer" },
  };
}

export function ledgerEvent(
  releaseId: string,
  bundleDigest: string,
  n: number,
): Record<string, unknown> {
  return {
    schema_version: "release-evidence/v0",
    event_id: `sha256:${String(n).padStart(64, "0")}`,
    release_id: releaseId,
    kind: "prepared",
    environment: "production",
    occurred_at: "2026-01-10T00:00:00Z",
    actor: { kind: "automation", id: "ci" },
    bundle_digest: bundleDigest,
  };
}

export const jsonl = (events: readonly unknown[]): string =>
  events.map((e) => `${JSON.stringify(e)}\n`).join("");

export function estimate(
  laneId: string,
  revisions: Array<{
    estimated_at: string;
    candidate_paths?: string[];
    digest?: string;
    risk_class?: string;
    files_touched_observed?: number | null;
  }>,
  intentId = laneId,
): Record<string, unknown> {
  return {
    schema_version: "estimate:v2",
    intent_id: intentId,
    revisions: revisions.map((r, i) => ({
      revision_id: `rev-${i + 1}`,
      estimated_at: r.estimated_at,
      as_of_phase: "2_spec",
      repo_commit: "c0ffee",
      ...(r.candidate_paths === undefined
        ? {}
        : {
            impact_scan_snapshot: {
              scan_version: "1",
              repo_commit: "c0ffee",
              candidate_paths: r.candidate_paths,
              candidate_layers: [],
              open_items: [],
              digest: r.digest ?? `scope-${laneId}`,
            },
          }),
      estimator_version: "fixture",
      predictors: {
        files_touched_estimate: null,
        files_touched_observed:
          r.files_touched_observed === undefined ? 3 : r.files_touched_observed,
        layers_crossed: null,
        risk_class: r.risk_class ?? "high",
        spec_rule_count: null,
        novel_surface: "unknown",
      },
    })),
  };
}

export function explanation(
  id: string,
  uncovered: string[],
  covered: string[],
  digest = "scope-L-1",
): Record<string, unknown> {
  return {
    explanation_id: id,
    scope: {
      snapshot: {
        repo_commit: "c0ffee",
        digest,
        candidate_paths: [...uncovered, ...covered].sort(),
      },
    },
    body: { covered_paths: covered, uncovered_paths: uncovered },
  };
}

export function laneEvidenceDoc(
  intentId: string,
  mergeSha: string | null,
): Record<string, unknown> {
  return {
    schema_version: "lane-evidence:v1",
    intent_id: intentId,
    generated_at: "2026-01-05T00:00:00Z",
    current_phase: "5_done",
    artifacts: {
      done_overlay: {
        done_source: "local_overlay",
        pr_url: null,
        merge_sha: mergeSha,
        verify_ended_at: "2026-01-04T00:00:00Z",
        done_recorded_at: "2026-01-04T00:00:00Z",
      },
    },
  };
}

export function approvalEvent(eventId: string, bundleDigest: string, kind = "approval_granted") {
  return {
    schema_version: "release-approval/v0",
    kind,
    subject: { bundle_digest: bundleDigest, target: "production" },
    principal: { principal_id: "release-captain-04", issuer: "oidc", role_snapshot: "approver" },
    occurred_at: "2026-01-11T00:00:00Z",
    event_id: eventId,
  };
}

export function ackRecord(
  recordId: string,
  eventId: string,
  options: { occurred_at?: string; self_report?: string; scope_digest?: string } = {},
) {
  return {
    schema_version: "cognitive-ack/v0",
    record_id: recordId,
    authority: "none",
    approval_event_id: eventId,
    principal: { principal_id: "release-captain-04", issuer: "oidc", role_snapshot: "approver" },
    occurred_at: options.occurred_at ?? "2026-01-11T00:00:00Z",
    self_report: options.self_report ?? "acknowledged",
    basis: "self_report",
    scopes: [
      {
        kind: "impact-scan:v1",
        scope_digest: options.scope_digest ?? "scope-L-1",
        risk_class: "high",
        risk_reason: "privilege_boundary",
        explanation_id: EXP_1,
        explanation_present: true,
      },
    ],
  };
}

/** The e2e baseline: R1 = full chain (lane L-1, two M1 episodes: one covered, one open; one M2
 * unit), R2 = `lane_ref: null`, R3 = no release event. */
export function baseSpec(): ScenarioSpec {
  const b1 = bundle("R1", "L-1");
  const b2 = bundle("R2", null);
  return {
    asOf: "2026-02-01T00:00:00Z",
    releaseIds: ["R1", "R2", "R3"],
    ledger: [
      {
        date: "2026-01-10T00:00:00Z",
        files: {
          "bundles/r1.json": b1,
          "bundles/r2.json": b2,
          "release-events.jsonl": jsonl([
            ledgerEvent("R1", jcsDigest(b1), 1),
            ledgerEvent("R2", jcsDigest(b2), 2),
          ]),
        },
      },
    ],
    lane: [
      {
        date: "2026-01-01T00:00:00Z",
        files: {
          "README.md": "consumer\n",
          "src/a.ts": "a0\n",
          "src/b.ts": "b0\n",
          "docs/spec/L-1/estimate.json": estimate("L-1", [
            {
              estimated_at: "2026-01-01T00:00:00Z",
              candidate_paths: ["src/a.ts", "src/b.ts", "lib/"],
            },
          ]),
        },
      },
      {
        date: "2026-01-03T00:00:00Z",
        files: { "src/a.ts": "a1\n", "src/c.ts": "c1\n", "lib/x.ts": "x1\n" },
      },
    ],
    corpus: [
      {
        date: "2026-01-02T00:00:00Z",
        files: { [`explanations/${EXP_1}.json`]: explanation(EXP_1, ["src/a.ts", "src/b.ts"], []) },
      },
      {
        date: "2026-01-04T00:00:00Z",
        files: { [`explanations/${EXP_1}.json`]: explanation(EXP_1, ["src/b.ts"], ["src/a.ts"]) },
      },
    ],
    evaluations: [{ date: "2026-01-01T00:00:00Z", files: { "README.md": "evaluations\n" } }],
    laneEvidence: (ctx) => ({ "L-1.json": laneEvidenceDoc("L-1", ctx.laneShas[1] as string) }),
    ack: (ctx) => ({
      approval_events: [approvalEvent(EVENT_1, ctx.digest(b1))],
      ack_records: [ackRecord(SHA_A, EVENT_1)],
    }),
  };
}

export interface Scenario {
  readonly root: string;
  readonly repos: { ledger: string; lane: string; corpus: string; evaluations: string };
  readonly laneEvidenceDir: string;
  readonly releaseIdsFile: string;
  readonly ackFile: string;
  readonly laneShas: readonly string[];
  readonly asOf: string;
  args(out: string, extra?: readonly string[]): string[];
  cleanup(): void;
}

function buildRepo(dir: string, commits: readonly CommitSpec[]): string[] {
  initRepo(dir);
  return commits.map((c) => commitFiles(dir, c.files, c.date));
}

export function buildScenario(
  spec: ScenarioSpec,
  root = mkdtempSync(path.join(tmpdir(), "cd-fixture-")),
): Scenario {
  const repos = {
    ledger: path.join(root, "release-evidence"),
    lane: path.join(root, "lane"),
    corpus: path.join(root, "corpus"),
    evaluations: path.join(root, "evaluations"),
  };
  buildRepo(repos.ledger, spec.ledger);
  const laneShas = buildRepo(repos.lane, spec.lane);
  buildRepo(repos.corpus, spec.corpus);
  buildRepo(repos.evaluations, spec.evaluations);
  const ctx: BuildContext = { laneShas, digest: jcsDigest };
  const laneEvidenceDir = path.join(root, "lane-evidence");
  mkdirSync(laneEvidenceDir, { recursive: true });
  writeFiles(laneEvidenceDir, spec.laneEvidence(ctx));
  const releaseIdsFile = path.join(root, "release-ids.json");
  writeFileSync(releaseIdsFile, `${JSON.stringify(spec.releaseIds)}\n`);
  const ackFile = path.join(root, "ack.json");
  writeFileSync(ackFile, `${JSON.stringify(spec.ack(ctx), null, 2)}\n`);
  return {
    root,
    repos,
    laneEvidenceDir,
    releaseIdsFile,
    ackFile,
    laneShas,
    asOf: spec.asOf,
    args: (out, extra = []) => [
      "--release-ids",
      releaseIdsFile,
      "--release-ledger",
      repos.ledger,
      "--ack",
      ackFile,
      "--lane-repo",
      repos.lane,
      "--lane-evidence",
      laneEvidenceDir,
      "--explanations",
      repos.corpus,
      "--evaluations",
      repos.evaluations,
      "--as-of",
      spec.asOf,
      "--out",
      out,
      ...extra,
    ],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RunResult {
  readonly code: number;
  readonly stderr: string[];
  readonly bytes: Buffer | null;
  // biome-ignore lint/suspicious/noExplicitAny: test-side view of the parsed report
  readonly report: any;
}

/** Runs the command in-process against `scenario` and reads the written report back. */
export async function runScenario(
  scenario: Scenario,
  extra: readonly string[] = [],
  outName = "report.json",
  overrides: { vendorDir?: string } = {},
): Promise<RunResult> {
  const out = path.join(scenario.root, outName);
  rmSync(out, { force: true });
  const stderr: string[] = [];
  const code = await runCognitiveDebt(
    scenario.args(out, extra),
    { stdout: () => {}, stderr: (l) => stderr.push(l) },
    overrides,
  );
  let bytes: Buffer | null = null;
  try {
    bytes = readFileSync(out);
  } catch {
    bytes = null;
  }
  return {
    code,
    stderr,
    bytes,
    report: bytes === null ? null : JSON.parse(bytes.toString("utf-8")),
  };
}

/** Build + run + cleanup in one call (most negative-fixture tests need nothing else). */
export async function runSpec(
  spec: ScenarioSpec,
  extra: readonly string[] = [],
): Promise<RunResult> {
  const scenario = buildScenario(spec);
  try {
    return await runScenario(scenario, extra);
  } finally {
    scenario.cleanup();
  }
}
