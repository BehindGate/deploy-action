# Prompt: improve the `bg-deploy` binary release

Copy everything below the line into a session working on the `bg-deploy` CLI /
release pipeline repository.

---

You are working on `bg-deploy`, BehindGate's static-site deploy CLI: a single
static Go binary with no runtime dependencies, published as per-platform
archives.

`bg-deploy` is now the shared core for BehindGate's CI integrations. The GitHub
Action (`behindgate/deploy-action`) wraps it, and a Bitbucket Pipe and a GitLab
component are planned. All three are deliberately thin — none of them
reimplements the deploy HTTP protocol — so anything the CLI does not expose,
none of them can offer. That constraint is what motivates the work below.

The findings here came from black-box testing of `bg-deploy 2026.07.1 (git
79f1f9f)` while building the Action: running the real binary, pointing it at a
local capture server with `--url`, and probing the download host. Re-verify
anything you intend to act on; do not assume the details still hold.

**Where to start.** Signing is the highest-leverage item, and the reasoning is
worth stating because it is not obvious from the list.

BehindGate is a SaaS: the server moves whether or not any client does. So pinning
a CLI version buys consumers no reproducibility — the half that decides what a
deploy actually does was never pinned. Every integration should simply track the
current build. They cannot, because the only integrity mechanism available is a
hash committed into each wrapper's own repository, and a hash can only pin one
specific build. `SHA256SUMS.txt` does not help: it is served by the same host as
the binaries, so it proves only that a download was not truncated.

Signing breaks that deadlock. With a signature verifiable against a key that does
not live on the download host, every wrapper can take the newest build and verify
it at runtime — no pinned tables, no per-release wrapper update, no stale clients.
It removes the most machinery for the least ongoing cost.

One thing outranks even signing, though: the published binary was built from a
**dirty working tree**, so it corresponds to no commit at all. Signing an
unreproducible artifact only attests that a specific pile of bytes was blessed —
not that anyone can rebuild or audit it. Fix the build first.

Suggested order:

1. **Release from a clean, tagged commit** — prerequisite for everything else.
2. **Sign the releases** — unblocks "always current" for all three integrations.
3. **Versioned, immutable URLs** — less about reproducibility than about
   *incident recovery*: today a bad CLI release breaks every customer at once with
   no way to roll back.
4. **Machine-readable output** — the only way wrappers stop parsing console text.
5. **Endpoint pinning** — `BEHINDGATE_URL`, precedence, mismatch detection.
6. **Exit codes**, then **small fixes** (one of which halves the download size).

Each task has acceptance criteria. Where one changes observable behaviour, keep
backward compatibility unless the task says otherwise: wrappers currently pin to
specific CLI versions, and will keep doing so until signing lands.

## Release from a clean, tagged commit

**Problem.** The binary published as `bg-deploy 2026.07.1 (git 79f1f9f)` was built
from a modified working tree. Go's own build metadata, embedded in the shipped
artifact, says so:

```
build  vcs.modified=true
build  vcs.revision=79f1f9ff1e3ed8b7383e0bc937cfa5afcf429dca
build  vcs.time=2026-07-31T13:07:03Z
mod    github.com/behindgate/app/deployer  v0.0.0-20260731130703-79f1f9ff1e3e+dirty
```

**Why it matters.** `git 79f1f9f` in `--version` is not true of the artifact
customers execute: the source it was built from had uncommitted changes, so that
commit does not describe it. Concretely, nobody can rebuild this binary, diff it
against source, bisect a regression to a commit, or answer "what code is running
in our CI?" with evidence. A security review of the repository says nothing about
the artifact.

This also undercuts every other item here. Signing an unreproducible binary
attests only that someone blessed a particular pile of bytes; it cannot attest
that those bytes correspond to reviewed source. Fix this first or the signature is
worth much less than it appears.

(The web app is affected too — the deployed `index.html` carries
`<!-- build: 2026.07.1 79f1f9f-dirty -->` — so this looks like a property of the
release tooling rather than a one-off.)

**Do this.**

- Build releases only in CI, triggered by a tag, from a clean checkout.
- **Fail the release if `vcs.modified` is true.** Go records this for free; make it
  a hard gate rather than a warning.
- Build with `-trimpath` and a pinned Go toolchain (currently `go1.24.13`) so
  paths and toolchain drift do not change output.
- Embed the tag, the full commit SHA, and the build timestamp; have `--version`
  print the full SHA rather than a short prefix.
- Ideally, make builds byte-reproducible so an independent rebuild of the tag
  reproduces the published archive exactly. Static Go binaries are unusually close
  to this already.

**Acceptance criteria.**

