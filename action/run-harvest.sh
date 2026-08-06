#!/usr/bin/env bash
# Builds the CLI argument list from this action's inputs (passed in as env vars) and invokes
# the already-built harvester CLI once. All accept/reject/store decisions happen inside the
# CLI (src/cli, src/application, src/protocol) -- this script only translates Action inputs
# into CLI flags and relays the CLI's JSON summary line into $GITHUB_OUTPUT.
set -euo pipefail
: "${GITHUB_ACTION_PATH:?}" "${STATE_DIR:?}" "${REPOS:?}" "${STORE_KIND:?}" "${STORE_PATH:?}"

ARGS=(--store "$STORE_KIND" --store-path "${STATE_DIR}/${STORE_PATH}")

while IFS= read -r repo; do
  [ -n "$repo" ] && ARGS+=(--repo "$repo")
done <<< "$REPOS"

while IFS= read -r login; do
  [ -n "$login" ] && ARGS+=(--allowed-login "$login")
done <<< "${ALLOWED_LOGINS:-}"

while IFS= read -r slug; do
  [ -n "$slug" ] && ARGS+=(--allowed-app-slug "$slug")
done <<< "${ALLOWED_APP_SLUGS:-}"

[ -n "${INITIAL_SINCE:-}" ] && ARGS+=(--initial-since "$INITIAL_SINCE")
[ -n "${LOOKBACK_DAYS:-}" ] && ARGS+=(--lookback-days "$LOOKBACK_DAYS")
[ -n "${MAX_API_REQUESTS:-}" ] && ARGS+=(--max-api-requests "$MAX_API_REQUESTS")
[ -n "${RATE_LIMIT_FLOOR:-}" ] && ARGS+=(--rate-limit-floor "$RATE_LIMIT_FLOOR")
[ -n "${MAX_RUNTIME_SECONDS:-}" ] && ARGS+=(--max-runtime-seconds "$MAX_RUNTIME_SECONDS")

echo "agent-metrics-harvester: node ${GITHUB_ACTION_PATH}/dist/src/cli/main.js ${ARGS[*]}"

# Deliberately never fails this step, even if the CLI reports per-repository errors: state
# already accepted by one repository in this run must still be committed (spec: "1 repo の
# 失敗が他 repo を巻き戻さない") before the action's overall pass/fail is decided. The final
# "Fail if harvester reported errors" step, which runs *after* the commit step below, is what
# actually fails the run when `errors` is non-empty.
set +e
OUTPUT="$(node "${GITHUB_ACTION_PATH}/dist/src/cli/main.js" "${ARGS[@]}")"
CLI_EXIT_CODE=$?
set -e

echo "$OUTPUT"
SUMMARY_LINE="$(echo "$OUTPUT" | tail -n 1)"

CHANGED="$(node -e '
  const line = process.argv[1];
  try {
    const summary = JSON.parse(line);
    process.stdout.write(summary.changed ? "true" : "false");
  } catch {
    process.stdout.write("false");
  }
' "$SUMMARY_LINE")"
HAS_ERRORS="$(node -e '
  const line = process.argv[1];
  try {
    const summary = JSON.parse(line);
    process.stdout.write(Object.keys(summary.errors ?? {}).length > 0 ? "true" : "false");
  } catch {
    process.stdout.write("true"); // an unparseable summary line is itself an error condition
  }
' "$SUMMARY_LINE")"

{
  echo "changed=${CHANGED}"
  echo "has-errors=${HAS_ERRORS}"
  echo "cli-exit-code=${CLI_EXIT_CODE}"
} >> "$GITHUB_OUTPUT"
