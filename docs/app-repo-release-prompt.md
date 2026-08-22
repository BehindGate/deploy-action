# Prompt: fix the `bg-deploy` release process in `behindgate/app`

Copy everything below the line into a session working on the `behindgate/app`
repository.

---

You are working in `behindgate/app`. This task is about `bg-deploy`, the
static-site deploy CLI — a single static Go binary, published as per-platform
archives from `https://app.behindgate.com/downloads/`.

The CLI lives at `deployer/`: the shipped binary records its module as
`github.com/behindgate/app/deployer`, so it is its own Go module inside this
repo. The web app ships from the same repo and the same commit — the deployed
`index.html` carries `<!-- build: 2026.07.1 79f1f9f-dirty -->`, matching the
CLI's `bg-deploy 2026.07.1 (git 79f1f9f)`. Confirm the exact layout before
starting; everything below is derived from published artifacts, not from reading
this repository.

`bg-deploy` is now the shared core for BehindGate's CI integrations. The GitHub
Action (`behindgate/deploy-action`) wraps it, and a Bitbucket Pipe and a GitLab
component are planned. All three are deliberately thin — none reimplements the
deploy HTTP protocol — so anything the CLI does not expose, none of them can
offer. That constraint motivates most of what follows.

**Provenance of these findings.** All of it came from black-box testing of
`bg-deploy 2026.07.1 (git 79f1f9f)` while building the Action: running the real
binary, pointing it at a local capture server with `--url`, probing the download
host, and reading metadata out of the published archives. Nothing here came from
reading source. **Re-verify anything you act on** — some of it may already have
changed, and some may be wrong about internals.

## Status as of 2026-08-09 (bg-deploy 2026.8.3)

Most of this brief has shipped. Verified against the published artifacts:

| Item | Status |
| --- | --- |
| Clean, tagged builds | **done** — `vcs.modified=false`, full SHA in `--version` |
| Versioned, immutable URLs + `index.json` | **done** |
| Valid semver version string | **done** — `2026.8.3` |
| `--json` and the deployed URL in output | **done** — stdout is pure JSON, progress on stderr |
| `BEHINDGATE_URL`, flag precedence, mismatch detection | **done** — mismatch is fatal (exit 2), stricter than proposed |
| Unified exit codes | **done** — credential problems are all exit 2 |
| Stripped binaries | **done** — download halved, 5.0 MB → 2.5 MB |
| `windows-arm64` | **done** |
| `--help` exits 0 | **done** |
| **Signed releases** | **outstanding** — `.sig` paths still 403 |

**What remains is signing**, and it is now the only thing standing between the
integrations and dropping their pinned checksum tables. The section below is
unchanged and still applies; everything above it is retained as a record of what
was asked for and why.

## Where to start

The single most important item is that **the published binary was built from a
dirty working tree**, so it corresponds to no commit. Everything else is worth
less until that is fixed: signing an unreproducible artifact attests only that
someone blessed a pile of bytes, not that those bytes came from reviewed source.

Suggested order:

1. **Release from a clean, tagged commit** — prerequisite for everything else.
2. **Sign the releases** — unblocks "always current" for all three integrations.
3. **Versioned, immutable URLs** — incident recovery, not reproducibility.
4. **Fix the version scheme** — one character, unblocks tool caching everywhere.
5. **Machine-readable output** — stops wrappers parsing console text.
6. **Endpoint pinning**, **exit codes**, then **small fixes** (one halves the
   download size).

Each task has acceptance criteria. Where one changes observable behaviour, keep
backward compatibility unless stated otherwise: wrappers currently pin specific
CLI versions and will keep doing so until signing lands.

## 1. Release from a clean, tagged commit

**Problem.** Go embeds build metadata in the artifact, and the published binary
says it was built from modified sources:

