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
#   BEHINDGATE_OIDC_TOKEN  the job's own OIDC token, minted by GitLab from the
#                          `id_tokens:` block this component declares
#   BEHINDGATE_TOKEN       a deploy token, for a workspace with no CI trust
#   BG_APP_ORIGIN          the BehindGate instance, as scheme and host
#   BG_PATH                the folder (or .zip) to deploy
#   BG_TRUST               the CI trust to exchange under, or empty
#   BG_URL                 the pinned deploy endpoint, or empty to derive it
#   BG_CLI_VERSION         a pinned CLI version, or empty for the default
#   BG_DOWNLOAD_BASE_URL   the CLI download host, or empty to derive it
#
# ONE INPUT NAMES THE INSTANCE. `app-origin` is the audience GitLab mints the
# job's token for, the origin of the deploy endpoint, and the host the CLI is
# downloaded from. Those three have to agree -- a token minted for one audience
# cannot be exchanged at another -- and deriving them from a single value is what
# makes disagreement unrepresentable rather than merely discouraged.
#
# THE PROJECT DIRECTORY IS READ-ONLY. This component uploads a directory; that
# is its whole contract, and it needs nothing written back to do it. The CLI it
# downloads, unpacks and runs lives under a temporary directory removed on exit.
#
# That rules out a job `cache:` and a dotenv report, both of which can only name
# paths inside $CI_PROJECT_DIR. It is worth the cost: `path: .` deploys that
# directory, so anything left there is published as part of the site. The
# release id and deployed address go to the log instead.

set -eu

bg_fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

echo "--- BehindGate deploy: preflight"

# The CLI exits 2 for a malformed credential, which is also how it reports a bad
# path and an endpoint mismatch. Checking the shape here separates a mangled
# variable from a genuine deploy failure. The value is never echoed -- only a dot
# count and a character class are derived from it.
#
# A leading dot or a doubled dot means an empty header or payload segment, both
# of which the Action rejects too. A TRAILING dot is deliberately allowed: that
# is an empty signature, and the Action's check requires only the first two
# segments to be non-empty. The two implementations cannot import each other, so
# the corpus in test/integration/gitlab-deploy.test.js is what keeps them level.
bg_is_jwt() {
  bg_dots=$(printf '%s' "$1" | tr -cd '.' | wc -c | tr -d ' ')
  bg_stray=$(printf '%s' "$1" | tr -d 'A-Za-z0-9_.-' | wc -c | tr -d ' ')

  case "$1" in
    .* | *..*) return 1 ;;
  esac

  [ "$bg_dots" = "2" ] && [ "$bg_stray" = "0" ]
}

# Credential selection, matching the CLI's own order: a deploy token set in the
# environment is used as-is, and only its absence takes the OIDC path.
#
# OIDC is what this component is built around -- GitLab mints the token from the
# `id_tokens:` block on the job, so it is present with nothing to configure and
# no long-lived secret stored anywhere. BEHINDGATE_TOKEN stays supported as the
# fallback for a workspace that has no CI trust covering this project.
BG_CREDENTIAL=oidc

if [ -n "${BEHINDGATE_TOKEN:-}" ]; then
  BG_CREDENTIAL=token

  if ! bg_is_jwt "$BEHINDGATE_TOKEN"; then
    bg_fail \
      'BEHINDGATE_TOKEN is set but is not a well-formed JWT.' \
      '' \
      'A BehindGate deploy token has three base64url segments separated by dots' \
      '(header.payload.signature). The value supplied does not, which usually' \
      'means it was truncated, wrapped across lines, or quoted when it was' \
      'stored as a CI/CD variable.' \
      '' \
      'Re-copy it from the workspace dashboard under Settings -> Deploy tokens,' \
      'or unset the variable entirely to authenticate as the job over OIDC.'
  fi

  echo "Authenticating with BEHINDGATE_TOKEN (a deploy token)."
  echo "OIDC needs no stored secret and issues a credential that expires with the job;"
  echo "unset BEHINDGATE_TOKEN once the workspace has a CI trust for this project."
elif [ -n "${BEHINDGATE_OIDC_TOKEN:-}" ]; then
  # Minted by GitLab, so a malformed value here is not a mistyped variable --
  # it means the job was redefined and something else now sets this name.
  if ! bg_is_jwt "$BEHINDGATE_OIDC_TOKEN"; then
    bg_fail \
      'BEHINDGATE_OIDC_TOKEN is not a well-formed JWT.' \
      '' \
      'GitLab sets this variable from the `id_tokens:` block on the job, and what' \
      'it mints is always a JWT -- so a value of another shape means the job was' \
      'redefined with a `variables:` entry of the same name, which shadows it.'
  fi

  echo "Authenticating as this job over OIDC."
