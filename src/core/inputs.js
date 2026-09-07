'use strict';

/**
 * Turn the Action's raw string inputs into a CLI invocation.
 *
 * Pure, dependency-free: no `@actions/*` imports and no filesystem access, so
 * the planned Bitbucket Pipe and GitLab component can reuse the same rules and
 * the whole input contract is unit-testable without a runner.
 *
 * Everything here is about catching a misconfiguration before the CLI is even
 * downloaded. The CLI rejects these combinations too, but it does so as a bare
 * `exit 2` whose message has to be read out of a log; naming the *inputs* that
 * conflict is the part only this layer can do.
 */

const { resolveEnvironment } = require('./environments');

/** A configuration error the caller can fix by editing their workflow. */
class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function trim(value) {
  return String(value ?? '').trim();
}

/**
 * Parse a boolean input.
 *
 * Deliberately strict. `create-app: yes` and `delete-app: 1` are the kind of
 * thing that looks like it works, and a `delete-app` silently read as false
 * leaves preview apps behind forever while the job goes green.
 */
function parseBoolean(name, value, fallback = false) {
  const raw = trim(value);
  if (!raw) return fallback;

  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new ConfigurationError(
    `The \`${name}\` input must be \`true\` or \`false\`, not "${raw}".`
  );
}

/**
 * A BehindGate deploy token is a JWT. Checking the shape here separates a
 * malformed secret from a genuine deploy failure -- the CLI reports both as
 * exit 2 with a message that has to be read out of the log. The token value
 * itself never appears in the message.
 */
function looksLikeJwt(token) {
  const segments = token.split('.');
  return (
    segments.length === 3 &&
    segments[0].length > 0 &&
    segments[1].length > 0 &&
    segments.every((segment) => /^[A-Za-z0-9_-]*$/.test(segment))
  );
}

/**
 * What the API accepts as a tag name, and what the CLI enforces before it zips
 * anything. Kept in step with it so a malformed name is named as an input error
 * here rather than reaching the runner as a bare exit 2.
 */
const TAG_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * Parse the `tags` input: one tag per line, `name=value` or a bare `name`.
 *
 * A line per tag rather than a separated list, because a value carries whatever
 * a CI expression resolved to -- a commit subject, a branch name -- and any
 * separator picked would eventually appear inside one.
 *
 * `name=` keeps the tag as a bare marker, so an unset build number labels the
 * release instead of failing the deploy.
 *
 * @returns {{name: string, value: string, raw: string}[]}
 */
function parseTags(value) {
  const tags = [];

  for (const line of trim(value).split('\n')) {
    const entry = line.trim();
    if (!entry) continue;

    const separator = entry.indexOf('=');
    const name = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    const tagValue = separator === -1 ? '' : entry.slice(separator + 1).trim();

    if (!name) {
      throw new ConfigurationError(
        `A tag needs a name: write "${entry}" as \`name=value\` or as a bare \`name\`.`
      );
    }
    if (!TAG_NAME.test(name)) {
      throw new ConfigurationError(
        `The tag name "${name}" must start with a letter and use only letters, ` +
          `digits, dot, hyphen or underscore.`
      );
    }
    if (tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) {
      throw new ConfigurationError(
        `The tag "${name}" is given more than once. A release holds one value ` +
          `per name, so repeating one cannot express anything.`
      );
    }

    tags.push({ name, value: tagValue, raw: tagValue ? `${name}=${tagValue}` : name });
  }

  return tags;
}

/**
 * Resolve the inputs into everything needed to run the CLI.
 *
 * @param {{env?: string, url?: string, downloadBaseUrl?: string, token?: string,
 *          path?: string, siteUrl?: string, createApp?: string|boolean,
 *          deleteApp?: string|boolean, trust?: string, tags?: string}} raw
 * @returns {{environment: object, deployUrl: string, endpointSource: string,
 *           downloadBaseUrl: string, token: string, usesToken: boolean,
 *           siteUrl: string, createApp: boolean, deleteApp: boolean, trust: string,
 *           tags: {name: string, value: string, raw: string}[],
 *           deployPath: string, args: string[], warnings: string[]}}
 */