- A release build from a dirty tree fails rather than publishing.
- `--version` reports a commit that exists in the repository and fully describes
  the artifact.
- Rebuilding a published tag on a clean checkout reproduces the published bytes,
  or the differences are documented and understood.

## Versioned, immutable download URLs

**Problem.** Archives are published only at unversioned paths:

```
https://app.behindgate.com/downloads/bg-deploy-<os>-<arch>.tar.gz
https://app.behindgate.com/downloads/SHA256SUMS.txt
```

There is no way to request a specific build. Every versioned path shape probed
returns 403 (`/downloads/v2026.07.1/...`, `/downloads/2026.07.1/...`,
`/downloads/bg-deploy-linux-amd64-2026.07.1.tar.gz`,
`/downloads/bg-deploy-2026.07.1-linux-amd64.tar.gz`), and `/downloads/` itself
returns the SPA shell rather than an index.

**Why it matters.** Not reproducibility — against a SaaS backend, holding an old
client gives none. The real cost is **incident recovery**. When a CLI release
regresses, there is currently no way for anyone to go back to the previous build:
the old bytes are simply gone from the only URL that exists, so every customer is
on the broken version simultaneously until a fix ships. Versioned URLs make
rollback a one-line change in a workflow rather than an emergency re-release.

Secondarily, consumers pin per-platform SHA256 checksums to verify downloads, and
with no version in the URL that pin is against a moving target: the host can serve
different bytes under the same name at any time. It fails closed, so it is safe —
but it means a wrapper's pinned table goes stale the moment a new CLI ships.

**Do this.**

- Publish immutable versioned artifacts. A published version path must never
  change content:
  ```
  /downloads/2026.07.1/bg-deploy-linux-amd64.tar.gz
  /downloads/2026.07.1/SHA256SUMS.txt
  ```
- Keep the unversioned paths working as a `latest` alias, for humans and for
  existing scripts.
- Publish a machine-readable index so tooling can resolve versions without
  scraping:
  ```
  /downloads/index.json
  {"latest":"2026.07.1","versions":[{"version":"2026.07.1","released":"2026-07-31",
    "platforms":["linux-amd64","linux-arm64","darwin-amd64","darwin-arm64","windows-amd64"]}]}
  ```
- Apply the same layout to every environment. Production is
  `app.behindgate.com`; test is `app.test.behindgate.net`. Hosts are
  per-environment and nothing downstream may hardcode one.

**Acceptance criteria.**

- Fetching a versioned URL twice, across a subsequent release, returns identical
  bytes.
- `/downloads/index.json` returns valid JSON listing every published version.
- Unversioned paths still resolve to the newest release.
- Production and test serve the same layout.

## Expose machine-readable output

**Problem.** On success the CLI prints only the release id:

```
✓ Deployed. Release rel_01J8ZQ4M2N is live.
```

The corresponding format string in the binary is `" Deployed. Release %s is
live."`. The deploy API returns the site's public address — both the
create-release and publish responses carry a `url` field — but the CLI never
echoes it. There is no structured output mode either: `--json`, `--output`,
`--format`, `--quiet` and `--verbose` are all rejected with `flag provided but
not defined`.

**Why it matters.** The Action declares a `url` output and writes a job summary,
both intended to link the deployed site — the single most useful thing to
surface after a deploy. Since the CLI is the only interface and the wrappers
must stay thin, there is nothing to read, and `url` currently ships empty.
Deriving it from the deploy endpoint was considered and rejected: the endpoint is
the API address, not the site's, so it would put a non-resolving link in every
job summary.

Note also that console output is presently the *only* machine-readable surface,
so all three integrations must parse human-facing text that any wording change
breaks.

**Do this.**

- Add `--json`, writing a single object to stdout and suppressing human output:
  ```json
  {"releaseId":"rel_01J8ZQ4M2N","url":"https://demo.behindgate.com/my-app/",
   "endpoint":"https://app.behindgate.com/api/deploy","status":"published","version":"2026.07.1"}
  ```
  Emit errors in the same shape (`{"error":{"code":"not_a_jwt","message":"..."}}`)
  so failures are parseable too.
- Independently, print the deployed address in human output:
  ```
  ✓ Deployed. Release rel_01J8ZQ4M2N is live at https://demo.behindgate.com/my-app/
  ```

Both are worth doing. `--json` is the durable contract for the three CI
integrations; the human line is what someone reading a log actually wants.

**Acceptance criteria.**

- `--json` output parses as a single JSON object and contains the deployed URL.
- Human output includes the deployed URL on success.
- With `--json`, nothing non-JSON is written to stdout (diagnostics go to stderr).
- Existing consumers that parse the current success line keep working — treat the
  URL as an addition, not a reformat.

