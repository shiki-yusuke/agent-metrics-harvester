// Shared test helpers -- not itself a test file (no *.test.ts suffix, so `node --test` never
// picks it up directly). Builds well-formed token-usage/v1 payloads and marker text on the fly
// so unit/e2e tests aren't stuck re-deriving upsert_key/sha256 arithmetic by hand.

import type { RawComment } from "../../src/application/types.js";
import { computeUpsertKey, sha256Hex } from "../../src/protocol/canonical.js";
import type { TokenUsagePayload } from "../../src/protocol/types.js";

export interface MakePayloadOptions {
  readonly repository?: string;
  readonly subjectId?: string;
  readonly changeNumber?: number;
  readonly tokens?: number;
  readonly generatedAt?: string;
  /** Defaults to 0.01 -- most tests care that a payload's record IS priced with a known cost,
   * not the exact figure. Pass 0 explicitly (not undefined) if you specifically need a $0
   * priced record; pass a `data` override instead if you need pricing_status other than
   * "priced" at all (see test/unit/cost-per-pr.test.ts for that pattern). */
  readonly estimatedCostUsd?: number;
}

export function makeTokenUsagePayload(opts: MakePayloadOptions = {}): TokenUsagePayload {
  const repository = { provider: "github", id: opts.repository ?? "octo/example" };
  const subject = {
    namespace: "test-emitter",
    type: "delivery-run",
    id: opts.subjectId ?? "run-1",
  };
  const upsertKey = computeUpsertKey({ schema: "token-usage/v1", repository, subject });

  return {
    protocol_version: "agent-metrics/v1",
    schema: "token-usage/v1",
    upsert_key: upsertKey,
    emitter: { name: "test-emitter", version: "0.0.1" },
    subject,
    repository,
    ...(opts.changeNumber !== undefined
      ? {
          change: {
            type: "pull_request",
            number: opts.changeNumber,
            url: "https://example.invalid/pr",
            head_sha: "abc123",
          },
        }
      : {}),
    generated_at: opts.generatedAt ?? "2026-08-01T00:00:00Z",
    data: {
      mode: "snapshot",
      records: [
        {
          activity: { namespace: "test", name: "implement" },
          agent: "claude",
          model: "claude-sonnet-5",
          token_kind: "output",
          tokens: opts.tokens ?? 100,
          pricing_status: "priced",
          estimated_cost_usd: opts.estimatedCostUsd ?? 0.01,
        },
      ],
      coverage: {
        status: "complete",
        eligible_entries: 1,
        measured_entries: 1,
        excluded_entries: 0,
      },
    },
  };
}

export function markerTextFor(payload: unknown): string {
  const bytes = Buffer.from(JSON.stringify(payload), "utf-8");
  const b64 = bytes.toString("base64");
  const sha = sha256Hex(bytes);
  return `<!-- agent-metrics:v1 payload_b64=${b64} sha256=${sha} -->`;
}

export function shaOfPayload(payload: unknown): string {
  return sha256Hex(Buffer.from(JSON.stringify(payload), "utf-8"));
}

export interface MakeCommentOptions {
  readonly id: number;
  readonly updatedAt: string;
  readonly body: string;
  readonly issueNumber?: number;
  /** Defaults to true -- most existing tests exercise the "marker posted on a PR" path,
   * matching the vendored fixtures' own `change.type: "pull_request"`. Pass false to build a
   * plain-issue comment, e.g. for the PR/issue cross-check regression test. */
  readonly isPullRequest?: boolean;
  readonly authorLogin?: string;
  readonly authorType?: RawComment["authorType"];
  readonly performedViaAppSlug?: string;
}

export function makeComment(opts: MakeCommentOptions): RawComment {
  return {
    id: opts.id,
    body: opts.body,
    updatedAt: opts.updatedAt,
    htmlUrl: `https://example.invalid/comments/${opts.id}`,
    issueNumber: opts.issueNumber ?? 1,
    isPullRequest: opts.isPullRequest ?? true,
    authorLogin: opts.authorLogin ?? "trusted-bot[bot]",
    authorType: opts.authorType ?? "Bot",
    ...(opts.performedViaAppSlug ? { performedViaAppSlug: opts.performedViaAppSlug } : {}),
  };
}
