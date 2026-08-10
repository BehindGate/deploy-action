# Deploy to BehindGate

[![CI](https://github.com/behindgate/deploy-action/actions/workflows/ci.yml/badge.svg)](https://github.com/behindgate/deploy-action/actions/workflows/ci.yml)

Deploy a static site to [BehindGate](https://behindgate.com) in one step.

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
          url: https://app.behindgate.com/api/deploy/releases
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
| `cli-version` | no | `defaultVersion` from [`versions.json`](versions.json) | Escape hatch to hold a specific `bg-deploy` version after a bad release. Normally leave unset — see [Which CLI version you get](#which-cli-version-you-get). |
| `download-base-url` | no | `https://app.behindgate.com` | Host to download the CLI from. Override only when targeting a non-production BehindGate environment. |

## Outputs

| Output | Description |
| --- | --- |
| `release-id` | Identifier of the published release. |
| `url` | Public address of the deployed site, read from the CLI's `--json` output. |

## Why you should pin `url`

A BehindGate deploy token is not only a credential. It is *also* a routing
instruction: the endpoint the CLI uploads to is a claim inside the token itself.

That means anyone who can change your `BEHINDGATE_TOKEN` secret can point your
builds at a host they control — and **nothing in the job looks wrong**. The
upload succeeds, the CLI prints `✓ Deployed`, the step exits `0`, and the
workflow goes green. Your real site simply stops receiving updates while your
build output goes somewhere else.

Setting `url` removes that, in two ways. The destination lives in your workflow
file, where code review and branch protection cover it rather than a secret a
single compromised account can rewrite — and since CLI 2026.8.0, a token whose
own claim disagrees with your pinned `url` is **refused outright** rather than
silently overridden. A swapped secret now fails the job instead of quietly
succeeding somewhere else. Both behaviours are covered in
[`test/integration/deploy.test.js`](test/integration/deploy.test.js).

```yaml
- uses: behindgate/deploy-action@v1
  with:
    path: dist
    token: ${{ secrets.BEHINDGATE_TOKEN }}
    url: https://app.behindgate.com/api/deploy/releases   # pinned, reviewable
```

**Finding your endpoint.** Run the step once *without* `url`. The CLI reports the
endpoint it used on its first line:

```
Deploying to https://app.behindgate.com/api/deploy/releases
```

Copy that value into `url` **exactly, including its path** — the endpoint is not
just the host, and the comparison is an exact match. Pinning a prefix of it, such
as `https://app.behindgate.com/api/deploy`, does not match a token minted for
`https://app.behindgate.com/api/deploy/releases`, and the deploy is refused with
`url_mismatch`.

Endpoints also differ per environment, so a value copied from another
environment's token will not match either.

From then on the destination is fixed by your workflow rather than by the token.

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

Those hashes live in this repository rather than being fetched at run time, so
changing one takes a commit that appears in history and in review. They are
computed from the downloaded archives themselves.

Verification happens on the archive **before** it is extracted, so a tampered
archive is never unpacked onto the runner. A mismatch fails the deploy; it never
silently falls back to running the binary anyway.

CI re-checks the pinned hashes against the published artifacts on every run, so
any drift surfaces as a build failure rather than as a surprise mid-deploy.

## Which CLI version you get

**Effectively the current one — you should not pin, and by default you don't.**

BehindGate is a hosted service, so the platform moves whether or not your
workflow does. Holding an old CLI therefore buys no reproducibility, and a stale
client only drifts further from the service it talks to.

The pinned hashes are about **integrity, not stability**. This Action downloads a
binary and executes it on your runner, next to your source, your build output and
your secrets, so it verifies what it runs before running it.

[`cli-update.yml`](.github/workflows/cli-update.yml) keeps the pin current: a
scheduled job reads the published release index, verifies the newest build and
opens a pull request. New versions reach you through an ordinary release of this
Action rather than through a table someone has to remember to update — automatic,
but with a reviewed commit behind every change of hash.

Downloads are versioned and immutable (`/downloads/<version>/<archive>`), so a
pinned hash describes one specific published release and rollback is possible.
`cli-version` exists as an escape hatch for the one case that genuinely needs it:
holding the previous version after a bad CLI release. Superseded versions stay in
the table for exactly that reason. Using it routinely will leave you on a client
the service has moved past.

**Minimum CLI version 2026.8.0.** This Action reads the CLI's `--json` output,
which earlier releases do not have.

## Failure messages

The CLI's two failure modes are reported differently, because they need
different fixes:

- **exit 2 (configuration)** — the request was rejected before deploying: a
  missing or malformed token, a bad path, or a `url` that disagrees with the
  endpoint the token was minted for. Since this Action validates the token
  format and the path itself before invoking the CLI, an exit 2 with `url` set
  is most often that endpoint mismatch, and the failure message says so.
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

## Supported runners

`linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`,
`windows-arm64`.

A runner outside that set fails with an explicit message rather than guessing at
an archive name that would not exist.

## Reusing this outside GitHub Actions

The CLI is the shared core, and this Action is a thin wrapper over it. Everything
reusable lives in [`src/core/`](src/core/) — platform resolution, the
version/checksum table, checksum verification, output parsing, and exit-code
mapping — with **no `@actions/*` imports** and no dependencies beyond Node
builtins. Only [`src/index.js`](src/index.js) touches the Actions toolkit, so the
core can back a wrapper for another CI system unchanged.

Nothing here reimplements the deploy HTTP protocol; that lives in the CLI, so any
wrapper stays thin and they cannot drift apart.

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
BG_DOWNLOAD_BASE_URL=https://<your-environment-host> npm run test:integration
```

Pull request titles must be conventional commits — releases and the changelog
are generated from them, and CI checks the title. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

See [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) for releasing and for
re-capturing checksums after a CLI release.

## License

[MIT](LICENSE)
