# Vendored from ai-agent-skills-playbook

This directory is a verbatim copy of `contracts/agent-metrics/v1/` from the
`ai-agent-skills-playbook` repository — the normative protocol contract this
harvester conforms to.

- Upstream repository: `ai-agent-skills-playbook`
- Upstream path: `contracts/agent-metrics/v1/`
- Upstream commit: `e60ed28c472df6eea5b6b9be5c37aae83cb6d02b` (the `main` commit whose
  `contracts/agent-metrics/v1/` tree is exactly the hash below; the previously recorded
  `d99e480` was a pre-merge commit that is not reachable from upstream `main`, re-identified
  by tree hash on 2026-10-19 -- the vendored files are unchanged)
- Upstream tree hash of that path at that commit: `6e228bcbad62ef0e499e3bec54299192d730d1a0`
- Protocol document: `docs/protocols/agent-metrics-v1.md` at the same commit.

`verify-fixtures.mjs` in this directory is the upstream reference checker (zero
dependencies, schema + JCS + personal-dimension logic re-implemented inline).
It is kept here unmodified as a second, independent oracle: `test/contract/*.test.ts`
in this repository re-derives the same accept/reject verdicts using this
repository's own production `src/protocol/*` code, and both must agree with
`fixtures/expected-results.json`.

Do not hand-edit anything in this directory. If the protocol changes upstream,
re-vendor the whole directory and update the commit/tree hash above.
