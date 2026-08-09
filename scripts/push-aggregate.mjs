#!/usr/bin/env node
// Local-observation -> `metrics-data` branch bridge (M1 dashboard, D9 plan). Reads one JSON
// object (a `--file` or stdin), validates+projects it against the aggregates/v0 schema
// (src/aggregates/schema.ts -- rejects a forbidden personal-dimension key, drops any field the
// target `kind` doesn't recognize), and only if that succeeds appends it as one line to
// `aggregates/YYYY-MM.jsonl` on the target branch (src/aggregates/git.ts), creating the branch
// as an orphan on first use.
//
// A plain script, not a compiled `src/cli` binary like the harvest/report CLIs -- it imports
// already-*built* dist output (`npm run build` must have run first, exactly like
// action/run-harvest.sh's own "npm ci && npm run build" step before it ever invokes the CLI).
// This keeps the validated schema/git logic itself in TypeScript and unit/e2e-testable
// (test/unit/aggregates-schema.test.ts, test/e2e/push-aggregate.test.ts) while this file stays
// a thin, uncompiled argv/stdin/exit-code wrapper -- the same division of labor action/
// run-harvest.sh draws around the harvest CLI, just in-process instead of subprocess.
//
// Deliberately does not import anything from a spec-lane package: the only coupling to lane is
// this file/CLI boundary (spec: "lane 側との結合は file/CLI のみ").

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const DIST_AGGREGATES = path.join(REPO_ROOT, "dist", "src", "aggregates", "index.js");

function usageError(message) {
  console.error(`push-aggregate: ${message}`);
  console.error(
    "usage: node scripts/push-aggregate.mjs --kind <attribution_audit_summary|calibration_point|heartbeat> " +
      "[--file <path>] [--repo <owner/repo|url>] [--branch metrics-data] [--github-token <token>]",
  );
  process.exitCode = 2;
}

function parseArgs(argv) {
  const opts = {
    kind: undefined,
    file: undefined,
    repo: undefined,
    branch: "metrics-data",
    githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${flag} requires a value`);
      i++;
      return v;
    };
    switch (flag) {
      case "--kind":
        opts.kind = next();
        break;
      case "--file":
        opts.file = next();
        break;
      case "--repo":
        opts.repo = next();
        break;
      case "--branch":
        opts.branch = next();
        break;
      case "--github-token":
        opts.githubToken = next();
        break;
      default:
        throw new Error(`unrecognized argument: ${flag}`);
    }
  }
  return opts;
}

function readInput(filePath) {
  if (filePath) return readFileSync(filePath, "utf-8");
  if (process.stdin.isTTY) {
    throw new Error("no --file given and stdin is a TTY -- pipe JSON in or pass --file <path>");
  }
  return readFileSync(0, "utf-8");
}

/** `--repo` may already be a full URL (a local path is used by test/e2e/push-aggregate.test.ts,
 * pointed at a temp bare repo) or an `owner/repo` slug resolved against GitHub, in which case an
 * available token is folded into the URL the same way action/prepare-state.sh does for the
 * harvester's own state-branch checkout. With no `--repo` at all, this falls back to the
 * current directory's own `origin` remote -- the common case for a developer running this from
 * inside their local checkout of this repository. */
function resolveRepoUrl(repo, githubToken) {
  if (repo === undefined) {
    return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
  }
  if (
    repo.includes("://") ||
    repo.startsWith("git@") ||
    repo.startsWith(".") ||
    repo.startsWith("/")
  ) {
    return repo;
  }
  return githubToken
    ? `https://x-access-token:${githubToken}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    usageError(err.message);
    return;
  }
  if (!opts.kind) {
    usageError("--kind is required");
    return;
  }

  let raw;
  try {
    const text = readInput(opts.file);
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`push-aggregate: failed to read/parse input JSON: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { projectAggregateRecord, monthBucketOf, appendAggregateLine } = await import(
    `file://${DIST_AGGREGATES}`
  );

  const projection = projectAggregateRecord(opts.kind, raw);
  if (!projection.ok) {
    console.error("push-aggregate: rejected -- input did not pass validation:");
    for (const e of projection.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  let repoUrl;
  try {
    repoUrl = resolveRepoUrl(opts.repo, opts.githubToken);
  } catch (err) {
    console.error(`push-aggregate: could not resolve a target repository: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const month = monthBucketOf(projection.record);
  const relativePath = `aggregates/${month}.jsonl`;
  const workDir = await mkdtemp(path.join(tmpdir(), "agent-metrics-push-aggregate-"));

  try {
    const result = await appendAggregateLine({
      repoUrl,
      branch: opts.branch,
      workDir,
      relativePath,
      line: JSON.stringify(projection.record),
    });
    console.log(
      JSON.stringify({
        kind: projection.record.kind,
        relativePath,
        branch: opts.branch,
        branchCreated: result.branchCreated,
        pushed: result.pushed,
      }),
    );
  } catch (err) {
    console.error(`push-aggregate: git operation failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("push-aggregate: fatal error");
  console.error(err);
  process.exitCode = 1;
});
