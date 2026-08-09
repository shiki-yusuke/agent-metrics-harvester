// Argument parsing for `agent-metrics-report cost-per-pr` (spec §1). Zero-dependency,
// hand-rolled, matching the harvest CLI's own args.ts style -- this is a second, separate
// binary in the same package (spec: "別 binary agent-metrics-report を追加"), not a change to
// the harvest CLI's own argument surface.

import { parseNonNegativeIntFlag } from "./numeric-flag.js";
import { PathTraversalError, assertNoPathTraversal } from "./path-safety.js";

export class ReportArgError extends Error {}

export type PeriodKind = "month" | "week";
export type MetadataMode = "auto" | "cache-only";
export type ReportFormat = "json" | "markdown";

export interface ReportOptions {
  readonly command: "cost-per-pr";
  readonly storeKind: "jsonl" | "sqlite";
  readonly storePath: string;
  readonly repos: readonly string[];
  readonly teamConfigPath?: string;
  readonly teamName?: string;
  readonly periodKind: PeriodKind;
  readonly periodLabel: string;
  readonly comparePeriodLabel?: string;
  readonly timezone: string;
  readonly metadataCachePath: string;
  readonly metadataMode: MetadataMode;
  readonly format: ReportFormat;
  readonly maxApiRequests?: number;
  readonly rateLimitFloor?: number;
  readonly maxRuntimeSeconds?: number;
  readonly minSampleSize?: number;
  readonly githubToken?: string;
  readonly githubBaseUrl?: string;
}

function assertPathSafe(value: string, flagName: string): void {
  try {
    assertNoPathTraversal(value, flagName);
  } catch (err) {
    throw err instanceof PathTraversalError ? new ReportArgError(err.message) : err;
  }
}

function requireValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) throw new ReportArgError(`${flag} requires a value`);
  return value;
}

/** See numeric-flag.ts: rejects anything `Number.parseInt` would silently turn into `NaN`
 * (e.g. "abc", "") or a negative/decimal value -- none of --max-api-requests/
 * --rate-limit-floor/--max-runtime-seconds/--min-sample-size have a sensible negative or
 * non-numeric value, and a silently-NaN safety valve would fail open (every `previewCheck`
 * comparison against NaN is false) rather than failing closed. */
function parseNonNegativeInt(value: string, flag: string): number {
  return parseNonNegativeIntFlag(value, flag, ReportArgError);
}

