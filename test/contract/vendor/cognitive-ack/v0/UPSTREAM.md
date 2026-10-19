# Vendored from ai-agent-skills-playbook

Verbatim copy of `contracts/cognitive-ack/v0/cognitive-ack-record.schema.json` and
`contracts/cognitive-ack/v0/fixtures/` (cognitive-ack/v0, DRAFT, authority none). The fixtures
are the F2 composites (`approval_events[]` + `ack_records[]`) that
`agent-metrics-cognitive-debt` reads via `--ack`.

- Upstream repository: `ai-agent-skills-playbook`
- Upstream path: `contracts/cognitive-ack/v0/`
- Upstream commit: `d2308e2f8f1d3055509e453675932142409b053c`
- Upstream tree hash of that path at that commit: `ddc720b05916d3b2adefcfe7dd04071b75f5c1a7`
- Design document: `docs/protocols/cognitive-debt-metrics-v0.md` at the same commit.

Not copied: `verify-fixtures.mjs` / `verify-fixtures.test.mjs` / `CHANGELOG.md` (this repo does
not re-verify the ack contract; it only reads the composites).

Do not hand-edit anything in this directory. Re-vendor the whole directory and update the
commit/tree hash above when upstream changes.