```
build  vcs.modified=true
build  vcs.revision=79f1f9ff1e3ed8b7383e0bc937cfa5afcf429dca
build  vcs.time=2026-07-31T13:07:03Z
mod    github.com/behindgate/app/deployer  v0.0.0-20260731130703-79f1f9ff1e3e+dirty
```

The web app is affected too (`79f1f9f-dirty` in its build marker), so this looks
like a property of the release tooling rather than one person's mistake.

**Why it matters.** `git 79f1f9f` in `--version` is not true of the artifact
customers execute — the tree had uncommitted changes, so that commit does not
describe it. Nobody can rebuild the binary, diff it against source, bisect a
regression to a commit, or answer "what code is running in our CI?" with
evidence. A security review of this repository says nothing about the artifact.

**Do this.**

- Build releases only in CI, triggered by a tag, from a clean checkout.
- **Fail the release when `vcs.modified` is true.** Go records it for free; make
  it a hard gate, not a warning. Apply it to the web app build as well.
- Build with `-trimpath` and a pinned Go toolchain (the shipped binary reports
  `go1.24.13`) so path and toolchain drift do not change output.
- Embed the tag, the full commit SHA and the build time; have `--version` print
  the full SHA rather than a seven-character prefix.
- Ideally make builds byte-reproducible, so an independent rebuild of a tag
  reproduces the published archive. Static Go binaries are close to this already.

**Acceptance criteria.**

- A release build from a dirty tree fails instead of publishing.
- `--version` reports a commit that exists in this repo and fully describes the
  artifact.
- Rebuilding a published tag on a clean checkout reproduces the published bytes,
  or the differences are documented and understood.

## 2. Sign the releases

**Problem.** `SHA256SUMS.txt` is served by the same host as the binaries it
describes. It proves only that a download was not truncated in transit: anyone
able to serve a modified binary can serve a matching checksum beside it, and the
check still passes.

**Why it matters.** The GitHub Action works around this by committing
per-platform hashes into its own repository, where the download host cannot
rewrite them and any change requires a reviewed commit. That works, but the cost
is structural:

- The Bitbucket Pipe and GitLab component each need their own copy of the same
  table, and all three must move in lockstep on every CLI release.
- **It forces every wrapper to pin a version it does not want to pin.** A hash
  identifies one specific build, so "verify against a committed hash" and "always
  take the current build" are mutually exclusive. Against a SaaS backend that is
  backwards: the server moves regardless, so a pinned client gains nothing and
  drifts out of step with the service it talks to. The Action currently carries a
  scheduled job that follows the published CLI and opens a PR — machinery that
  exists solely because signatures do not.

**Do this.**

