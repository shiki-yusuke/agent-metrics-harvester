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

### Deferred to a later version (see README "v1 scope")

- Notion / webhook / GitLab sources, any dashboard, cross-run
  aggregation or re-pricing, and a Claude/Codex/launchd-specific scheduler.
  The core CLI is kept scheduler-agnostic specifically so none of these
  require rewriting it.
