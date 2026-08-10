#!/bin/sh
# The body of the GitLab CI/CD component's job.
#
# Kept as a real shell file rather than as YAML so it can be linted with `sh -n`
# and driven directly by test/integration/gitlab-deploy.test.js.
# script/build-gitlab-template.js splices it into templates/deploy.yml, which is
# the artifact GitLab actually consumes; CI fails if the two drift.
#
# POSIX sh only -- the default image is Alpine, which has no bash. No arrays, no
# [[ ]], no pipefail.
#
# Reads from the environment:
#   BEHINDGATE_TOKEN      the deploy token, as a masked CI/CD variable
#   BG_PATH               the folder (or .zip) to deploy
#   BG_URL                the pinned deploy endpoint, or empty
#   BG_CLI_VERSION        a pinned CLI version, or empty for the default
#   BG_DOWNLOAD_BASE_URL  the CLI download host, or empty for the default
#
# Writes behindgate.env, which the job publishes as a dotenv report.

set -eu

bg_fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

echo "--- BehindGate deploy: preflight"

# An unset CI/CD variable expands to an empty string rather than failing the
# pipeline, so this is by far the most common way the job goes wrong.
if [ -z "${BEHINDGATE_TOKEN:-}" ]; then
  bg_fail \
    'BEHINDGATE_TOKEN is empty.' \
    '' \
    'A CI/CD variable that is not set expands to an empty string rather than' \
    'failing the pipeline, so this usually means the variable is missing, or' \
    'that it is marked "Protected" while this pipeline runs on an unprotected' \
    'branch or tag.' \
    '' \
    'Add it under Settings -> CI/CD -> Variables as a masked variable. Never' \
    'pass the token as a component input: inputs are plainly visible in the' \
    'fully expanded pipeline configuration.'
fi

# The CLI exits 2 for a malformed token, which is also how it reports a bad path
# and an endpoint mismatch. Checking the shape here separates a mangled variable
# from a genuine deploy failure. The value is never echoed -- only a count and a
# character class are derived from it.
bg_dots=$(printf '%s' "$BEHINDGATE_TOKEN" | tr -cd '.' | wc -c | tr -d ' ')
bg_stray=$(printf '%s' "$BEHINDGATE_TOKEN" | tr -d 'A-Za-z0-9_.-' | wc -c | tr -d ' ')
case "$BEHINDGATE_TOKEN" in
  .* | *. | *..*) bg_dots=0 ;;
esac
if [ "$bg_dots" != "2" ] || [ "$bg_stray" != "0" ]; then
  bg_fail \
    'BEHINDGATE_TOKEN is not a well-formed JWT.' \
    '' \
    'A BehindGate deploy token has three base64url segments separated by dots' \
    '(header.payload.signature). The value supplied does not, which usually' \
    'means it was truncated, wrapped across lines, or quoted when it was stored' \
    'as a CI/CD variable.' \
    '' \
    'Re-copy it from the workspace dashboard under Settings -> Deploy tokens.'
fi

BG_PATH="${BG_PATH:-}"
BG_URL="${BG_URL:-}"

if [ -z "$BG_PATH" ]; then
  bg_fail 'The `path` input is empty. It must name the folder to deploy, or an existing .zip.'
fi

# Checked before the CLI runs, because the CLI validates the token first and
# would report a bad path with the same exit code as a bad token.
if [ ! -e "$BG_PATH" ]; then
  bg_fail \
    "The \`path\` input ($BG_PATH) does not exist in the job workspace." \
    '' \
    'It must name the folder to deploy, or an existing .zip. If an earlier job' \
    'produces it, make sure this job runs in a later stage and that the earlier' \
    'job publishes it with `artifacts:paths:`.'
fi

if [ -z "$BG_URL" ]; then
  echo "WARNING: no \`url\` input set, so the deploy endpoint comes from the token itself." >&2
  echo "WARNING: a token is both a credential and a routing instruction: anyone who can" >&2
  echo "WARNING: change BEHINDGATE_TOKEN can redirect this upload while the job still" >&2
  echo "WARNING: reports success. Pin the endpoint with \`url:\` and the CLI refuses to" >&2
  echo "WARNING: deploy if a token turns up claiming a different one." >&2
