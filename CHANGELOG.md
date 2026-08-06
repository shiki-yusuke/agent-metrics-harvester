# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- `src/protocol`: marker framing decode, sha256/base64 verification, RFC 8785
  JCS `upsert_key` recomputation, hand-written schema validation mirroring
  the vendored `agent-metrics/v1` JSON Schemas, and the personal-dimension
  scan (protocol doc section 7).
- `src/application`: per-repository harvest orchestration (`harvestRepository`
  / `harvestAll`) with per-repo failure isolation, GitHub-order (`updated_at`,
  `id`) correction conflict resolution, a bounded `SafetyValve` (max API
  requests / rate-limit floor / max runtime), and the trust-model checks
  (author allowlist, repository/change cross-check, a second independent
  Goodhart re-check before storage).
- `src/sources/github`: repo-wide issue-comments client (plain `fetch`,
  per-URL ETag, bounded 403/429 backoff) and its `CommentSource` adapter.
- `src/stores/jsonl` and `src/stores/sqlite`: two `Store` implementations
  sharing one four-operation interface, each proving "cursor never advances
  ahead of a successful commit" by a backend-appropriate mechanism (JSONL:
  checkpoint-line-terminated batches, replayed with any incomplete tail
  discarded; SQLite: a single `better-sqlite3` transaction).
- `src/cli`: a zero-dependency `harvest` command.
- `action/`: a composite GitHub Action wrapper (checkout/state-restore ->
  CLI -> commit-if-changed) using a dedicated orphan state branch.
- `test/contract`: vendors `ai-agent-skills-playbook`'s
  `contracts/agent-metrics/v1/` (commit `d99e48057a98af80871d00ace90f2ca18ae78eba`)
  and independently re-derives every fixture's accept/reject/ignore verdict,
  cross-checked against the vendored reference oracle.
- `test/unit`: crash injection for both stores, JSONL/SQLite result parity
  under an identical operation sequence, and harvest-orchestration coverage
  (accept/reject/skip-already-seen/304-short-circuit/pre-tripped-safety-valve).
- `test/e2e`: an offline, network-free end-to-end test driving a fake GitHub
  source that serves real vendored fixture markers through the real
  orchestration into both real store backends.

### Fixed

Findings from a Codex (gpt-5.4) implementation review, all accepted:

- **(must)** A page-1 ETag/304 short-circuit is only a safe "nothing changed"
  signal when page 1 is the entire result. With `sort=updated&direction=asc`,
  a new comment always lands on the *last* page, so once a query spans more
  than one page, page 1's bytes (and its ETag) can stay identical forever
  while new data keeps arriving on later pages a page-1-only 304 would never
  reach -- permanently, since the checkpoint would never advance either.
  `GithubCommentSource` now never caches/returns an etag derived from a
  multi-page fetch (`src/sources/github/comments-source.ts`).
- **(must)** The `SafetyValve` budget (`--max-api-requests`, `--rate-limit-
  floor`) is now consulted, with a live per-page-accurate count, *during* a
  repository's own pagination loop (`SafetyValve.previewCheck`), not only
  once before the loop starts and once after it has already finished -- a
  single large-backlog repository could previously exhaust the entire
  request budget within one `fetchComments` call before the valve ever saw
  it.
- **(must)** A maliciously deeply nested comment body (thousands of levels
  of `{"a":{"a":...}}`) used to crash the process with a stack overflow --
  thrown from the (previously recursive) depth check and personal-dimension
  walker, running unguarded before the trust check, on any public repository
  where anyone can post a comment. Because nothing wrapped an individual
  comment in the batch loop, this took the whole batch down, not just the
  hostile comment, and recurred on every run via the overlap window. Both
  walkers (`src/protocol/limits.ts`, `src/protocol/personal-dimension.ts`)
  are now iterative, and `decode.ts`'s `checkPayload` runs the (now
  crash-safe) depth check first, rejecting `payload_too_deep` outright
  before either walker ever sees a too-deep structure.
- **(must)** The repository/change cross-check verified `repository.id` and
  `change.number` but not whether the comment actually appeared on a pull
  request -- since a repo-wide issue-comments query returns comments on
  plain issues and PRs indiscriminately, and issue/PR numbers share one
  namespace, a marker posted on issue #42 claiming `change.type:
  "pull_request", number: 42` used to pass. `RawComment` now carries
  `isPullRequest` (derived from the comment's own `html_url`), and
  `crossCheckRepositoryAndChange` rejects a `pull_request`-claiming payload
  whose comment was not actually on one (`change_type_mismatch`).
- **(should)** `--store-path` now rejects any `..` path segment -- the Action
  wrapper concatenates this onto the state checkout's own directory
  (`action/run-harvest.sh`), and a `..` there could write outside it.
  Absolute paths remain allowed (not a traversal, an explicit choice).
- **(should)** The Action's `changed` output (and the CLI's JSON summary
  `changed` field) now reflects whether `commitBatch` actually ran for at
  least one repository -- matching the "Commit and push state" step's own
  `git status --porcelain` check -- rather than summing `accepted +
  rejected`, which reported `false` for a real commit made only of
  already-seen comments (cursor re-advancing) or a bare ETag refresh.
  `HarvestRepositoryResult` gained an explicit `changed: boolean` field.

### Deferred to a later version (see README "v1 scope")

- Notion / webhook / GitLab sources, any dashboard, cross-run
  aggregation or re-pricing, and a Claude/Codex/launchd-specific scheduler.
  The core CLI is kept scheduler-agnostic specifically so none of these
  require rewriting it.
