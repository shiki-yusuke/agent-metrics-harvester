// Bounded-run safety valves (spec section 3): --max-api-requests / --rate-limit-floor /
// --max-runtime. A malfunctioning or malicious emitter, an unexpectedly large backlog, or a
// GitHub outage must degrade to "this run stopped early, cursor unchanged for what it didn't
// reach" -- never to an unbounded loop or a cursor advanced past work that was never
// actually fetched.

export interface SafetyValveOptions {
  readonly maxApiRequests?: number;
  readonly rateLimitFloor?: number;
  readonly maxRuntimeMs?: number;
}

export interface StopCheck {
  readonly stop: boolean;
  readonly reason?:
    | "max_api_requests_exceeded"
    | "max_runtime_exceeded"
    | "rate_limit_floor_reached";
}

export class SafetyValve {
  private requestCount = 0;
  private readonly startedAt: number;

  constructor(
    private readonly opts: SafetyValveOptions,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.startedAt = now();
  }

  private readonly now: () => number;

  get requestsUsed(): number {
    return this.requestCount;
  }

  recordRequests(count: number): void {
    this.requestCount += count;
  }

  check(rateLimitRemaining?: number): StopCheck {
    if (this.opts.maxApiRequests !== undefined && this.requestCount >= this.opts.maxApiRequests) {
      return { stop: true, reason: "max_api_requests_exceeded" };
    }
    if (
      this.opts.maxRuntimeMs !== undefined &&
      this.now() - this.startedAt >= this.opts.maxRuntimeMs
    ) {
      return { stop: true, reason: "max_runtime_exceeded" };
    }
    if (
      rateLimitRemaining !== undefined &&
      this.opts.rateLimitFloor !== undefined &&
      rateLimitRemaining <= this.opts.rateLimitFloor
    ) {
      return { stop: true, reason: "rate_limit_floor_reached" };
    }
    return { stop: false };
  }
}

export interface BackoffOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** Bounded exponential backoff delay for a given (0-indexed) retry attempt. Returns `null`
 * once `maxAttempts` is exceeded, signalling the caller must give up rather than retry forever
 * -- used for GitHub 403 secondary-rate-limit and 429 responses (spec section 3). */
export function boundedBackoffDelayMs(attempt: number, opts: BackoffOptions = {}): number | null {
  const maxAttempts = opts.maxAttempts ?? 5;
  if (attempt >= maxAttempts) return null;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60_000;
  return Math.min(max, base * 2 ** attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
