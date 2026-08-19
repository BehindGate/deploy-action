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
```

Pin a tag or a commit SHA, never a branch. A remote include is fetched fresh on
every pipeline, so a moving ref means the file that runs your deploy can change
without a commit in your project — which is the same problem `url` pinning
exists to solve, one level up.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `path` | yes | — | Folder to deploy, or an existing `.zip` to upload as-is. |
| `env` | no | `prod` | Environment to deploy to: `prod` or `test`. Selects the deploy endpoint **and** the CLI download host together. |
| `url` | no | from `env` | Override the deploy endpoint. Only for an endpoint `env` does not name. |
| `cli-version` | no | `defaultVersion` from [`versions.json`](../versions.json) | Escape hatch to hold a specific `bg-deploy` version after a bad release. Normally leave unset. |
| `download-base-url` | no | from `env` | Override the CLI download host. Only for a host `env` does not name. |
| `stage` | no | `deploy` | Stage the job runs in. |
| `image` | no | `alpine:3.22` | Image the job runs in. Needs a POSIX shell, `tar`, `mktemp`, and `curl` or `wget`. |

The job also needs one writable, **exec-capable** directory outside the project
directory to unpack the CLI into. It tries `$CI_BUILDS_DIR` first — the project
directory's own parent, so the runner already executes from that filesystem —
then `$TMPDIR` or `/tmp`. Each candidate is proven by running something from it,
because `/tmp` is mounted `noexec` on plenty of hardened runners and the failure
that produces is a bare "Permission denied" from a binary that was just
verified. If neither qualifies the job says so and names both; set `TMPDIR` on
the job to somewhere that does.
| `job-name` | no | `behindgate-deploy` | Name of the generated job. |

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

## Choosing the environment

`env` selects the two addresses that have to agree — the deploy endpoint and the
host the CLI is downloaded from. They are not the same URL and neither derives
from the other, so both come from one table generated from
[`src/core/environments.js`](../src/core/environments.js), the same file the
Action reads. An unrecognised value is refused rather than falling back to a
default and deploying somewhere you did not ask for.

```yaml
include:
  - component: $CI_SERVER_FQDN/behindgate/deploy-action/deploy@v1
    inputs:
      path: dist
      env: prod        # the default; `test` is the other
```

`url` and `download-base-url` still win where you set them — an explicit value is
never replaced by one derived from a shorthand — but you should not normally need
either.

**The endpoint is the releases collection**, `/api/deploy/releases`. The CLI
posts there to create a release and derives its sibling routes by trimming that
last segment, so naming the parent puts release creation on the wrong route, and
the bare host is fronted by a CDN that answers a POST with `403 text/html`.

**`env: test` republishes.** Production publishes a version once, so a committed
checksum describes it for good; the test environment rebuilds under the same
version number, so a pin there describes what it served when the pin was
captured. The job says so, and a checksum failure against it means the build was
replaced rather than that anything is wrong.

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
