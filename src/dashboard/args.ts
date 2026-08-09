// Argument parsing for `agent-metrics-dashboard`. Deliberately has no `--repo` flag, unlike the
// harvest/report CLIs: the dashboard covers every repository already present in the store
// (see all-repositories-reader.ts), matching the exact invocation shown in the M1 spec:
// `agent-metrics-dashboard --store jsonl --store-path <path> --aggregates-dir <dir> --out <dir>
// [--now <iso>]`.

import { PathTraversalError, assertNoPathTraversal } from "../cli/path-safety.js";

export class DashboardArgError extends Error {}

export interface DashboardOptions {
  readonly storeKind: "jsonl" | "sqlite";
  readonly storePath: string;
  readonly aggregatesDir: string;
  readonly outDir: string;
  /** ISO 8601. Fixes what `computeDashboardData` treats as "now" -- omitted in normal use (the
   * real wall clock at generation time), always passed explicitly by
   * test/unit/dashboard-*.test.ts for byte-identical determinism. */
  readonly now?: string;
}

function assertPathSafe(value: string, flagName: string): void {
  try {
    assertNoPathTraversal(value, flagName);
  } catch (err) {
    throw err instanceof PathTraversalError ? new DashboardArgError(err.message) : err;
  }
}

function requireValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) throw new DashboardArgError(`${flag} requires a value`);
  return value;
}

export function parseDashboardArgs(argv: readonly string[]): DashboardOptions {
  let storeKind: "jsonl" | "sqlite" = "jsonl";
  let storePath: string | undefined;
  let aggregatesDir: string | undefined;
  let outDir: string | undefined;
  let now: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    switch (flag) {
      case "--store": {
        const v = requireValue(argv, i, flag);
        if (v !== "jsonl" && v !== "sqlite") {
          throw new DashboardArgError(`--store must be "jsonl" or "sqlite", got "${v}"`);
        }
        storeKind = v;
        i++;
        break;
      }
      case "--store-path":
        storePath = requireValue(argv, i, flag);
        i++;
        break;
      case "--aggregates-dir":
        aggregatesDir = requireValue(argv, i, flag);
        i++;
        break;
      case "--out":
        outDir = requireValue(argv, i, flag);
        i++;
        break;
      case "--now":
        now = requireValue(argv, i, flag);
        i++;
        break;
      default:
        throw new DashboardArgError(`unrecognized argument: ${flag}`);
    }
  }

  if (!storePath) throw new DashboardArgError("--store-path is required");
  assertPathSafe(storePath, "--store-path");

  if (!aggregatesDir) throw new DashboardArgError("--aggregates-dir is required");
  assertPathSafe(aggregatesDir, "--aggregates-dir");

  if (!outDir) throw new DashboardArgError("--out is required");
  assertPathSafe(outDir, "--out");

  if (now !== undefined && Number.isNaN(Date.parse(now))) {
    throw new DashboardArgError(`--now must be a parseable ISO 8601 timestamp, got "${now}"`);
  }

  return { storeKind, storePath, aggregatesDir, outDir, now };
}
