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
```

Generate a deploy token in the BehindGate dashboard under **Settings → Deploy
tokens**, and store it as a repository secret.

`path` should point at your build output — the folder whose *contents* become
the site, so that `index.html` sits at the top of it.

That deploys to production. For the test environment, add `env: test`.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `path` | yes¹ | — | Folder to deploy, or an existing `.zip` to upload as-is. |
| `env` | no | `prod` | Which BehindGate environment to talk to: `prod` or `test`. Sets the deploy endpoint *and* the CLI download host together — see [Choosing an environment](#choosing-an-environment). |
| `token` | no² | — | BehindGate deploy token. Always pass from a secret. Without it the job authenticates as itself — see [Deploying without a token](#deploying-without-a-token). |
| `site-url` | no | — | What to deploy to, as the URL it serves on: the host names the site, the path names the app. Only with the CI-job credential; cannot be combined with `token`. |
| `create-app` | no | `false` | Create the app named by `site-url` if it does not exist yet. |
| `delete-app` | no | `false` | Delete the app named by `site-url` and exit without deploying. |
| `url` | no | from `env` | Pin the deploy endpoint to an exact URL, overriding `env`. For a local or dev endpoint. |
| `cli-version` | no | `defaultVersion` from [`versions.json`](versions.json) | Escape hatch to hold a specific `bg-deploy` version after a bad release. Normally leave unset — see [Which CLI version you get](#which-cli-version-you-get). |
| `download-base-url` | no | from `env` | Host to download the CLI from, overriding `env`. |

¹ Except with `delete-app: true`, which uploads nothing.
² Required unless the job authenticates as itself; `create-app` and `delete-app`
work only in that mode.

## Outputs

| Output | Description |
| --- | --- |
| `release-id` | Identifier of the published release. Empty for `delete-app`. |
| `url` | Public address of the deployed site, read from the CLI's `--json` output. Empty for `delete-app`. |

## Choosing an environment

BehindGate runs more than one environment, and two addresses have to agree for a
deploy to work: the endpoint the build is uploaded to, and the host the CLI
itself is downloaded from. They are different URLs, and until now you had to set
both by hand and keep them in sync.

`env` sets both:

| `env` | Deploy endpoint | CLI downloads |
| --- | --- | --- |
| `prod` (default) | `https://app.behindgate.com/api/deploy` | `https://app.behindgate.com` |
| `test` | `https://app.test.behindgate.net/api/deploy` | `https://app.test.behindgate.net` |

```yaml
- uses: behindgate/deploy-action@v1
  with:
    path: dist
    env: test
    token: ${{ secrets.BEHINDGATE_TEST_TOKEN }}
```

Any other value fails the step. `env: staging` is not quietly read as the
default, because that would deploy to an environment nobody named.

`url` and `download-base-url` still work and each **wins over `env`**, so a
workflow written before `env` existed behaves exactly as it did, and a local or
dev endpoint is still reachable:

```yaml
- uses: behindgate/deploy-action@v1
  with:
    path: dist
    url: http://localhost:8787/api/deploy   # env is ignored for the endpoint
    token: ${{ secrets.BEHINDGATE_TOKEN }}
```

They are independent: overriding the endpoint leaves the CLI downloads on the
environment's host, since a local endpoint does not imply a local mirror of the
CLI archives.

