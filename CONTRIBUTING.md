# Contributing

## Commit and pull request titles

Releases are cut by [release-please](https://github.com/googleapis/release-please),
which reads commit subjects to decide the next version and to write the
changelog. This repository squash-merges, so **the pull request title becomes
that commit subject** — a title outside the conventional-commit format means the
change silently never appears in a release.

CI checks the title, so you will find out before merging rather than after.

```
type(optional-scope): description
```

| Type | Effect on the next release | Appears in changelog |
| --- | --- | --- |
| `feat` | minor bump (`1.2.3` → `1.3.0`) | yes |
| `fix` | patch bump (`1.2.3` → `1.2.4`) | yes |
| `perf` | patch bump | yes |
| `revert` | patch bump | yes |
| `docs` | patch bump | yes |
| `build` | patch bump | yes |
| `chore`, `ci`, `refactor`, `style`, `test` | none | no |

A trailing `!` — `feat!:` — or a `BREAKING CHANGE:` footer bumps the major
version. Do not use it casually: consumers pin `@v1`, so a major bump means
nobody receives the change until they edit their workflow.

Examples:

```
fix(cache): key the tool cache on a semver-normalised version
feat: add windows-arm64 support
docs: explain why the endpoint should be pinned
feat!: require bg-deploy 2026.8.0 or newer
```

## Before opening a pull request

```bash
npm ci
npm run lint
npm test
npm run build      # dist/ is committed; CI fails if it drifts from src/
```

`dist/` is committed because GitHub runs `dist/index.js` directly — there is no
install step at Action runtime. If you changed anything under `src/`, rebuild and
commit the result in the same pull request.

## Tests

Unit tests are pure and run everywhere. Integration tests drive the **real**
`bg-deploy` binary against a local HTTP capture server using a syntactically
valid but fake JWT, so they need no credentials and run on forks.

```bash
npm run test:unit
npm run test:integration
```

The most important assertion in the suite is that the uploaded archive has
`index.html` at its **root**. If that ever regresses, a deploy still succeeds and
the job still goes green while the published site is broken — nothing else here
would catch it.

See [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) for releasing and for pinning
new CLI versions.
