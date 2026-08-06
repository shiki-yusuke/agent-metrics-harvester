#!/usr/bin/env bash
# Checks out STATE_BRANCH of STATE_REPOSITORY into STATE_DIR, initializing it as an orphan
# branch if it doesn't exist yet (first run). This is checkout/state-restore mechanics only --
# no marker/accept/reject logic lives in this script (spec: "action/ ... collection logic を
# YAML に書かない" applies to the whole action wrapper, scripts included).
set -euo pipefail
: "${STATE_DIR:?}" "${STATE_REPOSITORY:?}" "${STATE_BRANCH:?}" "${GITHUB_TOKEN:?}"

REMOTE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${STATE_REPOSITORY}.git"

rm -rf "$STATE_DIR"

if git ls-remote --exit-code --heads "$REMOTE_URL" "$STATE_BRANCH" >/dev/null 2>&1; then
  git clone --branch "$STATE_BRANCH" --single-branch --depth 1 "$REMOTE_URL" "$STATE_DIR"
else
  echo "state branch '$STATE_BRANCH' does not exist yet on $STATE_REPOSITORY -- initializing it as an orphan branch"
  git clone --depth 1 "$REMOTE_URL" "$STATE_DIR"
  (
    cd "$STATE_DIR"
    git checkout --orphan "$STATE_BRANCH"
    git rm -rf . >/dev/null 2>&1 || true
    cat > README.md <<'EOF'
# agent-metrics-harvester state branch

This branch holds only the harvester's store file and the commit history for
it (one commit per run that produced a change). It is maintained exclusively
by the agent-metrics-harvester GitHub Action -- do not edit it by hand.
EOF
    git add README.md
    git -c user.name="agent-metrics-harvester" -c user.email="actions@users.noreply.github.com" \
      commit -m "Initialize agent-metrics-harvester state branch"
  )
fi