## Endpoint pinning: env var, precedence, and mismatch detection

**Problem.** `--url` is currently the only way to pin the deploy endpoint.
Verified by testing: exporting `BEHINDGATE_URL` has no effect — the CLI still
routes to the claim inside the token. (Token claiming a dead port, `BEHINDGATE_URL`
pointing at a live server: the CLI tried the dead port and failed.)

**Be precise about what an env var buys.** Accepting `BEHINDGATE_URL` is worth
doing, but it is an *ergonomics* change, not a security one, and the distinction
matters enough to state in the docs.

The protection `--url` provides comes from *where the value lives and who can
change it* — a workflow file under version control, code review and branch
protection — not from which channel it arrives on. If an operator sets
`BEHINDGATE_URL` as a CI secret next to `BEHINDGATE_TOKEN`, both live in the same
mutable store, and anyone who can rewrite one can rewrite the other. That
configuration looks like pinning while providing none of its benefit, which is
worse than not pinning at all, because it is believed.

The real reason to add it is portability: Bitbucket Pipes and GitLab components
are configured through environment variables, not argv, so an env var is the
idiomatic interface there and will materially increase how many people pin at
all. Document it as "convenient", and keep "put the endpoint in reviewed
configuration" as the security advice.

**Do this.**

1. **Accept `BEHINDGATE_URL`** as an alternative to `--url`.

2. **Make `--url` win over `BEHINDGATE_URL`.** This one *is* a security
   requirement. If the environment could override an explicit flag, anyone able
   to inject an environment variable into the job could silently redirect a
   deploy that its author had deliberately pinned in the command line. Precedence
   must be: `--url` flag > `BEHINDGATE_URL` > token claim.

3. **Report when the pinned endpoint disagrees with the token's claim.** This is
   the highest-value change in this section. Today, `--url` silently overrides a
   conflicting claim — but that disagreement is *exactly* the signal that a token
   has been swapped for one pointing elsewhere. Discarding it silently throws away
   the only evidence of an attempted redirect.

   At minimum, warn:

   ```
   warning: token claims endpoint https://evil.example/api/deploy
            but deploying to https://app.behindgate.com/api/deploy (pinned)
   ```

   Better, offer `--require-url-match` (or `BEHINDGATE_REQUIRE_URL_MATCH=1`) to
   make the mismatch fatal, so a CI job fails loudly rather than deploying
   correctly while an attacker learns their swapped token went unnoticed.

**Acceptance criteria.**

- `BEHINDGATE_URL` pins the endpoint when `--url` is absent.
- `--url` overrides `BEHINDGATE_URL`; a test covers that precedence explicitly.
- A pinned endpoint differing from the token's claim produces a warning naming
  both values.
- `--require-url-match` turns that warning into a non-zero exit.
- Documentation describes the env var as convenience and continues to recommend
  pinning in reviewed configuration.

## Sign the releases

**Problem.** `SHA256SUMS.txt` is served by the same host as the binaries it
describes. It therefore proves only that a download was not truncated in
transit: anyone able to serve a modified binary can serve a matching checksum
beside it, and the check still passes.

The Action works around this by committing per-platform hashes into its own git
repository, where the download host cannot rewrite them and any change requires a
reviewed commit. That works, but the cost is structural, not just duplicated
effort:

- The Bitbucket Pipe and the GitLab component each need their own copy of the same
  table, and all three must move in lockstep on every CLI release.
- **It forces every wrapper to pin a version it does not want to pin.** A hash
  identifies one specific build, so verifying against a committed hash and always
  taking the current build are mutually exclusive. Against a SaaS backend that is
  exactly backwards: the server moves regardless, so a pinned client gains nothing
  and slowly drifts out of step with the service it talks to.

The Action currently mitigates this with a scheduled job that follows the
published CLI, re-verifies it and opens a pull request — machinery that exists
solely because signatures do not.

Signing collapses all of it. A wrapper can fetch the current build and verify a
signature at runtime: no pinned tables, no scheduled bump jobs, no version input,
no stale clients, and a genuinely stronger guarantee than a hash — because the
signing key is not controlled by whoever controls the download host.

**Do this.**

- Sign each release with a key that does **not** live on the download host —
  Sigstore/cosign keyless signing, or minisign with the public key published in
  the CLI's source repository and documented in release notes.
- Publish detached signatures alongside artifacts:
  `bg-deploy-linux-amd64.tar.gz.sig`, and a signature over `SHA256SUMS.txt`.
