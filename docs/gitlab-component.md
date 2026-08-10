# Deploy to BehindGate — GitLab CI/CD component

The GitLab counterpart of this repository's GitHub Action. Both download the
`bg-deploy` CLI, verify it against a checksum committed here, and deploy your
build. Neither reimplements the deploy protocol, so they cannot drift apart in
what a deploy actually does.

The component is [`templates/deploy.yml`](../templates/deploy.yml). It is
generated from [`src/gitlab/component.yml`](../src/gitlab/component.yml),
[`src/gitlab/deploy.sh`](../src/gitlab/deploy.sh) and
[`versions.json`](../versions.json); edit those, not the template.

## Quick start

```yaml
stages: [build, deploy]

include:
  - component: $CI_SERVER_FQDN/behindgate/deploy-action/deploy@v1
    inputs:
      path: dist
      # Pin the endpoint rather than trusting the token's own claim.
      # See "Why you should pin url".
      url: https://app.behindgate.com/api/deploy

build:
  stage: build
  image: node:24-alpine
  script:
    - npm ci && npm run build
  artifacts:
    paths:
      - dist
```

The component adds a job called `behindgate-deploy` in the `deploy` stage. It
picks up `dist` from the `build` job's artifacts, because jobs download the
artifacts of every earlier stage by default.

`path` should point at your build output — the folder whose *contents* become
the site, so that `index.html` sits at the top of it.

## The token is a CI/CD variable, never an input

Add **`BEHINDGATE_TOKEN`** under **Settings → CI/CD → Variables**, marked
*Masked* (and *Protected*, if you deploy only from protected branches). Generate
the value in the BehindGate dashboard under **Settings → Deploy tokens**.

There is deliberately no `token` input. Component inputs are interpolated into
the project's pipeline configuration, which is readable by anyone who can open
the pipeline editor's *Full configuration* view — so a token passed as an input
is a token published to every project member. It has to arrive as a masked
variable, and a unit test in this repository fails if an input that looks like a
credential is ever added.

A *Protected* variable is not exposed to pipelines on unprotected branches; it
expands to an empty string instead of failing. The component checks for that
explicitly and says so, because it is the single most common way this job goes
wrong.

## Where the component comes from

**`include: component:` resolves against the CI/CD Catalog on the same GitLab
instance.** GitLab does not fetch components across instances, so this repository
has to exist on your instance — mirrored to gitlab.com, or to your self-managed
GitLab — with a release published for the tag you reference.
[`.gitlab-ci.yml`](../.gitlab-ci.yml) contains the `release` job that publishes a
tag to the catalog.

**Until then, include it remotely.** `include: remote:` fetches the template over
HTTPS at pipeline creation and supports the same inputs:

```yaml
include:
  - remote: https://raw.githubusercontent.com/behindgate/deploy-action/v1/templates/deploy.yml
    inputs:
      path: dist
      url: https://app.behindgate.com/api/deploy
```

Pin a tag or a commit SHA, never a branch. A remote include is fetched fresh on
every pipeline, so a moving ref means the file that runs your deploy can change
without a commit in your project — which is the same problem `url` pinning
exists to solve, one level up.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `path` | yes | — | Folder to deploy, or an existing `.zip` to upload as-is. |
| `url` | no | — | Pin the deploy endpoint. **Strongly recommended** — see below. |
| `cli-version` | no | `defaultVersion` from [`versions.json`](../versions.json) | Escape hatch to hold a specific `bg-deploy` version after a bad release. Normally leave unset. |
| `download-base-url` | no | `https://app.behindgate.com` | Host to download the CLI from. Override only for non-production environments. |
| `stage` | no | `deploy` | Stage the job runs in. |
| `image` | no | `alpine:3.22` | Image the job runs in. Needs a POSIX shell, `tar`, and `curl` or `wget`. |
| `job-name` | no | `behindgate-deploy` | Name of the generated job. |

## Outputs

The job publishes a `dotenv` report, which is GitLab's equivalent of an Action
output:

| Variable | Description |
| --- | --- |
| `BEHINDGATE_RELEASE_ID` | Identifier of the published release. |
| `BEHINDGATE_URL` | Public address of the deployed site. |

Any job that `needs:` the deploy job receives both as ordinary variables:

```yaml
smoke-test:
  stage: verify
  needs: [behindgate-deploy]
  script:
    - curl -fsS "$BEHINDGATE_URL" > /dev/null
```

## Adjusting the job

The component defines one job, so redefining a job of the same name in your
`.gitlab-ci.yml` overrides any key on it. This is the intended way to adapt it —
there is no input for every knob.