else
  bg_fail \
    'This job has no credential: neither BEHINDGATE_OIDC_TOKEN nor BEHINDGATE_TOKEN is set.' \
    '' \
    'BEHINDGATE_OIDC_TOKEN is normally supplied by GitLab itself, from the' \
    '`id_tokens:` block this component puts on the job. It is missing here, which' \
    'means the job was redefined in your .gitlab-ci.yml without carrying that' \
    'block over -- redefining a job REPLACES its keys rather than merging them.' \
    '' \
    'Either restore it:' \
    '' \
    '    behindgate-deploy:' \
    '      id_tokens:' \
    '        BEHINDGATE_OIDC_TOKEN:' \
    '          aud: <the same value as the `app-origin` input>' \
    '' \
    'or set BEHINDGATE_TOKEN under Settings -> CI/CD -> Variables as a masked' \
    'variable, to authenticate with a deploy token instead. Never pass either as' \
    'a component input: inputs are plainly visible in the expanded pipeline' \
    'configuration.'
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

echo "--- BehindGate deploy: acquiring the CLI"

# >>> BEGIN generated from versions.json by script/build-gitlab-template.js
BG_DEPLOY_PATH='/api/deploy/releases'
BG_DEFAULT_ORIGIN='https://app.behindgate.com'
BG_KNOWN_ORIGINS='https://app.behindgate.com https://app.test.behindgate.net'

# Prints "pinned" or "unpinned" for an origin this repository names.
bg_origin() {
  case "$1" in
    'https://app.behindgate.com') printf '%s\n' 'pinned' ;;
    'https://app.test.behindgate.net') printf '%s\n' 'unpinned' ;;
    *) return 1 ;;
  esac
}

BG_DEFAULT_VERSION='2026.8.5'
BG_PINNED_VERSIONS='2026.8.3 2026.8.4 2026.8.5'
BG_OIDC_MIN_VERSION='2026.8.5'
BG_OIDC_VERSIONS='2026.8.5'

# Prints "<archive> <binary> <sha256>" for a version/platform pair.
bg_pin() {
  case "$1/$2" in
    '2026.8.3/linux-amd64') printf '%s %s %s\n' 'bg-deploy-linux-amd64.tar.gz' 'bg-deploy' 'c68fbc53c21d42eb7628d2dc6aaf65683033ada12e2ace15976d83e52c4645f9' ;;
    '2026.8.3/linux-arm64') printf '%s %s %s\n' 'bg-deploy-linux-arm64.tar.gz' 'bg-deploy' 'abd3a018d81649ed2644d622e7389cdb86803d25c6c5d547f7028f80c4dc1770' ;;
    '2026.8.3/darwin-amd64') printf '%s %s %s\n' 'bg-deploy-darwin-amd64.tar.gz' 'bg-deploy' '5c71f18d4ce06bc29023ed4ebfc6dd42b717c663961ffeea18f3b6f81b9e9cbc' ;;
    '2026.8.3/darwin-arm64') printf '%s %s %s\n' 'bg-deploy-darwin-arm64.tar.gz' 'bg-deploy' '4a9f7907019d7e2cd2bfe734e31c70022efe1f0236935a2e941983ec071e10d8' ;;
    '2026.8.4/linux-amd64') printf '%s %s %s\n' 'bg-deploy-linux-amd64.tar.gz' 'bg-deploy' '4db567f9a40b6965722cbe431a67a83e129b68dd1cbfc7a4e247bf6264a27c56' ;;
    '2026.8.4/linux-arm64') printf '%s %s %s\n' 'bg-deploy-linux-arm64.tar.gz' 'bg-deploy' '585668505f54dbec29a3039070656b969257dd484bf1b2fafdeee4ec8c450068' ;;
    '2026.8.4/darwin-amd64') printf '%s %s %s\n' 'bg-deploy-darwin-amd64.tar.gz' 'bg-deploy' 'e07076953f12eeec676d1a1d60bc4a226357826de233c8a1104b9c5d289315fb' ;;
    '2026.8.4/darwin-arm64') printf '%s %s %s\n' 'bg-deploy-darwin-arm64.tar.gz' 'bg-deploy' '100e5eae8496efddadec2b24776f0552143e641a870ce1b3cd323a846490f2b3' ;;
    '2026.8.5/linux-amd64') printf '%s %s %s\n' 'bg-deploy-linux-amd64.tar.gz' 'bg-deploy' 'ffdf4d3335d2e2c43b8c42a0f7169e8571479ee350426c0a12d1d03e4ef1e806' ;;
    '2026.8.5/linux-arm64') printf '%s %s %s\n' 'bg-deploy-linux-arm64.tar.gz' 'bg-deploy' 'c750633080bb858534d095c383d5a23dbdd977cffe6f252d169c3b4bb7638b2c' ;;
    '2026.8.5/darwin-amd64') printf '%s %s %s\n' 'bg-deploy-darwin-amd64.tar.gz' 'bg-deploy' '39b46091412e021c21e413e83f5f3272d3dd2746d5e2e82bc991022b7e644665' ;;
    '2026.8.5/darwin-arm64') printf '%s %s %s\n' 'bg-deploy-darwin-arm64.tar.gz' 'bg-deploy' 'a54f22a290416d01d0faf5c0ad4f309ab81916861158cdd0f869e56479cca9f8' ;;
    *) return 1 ;;
  esac
}
# <<< END generated

