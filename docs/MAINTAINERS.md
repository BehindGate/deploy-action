# Maintaining `behindgate/deploy-action`

## Releasing

Releases are proposed automatically and cut by a human.

1. [release-please](https://github.com/googleapis/release-please) watches `main`
   and keeps a pull request open titled something like
   *"chore(main): release 1.3.0"*, containing the version bump and a generated
   `CHANGELOG.md`. It computes the version from conventional commit subjects —
   see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
2. Review that PR. **Merging it is the release**: release-please tags the commit
   and publishes the GitHub release.
3. [`release-please.yml`](../.github/workflows/release-please.yml) then calls
   [`tag-major.yml`](../.github/workflows/tag-major.yml), which rebuilds the
   bundle, **refuses to continue** if the tagged `dist/` does not match a fresh
   build, and force-updates the floating major tag (`v1`).

Users reference `behindgate/deploy-action@v1`, so the floating tag is what
actually runs.

**Only the major tag ever moves.** `v1.2.3` is immutable by convention, and both
Dependabot and anyone auditing a pinned SHA rely on that. Never repoint a patch
or minor tag; cut a new one.

The version decision is automated; publishing is not. That is deliberate — every
consumer on `@v1` picks up a release the moment it exists, with no staged
rollout, so a human should look at the diff first.

### Why the major tag is moved from two places

A release created with `GITHUB_TOKEN` does not trigger further workflows, so the
`release: published` event from release-please never reaches
[`release.yml`](../.github/workflows/release.yml). If that workflow were the only
route, the major tag would silently stop moving the day release-please was
adopted. `release-please.yml` therefore calls the reusable workflow directly.

`release.yml` remains for the off-path cases — a release published by hand in the
UI, and `workflow_dispatch` to repoint the major tag after a botched release.
Both routes call the same reusable workflow, so the `dist/` gate cannot drift
between them.

### Bootstrapping the first release

`.release-please-manifest.json` records `1.0.0` as the current version, so
release-please will never propose it — it only proposes what comes *after* the
recorded version. The first tag has to be created once, by either:

- running [`bootstrap-release.yml`](../.github/workflows/bootstrap-release.yml)
  via **workflow_dispatch** with `1.0.0`, which verifies the bundle, runs the
  tests, tags the head of `main`, publishes the release and moves `v1`; or
- tagging and publishing by hand:
  ```bash
  git checkout main && git pull
  git tag -a v1.0.0 -m "v1.0.0"
  git push origin v1.0.0
  ```
  then publishing a release for that tag, which fires `release.yml`.

Note that `release.yml` via **workflow_dispatch** cannot bootstrap: it checks out
the tag it is given, so the tag must already exist. That path is for *repointing*
`v1` at an existing release after a botched one, not for creating the first tag.

After the first release, release-please proposes every version from the commit
history and `bootstrap-release.yml` should not be needed again.

## Versioning policy

**This Action and the CLI are versioned independently, and should stay that way.**

- The Action uses semver with a floating major tag: `v1.2.3`, with `v1` tracking
  the newest `v1.x.y`. That is what Action consumers expect.
- The CLI version is *data*, pinned in `versions.json` and selectable per-workflow
  through the `cli-version` input.

It is tempting to make them match, but they must not:

- **The Action supports more than one CLI version at a time.** `versions.json` can
  pin several, and a workflow can choose. If the Action were stamped `2026.07.1`
  while a user set `cli-version: 2026.06.3`, its version number would be a
  statement that is simply false.
- **The two change for unrelated reasons.** The tool-cache bug fixed in this repo
  had nothing to do with the CLI; a CLI patch needing no wrapper change should not
  force an Action release. Coupling them produces a stream of no-op releases in
  one project every time the other moves.
- **Calendar versions are not semver.** `2026.07.1` has a leading zero in the
  minor component, so it is invalid semver — which already broke the tool cache
  silently (see `semverSafeVersion`). Adopting it as the Action's own version
  would also break the floating-major-tag convention and Dependabot's ability to
  reason about upgrades.

Do state the default CLI version in each Action release note — "defaults to
bg-deploy 2026.07.1" — so the mapping is discoverable without reading
`versions.json`.

## Adding a new `bg-deploy` version

Downloads are versioned and immutable, and the vendor publishes a release index
at `/downloads/index.json`, so adopting a new release is a single command.

```bash
# Confirm the pinned release still verifies.
node script/checksums.js verify

# Adopt whatever the index reports as latest, adding a new entry.
node script/checksums.js bump
```

`bump` reads the index, downloads every platform of the new version, hashes them
locally, checks each binary reports the version it is being filed under, and adds
a **new** entry — it never overwrites an existing one, so a superseded version
stays selectable through `cli-version` after a bad release. `.github/workflows/cli-update.yml`
runs it weekly and opens a pull request.

**Minimum version 2026.8.0.** This Action reads the CLI's `--json` output, which
earlier releases do not have, and pre-2026.8.0 used a different exit-code scheme.
Do not add older entries: they would install cleanly and then fail at runtime.
A unit test enforces this.

`write` re-captures an existing entry in place. Now that published versions are
immutable it should almost never be needed — a hash that has changed under a
versioned path is a red flag, not a routine re-release.

`write` updates the checksums for `defaultVersion` in place and refreshes
`capturedFrom` / `capturedAt`. **Review the diff before committing.** A changed
hash is the one signal that distinguishes a legitimate re-release from a
compromised host, so it must never be updated reflexively — that is the entire
reason the table is committed here rather than fetched at runtime.

Both modes also read the version string embedded in each downloaded binary and
refuse to continue if it disagrees with the key it is filed under. This guards
the most likely maintenance mistake: running `write` after a CLI release records
the *new* binaries' hashes under the *old* version number. Checksums would still
verify — they would describe the new bytes correctly — but the tool cache keys on
the version, so runners would serve the new binary out of the old cache entry.
When the guard fires, add a new version entry rather than overwriting the
existing one:

```
The binaries do not report version 2026.06.9:
  linux-amd64 reports 2026.07.1
  ...
```

To add a genuinely new version, copy the existing block in
[`versions.json`](../versions.json) under the new version key, then run
`node script/checksums.js write --version <new>`. Bump `defaultVersion` in the
same commit if the new version should become the default.

Confirm the version string with `bg-deploy --version`, which prints e.g.
`bg-deploy 2026.07.1 (git 79f1f9f)`.

## The undocumented `env` input

`env` selects the BehindGate environment and resolves the two addresses that have
to agree — the deploy endpoint and the host the CLI is downloaded from:

| `env` | Deploy endpoint | CLI downloads |
| --- | --- | --- |
| `prod` (default) | `https://app.behindgate.com/api/deploy` | `https://app.behindgate.com` |
| `test` | `https://app.test.behindgate.net/api/deploy` | `https://app.test.behindgate.net` |

Anything else fails the step rather than falling back to the default, which would
deploy to an environment nobody named. `url` and `download-base-url` each win
over it, independently: overriding the endpoint leaves downloads on the
environment's host.

**It is deliberately absent from the README**, because the test environment is
BehindGate's own and not somewhere a user of this Action deploys. `url` and
`download-base-url` are the documented way to reach any other endpoint, and they
cover every case a user has. Keep it that way when editing the README: the table
above, `action.yml`, and `src/core/environments.js` are where it is written down.

Nothing user-facing names the input either. The endpoint is reported in the log
and the job summary as "pinned via the `url` input" or "pinned via the prod
default", and the exit-2 guidance in `src/core/errors.js` talks about the
endpoint rather than about `env`. Check that when changing those messages.

The input still has to be declared in `action.yml`: passing an undeclared input
makes the runner log "Unexpected input(s)" on every run, which is worse than a
terse description.

### How the CLI is resolved per environment

`versions.json` describes production, and only production. Each environment
carries a `pinnedCli` flag saying so, and it decides where the CLI's version and
checksum come from:

| | Version | Checksum | Verified against |
| --- | --- | --- | --- |
| `prod` | `defaultVersion`, or `cli-version` | `versions.json` | a hash committed here |
| `test` | the host's `/downloads/index.json`, or `cli-version` | the host's `SHA256SUMS.txt` | a file the same host serves |

Test republishes builds under the same version string. On 2026-08-16 the
`2026.8.5` linux-amd64 archive changed from `7d4250e0df0b` to `e566ce5c86a7`
inside three hours. A committed pin cannot survive that, and there is no
schedule that could re-capture it fast enough, so the choice on that host is
between the host's own manifest and no verification at all.

Be clear about what the manifest is worth: the host serves both the binary and
the file describing it, so it proves the download arrived intact and nothing
more. That is why production does not use it, and why the run warns whenever
this path is taken. It still catches the failure that actually happens on a
republishing host -- a truncated or half-published archive.

The tool cache is keyed on **version plus digest** (`2026.8.5-sha.e566ce5c86a7`)
wherever the version is not pinned. A key of version alone would hand back the
build that was replaced, and a cache hit is indistinguishable from a fast run.
The digest rides in a semver *prerelease* segment on purpose: `semver.clean`,
which the tool cache applies, keeps a prerelease and discards build metadata, so
`2026.8.5+sha.…` would collapse into the same entry as `2026.8.5`. A unit test
pins that, against the same copy of semver the tool cache resolves.

`node script/checksums.js verify` and the `checksums` CI job are unchanged: they
describe production, which is the only thing `versions.json` claims to describe.

## The preview inputs run ahead of the pinned CLI

`site-url`, `create-app` and `delete-app` map onto CLI flags added in
**2026.8.5**, which at the time of writing is published on the test host only —
production still serves 2026.8.4, and `/downloads/2026.8.5/` there answers 403.
Nothing was pinned for it: adding a test-host-captured entry would put production
users one `cli-version:` away from a 403, and `bump` never overwrites an existing
entry, so a hand-added key would also stop the weekly job adopting the production
build under the same name.

So the inputs ship first and start working on production when
[`cli-update.yml`](../.github/workflows/cli-update.yml) adopts 2026.8.5 there. No
change to this Action is needed then. On `env: test` they work already, since
that environment takes whatever version the host reports as current. Until the
production pin lands:

- `test/integration/preview.test.js` skips itself, detecting the flags from
  `--help` rather than from a version string;
- `BG_CLI_BINARY=/path/to/bg-deploy npm run test:integration` runs it against a
  build fetched by hand. That escape hatch is test-only — the Action itself never
  runs an unverified binary.

Drop the skip only when it stops firing on its own; a skipping preview suite is
the signal that the pin has not caught up yet.

## Hosts are per-environment

BehindGate serves downloads from a different host per environment — production
and test are not the same host — which is why `download-base-url` exists and why
nothing hardcodes a host.

Each version entry records `capturedFrom`: the host its checksums came from.
That value is also the default download host, because a checksum only means
anything relative to whoever served it — keeping them as one field stops them
drifting apart. `node script/checksums.js verify` defaults to that host, so CI
asks "do these pins still describe their own source?".

The two known environments are:

| Environment | Host |
| --- | --- |
| Production | `https://app.behindgate.com` — note **.com**, not `.net` |
| Test | `https://app.test.behindgate.net` |

The pinned checksums for 2026.8.3 were captured from production. The test
environment historically served byte-identical archives, but that has not been
re-confirmed for this release — check it if you rely on it:

```bash
node script/checksums.js verify --base-url https://app.behindgate.com
node script/checksums.js verify --base-url https://app.test.behindgate.net
```

If a future release ever diverges between environments, give the table a
per-environment dimension. Do **not** just overwrite the hashes with one host's
values — that silently drops verification for the other environment.

> `app.behindgate.net` (`.net`) does not resolve and never did; an early draft of
> this Action defaulted to it, and CI caught it as `fetch failed` across all five
> platforms. If a checksum job reports unreachability rather than a mismatch,
> suspect the hostname before suspecting the pins.

## Upstream CLI work

Several limitations in this Action are really limitations of the CLI's release
process — unversioned download URLs, no machine-readable output, checksums served
by the host they describe. [`app-repo-release-prompt.md`](app-repo-release-prompt.md)
is a ready-to-hand-over brief covering those, with the evidence behind each and
acceptance criteria. Tracked here as #2 and #3.

## Why `dist/` is committed

GitHub runs `dist/index.js` directly; there is no `npm install` at Action
runtime. The `dist` job in CI rebuilds and fails on any diff, so the published
bundle always corresponds to reviewed source.

After changing anything under `src/`, run:

```bash
npm run build && git add dist/
```

## Dependency updates

Dependabot is configured for both npm and the workflows' own Actions. Every
dependency PR is gated by the `dist` job, so a bumped runtime dependency cannot
land without its rebuilt bundle.

There is a standing `npm audit` finding for `undici`, pulled in transitively by
`@actions/http-client` (which pins `^5`). No fixed release satisfies that range;
forcing a major override risks breaking the download path that this Action
depends on. Dependabot will pick the fix up when `@actions/http-client` ships one.

## Testing without credentials

The integration suite runs the real CLI against a local capture server with a
fake-but-well-formed JWT, so it needs no secret and runs on forks. The
end-to-end workflow is the only thing that requires a real token, and it is
gated on the secret being present.

```bash
npm run test:unit
npm run test:integration
BG_DOWNLOAD_BASE_URL=https://app.test.behindgate.net npm run test:integration
```
