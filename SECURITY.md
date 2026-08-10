# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately rather than in a public issue.

Use GitHub's private vulnerability reporting on this repository — **Security →
Report a vulnerability** — which opens a draft advisory visible only to
maintainers. If you cannot use that, contact BehindGate support and ask for the
report to reach the engineering team.

Please include the Action version (`@v1`, or a specific tag), the runner OS, and
enough detail to reproduce. We will acknowledge the report and keep you updated
while we work on a fix.

Do not include a working deploy token in a report. If you believe a token has
been exposed, revoke it in the dashboard under **Settings → Deploy tokens**
first.

## Supported versions

Fixes land on the latest `v1` release. Consumers referencing
`behindgate/deploy-action@v1` receive them automatically; consumers pinned to a
specific tag or commit need to update.

## What this Action does with your secrets and your runner

Understanding the model makes it easier to judge a finding.

**The deploy token.** It is read from the `token` input, masked in the log before
anything else runs, and passed to the CLI through the environment — never on the
command line, where it could surface in a process listing or a command echo. It
is never written to disk by this Action.

**The CLI binary.** The Action downloads `bg-deploy` and executes it on your
runner, alongside your source, your build output and your other secrets. Because
that is code execution inside your trust boundary, every download is verified
against a SHA256 pinned in [`versions.json`](versions.json) **before the archive
is extracted**. A mismatch fails the deploy; there is no fallback path that runs
an unverified binary. Those hashes live in version control, so changing one
requires a commit that appears in history and in review.

**The deploy endpoint.** A deploy token carries the endpoint it was minted for,
so a token is both a credential and a routing instruction. Pinning the `url`
input moves the destination into your workflow file, where code review and branch
protection cover it, and the CLI refuses to deploy when a token's claim disagrees
with it. See "Why you should pin `url`" in the [README](README.md#why-you-should-pin-url).

## Hardening your own workflow

- **Pin `url`** to your deploy endpoint.
- **Store the token as a secret**, never inline and never in a repository
  variable.
- **Do not put the endpoint in a secret** — it is not sensitive, and keeping it
  beside the token means one compromised store controls both the credential and
  the destination.
- **Consider pinning this Action to a commit SHA** rather than `@v1` if your
  threat model calls for it. Version tags are immutable by convention; only the
  floating `v1` tag moves.
- **Deploy from a protected branch**, so the workflow that holds the token cannot
  be altered without review.