# `app-origin` names the BehindGate instance, and everything addressed follows
# from it: the audience GitLab minted the job's token for, the deploy endpoint,
# and the host the CLI is downloaded from. Trailing slashes are dropped so the
# derived endpoint has exactly one separator.
BG_APP_ORIGIN=$(printf '%s' "${BG_APP_ORIGIN:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s:/*$::')
[ -n "$BG_APP_ORIGIN" ] || BG_APP_ORIGIN="$BG_DEFAULT_ORIGIN"

# An ORIGIN, not a URL: scheme and host with no path. The deploy endpoint is
# built by appending to it, so a value carrying a path would produce an address
# nobody named -- and the same value is the audience the token was minted for,
# where a mismatched spelling fails the exchange rather than degrading.
case "$BG_APP_ORIGIN" in
  https://*/* | http://*/*)
    bg_fail \
      "The \`app-origin\` input ($BG_APP_ORIGIN) has a path." \
      '' \
      'It names the BehindGate instance as scheme and host only, for example' \
      'https://app.behindgate.com. The deploy endpoint is derived from it as' \
      "<app-origin>$BG_DEPLOY_PATH; to pin a different endpoint, use the \`url\` input."
    ;;
  https://?*) ;;
  http://?*)
    echo "WARNING: \`app-origin\` uses http://, so both the OIDC token and the build are" >&2
    echo "WARNING: sent in clear text. Only ever appropriate against a local instance." >&2
    ;;
  *)
    bg_fail \
      "The \`app-origin\` input ($BG_APP_ORIGIN) is not a URL." \
      '' \
      'It names the BehindGate instance as scheme and host, for example' \
      'https://app.behindgate.com.'
    ;;
esac

# Production publishes a version once, so a committed checksum describes it for
# good. Test republishes under the same version, so a pin there describes the
# build only until someone rebuilds it -- and the job then fails verification on
# bytes that are legitimate.
if bg_pinned=$(bg_origin "$BG_APP_ORIGIN"); then
  if [ "$bg_pinned" = "unpinned" ]; then
    echo "WARNING: $BG_APP_ORIGIN republishes CLI builds under the same version, so the" >&2
    echo "WARNING: checksums pinned in this component describe what it served when they" >&2
    echo "WARNING: were captured, not necessarily what it serves now. A checksum failure" >&2
    echo "WARNING: here means the build was replaced, not that anything is wrong." >&2
  fi
else
  echo "WARNING: $BG_APP_ORIGIN is not an instance this component knows about." >&2
  echo "WARNING: Known: $BG_KNOWN_ORIGINS." >&2
  echo "WARNING: The download is still verified against a checksum pinned here, so an" >&2
  echo "WARNING: unknown host cannot substitute a binary -- but it has to serve exactly" >&2
  echo "WARNING: the build this component pins, or verification fails." >&2
fi

# `url` and `download-base-url` win over what `app-origin` derives: an explicit
# value must never be quietly replaced by one built from a shorthand. Whether it
# was pinned is remembered, because a pinned endpoint that disagrees with a
# token's own claim is a diagnosis the CLI's exit code alone cannot give.
BG_URL_PINNED=no
if [ -n "$BG_URL" ]; then
  BG_URL_PINNED=yes
