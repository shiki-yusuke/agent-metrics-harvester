# agent-metrics-harvester

A reference harvester for the [`agent-metrics/v1`](https://github.com/shiki-yusuke/ai-agent-skills-playbook/blob/main/docs/protocols/agent-metrics-v1.md)
protocol: it collects AI-coding-agent token/cost telemetry that a pipeline
already posts as a hidden marker on a GitHub PR/issue comment, and turns it
into a queryable JSONL or SQLite store — without ever requiring a
developer-held credential.

This repository implements exactly one thing: the harvester side of the
protocol. The marker format, the upsert-key recipe, the trust model, and the
conformance fixtures it is tested against all live in
[`ai-agent-skills-playbook`](https://github.com/shiki-yusuke/ai-agent-skills-playbook)'s
[`docs/protocols/agent-metrics-v1.md`](https://github.com/shiki-yusuke/ai-agent-skills-playbook/blob/main/docs/protocols/agent-metrics-v1.md)
and [`contracts/agent-metrics/v1/`](https://github.com/shiki-yusuke/ai-agent-skills-playbook/tree/main/contracts/agent-metrics/v1) —
that is the normative contract; this repository vendors a copy for
conformance testing (see [`test/contract/vendor/UPSTREAM.md`](test/contract/vendor/UPSTREAM.md))
but does not redefine it.

## What it does

1. An emitter (e.g. a delivery pipeline, a review bot) posts a PR/issue
   comment that already contains a hidden HTML-comment marker:
   `<!-- agent-metrics:v1 payload_b64=... sha256=... -->`.
2. This harvester scans a repository's issue/PR comments (repo-wide, not
   PR-by-PR), decodes and independently re-verifies every marker it finds,
   authenticates the comment's actual author against an allowlist, and
   upserts the resulting token/cost record into a JSONL or SQLite store.
3. A cursor (per-repository watermark) tracks how far the harvester has
   gotten, so a scheduled run only fetches what's new since last time.

No step in this pipeline needs a developer to run a tool, hold an API key, or
remember to report anything.

## Why "harvester," not "sync" or "bot"

Nothing here writes back to GitHub, resolves anything, or acts on a PR. It
only reads comments and writes to its own store. That asymmetry is
deliberate — see the trust model below.

## Install

```bash
npm install
npm run build
```

This produces `dist/src/cli/main.js`, runnable directly with Node, plus a
`bin` entry (`agent-metrics-harvester`) if you install this package globally
or via `npx`.

## CLI usage

```bash
node dist/src/cli/main.js \
  --repo octo-org/example-repo \
  --store jsonl \
  --store-path ./data/agent-metrics-store.jsonl \
  --allowed-login "spec-lane-bot[bot]" \
  --allowed-app-slug "my-ci-app" \
  --lookback-days 30 \
  --max-api-requests 500 \
  --rate-limit-floor 200 \
  --max-runtime-seconds 240
```

| Flag | Meaning |
|---|---|
| `--repo <owner/repo>` | Repeatable. At least one required. |
| `--store <jsonl\|sqlite>` | Store backend. Default `jsonl`. |
| `--store-path <path>` | Required. File path for the store. Must not contain a `..` segment (rejected outright) -- the Action wrapper builds its actual path by concatenating this onto the state checkout's own directory, and a `..` there would escape it. Absolute paths are fine. |
| `--allowed-login <login>` / `--allowed-app-slug <slug>` | Repeatable. At least one of either is required — see [Trust model](#trust-model). |
| `--initial-since <ISO8601>` / `--lookback-days <n>` | One is required on a repository's *first* run (no checkpoint yet exists). A first run never silently full-scans a repository's entire comment history. |
| `--overlap-seconds <n>` | How far behind the last watermark to re-fetch, to tolerate clock/pagination skew. Default 300. |
| `--max-api-requests <n>` / `--rate-limit-floor <n>` / `--max-runtime-seconds <n>` | Safety valves — see below. |
| `--github-token <token>` | Defaults to `$GITHUB_TOKEN` / `$GH_TOKEN`. |
| `--github-base-url <url>` | For GitHub Enterprise Server. |
| `--max-pages-per-fetch <n>` | Caps pagination per repository per run (independent of the request/runtime valves). |

Each invocation prints a human-readable per-repository summary to `stderr`
and exactly one JSON summary line to `stdout` (consumed by the GitHub Action
wrapper — see below).

## Authentication and token scope

Section 7 of the protocol is explicit: **`sha256` in the marker is a
checksum, not a signature.** It proves a comment wasn't corrupted; it proves
nothing about who posted it. This harvester never treats a decoded payload's
own contents as proof of where it's allowed to land — trust is entirely a
transport-layer decision:

- The comment's actual author (`--allowed-login`) or the GitHub App that
  posted it (`--allowed-app-slug`) must be on an explicit allowlist. There is
  no "trust everyone" default — the CLI refuses to start without at least one
  of these configured.
- The payload's own `repository`/`change` fields are cross-checked against
  the repository/issue the comment actually appeared on. A payload claiming
  to be about a different repository or PR than the one it's attached to is
  rejected.
- The comment author is used once, for that check, and is never written to
  the store (protocol section 7 forbids it as a MUST).

**Token recommendation, in order:**

1. **GitHub App installation token** — scoped to exactly the repositories the
   app is installed on, short-lived, revocable independently of any person's
   account. Preferred.
2. **Fine-grained personal access token** — scoped to the specific
   repositories/permissions this harvester needs (`issues: read` on every
   harvested repo; `contents: write` on the state repository). Second choice.
3. **`GITHUB_TOKEN` (Actions' own default token)** covers *only* the
   repository the workflow runs in. It cannot read comments on any other
   repository, so it is unsuitable the moment `repos` names more than the
   current repository.

## GitHub Action

```yaml
name: agent-metrics-harvest
on:
  schedule:
    - cron: "17 */4 * * *"   # every 4 hours -- see "Scheduling" below
  workflow_dispatch: {}

concurrency:
  group: agent-metrics-harvest
  cancel-in-progress: false   # let an in-flight run finish; never overlap two writers

jobs:
  harvest:
    runs-on: ubuntu-latest
    steps:
      - uses: shiki-yusuke/agent-metrics-harvester@v1
        with:
          repos: |
            octo-org/example-repo
            octo-org/another-repo
          allowed-app-slugs: |
            my-ci-app
          lookback-days: "30"   # first run only; subsequent runs use the stored cursor
          github-token: ${{ secrets.HARVESTER_TOKEN }}
```

The action is a thin wrapper: it checks out the state branch, builds and
runs the CLI (all collection/accept/reject logic lives there, not in this
YAML), and commits the state branch back — **only if something changed**. See
[`action/action.yml`](action/action.yml) and the scripts next to it.

### Scheduling

A schedule on the order of a few hours, plus `workflow_dispatch` for
on-demand runs, is the supported pattern. This harvester does not offer
sub-minute scheduling — GitHub Actions' own `schedule` trigger doesn't
guarantee minute-level precision either, and a harvester polling that
aggressively is solving a freshness problem this protocol was never designed
to promise (it is a scheduled-harvester pattern, not a webhook).

### State branch

The store and its cursor live together on a dedicated **orphan branch**
(`agent-metrics-state` by default), never on the repository's default
branch. This keeps a JSONL/SQLite data file out of the codebase's normal
history and diff noise entirely. Concretely:

- The state branch holds *only* the store file (plus a README the action
  itself writes on first run). It has its own linear commit history,
  disconnected from the default branch's.
- **SQLite's binary file is never committed.** If you pass `--store sqlite`,
  point `store-path` somewhere the Action's own workflow treats as a
  throwaway working file, not the state branch — the state branch pattern
  above is built and tested for the JSONL backend; SQLite is intended for
  local use and for a future always-on runner process, not for a
  git-committed artifact (see [CHANGELOG](CHANGELOG.md)).
- The Action's `concurrency` group (set in *your* calling workflow — the
  action wrapper cannot set this on your behalf) ensures a single writer at a
  time. `commitBatch` (see [Architecture](#architecture)) also enforces this
  defensively at the store layer: a stale expected-checkpoint is rejected
  even if two writers somehow ran concurrently anyway.
- Store and cursor are written together in one `commitBatch` call and
  committed to the state branch as one git commit — there is no way for the
  action to observe "cursor advanced, but the corresponding data didn't
  land," in git history or inside the store file itself.

### Private repositories

If any repository in `repos` is private, put the state branch in a
**dedicated private repository** via the `state-repository` input, rather
than the (possibly public) repository being harvested. The harvester's own
token-scope guidance above already narrows what the token can read; this is
the equivalent narrowing for what can read the *harvested data* back out.

### Cost/traffic-limiting safety valves

A harvester that fetched an entire repository's comment history on every
run, or retried a rate-limited request forever, would be its own outage. All
of the following exist to bound one run, not to be tuned for peak
performance:

- **`--max-api-requests`**: hard stop after this many GitHub API requests,
  mid-pagination if necessary. The comments already fetched are still
  processed and committed; the next run picks up where this one left off.
- **`--rate-limit-floor`**: stop once GitHub's `x-ratelimit-remaining` header
  reaches this value, leaving headroom for anything else sharing the same
  token's rate limit budget.
- **`--max-runtime-seconds`**: hard wall-clock stop, independent of the
  above.
- **403 (secondary rate limit) / 429**: bounded exponential backoff (default
  5 attempts); once exhausted, the run stops cleanly rather than retrying
  forever.
- **`since` + overlap, not a full scan**: every run after the first fetches
  only `watermark − overlap` onward (`--overlap-seconds`, default 300s) —
  never the whole comment history. A first run requires an explicit
  `--initial-since`/`--lookback-days` bound for the same reason.
- **Per-URL ETag**: an unchanged comment page short-circuits to a 304 with
  zero further processing.
- **Per-`(repository, commentId, verified sha)` skip**: a comment already
  fully processed in a previous run (even one refetched again by the overlap
  window) is skipped without re-parsing or re-validating it.

None of these are cleverness for its own sake — each one is here because
omitting it turns "poll a few PRs every few hours" into either an outage risk
or an unbounded bill.

## Architecture

```
src/
  protocol/      marker decode, sha256/base64 verification, RFC 8785 JCS
                  upsert_key recomputation, schema validation, personal-
                  dimension scan -- pure functions, no I/O.
  application/    per-repository harvest orchestration: fetch -> decode ->
                  trust-check -> Goodhart re-check -> one atomic commit.
                  Safety valves and correction ordering live here too.
  sources/github/ repo-wide issue-comments client (plain fetch, ETag,
                  bounded 403/429 backoff) and the CommentSource adapter.
  stores/jsonl/   append-only JSONL journal; commitBatch = snapshot+cursor
                  lines followed by one checkpoint line, replayed on load
                  with any incomplete trailing batch discarded.
  stores/sqlite/  the same Store interface via better-sqlite3; commitBatch =
                  one transaction (checkpoint CAS check + upserts + cursor
                  advance), rolled back atomically on any failure.
  cli/            argument parsing and wiring -- no protocol/store logic of
                  its own.
action/           GitHub Action wrapper: checkout/state-restore -> CLI ->
                  commit, and nothing else.
test/contract/    conformance against the vendored agent-metrics/v1 fixtures.
test/unit/        crash injection (both stores), store parity (JSONL vs
                  SQLite under an identical operation sequence), and the
                  harvest orchestration's own accept/reject/skip paths.
test/e2e/         offline end-to-end: a fake, network-free GitHub source
                  serving real vendored fixture markers through the real
                  orchestration into both real store backends.
```

The `Store` interface is deliberately four operations, no more:

```ts
readCheckpoint(source)
hasSeenMarker(repository, commentId, markerSha)
readSnapshot(upsertKey)
commitBatch(expectedCheckpoint, nextCheckpoint, snapshots, rejections)
```

`commitBatch` is the one write path, and it is one atomic unit: a store
implementation can never observably advance its cursor without the
corresponding snapshots (and vice versa) having actually landed. See
`test/unit/*-crash-injection.test.ts` for the property this guarantees and
how each backend proves it.

## v1 scope

Not in this repository (see [`CHANGELOG.md`](CHANGELOG.md) for what's
tracked for later): Notion/webhook/GitLab sources, any dashboard, cross-run
aggregation/re-pricing, or a Claude/Codex/launchd-specific scheduler. The
core CLI is deliberately scheduler-agnostic — it takes flags and runs once —
so that a future always-on runner can drive it without a rewrite.

## Development

```bash
npm install
npm run build       # tsc + copy test fixture assets into dist/
npm run typecheck
npm run lint         # biome check .
npm test             # contract + unit + e2e
npm run test:contract
npm run test:unit
npm run test:e2e
```

## License

[MIT](LICENSE)
