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

Note what the quick start does **not** contain: a token. The job authenticates as
itself.

## How the job authenticates

**By default, over OIDC.** The component puts an `id_tokens:` block on the job,
so GitLab mints a token for the run and sets it as `BEHINDGATE_OIDC_TOKEN`. The
CLI exchanges that for a deploy token which expires with the job. Nothing
long-lived is stored in your project, there is no secret to rotate or to leak in
a log, and a fork's pipeline cannot obtain one.

What you need instead is a **CI trust** in the BehindGate workspace, under
**Settings → CI trusts**: it names the repository allowed to deploy, and
optionally the branch. The trust is what the exchange is checked against.

```yaml
include:
  - component: $CI_SERVER_FQDN/behindgate/deploy-action/deploy@v1
    inputs:
      path: dist
      # trust: my-trust    # only when several trusts cover this pipeline
```

**The audience is the instance you deploy to.** GitLab lets the job choose what
audience its token is minted for, so the trust has to require a specific one —
otherwise any project could mint a token for you. That audience is the
`app-origin` input, which is also the origin of the endpoint the token is
exchanged at. One input sets both, so they cannot be made to disagree.

### The deploy token, as a fallback

`BEHINDGATE_TOKEN` still works, for a workspace with no CI trust covering the
project. Add it under **Settings → CI/CD → Variables**, marked *Masked* (and
*Protected*, if you deploy only from protected branches), generating the value in
the BehindGate dashboard under **Settings → Deploy tokens**.

When it is set it *wins* — the CLI uses a deploy token as-is whenever one is
present, and the component selects the same credential the CLI will, so its
diagnostics describe the path that actually ran.

There is deliberately no `token` input, and none for the OIDC token either.
Component inputs are interpolated into the project's pipeline configuration,
readable by anyone who can open the pipeline editor's *Full configuration* view —
so a token passed as an input is a token published to every project member. A
unit test in this repository fails if an input that looks like a credential is
ever added.

A *Protected* variable is not exposed to pipelines on unprotected branches; it
expands to an empty string rather than failing, which now means the job falls
back to OIDC rather than failing outright.

> **Requires bg-deploy 2026.8.5 or newer.** Earlier releases do not read
> `BEHINDGATE_OIDC_TOKEN` at all. The component installs an OIDC-capable release
> by default and refuses, before downloading anything, if `cli-version` pins one
> that is not — pointing at the deploy token as the alternative.

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
```

Pin a tag or a commit SHA, never a branch. A remote include is fetched fresh on
every pipeline, so a moving ref means the file that runs your deploy can change
without a commit in your project — which is the same problem `url` pinning
exists to solve, one level up.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `path` | yes | — | Folder to deploy, or an existing `.zip` to upload as-is. |
| `app-origin` | no | `https://app.behindgate.com` | The BehindGate instance, as scheme and host with no path. Sets the OIDC audience, the deploy endpoint and the CLI download host together. |
| `trust` | no | — | The CI trust to exchange under, when more than one covers this pipeline. Ignored when `BEHINDGATE_TOKEN` is set. |
| `url` | no | `app-origin` + `/api/deploy/releases` | Override the deploy endpoint. Only for an instance that does not serve the API at that path. |
| `cli-version` | no | newest pinned release that supports OIDC | Escape hatch to hold a specific `bg-deploy` version after a bad release. Normally leave unset. |
| `download-base-url` | no | `app-origin` | Override the CLI download host. Only for a host that serves the CLI but not the API. |
| `stage` | no | `deploy` | Stage the job runs in. |
| `image` | no | `alpine:3.22` | Image the job runs in. Needs a POSIX shell, `tar`, `mktemp`, and `curl` or `wget`. |
| `job-name` | no | `behindgate-deploy` | Name of the generated job. |

The job also needs one writable, **exec-capable** directory outside the project
directory to unpack the CLI into. It tries `$CI_BUILDS_DIR` first — the project
directory's own parent, so the runner already executes from that filesystem —
then `$TMPDIR` or `/tmp`. Each candidate is proven by running something from it,
because `/tmp` is mounted `noexec` on plenty of hardened runners and the failure
that produces is a bare "Permission denied" from a binary that was just
verified. If neither qualifies the job says so and names both; set `TMPDIR` on
the job to somewhere that does.

## It never writes to your project directory

The component uploads a directory. That is the whole contract, and nothing about
it requires writing anything back, so it doesn't. The CLI it downloads, unpacks
and runs lives under a temporary directory removed when the job ends.

This is not tidiness. `path: .` deploys the project directory, so anything the
component left beside your source would be **published as part of your site**.
An earlier revision kept a `.bg-deploy-cache/` there and wrote a
`behindgate.env` for a dotenv report; both would have shipped. Two integration
tests now guard it — one snapshots the project directory around a real deploy
and fails on any difference, the other deploys `.` and asserts no component
scratch file appears in the uploaded archive.

The consequences are worth stating plainly:

- **There is no `cache:`.** GitLab cache paths must live inside the project
  directory, so caching the archive means writing there. The CLI is downloaded
  once per job instead — a few megabytes, verified either way.
- **There is no dotenv report**, so no `BEHINDGATE_RELEASE_ID` or
  `BEHINDGATE_URL` variable reaches later jobs. The release id and the deployed
  address go to the job log:

  ```
  Deployed release rel_01J8ZQ to https://demo.behindgate.com/my-app/
  ```

**If you use `environment:`**, give it your site's address as a literal rather
than a variable the deploy produces:

```yaml
behindgate-deploy:
  environment:
    name: production
    url: https://demo.behindgate.com/my-app/
```