else
  BG_URL="$BG_APP_ORIGIN$BG_DEPLOY_PATH"
fi

BG_VERSION="${BG_CLI_VERSION:-}"
[ -n "$BG_VERSION" ] || BG_VERSION="$BG_DEFAULT_VERSION"
BG_BASE="${BG_DOWNLOAD_BASE_URL:-}"
[ -n "$BG_BASE" ] || BG_BASE="$BG_APP_ORIGIN"
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

# Checked here rather than earlier so that a version with no pinned checksum is
# reported as unpinned first: that is true whatever the credential, while this is
# only about how the job authenticates. Still before anything is downloaded.
#
# An older CLI does not read BEHINDGATE_OIDC_TOKEN at all and reports the absence
# of a deploy token instead, which sends you looking for a variable you
# deliberately did not set.
if [ "$BG_CREDENTIAL" = "oidc" ]; then
  case " $BG_OIDC_VERSIONS " in
    *" $BG_VERSION "*) ;;
    *)
      bg_fail \
        "bg-deploy $BG_VERSION cannot authenticate over OIDC." \
        "OIDC needs $BG_OIDC_MIN_VERSION or newer; pinned here: $BG_OIDC_VERSIONS." \
        '' \
        'Either drop the `cli-version` input so the component picks a release that' \
        'can, or set BEHINDGATE_TOKEN to deploy with a deploy token instead.'
      ;;
  esac
fi

# Resolved once, here, rather than inside bg_sha256_of. Every call to that
# function happens in a command substitution, and an `exit` inside $(...) leaves
# only the subshell -- the caller would carry on with an empty digest and report
# a checksum mismatch against nothing, which is the least useful way to say that
# the image has no hashing tool. It still fails safe, but the message sends you
# hunting a tampered download that does not exist.
if command -v sha256sum >/dev/null 2>&1; then
  BG_SHA_TOOL='sha256sum'
elif command -v shasum >/dev/null 2>&1; then
  BG_SHA_TOOL='shasum -a 256'
else
  bg_fail \
    'Neither sha256sum nor shasum is available in this image, so the download' \
    'cannot be verified. Refusing to run an unverified binary.' \
    '' \
    'Use an image that provides one -- the default, alpine, does.'
fi

# Deliberately unquoted: BG_SHA_TOOL may carry arguments, and it holds only the
# two fixed values set above.
bg_sha256_of() {
  $BG_SHA_TOOL "$1" | cut -d' ' -f1
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

# A scratch directory outside the project directory, which the CLI is unpacked
# into and executed from -- so it has to allow execution. /tmp is mounted noexec
# on plenty of hardened runners, and the failure that produces is a bare
# "Permission denied" from a binary that was just verified.
#
# $CI_BUILDS_DIR is tried first: it is the project directory's own parent, so the
# runner already executes from that filesystem, and it is still outside the
# checkout. Each candidate is proven by running something from it rather than
# assumed.
bg_scratch_in() {
  bg_candidate=$(mktemp -d "$1/bg-deploy.XXXXXX" 2>/dev/null) || return 1

  printf '#!/bin/sh\nexit 0\n' >"$bg_candidate/probe" 2>/dev/null || {
    rm -rf "$bg_candidate"
    return 1
  }
  chmod 700 "$bg_candidate/probe" 2>/dev/null || {
    rm -rf "$bg_candidate"
    return 1
  }

  if "$bg_candidate/probe" 2>/dev/null; then
    rm -f "$bg_candidate/probe"
    printf '%s' "$bg_candidate"
    return 0
  fi

  rm -rf "$bg_candidate"
  return 1
}

bg_scratch() {
  for bg_base in "$@"; do
    [ -n "$bg_base" ] || continue
    [ -d "$bg_base" ] || continue
    if bg_scratch_in "$bg_base"; then
      return 0
    fi
  done
  return 1
}

BG_TMP=$(bg_scratch "${CI_BUILDS_DIR:-}" "${TMPDIR:-/tmp}") || bg_fail \
  'Found nowhere to unpack the CLI that allows execution.' \
  '' \
  "Tried \$CI_BUILDS_DIR (${CI_BUILDS_DIR:-unset}) and \${TMPDIR:-/tmp}." \
  'Both were missing, unwritable, or mounted noexec.' \
  '' \
  'This component never writes to the project directory, so it needs one' \
  'writable, exec-capable directory elsewhere. Set TMPDIR on the job to a' \
  'location that qualifies.'

trap 'rm -rf "$BG_TMP"' EXIT

BG_ARCHIVE_PATH="$BG_TMP/$BG_ARCHIVE"
BG_SOURCE="$BG_BASE/downloads/$BG_VERSION/$BG_ARCHIVE"

echo "Downloading bg-deploy $BG_VERSION ($BG_PLATFORM) from $BG_SOURCE"
bg_download "$BG_SOURCE" "$BG_ARCHIVE_PATH" || bg_fail \
  "Could not download $BG_SOURCE." \
  '' \
  'A version pinned in this component is not necessarily published on every' \
  'instance -- the two move independently, and a path that is not published is' \
  "answered by the CDN rather than by a 404. Check that $BG_APP_ORIGIN serves" \
  "$BG_VERSION at /downloads/index.json, and pin \`cli-version\` to one it lists" \
  'if it does not.'

# Verified before extraction, so a tampered archive is never unpacked at all.
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

BG_BIN_DIR="$BG_TMP/cli"
mkdir -p "$BG_BIN_DIR"
case "$BG_ARCHIVE" in
  *.tar.gz) tar -xzf "$BG_ARCHIVE_PATH" -C "$BG_BIN_DIR" ;;
  *) bg_fail "Unsupported archive format for $BG_ARCHIVE." ;;