```yaml
behindgate-deploy:
  # Deploy from merge requests as well as the default branch.
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'

  # Show the deployed address in Operate -> Environments, and on the MR.
  environment:
    name: production
    url: $BEHINDGATE_URL

  # Take the build from one specific job rather than from every earlier stage.
  needs: [build]

  tags: [my-runner]
```

By default the job runs only on the default branch. A deploy on every branch is
almost never what anyone wants, so that is the default you have to opt out of
rather than into.

**Sourcing the endpoint from a CI/CD variable.** Inputs are resolved when the
configuration is assembled, so `url: $MY_VARIABLE` does not do what it looks
like. Override `BG_URL` on the job instead:

```yaml
behindgate-deploy:
  variables:
    BG_URL: $BEHINDGATE_DEPLOY_URL
```

Note what this does *not* open up: the component already sets `BG_URL` at job
level, and job variables take precedence over project and group variables, so a
project variable named `BG_URL` cannot silently redirect a pinned deploy. Only an
edit to this file can — which is the point. Prefer the literal anyway; see below.

## Why you should pin `url`

A BehindGate deploy token is not only a credential. It is *also* a routing
instruction: the endpoint the CLI uploads to is a claim inside the token itself.

That means anyone who can change your `BEHINDGATE_TOKEN` variable can point your
builds at a host they control — and **nothing in the job looks wrong**. The
upload succeeds, the CLI prints `✓ Deployed`, the job exits `0`, and the pipeline
goes green. Your real site simply stops receiving updates while your build output
goes somewhere else.

Setting `url` removes that, in two ways. The destination lives in
`.gitlab-ci.yml`, where code review and protected branches cover it rather than
project settings a single compromised account can rewrite — and since CLI
2026.8.0, a token whose own claim disagrees with your pinned `url` is **refused
outright** rather than silently overridden.

**Finding your endpoint.** Run the job once *without* `url`. The CLI reports the
endpoint it used on its first line:

```
Deploying to https://app.behindgate.com/api/deploy
```

Never put the endpoint in a *masked* variable. It is not sensitive, and storing
it beside the token means one compromised store controls both the credential and
the destination — which looks like pinning while providing none of its benefit.

If you omit `url`, the job emits a warning explaining what it is trusting.

## How the CLI is verified

The component pins a SHA256 per platform and refuses to execute a download that
does not match. Verification happens on the archive **before** it is extracted,
so a tampered archive is never unpacked into the job workspace next to your
source and your build output.

**The checksums are inlined into the template**, rather than read from
`versions.json` the way the Action reads them. That is forced: a component is
YAML merged into *your* pipeline, and this repository is never checked out on
your runner, so there is no `versions.json` to read at job time. Fetching one
from the download host would defeat the purpose — a host able to serve a modified
binary can serve a matching hash beside it. The inline copy is generated by
[`script/build-gitlab-template.js`](../script/build-gitlab-template.js) and CI
fails if it drifts from `versions.json`.

**Only the archive is cached, and it is re-hashed on every run.** A runner cache
is shared and writable by other jobs in the project, so a cached *binary* would
be executed on trust. A cached archive that still matches the pin is exactly as
trustworthy as a fresh download, and skips the round trip. A cached archive that
does not match is deleted and re-fetched.

## Supported runners

Linux and macOS, on `amd64` and `arm64`.

Windows runners use PowerShell rather than a POSIX shell, so this component
cannot run there; it fails with an explicit message rather than part-way through.
Use the GitHub Action, or invoke the CLI directly.

The default `alpine:3.22` image provides everything needed. Any image with a
POSIX shell, `tar`, `sha256sum` (or `shasum`), and `curl` or `wget` works.

## Failure messages

The CLI's two failure modes need different fixes, and are reported differently:

- **exit 2 (configuration)** — rejected before deploying: a missing or malformed
  token, a bad path, or a `url` that disagrees with the endpoint the token was
  minted for. The component validates the token format and the path itself
  first, so an exit 2 with `url` set is most often that endpoint mismatch, and
  the message says so.
- **exit 1 (runtime)** — the deploy itself failed: the endpoint rejected the
  release, the runner could not reach it, or the upload was interrupted. Often
  transient and worth retrying.

## Development

The job body is [`src/gitlab/deploy.sh`](../src/gitlab/deploy.sh), a real shell
file rather than shell buried in YAML, so it can be linted and executed:

```bash
npm run lint:shell                       # sh -n
npm run build:gitlab                     # regenerate templates/deploy.yml
npm run build:gitlab -- --check          # what CI runs
node --test test/integration/gitlab-deploy.test.js
```

The integration tests run the script exactly as it ships — a unit test enforces
that the template's body is the same file — against two local servers: one
serving the real `bg-deploy` archive so the download-and-verify path runs for
real, one capturing the deploy. They need no credentials. The checksum test
serves deliberately corrupted bytes and asserts the binary is never executed.