function resolveInputs(raw = {}) {
  const environment = resolveEnvironment(raw.env);

  const url = trim(raw.url);
  const downloadBaseUrl = trim(raw.downloadBaseUrl);
  const token = trim(raw.token);
  const siteUrl = trim(raw.siteUrl);
  const deployPath = trim(raw.path);
  const createApp = parseBoolean('create-app', raw.createApp);
  const deleteApp = parseBoolean('delete-app', raw.deleteApp);
  const trust = trim(raw.trust);
  const tags = parseTags(raw.tags);

  const warnings = [];

  // `url` and `download-base-url` win over `env`. They predate it, they are what
  // a local or dev endpoint is reached through, and an explicit value must never
  // be quietly replaced by one derived from a shorthand.
  const deployUrl = url || environment.deployUrl;
  // Short enough to drop into a log line or a summary cell as-is. It names the
  // `url` input but never `env`, which is undocumented on purpose -- see
  // docs/MAINTAINERS.md.
  const endpointSource = url ? 'the `url` input' : `the ${environment.name} default`;

  if (token && siteUrl) {
    throw new ConfigurationError(
      [
        'Pass either `token` or `site-url`, not both.',
        '',
        'A deploy token already names the site and the app it deploys to, so ' +
          'there is nothing left for `site-url` to select. The two describe the ' +
          'same thing and would have to agree; rather than guess which one you ' +
          'meant, this fails now instead of deploying to whichever the CLI ' +
          'happens to prefer.',
        '',
        'Deploying to a fixed app: keep `token` and drop `site-url`. Naming the ' +
          'target per run (which is what a per-pull-request preview needs): drop ' +
          '`token`, grant `permissions: id-token: write`, and let the job ' +
          'authenticate as itself.',
      ].join('\n')
    );
  }

  if (token && trust) {
    throw new ConfigurationError(
      [
        'Pass either `token` or `trust`, not both.',
        '',
        'A CI trust is what a job authenticating as itself exchanges its OIDC ' +
          'token against. With `token` set there is no exchange, so the CLI ' +
          'would ignore `trust` and deploy wherever the token says.',
        '',
        'Drop `trust` to keep deploying with the token, or drop `token` and ' +
          'grant `permissions: id-token: write` to authenticate as the job.',
      ].join('\n')
    );
  }

  if (token && (createApp || deleteApp)) {
    const flag = createApp ? 'create-app' : 'delete-app';
    throw new ConfigurationError(
      [
        `\`${flag}\` cannot be used with \`token\`.`,
        '',
        'A deploy token is pinned to one app that already exists, so it can ' +
          'neither create another nor delete the one it names. Both need the job ' +
          'to authenticate as itself against a CI trust that holds those ' +
          'permissions.',
        '',
        'Remove `token:`, grant `permissions: id-token: write` to the job, and ' +
          'give the workspace a CI trust for this repository ' +
          '(Settings -> CI trusts).',
      ].join('\n')
    );
  }

  if (createApp && deleteApp) {
    throw new ConfigurationError(
      'Set either `create-app` or `delete-app`, not both. `delete-app` tears ' +
        'the app down and exits without deploying, so combining them cannot ' +
        'express anything.'
    );
  }

  if ((createApp || deleteApp) && !siteUrl) {
    const flag = createApp ? 'create-app' : 'delete-app';
    throw new ConfigurationError(
      `\`${flag}\` needs \`site-url\`, which is what names the app to ` +
        `${createApp ? 'create' : 'delete'}: the host names the site and the ` +
        `path names the app. Without it there is no target, and for ` +
        `\`delete-app\` in particular the Action will not guess at one.`
    );
  }

  if (token && !looksLikeJwt(token)) {
    throw new ConfigurationError(
      [
        'The `token` input is not a well-formed JWT.',
        '',
        'A BehindGate deploy token has three base64url segments separated by ' +
          'dots (header.payload.signature). The value supplied does not, which ' +
          'usually means it was truncated, wrapped across lines, or quoted when ' +
          'it was stored as a secret.',
        '',
        'Re-copy the token from the workspace dashboard under ' +
          'Settings -> Deploy tokens.',
      ].join('\n')
    );
  }

  if (!deleteApp && !deployPath) {
    throw new ConfigurationError(
      'The `path` input is required: it names the folder to deploy, or an ' +
        'existing .zip to upload as-is. Only `delete-app: true` can go without ' +
        'one, since a teardown uploads nothing.'
    );
  }

  if (deleteApp && deployPath) {
    warnings.push(
      'Both `delete-app` and `path` are set. A teardown uploads nothing, so ' +
        '`path` is ignored.'
    );
  }

  if (deleteApp && tags.length) {
    warnings.push(
      'Both `delete-app` and `tags` are set. A teardown publishes no release ' +
        'for a tag to land on, so `tags` is ignored.'
    );
  }

  const args = ['-y', '--json', '--url', deployUrl];

  if (trust) args.push('--trust', trust);
  if (siteUrl) args.push('--site-url', siteUrl);
  if (createApp) args.push('--create-app');
  if (deleteApp) args.push('--delete-app');
  if (!deleteApp) for (const tag of tags) args.push('--tag', tag.raw);
  // The CLI takes the path last, and takes none at all for a teardown.
  if (!deleteApp) args.push(deployPath);

  return {
    environment,
    deployUrl,
    endpointSource,
    downloadBaseUrl: downloadBaseUrl || environment.downloadBaseUrl,
    token,
    usesToken: Boolean(token),
    siteUrl,
    createApp,
    deleteApp,
    trust,
    tags: deleteApp ? [] : tags,
    deployPath: deleteApp ? '' : deployPath,
    args,
    warnings,
  };
}

module.exports = {
  ConfigurationError,
  parseBoolean,
  parseTags,
  looksLikeJwt,
  resolveInputs,
};
