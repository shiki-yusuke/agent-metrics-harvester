# Vendored from ai-agent-skills-playbook

Verbatim copy of `contracts/release-approval/v0/release-approval-event.schema.json`
(release-approval/v0). `agent-metrics-cognitive-debt` (`src/cognitive-debt/`) reads only its
`properties.kind.enum` at runtime: those values are the only `ack.by_kind` keys it writes, and
every other approval kind is counted under `other` (cognitive-debt-metrics/v0 design section
2.4; docs/cognitive-debt-decisions.md).

- Upstream repository: `ai-agent-skills-playbook`
- Upstream path: `contracts/release-approval/v0/release-approval-event.schema.json`
- Upstream commit: `d2308e2f8f1d3055509e453675932142409b053c` (the commit the cognitive-debt
  design is pinned to; the file was last changed upstream in `5eee9ef`)
- Upstream blob hash of that file at that commit: `e0859165de93c9b16d549ace374662e59e99405b`

Not copied: `fixtures/`, `verify-fixtures.mjs`, `CHANGELOG.md` (this repo does not re-verify the
release-approval contract; it only reads the `kind` enum).

Do not hand-edit anything in this directory. Re-vendor the file and update the commit / blob
hash above when upstream changes.
