'use strict';

/**
 * The BehindGate environments this Action knows how to talk to.
 *
 * Pure, dependency-free: no `@actions/*` imports.
 *
 * Two addresses have to agree for a deploy to work, and until now the caller
 * had to keep them in sync by hand: the deploy endpoint the CLI uploads to, and
 * the host the CLI itself is downloaded from. They are not the same URL and one
 * is not derivable from the other by string surgery, so both are spelled out.
 *
 * The deploy endpoint is the RELEASES collection, `/api/deploy/releases`. The
 * CLI posts to `--url` exactly as given to create a release and appends the
 * release id to poll it, and it derives the sibling routes by trimming that last
 * segment -- `/api/deploy/oidc/token` for the credential exchange, `/api/deploy/apps`
 * to resolve `--site-url`, `/api/deploy/publish` to publish. Naming the parent
 * instead puts release creation on the wrong route, and the bare host is worse
 * still: it is fronted by a CDN that answers a POST with 403 text/html.
 *
 * Downloads, by contrast, hang off the bare host: `<host>/downloads/<version>/`.
 *
 * `pinnedCli` records whether `versions.json` describes what a host serves. The
 * committed checksums were captured from production, and production publishes a
 * version once; test republishes, so a pin there describes the build for as long
 * as it takes someone to rebuild it. See `docs/MAINTAINERS.md`.
 */

class UnknownEnvironmentError extends Error {
  constructor(value, known) {
    super(
      `Unknown \`env\` input "${value}". ` +
        `Valid values: ${known.join(', ')}. ` +
        `The environment selects both the deploy endpoint and the host the CLI ` +
        `is downloaded from, so an unrecognised value is refused rather than ` +
        `falling back to a default and deploying somewhere you did not ask for.`
    );
    this.name = 'UnknownEnvironmentError';
    this.value = value;
  }
}

const ENVIRONMENTS = Object.freeze({
  prod: Object.freeze({
    name: 'prod',
    deployUrl: 'https://app.behindgate.com/api/deploy/releases',
    downloadBaseUrl: 'https://app.behindgate.com',
    pinnedCli: true,
  }),
  test: Object.freeze({
    name: 'test',
    deployUrl: 'https://app.test.behindgate.net/api/deploy/releases',
    downloadBaseUrl: 'https://app.test.behindgate.net',
    pinnedCli: false,
  }),
});

const DEFAULT_ENVIRONMENT = 'prod';

/**
 * The origins this Action will read CLI metadata from.
 *
 * Only consulted where the checksum comes from the download host itself. There
 * the host both serves the archive and declares its digest, so it can hand over
 * any bytes it likes together with a digest that matches -- which is tolerable
 * from a host named in this file and reviewed with it, and not from one a
 * workflow input picked. Where the digest is pinned in `versions.json` the host
 * has no such say, and `download-base-url` may point anywhere.
 */
const KNOWN_DOWNLOAD_ORIGINS = Object.freeze(
  Object.values(ENVIRONMENTS).map((environment) => new URL(environment.downloadBaseUrl).origin)
);

/**
 * Whether a URL belongs to a download host this repository names.
 *
 * Compares the ORIGIN, so scheme, host and port all have to match: an http://
 * spelling of a known host is a different origin and is refused with the rest.
 */
function isKnownDownloadOrigin(url) {
  let origin;

  try {
    origin = new URL(String(url)).origin;
  } catch {
    return false;
  }

  return KNOWN_DOWNLOAD_ORIGINS.includes(origin);
}

/** The environment names accepted by the `env` input. */
function knownEnvironments() {
  return Object.keys(ENVIRONMENTS);
}

/**
 * Resolve the `env` input to its two URLs.
 *
 * An empty value is the unset input and resolves to the default. Anything else
 * unrecognised throws: silently treating `env: staging` or `env: production` as
 * production would send a build to an environment the caller did not name.
 *
 * @param {string} [value]
 * @returns {{name: string, deployUrl: string, downloadBaseUrl: string, pinnedCli: boolean}}
 */
function resolveEnvironment(value) {
  const requested = String(value ?? '').trim();
  if (!requested) return ENVIRONMENTS[DEFAULT_ENVIRONMENT];

  const environment = ENVIRONMENTS[requested.toLowerCase()];
  if (!environment) {
    throw new UnknownEnvironmentError(requested, knownEnvironments());
  }

  return environment;
}

module.exports = {
  ENVIRONMENTS,
  DEFAULT_ENVIRONMENT,
  KNOWN_DOWNLOAD_ORIGINS,
  isKnownDownloadOrigin,
  knownEnvironments,
  resolveEnvironment,
  UnknownEnvironmentError,
};