- Document the exact verification command in the release notes.
- Consider having the CLI self-verify on upgrade, if a self-update path exists.

**Acceptance criteria.**

- Every published artifact has a detached signature verifiable with a documented
  public key or the Sigstore transparency log.
- Verification instructions are reproducible by someone with no BehindGate access.
- Signatures cover the versioned paths from Priority 1.

This is what lets the downstream integrations drop their pinned checksum tables
and verify a signature instead.

## Make exit codes consistent

**Problem.** Observed behaviour of 2026.07.1:

| Invocation | Exit | Message |
| --- | --- | --- |
| `BEHINDGATE_TOKEN` unset/empty | **2** | `error: BEHINDGATE_TOKEN is not set` |
| `BEHINDGATE_TOKEN=not-a-jwt` | **1** | `error: not a JWT (expected header.payload.signature)` |
| token with undecodable payload | **1** | `error: token payload is not valid base64url` |
| no `<path>` | 2 | `error: exactly one <path> ... is required` |
| unknown flag | 2 | `flag provided but not defined` |

A *missing* credential exits 2 while a *malformed* credential exits 1. Both are
the same class of problem — the operator supplied a bad secret — but they land in
different buckets, so a caller cannot use the exit code to distinguish "your
configuration is wrong" from "the deploy failed". Exit 1 currently mixes bad
tokens with network failures and server rejections.

Relatedly, the CLI validates the token *before* checking that `<path>` exists, so
a typo in the path surfaces as a confusing token error.

**Do this.** Pick one and document it in `--help`:

- Either treat every credential problem as exit 2 (configuration error), leaving
  exit 1 for genuine runtime failures; or
- introduce a distinct code (for example 3) for authentication/authorisation
  problems, keeping 2 for argument-shape errors.

Also validate `<path>` before the token so path errors report themselves.

**Acceptance criteria.**

- Missing and malformed tokens produce the same exit code as each other.
- That code differs from network failures and server rejections.
- `--help` documents the full set.
- A non-existent `<path>` reports a path error regardless of token validity.

## Small fixes

- **`--help` exits 2.** Both `--help` and `-h` print usage and exit **2**.
  Requesting help successfully is not an error; it should exit 0. Usage printed
  *because* of a bad invocation should keep exiting 2. This trips up CI wrappers
  that run `--help` as a smoke test.
- **Binaries ship unstripped, roughly doubling the download.** `file` reports
  `with debug_info, not stripped`. Measured on `linux-amd64`:

  | | binary | gzipped (what is downloaded) |
  | --- | --- | --- |
  | as shipped | 8,889,884 | 4,986,491 |
  | stripped | 6,023,320 | 2,519,056 |

  Building with `-ldflags="-s -w"` cuts the published archive from ~5.0 MB to
  ~2.5 MB — a **~50% reduction**, paid on every cold CI run by every customer
  across five platforms. Keep an unstripped build available for debugging if you
  want symbols, but do not make it the default download.

- **No `windows-arm64` build.** Published platforms are `linux-amd64`,
  `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`. Windows ARM64
  runners are increasingly common; the Action currently has to fail explicitly on
  them. Adding the target should be a build-matrix line.
- **Version string is not semver.** `bg-deploy --version` reports `2026.07.1`,
  whose `07` component has a leading zero and is therefore not valid semver. This
  is not cosmetic: `@actions/tool-cache` keys its cache on semver, silently treats
  a non-semver version as a *range*, matches nothing, and re-downloads the binary
  on every run. The Action normalises `2026.07.1` → `2026.7.1` to work around it.
  Publishing `2026.7.1` would remove the workaround for every consumer.

## Do not regress

These behaviours are load-bearing for the CI integrations and are covered by
tests in `behindgate/deploy-action`:

- **Given a folder, the CLI zips its CONTENTS, not the folder.** `index.html`
  must land at the zip root, with no entry prefixed by the source folder name.
  Nesting would produce a broken site from a deploy that reports success —
  the worst failure mode available, and invisible without inspecting the archive.
- `-y` / `--yes` must continue to suppress the confirmation prompt for
  unattended runs.
- `--url` must continue to override the endpoint claim carried in the token. The
  Action documents this as its main defence against a swapped secret silently
  redirecting a build.
- A path that is already a `.zip` must be uploaded as-is.
- The token must continue to be read from `BEHINDGATE_TOKEN` and never be
  accepted as a command-line argument, where it would leak into process listings.

## Deliverables

1. The changes above, prioritised, each with tests.
2. Updated release notes and download documentation covering versioned URLs,
   signature verification, and any exit-code change.
3. A short migration note for downstream integrations describing which changes
   are additive and which require a coordinated update.