- Sign each release with a key that does **not** live on the download host —
  Sigstore/cosign keyless signing (bound to the release workflow's OIDC identity)
  or minisign with the public key published in this repo.
- Publish detached signatures alongside artifacts
  (`bg-deploy-linux-amd64.tar.gz.sig`) and a signature over `SHA256SUMS.txt`.
- Document the verification command in the release notes.
- Consider a SLSA provenance attestation, which cosign gives you cheaply once
  builds are clean and tagged.

**Acceptance criteria.**

- Every artifact has a detached signature verifiable with a documented public key
  or via the Sigstore transparency log.
- Verification instructions are reproducible by someone with no BehindGate access.
- Signatures cover the versioned paths from the next section.

Once this lands, every wrapper can drop its pinned table and verify at runtime.

## 3. Versioned, immutable download URLs

**Problem.** Archives are published only at unversioned paths:

```
https://app.behindgate.com/downloads/bg-deploy-<os>-<arch>.tar.gz
https://app.behindgate.com/downloads/SHA256SUMS.txt
```

Every versioned path shape probed returns 403 (`/downloads/v2026.07.1/...`,
`/downloads/2026.07.1/...`, `/downloads/bg-deploy-linux-amd64-2026.07.1.tar.gz`,
`/downloads/bg-deploy-2026.07.1-linux-amd64.tar.gz`), and `/downloads/` returns
the SPA shell rather than an index.

**Why it matters.** Not reproducibility — against a SaaS backend, holding an old
client gives none. The real cost is **incident recovery**: when a release
regresses there is no way back, because the previous bytes are gone from the only
URL that exists. Every customer is on the broken build simultaneously until a fix
ships. Versioned URLs turn rollback into a one-line workflow change.

**Do this.**

- Publish immutable versioned artifacts; a published path must never change
  content:
  ```
  /downloads/2026.7.1/bg-deploy-linux-amd64.tar.gz
  /downloads/2026.7.1/SHA256SUMS.txt
  ```
- Keep unversioned paths as a `latest` alias for humans and existing scripts.
- Publish an index so tooling can resolve versions without scraping:
  ```
  /downloads/index.json
  {"latest":"2026.7.1","versions":[{"version":"2026.7.1","released":"2026-07-31",
    "platforms":["linux-amd64","linux-arm64","darwin-amd64","darwin-arm64","windows-amd64"]}]}
  ```
- Use the same layout in every environment. Production is `app.behindgate.com`;
  test is `app.test.behindgate.net`. They currently serve byte-identical archives
  for 2026.07.1 — verified by downloading all five platforms from both and
  hashing locally. Keep that property: build once and promote the same artifact,
  never rebuild per environment.

**Acceptance criteria.**

- A versioned URL returns identical bytes before and after a later release.
- `/downloads/index.json` lists every published version.
- Unversioned paths still resolve to the newest release.
- Production and test serve the same layout and the same bytes per version.

## 4. Fix the version scheme

**Problem.** `2026.07.1` is not valid semver: the `07` minor component has a
leading zero, which the spec forbids.

This is not cosmetic. `@actions/tool-cache` keys its cache on semver, silently
treats a non-semver version as a *range*, matches nothing, and re-downloads the
binary on **every** CI run. A cache miss is indistinguishable from a cold start,
so nobody notices. The Action currently normalises `2026.07.1` → `2026.7.1` to
work around it, and every future integration will need the same workaround.

**Do this.** Drop the leading zero: publish `2026.7.1`.

That keeps the calendar-style release train — which appears to be repo-wide,
since the web app and the CLI share `2026.07.1` and commit `79f1f9f` — while
making the string valid semver, correctly ordered, and directly usable by every
package and cache tool in the ecosystem. It is a one-character change to the
version formatter, not a versioning-policy change.

If the CLI ever needs to release independently of the web app, give it its own
tag namespace (`deployer/v2026.7.1`) rather than decoupling the numbers.

**Acceptance criteria.**

- `bg-deploy --version` reports a string that passes a standard semver parser.
- Published artifact paths and `index.json` use the same string.

## 5. Expose machine-readable output

**Problem.** On success the CLI prints only the release id:

```
✓ Deployed. Release rel_01J8ZQ4M2N is live.
```

The format string in the binary is `" Deployed. Release %s is live."`. The deploy
API returns the site's public address — both the create-release and publish
responses carry a `url` field — but the CLI never echoes it. There is no
structured output mode: `--json`, `--output`, `--format`, `--quiet` and
`--verbose` are all rejected with `flag provided but not defined`.

**Why it matters.** The Action declares a `url` output and writes a job summary,
both meant to link the deployed site — the most useful thing to surface after a
deploy. The CLI is the only interface and the wrappers must stay thin, so there
is nothing to read and `url` currently ships **empty**. Deriving it from the
deploy endpoint was considered and rejected: the endpoint is the API address, not
the site's, so it would put a non-resolving link in every job summary.

Console output is also currently the *only* machine-readable surface, so all
three integrations must parse human-facing text that any wording change breaks.

**Do this.**

- Add `--json`, writing one object to stdout and suppressing human output:
  ```json
  {"releaseId":"rel_01J8ZQ4M2N","url":"https://demo.behindgate.com/my-app/",
   "endpoint":"https://app.behindgate.com/api/deploy","status":"published","version":"2026.7.1"}
  ```
  Emit errors in the same shape (`{"error":{"code":"not_a_jwt","message":"..."}}`).
- Independently, print the address in human output:
  ```
  ✓ Deployed. Release rel_01J8ZQ4M2N is live at https://demo.behindgate.com/my-app/
  ```

Both are worth doing: `--json` is the durable contract for three integrations,
the human line is what someone reading a log actually wants.

**Acceptance criteria.**

- `--json` parses as a single object and contains the deployed URL.
- Human output includes the deployed URL on success.
- With `--json`, nothing non-JSON reaches stdout (diagnostics to stderr).
- Consumers parsing the current success line keep working — add the URL, do not
  reformat the line.

## 6. Endpoint pinning: env var, precedence, mismatch detection

**Delivered in 2026.8.5.** `BEHINDGATE_URL` is accepted and `--url` wins over it,
as asked below. The same release went further than this section did and put the
whole contract in the environment — `BEHINDGATE_SITE_URL`, `BEHINDGATE_OIDC_TOKEN`
and `BEHINDGATE_TRUST_ID` alongside it — which is what let the GitLab component in
[`gitlab/`](../gitlab/) be a shell job instead of a wrapper. `--require-url-match`
is the one item here still open.

**Problem.** `--url` is the only way to pin the deploy endpoint. Verified by
testing: exporting `BEHINDGATE_URL` has no effect — with a token claiming a dead
port and `BEHINDGATE_URL` pointing at a live server, the CLI tried the dead port
and failed.

**Be precise about what an env var buys.** Accepting `BEHINDGATE_URL` is worth
doing, but it is an *ergonomics* change, not a security one, and the docs should
say so. The protection `--url` gives comes from *where the value lives and who can
change it* — a workflow file under version control and review — not from the
channel it arrives on. Set as a CI secret beside `BEHINDGATE_TOKEN`, both live in
one mutable store and whoever can rewrite one can rewrite the other: that looks
like pinning while providing none of its benefit, which is worse than not pinning,
because it is believed.

The real reason to add it is portability — Bitbucket Pipes and GitLab components
are configured through environment variables, not argv — and it will increase how
many people pin at all. That has since paid off: the GitLab component sets
`BEHINDGATE_URL` and never builds an argv the consumer can see.

**Do this.**

1. **Accept `BEHINDGATE_URL`** as an alternative to `--url`.
2. **Make `--url` win over `BEHINDGATE_URL`.** This *is* a security requirement:
   if the environment could override an explicit flag, anyone able to inject an
   env var could silently redirect a deploy its author had pinned in argv.
   Precedence: `--url` > `BEHINDGATE_URL` > token claim.
3. **Report when the pinned endpoint disagrees with the token's claim.** The
   highest-value item here. Today `--url` silently overrides a conflicting claim —
   but that disagreement is exactly the fingerprint of a swapped token, and
   discarding it throws away the only evidence of an attempted redirect.
   ```
   warning: token claims endpoint https://evil.example/api/deploy
            but deploying to https://app.behindgate.com/api/deploy (pinned)
   ```
   Offer `--require-url-match` (or `BEHINDGATE_REQUIRE_URL_MATCH=1`) to make it
   fatal, so CI fails loudly rather than deploying correctly while an attacker
   learns their swapped token went unnoticed.

**Acceptance criteria.**

- `BEHINDGATE_URL` pins the endpoint when `--url` is absent.
- `--url` overrides it; a test covers that precedence explicitly.
- A pinned endpoint differing from the token claim warns, naming both values.
- `--require-url-match` turns that warning into a non-zero exit.

## 7. Make exit codes consistent

**Problem.** Observed behaviour of 2026.07.1:

| Invocation | Exit | Message |
| --- | --- | --- |
| `BEHINDGATE_TOKEN` unset/empty | **2** | `error: BEHINDGATE_TOKEN is not set` |
| `BEHINDGATE_TOKEN=not-a-jwt` | **1** | `error: not a JWT (expected header.payload.signature)` |
| token with undecodable payload | **1** | `error: token payload is not valid base64url` |
| no `<path>` | 2 | `error: exactly one <path> ... is required` |
| unknown flag | 2 | `flag provided but not defined` |

A *missing* credential exits 2 while a *malformed* credential exits 1. Both are
the same class of problem — a bad secret — so a caller cannot use the exit code to
separate "your configuration is wrong" from "the deploy failed". Exit 1 currently
mixes bad tokens with network failures and server rejections.

The CLI also validates the token *before* checking `<path>` exists, so a typo in
the path surfaces as a confusing token error.

**Do this.** Pick one and document it in `--help`:

- treat every credential problem as exit 2 (configuration error), leaving 1 for
  genuine runtime failures; or
- add a distinct code (e.g. 3) for auth problems, keeping 2 for argument shape.

Validate `<path>` before the token so path errors report themselves.

**Acceptance criteria.**

- Missing and malformed tokens share an exit code.
- That code differs from network failures and server rejections.
- `--help` documents the full set.
- A non-existent `<path>` reports a path error regardless of token validity.

## 8. Small fixes

- **Binaries ship unstripped, roughly doubling the download.** `file` reports
  `with debug_info, not stripped`. Measured on `linux-amd64`:

  | | binary | gzipped (what is downloaded) |
  | --- | --- | --- |
  | as shipped | 8,889,884 | 4,986,491 |
  | stripped | 6,023,320 | 2,519,056 |

  Building with `-ldflags="-s -w"` cuts the archive from ~5.0 MB to ~2.5 MB — a
  **~50% reduction**, paid on every cold CI run by every customer across five
  platforms. Keep an unstripped build available for debugging if you want
  symbols, but do not make it the default download.

- **`--help` exits 2.** Both `--help` and `-h` print usage and exit **2**.
  Requesting help successfully is not an error; it should exit 0. Usage printed
  *because of* a bad invocation should keep exiting 2. This trips CI wrappers that
  run `--help` as a smoke test.

- **No `windows-arm64` build.** Published platforms are `linux-amd64`,
  `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`. Windows ARM64
  runners are increasingly common and the Action has to fail explicitly on them.
  Should be a build-matrix line.

- **Consider an outdated-client signal.** Since clients should track the current
  build, have the deploy API return the minimum/current supported CLI version (a
  response header is enough) and have the CLI warn when it is behind. That closes
  the loop rather than relying on everyone upgrading unprompted.

## Do not regress

These behaviours are load-bearing for the CI integrations and are covered by
tests in `behindgate/deploy-action`:

- **Given a folder, the CLI zips its CONTENTS, not the folder.** `index.html` must
  land at the archive root, with no entry prefixed by the source folder name.
  Nesting would produce a broken site from a deploy that reports success — the
  worst failure mode available, and invisible without inspecting the archive.
- `-y` / `--yes` must keep suppressing the confirmation prompt.
- `--url` must keep overriding the endpoint claim in the token.
- A path that is already a `.zip` must be uploaded as-is.
- The token must keep being read from `BEHINDGATE_TOKEN` and must never be
  accepted as a command-line argument, where it would leak into process listings.
- The wire protocol the wrappers depend on: `POST <url>` → 201
  `{releaseId, uploadUrl, uploadMethod, expiresAt, url}`; `PUT` the zip;
  `GET <url>/<releaseId>` polled until extraction finishes; `POST <url>/publish`
  with `{"releaseId":"..."}`.

## Deliverables

1. The changes above, prioritised, each with tests.
2. Updated release notes and download documentation covering versioned URLs,
   signature verification, the version-string change, and any exit-code change.
3. A migration note for the downstream integrations saying which changes are
   additive and which need a coordinated update — `behindgate/deploy-action` can
   drop its pinned checksum table and its scheduled bump job once signing and
   versioned URLs are live.
