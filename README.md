# Deploy to BehindGate

[![CI](https://github.com/behindgate/deploy-action/actions/workflows/ci.yml/badge.svg)](https://github.com/behindgate/deploy-action/actions/workflows/ci.yml)

Deploy a static site to [BehindGate](https://behindgate.net) in one step.

This Action downloads the `bg-deploy` CLI, verifies it against a checksum
committed in this repository, caches it across runs, and deploys your build.

## Quick start

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci && npm run build

      - uses: behindgate/deploy-action@v1
        with:
          path: dist
          token: ${{ secrets.BEHINDGATE_TOKEN }}
          # Pin the endpoint rather than trusting the token's own claim.
          # See "Why you should pin url" for how to find yours.
          url: https://app.behindgate.com/api/deploy
```

Generate a deploy token in the BehindGate dashboard under **Settings → Deploy
tokens**, and store it as a repository secret.

`path` should point at your build output — the folder whose *contents* become
the site, so that `index.html` sits at the top of it.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `path` | yes | — | Folder to deploy, or an existing `.zip` to upload as-is. |
| `token` | yes | — | BehindGate deploy token. Always pass from a secret. |
| `url` | no | — | Pin the deploy endpoint. **Strongly recommended** — see below. |
| `cli-version` | no | `defaultVersion` from [`versions.json`](versions.json) | Which `bg-deploy` version to use. Must be pinned in this repo. |
| `download-base-url` | no | `https://app.behindgate.com` | Host to download the CLI from. Override only for non-production environments (for example `https://app.test.behindgate.net`). |

## Outputs

| Output | Description |
| --- | --- |
| `release-id` | Identifier of the published release. |
| `url` | Public address of the deployed site. **Currently always empty** — see [Known gaps](#known-gaps). |

## Why you should pin `url`

A BehindGate deploy token is not only a credential. It is *also* a routing
instruction: the endpoint the CLI uploads to is a claim inside the token itself.

That means anyone who can change your `BEHINDGATE_TOKEN` secret can point your
builds at a host they control — and **nothing in the job looks wrong**. The
upload succeeds, the CLI prints `✓ Deployed`, the step exits `0`, and the
workflow goes green. Your real site simply stops receiving updates while your
build output goes somewhere else.

This is not hypothetical; it is a covered behaviour in the integration suite
([`test/integration/deploy.test.js`](test/integration/deploy.test.js)), which
asserts that a token claiming an arbitrary endpoint silently redirects the
upload and still exits `0`.

Setting `url` removes that. The destination then lives in your workflow file,
where it is covered by code review and branch protection, rather than in a
secret that a single compromised account can rewrite:

```yaml
- uses: behindgate/deploy-action@v1
  with:
    path: dist
    token: ${{ secrets.BEHINDGATE_TOKEN }}
    url: https://app.behindgate.com/api/deploy   # pinned, reviewable
```

**Finding your endpoint.** Run the step once *without* `url`. The CLI reports the
endpoint it used on its first line:

```
Deploying to https://app.behindgate.com/api/deploy
```

Copy that value into `url`. From then on the destination is fixed by your
workflow rather than by the token.

**Write it as a literal.** You can also reference a repository or organisation
variable (`url: ${{ vars.BEHINDGATE_URL }}`), which is convenient when one
workflow targets several environments — but be clear about the trade-off. A
literal in the workflow file is protected by code review and branch protection.
A variable moves the value back into mutable repository settings, so whoever can
change the secret can often change the variable too, and the pin stops being a
pin. Prefer the literal; reach for a variable only when you genuinely need the
indirection.

Never put the endpoint in a *secret*. It is not sensitive, and storing it beside
the token means a single compromised store controls both the credential and the
destination — which looks like pinning while providing none of its benefit.

If you omit `url`, the Action emits a warning explaining what it is trusting.

## How the CLI is verified

The Action pins a SHA256 for every platform in [`versions.json`](versions.json)
and refuses to execute a download that does not match.

BehindGate publishes a `SHA256SUMS.txt` next to the binaries, and the Action
deliberately does **not** rely on it. That file is served by the same host as
the binary it describes, so it proves only that a download was not corrupted in
transit. Anyone able to serve a modified binary can serve a matching checksum
beside it, and the check passes.

A hash committed to *this* repository is the part that host cannot rewrite.
Changing it requires a commit, which shows up in history and in review. The
values in `versions.json` were computed locally from downloaded archives rather
than copied out of the vendor's file — then compared against it, and they agreed.

Verification happens on the archive **before** it is extracted, so a tampered
archive is never unpacked onto the runner. A mismatch fails the deploy; it never
silently falls back to running the binary anyway.

CI re-checks the pinned hashes against the live host on every run, so drift
surfaces as a build failure rather than as a surprise mid-deploy.

## Known gaps

These are real limitations, tracked as issues rather than papered over.

**The `url` output is empty.** `bg-deploy` 2026.07.1 prints only the release id
on success (`✓ Deployed. Release <id> is live.`). The deployed address is
returned by the deploy API but never echoed, and it has no `--json` mode. This
Action is a thin wrapper over the CLI and does not call the deploy API itself,
so it has nothing to read. The output is declared and its parser is already in
place, so it will populate automatically once the CLI exposes the value.

**Download URLs are unversioned.** Artifacts live at
`/downloads/bg-deploy-<os>-<arch>.tar.gz` with no version in the path, so
`cli-version` asserts which build the host is expected to be serving rather than
requesting it by name. If the host serves a different build, checksum
verification fails closed and the deploy stops rather than running an unverified
binary. Versioned URLs would make the pin exact.

## Failure messages

The CLI's two failure modes are reported differently, because they need
different fixes:

- **exit 2 (usage)** — the invocation was rejected. Since the Action builds the
  command line itself, this nearly always means the `token` input resolved to an
  empty string: an unset secret interpolates to `""` rather than failing the
  workflow. Common on forks, where secrets are unavailable by design.
- **exit 1 (runtime)** — the CLI ran and failed: a malformed token
  (`error: not a JWT`), an expired or revoked token, a rejected release, or an
  unreachable endpoint.

Note that a *missing* token exits 2 while a *malformed* token exits 1, even
though both are credential problems. The Action pre-checks both and fails early
with a specific message rather than passing a bad value through.

## Token handling

The token is masked in the log via `::add-mask::` before anything else runs, and
is passed to the CLI through the environment — never on the command line, so it
cannot appear in a process listing or in the step's command echo.

## Supported runners

`linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`.

Windows ARM64 runners are not supported: BehindGate publishes no such build, and
the Action fails with an explicit message rather than guessing at an archive
name.

## Reusing this outside GitHub Actions

Bitbucket Pipes and a GitLab component are planned, and the CLI is the shared
core. Everything reusable lives in [`src/core/`](src/core/) — platform
resolution, the version/checksum table, checksum verification, output parsing,
and exit-code mapping — with **no `@actions/*` imports** and no dependencies
beyond Node builtins. Only [`src/index.js`](src/index.js) touches the Actions
toolkit.

Neither this Action nor any future wrapper reimplements the deploy HTTP
protocol. That lives in the CLI, so all three integrations stay thin and cannot
drift apart.

## Development

```bash
npm ci
npm run lint
npm test          # unit + integration
npm run build     # bundle to dist/ with @vercel/ncc
```

`dist/` is committed because the Action runs it directly; CI fails if it drifts
from source.

The integration tests run the **real** CLI against a local capture server using
a syntactically valid but fake JWT, so they need no credentials and run on
forks. They assert, among other things, that the uploaded zip has `index.html`
at its root and nothing nested under the source folder name — the failure that
would otherwise produce a broken site from a green deploy.

To target a non-production environment:

```bash
BG_DOWNLOAD_BASE_URL=https://app.test.behindgate.net npm run test:integration
```

See [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) for releasing and for
re-capturing checksums after a CLI release.

## License

[MIT](LICENSE)