fi

echo "--- BehindGate deploy: acquiring the CLI"

# >>> BEGIN generated from versions.json by script/build-gitlab-template.js
BG_DEFAULT_VERSION='2026.8.3'
BG_DEFAULT_BASE_URL='https://app.behindgate.com'
BG_PINNED_VERSIONS='2026.8.3'

# Prints "<archive> <binary> <sha256>" for a version/platform pair.
bg_pin() {
  case "$1/$2" in
    '2026.8.3/linux-amd64') printf '%s %s %s\n' 'bg-deploy-linux-amd64.tar.gz' 'bg-deploy' 'c68fbc53c21d42eb7628d2dc6aaf65683033ada12e2ace15976d83e52c4645f9' ;;
    '2026.8.3/linux-arm64') printf '%s %s %s\n' 'bg-deploy-linux-arm64.tar.gz' 'bg-deploy' 'abd3a018d81649ed2644d622e7389cdb86803d25c6c5d547f7028f80c4dc1770' ;;
    '2026.8.3/darwin-amd64') printf '%s %s %s\n' 'bg-deploy-darwin-amd64.tar.gz' 'bg-deploy' '5c71f18d4ce06bc29023ed4ebfc6dd42b717c663961ffeea18f3b6f81b9e9cbc' ;;
    '2026.8.3/darwin-arm64') printf '%s %s %s\n' 'bg-deploy-darwin-arm64.tar.gz' 'bg-deploy' '4a9f7907019d7e2cd2bfe734e31c70022efe1f0236935a2e941983ec071e10d8' ;;
    *) return 1 ;;
  esac
}
# <<< END generated

BG_VERSION="${BG_CLI_VERSION:-}"
[ -n "$BG_VERSION" ] || BG_VERSION="$BG_DEFAULT_VERSION"
BG_BASE="${BG_DOWNLOAD_BASE_URL:-}"
[ -n "$BG_BASE" ] || BG_BASE="$BG_DEFAULT_BASE_URL"
BG_BASE=$(printf '%s' "$BG_BASE" | sed 's:/*$::')

# Anything outside the published set fails loudly rather than guessing at an
# archive name that would 404 -- or worse, return 200 with an HTML error page,
# which then fails the checksum with a thoroughly confusing message.
bg_os=$(uname -s)
bg_arch=$(uname -m)
case "$bg_os" in
  Linux) bg_os=linux ;;
  Darwin) bg_os=darwin ;;
  *)
    bg_fail \
      "This component cannot install bg-deploy on $bg_os." \
      '' \
      'It supports Linux and macOS runners. Windows runners use PowerShell' \
      'rather than a POSIX shell, so this script cannot run there; use the' \
      'GitHub Action, or invoke the CLI directly.'
    ;;
esac
case "$bg_arch" in
  x86_64 | amd64) bg_arch=amd64 ;;
  aarch64 | arm64) bg_arch=arm64 ;;
  *) bg_fail "bg-deploy has no published build for $bg_os/$bg_arch." ;;
esac
BG_PLATFORM="${bg_os}-${bg_arch}"

if ! bg_entry=$(bg_pin "$BG_VERSION" "$BG_PLATFORM"); then
  bg_fail \
    "No pinned checksum for bg-deploy $BG_VERSION on $BG_PLATFORM." \
    "Versions pinned in this component: $BG_PINNED_VERSIONS." \
    '' \
    'An unpinned version cannot be verified against anything this component' \
    'controls, so it is refused rather than downloaded.'
fi
BG_ARCHIVE=$(printf '%s' "$bg_entry" | cut -d' ' -f1)
BG_BINARY=$(printf '%s' "$bg_entry" | cut -d' ' -f2)
BG_SHA256=$(printf '%s' "$bg_entry" | cut -d' ' -f3)

