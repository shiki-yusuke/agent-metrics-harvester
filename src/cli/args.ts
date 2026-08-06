// Minimal hand-rolled flag parser -- no commander/yargs dependency (spec section 8: keep
// dependencies minimal). This CLI has exactly one command (`harvest`) with a fixed, small flag
// set, which does not need a general-purpose argument-parsing framework.

export interface CliOptions {
  readonly repos: readonly string[];
  readonly storeKind: "jsonl" | "sqlite";
  readonly storePath: string;
  readonly initialSince?: string;
  readonly lookbackDays?: number;
  readonly overlapSeconds?: number;
  readonly maxApiRequests?: number;
  readonly rateLimitFloor?: number;
  readonly maxRuntimeSeconds?: number;
  readonly allowedLogins: readonly string[];
  readonly allowedAppSlugs: readonly string[];
  readonly githubToken?: string;
  readonly githubBaseUrl?: string;
  readonly maxPagesPerFetch?: number;
}

export class CliArgError extends Error {}

function requireValue(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) throw new CliArgError(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const repos: string[] = [];
  const allowedLogins: string[] = [];
  const allowedAppSlugs: string[] = [];
  let storeKind: "jsonl" | "sqlite" = "jsonl";
  let storePath: string | undefined;
  let initialSince: string | undefined;
  let lookbackDays: number | undefined;
  let overlapSeconds: number | undefined;
  let maxApiRequests: number | undefined;
  let rateLimitFloor: number | undefined;
  let maxRuntimeSeconds: number | undefined;
  let githubToken: string | undefined = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  let githubBaseUrl: string | undefined;
  let maxPagesPerFetch: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    switch (flag) {
      case "--repo":
        repos.push(requireValue(argv, i, flag));
        i++;
        break;
      case "--store":
        {
          const v = requireValue(argv, i, flag);
          if (v !== "jsonl" && v !== "sqlite")
            throw new CliArgError(`--store must be "jsonl" or "sqlite", got "${v}"`);
          storeKind = v;
        }
        i++;
        break;
      case "--store-path":
        storePath = requireValue(argv, i, flag);
        i++;
        break;
      case "--initial-since":
        initialSince = requireValue(argv, i, flag);
        i++;
        break;
      case "--lookback-days":
        lookbackDays = Number.parseInt(requireValue(argv, i, flag), 10);
        i++;
        break;
      case "--overlap-seconds":
        overlapSeconds = Number.parseInt(requireValue(argv, i, flag), 10);
        i++;
        break;
      case "--max-api-requests":
        maxApiRequests = Number.parseInt(requireValue(argv, i, flag), 10);
        i++;
        break;
      case "--rate-limit-floor":
        rateLimitFloor = Number.parseInt(requireValue(argv, i, flag), 10);
        i++;
        break;
      case "--max-runtime-seconds":
        maxRuntimeSeconds = Number.parseInt(requireValue(argv, i, flag), 10);
        i++;
        break;
      case "--allowed-login":
        allowedLogins.push(requireValue(argv, i, flag));
        i++;
        break;
      case "--allowed-app-slug":
        allowedAppSlugs.push(requireValue(argv, i, flag));
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
      case "--max-pages-per-fetch":
        maxPagesPerFetch = Number.parseInt(requireValue(argv, i, flag), 10);
        i++;
        break;
      default:
        throw new CliArgError(`unrecognized argument: ${flag}`);
    }
  }

  if (repos.length === 0) throw new CliArgError("at least one --repo <owner/repo> is required");
  if (!storePath) throw new CliArgError("--store-path is required");
  if (allowedLogins.length === 0 && allowedAppSlugs.length === 0) {
    throw new CliArgError(
      "at least one --allowed-login or --allowed-app-slug is required -- a harvester with no " +
        "author allowlist would trust every comment, defeating the trust model (protocol doc section 7)",
    );
  }

  return {
    repos,
    storeKind,
    storePath,
    initialSince,
    lookbackDays,
    overlapSeconds,
    maxApiRequests,
    rateLimitFloor,
    maxRuntimeSeconds,
    allowedLogins,
    allowedAppSlugs,
    githubToken,
    githubBaseUrl,
    maxPagesPerFetch,
  };
}
