# BehindGate CI components

GitLab CI/CD components for [BehindGate](https://behindgate.net). One so far:

## `deploy`

Deploy a static site to BehindGate from GitLab CI in one `include`.

The pipeline stores no long-lived secret. The job mints an OIDC token for the
run and the `bg-deploy` CLI exchanges it for a deploy token that lives fifteen
minutes, so what the workspace trusts is the project, not a credential someone
pasted into a variable.

## Quick start

```yaml
include:
  - component: gitlab.com/behindgate/ci/deploy@2
    inputs:
      path: public
      site-url: https://docs.example.com
```

`path` points at your build output — the folder whose *contents* become the app,
so that `index.html` sits at the top of it.

`site-url` names the target as the URL it serves on: the **host** names the site,
the **path** names the app.

That needs a CI trust for this project in the workspace, under
**Settings → CI trusts**. Without one the exchange is refused and the job says so.

## With a build step

```yaml
stages: [build, deploy]

build:
  stage: build
  image: node:22
  script:
    - npm ci && npm run build
  artifacts:
    paths: [dist]

include:
  - component: gitlab.com/behindgate/ci/deploy@2
    inputs:
      path: dist
      site-url: https://docs.example.com
```

## A subgroup of prototypes

Where a group of short-lived projects each want a path on one site, the path can
come from the project itself instead of being written out per project — the
input is expanded at job runtime, so predefined variables work inside it:

```yaml
include:
  - component: gitlab.com/behindgate/ci/deploy@2
    inputs:
      path: public
      site-url: https://prototypes.example.com/$CI_PROJECT_NAME
      create-app: true
```

Every project in the group then carries the same four lines and lands on its own
path. `$CI_PROJECT_PATH_SLUG` instead of `$CI_PROJECT_NAME` gives an
instance-unique value, at the cost of a longer URL; two projects named `docs` in
different groups otherwise collide on one path, and the CI trust does not catch
that because it scopes to the site rather than to a path within it.

Do this for apps whose URL nobody has bookmarked. **With `create-app`, renaming
the project silently relocates the app**: the next pipeline derives a new path,
finds nothing there, creates a second app, and leaves the old one serving the
last release at the URL people were using. Nothing fails, which is what makes it
worth avoiding. For an app that is a product surface, write the path literally.

## Per-merge-request previews

Deploy each merge request to its own app and tear it down when it closes.

```yaml
include:
  - component: gitlab.com/behindgate/ci/deploy@2
    inputs:
      job-name: preview
      path: dist
      site-url: https://docs.example.com/preview/mr-$CI_MERGE_REQUEST_IID
      create-app: true
      rules:
        - if: $CI_PIPELINE_SOURCE == "merge_request_event"

  - component: gitlab.com/behindgate/ci/deploy@2
    inputs:
      job-name: teardown
      site-url: https://docs.example.com/preview/mr-$CI_MERGE_REQUEST_IID
      delete-app: true
      rules:
        - if: $CI_MERGE_REQUEST_EVENT_TYPE == "merge_train"
          when: never
        - if: $CI_PIPELINE_SOURCE == "merge_request_event"
          when: manual
```

The teardown job needs no `path`: it uploads nothing. Deleting a path with no app
succeeds, so the job is safe to re-run and safe on a merge request that never got
a preview.

Give the trust "create apps" and "delete apps" over the site, or the two flags
fail with an exit 2 naming the missing permission.

Without `create-app`, deploying to a path that has no app is an error rather than
a silent creation — a mistyped path cannot quietly become an app nobody looks at.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `site-url` | *(none)* | Where the release is served: host = site, path = app. Required with a CI trust. |
| `path` | `public` | Folder to deploy, or an existing `.zip`. Not needed with `delete-app`. |
| `audience` | `https://app.behindgate.com` | The BehindGate host to deploy to. Selects the endpoint, the CLI download host, and the id_token's `aud`. |
| `url` | *(from `audience`)* | Pin the deploy endpoint. The **releases collection**, not the site URL and not the bare host. |
| `trust-id` | *(none)* | Which CI trust to exchange under, when more than one covers the pipeline. |
| `create-app` | `false` | Create the app `site-url` names if it is missing. |
| `delete-app` | `false` | Delete that app and exit. |
| `cli-version` | *(pinned)* | Pin a `bg-deploy` version. |
| `job-name` | `deploy` | Name of the contributed job. |
| `stage` | `deploy` | Stage it runs in. |
| `image` | `alpine:3.22` | Needs a POSIX shell, curl, tar and sha256sum. |
| `rules` | default branch | Rules for the job. |

`audience` is the only name for the environment, and there is deliberately no
friendlier `prod`/`test` switch beside it. GitLab mints the id_token from the
`id_tokens` keyword *before* the job script runs, so its `aud` is fixed before
anything could derive it from a shorter input — and component inputs are textual
substitution, with no conditionals to select one. Everything else is derived from
this one value, so the two cannot disagree.

Deploying to test is therefore:

```yaml
include:
  - component: gitlab.com/behindgate/ci/deploy@2
    inputs:
      path: public
      site-url: https://prototypes.example.com/hello
      audience: https://app.test.behindgate.net
```

## Outputs

The job writes a `dotenv` report, so any later job in the pipeline can read:

- `BEHINDGATE_DEPLOYED_URL` — where the release is served
- `BEHINDGATE_RELEASE_ID` — the release it published

## Deploying with a token instead

A project with no CI trust can use a deploy token, generated in the workspace
under **Settings → Deploy tokens**. Set it as a **masked** CI/CD variable named
`BEHINDGATE_TOKEN`; the CLI prefers it over the OIDC exchange and it carries its
own endpoint and target app.

It is not a component input on purpose: an input is written into the pipeline
definition and echoed in the job log, which is not where a credential belongs.
A deploy token is also pinned to one app that already exists, so `create-app`
and `delete-app` do not work with it.

## How the CLI is verified

The job downloads `bg-deploy` from the environment's download host and checks it
before running it.

For production the expected SHA256 is **committed in this component**. A checksum
served by the same host as the binary proves only that the download arrived
intact — anyone able to serve a modified binary can serve a matching line beside
it. A hash in this repository is the part that host cannot rewrite.

For the test host there is nothing to pin against: it republishes a version in
place, so a committed hash would describe a build only until someone rebuilds it.
The job verifies against the host's own `SHA256SUMS.txt` and says in the log that
this is integrity in transit, not provenance.

## Failure messages

| Exit | Means |
| --- | --- |
| 1 | The deploy failed: network, upload, or the server rejected the release. |
| 2 | Configuration: bad inputs, a missing `path`, a missing or malformed token, an endpoint mismatch, or a permission the CI trust does not hold. |

`this pipeline is not trusted to deploy` means the workspace has no CI trust
matching this project — check the repository, and the branch if the trust names
one.

## Source

This component is maintained alongside the GitHub Action at
[github.com/behindgate/deploy-action](https://github.com/behindgate/deploy-action),
under `gitlab/`. Changes are made there and pushed here.

## License

MIT.
