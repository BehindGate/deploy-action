#!/usr/bin/env bash
set -euo pipefail

# Publish gitlab/ to the GitLab project that serves the CI/CD component.
#
# The component and the Action wrap the same CLI, so they move together: a new
# input, a new pinned version or a change in the CLI's contract is one review
# here rather than two in different places. GitLab is a mirror of this
# directory, which is why the copy is exact and anything else in that project
# is removed.
#
# Tags are not synced. Publishing to the catalog means creating a release from a
# tag in the GitLab project, which stays a deliberate act there.
#
#   GITLAB_TOKEN=<token with write access> script/gitlab-sync.sh
#
# GITLAB_PROJECT and GITLAB_HOST override the destination for a dry run against
# a fork.

: "${GITLAB_TOKEN:?set GITLAB_TOKEN to a GitLab token with write access}"

PROJECT="${GITLAB_PROJECT:-behindgate/ci}"
HOST="${GITLAB_HOST:-gitlab.com}"
SOURCE="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$SOURCE/gitlab" ]; then
  echo "No gitlab/ directory in $SOURCE." >&2
  exit 1
fi

# The token reaches git through a credential helper rather than the remote URL,
# so it is not written into .git/config and cannot surface in an error message
# that echoes the remote.
helper='!f() { echo username=oauth2; echo "password=$GITLAB_TOKEN"; }; f'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -c "credential.helper=$helper" clone --quiet --depth 1 \
  "https://$HOST/$PROJECT.git" "$work"

# Everything the project holds comes from gitlab/, so the copy replaces the tree
# rather than merging into it: a file dropped here is dropped there.
find "$work" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$SOURCE/gitlab/." "$work/"

cd "$work"
git add --all

if git diff --cached --quiet; then
  echo "$PROJECT is already in step with gitlab/."
  exit 0
fi

REVISION="$(git -C "$SOURCE" rev-parse HEAD)"
SUBJECT="$(git -C "$SOURCE" log -1 --format=%s)"

git -c user.name='BehindGate sync' \
    -c user.email='noreply@behindgate.com' \
    commit --quiet --message "$SUBJECT" --message "Synced from behindgate/deploy-action@$REVISION"

git -c "credential.helper=$helper" push --quiet origin HEAD:main
echo "Pushed gitlab/ to $PROJECT at $REVISION."
