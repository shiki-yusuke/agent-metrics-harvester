#!/usr/bin/env bash
# Commits and pushes STATE_DIR back to STATE_BRANCH -- but only if something actually changed.
# The store file and its cursor were written together by the CLI's single commitBatch call
# per repository, so whatever is on disk here is already a consistent snapshot; this script's
# only job is "did anything change at all" and, if so, one git commit + push.
set -euo pipefail
: "${STATE_DIR:?}" "${STATE_BRANCH:?}"

cd "$STATE_DIR"

if [ -z "$(git status --porcelain)" ]; then
  echo "agent-metrics-harvester: no changes to commit"
  exit 0
fi

git add -A
git -c user.name="agent-metrics-harvester" -c user.email="actions@users.noreply.github.com" \
  commit -m "agent-metrics-harvester: update store ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
git push origin "HEAD:${STATE_BRANCH}"
