# Changelog

All notable changes to this project are documented in this file. Nothing
below has been published to a registry or tagged in git yet -- version
numbers here track the package's own `version` field, not a release.

## [Unreleased]

### Considered, not done

- **Split `HARVESTER_TOKEN` into a read-only cross-repo token and a
  write-only same-repo token.** `dashboard.yml`'s harvest step currently
  uses one token scoped to both "read `WATCHED_REPOS`" and "write this
  repo's `metrics-data` branch" (see README's [Dashboard
  section](README.md#dashboard)). Two separate, even-more-narrowly-scoped
  tokens would shrink each one's blast radius further; not done in 0.3.0.

## [0.3.0]

### Added

- **M1 dashboard: `agent-metrics-dashboard`, `scripts/push-aggregate.mjs`,
  and `.github/workflows/dashboard.yml`.** A static, zero-dependency HTML
  dashboard (five panels: cost, forecast calibration, attribution,
  freshness, model cohort) generated from this repository's own
  `metrics-data` branch and deployed to GitHub Pages on a daily schedule.
  See the README's new [Dashboard](README.md#dashboard) section for the
  data-flow diagram, the sanitized-by-construction policy, the
  `HEALTHCHECK_URL`/`HARVESTER_TOKEN` secrets, and the one-time manual
  Pages-enablement step.
  - `src/aggregates/` (new): the aggregates/v0 line schema (`kind:
    attribution_audit_summary | calibration_point | heartbeat`) and its
    validation/projection (`projectAggregateRecord` -- rejects a forbidden
    personal-dimension key, drops any field the target `kind` doesn't
    recognize) plus a git-subprocess append helper
    (`appendAggregateLine`) that creates the target branch as an orphan on
    first use. Not itself a protocol/v1 contract change -- a v0, internal,
    not-yet-frozen format.
  - `scripts/push-aggregate.mjs` (new): a thin, uncompiled CLI wrapper
    around the above -- validates a local observation (a lane
    attribution-audit summary or calibration point) and appends it to
    `aggregates/YYYY-MM.jsonl` on the `metrics-data` branch, or rejects it
    outright without touching git at all. Coupled to lane only via this
    file/CLI boundary, never an import.
  - `src/dashboard/` (new): reads current snapshots via the same
    `SnapshotReader` `agent-metrics-report` uses (plus a new,
    dashboard-scoped `AllRepositoriesReader` that discovers every
    repository in the store, since the dashboard CLI takes no `--repo`
    flag) and the aggregates directory, computes a pure `DashboardData`
    domain object, and renders one self-contained HTML file -- CSS bars
    instead of a chart library, no CDN, light/dark via
    `prefers-color-scheme`, every table wrapped for horizontal scroll.
    Every panel carries N, a missing-rate (`null`, never a fabricated
    zero, when there is nothing to measure), and `quality_status:
    "not_measured"`. No causal claims: the model-cohort panel always
    carries a fixed non-comparability caveat, and forecast calibration
    reports `insufficient_data` rather than computing a confidence
    interval below the sample floor (M1 DoD). The freshness panel keeps
    "the pipeline stopped running" (`pipeline_heartbeat_at`) independent
    of "the pipeline ran but found nothing new" (`last_valid_event_at`),
    compared against the viewer's own clock by a small inline script at
    view time -- the generator itself stays byte-identical for fixed
    inputs and a fixed `--now`.
  - `.github/workflows/dashboard.yml` (new): daily schedule +
    `workflow_dispatch`, every third-party action pinned to a commit SHA,
    reuses the root `action.yml` unmodified for the harvest step. Two
    guards against a silent empty success: the watched-repo list must be
    non-empty, and the generated HTML must actually contain all 5 panel
    sections. A dead-man ping (`HEALTHCHECK_URL`) fires only after a full
    success; its absence as a configured secret only warns, never fails
    the run.

## [0.2.1]

### Fixed

- **Harvest CLI numeric flags now fail closed on a bad value instead of
  silently disabling the safety valve (G5).** `src/cli/args.ts`'s
  `--lookback-days` / `--overlap-seconds` / `--max-api-requests` /
  `--rate-limit-floor` / `--max-runtime-seconds` / `--max-pages-per-fetch`
  previously ran straight through `Number.parseInt`, which turns a typo'd
  value like `"abc"` into `NaN` rather than throwing. A `NaN` `maxApiRequests`
  reached `SafetyValve` untouched: every comparison against `NaN`
  (`this.requestCount + pendingRequests >= this.opts.maxApiRequests`) is
  `false`, so the valve never tripped and the run's request/runtime budget
  was silently unenforced (fail-open) instead of the CLI rejecting the
  invocation. The `agent-metrics-report cost-per-pr` binary already guarded
  its own equivalent flags this way (`parseNonNegativeInt` in
  `src/cli/report-args.ts`, added in 0.2.0) but the fix was never carried
  back to the harvest CLI.
  - `src/cli/numeric-flag.ts` (new): the shared validator
    (`parseNonNegativeIntFlag`), extracted out of `report-args.ts` so both
    binaries' argument parsers call one implementation instead of
    maintaining two copies of the same regex/range check. Rejects
    non-integer strings, `NaN`, negative values, decimals (e.g. `""`,
    `"abc"`, `"-1"`, `"1.5"`, `"+5"`, `"5e2"`, `"Infinity"`), and any digit
    string past `Number.MAX_SAFE_INTEGER` (e.g. `"9007199254740993"`) --
    `Number.parseInt` silently rounds a value that large to the nearest
    representable double rather than throwing, so a regex-plus-`isFinite`
    check alone (the validator's first cut) still let a mistyped huge value
    through as a different number than the one the user typed; the
    `Number.isSafeInteger` check catches that. Accepts `0`, any
    non-negative safe integer, and leading-zero digit strings (e.g. `"007"`
    parses as `7`, matching `Number.parseInt`'s own behavior).
    Each call site still throws its own error type (`CliArgError` for the
    harvest CLI, `ReportArgError` for the report CLI) via a constructor
    parameter, so `main.ts`'s existing exit-code-2 handling for argument
    errors is unchanged.
  - `src/cli/args.ts` / `src/cli/report-args.ts`: all numeric flags in both
    parsers now route through `parseNonNegativeIntFlag`.
  - Composite Action inputs (`action.yml`'s `lookback-days`,
    `max-api-requests`, `rate-limit-floor`, `max-runtime-seconds`) are
    forwarded to the same `--flag value` CLI arguments by
    `action/run-harvest.sh`, so a bad Action input now makes the CLI exit 2;
    `run-harvest.sh`'s existing `has-errors` output (set when the CLI's
    JSON summary line is missing or unparseable) and the workflow's "Fail
    if the harvester reported per-repository errors" step already turn
    that into a failed job with no further changes needed.
    `test/e2e/action-run-harvest.test.ts` (new) spawns the real
    `run-harvest.sh` with a bad `MAX_API_REQUESTS` and asserts its
    `$GITHUB_OUTPUT` carries `cli-exit-code=2`/`has-errors=true` end to
    end. `--overlap-seconds` and `--max-pages-per-fetch` are CLI-only
    flags with no corresponding Action input.
  - `test/unit/cli-args.test.ts`, `test/unit/report-args.test.ts`,
    `test/unit/numeric-flag.test.ts` (new): regression coverage for all
    six harvest-CLI numeric flags and the report CLI's four (rejects
    `"abc"` / `"-1"` / `"1.5"` / `""` / `"+5"` / `"5e2"` / `"Infinity"` /
    a value past `Number.MAX_SAFE_INTEGER`, accepts `0`, a positive
    integer, `Number.MAX_SAFE_INTEGER` itself, and leading-zero digit
    strings), plus direct unit tests of the shared validator and an
    exact-match check on the report CLI's error-message wording.

## [0.2.0]

### Added

- **`agent-metrics-report` (new binary): `cost-per-pr` command.** A
  read-only cost-per-merged-PR report over the same JSONL/SQLite store the
  `agent-metrics-harvester` binary writes -- the harvest CLI, the 4-operation
  `Store` interface, and the Action wrapper are all unchanged by this
  addition (see `src/report/snapshot-reader.ts`: a separate, additive,
  read-only `SnapshotReader` capability, not a 5th `Store` operation).
  - `src/stores/jsonl/journal.ts` / `src/stores/sqlite/mapping.ts`: the
    harvest CLI's own journal-replay and row-mapping logic, extracted into
    pure functions (behavior-preserving refactor -- existing harvest tests
    pass unmodified) so `JsonlSnapshotReader`/`SqliteSnapshotReader` reuse
    the exact same "never aggregate an incomplete tail" guarantee rather
    than maintaining a second copy of it.
  - `src/report/period.ts`: IANA-timezone month/ISO-week resolution as a
    half-open `[start, end)` interval, with no date library dependency.
  - `src/report/team-config.ts`: a versioned, hand-rolled parser for a
    fixed two-level `version`/`teams[].name`/`teams[].repositories[]`
    shape (see "Deviations" below -- this is not a general YAML parser).
  - `src/report/pr-metadata/`: a report-owned sidecar cache of merged-PR
    metadata (`repository`, `pr_number`, `opened_at`, `merged_at`, `state`,
    `github_updated_at`, `fetched_at` only), filled by bulk (never
    per-PR/N+1) GitHub Search queries that bisect any window reporting
    more than 1000 total results (Search API's hard per-query cap), and
    fail closed (mark the whole result incomplete) on `incomplete_results`,
    a safety-valve stop, or an unsplittable oversized window.
  - `src/report/cost-per-pr.ts`: the core metric. Denominator (unique
    merged `(repository, pr_number)` count) and numerator (sum of
    `priced` records' `estimated_cost_usd` whose *own* `generated_at`
    falls in period) are independent data sources on independent time
    checks, so a merged PR with no snapshot still counts in the
    denominator, and a PR-unlinked/open-PR-linked/different-period-merged
    snapshot's cost still counts in the numerator. Missing data
    (unpriced/unknown/`priced`-without-cost/partial coverage) is never
    folded into a clean $0 -- it nulls the exact
    `estimated_cost_per_merged_pr_usd` and surfaces a lower bound instead,
    alongside a `status` in `{ok_observed, partial_cost, no_telemetry,
    metadata_incomplete, insufficient_sample, zero_denominator}` and the
    full honesty-fields breakdown from spec §5 (coverage counts,
    linked/unlinked cost split, pricing-status/token breakdown,
    `quality_status: "not_measured"`, a deterministic `input_fingerprint`,
    ...).
  - `src/report/comparison.ts`: a pure A/B combination of two already-
    computed results -- sign-normalized improvement percentages, a
    versioned comparison policy, and a hard compatibility guard (same
    timezone/bucket-kind/repository-set/team-config-hash, else an error,
    never a misleading number).
  - `src/report/render/{json,markdown}.ts`: both read the same domain
    result, so the two formats can never disagree; Markdown always shows
    sample size, coverage, and the metadata as-of timestamp, and a
    rendered comparison always ends with the two fixed disclaimer
    sentences verbatim (never a "quality maintained" claim -- quality is
    simply not measured in v1).
  - `src/cli/report-args.ts` / `report-command.ts` / `report-main.ts`: the
    `agent-metrics-report cost-per-pr` CLI itself.
  - `src/cli/path-safety.ts`: the harvest CLI's `--store-path` `..`-segment
    guard, extracted into a shared module so `--store-path` and
    `--metadata-cache` in both binaries enforce the same rule (pure
    refactor of the harvest CLI's own args.ts; its error type/messages at
    the call site, and its existing tests, are unchanged).

  Deviations from the literal spec text (reported to team-lead):
  - The spec calls the team-config file "yaml", but this project's
    dependency policy allows no runtime dependency beyond `better-sqlite3`.
    `team-config.ts` implements only the fixed shape a team config actually
    needs, not general YAML, and rejects anything else outright rather than
    silently redefining the format as JSON.
  - `--team-config` supports more than one team per file (spec §6's "1 repo
    の複数 team 所属は拒否" implies a shared, multi-team file); a `--team
    <name>` flag (not in the spec's literal §1 CLI listing) selects one when
    a config defines more than one, auto-selecting when there is exactly
    one.
  - `--month`/`--week` name the period being *evaluated* ("period B" in
    comparison terms); `--compare-month`/`--compare-week` name the earlier
    *baseline* ("period A") -- i.e. "how did July do, compared to June."
    The spec's §1 CLI sketch does not state this ordering explicitly.

## [0.1.0]

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