Your site's address is a property of the app, not of a release — it does not
change per deploy — so a literal is both accurate and reviewable, the same
argument that applies to pinning `url`.

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
  # A literal, not $BEHINDGATE_URL: the component publishes no dotenv report.
  environment:
    name: production
    url: https://demo.behindgate.com/my-app/

  # Take the build from one specific job rather than from every earlier stage.
  needs: [build]

  tags: [my-runner]
```

By default the job runs only on the default branch. A deploy on every branch is
almost never what anyone wants, so that is the default you have to opt out of
rather than into.

**Redefining a job replaces its keys rather than merging them**, so a
redefinition that includes its own `id_tokens:` drops the one the component
declared and the job loses its credential. Overriding unrelated keys — `rules`,
`needs`, `environment`, `tags` — is safe; the block is only at risk if you write
one. The script says so by name if it goes missing, rather than letting it
surface as a missing deploy token.

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

## Choosing the instance

The Action has an `env` input — `prod` or `test`. This component deliberately
does not, and the reason is OIDC.

`aud:` is resolved when GitLab expands the configuration, while an `env` value
would only be resolved later, by the shell inside the job. An environment
shorthand could therefore drive the audience only by declaring *one id_token per
environment* — so every job would be handed a credential for an instance it does
not deploy to, and adding a third environment would silently add a third to
everyone's pipeline.

Under OIDC there is no deploy token to carry the endpoint, so the endpoint has to
be named anyway — and its origin is exactly the audience. One value does the
whole job:

```yaml
include:
  - component: $CI_SERVER_FQDN/behindgate/deploy-action/deploy@v1
    inputs:
      path: dist
      app-origin: https://app.behindgate.com    # the default
```

That single input fixes three things that must agree: the audience GitLab mints
the token for, the endpoint it is exchanged at, and the host the CLI is
downloaded from. `url` and `download-base-url` still win where you set them — an
explicit value is never replaced by a derived one — but you should not normally
need either.

**It is an origin, not a URL.** Scheme and host — no path, and **no trailing
slash**. Both are refused rather than tidied up, which is worth explaining
because it looks unhelpfully strict:

GitLab mints the token's `aud` from this input when it *expands the
configuration*, long before the job's shell runs. By then the audience is fixed.
Trimming a trailing slash inside the job could not change what the token already
claims — it would only leave the derived endpoint disagreeing with the audience,
while appearing to have handled it. An audience is compared as an exact string,
so `https://app.behindgate.com/` is a *different* audience, not a tidier spelling
of the same one. Refusing it is the only outcome that keeps the two identical.

**https only.** This value is the audience for a bearer credential, so
clear-text is not offered. To reach a local instance, override `url` and
`download-base-url` and authenticate with a deploy token.

**The endpoint is the releases collection**, `app-origin` +
`/api/deploy/releases`. The CLI posts there to create a release and derives its
sibling routes by trimming that last segment — including `/api/deploy/oidc/token`,
where the credential exchange happens. Naming the parent puts release creation on
the wrong route, and the bare host is fronted by a CDN that answers a POST with
`403 text/html`. A build-time check in
[`script/build-gitlab-template.js`](../script/build-gitlab-template.js) refuses to
generate the component if any environment in
[`src/core/environments.js`](../src/core/environments.js) — the same file the
Action reads — stops matching that convention.

**Instances differ in whether they republish.** Production publishes a version
once, so a committed checksum describes it for good; the test environment
rebuilds under the same version number, so a pin there describes what it served
when the pin was captured. The job says so, and a checksum failure against it
means the build was replaced rather than that anything is wrong.

**An instance this component does not name still works**, with a warning. The
checksum is committed here rather than served by the host, so an unknown host
cannot substitute a binary — it can only fail verification. That makes refusing
one pointless, and would rule out local instances entirely.

## How the CLI is verified

The component pins a SHA256 per platform and refuses to execute a download that
does not match. Verification happens on the archive **before** it is extracted,
so a tampered archive is never unpacked at all.

**The checksums are inlined into the template**, rather than read from
`versions.json` the way the Action reads them. That is forced: a component is
YAML merged into *your* pipeline, and this repository is never checked out on
your runner, so there is no `versions.json` to read at job time. Fetching one
from the download host would defeat the purpose — a host able to serve a modified
binary can serve a matching hash beside it. The inline copy is generated by
[`script/build-gitlab-template.js`](../script/build-gitlab-template.js) and CI
fails if it drifts from `versions.json`.

**Nothing is cached between jobs.** Caching would mean writing into the project
directory, which this component does not do — see above. The archive is fetched
and verified once per job and discarded with the temporary directory.

## Supported runners

Linux and macOS, on `amd64` and `arm64`.

Windows runners use PowerShell rather than a POSIX shell, so this component
cannot run there; it fails with an explicit message rather than part-way through.
Use the GitHub Action, or invoke the CLI directly.

The default `alpine:3.22` image provides everything needed. Any image with a
POSIX shell, `tar`, `sha256sum` (or `shasum`), and `curl` or `wget` works.

## Failure messages

The CLI's two failure modes need different fixes, and are reported differently:

- **exit 2 (configuration)** — rejected before deploying: a malformed credential,
  a bad path, a failed OIDC exchange, or a `url` that disagrees with the endpoint
  a deploy token was minted for. The component checks the credential's shape and
  the path itself first, so what remains depends on how the job authenticated,
  and the message is written for whichever one ran:
  - *over OIDC* — the workspace has no CI trust covering this pipeline, or more
    than one does and none was named with `trust`. If you redefined the job,
    check that `aud:` is still exactly the `app-origin` input; a token minted for
    one audience cannot be exchanged at another.
  - *with a deploy token* — expired, revoked, or issued for another instance.
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
