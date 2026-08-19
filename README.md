# Deploy to BehindGate

[![CI](https://github.com/behindgate/deploy-action/actions/workflows/ci.yml/badge.svg)](https://github.com/behindgate/deploy-action/actions/workflows/ci.yml)

Deploy a static site to [BehindGate](https://behindgate.net) in one step.

This Action downloads the `bg-deploy` CLI, verifies it against a checksum
committed in this repository, caches it across runs, and deploys your build.

Using GitLab? The same thing ships here as a CI/CD component — see
[`docs/gitlab-component.md`](docs/gitlab-component.md).

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
| `cli-version` | no | `defaultVersion` from [`versions.json`](versions.json) | Escape hatch to hold a specific `bg-deploy` version after a bad release. Normally leave unset — see [Which CLI version you get](#which-cli-version-you-get). |
| `download-base-url` | no | `https://app.behindgate.com` | Host to download the CLI from. Override only for non-production environments (for example `https://app.test.behindgate.net`). |

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

## Outside GitHub Actions

**GitLab** is supported today, as a CI/CD component in
[`templates/deploy.yml`](templates/deploy.yml).
[`docs/gitlab-component.md`](docs/gitlab-component.md) covers it in full.

```yaml
include:
  - component: $CI_SERVER_FQDN/behindgate/deploy-action/deploy@v1
    inputs:
      path: dist
      url: https://app.behindgate.com/api/deploy
```

The token arrives as a masked `BEHINDGATE_TOKEN` CI/CD variable rather than as
an input, because component inputs are visible in the project's expanded
pipeline configuration.

Like the Pipe, the component never writes to your project directory — which
matters more here than it sounds: `path: .` deploys that directory, so anything
left beside your source would be published as part of your site.

The CLI is the shared core, and neither wrapper reimplements the deploy HTTP
protocol — so they stay thin and cannot drift apart in what a deploy does. What
each *can* share depends on where it runs:

- The Action runs Node on the runner, so it reuses [`src/core/`](src/core/) —
  platform resolution, the checksum table, verification, output parsing,
  exit-code mapping — with **no `@actions/*` imports** and no dependencies beyond
  Node builtins. Only [`src/index.js`](src/index.js) touches the Actions toolkit.
- The component is YAML merged into *your* pipeline, and this repository is never
  checked out on a GitLab runner. It therefore cannot call into `src/core/` at
  all, and is POSIX shell with the checksum table inlined. That inlining is
  generated from the same `versions.json`, so the data has one source even though
  the code does not.

A Bitbucket Pipe would follow the Action's shape rather than the component's,
since a Pipe is a container that can carry its own Node.

## Development

```bash
npm ci
npm run lint
npm test          # unit + integration
npm run build     # bundle to dist/ with @vercel/ncc
```

`npm run build` produces two committed outputs, and CI fails if either drifts
from source: `dist/`, which the Action runs directly, and
[`templates/deploy.yml`](templates/deploy.yml), the GitLab component.

The integration tests run the **real** CLI against a local capture server using
a syntactically valid but fake JWT, so they need no credentials and run on
forks. They assert, among other things, that the uploaded zip has `index.html`
at its root and nothing nested under the source folder name — the failure that
would otherwise produce a broken site from a green deploy.

To target a non-production environment:

```bash
BG_DOWNLOAD_BASE_URL=https://app.test.behindgate.net npm run test:integration
```

Pull request titles must be conventional commits — releases and the changelog
are generated from them, and CI checks the title. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

See [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) for releasing and for
re-capturing checksums after a CLI release.

## License

[MIT](LICENSE)