**This pins your endpoint by default.** Setting neither `env` nor `url` used to
mean "upload wherever the token says"; it now means production. If you deploy to
the test environment with only a token, add `env: test` — otherwise the CLI
refuses the deploy on the endpoint mismatch, which is the behaviour
[the next section](#why-the-endpoint-is-pinned) exists for.

## Why the endpoint is pinned

A BehindGate deploy token is not only a credential. It is *also* a routing
instruction: the endpoint the CLI uploads to is a claim inside the token itself.

That means anyone who can change your `BEHINDGATE_TOKEN` secret can point your
builds at a host they control — and **nothing in the job looks wrong**. The
upload succeeds, the CLI prints `✓ Deployed`, the step exits `0`, and the
workflow goes green. Your real site simply stops receiving updates while your
build output goes somewhere else.

Pinning removes that, in two ways. The destination lives in your workflow file,
where code review and branch protection cover it rather than a secret a single
compromised account can rewrite — and since CLI 2026.8.0, a token whose own claim
disagrees with the pinned endpoint is **refused outright** rather than silently
overridden. A swapped secret now fails the job instead of quietly succeeding
somewhere else. Both behaviours are covered in
[`test/integration/deploy.test.js`](test/integration/deploy.test.js).

This is why `env` defaults to `prod` rather than to "whatever the token says":
the safe destination is the one written down in the workflow.

Use `url` when you need an endpoint `env` does not name — a local or dev
instance. Write it as a literal. You can reference a repository or organisation
variable (`url: ${{ vars.BEHINDGATE_URL }}`), but be clear about the trade-off: a
literal is protected by code review and branch protection, while a variable moves
the value back into mutable repository settings, so whoever can change the secret
can often change the variable too — and the pin stops being a pin.

Never put the endpoint in a *secret*. It is not sensitive, and storing it beside
the token means a single compromised store controls both the credential and the
destination — which looks like pinning while providing none of its benefit.

## Deploying without a token

`token` is optional. Without it the CLI authenticates as the CI job itself: it
exchanges the OIDC token GitHub mints for the run for a deploy token that lives
fifteen minutes, so the repository stores no long-lived secret at all.

That needs three things:

- `permissions: id-token: write` on the job, which is what mints the OIDC token;
- a CI trust for this repository in the workspace, under **Settings → CI trusts**;
- an endpoint the Action can name, which `env` supplies by default — there is no
  token to carry one.

It is also the **only** mode in which `create-app` and `delete-app` work, because
a deploy token is pinned to one app that already exists: it can neither create
another nor delete the one it names. Passing `token` together with `site-url`,
`create-app` or `delete-app` fails the step immediately, before anything is
downloaded or uploaded.

## Per-pull-request previews

Deploy each pull request to its own app, and tear it down when the pull request
closes. `site-url` names the target as the URL it serves on: the **host** names
the site, the **path** names the app.

```yaml
name: Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  preview:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write        # mints the OIDC token; no deploy token needed
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci && npm run build

      - uses: behindgate/deploy-action@v1
        id: preview
        with:
          path: dist
          site-url: https://docs.example.com/preview/pr-${{ github.event.number }}
          create-app: true

      - run: echo "Preview at ${{ steps.preview.outputs.url }}"

  teardown:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: behindgate/deploy-action@v1
        with:
          site-url: https://docs.example.com/preview/pr-${{ github.event.number }}
          delete-app: true
```

The teardown job needs no checkout and no `path`: it uploads nothing. Deleting a
path with no app there succeeds, so the job is safe to re-run — and to run on a
pull request that never got a preview.

Give the trust "create apps" and "delete apps" over the site, or the two flags
fail with an exit 2 naming the missing permission.

**`site-url` is not the deploy endpoint.** They are different values and both
appear in this example's job log: `site-url` is where the release is *served*,
`url` / `env` is the API it is *uploaded to*. Setting one to the other's value
does not work.

Without `create-app`, deploying to a path that has no app is an error rather than
a silent creation — a mistyped path cannot quietly become a new app nobody ever
looks at.

**Needs bg-deploy 2026.8.5**, which is where `--site-url`, `--create-app` and
`--delete-app` arrived. The pinned default tracks the production download host
and moves through [`cli-update.yml`](.github/workflows/cli-update.yml); on an
older CLI these inputs fail with an unknown-flag error. See
[Which CLI version you get](#which-cli-version-you-get).

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

## Which CLI version you get

**Effectively the current one — you should not pin, and by default you don't.**

BehindGate is a SaaS. The server moves whether or not your workflow does, so
holding an old CLI buys you no reproducibility: the half that actually decides
what a deploy does was never pinned in the first place. A stale client is a
liability, not a safety measure — it drifts away from the server it talks to, and
BehindGate cannot ship you a fix for a version you have frozen.

So why does `versions.json` pin hashes at all? **Integrity, not stability.** This
Action downloads a binary and executes it on your runner, next to your source,
your build output and your secrets. That is arbitrary code execution inside your
trust boundary, and it deserves verification regardless of how the backend is
deployed. The only mechanism available today is a hash committed to this
repository, because the vendor publishes no signatures and a `SHA256SUMS.txt`
served beside the binaries proves nothing.

Verifying against a fixed hash and always taking the newest build are, strictly,
in tension. [`cli-update.yml`](.github/workflows/cli-update.yml) resolves it: a
scheduled job reads the vendor's release index, verifies the newest build, and
opens a pull request. New versions reach you through a normal release of this
Action rather than through a frozen table someone has to remember to update —
automatic, but with a reviewed commit behind every change of hash.

Downloads are versioned and immutable
(`/downloads/<version>/<archive>`), so a pinned hash describes one specific
published release and rollback is possible. `cli-version` exists as an escape
hatch for the one case that genuinely needs it: a bad CLI release, where you want
to hold the previous version until it is fixed. Superseded versions stay in the
table for exactly that reason. It is not a stability feature, and using it
routinely will leave you on a client the server has moved past.

**Minimum CLI version 2026.8.0.** This Action reads the CLI's `--json` output,
which earlier releases do not have.

**The preview inputs need 2026.8.5.** `site-url`, `create-app` and `delete-app`
are passed straight through to CLI flags that arrived in that release, so on an
older CLI they fail as unknown flags. The pinned default follows the production
download host, which at the time of writing serves 2026.8.4 — these inputs start
working when the scheduled bump lands, with no change to your workflow.

Signing the releases would remove this machinery entirely — the Action could
verify a signature at runtime and always take the current build. That is the
highest-leverage item in
[`docs/app-repo-release-prompt.md`](docs/app-repo-release-prompt.md).

## Known gaps

These are real limitations, tracked as issues rather than papered over.

**Releases are not signed.** `versions.json` pins a hash per platform because
that is the only integrity mechanism available: the vendor publishes no
signatures, and the `SHA256SUMS.txt` served beside the binaries proves nothing
(see above). A signature verifiable against a key that does not live on the
download host would let this Action verify at runtime and always take the current
build, removing the pinned table and the scheduled bump job entirely. It is the
outstanding item in
[`docs/app-repo-release-prompt.md`](docs/app-repo-release-prompt.md).

## Failure messages

The CLI's two failure modes are reported differently, because they need
different fixes:

- **exit 2 (configuration)** — the request was rejected before deploying: a
  missing or malformed token, a bad path, or a pinned endpoint that disagrees
  with the one the token was minted for. Since this Action validates the token
  format and the path itself before invoking the CLI, an exit 2 with a token is
  most often that endpoint mismatch, and the failure message says so. Without a
  token the message points at the CI trust instead, which is what decides what
  the job may do.
- **exit 1 (runtime)** — the deploy itself failed: the endpoint rejected the
  release, the runner could not reach it, or the upload was interrupted. Often
  transient and worth retrying.

Before 2026.8.0 a *missing* token exited 2 while a *malformed* one exited 1,
splitting the same class of problem across both codes. They are now both 2,
which is what makes the distinction usable.

## Token handling

The token is masked in the log via `::add-mask::` before anything else runs, and
is passed to the CLI through the environment — never on the command line, so it
cannot appear in a process listing or in the step's command echo.

When no `token` is set, `BEHINDGATE_TOKEN` is *removed* from the CLI's
environment rather than left to inherit. The CLI picks its credential mode from
that variable, so one set elsewhere in the workflow would otherwise silently
override what your inputs asked for.

An unset secret interpolates to an empty string rather than failing the workflow,
which now selects the CI-job credential instead of failing outright. The Action
catches that: with no token and no OIDC token available to the job, it fails
naming both causes — the missing `id-token: write` permission, and the secret
that may simply not be set.

## Supported runners

`linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`,
`windows-arm64`.

A runner outside that set fails with an explicit message rather than guessing at
an archive name that would not exist.

## Reusing this outside GitHub Actions

Bitbucket Pipes and a GitLab component are planned, and the CLI is the shared
core. Everything reusable lives in [`src/core/`](src/core/) — platform
resolution, the version/checksum table, checksum verification, output parsing,
exit-code mapping, the environment table, and the input rules that turn a set of
inputs into a CLI invocation — with **no `@actions/*` imports** and no
dependencies beyond Node builtins. Only [`src/index.js`](src/index.js) touches
the Actions toolkit.

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

[`test/integration/preview.test.js`](test/integration/preview.test.js) covers the
preview flow the same way, with a second local server standing in for the Actions
token service so the CLI can authenticate as the job. It skips itself on a CLI
older than 2026.8.5, detected from `--help` rather than from a version string.

To target a non-production environment:

```bash
BG_DOWNLOAD_BASE_URL=https://app.test.behindgate.net npm run test:integration
```

To run against a build that has no pin yet — a release published to the test
environment ahead of production, which has no checksum in `versions.json`:

```bash
BG_CLI_BINARY=/path/to/bg-deploy npm run test:integration
```

Pull request titles must be conventional commits — releases and the changelog
are generated from them, and CI checks the title. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

See [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) for releasing and for
re-capturing checksums after a CLI release.

## License

[MIT](LICENSE)