bg_sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    bg_fail 'Neither sha256sum nor shasum is available, so the download cannot be verified. Refusing to run an unverified binary.'
  fi
}

bg_download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    bg_fail 'Neither curl nor wget is available in this image, so the CLI cannot be downloaded.'
  fi
}

BG_CACHE_DIR=".bg-deploy-cache/$BG_VERSION"
BG_ARCHIVE_PATH="$BG_CACHE_DIR/$BG_ARCHIVE"
BG_SOURCE="$BG_BASE/downloads/$BG_VERSION/$BG_ARCHIVE"
mkdir -p "$BG_CACHE_DIR"

# A cached archive is re-hashed rather than trusted: the runner cache is shared,
# so its contents carry no more authority than a fresh download. One that still
# matches the pin is exactly as good as re-fetching it, and saves the round trip.
if [ -f "$BG_ARCHIVE_PATH" ] && [ "$(bg_sha256_of "$BG_ARCHIVE_PATH")" = "$BG_SHA256" ]; then
  echo "Using the cached bg-deploy $BG_VERSION ($BG_PLATFORM) archive; it still matches the pinned checksum."
else
  rm -f "$BG_ARCHIVE_PATH"
  echo "Downloading bg-deploy $BG_VERSION ($BG_PLATFORM) from $BG_SOURCE"
  bg_download "$BG_SOURCE" "$BG_ARCHIVE_PATH" || bg_fail "Could not download $BG_SOURCE."
fi

# Verified before extraction, so a tampered archive is never unpacked into the
# workspace alongside your source and your build output.
bg_actual=$(bg_sha256_of "$BG_ARCHIVE_PATH")
if [ "$bg_actual" != "$BG_SHA256" ]; then
  rm -f "$BG_ARCHIVE_PATH"
  bg_fail \
    "Checksum verification failed for $BG_ARCHIVE." \
    "  expected (pinned in this component): $BG_SHA256" \
    "  actual   (downloaded from $BG_SOURCE): $bg_actual" \
    '' \
    'The download does not match the hash this component pins. Refusing to' \
    'execute it. Either the host is serving a different build than the one' \
    'pinned (a maintainer must re-capture and commit the new checksums), or the' \
    'download was tampered with in transit.'
fi
echo "Checksum verified: $BG_SHA256"

BG_BIN_DIR=".bg-deploy-run/$BG_VERSION/$BG_PLATFORM"
rm -rf "$BG_BIN_DIR"
mkdir -p "$BG_BIN_DIR"
case "$BG_ARCHIVE" in
  *.tar.gz) tar -xzf "$BG_ARCHIVE_PATH" -C "$BG_BIN_DIR" ;;
  *) bg_fail "Unsupported archive format for $BG_ARCHIVE." ;;
esac

BG_BIN="$BG_BIN_DIR/$BG_BINARY"
[ -f "$BG_BIN" ] || bg_fail "The archive did not contain $BG_BINARY."
chmod +x "$BG_BIN"

echo "--- BehindGate deploy: deploying $BG_PATH"

# stdout and stderr must stay separate: under --json, stdout carries exactly one
# JSON object and every human-readable progress line goes to stderr. Merging
# them would leave the result unparseable, which is why the CLI's output is
# replayed after the run rather than streamed through a pipe.
BG_OUT="$BG_BIN_DIR/stdout.json"
BG_ERR="$BG_BIN_DIR/stderr.log"

set -- -y --json
if [ -n "$BG_URL" ]; then
  set -- "$@" --url "$BG_URL"
fi
set -- "$@" "$BG_PATH"

# The token is already in the environment, so it never goes on the command line
# and cannot surface in a process listing.
set +e
"$BG_BIN" "$@" >"$BG_OUT" 2>"$BG_ERR"
BG_CODE=$?
set -e

cat "$BG_ERR" >&2

# Extracts a top-level string field. The CLI's --json contract is a flat object
# of string values, so a targeted match is enough -- and it avoids depending on
# jq, which is absent from the small images runners use.
bg_json() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$2" | head -n 1
}

