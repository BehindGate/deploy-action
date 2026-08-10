# Deploy to BehindGate — Bitbucket Pipe

The Bitbucket counterpart of this repository's GitHub Action. Both download the
`bg-deploy` CLI, verify it against a checksum committed here, and deploy your
build. Neither reimplements the deploy protocol, so they cannot drift apart in
what a deploy actually does.

A Pipe is a Docker image Bitbucket runs with your build directory mounted and
pipe variables injected as environment variables. Because the image carries its
own filesystem, this wrapper reuses [`src/core/`](../src/core/) exactly as the
Action does — the [GitLab component](gitlab-component.md) cannot, which is why
that one is shell.

## Quick start

```yaml
image: node:24

pipelines:
  branches:
    main:
      - step:
          name: Build
          script:
            - npm ci && npm run build
          artifacts:
            - dist/**

      - step:
          name: Deploy
          script:
            - pipe: docker://behindgate/deploy-pipe:1
              variables:
                DEPLOY_PATH: dist
                BEHINDGATE_TOKEN: $BEHINDGATE_TOKEN
                # Pin the endpoint rather than trusting the token's own claim.
                DEPLOY_URL: https://app.behindgate.com/api/deploy
```

`DEPLOY_PATH` should point at your build output — the folder whose *contents*
become the site, so that `index.html` sits at the top of it.

**Declare the build output as `artifacts:`.** Bitbucket does not carry a build
directory between steps otherwise, and the deploy step will fail with a path
that does not exist.

## Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DEPLOY_PATH` | yes | — | Folder to deploy, or an existing `.zip` to upload as-is. |
| `BEHINDGATE_TOKEN` | yes | — | BehindGate deploy token. Store it as a **Secured** repository variable. |
| `DEPLOY_URL` | no | — | Pin the deploy endpoint. **Strongly recommended** — see below. |
| `CLI_VERSION` | no | `defaultVersion` from [`versions.json`](../versions.json) | Escape hatch to hold a specific `bg-deploy` version after a bad release. Normally leave unset. |
| `DOWNLOAD_BASE_URL` | no | `https://app.behindgate.com` | Host to download the CLI from, when the image carries no baked archive for the requested version. |

### Why the path variable is not called `PATH`

Bitbucket injects pipe variables as environment variables, so a variable named
`PATH` replaces the container's executable search path rather than telling the
pipe what to deploy — and then nothing in the step can run at all. The pipe
detects that specific mistake and says so, rather than failing with an error
that has nothing to do with the cause.

## The token

Add **`BEHINDGATE_TOKEN`** under **Repository settings → Repository variables**,
marked **Secured**, and pass it through explicitly in the `variables:` block.
Generate the value in the BehindGate dashboard under **Settings → Deploy
tokens**.

Secured variables are masked in the log by Bitbucket. The pipe never echoes the
token: it goes to the CLI through the environment, never on the command line, so
it cannot surface in a process listing either.

An unset variable expands to an empty string rather than failing the build, so
the pipe checks for that explicitly and names it — it is the most common way
this step goes wrong.

## Outputs

The pipe writes **`behindgate.env`** into the build directory:

```
BEHINDGATE_RELEASE_ID=rel_01J8ZQ
BEHINDGATE_URL=https://demo.behindgate.com/my-app/
```

Bitbucket steps do not share an environment, so a file is the handoff. Declare
it as an artifact to read it in a later step:

```yaml
- step:
    name: Deploy
    script:
      - pipe: docker://behindgate/deploy-pipe:1
        variables:
          DEPLOY_PATH: dist
          BEHINDGATE_TOKEN: $BEHINDGATE_TOKEN
    artifacts:
      - behindgate.env

- step:
    name: Smoke test
    script:
      - source behindgate.env
      - curl -fsS "$BEHINDGATE_URL" > /dev/null
```

Both keys are always written, so a consumer can tell "deployed, address unknown"
from "never ran".

## Why you should pin `DEPLOY_URL`

A BehindGate deploy token is not only a credential. It is *also* a routing
instruction: the endpoint the CLI uploads to is a claim inside the token itself.

