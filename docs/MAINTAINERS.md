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

## Adding a new `bg-deploy` version

Download URLs are unversioned, so the pin table records what the host serves.

```bash
# Inspect what is being served right now.
node script/checksums.js verify

# Record it.
node script/checksums.js write
```

`write` updates the checksums for `defaultVersion` in place and refreshes
`capturedFrom` / `capturedAt`. **Review the diff before committing.** A changed
hash is the one signal that distinguishes a legitimate re-release from a
compromised host, so it must never be updated reflexively — that is the entire
reason the table is committed here rather than fetched at runtime.

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

> **Note for the first release.** The checksums currently in `versions.json` were
> captured from `https://app.test.behindgate.net`, because the sandbox this
> Action was developed in could not reach the production host (blocked at the
> egress proxy). They have *not* been confirmed against
> `https://app.behindgate.net`, which is the default `download-base-url`.
>
> Before tagging `v1`, run `node script/checksums.js verify` from somewhere with
> production access. If production serves an identical build the command passes
> and nothing needs changing. If it reports a mismatch, production is serving a
> different build and the table needs per-environment handling — do not simply
> overwrite the hashes, since that would silently drop verification for one of
> the two environments.
>
> The `checksums` job in CI performs exactly this check on every run.

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
