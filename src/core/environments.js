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
 * The deploy endpoint carries the `/api/deploy` path. The bare host is served by
 * a CDN that answers a POST with 403 text/html, and the CLI sends the request to
 * `--url` exactly as given rather than appending a path, so a host on its own is
 * not a usable endpoint.
 *
 * Downloads, by contrast, hang off the bare host: `<host>/downloads/<version>/`.
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
    deployUrl: 'https://app.behindgate.com/api/deploy',
    downloadBaseUrl: 'https://app.behindgate.com',
  }),
  test: Object.freeze({
    name: 'test',
    deployUrl: 'https://app.test.behindgate.net/api/deploy',
    downloadBaseUrl: 'https://app.test.behindgate.net',
  }),
});

const DEFAULT_ENVIRONMENT = 'prod';

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
 * @returns {{name: string, deployUrl: string, downloadBaseUrl: string}}
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
  knownEnvironments,
  resolveEnvironment,
  UnknownEnvironmentError,
};