if [ "$BG_CODE" -ne 0 ]; then
  bg_reported=$(bg_json message "$BG_OUT")
  if [ -z "$bg_reported" ]; then
    bg_reported=$(sed -n 's/^[[:space:]]*error:[[:space:]]*//p' "$BG_ERR" | head -n 1)
  fi
  [ -z "$bg_reported" ] || echo "bg-deploy reported: $bg_reported" >&2

  # Established by running the real CLI, not read off documentation:
  #   exit 2 - configuration: missing or malformed token, no path, unknown flag,
  #            or a mismatch between the pinned url and the token's own claim
  #   exit 1 - runtime: network failure, non-2xx from the deploy API, anything
  #            that goes wrong once the deploy is under way
  if [ "$BG_CODE" -eq 2 ]; then
    echo "bg-deploy rejected the request as misconfigured (exit 2)." >&2
    if [ -n "$BG_URL" ]; then
      # The token format and the path were checked above, so the causes this job
      # could have caught are already ruled out. What is left is overwhelmingly
      # the endpoint check -- and that one is security relevant, so it leads.
      echo "Because this job already checks the token format and the path before running," >&2
      echo "the most likely cause is that the \`url\` input does not match the endpoint" >&2
      echo "your token was minted for. Since 2026.8.x the CLI refuses to deploy on that" >&2
      echo "mismatch rather than silently preferring one of them." >&2
      echo "" >&2
      echo "That refusal is the desired behaviour: a token whose endpoint claim disagrees" >&2
      echo "with your pinned \`url\` is exactly what a swapped variable looks like. Check" >&2
      echo "that \`url\` names the endpoint reported when you deploy without it, and that" >&2
      echo "the token really was issued for that environment (a test-environment token" >&2
      echo "cannot deploy to production)." >&2
    else
      echo "Check that BEHINDGATE_TOKEN exists and is non-empty, that it is not Protected" >&2
      echo "while this pipeline runs on an unprotected ref, and that it has not expired or" >&2
      echo "been revoked." >&2
    fi
  elif [ "$BG_CODE" -eq 1 ]; then
    echo "bg-deploy failed while running (exit 1, runtime failure)." >&2
    echo "This is a failure of the deploy itself rather than of its configuration: the" >&2
    echo "endpoint rejected the release, the runner could not reach it, or the upload was" >&2
    echo "interrupted. The CLI output above carries the specific error. Re-running is" >&2
    echo "often worthwhile, since these are frequently transient." >&2
  else
    echo "bg-deploy exited with code $BG_CODE, which is outside its documented range" >&2
    echo "(0 success, 1 runtime failure, 2 configuration error). Treating as a failure." >&2
  fi
  exit "$BG_CODE"
fi

BG_RELEASE_ID=$(bg_json releaseId "$BG_OUT")
BG_DEPLOYED_URL=$(bg_json url "$BG_OUT")

if [ -z "$BG_RELEASE_ID" ] && [ -z "$BG_DEPLOYED_URL" ]; then
  echo "WARNING: bg-deploy reported success but its --json output could not be parsed, so" >&2
  echo "WARNING: BEHINDGATE_RELEASE_ID and BEHINDGATE_URL will be empty. This usually means" >&2
  echo "WARNING: the CLI changed its output contract; please open an issue." >&2
fi

# A dotenv report is the GitLab counterpart of an Action output: jobs that
# `needs:` this one receive these as ordinary variables, and an `environment:`
# override can use BEHINDGATE_URL as its dynamic url.
{
  printf 'BEHINDGATE_RELEASE_ID=%s\n' "$BG_RELEASE_ID"
  printf 'BEHINDGATE_URL=%s\n' "$BG_DEPLOYED_URL"
} >behindgate.env

if [ -n "$BG_DEPLOYED_URL" ]; then
  echo "Deployed release ${BG_RELEASE_ID:-(unknown)} to $BG_DEPLOYED_URL"
else
  echo "Deployed release ${BG_RELEASE_ID:-(unknown)}"
fi

rm -rf .bg-deploy-run