esac

BG_BIN="$BG_BIN_DIR/$BG_BINARY"
[ -f "$BG_BIN" ] || bg_fail "The archive did not contain $BG_BINARY."

# Executable by its owner only: the shell that extracts it is the shell that
# runs it, and the directory is removed when this job ends.
chmod 700 "$BG_BIN"

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

# Only exported when it was actually asked for: the CLI resolves the workspace's
# single covering trust on its own, and an empty value would be a name to match
# rather than an absent one.
if [ -n "${BG_TRUST:-}" ]; then
  BEHINDGATE_TRUST_ID="$BG_TRUST"
  export BEHINDGATE_TRUST_ID
fi

# Both credentials are already in the environment, so neither goes on the command
# line and neither can surface in a process listing.
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
    # The credential's shape and the path were both checked above, so the causes
    # this job could have caught are already ruled out.
    if [ "$BG_CREDENTIAL" = "oidc" ]; then
      echo "This job authenticated as itself, so the exchange is what failed: the" >&2
      echo "workspace at $BG_APP_ORIGIN has no CI trust that covers this pipeline, or the" >&2
      echo "one it has does not match." >&2
      echo "" >&2
      echo "Check the trust under Settings -> CI trusts: it names a repository, and it may" >&2
      echo "also name a branch. If more than one covers this pipeline, name the one you" >&2
      echo "mean with the \`trust\` input." >&2
      echo "" >&2
      echo "If you redefined this job in your own .gitlab-ci.yml, check that the \`aud:\`" >&2
      echo "under \`id_tokens:\` is still exactly the \`app-origin\` input ($BG_APP_ORIGIN)." >&2
      echo "A token minted for one audience cannot be exchanged at another." >&2
    elif [ "$BG_URL_PINNED" = "yes" ]; then
      # A pinned `url` that disagrees with the token's own claim is the one
      # security-relevant cause, so it leads wherever it is possible.
      echo "The most likely cause is that the \`url\` input ($BG_URL) does not match the" >&2
      echo "endpoint your token was minted for. Since 2026.8.x the CLI refuses to deploy" >&2
      echo "on that mismatch rather than silently preferring one of them." >&2
      echo "" >&2
      echo "That refusal is the desired behaviour: a token whose endpoint claim disagrees" >&2
      echo "with your pinned \`url\` is exactly what a swapped variable looks like. Check" >&2
      echo "that the token really was issued for this instance -- a test-environment token" >&2
      echo "cannot deploy to production." >&2
    else
      echo "Check that BEHINDGATE_TOKEN has not expired or been revoked, and that it was" >&2
      echo "issued for $BG_APP_ORIGIN rather than for another instance." >&2
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
  echo "WARNING: the release cannot be named below. The deploy itself succeeded. This" >&2
  echo "WARNING: usually means the CLI changed its output contract; please open an issue." >&2
fi

if [ -n "$BG_DEPLOYED_URL" ]; then
  echo "Deployed release ${BG_RELEASE_ID:-(unknown)} to $BG_DEPLOYED_URL"
else
  echo "Deployed release ${BG_RELEASE_ID:-(unknown)}"
fi