export function parseReportArgs(argv: readonly string[]): ReportOptions {
  const command = argv[0];
  if (command !== "cost-per-pr") {
    throw new ReportArgError(
      `unrecognized command "${command ?? ""}" -- the only supported command is "cost-per-pr"`,
    );
  }

  const repos: string[] = [];
  let storeKind: "jsonl" | "sqlite" = "jsonl";
  let storePath: string | undefined;
  let teamConfigPath: string | undefined;
  let teamName: string | undefined;
  let month: string | undefined;
  let week: string | undefined;
  let compareMonth: string | undefined;
  let compareWeek: string | undefined;
  let timezone = "UTC";
  let metadataCachePath: string | undefined;
  let metadataMode: MetadataMode = "auto";
  let format: ReportFormat | undefined;
  let maxApiRequests: number | undefined;
  let rateLimitFloor: number | undefined;
  let maxRuntimeSeconds: number | undefined;
  let minSampleSize: number | undefined;
  let githubToken: string | undefined = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  let githubBaseUrl: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i] as string;
    switch (flag) {
      case "--store": {
        const v = requireValue(argv, i, flag);
        if (v !== "jsonl" && v !== "sqlite")
          throw new ReportArgError(`--store must be "jsonl" or "sqlite", got "${v}"`);
        storeKind = v;
        i++;
        break;
      }
      case "--store-path":
        storePath = requireValue(argv, i, flag);
        i++;
        break;
      case "--repo":
        repos.push(requireValue(argv, i, flag));
        i++;
        break;
      case "--team-config":
        teamConfigPath = requireValue(argv, i, flag);
        i++;
        break;
      case "--team":
        teamName = requireValue(argv, i, flag);
        i++;
        break;
      case "--month":
        month = requireValue(argv, i, flag);
        i++;
        break;
      case "--week":
        week = requireValue(argv, i, flag);
        i++;
        break;
      case "--compare-month":
        compareMonth = requireValue(argv, i, flag);
        i++;
        break;
      case "--compare-week":
        compareWeek = requireValue(argv, i, flag);
        i++;
        break;
      case "--timezone":
        timezone = requireValue(argv, i, flag);
        i++;
        break;
      case "--metadata-cache":
        metadataCachePath = requireValue(argv, i, flag);
        i++;
        break;
      case "--metadata-mode": {
        const v = requireValue(argv, i, flag);
        if (v !== "auto" && v !== "cache-only")
          throw new ReportArgError(`--metadata-mode must be "auto" or "cache-only", got "${v}"`);
        metadataMode = v;
        i++;
        break;
      }
      case "--format": {
        const v = requireValue(argv, i, flag);
        if (v !== "json" && v !== "markdown")
          throw new ReportArgError(`--format must be "json" or "markdown", got "${v}"`);
        format = v;
        i++;
        break;
      }
      case "--max-api-requests":
        maxApiRequests = parseNonNegativeInt(requireValue(argv, i, flag), flag);
        i++;
        break;
      case "--rate-limit-floor":
        rateLimitFloor = parseNonNegativeInt(requireValue(argv, i, flag), flag);
        i++;
        break;
      case "--max-runtime-seconds":
        maxRuntimeSeconds = parseNonNegativeInt(requireValue(argv, i, flag), flag);
        i++;
        break;
      case "--min-sample-size":
        minSampleSize = parseNonNegativeInt(requireValue(argv, i, flag), flag);
        i++;
        break;
      case "--github-token":
        githubToken = requireValue(argv, i, flag);
        i++;
        break;
      case "--github-base-url":
        githubBaseUrl = requireValue(argv, i, flag);
        i++;
        break;
      default:
        throw new ReportArgError(`unrecognized argument: ${flag}`);
    }
  }

  if (repos.length > 0 && teamConfigPath !== undefined) {
    throw new ReportArgError(
      "--repo and --team-config are mutually exclusive -- pick exactly one way to specify the repository set",
    );
  }
  if (repos.length === 0 && teamConfigPath === undefined) {
    throw new ReportArgError(
      "exactly one of --repo <owner/repo> (repeatable) or --team-config <path> is required",
    );
  }
  if (teamName !== undefined && teamConfigPath === undefined) {
    throw new ReportArgError("--team requires --team-config");
  }

  if (month !== undefined && week !== undefined) {
    throw new ReportArgError("--month and --week are mutually exclusive");
  }
  if (month === undefined && week === undefined) {
    throw new ReportArgError("exactly one of --month <YYYY-MM> or --week <YYYY-Www> is required");
  }
  const periodKind: PeriodKind = month !== undefined ? "month" : "week";
  const periodLabel = (month ?? week) as string;

  if (compareMonth !== undefined && compareWeek !== undefined) {
    throw new ReportArgError("--compare-month and --compare-week are mutually exclusive");
  }
  if (compareMonth !== undefined && periodKind !== "month") {
    throw new ReportArgError(
      "--compare-month requires --month (the two periods being compared must be the same bucket kind)",
    );
  }
  if (compareWeek !== undefined && periodKind !== "week") {
    throw new ReportArgError(
      "--compare-week requires --week (the two periods being compared must be the same bucket kind)",
    );
  }
  const comparePeriodLabel = compareMonth ?? compareWeek;

  if (!storePath) throw new ReportArgError("--store-path is required");
  assertPathSafe(storePath, "--store-path");

  if (!metadataCachePath) throw new ReportArgError("--metadata-cache is required");
  assertPathSafe(metadataCachePath, "--metadata-cache");

  if (!format) throw new ReportArgError("--format is required (json or markdown)");

  return {
    command: "cost-per-pr",
    storeKind,
    storePath,
    repos,
    teamConfigPath,
    teamName,
    periodKind,
    periodLabel,
    comparePeriodLabel,
    timezone,
    metadataCachePath,
    metadataMode,
    format,
    maxApiRequests,
    rateLimitFloor,
    maxRuntimeSeconds,
    minSampleSize,
    githubToken,
    githubBaseUrl,
  };
}