That means anyone who can change your `BEHINDGATE_TOKEN` variable can point your
builds at a host they control — and **nothing in the step looks wrong**. The
upload succeeds, the CLI prints `✓ Deployed`, the step exits `0`, and the
pipeline goes green. Your real site simply stops receiving updates while your
build output goes somewhere else.

Setting `DEPLOY_URL` removes that, in two ways. The destination lives in
`bitbucket-pipelines.yml`, where code review and branch permissions cover it
rather than repository settings a single compromised account can rewrite — and
since CLI 2026.8.0, a token whose own claim disagrees with your pinned value is
**refused outright** rather than silently overridden.

**Finding your endpoint.** Run the step once *without* `DEPLOY_URL`. The CLI
reports the endpoint it used on its first line:

```
Deploying to https://app.behindgate.com/api/deploy
```

Never put the endpoint in a *Secured* variable. It is not sensitive, and storing
it beside the token means one compromised store controls both the credential and
the destination — which looks like pinning while providing none of its benefit.

If you omit it, the step emits a warning explaining what it is trusting.

## How the CLI is verified

The pinned archive is **baked into the image at build time** and verified against
[`versions.json`](../versions.json) then — and verified again, against the same
pin, on every run before it is unpacked. The common path therefore involves no
download at all, and no run reaches an unverified binary.

Storing the archive rather than the unpacked binary is deliberate. It keeps one
code path for baked and downloaded archives, and it means an image whose
contents were altered after the build is caught by the same check that catches a
tampered download — the pin lives in this repository, which the registry cannot
rewrite.

If the image carries no archive for the requested version — which happens when
`CLI_VERSION` selects an older pin — the pipe downloads it and verifies it
identically before use.

## Supported platforms

`linux/amd64`, which is what Bitbucket Cloud runs.

The Dockerfile reads `TARGETARCH` and would build `arm64` unchanged, but that
needs QEMU emulation on the release runner and nothing here can exercise the
result. It is left unpublished rather than shipped untested — relevant only for
self-hosted runners on ARM.

## Failure messages

The CLI's two failure modes need different fixes, and are reported differently:

- **exit 2 (configuration)** — rejected before deploying: a missing or malformed
  token, a bad path, or a `DEPLOY_URL` that disagrees with the endpoint the token
  was minted for. The pipe validates the token format and the path itself first,
  so an exit 2 with `DEPLOY_URL` set is most often that endpoint mismatch, and
  the message says so.
- **exit 1 (runtime)** — the deploy itself failed: the endpoint rejected the
  release, the runner could not reach it, or the upload was interrupted. Often
  transient and worth retrying.

## Development

```bash
docker build -t behindgate/deploy-pipe:dev .
node --test test/integration/bitbucket-deploy.test.js
node --test test/unit/bitbucket-variables.test.js
```

The integration tests run [`src/bitbucket/index.js`](../src/bitbucket/index.js)
as a process, exactly as the container's `ENTRYPOINT` does, against two local
servers: one serving the real `bg-deploy` archive so download-and-verify runs for
real, one capturing the deploy. They need no credentials.

Both CLI paths are covered — the baked archive and the download fallback — as is
the checksum refusal, using deliberately corrupted bytes, asserting the binary is
never executed.

The image itself is covered by the `pipe` job in
[`ci.yml`](../.github/workflows/ci.yml), which builds it, runs it with no
configuration and asserts it reports the empty token, and checks the baked
archive is where the entrypoint looks for it.

## Publishing

[`pipe-publish.yml`](../.github/workflows/pipe-publish.yml) builds and pushes
`behindgate/deploy-pipe` on each published release, tagging both the full version
and the floating major. It needs `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
repository secrets, and skips itself when they are absent.

It uses no third-party actions. The job holds registry credentials, and every
`uses:` in it would be code someone else can change under a mutable tag; the
docker CLI is already on the runner. It also runs the built image once and
checks it reports its configuration correctly before the credentials are
anywhere near the shell.

Consumers reference `docker://behindgate/deploy-pipe:1`, so the floating major
tag is what actually runs — the same convention as `@v1` for the Action.
