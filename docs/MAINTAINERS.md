# Maintaining `behindgate/deploy-action`

## Releasing

1. Make sure `main` is green and `dist/` is committed and current
   (`npm run build` should produce no diff).
2. Draft a GitHub release with a semver tag: `v1.2.3`.
3. Publishing the release triggers [`.github/workflows/release.yml`](../.github/workflows/release.yml), which:
   - rebuilds the bundle and **refuses to continue** if the tagged `dist/` does
     not match a fresh build,
   - force-updates the floating major tag (`v1`) to point at the new release.

Users reference `behindgate/deploy-action@v1`, so the floating tag is what
actually runs. Nothing else moves it.

To repoint the major tag manually (for example after a botched release), run the
`Release` workflow via **workflow_dispatch** with the target tag.

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
